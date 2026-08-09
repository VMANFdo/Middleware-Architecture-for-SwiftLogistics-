# Docker Setup Guide - SwiftTrack

How to install Docker and run this project's Phase 1 stack (Postgres,
RabbitMQ, API Gateway) on **Windows** or **Ubuntu**.\
See [`README.md`](./README.md) for the overall architecture; this file is just
the "get it running on your machine" guide.

---

## 1. Install Docker

### Windows

1. Download **Docker Desktop** from https://www.docker.com/products/docker-desktop/
2. During install, keep **"Use WSL 2 instead of Hyper-V"** checked (default on modern Windows 10/11).
3. Restart your machine if prompted.
4. Launch Docker Desktop and wait for the whale icon in the system tray to stop animating - that means the engine is running.
5. Verify in PowerShell:
   ```powershell
   docker --version
   docker compose version
   ```

### Ubuntu

Don't use the `docker.io` package from the default Ubuntu repos - it's often outdated. \
Use Docker's official repo instead:

```bash
# Remove any old versions first
sudo apt-get remove docker docker-engine docker.io containerd runc

# Set up Docker's official repo
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update

# Install Docker Engine + Compose plugin
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**Important - avoid needing `sudo` for every command:**

```bash
sudo usermod -aG docker $USER
```

Then **log out and back in** (or reboot) for the group change to apply. After that, plain `docker ...` and `docker compose ...` work without `sudo`. \
If you skip this step, every command in this guide needs `sudo` in front of it, which is easy to forget half the time and causes confusing permission errors.

Verify:
```bash
docker --version
docker compose version
docker run hello-world
```

---

## 2. Clone and Run the Project

```bash
git clone https://github.com/VMANFdo/Middleware-Architecture-for-SwiftLogistics-.git
cd Middleware-Architecture-for-SwiftLogistics-
```

**Start only what exists so far (Phase 1):**

```bash
docker compose up -d postgres rabbitmq api-gateway
```

**Don't run `docker compose up -d` with no service names** until every teammate's service folder (`cms-service/`, `ros-service/`, `wms-service/`, `client-portal/`, `driver-app/`) has a real `Dockerfile` in it. \
Compose will try to build *all* services listed in `docker-compose.yml`, and fail on any folder that doesn't have one yet with an error like:
```
failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory
```
Always name the specific services you want until Phase 2/4 land:
```bash
docker compose up -d postgres rabbitmq api-gateway
```

**Check everything is healthy:**
```bash
docker compose ps
curl http://localhost:3000/health
```

---

## 3. Everyday Commands

| Task | Command |
|---|---|
| Start (specific services) | `docker compose up -d postgres rabbitmq api-gateway` |
| Stop (keep data) | `docker compose down` |
| Stop and **wipe all data** | `docker compose down -v` |
| View running containers | `docker compose ps` |
| View logs (all) | `docker compose logs -f` |
| View logs (one service) | `docker compose logs -f api-gateway` |
| Rebuild after code changes | `docker compose up -d --build api-gateway` |
| Restart one service | `docker compose restart api-gateway` |
| View logs for one container directly | `docker logs swift-postgres` / `docker logs swift-rabbitmq` |
| Remove and rebuild everything | `docker compose down && docker compose up -d --build postgres rabbitmq api-gateway` |
| Connect to Postgres | `docker exec -it swift-postgres psql -U swift_admin -d swifttrack` |

Inside `psql`:
```sql
\dt                              -- list tables
\d clients                       -- describe a table
SELECT * FROM clients;
SELECT COUNT(*) FROM orders;     -- count records
\q                               -- quit
```

**Note on command syntax:** this guide uses `docker compose` (with a space) - the modern Compose V2 plugin bundled with current Docker installs. If you're on an older setup, you might have `docker-compose` (hyphenated) instead. Both do the same thing; just use whichever one `docker compose version` / `docker-compose version` confirms you actually have.

---

## 4. Service Port Map & Access

| Port | Service | Purpose |
|---|---|---|
| 3000 | API Gateway | HTTP + WebSocket |
| 5432 | PostgreSQL | Database connections |
| 5672 | RabbitMQ | AMQP application port |
| 15672 | RabbitMQ | Management UI |

**PostgreSQL**
- Host: `localhost` · Port: `5432` · Database: `swifttrack`
- Username: `swift_admin` · Password: `swift_pw_dev_only`

**RabbitMQ**
- Management UI: http://localhost:15672
- Username: `swift_admin` · Password: `swift_pw_dev_only`

---

## 5. What's Running (Phase 1)

```
┌─────────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐
│   PostgreSQL Container  │   │   RabbitMQ Container    │   │   API Gateway Container │
│                         │   │                         │   │                         │
│   Database Server       │   │   AMQP Server           │   │   Express (Node.js)     │
│   Port 5432             │   │   Port 5672             │   │   Port 3000             │
│                         │   │                         │   │                         │
│   DB: swifttrack        │   │   Management UI         │   │   /health endpoint      │
│   8 tables (clients,    │   │   Port 15672            │   │   (protocol bridging +  │
│   drivers, orders,      │   │                         │   │   Saga coordinator land │
│   packages, routes,     │   │                         │   │   in later phases)      │
│   route_stops,          │   │                         │   │                         │
│   delivery_proofs,      │   │                         │   │                         │
│   transaction_logs)     │   │                         │   │                         │
│                         │   │                         │   │                         │
│   Volume: pgdata        │   │(no persistent volume    │   │   (stateless)           │
│                         │   │ yet - add one if needed │   │                         │
│                         │   │ for Phase 2 durability) │   │                         │
└─────────────────────────┘   └─────────────────────────┘   └─────────────────────────┘
```

---

## 6. Troubleshooting

**`role "swift_admin" does not exist` / `role "postgres" does not exist`**
Postgres only applies `POSTGRES_USER`/`POSTGRES_DB` env vars and runs `init.sql` the *first* time it initializes an empty data volume. If a Postgres container ran here before (even with different settings), the volume already has old data and skips re-init. Fix:
```bash
docker compose down -v
docker compose up -d postgres rabbitmq api-gateway
```
`-v` removes the volume so Postgres genuinely starts fresh. Always double-check which role/db you're connecting with - this project uses `swift_admin` / `swifttrack`, not the Postgres defaults.

**`Bind for 0.0.0.0:5432 failed: port is already allocated`**
Something else on your machine is already using port 5432 - commonly a locally installed Postgres service, or a leftover container from an earlier run. Find and stop it:
```bash
sudo lsof -i :5432          # Ubuntu - see what's using the port
docker ps                   # check for other running containers
docker stop <container-id>  # stop the conflicting one
```

**`failed to read dockerfile: open Dockerfile: no such file or directory`**
Either a service's Dockerfile genuinely doesn't exist yet (see the warning in Section 2 - name your services explicitly), or the Dockerfile exists but isn't in the right folder, or it was accidentally saved with a `.txt` extension. Check with:
```bash
ls -la api-gateway/     # or ros-service/, cms-service/, etc.
```
It must be named exactly `Dockerfile`, no extension, sitting directly inside the service's own folder (matching the `context:` path in `docker-compose.yml`).

**Permission denied on Ubuntu (`Cannot connect to the Docker daemon`)**
You either need `sudo` in front of every command, or (better, one-time fix) run `sudo usermod -aG docker $USER` and then fully log out and back in.

**Container name conflict (`The container name "/swift-postgres" is already in use`)**
A stopped container with that name already exists. Remove it before retrying:
```bash
docker rm -f swift-postgres
```
Or just use `docker compose down` first, which removes all of this project's containers cleanly.

---

## 6. Learning Notes

**What is Alpine?**
`postgres:16-alpine`, `rabbitmq:3-management-alpine`, and `node:20-alpine` all use Alpine Linux as their base - a minimal distro (~5MB vs ~100MB+ for standard Debian/Ubuntu-based images). Same functionality, much smaller images, faster pulls and builds.

**What are volumes?**
```yaml
volumes:
  - pgdata:/var/lib/postgresql/data
```
A named volume like `pgdata` persists data *outside* the container's filesystem. This means your seed data and any orders/records added later survive `docker compose down`, container restarts, and even rebuilding the image - the data only disappears if you explicitly run `docker compose down -v`.

**What is a healthcheck?**
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U swift_admin -d swifttrack"]
  interval: 5s
  timeout: 5s
  retries: 10
```
Docker periodically runs this test inside the container to confirm the service is actually ready to accept connections - not just that the process started. Other services can use `depends_on: condition: service_healthy` to wait for this before starting, which is why `api-gateway` won't try to connect to Postgres before Postgres is truly ready.

---

## 7. Quick Start Checklist

1. Install Docker (Section 1) and confirm `docker --version` works
2. Clone the repo and `cd` into it
3. Run `docker compose up -d postgres rabbitmq api-gateway`
4. Confirm with `docker compose ps` - all three should show `Up` (postgres/rabbitmq should say `healthy`)
5. Check the gateway: `curl http://localhost:3000/health`
6. Check the database: `docker exec -it swift-postgres psql -U swift_admin -d swifttrack -c "\dt"` - should list 8 tables
7. Check RabbitMQ: open http://localhost:15672 and log in with `swift_admin` / `swift_pw_dev_only`

---

## 8. Notes

- **Data persistence**: Postgres data lives in a named Docker volume (`pgdata`), so it survives `docker compose down` and container restarts - only `down -v` deletes it.
- **First run is slow**: Docker has to pull the `node:20-alpine`, `postgres:16-alpine`, and `rabbitmq:3-management-alpine` base images the first time - expect a minute or two depending on your connection. Subsequent runs are much faster since images are cached locally.
- Once you're done for the session, `docker compose down` is enough - you don't need to leave the stack running all the time.
