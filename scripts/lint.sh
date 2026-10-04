#!/usr/bin/env bash
# Lint every SwiftTrack service.
#   ./scripts/lint.sh          # check only (CI mode)
#   ./scripts/lint.sh --fix    # auto-fix where possible
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUFF="${RUFF:-ruff}"
if [[ -x "$ROOT/.venv/bin/ruff" ]]; then
  RUFF="$ROOT/.venv/bin/ruff"
fi

EXTRA_ARGS=()
if [[ "${1:-}" == "--fix" ]]; then
  EXTRA_ARGS=(--fix)
fi

status=0

echo "==> eslint (api-gateway)"
(cd api-gateway && npx eslint . "${EXTRA_ARGS[@]}") || status=1

echo "==> eslint (ros-service)"
(cd ros-service && npx eslint . "${EXTRA_ARGS[@]}") || status=1

echo "==> ruff (cms-service, wms-service)"
"$RUFF" check . "${EXTRA_ARGS[@]}" || status=1

exit $status
