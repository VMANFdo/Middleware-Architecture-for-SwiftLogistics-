#!/usr/bin/env python3
"""End-to-end smoke test for a running SwiftTrack stack.

Exercises the real containers over the real wire — HTTP, SOAP, raw TCP and
WebSocket — with no test doubles.  Every check maps to one hop of a single
order's journey:

    client -> api-gateway -> CMS (SOAP) -> RabbitMQ -> WMS
                                   \\-> ROS (REST)
                                   \\-> WebSocket (push)

Usage:
    python scripts/smoke.py                    # whole suite
    python scripts/smoke.py --only delivery    # substring filter on check names
    python scripts/smoke.py --list             # print step names and exit

Exit code 0 only when every executed check passed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

GATEWAY = os.environ.get("GATEWAY_URL", "http://localhost:3000").rstrip("/")
CMS = os.environ.get("CMS_URL", "http://localhost:8001").rstrip("/")
ROS = os.environ.get("ROS_URL", "http://localhost:8002").rstrip("/")
WMS = os.environ.get("WMS_URL", "http://localhost:8003").rstrip("/")
WMS_TCP_HOST = os.environ.get("WMS_TCP_HOST", "127.0.0.1")
WMS_TCP_PORT = int(os.environ.get("WMS_TCP_PORT", "9000"))

CLIENT_EMAIL = os.environ.get("SMOKE_CLIENT_EMAIL", "techmart@example.com")
CLIENT_PASSWORD = os.environ.get("SMOKE_CLIENT_PASSWORD", "password123")
DRIVER_EMAIL = os.environ.get("SMOKE_DRIVER_EMAIL", "kasun@swiftlogistics.lk")
DRIVER_PASSWORD = os.environ.get("SMOKE_DRIVER_PASSWORD", "password123")

TIMEOUT = 8.0


# ─────────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────────
def http(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: Any = None,
    timeout: float = TIMEOUT,
) -> tuple[int, Any]:
    """Return ``(status, decoded_body)``; never raises on HTTP/network errors."""
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, _decode(response.read())
    except urllib.error.HTTPError as error:
        return error.code, _decode(error.read())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return 0, {"error": str(error)}


def _decode(raw: bytes) -> Any:
    text = raw.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def wait_for(predicate, attempts: int = 30, delay: float = 0.5):
    """Poll ``predicate`` until it returns a truthy value or time runs out."""
    for _ in range(attempts):
        value = predicate()
        if value:
            return value
        time.sleep(delay)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Raw WebSocket client (RFC 6455 subset, no third-party dependency)
# ─────────────────────────────────────────────────────────────────────────────
def websocket_connect(path: str = "/ws", timeout: float = TIMEOUT):
    """Open a WebSocket over the gateway's HTTP port and return the socket."""
    from urllib.parse import urlparse

    parsed = urlparse(GATEWAY)
    host, port = parsed.hostname or "localhost", parsed.port or 80
    key = base64.b64encode(uuid.uuid4().bytes).decode()

    sock = socket.create_connection((host, port), timeout=timeout)
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode())

    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
    head, _, rest = response.partition(b"\r\n\r\n")
    if b" 101 " not in head.split(b"\r\n", 1)[0]:
        sock.close()
        raise OSError(f"websocket handshake rejected: {head[:120]!r}")
    return sock, rest


def ws_send(sock, payload: dict) -> None:
    """Send a masked text frame.  RFC 6455 requires clients to mask; the key
    must be exactly 4 bytes, not a whole UUID."""
    body = json.dumps(payload).encode()
    mask = uuid.uuid4().bytes[:4]
    header = bytearray([0x81])  # FIN + text frame
    length = len(body)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header += struct.pack("!H", length)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", length)
    header += mask
    header += bytes(byte ^ mask[i % 4] for i, byte in enumerate(body))
    sock.sendall(bytes(header))


def _recv_exact(sock, need: int) -> bytes:
    """Read ``need`` bytes, or raise if the peer closed or went quiet."""
    if need <= 0:
        return b""
    got = b""
    while len(got) < need:
        chunk = sock.recv(need - len(got))
        if not chunk:
            raise OSError("websocket peer closed the connection")
        got += chunk
    return got


def _ws_read_frame(buffer: bytes, sock) -> tuple[dict | None, bytes]:
    """Pull one complete frame off the wire.

    Returns ``(message, remainder)`` for a JSON text frame and
    ``(None, remainder)`` for a close frame or a dead/quiet peer.  Every
    iteration either consumes bytes from ``buffer`` or raises, so the loop
    cannot spin forever.
    """
    while True:
        try:
            if len(buffer) < 2:
                buffer += _recv_exact(sock, 2 - len(buffer))
            opcode = buffer[0] & 0x0F
            length = buffer[1] & 0x7F
            offset = 2
            if length == 126:
                if len(buffer) < 4:
                    buffer += _recv_exact(sock, 4 - len(buffer))
                length = struct.unpack("!H", buffer[2:4])[0]
                offset = 4
            elif length == 127:
                if len(buffer) < 10:
                    buffer += _recv_exact(sock, 10 - len(buffer))
                length = struct.unpack("!Q", buffer[2:10])[0]
                offset = 10
            if len(buffer) < offset + length:
                buffer += _recv_exact(sock, offset + length - len(buffer))
        except (OSError, TimeoutError):
            return None, b""

        payload = buffer[offset : offset + length]
        buffer = buffer[offset + length :]

        if opcode == 0x9:  # ping -> reply pong (servers require us to mask too)
            if len(payload) < 126:
                mask = uuid.uuid4().bytes[:4]
                masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + masked)
            continue
        if opcode == 0x8:  # close
            return None, buffer
        if opcode == 0x1:
            try:
                return json.loads(payload.decode()), buffer
            except json.JSONDecodeError:
                continue


# ─────────────────────────────────────────────────────────────────────────────
# Runner
# ─────────────────────────────────────────────────────────────────────────────
class Runner:
    def __init__(self, only: str | None = None):
        self.only = only
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.skipped: list[str] = []

    def check(self, name: str, ok: bool, detail: Any = "") -> bool:
        if self.only and self.only not in name:
            return ok
        if ok:
            self.passed.append(name)
            print(f"[PASS] {name}")
        else:
            self.failed.append(name)
            print(f"[FAIL] {name}" + (f"  --  {detail}" if detail else ""))
        return ok

    def skip(self, name: str, reason: str) -> None:
        if self.only and self.only not in name:
            return
        self.skipped.append(name)
        print(f"[SKIP] {name}  --  {reason}")

    @property
    def ok(self) -> bool:
        return not self.failed


def _json(payload: Any) -> dict:
    return payload if isinstance(payload, dict) else {}


# ─────────────────────────────────────────────────────────────────────────────
# Steps
# ─────────────────────────────────────────────────────────────────────────────
def check_infrastructure(runner: Runner) -> None:
    status, body = http("GET", f"{GATEWAY}/health")
    body = _json(body)
    runner.check(
        "infra.gateway.health",
        status == 200 and body.get("status") == "ok",
        f"status={status} body={body}",
    )
    runner.check(
        "infra.gateway.postgres",
        body.get("database") == "connected",
        f"database={body.get('database')!r}",
    )
    runner.check(
        "infra.gateway.rabbitmq",
        body.get("rabbitmq") == "connected",
        f"rabbitmq={body.get('rabbitmq')!r}",
    )

    for label, base in (("cms", CMS), ("ros", ROS), ("wms", WMS)):
        status, body = http("GET", f"{base}/health")
        body = _json(body)
        runner.check(
            f"infra.{label}.health",
            status == 200 and body.get("status") == "ok",
            f"status={status} body={body}",
        )


def check_auth(runner: Runner) -> tuple[str | None, str | None]:
    status, body = http(
        "POST",
        f"{GATEWAY}/api/auth/client/login",
        body={"email": CLIENT_EMAIL, "password": CLIENT_PASSWORD},
    )
    body = _json(body)
    client_token = body.get("token")
    if not runner.check(
        "auth.client.login",
        status == 200 and bool(client_token) and body.get("success") is True,
        f"status={status} body={body}",
    ):
        client_token = None

    status, body = http("POST", f"{GATEWAY}/api/auth/client/login", body={})
    runner.check(
        "auth.client.login.missing_credentials_is_400",
        status == 400,
        f"status={status} body={body}",
    )

    status, body = http(
        "POST",
        f"{GATEWAY}/api/auth/client/login",
        body={"email": CLIENT_EMAIL, "password": "not-the-password"},
    )
    runner.check(
        "auth.client.login.bad_password_is_401",
        status == 401,
        f"status={status} body={body}",
    )

    status, body = http("GET", f"{GATEWAY}/api/auth/me", token=client_token)
    body = _json(body)
    runner.check(
        "auth.me.echoes_client_identity",
        status == 200 and body.get("user", {}).get("role") == "client",
        f"status={status} body={body}",
    )

    status, body = http("GET", f"{GATEWAY}/api/auth/me")
    runner.check(
        "auth.me.rejects_anonymous",
        status == 401,
        f"status={status} body={body}",
    )

    status, body = http(
        "POST",
        f"{GATEWAY}/api/auth/driver/login",
        body={"email": DRIVER_EMAIL, "password": DRIVER_PASSWORD},
    )
    body = _json(body)
    driver_token = body.get("token")
    if not runner.check(
        "auth.driver.login",
        status == 200 and bool(driver_token),
        f"status={status} body={body}",
    ):
        driver_token = None

    status, body = http("GET", f"{GATEWAY}/api/orders", token=driver_token)
    runner.check(
        "auth.rbac.driver_cannot_use_client_route",
        status == 403,
        f"status={status} body={body}",
    )

    status, body = http("GET", f"{GATEWAY}/api/driver/route/today", token=client_token)
    runner.check(
        "auth.rbac.client_cannot_use_driver_route",
        status == 403,
        f"status={status} body={body}",
    )

    return client_token, driver_token


def check_order_lifecycle(runner: Runner, client_token: str | None) -> dict:
    ctx: dict = {}
    if not client_token:
        runner.skip("orders.*", "client login failed")
        return ctx

    status, body = http(
        "POST",
        f"{GATEWAY}/api/orders",
        token=client_token,
        body={
            "pickup_address": "45 Galle Road, Colombo 03",
            "delivery_address": "Kandy Central, Kandy",
            "weight_kg": 3.5,
        },
    )
    body = _json(body)
    order_code = body.get("order_code")
    if not runner.check(
        "orders.create.returns_201",
        status == 201 and bool(order_code) and body.get("success") is True,
        f"status={status} body={body}",
    ):
        return ctx
    ctx["order_code"] = order_code
    print(f"       created {order_code}")

    status, body = http("GET", f"{GATEWAY}/api/orders", token=client_token)
    body = _json(body)
    codes = [o.get("order_code") for o in body.get("orders", [])]
    runner.check(
        "orders.list.contains_new_order",
        status == 200 and order_code in codes,
        f"status={status} codes={codes}",
    )

    status, body = http("GET", f"{GATEWAY}/api/orders/{order_code}", token=client_token)
    body = _json(body)
    runner.check(
        "orders.detail.hydrates_package_and_route",
        status == 200 and body.get("order", {}).get("order_code") == order_code,
        f"status={status} keys={sorted(body)}",
    )

    status, body = http("GET", f"{CMS}/api/orders/status/{order_code}")
    body = _json(body)
    runner.check(
        "orders.cms_status_is_readable",
        status == 200 and body.get("order_code") == order_code,
        f"status={status} body={body}",
    )

    status, body = http("GET", f"{CMS}/api/orders/status/ORD-NOPE")
    runner.check(
        "orders.cms_status_404_for_unknown",
        status == 404,
        f"status={status} body={body}",
    )

    status, body = http("GET", f"{GATEWAY}/api/saga/transactions", token=client_token)
    runner.check(
        "orders.saga_endpoint_is_reachable",
        status == 200,
        f"status={status} body={body}",
    )

    return ctx


def check_order_propagation(runner: Runner, ctx: dict) -> None:
    """CMS publishes ORDER_CREATED -> RabbitMQ -> WMS registers the package."""
    order_code = ctx.get("order_code")
    if not order_code:
        runner.skip("propagate.*", "no order was created")
        return

    def package_ready():
        status, body = http("GET", f"{WMS}/api/packages/order/{order_code}")
        return body if status == 200 and _json(body).get("success") else None

    body = wait_for(package_ready, attempts=40, delay=0.5)
    runner.check(
        "propagate.wms.registered_package_from_bus",
        body is not None and body.get("order_code") == order_code,
        f"body={body}",
    )
    if not body:
        return

    ctx["barcode"] = body.get("barcode")
    runner.check(
        "propagate.wms.assigned_a_bin",
        bool(body.get("bin_location")) and bool(body.get("warehouse_zone")),
        f"body={body}",
    )

    status, gateway_body = http(
        "GET", f"{GATEWAY}/api/packages/order/{order_code}", token=None
    )
    # 401/403 are equally valid proof that the route is wired to auth.
    runner.check(
        "propagate.gateway.package_route_requires_auth",
        status in (401, 403),
        f"status={status} body={gateway_body}",
    )


def check_saga(runner: Runner, client_token: str | None, ctx: dict) -> None:
    """The coordinator must walk CMS_CREATE -> ROS_ASSIGN -> WMS_ALLOCATE -> done."""
    order_code = ctx.get("order_code")
    if not client_token or not order_code:
        runner.skip("saga.*", "no order was created")
        return

    def settled():
        _, body = http(
            "GET",
            f"{GATEWAY}/api/saga/transactions/{order_code}",
            token=client_token,
        )
        body = _json(body)
        history = body.get("history") or []
        if not history:
            return None
        steps = {row.get("saga_step") for row in history}
        statuses = {row.get("status") for row in history}
        if "SAGA_COMPLETE" in steps or "SAGA_TRANSACTION_SUCCESS" in steps:
            return history
        if "failed" in statuses or "rolled_back" in statuses:
            return history
        return None

    history = wait_for(settled, attempts=60, delay=0.5)
    if not runner.check(
        "saga.reaches_completion",
        history is not None,
        f"no terminal saga step for {order_code}",
    ):
        return

    steps = [row.get("saga_step") for row in history]
    runner.check(
        "saga.logged_every_required_step",
        {"CMS_CREATE", "ROS_ASSIGN", "WMS_ALLOCATE"} <= set(steps),
        f"steps={steps}",
    )
    runner.check(
        "saga.no_step_failed",
        not {"failed", "rolled_back"} & {row.get("status") for row in history},
        f"rows={history}",
    )

    _, body = http("GET", f"{GATEWAY}/api/saga/transactions", token=client_token)
    runner.check(
        "saga.history_is_queryable_across_orders",
        _json(body).get("success") is True and _json(body).get("count", 0) > 0,
        f"body={body}",
    )


def check_delivery(
    runner: Runner, driver_token: str | None, client_token: str | None, ctx: dict
) -> None:
    """Scan the barcode, submit proof of delivery, then re-read every status."""
    order_code = ctx.get("order_code")
    barcode = ctx.get("barcode")
    if not driver_token or not client_token or not order_code or not barcode:
        runner.skip("delivery.*", "driver token, order or barcode unavailable")
        return

    status, body = http(
        "GET", f"{GATEWAY}/api/packages/scan/{barcode}", token=driver_token
    )
    body = _json(body)
    runner.check(
        "delivery.barcode_scan_returns_the_package",
        status == 200 and body.get("barcode") == barcode,
        f"status={status} body={body}",
    )

    status, body = http(
        "POST",
        f"{GATEWAY}/api/driver/delivery/{order_code}",
        token=driver_token,
        body={
            "status": "delivered",
            "recipient_name": "Smoke Tester",
            "signature": "data:image/png;base64,c21va2UtdGVzdA==",
            "notes": "submitted by scripts/smoke.py",
        },
    )
    body = _json(body)
    if not runner.check(
        "delivery.pod_is_accepted",
        status == 200 and body.get("success") is True,
        f"status={status} body={body}",
    ):
        return

    status, body = http(
        "GET", f"{GATEWAY}/api/orders/{order_code}", token=client_token
    )
    body = _json(body)
    runner.check(
        "delivery.order_status_is_delivered",
        status == 200 and body.get("order", {}).get("status") == "delivered",
        f"status={status} status={body.get('order', {}).get('status')!r}",
    )

    status, body = http("GET", f"{GATEWAY}/api/driver/route/today", token=driver_token)
    body = _json(body)
    stop = next(
        (s for s in body.get("stops", []) if s.get("order_code") == order_code), None
    )
    runner.check(
        "delivery.route_stop_is_completed",
        stop is not None and stop.get("status") == "completed",
        f"stop={stop}",
    )

    status, body = http("GET", f"{CMS}/api/orders/status/{order_code}")
    body = _json(body)
    runner.check(
        "delivery.cms_status_matches",
        status == 200 and body.get("status") == "delivered",
        f"status={status} body={body}",
    )


def check_driver_flow(runner: Runner, driver_token: str | None) -> None:
    if not driver_token:
        runner.skip("driver.*", "driver login failed")
        return

    status, body = http("GET", f"{GATEWAY}/api/driver/route/today", token=driver_token)
    body = _json(body)
    runner.check(
        "driver.route_today_returns_stops",
        status == 200 and "stops" in body and "route_id" in body,
        f"status={status} keys={sorted(body)}",
    )

    status, ros_body = http("GET", f"{ROS}/api/vehicles/available")
    runner.check(
        "driver.ros_vehicles_available",
        status == 200 and isinstance(ros_body, (list, dict)),
        f"status={status} body={ros_body}",
    )

    status, ros_body = http(
        "POST",
        f"{ROS}/api/routes/optimize",
        body={
            "driver_code": "DRV001",
            "stops": [
                {
                    "order_code": "ORD-SMOKE-A",
                    "delivery_address": "10 Havelock Road, Colombo 05",
                    "delivery_lat": 6.8916,
                    "delivery_lng": 79.8567,
                    "weight_kg": 2,
                },
                {
                    "order_code": "ORD-SMOKE-B",
                    "delivery_address": "Kandy Central, Kandy",
                    "delivery_lat": 7.2906,
                    "delivery_lng": 80.6337,
                    "weight_kg": 4,
                },
            ],
        },
    )
    ros_body = _json(ros_body)
    optimised = ros_body.get("stops", [])
    runner.check(
        "driver.ros_optimise_returns_ordered_stops",
        status == 200 and len(optimised) == 2,
        f"status={status} body={ros_body}",
    )
    runner.check(
        "driver.ros_optimise_is_deterministic",
        bool(optimised)
        and [s["order_code"] for s in optimised] == ["ORD-SMOKE-A", "ORD-SMOKE-B"],
        f"stops={[s.get('order_code') for s in optimised]}",
    )

    status, ros_body = http("GET", f"{ROS}/api/routes")
    runner.check(
        "driver.ros_lists_routes",
        status == 200,
        f"status={status}",
    )


def check_wms(runner: Runner) -> None:
    status, body = http("GET", f"{WMS}/api/warehouse/locations")
    body = _json(body)
    runner.check(
        "wms.locations_cover_the_whole_grid",
        status == 200 and len(body.get("locations", [])) == 60,
        f"status={status} count={len(body.get('locations', []))}",
    )

    status, body = http(
        "POST", f"{WMS}/api/packages", body={"order_code": "ORD-NOPE"}
    )
    runner.check(
        "wms.register_rejects_unknown_order",
        status == 400,
        f"status={status} body={body}",
    )

    # Proprietary TCP protocol, not HTTP.
    try:
        with socket.create_connection((WMS_TCP_HOST, WMS_TCP_PORT), timeout=TIMEOUT) as sock:
            sock.sendall(b'{"type": "PING"}\n')
            raw = b""
            deadline = time.time() + TIMEOUT
            while b"\n" not in raw and time.time() < deadline:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                raw += chunk
        payload = json.loads(raw.decode() or "{}")
        runner.check(
            "wms.tcp_ping_answers_pong",
            payload.get("message") == "PONG",
            f"raw={raw!r}",
        )
    except (OSError, json.JSONDecodeError) as error:
        runner.check("wms.tcp_ping_answers_pong", False, str(error))


def check_soap(runner: Runner) -> None:
    status, body = http("GET", f"{CMS}/soap/?wsdl", timeout=TIMEOUT)
    text = body if isinstance(body, str) else json.dumps(body)
    runner.check(
        "soap.wsdl_is_published",
        status == 200 and "definitions" in text,
        f"status={status} head={text[:120]!r}",
    )

    envelope = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"'
        b' xmlns:cms="swifttrack.cms">'
        b"<soap:Body><cms:ping/></soap:Body></soap:Envelope>"
    )
    request = urllib.request.Request(
        f"{CMS}/soap",
        data=envelope,
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": '""'},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            payload = response.read().decode()
        status = 200
    except urllib.error.HTTPError as error:
        payload = error.read().decode()
        status = error.code
    except (urllib.error.URLError, OSError) as error:
        payload, status = str(error), 0

    runner.check(
        "soap.ping_round_trip",
        status == 200 and "CMS SOAP service is running" in payload,
        f"status={status} body={payload[:200]!r}",
    )


def check_websocket(runner: Runner, client_token: str | None) -> None:
    del client_token  # registration frames are currently unauthenticated (Phase 4)
    try:
        sock, buffer = websocket_connect()
    except (OSError, TimeoutError) as error:
        runner.check("websocket.handshake", False, str(error))
        return

    try:
        hello, buffer = _ws_read_frame(buffer, sock)
        runner.check(
            "websocket.handshake",
            True,
        )
        runner.check(
            "websocket.greets_on_connect",
            isinstance(hello, dict) and hello.get("type") == "connected",
            f"frame={hello}",
        )

        ws_send(sock, {"type": "ping"})
        pong, _ = _ws_read_frame(buffer, sock)
        runner.check(
            "websocket.ping_pong",
            isinstance(pong, dict) and pong.get("type") == "pong",
            f"frame={pong}",
        )

        ws_send(sock, {"type": "register_client", "client_code": "CLT001"})
        registered, _ = _ws_read_frame(b"", sock)
        runner.check(
            "websocket.client_registration_acknowledged",
            isinstance(registered, dict)
            and registered.get("type") == "registered"
            and registered.get("role") == "client",
            f"frame={registered}",
        )
    finally:
        sock.close()


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
STEPS = (
    "infrastructure",
    "auth",
    "order_lifecycle",
    "order_propagation",
    "saga",
    "delivery",
    "driver_flow",
    "wms",
    "soap",
    "websocket",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="run only steps whose name contains this")
    parser.add_argument("--list", action="store_true", help="list step names and exit")
    args = parser.parse_args()

    if args.list:
        print("\n".join(STEPS))
        return 0

    # Stream progress immediately — a hang should be diagnosable line by line.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    print(f"Smoke testing SwiftTrack at {GATEWAY}")
    print("-" * 72)

    runner = Runner(only=args.only)
    started = time.time()

    def wants(step: str) -> bool:
        return not args.only or args.only in step

    # Infrastructure and auth are read-only, so they always run — the Runner's
    # `--only` filter decides which of their checks get reported.  This keeps a
    # filtered run from dying on a missing token while still letting you scope
    # the output.
    check_infrastructure(runner)
    client_token, driver_token = check_auth(runner)

    # Creating an order mutates the database, so it only runs when a later
    # step actually needs one.  `needs_*` decides execution; the Runner's
    # `--only` filter decides what gets reported.
    needs_order = any(wants(s) for s in ("order_lifecycle", "order_propagation", "saga", "delivery"))
    needs_propagation = any(wants(s) for s in ("order_propagation", "saga", "delivery"))
    needs_saga = wants("saga") or wants("delivery")

    ctx: dict = {}
    if needs_order:
        ctx = check_order_lifecycle(runner, client_token)
    if needs_propagation:
        check_order_propagation(runner, ctx)
    if needs_saga:
        check_saga(runner, client_token, ctx)
    if wants("delivery"):
        check_delivery(runner, driver_token, client_token, ctx)
    if wants("driver_flow"):
        check_driver_flow(runner, driver_token)
    if wants("wms"):
        check_wms(runner)
    if wants("soap"):
        check_soap(runner)
    if wants("websocket"):
        check_websocket(runner, client_token)

    print("-" * 72)
    print(
        f"{len(runner.passed)} passed, {len(runner.failed)} failed, "
        f"{len(runner.skipped)} skipped in {time.time() - started:.1f}s"
    )
    if runner.failed:
        for name in runner.failed:
            print(f"  FAILED: {name}")
    return 1 if runner.failed else 0


if __name__ == "__main__":
    sys.exit(main())
