---
name: swifttrack-middleware
description: >
  AI Agent skill file for building the SwiftTrack middleware system from scratch.
  This file gives a complete-context snapshot of the project — architecture, 
  tech stack, API contracts, RabbitMQ schemas, TCP protocol, database schema, 
  and per-component implementation instructions.
  An AI agent MUST read this file fully before writing any code for this project.
---

# SwiftTrack AI Agent Skill File
## SCS3208 Middleware Architecture Assignment

---

## 1. Project Overview

**Client:** SwiftLogistics (Pvt) Ltd. — a Sri Lanka last-mile delivery company.

**Goal:** Build a middleware layer called **SwiftTrack** that integrates three siloed legacy systems into a unified prototype. The frontend consists of a **Client Web Portal** and a **Driver Mobile App**.

**This is a prototype, not production.** Keep implementations minimal but functional. The assignment explicitly says "minimal implementation that mocks" — do not over-engineer.

---

## 2. The Three Backend Systems to Mock

| System | Port | Protocol | Your Mock Technology |
|--------|------|----------|---------------------|
| **CMS** – Client Management System | 8001 | SOAP/XML + REST/JSON | Python + Flask + Spyne |
| **ROS** – Route Optimisation System | 8002 | REST/JSON | Node.js + Express |
| **WMS** – Warehouse Management System | 8003 (REST) + 9000 (TCP) | TCP/IP proprietary + REST | Python + Flask + raw sockets |

---

## 3. Full Architecture

```
                        ┌──────────────────┐
                        │   PostgreSQL DB  │
                        │     :5432        │
                        └────────┬─────────┘
                                 │
        ┌──────────┬─────────────┼─────────────┬──────────┐
        ↓          ↓             ↓             ↓          ↓
  ┌──────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │   CMS    │ │  ROS   │ │   WMS    │ │ RabbitMQ │ │  API     │
  │ :8001    │ │ :8002  │ │:8003+9000│ │  :5672   │ │ Gateway  │
  │SOAP+REST │ │  REST  │ │ TCP+REST │ │  :15672  │ │  :3000   │
  └──────────┘ └────────┘ └──────────┘ └──────────┘ └──────────┘
                                                           │
                              ┌────────────────────────────┤
                              ↓                            ↓
                     ┌────────────────┐         ┌──────────────────┐
                     │ Client Portal  │         │   Driver App     │
                     │  :8080 (Nginx) │         │  :8081 (Nginx)   │
                     └────────────────┘         └──────────────────┘
```

**Core Patterns Used:**
- **API Gateway Pattern** — Single entry point, JWT auth, routing
- **Adapter Pattern** — SOAP adapter (CMS), TCP adapter (WMS)
- **Publish-Subscribe** — RabbitMQ decouples CMS → ROS & WMS
- **Saga (Choreography)** — Transaction tracking across all 3 systems
- **Circuit Breaker (basic)** — try/catch with timeouts on backend calls

---

## 4. Database Schema (PostgreSQL)

File: `database/init.sql`

```sql
CREATE TABLE IF NOT EXISTS clients (
    client_id    VARCHAR(50) PRIMARY KEY,
    company_name VARCHAR(255) NOT NULL,
    email        VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    contract_type VARCHAR(50) DEFAULT 'standard',
    status       VARCHAR(20) DEFAULT 'active',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
    driver_id    VARCHAR(50) PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    email        VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    vehicle_type VARCHAR(50),
    vehicle_number VARCHAR(50),
    status       VARCHAR(20) DEFAULT 'available',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    order_id         VARCHAR(50) PRIMARY KEY,
    client_id        VARCHAR(50) REFERENCES clients(client_id),
    pickup_address   TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    pickup_lat       DECIMAL(10,8),
    pickup_lng       DECIMAL(11,8),
    delivery_lat     DECIMAL(10,8),
    delivery_lng     DECIMAL(11,8),
    package_weight   DECIMAL(10,2),
    priority         VARCHAR(20) DEFAULT 'normal',
    status           VARCHAR(50) DEFAULT 'pending',
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS packages (
    package_id         VARCHAR(50) PRIMARY KEY,
    order_id           VARCHAR(50) REFERENCES orders(order_id),
    barcode            VARCHAR(100),
    warehouse_location VARCHAR(50),
    status             VARCHAR(50) DEFAULT 'RECEIVED',
    received_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS routes (
    route_id   VARCHAR(50) PRIMARY KEY,
    driver_id  VARCHAR(50) REFERENCES drivers(driver_id),
    date       DATE NOT NULL,
    status     VARCHAR(20) DEFAULT 'planned',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS route_stops (
    id               SERIAL PRIMARY KEY,
    route_id         VARCHAR(50) REFERENCES routes(route_id),
    order_id         VARCHAR(50) REFERENCES orders(order_id),
    sequence_number  INTEGER NOT NULL,
    estimated_arrival TIMESTAMP,
    status           VARCHAR(20) DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS delivery_proofs (
    id             SERIAL PRIMARY KEY,
    order_id       VARCHAR(50) REFERENCES orders(order_id),
    recipient_name VARCHAR(255),
    signature_data TEXT,
    notes          TEXT,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transaction_logs (
    transaction_id VARCHAR(50) PRIMARY KEY,
    order_id       VARCHAR(50),
    cms_status     VARCHAR(20) DEFAULT 'pending',
    ros_status     VARCHAR(20) DEFAULT 'pending',
    wms_status     VARCHAR(20) DEFAULT 'pending',
    overall_status VARCHAR(20) DEFAULT 'pending',
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Seed Data (password = `password123`):**
```sql
INSERT INTO clients VALUES
  ('CLT001','TechMart Online','techmart@example.com','$2b$10$rO.X3Xt3KXSO6xF5QGSjK.VHZV3b7X2yVf6mG3q6v3FqYPvKX6.JS','premium','active',NOW()),
  ('CLT002','Fashion Hub','fashionhub@example.com','$2b$10$rO.X3Xt3KXSO6xF5QGSjK.VHZV3b7X2yVf6mG3q6v3FqYPvKX6.JS','standard','active',NOW()),
  ('CLT003','HomeGoods Lanka','homegoods@example.com','$2b$10$rO.X3Xt3KXSO6xF5QGSjK.VHZV3b7X2yVf6mG3q6v3FqYPvKX6.JS','enterprise','active',NOW())
ON CONFLICT DO NOTHING;

INSERT INTO drivers VALUES
  ('DRV001','Kasun Perera','kasun@swiftlogistics.lk','$2b$10$rO.X3Xt3KXSO6xF5QGSjK.VHZV3b7X2yVf6mG3q6v3FqYPvKX6.JS','Van','WP-KA-1234','available',NOW()),
  ('DRV002','Nimal Silva','nimal@swiftlogistics.lk','$2b$10$rO.X3Xt3KXSO6xF5QGSjK.VHZV3b7X2yVf6mG3q6v3FqYPvKX6.JS','Motorcycle','WP-NB-5678','available',NOW())
ON CONFLICT DO NOTHING;
```

---

## 5. RabbitMQ Event Contracts (LOCK THESE — DO NOT CHANGE)

All services publish/consume messages in this exact format.

### Queue Names
| Queue | Publisher | Consumers |
|-------|-----------|-----------|
| `order_events` | CMS Service | ROS Service, WMS Service, API Gateway |
| `wms_events` | WMS Service | API Gateway |
| `route_events` | ROS Service | API Gateway |

### Event: `ORDER_CREATED` (published by CMS, consumed by ROS & WMS)
```json
{
  "event_type": "ORDER_CREATED",
  "timestamp": "2026-07-31T06:30:00Z",
  "data": {
    "order_id": "ORD20260731ABCD",
    "transaction_id": "TXN9A8B7C6D",
    "client_id": "CLT001",
    "pickup_address": "123 Tech Street, Colombo",
    "delivery_address": "456 Style Avenue, Kandy",
    "pickup_lat": 6.9271,
    "pickup_lng": 79.8612,
    "delivery_lat": 7.2906,
    "delivery_lng": 80.6337,
    "weight": 2.5,
    "priority": "normal"
  }
}
```

### Event: `WMS_PROCESSING_COMPLETE` (published by WMS)
```json
{
  "event_type": "WMS_PROCESSING_COMPLETE",
  "timestamp": "2026-07-31T06:30:05Z",
  "data": {
    "order_id": "ORD20260731ABCD",
    "transaction_id": "TXN9A8B7C6D",
    "client_id": "CLT001",
    "package_id": "PKG-ABCD-1234",
    "barcode": "SL-ABCD-1234",
    "warehouse_location": "B3-2",
    "status": "RECEIVED"
  }
}
```

### Event: `ROS_PROCESSING_COMPLETE` (published by ROS)
```json
{
  "event_type": "ROS_PROCESSING_COMPLETE",
  "timestamp": "2026-07-31T06:30:06Z",
  "data": {
    "order_id": "ORD20260731ABCD",
    "transaction_id": "TXN9A8B7C6D",
    "driver_id": "DRV001",
    "route_id": "RTE-20260731-DRV001",
    "sequence_number": 3,
    "estimated_arrival": "2026-07-31T10:30:00Z"
  }
}
```

---

## 6. WMS TCP Socket Protocol (Port 9000)

All messages are **newline-delimited JSON** (`\n` terminated). The gateway opens a socket, sends one command, reads one response, then closes.

### Request: PING
```json
{"command": "PING"}\n
```
### Response:
```json
{"success": true, "message": "PONG"}\n
```

### Request: REGISTER_PACKAGE
```json
{"command": "REGISTER_PACKAGE", "order_id": "ORD123", "weight": 2.5}\n
```
### Response:
```json
{"success": true, "package_id": "PKG-ABCD-1234", "barcode": "SL-ABCD-1234", "location": "B3-2"}\n
```

### Request: SCAN_BARCODE
```json
{"command": "SCAN_BARCODE", "barcode": "SL-ABCD-1234"}\n
```
### Response:
```json
{"success": true, "package_id": "PKG-ABCD-1234", "order_id": "ORD123", "status": "READY", "location": "B3-2"}\n
```

### Request: UPDATE_STATUS
```json
{"command": "UPDATE_STATUS", "package_id": "PKG-ABCD-1234", "status": "LOADED"}\n
```
### Response:
```json
{"success": true, "package_id": "PKG-ABCD-1234", "status": "LOADED"}\n
```

---

## 7. API Gateway REST Contracts

**Base URL:** `http://localhost:3000`
**Auth:** `Authorization: Bearer <JWT>` header required on protected routes.

### Authentication
| Method | Endpoint | Auth | Body | Response |
|--------|----------|------|------|----------|
| POST | `/api/auth/client/login` | No | `{email, password}` | `{success, token, client:{id, company_name, email}}` |
| POST | `/api/auth/driver/login` | No | `{email, password}` | `{success, token, driver:{id, name, email, vehicle}}` |

### Orders (Client)
| Method | Endpoint | Auth | Body / Params | Response |
|--------|----------|------|---------------|----------|
| POST | `/api/orders` | Client JWT | `{pickup_address, delivery_address, pickup_lat, pickup_lng, delivery_lat, delivery_lng, weight, priority}` | `{success, order, transaction_id}` |
| GET | `/api/orders` | Client JWT | — | `{success, orders:[...]}` |
| GET | `/api/orders/:orderId` | Client JWT | — | `{success, order, package, route}` |
| PUT | `/api/orders/:orderId/status` | Client JWT | `{status}` | `{success}` |

### Driver
| Method | Endpoint | Auth | Response |
|--------|----------|------|----------|
| GET | `/api/driver/route/today` | Driver JWT | `{success, route:{route_id, stops:[{order_id, sequence, address, eta, status}]}}` |
| POST | `/api/driver/delivery/:orderId` | Driver JWT | Body: `{status, reason, recipient_name, signature}` → `{success}` |

### Public
| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/health` | `{status, services:{cms, ros, wms, rabbitmq}}` |
| GET | `/api/track/:orderId` | `{success, order_id, package, route}` |

---

## 8. WebSocket Protocol (API Gateway ↔ Frontends)

**Connection URL:** `ws://localhost:3000`

### Client → Server Messages (Registration)
```json
{ "type": "register_client", "client_id": "CLT001" }
{ "type": "register_driver", "driver_id": "DRV001" }
{ "type": "ping" }
```

### Server → Client Messages (Notifications)
```json
{ "type": "connected", "message": "Connected to SwiftLogistics real-time updates" }
{ "type": "registered", "role": "client", "client_id": "CLT001" }
{
  "type": "notification",
  "source": "wms",
  "event_type": "PACKAGE_STATUS_UPDATED",
  "data": { "order_id": "ORD123", "status": "READY" },
  "timestamp": "2026-07-31T06:30:05Z"
}
{
  "type": "order_created",
  "order_id": "ORD123",
  "transaction_id": "TXN9A8B7C6D"
}
{
  "type": "delivery_update",
  "order_id": "ORD123",
  "driver_id": "DRV001",
  "status": "delivered",
  "timestamp": "2026-07-31T06:30:10Z"
}
{
  "type": "transaction_failed",
  "transaction_id": "TXN9A8B7C6D",
  "order_id": "ORD123",
  "failed_steps": ["ros"]
}
```

---

## 9. Component Implementation Instructions (Per Member)

### Member 1: CMS Service
- File: `cms-service/app.py`, `cms-service/requirements.txt`, `cms-service/Dockerfile`
- **MUST expose SOAP at `/soap` using Spyne** with methods: `authenticate_client`, `create_order`, `get_client_orders`
- **MUST expose REST** at `/api/clients/auth`, `/api/orders`, `/api/orders/<client_id>`, `/api/orders/status/<order_id>`
- **MUST publish** `ORDER_CREATED` event to RabbitMQ queue `order_events` after every successful order insert
- Connect to PostgreSQL using env var `DATABASE_URL` defaulting to `postgresql://swift:logistics123@postgres:5432/swiftlogistics`
- Connect to RabbitMQ using env var `RABBITMQ_URL` defaulting to `amqp://swift:logistics123@rabbitmq:5672/`
- Use bcrypt to verify passwords

**requirements.txt must include:**
```
flask
spyne
lxml
psycopg2-binary
pika
bcrypt
```

---

### Member 2: ROS Service
- File: `ros-service/app.js`, `ros-service/package.json`, `ros-service/Dockerfile`
- **MUST store routes in JS Maps** (no database)
- **MUST implement Haversine formula** for distance calculation
- **MUST consume** `ORDER_CREATED` from `order_events`, add stop to today's route for `DRV001`, re-order by nearest-neighbour, and publish `ROS_PROCESSING_COMPLETE`
- **MUST expose REST endpoints:** `GET /api/routes/driver/:driverId/today`, `PUT /api/routes/:routeId/stops/:orderId`, `GET /api/routes`
- RabbitMQ URL from env var `RABBITMQ_URL`
- **ETA calculation:** Start at 08:00 AM, add 30 minutes per stop in sequence

**package.json dependencies:**
```json
{ "express": "^4", "amqplib": "^0.10", "uuid": "^9", "cors": "^2" }
```

---

### Member 3: WMS Service
- File: `wms-service/app.py`, `wms-service/requirements.txt`, `wms-service/Dockerfile`
- **MUST run THREE threads:** TCP Server (port 9000), RabbitMQ Consumer, Flask REST API
- **TCP protocol:** Read newline-delimited JSON, handle commands: `PING`, `REGISTER_PACKAGE`, `SCAN_BARCODE`, `UPDATE_STATUS`
- **MUST consume** `ORDER_CREATED`, auto-create package in `packages` table, assign warehouse location (e.g., zone A-D, rack 1-5, shelf 1-3 = `A3-2`), publish `WMS_PROCESSING_COMPLETE`
- **REST endpoints:** `POST /api/packages`, `GET /api/packages/order/<order_id>`, `PUT /api/packages/<id>/status`, `GET /api/warehouse/locations`
- Use `threading.Thread` for concurrent servers

**requirements.txt must include:**
```
flask
psycopg2-binary
pika
bcrypt
```

---

### Member 4: API Gateway
- File: `api-gateway/app.js`, `api-gateway/package.json`, `api-gateway/Dockerfile`
- **JWT:** Use `jsonwebtoken`. Secret from env `JWT_SECRET` default `swiftlogistics-secret-key-2026`
- **SOAP client:** Use `axios` to POST raw XML to `http://cms-service:8001/soap`, parse XML response with `xml2js`
- **TCP client:** Use Node.js `net.createConnection()` to port 9000 on `wms-service`
- **WebSocket:** Use `ws` library. Maintain `wsClients = { clients: Map(), drivers: Map() }`
- **RabbitMQ:** Consume `wms_events` and `route_events`. On message, call `broadcastToAll()` or `notifyClient()`
- **Transaction map:** In-memory `Map`. On order creation: `{cms:'completed', ros:'pending', wms:'pending'}`. Update as events arrive.
- Service URLs from env: `CMS_URL`, `ROS_URL`, `WMS_URL`, `RABBITMQ_URL`

**package.json dependencies:**
```json
{ "express": "^4", "cors": "^2", "body-parser": "^1", "ws": "^8", "amqplib": "^0.10", "axios": "^1", "jsonwebtoken": "^9", "uuid": "^9", "xml2js": "^0.6" }
```

---

### Member 5: Client Portal
- Files: `client-portal/index.html`, `client-portal/app.js`, `client-portal/styles.css`, `client-portal/nginx.conf`, `client-portal/Dockerfile`
- **Login:** POST to `/api/auth/client/login`. Store `token` and `clientId` in `localStorage`
- **Order form:** Collect addresses and weight. POST to `/api/orders` with Bearer token
- **Orders table:** GET `/api/orders` on load. Re-fetch after each WebSocket notification
- **WebSocket:** Connect to `ws://` + `location.host`. Send `register_client` on open
- **nginx.conf:** Proxy `/api` and `/ws` to `http://api-gateway:3000`. Serve static files from `/usr/share/nginx/html`

**Dockerfile:**
```dockerfile
FROM nginx:alpine
COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

---

### Member 6: Driver App + DB + Docker
- **DB:** Write `database/init.sql` (schema above + seed data)
- **Docker Compose:** Wire all 7 services on `swift-network`. Set `depends_on` with health checks for postgres and rabbitmq
- **Driver App:** `driver-app/index.html`, `driver-app/app.js`, `driver-app/styles.css`, `driver-app/nginx.conf`, `driver-app/Dockerfile`
  - Login: POST `/api/auth/driver/login`
  - Route manifest: GET `/api/driver/route/today`
  - Delivery complete: Canvas signature (`toDataURL()`), POST `/api/driver/delivery/:orderId` with `{status:'delivered', recipient_name, signature}`
  - Failed delivery: POST same endpoint with `{status:'failed', reason:'recipient_unavailable'|'wrong_address'|'refused'}`
  - WebSocket: `register_driver` on connect

**docker-compose.yml services order:**
```
postgres → rabbitmq → cms-service → ros-service → wms-service → api-gateway → client-portal → driver-app
```

---

## 10. Environment Variables Reference

| Service | Variable | Default Value |
|---------|----------|---------------|
| CMS | `DATABASE_URL` | `postgresql://swift:logistics123@postgres:5432/swiftlogistics` |
| CMS | `RABBITMQ_URL` | `amqp://swift:logistics123@rabbitmq:5672/` |
| WMS | `DATABASE_URL` | same as CMS |
| WMS | `RABBITMQ_URL` | same as CMS |
| API Gateway | `CMS_URL` | `http://cms-service:8001` |
| API Gateway | `ROS_URL` | `http://ros-service:8002` |
| API Gateway | `WMS_URL` | `http://wms-service:8003` |
| API Gateway | `WMS_TCP_HOST` | `wms-service` |
| API Gateway | `WMS_TCP_PORT` | `9000` |
| API Gateway | `RABBITMQ_URL` | `amqp://swift:logistics123@rabbitmq:5672/` |
| API Gateway | `JWT_SECRET` | `swiftlogistics-secret-key-2026` |
| PostgreSQL | `POSTGRES_USER` | `swift` |
| PostgreSQL | `POSTGRES_PASSWORD` | `logistics123` |
| PostgreSQL | `POSTGRES_DB` | `swiftlogistics` |
| RabbitMQ | `RABBITMQ_DEFAULT_USER` | `swift` |
| RabbitMQ | `RABBITMQ_DEFAULT_PASS` | `logistics123` |

---

## 11. Order Status Lifecycle

```
pending → processing → ready → loaded → in_transit → delivered
                                                    ↘ failed
```

Each status change triggers:
1. CMS `orders` table update
2. WMS `packages` table update
3. ROS `route_stops` table update
4. WebSocket broadcast to all connected clients

---

## 12. Ports Quick Reference

| Service | HTTP Port | Other |
|---------|-----------|-------|
| Client Portal | 8080 | — |
| Driver App | 8081 | — |
| API Gateway | 3000 | WS: 3000 |
| CMS Service | 8001 | SOAP: /soap |
| ROS Service | 8002 | — |
| WMS Service | 8003 | TCP: 9000 |
| RabbitMQ | 5672 | Management: 15672 |
| PostgreSQL | 5432 | — |

---

## 13. Access Credentials (Demo)

| App | Email | Password |
|-----|-------|----------|
| Client Portal | techmart@example.com | password123 |
| Client Portal | fashionhub@example.com | password123 |
| Driver App | kasun@swiftlogistics.lk | password123 |
| Driver App | nimal@swiftlogistics.lk | password123 |
| RabbitMQ UI | swift | logistics123 |
| PostgreSQL | swift | logistics123 |
