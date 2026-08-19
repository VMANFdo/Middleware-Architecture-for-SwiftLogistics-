# SwiftTrack — Architecture & Integration Patterns

This document explains the technical architecture of the SwiftTrack middleware platform: the integration patterns applied, how data flows end-to-end, and the design decisions behind each service.

---

## Business Context

SwiftLogistics operates three heterogeneous backend systems that cannot communicate directly:

| System | Protocol | Role |
|---|---|---|
| **CMS** — Client Management System | SOAP / XML | On-prem legacy system: client contracts, authentication, order intake |
| **ROS** — Route Optimisation System | REST / JSON | Third-party cloud service: nearest-neighbour route planning |
| **WMS** — Warehouse Management System | Proprietary TCP/IP | Tracks packages from warehouse receipt to dispatch |

SwiftTrack sits in front of all three and exposes a single, uniform REST + WebSocket API to the web portals.

---

## Integration Patterns

### 1. Gateway Pattern

The **API Gateway** (`api-gateway/`) is the single entry point for all client and driver requests. It:

- Authenticates every request with JWT (`HS256`, issued by the gateway itself)
- Routes to the appropriate backend service
- Translates between protocols (see Channel Adapter below)
- Enforces role-based access control (`client` vs `driver`)
- Owns WebSocket connection management for real-time push

This means neither frontend ever needs to know that CMS speaks SOAP or that WMS uses a proprietary TCP wire format.

### 2. Channel Adapter Pattern

Two adapters live inside the gateway, converting the portals' REST/JSON calls into the downstream protocol each service expects.

#### REST → SOAP/XML (CMS Adapter)

```
Client Portal ──REST/JSON──▶ Gateway ──SOAP/XML──▶ CMS Service
                            (buildSoapEnvelope)   (Flask + Spyne)
                            (parseStringPromise)
```

- `buildSoapEnvelope()` constructs a valid SOAP 1.1 envelope from a plain JS object
- `callCmsSoap()` posts the envelope, parses the XML response with `xml2js`, and extracts the JSON payload that Spyne serialises inside the `*Result` element
- The portal never sees XML

#### REST → TCP (WMS Adapter)

```
Driver App ──REST/JSON──▶ Gateway ──newline-delimited JSON──▶ WMS Service
                          (sendWmsTcpCommand)                 (raw Python socket)
```

- `sendWmsTcpCommand()` opens a fresh TCP connection to port 9000, writes a newline-terminated JSON command, reads until `\n`, parses the response, and closes the socket
- The WMS TCP protocol supports `PING`, `REGISTER_PACKAGE`, `GET_PACKAGE`, and `UPDATE_STATUS` commands

### 3. Publish-Subscribe Pattern

Every time a new order is created, an event is published to RabbitMQ. The three backend services consume from the same fanout exchange independently:

```
CMS publishes ──▶ order_events (fanout)
                    ├──▶ ROS (queue: ros_order_events)  → optimises route, publishes to route_events
                    └──▶ WMS (queue: wms_order_events)  → registers package, publishes to wms_events

API Gateway subscribes to all three exchanges (gateway_event_queue):
  order_events + route_events + wms_events → Saga coordinator
```

All exchanges are declared `durable: true` and messages use `delivery_mode: 2` (persistent), so no events are lost during service restarts.

### 4. Saga Pattern (Distributed Transaction Coordinator)

Creating an order involves three separate services. SwiftTrack uses a **choreography-based Saga** to track the distributed transaction and compensate on failure.

```
┌─────────────────────────────────────────────────────────────────┐
│  Saga State Machine (in-memory Map, backed by transaction_logs) │
│                                                                 │
│  Step         Service    Event Published                        │
│  ──────────── ──────── ─ ──────────────────────────────────     │
│  CMS_CREATE   CMS        ORDER_CREATED                         │
│  ROS_ASSIGN   ROS        ROS_PROCESSING_COMPLETE               │
│  WMS_ALLOCATE WMS        WMS_PROCESSING_COMPLETE               │
│                                                                 │
│  All three steps completed → SAGA_TRANSACTION_SUCCESS           │
│  Any step fails           → SAGA_COMPENSATION (rollback)        │
└─────────────────────────────────────────────────────────────────┘
```

Each Saga step is persisted to the `transaction_logs` table so the state survives a gateway restart. The compensation path marks the order as `failed` in PostgreSQL and dispatches a `SAGA_COMPENSATED` WebSocket event to the affected client.

### 5. Canonical Data Model

All services exchange data in a common JSON schema regardless of their native protocol. The gateway normalises incoming SOAP responses and outgoing TCP commands into this shared shape:

```json
{
  "order_code": "ORD-0001",
  "client_code": "CLT001",
  "pickup_address": "...",
  "delivery_address": "...",
  "pickup_lat": 6.9271,
  "pickup_lng": 79.8612,
  "delivery_lat": 6.8916,
  "delivery_lng": 79.8567,
  "weight_kg": 2.4,
  "status": "pending"
}
```

---

## End-to-End Data Flow: Order Creation

```
1. Client Portal  POST /api/orders  ──────────────────────────────────────────────────▶ API Gateway
2. API Gateway    SOAP: create_order ───────────────────────────────────────────────▶ CMS Service
3. CMS Service    INSERT INTO orders  ─────────────────────────────────────────────▶ PostgreSQL
4. CMS Service    Publish ORDER_CREATED ───────────────────────────────────────────▶ RabbitMQ (order_events)
5. ROS Service    Consumes ORDER_CREATED → optimises route → Publish ROS_PROCESSING_COMPLETE ▶ RabbitMQ (route_events)
6. WMS Service    Consumes ORDER_CREATED → registers package → Publish WMS_PROCESSING_COMPLETE ▶ RabbitMQ (wms_events)
7. API Gateway    Consumes all three events → logs Saga steps → dispatches WebSocket events
8. Client Portal  Receives ORDER_CREATED / ROS_PROCESSING_COMPLETE / SAGA_TRANSACTION_SUCCESS via WebSocket
9. Driver Portal  Receives NEW_ORDER_AVAILABLE / ROUTE_UPDATED via WebSocket
```

---

## Service Design Notes

### CMS Service (`cms-service/`)

- Built with **Flask** (REST) and **Spyne** (SOAP 1.1)
- `DispatcherMiddleware` mounts the SOAP WSGI app at `/soap` and the Flask REST app at `/`
- Passwords hashed with **bcrypt** (cost factor 10)
- Coordinate estimation (`estimate_coordinates`) provides latitude/longitude from free-text addresses for demo purposes

### ROS Service (`ros-service/`)

- Implements a **nearest-neighbour greedy algorithm** using the Haversine formula for distance
- Maintains in-memory route state (per-driver, per-day) and mirrors it to PostgreSQL on every update
- On startup, restores today's routes from the DB so in-memory state survives container restarts

### WMS Service (`wms-service/`)

- Runs two servers in the same process: Flask REST (port 8003) and a raw TCP server (port 9000)
- TCP server uses a newline-delimited JSON protocol with one connection per request (stateless)
- Deterministic bin location assignment from order code hash ensures repeatable demo results

### API Gateway (`api-gateway/`)

- Single `http.Server` shared between Express (REST) and `ws.Server` (WebSocket on `/ws`)
- WebSocket connections are stored in two `Map<id, Set<socket>>` structures (`clientSockets`, `driverSockets`) for targeted dispatch
- Heartbeat interval (30 s ping/pong) detects and removes stale connections

### Client Portal (`client-portal/`)

- Single-page Vanilla JS application served by Nginx
- Subscribes to the gateway WebSocket on login for live order status updates

### Driver Portal (`driver-app/`)

- Mobile-first PWA with a bottom navigation bar
- **Service Worker** (`sw.js`) enables offline access to previously loaded routes
- **Web App Manifest** (`manifest.json`) enables "Add to Home Screen" on mobile browsers
- Uses the browser Web Notifications API to alert drivers of route changes via WebSocket events

---

## Database Schema

```
clients ──┐
          │ 1:N
          ▼
        orders ──────────── route_stops ──── routes ──── drivers
          │                                               │
          │ 1:1                                           │
          ▼                                               │
        packages                                          │
          │                                               │
          │ M:1                                           │
          ▼                                               │
     delivery_proofs ◄─────────────────────────────── drivers
          │
     transaction_logs (Saga audit log, FK → orders)
```

See [`database/init.sql`](./database/init.sql) for the full DDL, indexes, and seed data.
