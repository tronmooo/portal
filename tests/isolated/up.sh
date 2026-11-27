#!/usr/bin/env bash
# Bring up the isolated test stack and print how to point the app and the
# tests at it:
#   tests/isolated/up.sh           # database, auth, REST, gateway, schema, test accounts
#   tests/isolated/down.sh         # remove it (and its data)
# The database is EMPTY apart from the two test accounts: no production row is
# copied, only the structure in schema.sql.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .run/env ] || node keys.mjs
set -a; . .run/env; set +a
docker compose up -d db
until [ "$(docker inspect -f '{{.State.Health.Status}}' isolated-db-1 2>/dev/null)" = "healthy" ]; do sleep 2; done
# the image creates these roles; this run's password lets auth and REST sign in
until docker exec isolated-db-1 psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 \
  -c "alter user authenticator with password '$ISOLATED_DB_PASSWORD'; alter user supabase_auth_admin with password '$ISOLATED_DB_PASSWORD'; alter user supabase_storage_admin with password '$ISOLATED_DB_PASSWORD';" >/dev/null 2>&1; do sleep 2; done
docker compose up -d mail auth rest
for _ in $(seq 1 60); do curl -s -o /dev/null --noproxy '*' -f http://127.0.0.1:54323/health && break; sleep 2; done
if [ "$(docker exec isolated-db-1 psql -U supabase_admin -d postgres -Atc "select count(*) from pg_tables where schemaname='public'")" = "0" ]; then
  echo "applying schema.sql"; ./apply-schema.sh
fi
docker restart isolated-rest-1 >/dev/null   # pick up the schema
docker compose up -d storage
for _ in $(seq 1 60); do curl -s -o /dev/null --noproxy '*' -f http://127.0.0.1:54326/status && break; sleep 2; done
# the two buckets the app uses (private, as in production)
for b in documents profile-photos; do
  curl -s --noproxy '*' -o /dev/null -X POST http://127.0.0.1:54326/bucket \
    -H "apikey: $ISOLATED_SERVICE_KEY" -H "Authorization: Bearer $ISOLATED_SERVICE_KEY" -H "Content-Type: application/json" \
    -d "{\"id\":\"$b\",\"name\":\"$b\",\"public\":false}"
done
[ -f .run/gateway.pid ] && kill "$(cat .run/gateway.pid)" 2>/dev/null || true
nohup node gateway.mjs > .run/gateway.log 2>&1 &
echo $! > .run/gateway.pid
for _ in $(seq 1 20); do curl -s -o /dev/null --noproxy '*' -f http://127.0.0.1:54321/auth/v1/health && break; sleep 1; done
# The two test accounts, with the ids and sign-ins the fixtures already use
# (tests/smoke/fixture/account.ts; the second is only ever REFUSED things).
user() {
  curl -s --noproxy '*' -o /dev/null -X POST http://127.0.0.1:54321/auth/v1/admin/users \
    -H "apikey: $ISOLATED_SERVICE_KEY" -H "Authorization: Bearer $ISOLATED_SERVICE_KEY" -H "Content-Type: application/json" \
    -d "{\"id\":\"$1\",\"email\":\"$2\",\"password\":\"$3\",\"email_confirm\":true}"
}
user 229685c4-8dcb-4349-8448-57fc38e6e3d2 "${SMOKE_EMAIL:-portol-smoke@aol.com}" "${SMOKE_PASSWORD:-Smoke-Test-2026!}"
user 7d0c2f6e-3b1a-4c58-9e47-1f2a3b4c5d6e "${INTEGRITY_OTHER_EMAIL:-testfix2026@aol.com}" "${INTEGRITY_OTHER_PASSWORD:-Testtest1!}"
# Worker accounts, so several runs can go side by side (ISOLATED_WORKER=1..9).
for i in 1 2 3 4 5 6 7 8 9; do user "00000000-0000-4000-8000-00000000010$i" "worker$i@isolated.test" "${SMOKE_PASSWORD:-Smoke-Test-2026!}"; done
cat > .run/app.env <<ENV
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=$ISOLATED_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$ISOLATED_SERVICE_KEY
SUPABASE_JWT_SECRET=$ISOLATED_JWT_SECRET
SMOKE_SB_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=$ISOLATED_ANON_KEY
SMOKE_API_BASE=http://127.0.0.1:5199/api
SMOKE_UI_BASE=http://127.0.0.1:5199
WRITE_RATE_LIMIT_PER_MIN=100000
INTEGRITY_NO_AI=1
INTEGRITY_ISOLATED=1
ISOLATED_SERVICE_KEY=$ISOLATED_SERVICE_KEY
ISOLATED_MAIL_API=http://127.0.0.1:54325
ENV
echo "isolated stack is up. App + test environment: tests/isolated/.run/app.env"
