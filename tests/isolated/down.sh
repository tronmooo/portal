#!/usr/bin/env bash
# Remove the isolated stack and everything in it.
cd "$(dirname "$0")"
[ -f .run/gateway.pid ] && kill "$(cat .run/gateway.pid)" 2>/dev/null
[ -f .run/server.pid ] && kill "$(cat .run/server.pid)" 2>/dev/null
[ -f .run/env ] && { set -a; . .run/env; set +a; }
ISOLATED_DB_PASSWORD=${ISOLATED_DB_PASSWORD:-x} ISOLATED_JWT_SECRET=${ISOLATED_JWT_SECRET:-x} docker compose down -v
rm -rf .run
