import json
import os
from datetime import datetime, timezone

import bcrypt
import pika
import psycopg2
from flask import Flask, jsonify
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


class CMSService(ServiceBase):
    @rpc(_returns=Unicode)
    def ping(ctx):
        return "CMS SOAP service is running"

    @rpc(Unicode, Unicode, _returns=Unicode)
    def authenticate_client(ctx, email, password):
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
                return json.dumps({"success": False, "message": "Client not found"})

            client_code, company_name, client_email, password_hash = row
            password_ok = bcrypt.checkpw(
                password.encode("utf-8"),
                password_hash.encode("utf-8"),
            )

            if not password_ok:
                return json.dumps({"success": False, "message": "Invalid password"})

            return json.dumps(
                {
                    "success": True,
                    "client_code": client_code,
                    "company_name": company_name,
                    "email": client_email,
                }
            )

        except Exception as error:
            return json.dumps({"success": False, "message": str(error)})

    @rpc(Unicode, Unicode, Unicode, Float, _returns=Unicode)
    def create_order(ctx, client_code, pickup_address, delivery_address, weight_kg):
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id FROM clients WHERE client_code = %s",
                        (client_code,),
                    )
                    client_row = cur.fetchone()

                    if client_row is None:
                        return json.dumps(
                            {"success": False, "message": "Client not found"}
                        )

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

            return json.dumps(
                {
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
            )

        except Exception as error:
            return json.dumps({"success": False, "message": str(error)})

    @rpc(Unicode, _returns=Unicode)
    def get_client_orders(ctx, client_code):
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

            return json.dumps(
                {"success": True, "client_code": client_code, "orders": orders}
            )

        except Exception as error:
            return json.dumps({"success": False, "message": str(error)})


soap_app = Application(
    [CMSService],
    tns="swifttrack.cms",
    in_protocol=Soap11(validator="lxml"),
    out_protocol=Soap11(),
)

application = DispatcherMiddleware(flask_app, {"/soap": WsgiApplication(soap_app)})

run_simple("0.0.0.0", 8001, application)
