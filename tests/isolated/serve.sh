#!/usr/bin/env bash
# Start the app from this checkout against the isolated stack (port 5199) and
# wait until it answers. Restarts it when it is already running.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f tests/isolated/.run/server.pid ] && kill "$(cat tests/isolated/.run/server.pid)" 2>/dev/null || true
pkill -f "tsx server/index.ts" 2>/dev/null || true
set -a; . tests/isolated/.run/app.env; set +a
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
PORT=5199 nohup npm run dev > tests/isolated/.run/server.log 2>&1 &
echo $! > tests/isolated/.run/server.pid
for _ in $(seq 1 90); do curl -s -o /dev/null --noproxy '*' -f http://127.0.0.1:5199/api/version && { echo "app up on :5199"; exit 0; }; sleep 2; done
echo "app did not start; see tests/isolated/.run/server.log"; exit 1
