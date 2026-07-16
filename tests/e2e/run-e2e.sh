#!/usr/bin/env bash
# Build the app and run the fake-phone e2e loop. On headless Linux (CI) this
# wraps everything in xvfb; on a machine with a display it runs directly.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm run build

if [ -n "${DISPLAY:-}" ]; then
  node tests/e2e/fake-phone.mjs
else
  xvfb-run -a node tests/e2e/fake-phone.mjs
fi
