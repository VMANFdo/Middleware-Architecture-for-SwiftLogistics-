#!/usr/bin/env bash
# End-to-end smoke test against the *running* SwiftTrack stack.
#
#   docker compose up -d --wait
#   ./scripts/smoke.sh                 # whole suite
#   ./scripts/smoke.sh --only delivery # filter on check names
#
# Requires the compose stack from docker-compose.yml to be healthy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec python3 scripts/smoke.py "$@"
