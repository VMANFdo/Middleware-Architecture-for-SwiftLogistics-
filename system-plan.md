# SwiftTrack — Master Phase-by-Phase Implementation Plan
### SCS3208 | Assignment 4 | Group of 6 (Master Plan)

This plan maps out the construction of the **SwiftTrack** middleware platform in chronological order. Each phase outlines the exact steps, responsible members, key interfaces, and testing strategies.

---

```
Phase 1: Setup DB & Compose (M6) + Gateway Scaffold (M4)
     │
     ▼
Phase 2: Build Mocks — CMS (M1), ROS (M2), WMS (M3)
     │
     ▼
Phase 3: Gateway Protocol Bridging — HTTP/SOAP/TCP (M4 + M1/M3)
     │
     ▼
Phase 4: Frontend Development — Client Web (M5), Driver App (M6)
     │
     ▼
Phase 5: Saga Transaction Coordinator & WebSockets (M4 + M1/M2/M3)
     │
     ▼
Phase 6: End-to-End Integration, Validation & Load Testing (All)
     │
     ▼
Phase 7: Group Documentation & Screencast Presentation (All)
```

---

## Phase 1: Core Database, Infrastructure & Gateway Scaffold
*   **Goal:** Establish the shared network, local database, message broker, and routing server.
*   **Estimated Duration:** Days 1–3

### Step 1.1: PostgreSQL Schema Definition & Hashed Seed Data
*   **Responsible Member:** **Member 6**
*   **Task:** Create [init.sql](file:///d:/Campus%20work/3rd%20year%201st%20sem/Middleware/assignments/system_sourcecode/database/init.sql) containing schemas for `clients`, `drivers`, `orders`, `packages`, `routes`, `route_stops`, `delivery_proofs`, and `transaction_logs`.
*   **Detail:** Must generate hashed bcrypt credentials (`$2b$10$...`) for demo clients and drivers. The default password is `password123`.
*   **Verification:** Run a local PostgreSQL instance and execute the schema script; verify tables exist and are querying correctly.

### Step 1.2: Orchestration (Docker Compose Configuration)
*   **Responsible Member:** **Member 6**
*   **Task:** Create the root `docker-compose.yml` declaring 7 services: `postgres`, `rabbitmq`, `cms-service`, `ros-service`, `wms-service`, `api-gateway`, `client-portal`, `driver-app`.
*   **Detail:** Set up a bridge network `swift-network`. Declare health checks on `postgres` and `rabbitmq` so backend services do not boot until infrastructure is fully responsive.
*   **Verification:** Execute `docker compose up -d postgres rabbitmq` and confirm Docker Desktop shows active status.

### Step 1.3: API Gateway Initial Scaffold
*   **Responsible Member:** **Member 4**
*   **Task:** Create `api-gateway/app.js` and `package.json`.
*   **Detail:** Set up an Express app listing on port 3000. Incorporate standard JSON body parsing and CORS configuration. Add basic `/health` route.
*   **Verification:** Start the gateway locally (`node app.js`) and access `http://localhost:3000/health` in a browser.

---

## Phase 2: Core Mock Services Development
*   **Goal:** Build the independent business systems CMS, ROS, and WMS.
*   **Estimated Duration:** Days 4–10
*   **Dependency:** Phase 1 (Database and Broker setup must be completed).

### Step 2.1: Legacy SOAP & REST CMS Service
*   **Responsible Member:** **Member 1**
*   **Task:** Write Flask service with Spyne framework.
*   **Detail:** Expose SOAP handler on `/soap` mapped to `create_order`, `get_client_orders`, and `authenticate_client`. Add REST adapters mapping to DB select/insert statements. Include RabbitMQ client logic to publish an event on exchange `order_events` upon new order insertion.
*   **Verification:** Query the generated SOAP WSDL at `http://localhost:8001/soap/wsdl` using a client like SoapUI or Python's `zeep` library.

### Step 2.2: ROS Route Manifest Service
*   **Responsible Member:** **Member 2**
*   **Task:** Write Node.js Express service for ROS routing.
*   **Detail:** Create in-memory JS Maps to represent route tables. Implement the nearest-neighbor algorithm based on Haversine distance logic. Create RabbitMQ consumer parsing `ORDER_CREATED` messages to dynamically add stop sequence indices.
*   **Verification:** Mock a RabbitMQ event manually and check if the ROS log prints an added stop coordinates update.

### Step 2.3: Proprietary TCP WMS Service
*   **Responsible Member:** **Member 3**
*   **Task:** Write Python Flask service that runs a TCP Socket Server on Port 9000 using Python's `threading` and `socket`.
*   **Detail:** TCP socket server processes incoming JSON structures followed by a `\n` character. Write RabbitMQ event listener to capture `ORDER_CREATED` events and auto-allocate coordinates/bins (e.g. Zone B-1).
*   **Verification:** Connect to Port 9000 using netcat (`nc localhost 9000`) or Telnet and send client requests: `{"command":"PING"}`. Confirm message replies with `{"status":"PONG"}`.

---

## Phase 3: Gateway Protocol Bridging & Routing
*   **Goal:** Route incoming public JSON payloads to legacy/proprietary interfaces.
*   **Estimated Duration:** Days 11–15
*   **Dependency:** Phase 2 (CMS and WMS must have endpoints ready).

### Step 3.1: REST to SOAP Adapter for CMS
*   **Responsible Member:** **Member 4 (assisted by Member 1)**
*   **Task:** Implement SOAP client connector within the API Gateway (`api-gateway/app.js`).
*   **Detail:** When a client sends a REST request to `POST /api/auth/client/login`, the gateway converts credentials to an XML payload, sends it to the CMS SOAP `/soap` endpoint, processes the XML reply, and sends JSON back to client.
*   **Verification:** Send REST payload via cURL to `POST /api/auth/client/login` and verify a successful login responds with JSON fields.

### Step 3.2: REST to TCP Bridge for WMS
*   **Responsible Member:** **Member 4 (assisted by Member 3)**
*   **Task:** Implement Node.js raw socket handler using `net.createConnection()`.
*   **Detail:** Create REST endpoints on the Gateway such as `GET /api/packages/scan/:barcode`. The Gateway opens socket to `wms-service:9000`, sends serialized JSON command ending in `\n`, reads the line response, parses it, and forwards it to the client.
*   **Verification:** Trigger Gateway scanner route via Postman and confirm it returns database details from WMS.

---

## Phase 4: Frontend Development
*   **Goal:** Create client and driver dashboard interfaces.
*   **Estimated Duration:** Days 16–20
*   **Dependency:** Phase 3 (REST API Gateway must be operational).

### Step 4.1: Client Portal Dashboard
*   **Responsible Member:** **Member 5**
*   **Task:** Build index page, styles file, and script logic.
*   **Detail:** Build simple client view displaying credentials login, a detailed order creation modal (address inputs, priority levels, package weight), and an order logs table. Connect Nginx proxy container to rewrite URLs.
*   **Verification:** Access `http://localhost:8080`, log in using `techmart@example.com`, and submit a mock order.

### Step 4.2: Driver Mobile App & Canvas Pod
*   **Responsible Member:** **Member 6**
*   **Task:** Create driver interface.
*   **Detail:** Design mobile layout with CSS styles. Fetch today's manifest route list from `/api/driver/route/today`. Build standard HTML canvas signatures capture script binding both touch/mouse gestures to base64 export files.
*   **Verification:** Open app on a phone/browser emulator, draw on canvas signature line, and confirm submit button posts signature payload without errors.

---

## Phase 5: Saga Transaction Coordinator & WebSockets
*   **Goal:** Bind systems together with real-time updates and distributed transaction logging.
*   **Estimated Duration:** Days 21–24
*   **Dependency:** Phase 4 (UIs must be ready to receive WebSocket payloads).

### Step 5.1: WebSocket Live Event Dispatch
*   **Responsible Member:** **Member 4**
*   **Task:** Write Gateway WebSocket subscription handler using `ws`.
*   **Detail:** Listen to RabbitMQ event queues. On message receive, parse recipient identifiers (`client_id` or `driver_id`) and dispatch notification JSON via WebSockets.
*   **Verification:** Launch Client Web UI, trigger order update events, and verify instant toast popup appears.

### Step 5.2: Saga Transaction Tracker (distributed transaction monitoring)
*   **Responsible Member:** **Member 4 (with updates by Members 1, 2, 3)**
*   **Task:** Build Saga distributed transactions controller.
*   **Detail:** Create in-memory Saga state machine inside Gateway. Monitor queues to track individual service processing status. If ROS or WMS fails to process, trigger fallback events to warn the frontend of order transaction failures.
*   **Verification:** Force ROS/WMS processing to fail, confirm Gateway detects the mismatch, updates `transaction_logs` to failed, and alerts the UI.

---

## Phase 6: End-to-End Integration, Validation & Load Testing
*   **Goal:** Package the entire system, fix environment bugs, and verify compliance with assignment criteria.
*   **Estimated Duration:** Days 25–27
*   **Dependency:** Phases 1–5 must be complete.

### Step 6.1: Full Stack Docker Compose Integration
*   **Responsible Members:** **All Members**
*   **Task:** Spin up all containers simultaneously using `docker-compose up --build`.
*   **Detail:** Check container log streams to confirm correct start sequence. Ensure PostgreSQL database sets up seed records cleanly on mount.
*   **Verification:** Run `docker-compose ps` to verify all 7 services show `running` status.

### Step 6.2: E2E Scenario Flow Validation
*   **Responsible Members:** **All Members**
*   **Task:** Run through the complete business workflow:
    1. Log in as client `CLT001` on Client Portal.
    2. Place order. Verify in-flight transaction loader icon appears.
    3. Log in as driver `DRV001` on Driver App. Confirm new order stop appears dynamically in sequence.
    4. Move order along warehouse states.
    5. Mark order as delivered, draw signature, and submit.
    6. Confirm Client Portal updates to `delivered` status instantly without page reload.
*   **Verification:** Cross-check PostgreSQL logs to confirm database records are written correctly across all tables.

---

## Phase 7: Group Documentation & Screencast
*   **Goal:** Record the presentation, write diagrams, and package submission files.
*   **Estimated Duration:** Days 28–30 (Final Deadline: 20 August 2026)

### Step 7.1: Solution Documentation Compile
*   **Responsible Members:** **All Members**
*   **Task:** Compile the assignment report. Include conceptual and implementation architecture diagrams, detailed pattern descriptions (Saga, Adapter, Gateway, Pub-Sub), security measures, and alternative architectures.
*   **Verification:** Convert document to PDF format and check VLE upload constraints.

### Step 7.2: Presentation Video Capture
*   **Responsible Members:** **All Members**
*   **Task:** Record a ~10 minute voiced walkthrough. Show architecture designs, code implementation, and a live prototype demo.
*   **Verification:** Review output file size, format, and clear audio mix.

---

## 4. Phase-by-Phase Task Checklist Matrix

| Phase | Tasks | Primary Code Owner | Integration Overlap Partners |
|---|---|---|---|
| **Phase 1** | Postgres DB Schema, Docker Compose Setup, API Gateway Scaffold | **M6, M4** | M1, M3 (DB connection config) |
| **Phase 2** | CMS SOAP/REST Service, ROS Optimizer, WMS TCP Service | **M1, M2, M3** | M4 (API Contract validation) |
| **Phase 3** | Gateway SOAP client integration, TCP Socket client implementation | **M4** | M1 (SOAP), M3 (TCP payload layout) |
| **Phase 4** | Dashboard frontend design, Mobile manifest routing, Canvas pod | **M5, M6** | M4 (API endpoint compatibility) |
| **Phase 5** | Saga transaction monitoring, WebSocket messaging server | **M4** | M1, M2, M3 (RabbitMQ event format) |
| **Phase 6** | E2E integration test runs, Docker container cleanup, Bug fixes | **All Members** | Collaborative verification |
| **Phase 7** | Final PDF documentation assembly, Group narrated screencast | **All Members** | Collaborative review |
