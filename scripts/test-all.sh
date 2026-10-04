#!/usr/bin/env bash
# =====================================================================
# Run every SwiftTrack test suite in one process.
#
#   bash scripts/test-all.sh
#   docker compose -f docker-compose.test.yml up --build --exit-code-from tests
#
# A single script (rather than several compose services) keeps the exit
# code unambiguous: 0 means *everything* passed.
# =====================================================================
set -uo pipefail

status=0

run() {
  local label="$1"
  shift
  echo
  echo "==> ${label}"
  if ! "$@"; then
    echo "!! ${label} FAILED"
    status=1
  fi
}

run "eslint (api-gateway)" bash -c 'cd api-gateway && npx eslint .'
run "jest  (api-gateway)" bash -c 'cd api-gateway && npx jest --ci --forceExit'
run "eslint (ros-service)" bash -c 'cd ros-service && npx eslint .'
run "jest  (ros-service)" bash -c 'cd ros-service && npx jest --ci --forceExit'
run "ruff  (cms-service, wms-service)" ruff check .
run "pytest (cms-service)" pytest cms-service
run "pytest (wms-service)" pytest wms-service

echo
if [ "${status}" -eq 0 ]; then
  echo "All SwiftTrack test suites passed."
else
  echo "One or more SwiftTrack test suites FAILED."
fi
exit "${status}"
