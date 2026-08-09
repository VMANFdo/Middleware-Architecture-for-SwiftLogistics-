# SwiftTrack - Middleware Architecture for "SwiftLogistics"

A prototype middleware platform that integrates three heterogeneous backend
systems.

## 1. Business Scenario

Swift Logistics needs to bridge three systems that speak different
protocols:

| System | Role | Protocol |
|---|---|---|
| **CMS** - Client Management System | Legacy on-prem system: client contracts, billing, order intake | SOAP / XML |
| **ROS** - Route Optimisation System | Third-party cloud service: generates efficient delivery routes | REST / JSON |
| **WMS** - Warehouse Management System | Tracks packages from receipt to dispatch | Proprietary TCP/IP messaging |

SwiftTrack sits in front of all three and gives clients a web portal and
drivers a mobile app, with real-time order tracking and no order ever lost
even if a backend system is temporarily down.

## 2. Architecture Overview

```
                     ┌─────────────────┐          ┌──────────────────┐
                     │  Client Portal  │          │   Driver App     │
                     │     :8080       │          │     :8081        │
                     └────────┬────────┘          └─────────┬────────┘
                              │            HTTP + WebSocket │
                              └──────────────┬──────────────┘
                                             ▼
                                   ┌─────────────────────┐
                                   │    API Gateway:3000 │
                                   │ REST↔SOAP/REST↔TCP  │
                                   │  Saga Coordinator   │
                                   │  WebSocket Dispatch │
                                   └───┬───────┬───────┬─┘
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
                                   ▼          publish/subscribe     ▼
                          ┌───────────────────────────────────────────┐
                          │              RabbitMQ (:5672)             │
                          │           exchange: order_events          │
                          └───────────────────────────────────────────┘
                                              │
                                              ▼
                                   ┌─────────────────────┐
                                   │     PostgreSQL      │
                                   │        :5432        │
                                   └─────────────────────┘
```

**Integration patterns used:** Gateway, Channel Adapter (SOAP/TCP↔REST),
Publish-Subscribe, Saga (distributed transaction), Canonical Data Model.
Full rationale is in [`system-plan.md`](./system-plan.md) and the solution
documentation.

## 3. Project Structure

```
Middleware-Architecture-for-SwiftLogistics-/
│
├── database/
│   └── init.sql                # Schema + seed data (Phase 1)
│
├── api-gateway/                 # Central gateway (Phase 1 scaffold → Phase 3/5)
│   ├── app.js
│   ├── package.json
│   └── Dockerfile
│
├── cms-service/                 # SOAP/REST hybrid, Flask + Spyne (Phase 2 - M1)
├── ros-service/                 # Route optimiser, Node Express (Phase 2 - M2)
├── wms-service/                 # TCP socket server, Flask (Phase 2 - M3)
├── client-portal/                # Web dashboard (Phase 4 - M5)
├── driver-app/                  # Driver mobile UI (Phase 4 - M6)
│
├── docker-compose.yml           # Orchestrates all 7 services
├── MA-Assignment-4-2026.pdf     # Original assignment brief
├── system-plan.md               # Phase-by-phase implementation plan
├── implementation_plan.md
├── task-list.md
└── work-distribution.md
```

## 4. Getting Started

### Prerequisites
- Docker Desktop
- Node.js 20+ (for local, non-container development)
- Git

Set up Docker. \
See [`DOCKER-SETUP.md`](./plans/DOCKER-SETUP.md) for full install instructions (Windows + Ubuntu) and troubleshooting.

### Run infrastructure + gateway

```bash
git clone https://github.com/VMANFdo/Middleware-Architecture-for-SwiftLogistics-.git
cd Middleware-Architecture-for-SwiftLogistics-

# Bring up database, broker, and the gateway
docker compose up -d postgres rabbitmq api-gateway
```

Check everything is healthy:

```bash
docker compose ps
curl http://localhost:3000/health
```

Once teammates' services (`cms-service`, `ros-service`, `wms-service`,
`client-portal`, `driver-app`) land in their respective folders, bring up
the full stack:

```bash
docker compose up --build
```

## 5. Service Port Map

| Port | Service | Protocol |
|---|---|---|
| 3000 | API Gateway | HTTP + WebSocket |
| 5432 | PostgreSQL | Postgres |
| 5672 / 15672 | RabbitMQ (AMQP / Management UI) | AMQP / HTTP |
| 8001 | CMS Service | SOAP + REST |
| 8002 | ROS Service | REST |
| 8003 / 9000 | WMS Service (REST / proprietary TCP) | REST / TCP |
| 8080 | Client Portal | HTTP |
| 8081 | Driver App | HTTP |

## 6. Technology Stack

| Layer | Technology |
|---|---|
| API Gateway | Node.js, Express |
| CMS Service | Python, Flask, Spyne (SOAP) |
| ROS Service | Node.js, Express |
| WMS Service | Python, Flask, raw TCP sockets |
| Message Broker | RabbitMQ |
| Database | PostgreSQL |
| Real-time | WebSockets |
| Orchestration | Docker Compose |

## 7. Team & Progress

| Phase | Scope | Owner(s) | Status |
|---|---|---|---|
| 1 | DB schema, Docker Compose, Gateway scaffold | - |  Complete |
| 2 | CMS / ROS / WMS mock services | M1 / M2 / M3 |  Not started |
| 3 | Gateway protocol bridging (SOAP, TCP) | M4 |  Not started |
| 4 | Frontend (Client Portal, Driver App) | M5 / M6 |  Not started |
| 5 | Saga coordinator, WebSocket dispatch | M4 |  Not started |
| 6 | Integration & load testing | All |  Not started |
| 7 | Documentation & screencast | All |  Not started |


## 8. Documentation

- [`DOCKER-SETUP.md`](./plans/DOCKER-SETUP.md) - Docker install + troubleshooting guide (Windows/Ubuntu)
- [`system-plan.md`](./plans/system-plan.md) - phase-by-phase implementation plan
- [`implementation_plan.md`](./plans/implementation_plan.md)
- [`task-list.md`](./plans/task-list.md)
- [`work-distribution.md`](./plans/work-distribution.md)
- [`MA-Assignment-4-2026.pdf`](./plans/MA-Assignment-4-2026.pdf) - original brief
