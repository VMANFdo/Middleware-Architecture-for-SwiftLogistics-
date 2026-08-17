# SwiftTrack — Middleware Architecture Reimplementation Plan
### IS3208 | Assignment 4 | Group of 6

---

## 1. What We're Building

**SwiftLogistics (Pvt) Ltd.** needs a middleware layer ("SwiftTrack") that integrates three siloed legacy systems:

| System | Protocol | Role |
|--------|----------|------|
| **CMS** (Client Management System) | SOAP/XML | Client accounts, order intake |
| **ROS** (Route Optimisation System) | REST/JSON | Delivery route planning |
| **WMS** (Warehouse Management System) | TCP/IP proprietary | Package tracking in warehouse |

The deliverable is a **functional prototype** — not a production system. The assignment explicitly says:
> *"A minimal implementation that mocks the functionalities of the CMS, ROS, and WMS… The real-time tracking and notification system should be architecturally described, but only minimally implemented."*

So we build **just enough to demonstrate the architecture** — no over-engineering.

---

## 2. Architecture Decision

### Option A — ESB (Enterprise Service Bus) e.g. Apache Camel / WSO2
- Central bus routes all messages
- Heavy setup, complex for a prototype
- ❌ Too complex, overkill for this size

### Option B — API Gateway + Message Broker (Microservices) ✅ **Chosen**
- Lightweight API Gateway (Node.js/Express) as single entry point
- RabbitMQ for async pub/sub messaging
- Each system runs as a small mock service
- ✅ Clean separation, demonstrates all required patterns
- ✅ Easy to run with Docker Compose
- ✅ Matches all 6 architectural challenges in the assignment

**Justification for docs:** The API Gateway + event-driven microservices pattern allows heterogeneous protocol bridging at the gateway level (SOAP, REST, TCP adapters), asynchronous decoupling via RabbitMQ for high-volume processing, and WebSockets for real-time client updates — all with minimal infrastructure footprint suitable for a prototype.

---

## 3. System Architecture (What We Actually Build)

```
                    ┌──────────────────────┐
                    │     PostgreSQL DB     │
                    │       (:5432)        │
                    └──────────┬───────────┘
                               │
       ┌────────────┬──────────┼──────────┬────────────┐
       ↓            ↓          ↓          ↓            ↓
  ┌─────────┐  ┌────────┐ ┌───────┐  ┌──────────┐ ┌──────────┐
  │  CMS    │  │  ROS   │ │  WMS  │  │ RabbitMQ │ │  API     │
  │ Service │  │Service │ │Service│  │  :5672   │ │ Gateway  │
  │ (Flask) │  │(Node)  │ │(Flask)│  │  :15672  │ │ (Node)   │
  │ :8001   │  │ :8002  │ │ :8003 │  │          │ │  :3000   │
  │ SOAP+   │  │ REST   │ │ TCP   │  └──────────┘ └──────────┘
  │ REST    │  │        │ │ :9000 │
  └─────────┘  └────────┘ └───────┘

                              ↑ API Gateway talks to all of them

  ┌─────────────────┐    ┌──────────────────┐
  │  Client Portal  │    │ Driver Web Portal│
  │ HTML/JS :8080   │    │ HTML/JS  :8081   │
  └─────────────────┘    └──────────────────┘
```

**Patterns used (required by assignment):**
- **API Gateway Pattern** — single entry point, JWT auth, protocol translation
- **Adapter Pattern** — CMS SOAP adapter, WMS TCP adapter
- **Publish-Subscribe (Event-Driven)** — RabbitMQ decouples CMS → ROS & WMS
- **Saga Pattern (Choreography)** — distributed transaction tracking across 3 systems
- **Circuit Breaker (basic)** — graceful error handling per service call

---

## 4. Team Division — 6 Members, Equal Work

Each member owns **one complete component** end-to-end (code + docs section).

| Member | Component | Key Technologies | Docs Section |
|--------|-----------|-----------------|--------------|
| **Member 1** | CMS Service (mock) | Python, Flask, Spyne (SOAP), PostgreSQL | Section c.i — CMS Adapter Pattern |
| **Member 2** | ROS Service (mock) | Node.js, Express, in-memory route logic | Section c.ii — ROS & Pub/Sub |
| **Member 3** | WMS Service (mock) | Python, Flask, TCP sockets, RabbitMQ | Section c.iii — WMS Adapter + TCP |
| **Member 4** | API Gateway | Node.js, Express, JWT, WebSockets, RabbitMQ consumer | Section b — Architecture diagrams |
| **Member 5** | Client Portal | HTML, CSS, Vanilla JS, Nginx | Section d — Prototype demo |
| **Member 6** | Database + Docker + Driver Web Portal | PostgreSQL, Docker Compose, HTML/JS | Section a + e — Intro & Security |

> **Shared responsibilities:** All members document their own component's architecture pattern and attend the screencast recording.

---

## 5. Component-by-Component Implementation Guide

---

### Component 1: CMS Service (Member 1)

**Folder:** `cms-service/`

**What it does:** Mimics a legacy SOAP/XML Client Management System. Stores clients and orders in PostgreSQL.

**Files to create:**
- `cms-service/app.py` — Flask + Spyne SOAP service
- `cms-service/requirements.txt`
- `cms-service/Dockerfile`

**Core functionality (keep it minimal):**

1. **SOAP endpoint** at `/soap` — methods:
   - `authenticate_client(email, password)` → returns client_id + token
   - `create_order(client_id, pickup_addr, delivery_addr, weight)` → returns order_id
   - `get_client_orders(client_id)` → returns list of orders

2. **REST endpoint** (internal, for API Gateway to call):
   - `POST /api/clients/auth` — validates credentials, returns JWT-ready info
   - `POST /api/orders` — creates order, publishes `ORDER_CREATED` to RabbitMQ
   - `GET /api/orders?client_id=X` — get orders for a client
   - `PUT /api/orders/<order_id>/status` — update order status

3. **RabbitMQ:** On order creation, publish to `order_events` queue:
   ```json
   {
     "event": "ORDER_CREATED",
     "order_id": "ORD...",
     "pickup_lat": 6.9271,
     "pickup_lng": 79.8612,
     "delivery_lat": 6.9344,
     "delivery_lng": 79.8428,
     "weight": 2.5,
     "client_id": "CLT001"
   }
   ```

**Key pattern to document:** Adapter Pattern — SOAP/XML legacy interface exposed alongside REST for modern gateway.

---

### Component 2: ROS Service (Member 2)

**Folder:** `ros-service/`

**What it does:** Mimics a cloud REST API for route optimisation. Listens for `ORDER_CREATED` events and builds delivery routes.

**Files to create:**
- `ros-service/app.js`
- `ros-service/package.json`
- `ros-service/Dockerfile`

**Core functionality:**

1. **In-memory storage** — no database needed:
   - Pre-load 2-3 vehicles: `{ driver_id, name, vehicle_type, capacity }`
   - Store routes in a `Map`

2. **REST API endpoints:**
   - `GET /api/vehicles/available` — list available vehicles
   - `POST /api/routes/optimize` — create optimised route given stops
   - `GET /api/routes/driver/:driverId/today` — today's route for a driver
   - `PUT /api/routes/:routeId/stops/:orderId` — update stop status

3. **RabbitMQ consumer** — consumes `ORDER_CREATED`:
   - Find or create today's route for `DRV001`
   - Add stop with pickup/delivery coordinates
   - Simple nearest-neighbor ordering (Haversine distance)
   - Publish `ROUTE_UPDATED` event to `route_events` queue

4. **Publish `ROS_PROCESSING_COMPLETE`** to help API Gateway track transaction progress.

**Key pattern to document:** Publish-Subscribe — ROS reacts to CMS events asynchronously, no direct coupling.

---

### Component 3: WMS Service (Member 3)

**Folder:** `wms-service/`

**What it does:** Mimics a warehouse system with a proprietary TCP/IP protocol. Tracks packages from receipt to vehicle loading.

**Files to create:**
- `wms-service/app.py`
- `wms-service/requirements.txt`
- `wms-service/Dockerfile`

**Core functionality — three threads:**

**Thread 1: TCP Server on port 9000**
- Accept connections, read newline-delimited JSON
- Supported message types:
  - `REGISTER_PACKAGE` → assign warehouse location, barcode
  - `UPDATE_STATUS` → change package status
  - `GET_PACKAGE` → query package info
  - `PING` → keepalive

**Thread 2: RabbitMQ Consumer**
- Consume `ORDER_CREATED` from `order_events`
- Auto-register package in PostgreSQL
- Assign random warehouse location (e.g., `A1-2`)
- Publish `WMS_PROCESSING_COMPLETE` to `wms_events`

**Thread 3: Flask REST API**
- `POST /api/packages` — register package
- `GET /api/packages/<id>` — get package
- `PUT /api/packages/<id>/status` — update status
- `GET /api/packages/order/<order_id>` — all packages for order

**Key pattern to document:** Adapter Pattern — proprietary TCP protocol bridged to REST/JSON by the service itself.

---

### Component 4: API Gateway (Member 4)

**Folder:** `api-gateway/`

**What it does:** The brain. Single entry point. Handles auth, routing, protocol translation, and real-time updates.

**Files to create:**
- `api-gateway/app.js`
- `api-gateway/package.json`
- `api-gateway/Dockerfile`

**Core functionality:**

1. **JWT Authentication middleware**
   - `POST /api/auth/client/login` — validates against CMS, returns JWT
   - `POST /api/auth/driver/login` — hardcoded driver auth for demo
   - `authenticateToken` middleware protects all other routes

2. **Request Routing (protocol translation)**
   - Client requests (REST/JSON) → CMS (REST adapter)
   - Driver requests → ROS (REST) + WMS (TCP via `net.createConnection`)
   - WMS TCP adapter: open socket, send JSON message, read response, close

3. **WebSocket Server** (for real-time updates)
   - Clients connect and register: `{ type: 'register_client', clientId }`
   - Drivers connect and register: `{ type: 'register_driver', driverId }`
   - Store connections in Maps

4. **RabbitMQ Consumer** — listens to:
   - `order_events` → broadcast `order_created` WebSocket notification
   - `wms_events` → broadcast package status update
   - `route_events` → broadcast route update to driver

5. **Transaction Tracking** (simple in-memory map):
   - On order creation, create `{ txn_id, cms: 'pending', ros: 'pending', wms: 'pending' }`
   - Mark each step done as events arrive
   - When all done → `overall: 'completed'`

6. **Endpoints:**
   - `GET /health` — check all services
   - `POST /api/orders` — orchestrate order creation across CMS, then async ROS+WMS
   - `GET /api/orders` — fetch client's orders from CMS
   - `GET /api/orders/:id` — fetch order + package info + route info (aggregated)
   - `PUT /api/orders/:id/status` — update order status
   - `GET /api/driver/route/today` — get driver's today's route from ROS
   - `POST /api/driver/delivery/:orderId` — mark delivery complete/failed
   - `GET /api/track/:orderId` — public order tracking (no auth)

**Key pattern to document:** API Gateway Pattern, Circuit Breaker (basic try/catch with timeouts).

---

### Component 5: Client Portal (Member 5)

**Folder:** `client-portal/`

**What it does:** Simple web app for e-commerce clients to manage and track orders.

**Files to create:**
- `client-portal/index.html`
- `client-portal/app.js`
- `client-portal/styles.css`
- `client-portal/nginx.conf`
- `client-portal/Dockerfile`

**Pages:**

1. **Login page**
   - Email + password form
   - `POST /api/auth/client/login` → store JWT in localStorage

2. **Dashboard**
   - Stats bar (total orders, pending, delivered)
   - Orders table with status badges
   - "Create Order" button → modal form with pickup/delivery address + weight
   - Real-time notification panel (WebSocket updates appear here)

**WebSocket behaviour:**
- On load, connect to `ws://localhost:3000`
- Send `{ type: 'register_client', clientId }` after login
- On message, show toast notification and refresh orders list

**Key to document (Section d):** Show the working prototype — login → create order → see real-time notification → order status updates.

---

### Component 6: Database + Docker + Driver Web Portal (Member 6)

**Folder:** `database/`, `driver-app/`, root files

**Sub-tasks:**

**6a: PostgreSQL Schema** (`database/init.sql`):
Tables needed (keep minimal):
- `clients(client_id, company_name, email, password_hash, contract_type)`
- `drivers(driver_id, name, email, password_hash, vehicle_type)`
- `orders(order_id, client_id, pickup_address, delivery_address, pickup_lat, pickup_lng, delivery_lat, delivery_lng, weight, status, created_at)`
- `packages(package_id, order_id, barcode, warehouse_location, status)`
- `routes(route_id, driver_id, date, status)`
- `route_stops(id, route_id, order_id, sequence_number, estimated_arrival, status)`
- `transaction_logs(transaction_id, order_id, cms_status, ros_status, wms_status, overall_status)`

Seed data: 2-3 clients, 2 drivers (all with password `password123` bcrypt hash).

**6b: Responsive Driver Web Portal** (`driver-app/`):
- Login page (driver email + password)
- Dashboard: today's route list (stops with address, ETA)
- Click a stop → mark as "Delivered" (with recipient name field) or "Failed" (with reason dropdown)
- WebSocket: receive notifications for new orders added to route
- Simple canvas signature capture for proof of delivery

**6c: Docker Compose** (`docker-compose.yml`):
Wire up all 7 services on a bridge network:
```yaml
services: postgres, rabbitmq, cms-service, ros-service, wms-service, api-gateway, client-portal, driver-app
```
With `depends_on` and health checks so services start in right order.

**6d: `start-services.bat` / `stop-services.bat`** — convenience scripts.

**Key to document:** Sections a (Intro) + e (Security: JWT, bcrypt, Docker network isolation, env vars).

---

## 6. Shared Deliverables

### Documentation (everyone contributes their section)

| Section | Owner | Content |
|---------|-------|---------|
| a. Introduction | Member 6 | Business problem, solution overview |
| b. Architecture diagrams | Member 4 | Conceptual + implementation diagrams + 2 alternatives |
| c. Architectural Patterns | Members 1,2,3,4 | Adapter, Pub-Sub, API Gateway, Saga, Circuit Breaker |
| d. Prototype demo | Member 5 | Screenshots, order flow walkthrough |
| e. Security considerations | Member 6 | JWT, bcrypt, Docker network, HTTPS considerations |

### Screencast (~10 min)
- Each member narrates their own component's section
- Member 5 does the live demo portion

---

## 7. Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| API Gateway | Node.js + Express | Non-blocking I/O, easy WebSocket |
| CMS Mock | Python + Flask + Spyne | Spyne makes SOAP easy in Python |
| ROS Mock | Node.js + Express | Lightweight, matches REST pattern |
| WMS Mock | Python + Flask + raw sockets | TCP socket control in Python is simple |
| Message Broker | RabbitMQ | Industry standard pub/sub, good management UI |
| Database | PostgreSQL | Relational, reliable, free |
| Frontend | Vanilla HTML/CSS/JS | No framework needed for a prototype |
| Reverse Proxy | Nginx | Serve static files, proxy /api and /ws |
| Infrastructure | Docker + Docker Compose | Easy reproducible setup |

---

## 8. Implementation Order (Recommended Sequence)

```
Week 1:
  - Member 6: Set up database schema + Docker Compose skeleton
  - Member 1: CMS Service (SOAP + REST + RabbitMQ publish)
  - Member 2: ROS Service (REST API + in-memory routes)

Week 2:
  - Member 3: WMS Service (TCP + RabbitMQ consumer + REST)
  - Member 4: API Gateway (auth + routing + WebSocket)
  - Test: CMS → RabbitMQ → ROS & WMS flow end-to-end

Week 3:
  - Member 5: Client Portal (login + dashboard + WebSocket)
  - Member 6: Driver Web Portal (login + route view + delivery marking)
  - Integration testing with all services running

Week 4:
  - All: Write documentation sections
  - Record screencast (each person narrates their part)
  - Final polish + submission
```

---

## 9. What We DON'T Need (Scope Limit)

The assignment says "minimal implementation" — so intentionally skip:

- ❌ Real-time GPS tracking on a map
- ❌ Photo capture (signature canvas is enough for POD)
- ❌ Push notifications (WebSocket toast notifications are sufficient)
- ❌ Full circuit breaker library (basic try/catch is fine)
- ❌ HTTPS/TLS (mention in security docs, not required for prototype)
- ❌ Admin panel
- ❌ Billing/invoicing features
- ❌ Complex route optimization (nearest-neighbor is enough)
- ❌ Service discovery / registry (not required by assignment)

---

## 10. Open Questions

> [!IMPORTANT]
> **Do you want to reuse the existing directory structure** (`d:\Campus work\...\system_sourcecode`) and write new files directly there, overwriting the existing source code? Or should we create a fresh new folder?

> [!IMPORTANT]  
> **Member names** — do you want me to assign specific work items to specific people by name? If you share the 6 names I can personalise the breakdown.

> [!NOTE]
> The existing source code is already a complete, working implementation of this assignment. The plan above strips it back to the minimum required by the assignment brief. Should any member use the existing code as a reference/starting point, or must all code be written independently from scratch?
