import json
import os
import random
import socket
import threading
import time
from datetime import datetime, timezone

import pika
import psycopg2
from flask import Flask, jsonify, request


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://swift_admin:swift_pw_dev_only@postgres:5432/swifttrack",
)
RABBITMQ_URL = os.getenv(
    "RABBITMQ_URL",
    "amqp://swift_admin:swift_pw_dev_only@rabbitmq:5672",
)
ORDER_EXCHANGE = "order_events"
WMS_EXCHANGE = "wms_events"
ORDER_QUEUE = "wms_order_events"
HTTP_PORT = int(os.getenv("PORT", "8003"))
TCP_PORT = int(os.getenv("WMS_TCP_PORT", "9000"))
ALLOWED_STATUSES = {"received", "stored", "picked", "loaded", "dispatched"}

app = Flask("wms-service")


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def json_response(success, **kwargs):
    payload = {"success": success, **kwargs}
    return json.dumps(payload) + "\n"


def assign_location(order_code):
    zones = ["A", "B", "C", "D"]
    seed = sum(ord(ch) for ch in order_code)
    zone = zones[seed % len(zones)]
    rack = (seed % 5) + 1
    shelf = (seed % 3) + 1
    return f"Zone {zone}", f"{zone}{rack}-{shelf}"


def register_package(order_code):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, weight_kg FROM orders WHERE order_code = %s",
                (order_code,),
            )
            order_row = cur.fetchone()
            if order_row is None:
                return {"success": False, "message": "Order not found"}

            order_id, weight_kg = order_row
            cur.execute(
                """
                SELECT id, barcode, warehouse_zone, bin_location, status
                FROM packages
                WHERE order_id = %s
                ORDER BY warehouse_event_at DESC
                LIMIT 1
                """,
                (order_id,),
            )
            existing = cur.fetchone()
            if existing:
                return {
                    "success": True,
                    "package_id": str(existing[0]),
                    "order_code": order_code,
                    "barcode": existing[1],
                    "warehouse_zone": existing[2],
                    "bin_location": existing[3],
                    "status": existing[4],
                    "weight_kg": float(weight_kg) if weight_kg is not None else None,
                    "already_registered": True,
                }

            warehouse_zone, bin_location = assign_location(order_code)
            barcode = f"BC-{order_code}"
            cur.execute(
                """
                INSERT INTO packages (
                    order_id,
                    barcode,
                    warehouse_zone,
                    bin_location,
                    status
                )
                VALUES (%s, %s, %s, %s, 'received')
                RETURNING id, barcode, warehouse_zone, bin_location, status
                """,
                (order_id, barcode, warehouse_zone, bin_location),
            )
            package = cur.fetchone()

    return {
        "success": True,
        "package_id": str(package[0]),
        "order_code": order_code,
        "barcode": package[1],
        "warehouse_zone": package[2],
        "bin_location": package[3],
        "status": package[4],
        "weight_kg": float(weight_kg) if weight_kg is not None else None,
        "already_registered": False,
    }


def get_package(order_code=None, barcode=None):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            if order_code:
                cur.execute(
                    """
                    SELECT p.id, o.order_code, p.barcode, p.warehouse_zone,
                           p.bin_location, p.status, p.warehouse_event_at
                    FROM packages p
                    JOIN orders o ON o.id = p.order_id
                    WHERE o.order_code = %s
                    ORDER BY p.warehouse_event_at DESC
                    LIMIT 1
                    """,
                    (order_code,),
                )
            else:
                cur.execute(
                    """
                    SELECT p.id, o.order_code, p.barcode, p.warehouse_zone,
                           p.bin_location, p.status, p.warehouse_event_at
                    FROM packages p
                    JOIN orders o ON o.id = p.order_id
                    WHERE p.barcode = %s
                    ORDER BY p.warehouse_event_at DESC
                    LIMIT 1
                    """,
                    (barcode,),
                )

            row = cur.fetchone()

    if row is None:
        return {"success": False, "message": "Package not found"}

    return {
        "success": True,
        "package_id": str(row[0]),
        "order_code": row[1],
        "barcode": row[2],
        "warehouse_zone": row[3],
        "bin_location": row[4],
        "status": row[5],
        "warehouse_event_at": row[6].isoformat(),
    }


def update_package_status(order_code=None, barcode=None, status=None):
    if status not in ALLOWED_STATUSES:
        return {
            "success": False,
            "message": f"Invalid status. Use one of: {sorted(ALLOWED_STATUSES)}",
        }

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            if order_code:
                cur.execute(
                    """
                    UPDATE packages p
                    SET status = %s,
                        warehouse_event_at = now()
                    FROM orders o
                    WHERE p.order_id = o.id
                      AND o.order_code = %s
                    RETURNING p.id, o.order_code, p.barcode,
                              p.warehouse_zone, p.bin_location, p.status
                    """,
                    (status, order_code),
                )
            else:
                cur.execute(
                    """
                    UPDATE packages p
                    SET status = %s,
                        warehouse_event_at = now()
                    FROM orders o
                    WHERE p.order_id = o.id
                      AND p.barcode = %s
                    RETURNING p.id, o.order_code, p.barcode,
                              p.warehouse_zone, p.bin_location, p.status
                    """,
                    (status, barcode),
                )

            row = cur.fetchone()

    if row is None:
        return {"success": False, "message": "Package not found"}

    return {
        "success": True,
        "package_id": str(row[0]),
        "order_code": row[1],
        "barcode": row[2],
        "warehouse_zone": row[3],
        "bin_location": row[4],
        "status": row[5],
    }


def update_package_status_by_id(package_id, status):
    if status not in ALLOWED_STATUSES:
        return {
            "success": False,
            "message": f"Invalid status. Use one of: {sorted(ALLOWED_STATUSES)}",
        }

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE packages p
                SET status = %s,
                    warehouse_event_at = now()
                FROM orders o
                WHERE p.order_id = o.id
                  AND p.id = %s
                RETURNING p.id, o.order_code, p.barcode,
                          p.warehouse_zone, p.bin_location, p.status
                """,
                (status, package_id),
            )
            row = cur.fetchone()

    if row is None:
        return {"success": False, "message": "Package not found"}

    return {
        "success": True,
        "package_id": str(row[0]),
        "order_code": row[1],
        "barcode": row[2],
        "warehouse_zone": row[3],
        "bin_location": row[4],
        "status": row[5],
    }


def handle_tcp_command(command):
    command_type = command.get("type") or command.get("command")

    if command_type == "PING":
        return {"success": True, "message": "PONG"}

    if command_type == "REGISTER_PACKAGE":
        return register_package(command.get("order_code"))

    if command_type == "GET_PACKAGE":
        return get_package(
            order_code=command.get("order_code"),
            barcode=command.get("barcode"),
        )

    if command_type == "UPDATE_STATUS":
        return update_package_status(
            order_code=command.get("order_code"),
            barcode=command.get("barcode"),
            status=command.get("status"),
        )

    return {"success": False, "message": f"Unsupported command: {command_type}"}


def handle_tcp_client(client_socket, address):
    with client_socket:
        buffer = b""
        while True:
            chunk = client_socket.recv(4096)
            if not chunk:
                break
            buffer += chunk

            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue

                try:
                    command = json.loads(line.decode("utf-8"))
                    response = handle_tcp_command(command)
                except Exception as error:
                    response = {"success": False, "message": str(error)}

                client_socket.sendall(json_response(**response).encode("utf-8"))


def start_tcp_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", TCP_PORT))
    server.listen(20)
    print(f"WMS TCP server listening on port {TCP_PORT}")

    while True:
        client_socket, address = server.accept()
        thread = threading.Thread(
            target=handle_tcp_client,
            args=(client_socket, address),
            daemon=True,
        )
        thread.start()


def publish_wms_event(package_payload):
    params = pika.URLParameters(RABBITMQ_URL)
    connection = pika.BlockingConnection(params)
    channel = connection.channel()
    channel.exchange_declare(exchange=WMS_EXCHANGE, exchange_type="fanout", durable=True)
    channel.basic_publish(
        exchange=WMS_EXCHANGE,
        routing_key="",
        body=json.dumps(
            {
                "event_type": "WMS_PROCESSING_COMPLETE",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": package_payload,
            }
        ),
        properties=pika.BasicProperties(
            content_type="application/json",
            delivery_mode=2,
        ),
    )
    connection.close()


def consume_order_events():
    while True:
        try:
            params = pika.URLParameters(RABBITMQ_URL)
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(
                exchange=ORDER_EXCHANGE,
                exchange_type="fanout",
                durable=True,
            )
            channel.queue_declare(queue=ORDER_QUEUE, durable=True)
            channel.queue_bind(
                exchange=ORDER_EXCHANGE,
                queue=ORDER_QUEUE,
                routing_key="",
            )
            channel.basic_qos(prefetch_count=1)

            def callback(ch, method, properties, body):
                try:
                    event = json.loads(body.decode("utf-8"))
                    if event.get("event_type") == "ORDER_CREATED":
                        package_payload = register_package(
                            event.get("data", {}).get("order_code")
                        )
                        if package_payload.get("success"):
                            publish_wms_event(package_payload)
                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except Exception as error:
                    print(f"WMS failed to process order event: {error}")
                    ch.basic_nack(
                        delivery_tag=method.delivery_tag,
                        requeue=False,
                    )

            channel.basic_consume(queue=ORDER_QUEUE, on_message_callback=callback)
            print("WMS connected to RabbitMQ")
            channel.start_consuming()
        except Exception as error:
            print(f"WMS RabbitMQ connection failed: {error}")
            time.sleep(5)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "wms-service"})


@app.route("/api/packages/order/<order_code>", methods=["GET"])
def package_by_order(order_code):
    package = get_package(order_code=order_code)
    status = 200 if package.get("success") else 404
    return jsonify(package), status


@app.route("/api/packages", methods=["POST"])
def create_package():
    payload = request.get_json(silent=True) or {}
    package = register_package(payload.get("order_code"))
    status = 201 if package.get("success") else 400
    return jsonify(package), status


@app.route("/api/packages/<package_id>/status", methods=["PUT"])
def package_status_by_id(package_id):
    payload = request.get_json(silent=True) or {}
    package = update_package_status_by_id(package_id, payload.get("status"))
    status = 200 if package.get("success") else 400
    return jsonify(package), status


@app.route("/api/warehouse/locations", methods=["GET"])
def warehouse_locations():
    locations = [
        {
            "warehouse_zone": f"Zone {zone}",
            "bin_location": f"{zone}{rack}-{shelf}",
            "available": True,
        }
        for zone in ["A", "B", "C", "D"]
        for rack in range(1, 6)
        for shelf in range(1, 4)
    ]
    return jsonify({"success": True, "locations": locations})


if __name__ == "__main__":
    threading.Thread(target=start_tcp_server, daemon=True).start()
    threading.Thread(target=consume_order_events, daemon=True).start()
    app.run(host="0.0.0.0", port=HTTP_PORT)
