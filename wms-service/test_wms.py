"""Tests for the Warehouse Management System.

Runs inside the shared Python test image (``Dockerfile.test``) on the same
interpreter the service ships with.  Every database touch is replaced by an
in-memory fake so the suite needs no Postgres.
"""

import json
import socket
import threading
from datetime import UTC, datetime

import app as wms
import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────────────────
class FakeCursor:
    def __init__(self, connection):
        self._connection = connection
        self._rows = []

    def execute(self, sql, params=None):
        self._connection.sql_log.append((sql, params))
        self._rows = list(self._connection.responder(sql, params))

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
    """Point the module at a fake connection factory and return the log."""
    connections = []

    def factory():
        connection = FakeConnection(responder)
        connections.append(connection)
        return connection

    monkeypatch.setattr(wms, "get_db_connection", factory)
    return connections


def no_rows(_sql, _params=None):
    return []


def rows(*tuples):
    return lambda _sql, _params=None: list(tuples)


NOW = datetime(2026, 10, 1, 8, 30, tzinfo=UTC)


# ─────────────────────────────────────────────────────────────────────────────
# assign_location
# ─────────────────────────────────────────────────────────────────────────────
class TestAssignLocation:
    def test_is_deterministic_for_the_same_order_code(self):
        assert wms.assign_location("ORD-0001") == wms.assign_location("ORD-0001")

    def test_returns_a_zone_and_a_bin_in_that_zone(self):
        zone, bin_location = wms.assign_location("ORD-0042")
        assert zone.startswith("Zone ")
        zone_letter = zone.split()[1]
        assert zone_letter in {"A", "B", "C", "D"}
        assert bin_location[0] == zone_letter

    def test_bin_follows_the_rack_shelf_shape(self):
        _, bin_location = wms.assign_location("ORD-0042")
        rack_shelf = bin_location[1:]
        rack, shelf = rack_shelf.split("-")
        assert rack.isdigit() and 1 <= int(rack) <= 5
        assert shelf.isdigit() and 1 <= int(shelf) <= 3

    def test_different_orders_spread_across_zones(self):
        zones = {wms.assign_location(f"ORD-{n:04d}")[0] for n in range(40)}
        assert len(zones) > 1

    def test_known_order_code_matches_the_hash_formula(self):
        seed = sum(ord(ch) for ch in "ORD-0001")
        expected_zone = ["A", "B", "C", "D"][seed % 4]
        assert wms.assign_location("ORD-0001") == (
            f"Zone {expected_zone}",
            f"{expected_zone}{(seed % 5) + 1}-{(seed % 3) + 1}",
        )


# ─────────────────────────────────────────────────────────────────────────────
# json_response
# ─────────────────────────────────────────────────────────────────────────────
class TestJsonResponse:
    def test_emits_one_json_object_terminated_by_a_newline(self):
        payload = wms.json_response(True, message="PONG")
        assert payload.endswith("\n")
        assert json.loads(payload) == {"success": True, "message": "PONG"}

    def test_round_trips_extra_fields(self):
        payload = wms.json_response(True, barcode="BC-1", status="picked")
        assert json.loads(payload) == {
            "success": True,
            "barcode": "BC-1",
            "status": "picked",
        }


# ─────────────────────────────────────────────────────────────────────────────
# register_package
# ─────────────────────────────────────────────────────────────────────────────
def order_row(_sql, _params=None):
    if "FROM orders" in _sql:
        return [("order-uuid", 2.4)]
    return []


class TestRegisterPackage:
    def test_registers_a_new_package_and_returns_its_bin(self, monkeypatch):
        def responder(sql, _params=None):
            if "FROM orders" in sql:
                return [("order-uuid", 2.4)]
            if "FROM packages" in sql:
                return []
            if sql.strip().upper().startswith("INSERT INTO PACKAGES"):
                return [("pkg-uuid", "BC-ORD-0001", "Zone A", "A1-1", "received")]
            return []

        connections = patch_db(monkeypatch, responder)

        result = wms.register_package("ORD-0001")

        assert result["success"] is True
        assert result["already_registered"] is False
        assert result["barcode"] == "BC-ORD-0001"
        assert result["warehouse_zone"] == "Zone A"
        assert result["bin_location"] == "A1-1"
        assert result["status"] == "received"
        assert result["weight_kg"] == 2.4
        assert len(connections) == 1

    def test_is_idempotent_for_an_order_that_already_has_a_package(self, monkeypatch):
        def responder(sql, _params=None):
            if "FROM orders" in sql:
                return [("order-uuid", 1.0)]
            if "FROM packages" in sql:
                return [("pkg-uuid", "BC-ORD-0001", "Zone B", "B2-3", "stored")]
            return []

        patch_db(monkeypatch, responder)

        result = wms.register_package("ORD-0001")

        assert result["success"] is True
        assert result["already_registered"] is True
        assert result["status"] == "stored"
        assert result["bin_location"] == "B2-3"

    def test_rejects_an_unknown_order_without_writing_a_package(self, monkeypatch):
        connections = patch_db(monkeypatch, no_rows)

        result = wms.register_package("ORD-9999")

        assert result == {"success": False, "message": "Order not found"}
        joined = " ".join(sql for conn in connections for sql, _ in conn.sql_log)
        assert "INSERT INTO packages" not in joined

    def test_handles_a_null_weight(self, monkeypatch):
        def responder(sql, _params=None):
            if "FROM orders" in sql:
                return [("order-uuid", None)]
            if "FROM packages" in sql:
                return []
            if sql.strip().upper().startswith("INSERT INTO PACKAGES"):
                return [("pkg-uuid", "BC-ORD-0001", "Zone A", "A1-1", "received")]
            return []

        patch_db(monkeypatch, responder)

        assert wms.register_package("ORD-0001")["weight_kg"] is None


# ─────────────────────────────────────────────────────────────────────────────
# get_package
# ─────────────────────────────────────────────────────────────────────────────
def package_row(_sql, _params=None):
    return [("pkg-uuid", "ORD-0001", "BC-ORD-0001", "Zone A", "A1-1", "received", NOW)]


class TestGetPackage:
    def test_returns_the_package_for_an_order_code(self, monkeypatch):
        connections = patch_db(monkeypatch, package_row)

        result = wms.get_package(order_code="ORD-0001")

        assert result["success"] is True
        assert result["order_code"] == "ORD-0001"
        assert result["warehouse_event_at"] == NOW.isoformat()
        assert "o.order_code = %s" in connections[0].sql_log[0][0]

    def test_returns_the_package_for_a_barcode(self, monkeypatch):
        connections = patch_db(monkeypatch, package_row)

        result = wms.get_package(barcode="BC-ORD-0001")

        assert result["success"] is True
        assert "p.barcode = %s" in connections[0].sql_log[0][0]

    def test_reports_a_miss_instead_of_raising(self, monkeypatch):
        patch_db(monkeypatch, no_rows)

        assert wms.get_package(order_code="ORD-9999") == {
            "success": False,
            "message": "Package not found",
        }


# ─────────────────────────────────────────────────────────────────────────────
# update_package_status
# ─────────────────────────────────────────────────────────────────────────────
def updated_row(_sql, params=None):
    # `SET status = %s` is always the first bound parameter, so the fake
    # echoes back whatever transition the code under test actually sent.
    status = params[0] if params else "picked"
    return [("pkg-uuid", "ORD-0001", "BC-ORD-0001", "Zone A", "A1-1", status)]


class TestUpdatePackageStatus:
    @pytest.mark.parametrize("status", sorted(wms.ALLOWED_STATUSES))
    def test_accepts_every_allowed_status(self, monkeypatch, status):
        patch_db(monkeypatch, updated_row)

        result = wms.update_package_status(order_code="ORD-0001", status=status)

        assert result["success"] is True
        assert result["status"] == status

    @pytest.mark.parametrize("status", ["exploded", "", "RECEIVED", None, "ready"])
    def test_rejects_disallowed_statuses_before_touching_the_database(
        self, monkeypatch, status
    ):
        connections = patch_db(monkeypatch, updated_row)

        result = wms.update_package_status(order_code="ORD-0001", status=status)

        assert result["success"] is False
        assert result["message"].startswith("Invalid status.")
        assert connections == []

    def test_returns_not_found_when_the_order_does_not_exist(self, monkeypatch):
        patch_db(monkeypatch, no_rows)

        result = wms.update_package_status(order_code="ORD-9999", status="picked")

        assert result == {"success": False, "message": "Package not found"}

    def test_can_target_a_barcode_instead_of_an_order_code(self, monkeypatch):
        connections = patch_db(monkeypatch, updated_row)

        wms.update_package_status(barcode="BC-ORD-0001", status="loaded")

        assert "p.barcode = %s" in connections[0].sql_log[0][0]

    def test_by_id_targets_the_package_primary_key(self, monkeypatch):
        connections = patch_db(monkeypatch, updated_row)

        result = wms.update_package_status_by_id("pkg-uuid", "dispatched")

        assert result["success"] is True
        assert "p.id = %s" in connections[0].sql_log[0][0]

    def test_by_id_rejects_an_illegal_status_without_a_query(self, monkeypatch):
        connections = patch_db(monkeypatch, updated_row)

        result = wms.update_package_status_by_id("pkg-uuid", "bogus")

        assert result["success"] is False
        assert connections == []


# ─────────────────────────────────────────────────────────────────────────────
# handle_tcp_command — the wire protocol
# ─────────────────────────────────────────────────────────────────────────────
class TestHandleTcpCommand:
    def test_ping_answers_pong_without_a_database(self, monkeypatch):
        connections = patch_db(monkeypatch, no_rows)

        assert wms.handle_tcp_command({"type": "PING"}) == {
            "success": True,
            "message": "PONG",
        }
        assert connections == []

    def test_accepts_the_synonym_command_field(self, monkeypatch):
        patch_db(monkeypatch, no_rows)

        assert wms.handle_tcp_command({"command": "PING"})["message"] == "PONG"

    def test_register_package_dispatches_to_the_registrar(self, monkeypatch):
        calls = []
        monkeypatch.setattr(wms, "register_package", lambda code: calls.append(code) or {"success": True})

        assert wms.handle_tcp_command({"type": "REGISTER_PACKAGE", "order_code": "ORD-7"})
        assert calls == ["ORD-7"]

    def test_get_package_passes_both_selector_fields(self, monkeypatch):
        captured = {}

        def fake_get(order_code=None, barcode=None):
            captured.update(order_code=order_code, barcode=barcode)
            return {"success": True}

        monkeypatch.setattr(wms, "get_package", fake_get)

        wms.handle_tcp_command({"type": "GET_PACKAGE", "barcode": "BC-1"})

        assert captured == {"order_code": None, "barcode": "BC-1"}

    def test_update_status_passes_the_transition_through(self, monkeypatch):
        captured = {}

        def fake_update(**kwargs):
            captured.update(kwargs)
            return {"success": True}

        monkeypatch.setattr(wms, "update_package_status", fake_update)

        wms.handle_tcp_command(
            {"type": "UPDATE_STATUS", "order_code": "ORD-1", "status": "picked"}
        )

        assert captured["order_code"] == "ORD-1"
        assert captured["status"] == "picked"

    @pytest.mark.parametrize("command", ["NOPE", "DROP TABLE", "", None, 42])
    def test_unsupported_commands_return_a_structured_error(self, command):
        result = wms.handle_tcp_command({"type": command})

        assert result["success"] is False
        assert result["message"].startswith("Unsupported command:")

    def test_command_field_may_be_omitted(self):
        result = wms.handle_tcp_command({})

        assert result["success"] is False
        assert result["message"].startswith("Unsupported command:")


# ─────────────────────────────────────────────────────────────────────────────
# handle_tcp_client — newline framing over a real socket pair
# ─────────────────────────────────────────────────────────────────────────────
def _run_tcp_client(server_sock, client_sock, action):
    """Drive ``handle_tcp_client`` on ``server_sock`` from ``client_sock``.

    Closing the *client* end is what ends the server loop (recv() returns
    b""), so the server socket must only be closed once the worker thread
    has finished with it.
    """
    thread = threading.Thread(
        target=wms.handle_tcp_client, args=(server_sock, ("test", 0)), daemon=True
    )
    thread.start()
    try:
        return action()
    finally:
        client_sock.close()
        thread.join(timeout=5)
        server_sock.close()


class TestTcpFraming:
    def test_answers_a_single_ping(self):
        server_sock, client_sock = socket.socketpair()

        def exchange():
            client_sock.sendall(b'{"type": "PING"}\n')
            return json.loads(client_sock.recv(4096).decode())

        assert _run_tcp_client(server_sock, client_sock, exchange) == {
            "success": True,
            "message": "PONG",
        }

    def test_handles_two_commands_on_one_connection(self):
        server_sock, client_sock = socket.socketpair()

        def exchange():
            client_sock.sendall(b'{"type": "PING"}\n{"type": "PING"}\n')
            buffer = b""
            while buffer.count(b"\n") < 2:
                chunk = client_sock.recv(4096)
                if not chunk:
                    break
                buffer += chunk
            return [json.loads(line) for line in buffer.strip().split(b"\n")]

        results = _run_tcp_client(server_sock, client_sock, exchange)
        assert len(results) == 2
        assert all(item["message"] == "PONG" for item in results)

    def test_reports_bad_json_instead_of_closing_the_connection(self):
        server_sock, client_sock = socket.socketpair()

        def exchange():
            client_sock.sendall(b"not json at all\n")
            first = json.loads(client_sock.recv(4096).decode())
            client_sock.sendall(b'{"type": "PING"}\n')
            second = json.loads(client_sock.recv(4096).decode())
            return first, second

        first, second = _run_tcp_client(server_sock, client_sock, exchange)

        assert first["success"] is False
        assert first["message"]
        assert second == {"success": True, "message": "PONG"}

    def test_ignores_blank_lines(self):
        server_sock, client_sock = socket.socketpair()

        def exchange():
            client_sock.sendall(b'\n\n{"type": "PING"}\n')
            return json.loads(client_sock.recv(4096).decode())

        assert _run_tcp_client(server_sock, client_sock, exchange)["message"] == "PONG"


# ─────────────────────────────────────────────────────────────────────────────
# Flask REST surface
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def client(monkeypatch):
    patch_db(monkeypatch, no_rows)
    wms.app.config["TESTING"] = True
    with wms.app.test_client() as test_client:
        yield test_client


class TestRestEndpoints:
    def test_health(self, client):
        response = client.get("/health")

        assert response.status_code == 200
        assert response.get_json() == {"status": "ok", "service": "wms-service"}

    def test_package_by_order_returns_404_on_a_miss(self, client):
        response = client.get("/api/packages/order/ORD-9999")

        assert response.status_code == 404
        assert response.get_json()["success"] is False

    def test_package_by_order_returns_200_on_a_hit(self, client, monkeypatch):
        patch_db(monkeypatch, package_row)

        response = client.get("/api/packages/order/ORD-0001")

        assert response.status_code == 200
        assert response.get_json()["barcode"] == "BC-ORD-0001"

    def test_create_package_validates_the_order_code(self, client, monkeypatch):
        patch_db(monkeypatch, no_rows)

        response = client.post("/api/packages", json={"order_code": "ORD-9999"})

        assert response.status_code == 400
        assert response.get_json() == {"success": False, "message": "Order not found"}

    def test_create_package_returns_201_for_a_valid_order(self, client, monkeypatch):
        def responder(sql, _params=None):
            if "FROM orders" in sql:
                return [("order-uuid", 2.4)]
            if "FROM packages" in sql:
                return []
            if sql.strip().upper().startswith("INSERT INTO PACKAGES"):
                return [("pkg-uuid", "BC-ORD-1", "Zone C", "C1-2", "received")]
            return []

        patch_db(monkeypatch, responder)

        response = client.post("/api/packages", json={"order_code": "ORD-1"})

        assert response.status_code == 201
        assert response.get_json()["success"] is True

    def test_update_status_by_id_rejects_an_illegal_status(self, client):
        response = client.put("/api/packages/pkg-uuid/status", json={"status": "bogus"})

        assert response.status_code == 400
        assert response.get_json()["success"] is False

    def test_update_status_by_id_accepts_a_legal_status(self, client, monkeypatch):
        patch_db(monkeypatch, updated_row)

        response = client.put("/api/packages/pkg-uuid/status", json={"status": "picked"})

        assert response.status_code == 200
        assert response.get_json()["status"] == "picked"

    def test_warehouse_locations_covers_every_zone_rack_shelf(self, client):
        response = client.get("/api/warehouse/locations")

        assert response.status_code == 200
        locations = response.get_json()["locations"]
        assert len(locations) == 4 * 5 * 3
        assert all(item["available"] for item in locations)
        assert {item["warehouse_zone"] for item in locations} == {
            "Zone A",
            "Zone B",
            "Zone C",
            "Zone D",
        }


# ─────────────────────────────────────────────────────────────────────────────
# Module contract
# ─────────────────────────────────────────────────────────────────────────────
def test_allowed_statuses_match_the_database_check_constraint():
    # packages.status also allows 'ready', which the TCP surface deliberately
    # does not expose — drivers must go through the picking workflow.
    assert {
        "received",
        "stored",
        "picked",
        "loaded",
        "dispatched",
    } == wms.ALLOWED_STATUSES


def test_app_module_exposes_both_servers():
    assert callable(wms.start_tcp_server)
    assert callable(wms.consume_order_events)
    assert callable(wms.publish_wms_event)
