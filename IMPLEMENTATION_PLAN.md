# SwiftTrack — Implementation Plan & Task List

Derived from a full audit of the codebase (see `README.md`, `ARCHITECTURE.md`).
Every task below is traceable to a specific, evidence-backed gap found during the audit.

---

## Definition of Done

1. `npm run lint` / `ruff check .` pass with zero warnings in every service.
2. A real automated test suite exists and passes (unit + integration + smoke), backing the
   README's Phase 6 claim.
3. The platform's core promise — **"no order ever lost even when a downstream service is
   temporarily unavailable"** — is enforced by code, not just asserted in prose.
4. `docker compose up --build` starts green and `scripts/smoke.sh` passes end-to-end.
5. README / ARCHITECTURE.md are updated to match reality.

---

## Priority Tiers

| Tier | Phases | Theme | Why |
|---|---|---|---|
| **P0 — Must** | 1, 2, 3, 4 | Tests, Saga reliability, messaging reliability, security | Fixes false claims + real correctness/security bugs |
| **P1 — Should** | 5, 6, 7 | Smarter ROS, live map, saga timeline UI | Highest demo value per unit effort |
| **P2 — Could** | 8, 9 | Offline-first driver PWA, scanning/warehouse | Completes the product story |
| **P3 — Polish** | 10 | Observability, OpenAPI, docs, CI | Production credibility |

---

# P0 — Must

## Phase 1 — Real test suite (closes the unbacked Phase 6 claim)

> Audit finding: README line 254 claims "Integration testing & load testing ✅ Complete",
> but there are **zero** `*.test.js` / `test_*.py` / k6 files in the repo.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **1.1** | Add lint tooling: ESLint (Node services) + Ruff (Python services) + `.editorconfig` | `api-gateway/eslint.config.js`, `ros-service/eslint.config.js`, `pyproject.toml`, `package.json` scripts | `npm run lint` and `ruff check .` both exit 0 |
| **1.2** | Gateway unit tests — `escapeXml`, `buildSoapEnvelope`, `findSoapResult`, `createAccessToken`, `authenticateToken`, `requireRole` | `api-gateway/test/*.test.js`, `api-gateway/package.json` (`test`, `devDeps: jest, supertest, nock`) | `npm test` green; malformed/expired/wrong-audience tokens all rejected |
| **1.3** | Gateway integration tests with mocked downstreams (`nock` for CMS/ROS, in-memory TCP server for WMS) | `api-gateway/test/integration.*.test.js` | Covers `POST /api/orders`, `GET /api/orders/:code`, package scan/status, `/api/saga/*`, 401/403 paths |
| **1.4** | WMS tests (pytest) — `assign_location`, `register_package` idempotency, `get_package`, `update_package_status` validation, TCP framing (`PING`/`REGISTER_PACKAGE`/`GET_PACKAGE`/`UPDATE_STATUS`) | `wms-service/test_*.py`, `wms-service/requirements-dev.txt` | `pytest` green; invalid status returns the allowed-set message |
| **1.5** | CMS tests (pytest) — `authenticate_client_payload`, `create_order_payload` (code sequencing), `get_client_orders_payload`, REST routes | `cms-service/test_*.py`, `cms-service/requirements-dev.txt` | `pytest` green; wrong password → `success:false` |
| **1.6** | ROS tests (jest) — `haversineKm`, `optimiseStops` ordering + `sequence` monotonicity, `databaseStopStatus` mapping, `POST /api/routes/optimize` | `ros-service/test/*.test.js`, `ros-service/package.json` | `npm test` green |
| **1.7** | End-to-end smoke script against the running stack | `scripts/smoke.sh` (+ `.ps1` for Windows) | Logs in as client & driver, creates an order, polls until `SAGA_TRANSACTION_SUCCESS`, scans the barcode, submits POD, asserts all statuses |
| **1.8** | Load test with k6 | `loadtest/k6-orders.js` | 60 VUs × 60 s on `POST /api/orders`; p95 < 1500 ms, error rate < 1 % |
| **1.9** | `docker compose` test profile so tests run in CI without host dependencies | `docker-compose.test.yml` | `docker compose -f docker-compose.test.yml up --build --exit-code-from tests` exits 0 |

**Phase 1 exit:** `npm test` in both Node services, `pytest` in both Python services, and `scripts/smoke.sh` all pass.

### Phase 1 result (2026-10-04)

| Suite | Count | Command |
|---|---|---|
| gateway unit + integration (jest) | 95 | `cd api-gateway && npm test` |
| ROS (jest) | 45 | `cd ros-service && npm test` |
| CMS (pytest) | 73 | `pytest cms-service` |
| WMS (pytest) | 53 | `pytest wms-service` |
| lint (eslint ×2 + ruff) | — | `./scripts/lint.sh` |
| **total** | **266** | `docker compose -f docker-compose.test.yml up --build --exit-code-from tests` → **0** |
| end-to-end smoke (HTTP + SOAP + TCP + WS) | 46 checks | `./scripts/smoke.sh` |

**Deliverables:** `scripts/lint.{sh,ps1}`, `scripts/smoke.{py,sh,ps1}`,
`scripts/test-all.sh`, `scripts/loadtest.{sh,ps1}`, `Dockerfile.test`,
`docker-compose.test.yml`, `loadtest/k6-orders.js`.

**1.8 — measured, not yet passing.** The k6 script runs and every request
succeeds at low concurrency, but the plan's target is missed:

| Profile | p95 | error rate |
|---|---|---|
| 5 VUs × 10 s | 1.96 s | 0 % |
| 60 VUs × 10 s (plan profile) | 6.50 s | 88 % |

Root cause, isolated by benchmarking each layer:

1. **CMS and WMS serve requests one at a time.** Both call
   `run_simple(...)` with Werkzeug's default `threaded=False`, so a single
   ~180 ms order creation caps throughput at ~5 req/s. At 60 VUs the queue
   grows past the gateway's `DOWNSTREAM_TIMEOUT_MS` (5000 ms) and the
   gateway answers **502** — visible as `Gateway adapter error: timeout of
   5000ms exceeded` in `docker logs swift-gateway`.
2. **Every request opens fresh connections.** `get_db_connection()` calls
   `psycopg2.connect()` per call (~76 ms) and `publish_order_created()`
   opens a new AMQP connection per order (~95 ms).

Fixing these belongs to a later phase (threaded/production WSGI server,
connection pooling, publish-after-commit). Until then task 1.8 stays ⚠️.

---

## Phase 2 — Saga reliability (makes the core promise true)

> Audit findings:
> - `executeSagaCompensation` is only reachable from `POST /api/saga/simulate-failure`
>   (`api-gateway/app.js:1026`). A genuine downstream 502 falls through to the generic
>   error handler (`app.js:1039`) — **no automatic compensation ever runs.**
> - `activeSagas` (`app.js:351`) is never rehydrated from `transaction_logs` on boot and
>   never evicted → unbounded memory growth, state lost on restart.
> - No timeout exists for a step that never completes.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **2.1** | Rehydrate `activeSagas` from `transaction_logs` at boot (replay steps per order, derive status) | `api-gateway/app.js`, new `api-gateway/saga-store.js` | Kill/restart gateway mid-saga → state restored, saga still completes |
| **2.2** | TTL eviction: completed/failed sagas leave memory after 15 min; max-size guard | `api-gateway/saga-store.js` | 10k simulated sagas → heap stable; `active_sagas` in `/api/saga/transactions` reflects only live sagas |
| **2.3** | Automatic compensation on downstream failure: map axios/TCP errors to the correct `failed_step` and call `executeSagaCompensation` | `api-gateway/app.js` (error handler + route wrappers) | Stop the `ros-service` container → creating an order ends in `SAGA_COMPENSATED` + order `status='failed'`, not a bare 502 |
| **2.4** | Saga timeout watchdog (default 45 s, env `SAGA_STEP_TIMEOUT_MS`) → compensate on stall | `api-gateway/saga-store.js` | Publish only `ORDER_CREATED` → watchdog fires, logs `SAGA_COMPENSATION` with `reason='timeout'` |
| **2.5** | Transient-failure retry with exponential backoff (3 attempts) before compensating | `api-gateway/downstream.js` | Flaky downstream (1/3 failures) → order still succeeds |
| **2.6** | Idempotent saga logging — unique `(order_id, saga_step, attempt)` guard so replays don't duplicate rows | `database/init.sql` (migration), `api-gateway/saga-store.js` | Replaying the same event twice → one `CMS_CREATE` row |
| **2.7** | Compensate ROS + WMS side effects, not just `orders.status` (release route stop, mark package `cancelled`) | `api-gateway/saga-store.js`, `wms-service/app.py`, `ros-service/app.js` | After compensation, `route_stops.stop_status='skipped'` and package status reflects cancellation |

**Phase 2 exit:** `scripts/failure-drill.sh` (new) stops each backend in turn and proves every path terminates in either `SAGA_TRANSACTION_SUCCESS` or `SAGA_COMPENSATED` — never a lost order.

---

## Phase 3 — Messaging reliability

> Audit finding: all three RabbitMQ consumers call `nack(msg, false, false)` on error
> (`api-gateway/app.js:534`, `ros-service/app.js:357`, `wms-service/app.py:375`), which
> **discards the message permanently**. Any transient DB/broker blip loses an event.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **3.1** | Declare a DLX + `*.dlq` queue per exchange; route nacked/poisoned messages there instead of dropping | `api-gateway/app.js`, `ros-service/app.js`, `wms-service/app.py`, `cms-service/app.py` | Kill Postgres for 10 s during order creation → message lands in DLQ, not lost |
| **3.2** | Retry queue with TTL + dead-letter re-entry (2 retries with backoff) before DLQ | same as 3.1 | Transient failure retried twice then quarantined with `x-death` headers intact |
| **3.3** | Idempotent consumers — dedup on `(event_type, order_code)` so a redelivery can't double-register a package | new `database/init.sql` table `processed_events`, all 3 consumers | Re-publish the same `ORDER_CREATED` → still exactly one package row |
| **3.4** | Publish-only-after-commit in CMS (`create_order_payload`) so an event never references a rolled-back order | `cms-service/app.py` | Force a DB error after INSERT → no `ORDER_CREATED` published |
| **3.5** | Structured consumer logging with correlation ID (order_code) | all services | Every log line for an order carries the same `order_code` |

---

## Phase 4 — Security hardening

> Audit findings: driver auth bypasses the DB (`api-gateway/app.js:38` hardcoded
> `demoDrivers` while `drivers.password_hash` sits unused); `cors()` is wide open
> (`app.js:53`); no helmet/rate limiting/refresh tokens; JWT secret committed in
> `.env.example`; **WS registration frames are unauthenticated** — any socket can claim
> `{type:'register_client', client_id:'CLT001'}` (`app.js:160`) and receive another
> client's order events.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **4.1** | Driver login against Postgres with bcrypt; delete `demoDrivers` Map | `api-gateway/app.js` | `kasun@swiftlogistics.lk` / `password123` still works; wrong password rejected; map gone |
| **4.2** | Authenticate WS registration: require a JWT in the register frame, verify, and only register the `sub` it authorises | `api-gateway/app.js`, `client-portal/app.js`, `driver-app/app.js` | Registering `CLT002` while holding a `CLT001` token → rejected; cross-client event leakage impossible |
| **4.3** | Helmet + CORS allowlist (`CLIENT_PORTAL_ORIGIN`, `DRIVER_APP_ORIGIN`) + `express-rate-limit` (10 req/min on login, 100/min global) | `api-gateway/app.js`, `docker-compose.yml`, `.env.example` | `curl -H "Origin: https://evil.test"` → no `Access-Control-Allow-Origin` |
| **4.4** | Refresh-token rotation with `jti` + server-side revocation; logout endpoint | `api-gateway/auth.js`, `POST /api/auth/logout` | Replayed refresh token → 401; logout invalidates immediately |
| **4.5** | Remove committed secrets; `.env.example` gets placeholders only + generation instructions | `.env.example`, `docker-compose.yml` | `git grep 'swiftlogistics-secret-key-2026'` returns nothing in tracked files |
| **4.6** | Internal service auth: shared-secret header (`X-Internal-Token`) on CMS REST, ROS REST, WMS REST/TCP | all 4 services | Direct `curl localhost:8002/api/routes` without header → 401 |
| **4.7** | Stop publishing WMS `:9000`/`:8003`, CMS `:8001`, ROS `:8002` to the host (keep internal network only) | `docker-compose.yml` | Ports closed on host; gateway unaffected |

**Phase 4 exit:** `scripts/security-check.sh` passes — token tampering, WS impersonation, CORS, rate limiting, and internal-port exposure all verified.

---

# P1 — Should

## Phase 5 — Smarter route optimisation

> Audit finding: ROS hardcodes **every** order to `DRV001` (`ros-service/app.js:250`),
> ignores `capacity_kg`, and uses a fixed 30-minute slot per stop
> (`app.js:106`) regardless of distance.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **5.1** | Multi-driver assignment: pick vehicle by free capacity + fewest assigned stops (round-robin tie-break) | `ros-service/app.js` | 15 orders across 2 drivers → both get stops, none exceed `capacity_kg` |
| **5.2** | Load vehicles/drivers from the `drivers` table instead of the hardcoded array | `ros-service/app.js` | Adding a driver row makes them assignable without a code change |
| **5.3** | 2-opt improvement pass after nearest-neighbour | `ros-service/app.js` | Total route distance ≤ nearest-neighbour baseline on the seeded dataset |
| **5.4** | Realistic ETA: cumulative distance ÷ average speed + 5 min service time per stop | `ros-service/app.js` | ETAs are monotonically increasing and scale with distance |
| **5.5** | Re-optimise on demand endpoint `POST /api/routes/:driverCode/reoptimise`, broadcast `ROUTE_UPDATED` | `ros-service/app.js`, `api-gateway/app.js` | Adding an order mid-day re-sequences the route and pushes to the driver |

---

## Phase 6 — Live map & vehicle tracking

> Audit finding: **no geolocation anywhere** — no `navigator.geolocation`, no
> `driver_positions`, no map component. The driver app only deep-links to Google Maps
> (`driver-app/app.js:220`) and the "Route synchronized" chip (`index.html:142`) is
> static markup never touched by JS.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **6.1** | `driver_positions` table (driver_id, lat, lng, heading, speed, recorded_at) + `POST /api/driver/location` | `database/init.sql`, `api-gateway/app.js`, `ros-service/app.js` | Ping persists; upsert per driver |
| **6.2** | Driver app: `watchPosition` (10 s / 25 m), throttled upload, battery-aware | `driver-app/app.js` | Position rows appear while driving; works offline → queued (see 8.1) |
| **6.3** | Gateway broadcasts `DRIVER_LOCATION` over WS to the owning client + all drivers | `api-gateway/app.js` | Client portal marker moves live |
| **6.4** | Client portal: Leaflet map, order route polyline, live driver marker, stop markers coloured by status | `client-portal/index.html`, `app.js`, `styles.css`, CDN Leaflet | Map renders pickup→delivery polyline + moving marker |
| **6.5** | Driver portal: Leaflet map of today's route with completed/pending stops | `driver-app/*` | Map matches the stop list; tapping a stop focuses it |
| **6.6** | Mark "Route synchronized" chip live from last successful ping + WS state | `driver-app/index.html:142`, `app.js` | Chip turns amber when stale > 60 s |

---

## Phase 7 — Saga timeline UI + portal depth

> Audit finding: the client portal exposes saga data only as one opaque "Transaction"
> text field (`client-portal/app.js:120`). `GET /api/saga/transactions/:orderCode`
> already returns full step history — **there is no UI for it.** Also: no pagination,
> no order cancel, no URL routing.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **7.1** | Order detail drawer with step timeline: `CMS_CREATE → ROS_ASSIGN → WMS_ALLOCATE → SAGA_COMPLETE` (+ `failed`/`compensated` state) | `client-portal/index.html`, `app.js`, `styles.css` | Timeline renders from `/api/saga/transactions/:code`; compensation shows red with reason |
| **7.2** | Per-order event history from WS (replace global capped feed), with unread badge scoped to open order | `client-portal/app.js` | Events for other orders don't pollute the open order's history |
| **7.3** | Orders list: server-side pagination + status filter + sort | `api-gateway/app.js`, `cms-service/app.js`, `client-portal/app.js` | 500 orders → page 1 loads fast, filter works |
| **7.4** | Order cancel endpoint + UI (only while `pending`), publishes `ORDER_CANCELLED`, compensates ROS/WMS | `api-gateway/app.js`, portals | Cancel a pending order → route stop and package released |
| **7.5** | Hash-based URL routing (`#/orders`, `#/new`, `#/updates`) so nav + browser back work; fix dead `data-view` attributes | `client-portal/app.js` | Refresh preserves view; back button works |
| **7.6** | Order creation: drop redundant `weight`/`weight_kg` duplication, add validation + inline errors | `client-portal/app.js`, `api-gateway/app.js` | Weight ≤ 0 → clear client-side error, no SOAP call |

---

# P2 — Could

## Phase 8 — Offline-first driver PWA & rich proof of delivery

> Audit findings: `sw.js:51-61` returns a 503 JSON body offline, so **a delivery
> submitted offline fails outright** — typed notes, recipient name, and the signature
> data-URL are lost (no IndexedDB, no Background Sync). `sw.js:79` labels the push
> handler "future server-push support" and `pushManager.subscribe()` is never called.
> `manifest.json:31` points at `/?view=route`, which `app.js` never reads (dead shortcut).
> Progress % counts failed stops as complete (`app.js:200`). Schema has `photo_base64`
> (`init.sql:137`) that is never written.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **8.1** | IndexedDB queue for POD submissions + Background Sync flush | `driver-app/app.js`, `sw.js` | Airplane mode → submit POD → reconnect → auto-syncs, nothing lost |
| **8.2** | Queue order edits/stop updates offline the same way | `driver-app/app.js`, `sw.js` | Offline stop status change syncs on reconnect |
| **8.3** | Real Web Push: VAPID keys, subscription endpoint, server-side `web-push` fanout on `ROUTE_UPDATED` | `api-gateway/`, `driver-app/sw.js`, `docker-compose.yml` | Notification arrives **with the tab closed** |
| **8.4** | Fix dead PWA shortcut (`/?view=route`) — honour query params in `app.js` | `driver-app/app.js` | Tapping the shortcut opens the route view |
| **8.5** | Fix progress ring: exclude `failed` from completed count | `driver-app/app.js:200` | 2 done + 1 failed of 4 → 50 %, not 75 % |
| **8.6** | Camera photo proof → `photo_base64` (capture + upload + display in client portal) | `driver-app/*`, `api-gateway/app.js`, `cms-service/app.py` | Photo stored and visible on the order detail |

---

## Phase 9 — Barcode scanning & warehouse visibility

> Audit finding: `GET /api/packages/scan/:barcode` exists but **nothing calls it** —
> there is no camera/`BarcodeDetector` anywhere in `driver-app/`.

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **9.1** | Barcode scanning via `BarcodeDetector` with `<input type=file capture>` fallback | `driver-app/app.js`, `index.html` | Scan `BC-ORD-0001` → package found → status update flow |
| **9.2** | Warehouse admin view: bin occupancy heatmap, package list, status bulk-update | `client-portal/` or new `warehouse-portal/` | Zone/bin grid shows occupancy; bulk update calls `/api/packages/status` |
| **9.3** | Expose `/api/warehouse/locations` with real occupancy counts | `wms-service/app.py` | Occupancy reflects actual `packages` rows |
| **9.4** | Picking/packing workflow: `stored → picked → loaded → dispatched` progression enforced | `wms-service/app.py`, driver app | Illegal status jumps rejected with a clear message |

---

# P3 — Polish

## Phase 10 — Observability, docs & CI

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| **10.1** | Correlation ID (`X-Request-Id`) generated at gateway, propagated to all downstream calls and log lines | all services | One ID traces a request across gateway → CMS → ROS → WMS |
| **10.2** | `/metrics` (Prometheus) on gateway: request latency histogram, saga success/compensation counters, WS gauge | `api-gateway/` | `curl :3000/metrics` returns valid exposition format |
| **10.3** | OpenAPI 3 spec served at `/docs` from the gateway | `api-gateway/openapi.yaml`, swagger-ui | Spec covers every documented route; validates |
| **10.4** | Health endpoints report real dependency state (all services currently return static `{status:'ok'}`) | all 4 services | Stop Postgres → `cms-service/health` reports degraded |
| **10.5** | GitHub Actions CI: lint → unit tests → `docker compose` smoke | `.github/workflows/ci.yml` | Green badge on the repo |
| **10.6** | Update README (accurate status table, remove unbacked claims) + ARCHITECTURE.md (new patterns: DLQ, watchdog, refresh rotation) | `README.md`, `ARCHITECTURE.md` | Every claim in README is verifiable by a command |
| **10.7** | Fix mojibake in `driver-app/nginx.conf` comments + `docker-compose.yml` commented port block | those files | Files are clean UTF-8 |

---

## Task Tracker

Legend: `⬜` not started · `🔵` in progress · `✅` done · `⚠️` delivered, but its
acceptance criterion is **not yet met** · `⏭️` deferred

### P0
| ID | Task | Status |
|---|---|---|
| 1.1 | Lint tooling (ESLint + Ruff) | ✅ |
| 1.2 | Gateway unit tests | ✅ |
| 1.3 | Gateway integration tests (mocked downstreams) | ✅ |
| 1.4 | WMS pytest suite | ✅ |
| 1.5 | CMS pytest suite | ✅ |
| 1.6 | ROS jest suite | ✅ |
| 1.7 | E2E smoke script | ✅ |
| 1.8 | k6 load test | ⚠️ |
| 1.9 | Docker test profile for CI | ✅ |
| 2.1 | Rehydrate `activeSagas` from `transaction_logs` | ⬜ |
| 2.2 | TTL eviction / memory guard | ⬜ |
| 2.3 | Automatic compensation on downstream failure | ⬜ |
| 2.4 | Saga timeout watchdog | ⬜ |
| 2.5 | Downstream retry with backoff | ⬜ |
| 2.6 | Idempotent saga logging | ⬜ |
| 2.7 | Compensate ROS/WMS side effects | ⬜ |
| 3.1 | Dead-letter queues | ⬜ |
| 3.2 | Retry queue with backoff | ⬜ |
| 3.3 | Idempotent consumers (dedup table) | ⬜ |
| 3.4 | Publish-after-commit in CMS | ⬜ |
| 3.5 | Correlation ID in consumer logs | ⬜ |
| 4.1 | Driver auth from DB | ⬜ |
| 4.2 | Authenticated WS registration | ⬜ |
| 4.3 | Helmet + CORS allowlist + rate limiting | ⬜ |
| 4.4 | Refresh-token rotation + logout | ⬜ |
| 4.5 | Purge committed secrets | ⬜ |
| 4.6 | Internal service shared-secret auth | ⬜ |
| 4.7 | Internal ports not host-exposed | ⬜ |

### P1
| ID | Task | Status |
|---|---|---|
| 5.1 | Multi-driver assignment by capacity | ⬜ |
| 5.2 | Vehicles loaded from DB | ⬜ |
| 5.3 | 2-opt improvement pass | ⬜ |
| 5.4 | Distance-based ETA model | ⬜ |
| 5.5 | On-demand re-optimise + broadcast | ⬜ |
| 6.1 | `driver_positions` schema + endpoint | ⬜ |
| 6.2 | Driver GPS tracking upload | ⬜ |
| 6.3 | `DRIVER_LOCATION` WS broadcast | ⬜ |
| 6.4 | Client portal Leaflet map | ⬜ |
| 6.5 | Driver portal Leaflet map | ⬜ |
| 6.6 | Live "Route synchronized" chip | ⬜ |
| 7.1 | Saga timeline UI | ⬜ |
| 7.2 | Per-order event history | ⬜ |
| 7.3 | Pagination + filters | ⬜ |
| 7.4 | Order cancel + compensation | ⬜ |
| 7.5 | Hash routing + `data-view` fix | ⬜ |
| 7.6 | Order form validation cleanup | ⬜ |

### P2
| ID | Task | Status |
|---|---|---|
| 8.1 | IndexedDB POD queue + Background Sync | ⬜ |
| 8.2 | Offline stop-update queue | ⬜ |
| 8.3 | Real Web Push (VAPID) | ⬜ |
| 8.4 | Fix dead PWA shortcut | ⬜ |
| 8.5 | Fix progress ring math | ⬜ |
| 8.6 | Camera photo proof | ⬜ |
| 9.1 | Barcode scanning | ⬜ |
| 9.2 | Warehouse admin view | ⬜ |
| 9.3 | Real occupancy counts | ⬜ |
| 9.4 | Picking/packing state machine | ⬜ |

### P3
| ID | Task | Status |
|---|---|---|
| 10.1 | Correlation IDs across services | ⬜ |
| 10.2 | Prometheus `/metrics` | ⬜ |
| 10.3 | OpenAPI + `/docs` | ⬜ |
| 10.4 | Real dependency health checks | ⬜ |
| 10.5 | GitHub Actions CI | ⬜ |
| 10.6 | Honest README / ARCHITECTURE update | ⬜ |
| 10.7 | Encoding cleanup | ⬜ |

---

## Suggested execution order

```
Week 1  ─ 1.1 → 1.2 → 1.4 → 1.5 → 1.6   (tooling + unit tests, safety net first)
Week 2  ─ 1.3 → 1.7 → 1.9 → 1.8          (integration + E2E + load)
Week 3  ─ 2.1 → 2.3 → 2.4 → 2.2 → 2.5 → 2.6 → 2.7   (Saga correctness)
Week 4  ─ 3.1 → 3.3 → 3.2 → 3.4 → 3.5    (messaging)  +  4.1 → 4.2 → 4.3  (security core)
Week 5  ─ 4.4 → 4.5 → 4.6 → 4.7          (security rest) + 5.x (ROS)
Week 6  ─ 6.x → 7.x                       (map + timeline — the demo highlights)
```

## Verification commands

```bash
# Lint / unit tests
npm run lint --prefix api-gateway && npm test --prefix api-gateway
npm run lint --prefix ros-service  && npm test --prefix ros-service
ruff check cms-service wms-service
pytest cms-service wms-service

# Full stack + smoke
docker compose up --build -d
./scripts/smoke.sh
./scripts/failure-drill.sh     # Phase 2 deliverable
./scripts/security-check.sh    # Phase 4 deliverable

# Load
k6 run loadtest/k6-orders.js
```
