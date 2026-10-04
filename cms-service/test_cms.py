"""Tests for the Client Management System.

Runs inside the shared Python test image (``Dockerfile.test``) under
python:3.11-slim — the host interpreter cannot import spyne 2.14.

Postgres and RabbitMQ are replaced by in-memory fakes so the suite is
hermetic; the SOAP wire format is exercised for real through the
DispatcherMiddleware/WSGI stack the service ships with.
"""

import json
from datetime import UTC, datetime
from decimal import Decimal

import app as cms
import bcrypt
import pytest
from werkzeug.test import Client

NOW = datetime(2026, 10, 1, 8, 30, tzinfo=UTC)


# ─────────────────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────────────────
class FakeCursor:
    def __init__(self, connection):
        self._connection = connection
        self._rows = []

    def execute(self, sql, params=None):
        self._connection.sql_log.append((sql, params))
        result = self._connection.responder(sql, params)
        if isinstance(result, Exception):
            raise result
        self._rows = list(result)

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None

    def fetchall(self):
        rows, self._rows = self._rows, []
        return rows

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeConnection:
    def __init__(self, responder):
        self.responder = responder
        self.sql_log = []
        self._cursor = FakeCursor(self)

    def cursor(self):
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def patch_db(monkeypatch, responder):
    connections = []

    def factory():
        connection = FakeConnection(responder)
        connections.append(connection)
        return connection

    monkeypatch.setattr(cms, "get_db_connection", factory)
    return connections


def no_rows(_sql, _params=None):
    return []


def only(fragment, rows):
    """Respond with ``rows`` whenever the statement mentions ``fragment``."""
    wanted = list(rows)

    def respond(sql, _params=None):
        return wanted if fragment in sql else []

    return respond


@pytest.fixture()
def published(monkeypatch):
    """Capture order_created events instead of dialling RabbitMQ."""
    events = []
    monkeypatch.setattr(cms, "publish_order_created", events.append)
    return events


@pytest.fixture()
def client(monkeypatch):
    patch_db(monkeypatch, no_rows)
    cms.flask_app.config["TESTING"] = True
    with cms.flask_app.test_client() as test_client:
        yield test_client


# ─────────────────────────────────────────────────────────────────────────────
# estimate_coordinates
# ─────────────────────────────────────────────────────────────────────────────
class TestEstimateCoordinates:
    @pytest.mark.parametrize(
        ("address", "expected"),
        [
            ("Colombo", (6.9271, 79.8612)),
            ("Kandy Central", (7.2906, 80.6337)),
            ("Gampaha District", (7.0873, 80.0144)),
            ("Galle Face", (6.0535, 80.2210)),
            ("Havelock Town", (6.8869, 79.8651)),
        ],
    )
    def test_resolves_known_sri_lankan_places(self, address, expected):
        assert cms.estimate_coordinates(address) == expected

    @pytest.mark.parametrize("address", ["colombo", "COLombo", "  Colombo  "])
    def test_matching_is_case_and_whitespace_insensitive(self, address):
        assert cms.estimate_coordinates(address) == (6.9271, 79.8612)

    def test_first_known_place_in_dict_order_wins(self):
        assert cms.estimate_coordinates("Galle Road, Kandy") == (7.2906, 80.6337)

    @pytest.mark.parametrize("address", [None, ""])
    def test_blank_addresses_fall_back_to_the_colombo_point(self, address):
        assert cms.estimate_coordinates(address) == (6.9271, 79.8612)

    def test_a_whitespace_only_address_stays_near_colombo(self):
        lat, lng = cms.estimate_coordinates("   ")

        assert 6.9271 <= lat < 6.9371
        assert 79.8612 <= lng < 79.8712

    def test_unknown_addresses_fall_back_near_colombo(self):
        lat, lng = cms.estimate_coordinates("Somewhere, Switzerland")

        assert 6.9271 <= lat < 6.9371
        assert 79.8612 <= lng < 79.8712

    def test_the_fallback_is_deterministic(self):
        assert cms.estimate_coordinates("Zurich") == cms.estimate_coordinates("Zurich")

    def test_the_fallback_varies_with_the_address(self):
        assert cms.estimate_coordinates("Zurich") != cms.estimate_coordinates("Basel")


# ─────────────────────────────────────────────────────────────────────────────
# authenticate_client_payload
# ─────────────────────────────────────────────────────────────────────────────
def client_row(password_hash, known_email="ops@acme.ch"):
    """Look up by email the way the real query does, so a miss is a miss."""

    def respond(_sql, params=None):
        if params and params[0] != known_email:
            return []
        return [("CLI-001", "Acme AG", known_email, password_hash)]

    return respond


class TestAuthenticateClient:
    @pytest.fixture()
    def password_hash(self):
        return bcrypt.hashpw(b"correct horse", bcrypt.gensalt(rounds=4)).decode()

    def test_returns_client_identity_on_a_good_password(self, monkeypatch, password_hash):
        patch_db(monkeypatch, client_row(password_hash))

        result = cms.authenticate_client_payload("ops@acme.ch", "correct horse")

        assert result == {
            "success": True,
            "client_code": "CLI-001",
            "company_name": "Acme AG",
            "email": "ops@acme.ch",
        }

    def test_rejects_a_wrong_password(self, monkeypatch, password_hash):
        patch_db(monkeypatch, client_row(password_hash))

        result = cms.authenticate_client_payload("ops@acme.ch", "wrong")

        assert result == {"success": False, "message": "Invalid password"}

    def test_rejects_an_unknown_email(self, monkeypatch, password_hash):
        patch_db(monkeypatch, client_row(password_hash))

        result = cms.authenticate_client_payload("nobody@acme.ch", "correct horse")

        assert result == {"success": False, "message": "Client not found"}

    def test_looks_up_the_stored_hash_by_email(self, monkeypatch, password_hash):
        connections = patch_db(monkeypatch, client_row(password_hash))

        cms.authenticate_client_payload("ops@acme.ch", "correct horse")

        sql, params = connections[0].sql_log[0]
        assert "FROM clients" in sql
        assert "WHERE email = %s" in sql
        assert params == ("ops@acme.ch",)

    def test_surfaces_database_errors_as_a_failed_result(self, monkeypatch):
        patch_db(monkeypatch, lambda *_: RuntimeError("connection refused"))

        result = cms.authenticate_client_payload("a@b.ch", "x")

        assert result == {"success": False, "message": "connection refused"}


# ─────────────────────────────────────────────────────────────────────────────
# create_order_payload
# ─────────────────────────────────────────────────────────────────────────────
def order_responder(client_id="client-uuid", next_number=42, created=None):
    # The RETURNING clause echoes back whatever the code inserted, so derive
    # it from next_number to keep the fake consistent with the sequencing.
    if created is None:
        created = (f"ORD-{next_number:04d}", "pending", NOW)

    def respond(sql, _params=None):
        if "FROM clients" in sql:
            return [(client_id,)] if client_id else []
        if "MAX(CAST(SUBSTRING" in sql:
            return [(next_number,)]
        if "INSERT INTO orders" in sql:
            return [created]
        return []

    return respond


class TestCreateOrderPayload:
    def test_creates_the_next_sequential_order_code(self, monkeypatch, published):
        patch_db(monkeypatch, order_responder(next_number=7))

        result = cms.create_order_payload("CLI-001", "Colombo", "Kandy", 2.5)

        assert result["success"] is True
        assert result["order_code"] == "ORD-0007"
        assert result["status"] == "pending"
        assert result["created_at"] == NOW.isoformat()
        assert result["event_published"] is True

    def test_zero_yields_a_four_digit_code(self, monkeypatch, published):
        patch_db(monkeypatch, order_responder(next_number=0))

        assert cms.create_order_payload("CLI-001", "a", "b", 1)["order_code"] == "ORD-0000"

    def test_the_insert_binds_the_computed_order_code(self, monkeypatch, published):
        # This is the real sequencing assertion: the code under test must
        # take MAX(...)+1 and write exactly that value into the INSERT.
        connections = patch_db(monkeypatch, order_responder(next_number=7))

        cms.create_order_payload("CLI-001", "a", "b", 1.0)

        insert_sql, insert_params = next(
            (sql, params) for sql, params in connections[0].sql_log if "INSERT INTO orders" in sql
        )
        assert "VALUES (%s, %s, %s, %s, %s, 'pending')" in insert_sql
        assert insert_params[0] == "ORD-0007"

    def test_publishes_a_full_order_created_event(self, monkeypatch, published):
        patch_db(monkeypatch, order_responder(next_number=1))

        cms.create_order_payload("CLI-001", "Colombo", "Kandy", 3.25)

        assert len(published) == 1
        event = published[0]
        assert event["event_type"] == "ORDER_CREATED"
        assert event["data"] == {
            "order_code": "ORD-0001",
            "client_code": "CLI-001",
            "pickup_address": "Colombo",
            "delivery_address": "Kandy",
            "pickup_lat": 6.9271,
            "pickup_lng": 79.8612,
            "delivery_lat": 7.2906,
            "delivery_lng": 80.6337,
            "weight_kg": 3.25,
            "status": "pending",
        }

    def test_the_event_timestamp_is_timezone_aware(self, monkeypatch, published):
        patch_db(monkeypatch, order_responder())

        cms.create_order_payload("CLI-001", "Colombo", "Kandy", 1.0)

        parsed = datetime.fromisoformat(published[0]["timestamp"])
        assert parsed.tzinfo is not None

    def test_rejects_an_unknown_client_without_inserting(self, monkeypatch, published):
        patch_db(monkeypatch, order_responder(client_id=None))

        result = cms.create_order_payload("CLI-999", "a", "b", 1.0)

        assert result == {"success": False, "message": "Client not found"}
        assert published == []

    def test_returns_the_failure_when_rabbitmq_cannot_be_published(
        self, monkeypatch, published
    ):
        patch_db(monkeypatch, order_responder())

        def explode(_payload):
            raise RuntimeError("broker down")

        monkeypatch.setattr(cms, "publish_order_created", explode)

        result = cms.create_order_payload("CLI-001", "Colombo", "Kandy", 1.0)

        assert result == {"success": False, "message": "broker down"}

    def test_binds_the_client_lookup_by_client_code(self, monkeypatch, published):
        connections = patch_db(monkeypatch, order_responder())

        cms.create_order_payload("CLI-001", "a", "b", 1.0)

        sql, params = connections[0].sql_log[0]
        assert "FROM clients" in sql
        assert params == ("CLI-001",)


# ─────────────────────────────────────────────────────────────────────────────
# get_client_orders_payload
# ─────────────────────────────────────────────────────────────────────────────
def order_list(*rows):
    return lambda _sql, _params=None: list(rows)


class TestGetClientOrders:
    def test_maps_rows_to_json_friendly_dicts(self, monkeypatch):
        patch_db(
            monkeypatch,
            order_list(
                ("ORD-0002", "Colombo", "Kandy", Decimal("2.50"), "dispatched", NOW),
                ("ORD-0001", "Galle", "Gampaha", None, "pending", NOW),
            ),
        )

        result = cms.get_client_orders_payload("CLI-001")

        assert result["client_code"] == "CLI-001"
        assert result["orders"] == [
            {
                "order_code": "ORD-0002",
                "pickup_address": "Colombo",
                "delivery_address": "Kandy",
                "weight_kg": 2.5,
                "status": "dispatched",
                "created_at": NOW.isoformat(),
            },
            {
                "order_code": "ORD-0001",
                "pickup_address": "Galle",
                "delivery_address": "Gampaha",
                "weight_kg": None,
                "status": "pending",
                "created_at": NOW.isoformat(),
            },
        ]

    def test_orders_are_json_serialisable(self, monkeypatch):
        patch_db(monkeypatch, order_list(("ORD-0001", "a", "b", Decimal("1.5"), "pending", NOW)))

        payload = cms.get_client_orders_payload("CLI-001")

        assert json.loads(json.dumps(payload)) == payload

    def test_returns_an_empty_list_when_the_client_has_no_orders(self, monkeypatch):
        patch_db(monkeypatch, no_rows)

        assert cms.get_client_orders_payload("CLI-001") == {
            "success": True,
            "client_code": "CLI-001",
            "orders": [],
        }

    def test_surfaces_database_errors(self, monkeypatch):
        patch_db(monkeypatch, lambda *_: RuntimeError("boom"))

        assert cms.get_client_orders_payload("CLI-001") == {
            "success": False,
            "message": "boom",
        }


# ─────────────────────────────────────────────────────────────────────────────
# publish_order_created — the RabbitMQ fanout
# ─────────────────────────────────────────────────────────────────────────────
class RecordingChannel:
    def __init__(self):
        self.declared = []
        self.published = []

    def exchange_declare(self, **kwargs):
        self.declared.append(kwargs)

    def basic_publish(self, **kwargs):
        self.published.append(kwargs)


class RecordingConnection:
    def __init__(self):
        self.channel_calls = 0
        self.closed = False
        self._channel = RecordingChannel()

    def channel(self):
        self.channel_calls += 1
        return self._channel

    def close(self):
        self.closed = True


class TestPublishOrderCreated:
    @pytest.fixture()
    def recording(self, monkeypatch):
        created = RecordingConnection()
        monkeypatch.setattr(cms.pika, "BlockingConnection", lambda _params: created)
        return created

    def test_publishes_as_a_durable_json_fanout(self, recording):
        cms.publish_order_created({"event_type": "ORDER_CREATED"})

        channel = recording.channel()
        assert channel.declared == [
            {"exchange": "order_events", "exchange_type": "fanout", "durable": True}
        ]
        publish = channel.published[0]
        assert publish["exchange"] == "order_events"
        assert publish["routing_key"] == ""
        assert json.loads(publish["body"]) == {"event_type": "ORDER_CREATED"}
        assert publish["properties"].content_type == "application/json"
        assert publish["properties"].delivery_mode == 2

    def test_closes_the_connection_even_on_success(self, recording):
        cms.publish_order_created({"event_type": "ORDER_CREATED"})

        assert recording.closed is True

    def test_builds_the_connection_from_rabbitmq_url(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(cms.pika, "URLParameters", lambda url: seen.setdefault("url", url))
        monkeypatch.setattr(cms.pika, "BlockingConnection", lambda _p: RecordingConnection())

        cms.publish_order_created({})

        assert seen["url"] == cms.RABBITMQ_URL


# ─────────────────────────────────────────────────────────────────────────────
# REST surface
# ─────────────────────────────────────────────────────────────────────────────
class TestRestAuth:
    def test_success_returns_200(self, client, monkeypatch):
        patch_db(monkeypatch, client_row("unused"))

        def check(_pw, _hash):
            return True

        monkeypatch.setattr(cms.bcrypt, "checkpw", check)

        response = client.post(
            "/api/clients/auth", json={"email": "ops@acme.ch", "password": "x"}
        )

        assert response.status_code == 200
        assert response.get_json()["client_code"] == "CLI-001"

    @pytest.mark.parametrize(
        "body",
        [
            {"email": "nobody@b.ch", "password": "x"},
            {"email": "", "password": ""},
            {},
        ],
    )
    def test_failure_returns_401(self, client, monkeypatch, body):
        patch_db(monkeypatch, no_rows)

        response = client.post("/api/clients/auth", json=body)

        assert response.status_code == 401
        assert response.get_json()["success"] is False

    def test_wrong_password_returns_401(self, client, monkeypatch):
        stored = bcrypt.hashpw(b"correct horse", bcrypt.gensalt(rounds=4))
        patch_db(monkeypatch, client_row(stored.decode()))

        response = client.post(
            "/api/clients/auth", json={"email": "ops@acme.ch", "password": "wrong"}
        )

        assert response.status_code == 401
        assert response.get_json() == {"success": False, "message": "Invalid password"}

    def test_malformed_json_is_treated_as_an_empty_payload(self, client, monkeypatch):
        patch_db(monkeypatch, no_rows)

        response = client.post(
            "/api/clients/auth", data="not json", content_type="application/json"
        )

        assert response.status_code == 401


class TestRestOrders:
    def test_creates_an_order_with_201(self, client, monkeypatch, published):
        patch_db(monkeypatch, order_responder())

        response = client.post(
            "/api/orders",
            json={
                "client_code": "CLI-001",
                "pickup_address": "Colombo",
                "delivery_address": "Kandy",
                "weight_kg": 2.5,
            },
        )

        assert response.status_code == 201
        assert response.get_json()["order_code"] == "ORD-0042"

    def test_unknown_client_returns_400(self, client, monkeypatch, published):
        patch_db(monkeypatch, order_responder(client_id=None))

        response = client.post(
            "/api/orders",
            json={
                "client_code": "CLI-999",
                "pickup_address": "a",
                "delivery_address": "b",
                "weight_kg": 1,
            },
        )

        assert response.status_code == 400
        assert response.get_json() == {"success": False, "message": "Client not found"}

    def test_a_missing_weight_defaults_to_zero(self, client, monkeypatch, published):
        patch_db(monkeypatch, order_responder())

        response = client.post(
            "/api/orders",
            json={"client_code": "CLI-001", "pickup_address": "a", "delivery_address": "b"},
        )

        assert response.status_code == 201
        assert response.get_json()["weight_kg"] == 0.0

    def test_a_non_numeric_weight_propagates(self, client, monkeypatch, published):
        patch_db(monkeypatch, order_responder())

        # Known gap: the route float()-casts before any validation, so a
        # client sending weight_kg="heavy" turns into an unhandled 500.
        with pytest.raises(ValueError):
            client.post(
                "/api/orders",
                json={
                    "client_code": "CLI-001",
                    "pickup_address": "a",
                    "delivery_address": "b",
                    "weight_kg": "heavy",
                },
            )

    def test_client_orders_returns_200(self, client, monkeypatch):
        patch_db(monkeypatch, order_list(("ORD-1", "a", "b", 1.0, "pending", NOW)))

        response = client.get("/api/orders/CLI-001")

        assert response.status_code == 200
        assert len(response.get_json()["orders"]) == 1

    def test_client_orders_returns_400_on_failure(self, client, monkeypatch):
        patch_db(monkeypatch, lambda *_: RuntimeError("db down"))

        response = client.get("/api/orders/CLI-001")

        assert response.status_code == 400
        assert response.get_json()["message"] == "db down"


class TestRestOrderStatus:
    def test_returns_200_for_a_known_order(self, client, monkeypatch):
        patch_db(monkeypatch, only("FROM orders", [("ORD-0001", "dispatched", NOW, NOW)]))

        response = client.get("/api/orders/status/ORD-0001")

        assert response.status_code == 200
        assert response.get_json() == {
            "success": True,
            "order_code": "ORD-0001",
            "status": "dispatched",
            "created_at": NOW.isoformat(),
            "updated_at": NOW.isoformat(),
        }

    def test_returns_404_for_an_unknown_order(self, client, monkeypatch):
        patch_db(monkeypatch, no_rows)

        response = client.get("/api/orders/status/ORD-9999")

        assert response.status_code == 404
        assert response.get_json() == {"success": False, "message": "Order not found"}

    def test_returns_500_when_the_database_fails(self, client, monkeypatch):
        patch_db(monkeypatch, lambda *_: RuntimeError("db down"))

        response = client.get("/api/orders/status/ORD-0001")

        assert response.status_code == 500
        assert response.get_json() == {"success": False, "message": "db down"}


# ─────────────────────────────────────────────────────────────────────────────
# REST — delivery proofs
# ─────────────────────────────────────────────────────────────────────────────
def delivery_responder(order_id="order-uuid", driver_id="driver-uuid"):
    def respond(sql, _params=None):
        if "UPDATE orders" in sql:
            return []
        if "FROM orders" in sql:
            return [(order_id,)] if order_id else []
        if "FROM drivers" in sql:
            return [(driver_id,)] if driver_id else []
        if "INSERT INTO delivery_proofs" in sql:
            return [("proof-uuid", NOW)]
        return []

    return respond


class TestRestDeliveries:
    DELIVERED = {
        "status": "delivered",
        "driver_code": "DRV001",
        "recipient_name": "M. Meier",
        "signature": "data:image/png;base64,AAAA",
        "notes": "Left at the front desk",
    }

    def test_records_a_successful_delivery(self, client, monkeypatch):
        patch_db(monkeypatch, delivery_responder())

        response = client.post("/api/deliveries/ORD-0001", json=self.DELIVERED)

        assert response.status_code == 201
        assert response.get_json() == {
            "success": True,
            "order_code": "ORD-0001",
            "driver_code": "DRV001",
            "status": "delivered",
            "proof_id": "proof-uuid",
            "captured_at": NOW.isoformat(),
        }

    def test_records_a_failed_delivery_with_a_reason(self, client, monkeypatch):
        patch_db(monkeypatch, delivery_responder())

        response = client.post(
            "/api/deliveries/ORD-0001",
            json={
                "status": "failed",
                "driver_code": "DRV001",
                "reason": "Recipient absent",
            },
        )

        assert response.status_code == 201
        assert response.get_json()["status"] == "failed"

    @pytest.mark.parametrize("status", ["pending", "in_transit", "", None])
    def test_rejects_a_status_outside_delivered_or_failed(self, client, status):
        response = client.post(
            "/api/deliveries/ORD-0001", json={"status": status, "driver_code": "DRV001"}
        )

        assert response.status_code == 400
        assert response.get_json() == {
            "success": False,
            "message": "Status must be delivered or failed",
        }

    def test_requires_a_driver_code(self, client):
        response = client.post(
            "/api/deliveries/ORD-0001",
            json={"status": "delivered", "recipient_name": "x", "signature": "y"},
        )

        assert response.status_code == 400
        assert response.get_json()["message"] == "Driver code is required"

    @pytest.mark.parametrize(
        ("delivery", "missing"),
        [
            ({"recipient_name": ""}, "Recipient name and signature are required"),
            ({"signature": None}, "Recipient name and signature are required"),
            ({"recipient_name": "   "}, "Recipient name and signature are required"),
        ],
    )
    def test_delivered_needs_recipient_and_signature(self, client, delivery, missing):
        payload = {**self.DELIVERED, **delivery}

        response = client.post("/api/deliveries/ORD-0001", json=payload)

        assert response.status_code == 400
        assert response.get_json()["message"] == missing

    def test_failed_needs_a_failure_reason(self, client):
        response = client.post(
            "/api/deliveries/ORD-0001",
            json={"status": "failed", "driver_code": "DRV001"},
        )

        assert response.status_code == 400
        assert response.get_json()["message"] == "Failure reason is required"

    def test_unknown_order_returns_404(self, client, monkeypatch):
        patch_db(monkeypatch, delivery_responder(order_id=None))

        response = client.post("/api/deliveries/ORD-9999", json=self.DELIVERED)

        assert response.status_code == 404
        assert response.get_json()["message"] == "Order not found"

    def test_unknown_driver_returns_404(self, client, monkeypatch):
        patch_db(monkeypatch, delivery_responder(driver_id=None))

        response = client.post("/api/deliveries/ORD-0001", json=self.DELIVERED)

        assert response.status_code == 404
        assert response.get_json()["message"] == "Driver not found"

    def test_validation_happens_before_any_database_access(self, client, monkeypatch):
        connections = patch_db(monkeypatch, delivery_responder())

        response = client.post("/api/deliveries/ORD-0001", json={"status": "pending"})

        assert response.status_code == 400
        assert connections == []


class TestRestHealth:
    def test_health(self, client):
        response = client.get("/health")

        assert response.status_code == 200
        assert response.get_json() == {"status": "ok", "service": "cms-service"}


# ─────────────────────────────────────────────────────────────────────────────
# SOAP surface — real envelopes through the DispatcherMiddleware stack
# ─────────────────────────────────────────────────────────────────────────────
SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/"


@pytest.fixture()
def soap_client():
    return Client(cms.application)


def envelope(body, tns="swifttrack.cms"):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<soap:Envelope xmlns:soap="{SOAP_NS}" xmlns:cms="{tns}">'
        f"<soap:Body>{body}</soap:Body>"
        "</soap:Envelope>"
    ).encode()


def post_soap(soap_client, body):
    return soap_client.post(
        "/soap",
        data=envelope(body),
        headers={
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": '""',
        },
    )


class TestSoapSurface:
    def test_wsdl_is_served(self, soap_client):
        response = soap_client.get("/soap/?wsdl")

        assert response.status_code == 200
        assert b"definitions" in response.data

    def test_ping_round_trip(self, soap_client):
        response = post_soap(soap_client, "<cms:ping/>")

        assert response.status_code == 200
        assert b"CMS SOAP service is running" in response.data

    def test_authenticate_client_returns_json(self, soap_client, monkeypatch):
        patch_db(monkeypatch, client_row("unused"))
        monkeypatch.setattr(cms.bcrypt, "checkpw", lambda *_: True)

        response = post_soap(
            soap_client,
            "<cms:authenticate_client>"
            "<cms:email>ops@acme.ch</cms:email>"
            "<cms:password>correct horse</cms:password>"
            "</cms:authenticate_client>",
        )

        assert response.status_code == 200
        assert b'"success": true' in response.data.replace(b"True", b"true")
        assert b"CLI-001" in response.data

    def test_create_order_returns_json(self, soap_client, monkeypatch, published):
        patch_db(monkeypatch, order_responder(next_number=5))

        response = post_soap(
            soap_client,
            "<cms:create_order>"
            "<cms:client_code>CLI-001</cms:client_code>"
            "<cms:pickup_address>Colombo</cms:pickup_address>"
            "<cms:delivery_address>Kandy</cms:delivery_address>"
            "<cms:weight_kg>2.5</cms:weight_kg>"
            "</cms:create_order>",
        )

        assert response.status_code == 200
        assert b"ORD-0005" in response.data
        assert len(published) == 1

    def test_get_client_orders_returns_json(self, soap_client, monkeypatch):
        patch_db(monkeypatch, order_list(("ORD-0001", "a", "b", 1.0, "pending", NOW)))

        response = post_soap(
            soap_client,
            "<cms:get_client_orders><cms:client_code>CLI-001</cms:client_code></cms:get_client_orders>",
        )

        assert response.status_code == 200
        assert b"ORD-0001" in response.data

    def test_rest_endpoints_still_resolve_outside_soap(self, soap_client):
        response = soap_client.get("/health")

        assert response.status_code == 200
        assert response.get_json()["service"] == "cms-service"


# ─────────────────────────────────────────────────────────────────────────────
# Module contract
# ─────────────────────────────────────────────────────────────────────────────
def test_soap_and_rest_share_one_wsgi_application():
    assert "/soap" in cms.application.mounts
    assert cms.application.app is cms.flask_app


def test_soap_service_advertises_four_operations():
    assert set(cms.CMSService.__dict__) >= {
        "ping",
        "authenticate_client",
        "create_order",
        "get_client_orders",
    }
