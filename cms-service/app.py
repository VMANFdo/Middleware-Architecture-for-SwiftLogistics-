import json
import os
from datetime import datetime, timezone

import bcrypt
import pika
import psycopg2
from flask import Flask, jsonify, request
from spyne import Application, Float, ServiceBase, Unicode, rpc
from spyne.protocol.soap import Soap11
from spyne.server.wsgi import WsgiApplication
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import run_simple


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://swift_admin:swift_pw_dev_only@postgres:5432/swifttrack",
)
RABBITMQ_URL = os.getenv(
    "RABBITMQ_URL",
    "amqp://swift_admin:swift_pw_dev_only@rabbitmq:5672",
)
ORDER_EXCHANGE = "order_events"

flask_app = Flask("cms-service")


@flask_app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "cms-service"})


@flask_app.route("/api/clients/auth", methods=["POST"])
def rest_authenticate_client():
    payload = request.get_json(silent=True) or {}
    result = authenticate_client_payload(
        payload.get("email", ""),
        payload.get("password", ""),
    )
    return jsonify(result), 200 if result.get("success") else 401


@flask_app.route("/api/orders", methods=["POST"])
def rest_create_order():
    payload = request.get_json(silent=True) or {}
    result = create_order_payload(
        payload.get("client_code", ""),
        payload.get("pickup_address", ""),
        payload.get("delivery_address", ""),
        float(payload.get("weight_kg", 0) or 0),
    )
    return jsonify(result), 201 if result.get("success") else 400


@flask_app.route("/api/orders/<client_code>", methods=["GET"])
def rest_client_orders(client_code):
    result = get_client_orders_payload(client_code)
    return jsonify(result), 200 if result.get("success") else 400


@flask_app.route("/api/orders/status/<order_code>", methods=["GET"])
def rest_order_status(order_code):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT o.order_code, o.status, o.created_at, o.updated_at
                    FROM orders o
                    WHERE o.order_code = %s
                    """,
                    (order_code,),
                )
                row = cur.fetchone()

        if row is None:
            return jsonify({"success": False, "message": "Order not found"}), 404

        return jsonify(
            {
                "success": True,
                "order_code": row[0],
                "status": row[1],
                "created_at": row[2].isoformat(),
                "updated_at": row[3].isoformat(),
            }
        )
    except Exception as error:
        return jsonify({"success": False, "message": str(error)}), 500


@flask_app.route("/api/deliveries/<order_code>", methods=["POST"])
def rest_record_delivery(order_code):
    payload = request.get_json(silent=True) or {}
    delivery_status = payload.get("status")
    driver_code = payload.get("driver_code")
    recipient_name = (payload.get("recipient_name") or "").strip()
    failure_reason = payload.get("reason")
    signature_base64 = payload.get("signature")
    notes = payload.get("notes")

    if delivery_status not in {"delivered", "failed"}:
        return jsonify({"success": False, "message": "Status must be delivered or failed"}), 400
    if not driver_code:
        return jsonify({"success": False, "message": "Driver code is required"}), 400
    if delivery_status == "delivered" and (not recipient_name or not signature_base64):
        return jsonify({"success": False, "message": "Recipient name and signature are required"}), 400
    if delivery_status == "failed" and not failure_reason:
        return jsonify({"success": False, "message": "Failure reason is required"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM orders WHERE order_code = %s", (order_code,))
                order_row = cur.fetchone()
                cur.execute("SELECT id FROM drivers WHERE driver_code = %s", (driver_code,))
                driver_row = cur.fetchone()

                if order_row is None:
                    return jsonify({"success": False, "message": "Order not found"}), 404
                if driver_row is None:
                    return jsonify({"success": False, "message": "Driver not found"}), 404

                cur.execute(
                    "UPDATE orders SET status = %s WHERE id = %s",
                    (delivery_status, order_row[0]),
                )
                cur.execute(
                    """
                    INSERT INTO delivery_proofs (
                        order_id, driver_id, delivery_status, failure_reason,
                        recipient_name, notes, signature_base64
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id, captured_at
                    """,
                    (
                        order_row[0], driver_row[0], delivery_status,
                        failure_reason, recipient_name or None, notes,
                        signature_base64,
                    ),
                )
                proof_id, captured_at = cur.fetchone()

        return jsonify(
            {
                "success": True,
                "order_code": order_code,
                "driver_code": driver_code,
                "status": delivery_status,
                "proof_id": str(proof_id),
                "captured_at": captured_at.isoformat(),
            }
        ), 201
    except Exception as error:
        return jsonify({"success": False, "message": str(error)}), 500


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def estimate_coordinates(address):
    known_points = {
        "colombo": (6.9271, 79.8612),
        "kandy": (7.2906, 80.6337),
        "gampaha": (7.0873, 80.0144),
        "galle": (6.0535, 80.2210),
        "havelock": (6.8869, 79.8651),
    }

    text = (address or "").lower()
    for key, point in known_points.items():
        if key in text:
            return point

    # Deterministic fallback near Colombo so route demos always have coordinates.
    offset = (sum(ord(ch) for ch in text) % 100) / 10000
    return (6.9271 + offset, 79.8612 + offset)


def publish_order_created(event_payload):
    params = pika.URLParameters(RABBITMQ_URL)
    connection = pika.BlockingConnection(params)
    channel = connection.channel()
    channel.exchange_declare(
        exchange=ORDER_EXCHANGE,
        exchange_type="fanout",
        durable=True,
    )
    channel.basic_publish(
        exchange=ORDER_EXCHANGE,
        routing_key="",
        body=json.dumps(event_payload),
        properties=pika.BasicProperties(
            content_type="application/json",
            delivery_mode=2,
        ),
    )
    connection.close()


def authenticate_client_payload(email, password):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT client_code, company_name, email, password_hash
                    FROM clients
                    WHERE email = %s
                    """,
                    (email,),
                )
                row = cur.fetchone()

        if row is None:
            return {"success": False, "message": "Client not found"}

        client_code, company_name, client_email, password_hash = row
        password_ok = bcrypt.checkpw(
            password.encode("utf-8"),
            password_hash.encode("utf-8"),
        )

        if not password_ok:
            return {"success": False, "message": "Invalid password"}

        return {
            "success": True,
            "client_code": client_code,
            "company_name": company_name,
            "email": client_email,
        }

    except Exception as error:
        return {"success": False, "message": str(error)}


def create_order_payload(client_code, pickup_address, delivery_address, weight_kg):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM clients WHERE client_code = %s",
                    (client_code,),
                )
                client_row = cur.fetchone()

                if client_row is None:
                    return {"success": False, "message": "Client not found"}

                client_id = client_row[0]

                cur.execute(
                    """
                    SELECT COALESCE(
                        MAX(CAST(SUBSTRING(order_code FROM 5) AS INTEGER)),
                        0
                    ) + 1
                    FROM orders
                    WHERE order_code LIKE 'ORD-%'
                    """
                )
                next_number = cur.fetchone()[0]
                order_code = f"ORD-{next_number:04d}"

                cur.execute(
                    """
                    INSERT INTO orders (
                        order_code,
                        client_id,
                        pickup_address,
                        delivery_address,
                        weight_kg,
                        status
                    )
                    VALUES (%s, %s, %s, %s, %s, 'pending')
                    RETURNING order_code, status, created_at
                    """,
                    (
                        order_code,
                        client_id,
                        pickup_address,
                        delivery_address,
                        weight_kg,
                    ),
                )
                created_order = cur.fetchone()

        pickup_lat, pickup_lng = estimate_coordinates(pickup_address)
        delivery_lat, delivery_lng = estimate_coordinates(delivery_address)
        event_payload = {
            "event_type": "ORDER_CREATED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": {
                "order_code": order_code,
                "client_code": client_code,
                "pickup_address": pickup_address,
                "delivery_address": delivery_address,
                "pickup_lat": pickup_lat,
                "pickup_lng": pickup_lng,
                "delivery_lat": delivery_lat,
                "delivery_lng": delivery_lng,
                "weight_kg": float(weight_kg),
                "status": created_order[1],
            },
        }
        publish_order_created(event_payload)

        return {
            "success": True,
            "order_code": created_order[0],
            "client_code": client_code,
            "pickup_address": pickup_address,
            "delivery_address": delivery_address,
            "weight_kg": float(weight_kg),
            "status": created_order[1],
            "created_at": created_order[2].isoformat(),
            "event_published": True,
        }

    except Exception as error:
        return {"success": False, "message": str(error)}


def get_client_orders_payload(client_code):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT o.order_code,
                           o.pickup_address,
                           o.delivery_address,
                           o.weight_kg,
                           o.status,
                           o.created_at
                    FROM orders o
                    JOIN clients c ON c.id = o.client_id
                    WHERE c.client_code = %s
                    ORDER BY o.created_at DESC
                    """,
                    (client_code,),
                )
                rows = cur.fetchall()

        orders = [
            {
                "order_code": row[0],
                "pickup_address": row[1],
                "delivery_address": row[2],
                "weight_kg": float(row[3]) if row[3] is not None else None,
                "status": row[4],
                "created_at": row[5].isoformat(),
            }
            for row in rows
        ]

        return {"success": True, "client_code": client_code, "orders": orders}

    except Exception as error:
        return {"success": False, "message": str(error)}


class CMSService(ServiceBase):
    @rpc(_returns=Unicode)
    def ping(ctx):
        return "CMS SOAP service is running"

    @rpc(Unicode, Unicode, _returns=Unicode)
    def authenticate_client(ctx, email, password):
        return json.dumps(authenticate_client_payload(email, password))

    @rpc(Unicode, Unicode, Unicode, Float, _returns=Unicode)
    def create_order(ctx, client_code, pickup_address, delivery_address, weight_kg):
        return json.dumps(
            create_order_payload(
                client_code,
                pickup_address,
                delivery_address,
                weight_kg,
            )
        )

    @rpc(Unicode, _returns=Unicode)
    def get_client_orders(ctx, client_code):
        return json.dumps(get_client_orders_payload(client_code))


soap_app = Application(
    [CMSService],
    tns="swifttrack.cms",
    in_protocol=Soap11(validator="lxml"),
    out_protocol=Soap11(),
)

application = DispatcherMiddleware(flask_app, {"/soap": WsgiApplication(soap_app)})

run_simple("0.0.0.0", 8001, application)
