# SwiftTrack — Middleware Architecture for SwiftLogistics

A fully-integrated middleware platform bridging three heterogeneous backend systems for SwiftLogistics, built as part of an IS3208 Middleware Architecture assignment. The platform handles real-time order tracking, route optimisation, and warehouse management via a unified API Gateway — with no order ever lost even when a downstream service is temporarily unavailable.

## Architecture Overview

```
                     ┌─────────────────┐          ┌──────────────────┐
                     │  Client Portal  │          │  Driver Portal   │
                     │  (PWA) :8080    │          │  (PWA) :8081     │
                     └────────┬────────┘          └─────────┬────────┘
                              │            HTTP + WebSocket  │
                              └──────────────┬──────────────┘
                                             ▼
                                   ┌─────────────────────┐
                                   │   API Gateway :3000  │
                                   │  REST ↔ SOAP/XML     │
                                   │  REST ↔ TCP          │
                                   │  Saga Coordinator    │
                                   │  WebSocket Dispatch  │
                                   └───┬───────┬───────┬──┘
                        SOAP/XML       │       │       │   TCP (:9000)
                    ┌──────────────────┘       │       └──────────────────┐
                    ▼                          │ REST                     ▼
          ┌──────────────────┐                 ▼                ┌──────────────────┐
          │   CMS Service    │        ┌──────────────────┐      │   WMS Service    │
          │      :8001       │        │   ROS Service    │      │  REST :8003      │
          │  Flask + Spyne   │        │      :8002       │      │  TCP  :9000      │
          └─────────┬────────┘        │  Node.js Express │      └─────────┬────────┘
                    │                 └─────────┬────────┘                │
                    └──────────────┬────────────┴───────────────────┬─────┘
                                   ▼        publish / subscribe      ▼
                          ┌────────────────────────────────────────────┐
                          │             RabbitMQ (:5672)               │
                          │          exchange: order_events            │
                          └────────────────────────────────────────────┘
                                              │
                                              ▼
                                   ┌─────────────────────┐
                                   │     PostgreSQL       │
                                   │        :5432         │
                                   └─────────────────────┘
```

**Integration patterns:** Gateway, Channel Adapter (SOAP/XML ↔ REST, TCP ↔ REST), Publish-Subscribe, Saga (distributed transaction coordinator), Canonical Data Model.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for a full explanation of each pattern and the data flow.

---

## Project Structure

```
SwiftTrack/
│
├── database/
│   └── init.sql              # PostgreSQL schema + seed data
│
├── api-gateway/              # Central gateway — protocol bridging, Saga, WebSockets
│   ├── app.js
│   ├── package.json
│   └── Dockerfile
│
├── cms-service/              # Client Management System — SOAP/REST hybrid (Flask + Spyne)
│   ├── app.py
│   ├── requirements.txt
│   └── Dockerfile
│
├── ros-service/              # Route Optimisation System — REST + RabbitMQ (Node.js)
│   ├── app.js
│   ├── package.json
│   └── Dockerfile
│
├── wms-service/              # Warehouse Management System — REST + proprietary TCP (Flask)
│   ├── app.py
│   ├── requirements.txt
│   └── Dockerfile
│
├── client-portal/            # Client web dashboard (Vanilla JS PWA, served by Nginx)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── Dockerfile
│
├── driver-app/               # Driver mobile-first PWA (Vanilla JS, served by Nginx)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── sw.js                 # Service Worker (offline support)
│   ├── manifest.json         # PWA manifest (Add to Home Screen)
│   └── Dockerfile
│
├── docker-compose.yml        # Orchestrates all 7 services
├── .env.example              # Environment variable reference
├── ARCHITECTURE.md           # Integration pattern deep-dive
└── README.md
```

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2 on Linux)
- Git

### Run the full stack

```bash
git clone https://github.com/VMANFdo/Middleware-Architecture-for-SwiftLogistics-.git
cd Middleware-Architecture-for-SwiftLogistics-

docker compose up --build
```

All seven services start, including infrastructure (PostgreSQL + RabbitMQ), the three backend systems, the API Gateway, the Client Portal, and the Driver Portal.

> The first `--build` may take a minute to pull base images.

### Verify everything is healthy

```bash
docker compose ps
curl http://localhost:3000/health
```

### Optional port overrides

If ports `3000`, `8080`, or `8081` are already in use on your machine, copy `.env.example` to `.env` and adjust the host-side port overrides before starting:

```bash
cp .env.example .env
# edit .env as needed
docker compose up --build
```

Container-to-container communication always uses the internal ports — only the host-side bindings change.

---

## Service Port Map

| Port | Service | Protocol |
|---|---|---|
| 3000 | API Gateway | HTTP + WebSocket (`/ws`) |
| 5432 | PostgreSQL | Postgres |
| 5672 / 15672 | RabbitMQ (AMQP / Management UI) | AMQP / HTTP |
| 8001 | CMS Service | SOAP (`/soap`) + REST |
| 8002 | ROS Service | REST |
| 8003 / 9000 | WMS Service (REST / proprietary TCP) | REST / TCP |
| 8080 | Client Portal | HTTP |
| 8081 | Driver Portal (PWA) | HTTP |

---

## Technology Stack

| Layer | Technology |
|---|---|
| API Gateway | Node.js 20, Express, ws, amqplib, axios, jsonwebtoken |
| CMS Service | Python 3.12, Flask, Spyne (SOAP/XML), psycopg2, pika, bcrypt |
| ROS Service | Node.js 20, Express, amqplib, pg |
| WMS Service | Python 3.12, Flask, raw TCP sockets, psycopg2, pika |
| Message Broker | RabbitMQ 3 (fanout exchanges: `order_events`, `route_events`, `wms_events`) |
| Database | PostgreSQL 16 |
| Real-time | WebSockets (broadcast + targeted dispatch) |
| Frontends | Vanilla HTML/CSS/JS, Nginx, PWA (Service Worker + Web App Manifest) |
| Orchestration | Docker Compose |

---

## Demo Credentials

All seeded accounts share the password **`password123`**.

| Role | Email | Notes |
|---|---|---|
| Client | `techmart@example.com` | TechMart Online (premium) |
| Client | `fashionhub@example.com` | Fashion Hub (standard) |
| Client | `homegoods@example.com` | HomeGoods Lanka (enterprise) |
| Driver | `kasun@swiftlogistics.lk` | Vehicle WP-KA-1234 |
| Driver | `nimal@swiftlogistics.lk` | Vehicle WP-NB-5678 |

---

## API Reference

All routes except `/health` and auth endpoints require a `Bearer` JWT token in the `Authorization` header.

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/client/login` | None | Authenticate a client (proxied to CMS SOAP) |
| `POST` | `/api/auth/driver/login` | None | Authenticate a driver |
| `GET` | `/api/auth/me` | Any | Return current user info from token |

### Orders

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders` | Client | Create a new order (triggers full Saga) |
| `GET` | `/api/orders` | Client | List all orders for the authenticated client |
| `GET` | `/api/orders/:orderCode` | Any | Fetch a single order with package + route + Saga logs |

### Packages (WMS — via TCP adapter)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/packages/scan/:barcode` | Driver | Look up a package by barcode |
| `GET` | `/api/packages/order/:orderCode` | Client, Driver | Look up a package by order code |
| `PUT` | `/api/packages/status` | Driver | Update warehouse package status |

### Driver & Routes (ROS proxy)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/driver/route/today` | Driver | Fetch today's optimised route for the authenticated driver |
| `POST` | `/api/driver/delivery/:orderCode` | Driver | Submit delivery proof (triggers WebSocket dispatch) |
| `GET` | `/api/routes` | Driver | List all routes |
| `PUT` | `/api/routes/:routeId/stops/:orderCode` | Driver | Update a route stop status |

### Saga / Distributed Transactions

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/saga/transactions` | Any | List recent Saga steps from the transaction log |
| `GET` | `/api/saga/transactions/:orderCode` | Any | Fetch Saga history for a specific order |
| `POST` | `/api/saga/simulate-failure` | Any | Trigger a simulated Saga compensation (for testing) |

### WebSocket (`ws://localhost:3000/ws`)

After connecting, send a JSON registration message to receive targeted events:

```json
{ "type": "register_client", "client_id": "CLT001" }
{ "type": "register_driver", "driver_id": "DRV001" }
```

**Inbound event types:** `ORDER_CREATED`, `ROS_PROCESSING_COMPLETE`, `WMS_PROCESSING_COMPLETE`, `SAGA_TRANSACTION_SUCCESS`, `SAGA_COMPENSATED`, `DELIVERY_COMPLETED`, `PACKAGE_STATUS_UPDATED`, `ROUTE_UPDATED`, `NEW_ORDER_AVAILABLE`.

---

## Implementation Status

| Phase | Scope | Status |
|---|---|---|
| 1 | PostgreSQL schema, Docker Compose, API Gateway scaffold | ✅ Complete |
| 2 | CMS (SOAP/REST), ROS (REST + route optimiser), WMS (REST + TCP) | ✅ Complete |
| 3 | Gateway protocol bridging — SOAP/XML adapter, TCP adapter | ✅ Complete |
| 4 | Client Portal (web dashboard), Driver Portal (mobile PWA) | ✅ Complete |
| 5 | Saga coordinator, RabbitMQ pub/sub, WebSocket real-time dispatch | ✅ Complete |
| 6 | Integration testing & load testing | 🔄 In progress |
| 7 | Final documentation & screencast | ✅ Complete |
