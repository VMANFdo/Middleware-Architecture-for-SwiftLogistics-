#!/usr/bin/env bash
# Run the k6 load test against the running SwiftTrack stack.
#
#   ./scripts/loadtest.sh                                  # 60 VUs x 60 s
#   ./scripts/loadtest.sh -e VUS=10 -e DURATION=15s        # quick pass
#   BASE_URL=http://localhost:3000 ./scripts/loadtest.sh   # explicit target
#
# Uses a local `k6` when one is on PATH; otherwise falls back to the official
# Grafana image joined to the compose network, so no host tooling is required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETWORK="${SWIFT_NETWORK:-swifttrack_swift-network}"
SCRIPT="loadtest/k6-orders.js"

if command -v k6 >/dev/null 2>&1; then
  TARGET="${BASE_URL:-http://localhost:3000}"
  echo "==> k6 (local) targeting ${TARGET}"
  args=(run -e "BASE_URL=${TARGET}")
  args+=("$@")
  args+=("$SCRIPT")
  exec k6 "${args[@]}"
fi

if ! docker info >/dev/null 2>&1; then
  echo "k6 is not installed and Docker is unavailable." >&2
  echo "Install k6 (https://k6.io/docs/get-started/installation/) or start Docker Desktop." >&2
  exit 1
fi

# Inside the compose network the gateway is reachable by service name,
# which sidesteps host/container networking differences entirely.
TARGET="${BASE_URL:-http://api-gateway:3000}"
echo "==> k6 (docker) on network ${NETWORK} targeting ${TARGET}"
args=(run -e "BASE_URL=${TARGET}")
args+=("$@")
docker run --rm -i \
  --network "$NETWORK" \
  grafana/k6:latest \
  "${args[@]}" - < "$SCRIPT"
