# SwiftTrack — Tasks List

## Phase 1: Environment & Base Infrastructure Setup (Days 1–3)
- [x] Setup shared PostgreSQL database schema & bcrypt seed accounts (`database/init.sql`) - **Member 6**
- [x] Set up Docker Compose configuration skeleton with bridge networks and service definitions (`docker-compose.yml`) - **Member 6**
- [ ] Bootstrap Node.js Express server with health checking routes (`api-gateway/app.js`) - **Member 4**

## Phase 2: Core Mock Services Development (Days 4–10)
- [ ] Develop CMS SOAP + REST API flask app with Spyne and PostgreSQL connectors (`cms-service/app.py`) - **Member 1**
- [ ] Write logic to publish `ORDER_CREATED` RabbitMQ message in CMS service - **Member 1**
- [ ] Implement ROS Node.js optimization service with Haversine greedy nearest-neighbor algorithm (`ros-service/app.js`) - **Member 2**
- [ ] Implement RabbitMQ event consumer in ROS to add route stops and trigger optimization - **Member 2**
- [ ] Build WMS Python TCP Socket Server (Port 9000) with concurrent threads (`wms-service/app.py`) - **Member 3**
- [ ] Build WMS REST endpoints & RabbitMQ event consumer to auto-allocate packages in postgres - **Member 3**

## Phase 3: Middleware Integration & Gateway Logic (Days 11–15)
- [ ] Implement Gateway REST-to-SOAP translation adapter logic for CMS - **Member 4**
- [ ] Implement Gateway REST-to-TCP socket bridge logic (Port 9000 client connection) for WMS - **Member 4**
- [ ] Implement Gateway JWT Token authentication and authorization middleware - **Member 4**

## Phase 4: Frontend Development (Days 16–20)
- [x] Design and code Client Web Portal UI (Dashboard & Orders intake panel) - **Member 5**
- [x] Setup Nginx server configuration for Client Portal resource routing - **Member 5**
- [ ] Develop Driver Mobile App manifest stop list view - **Member 6**
- [ ] Write HTML Canvas script to capture handwritten signature PODs - **Member 6**

## Phase 5: Saga Transaction Coordinator & WebSockets (Days 21–24)
- [ ] Program Gateway WebSocket server logic to manage active client/driver communication maps - **Member 4**
- [ ] Code Saga transaction tracking engine in Gateway to record distributed transaction logs - **Member 4**
- [ ] Setup RabbitMQ event consumers in Gateway to trigger live WebSocket notifications - **Member 4**

## Phase 6: Integration, Testing & Bug Fixing (Days 25–27)
- [ ] Execute full system container build with Docker Compose - **All Members**
- [ ] Validate complete end-to-end order flow (Create -> Warehouse processing -> Driver signature -> Complete) - **All Members**
- [ ] Implement and test fallback/compensation triggers for transaction errors - **All Members**

## Phase 7: Documentation & Screencast Presentation (Days 28–30)
- [ ] Draft group architecture design and pattern justifications PDF documentation - **All Members**
- [ ] Record narrated video demonstrating working code prototypes - **All Members**
