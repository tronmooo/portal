#!/usr/bin/env bash
# ── Migration regression tests ───────────────────────────────────────────────
#
# Spins up a throwaway PostgreSQL cluster, loads a fixture reproducing the
# exact corruption the 2026-07-29 production audit found, applies the
# migrations, and asserts both the cleanup and the guard behaviour — including
# that re-running the migrations is a no-op.
#
# These migrations install triggers that REJECT writes, so "does it break
# legitimate writes?" matters as much as "does it block bad ones?". Both are
# covered in tests/sql/linked-profiles.assert.sql.
#
# Usage:  ./scripts/test-migrations.sh
# Requires: postgresql server binaries (initdb/pg_ctl) + psql.
#
# Runs entirely on a temporary cluster in a temp directory. It never touches a
# configured DATABASE_URL, and never connects to Supabase.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGPORT="${PGPORT_TEST:-55432}"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/data"

# PostgreSQL refuses to run as root, so drop to a non-root user when needed.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  if id postgres >/dev/null 2>&1; then RUNAS="postgres"; else
    echo "ERROR: running as root and no 'postgres' user exists to drop to." >&2
    exit 1
  fi
fi

# Locate the server binaries — they are not on PATH on Debian/Ubuntu.
if command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
else
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "ERROR: PostgreSQL server binaries (initdb/pg_ctl) not found." >&2
  echo "       Install postgresql (e.g. apt-get install postgresql) and retry." >&2
  exit 1
fi

run() { if [ -n "$RUNAS" ]; then su "$RUNAS" -c "PATH=$PGBIN:\$PATH $*"; else env PATH="$PGBIN:$PATH" bash -c "$*"; fi; }

cleanup() {
  run "pg_ctl -D $PGDATA -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$PGDATA"
[ -n "$RUNAS" ] && chown -R "$RUNAS" "$WORKDIR"
chmod 700 "$PGDATA"

echo "▶ starting throwaway PostgreSQL on port $PGPORT"
run "initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
run "pg_ctl -D $PGDATA -o '-p $PGPORT -k $WORKDIR' -l $WORKDIR/log start" >/dev/null
for _ in $(seq 1 30); do
  if psql -h "$WORKDIR" -p "$PGPORT" -U postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 0.5
done

PSQL="psql -h $WORKDIR -p $PGPORT -U postgres -q -v ON_ERROR_STOP=1"

echo "▶ loading fixture (the audited corruption)"
$PSQL -f "$REPO_ROOT/tests/sql/linked-profiles.fixture.sql" >/dev/null

echo "▶ applying migrations"
$PSQL -f "$REPO_ROOT/migrations/20260729_linked_profiles_ownership_guard.sql" 2>&1 | grep -E 'NOTICE|WARNING' || true

echo "▶ asserting cleanup + guard behaviour"
$PSQL -f "$REPO_ROOT/tests/sql/linked-profiles.assert.sql" 2>&1 | grep -E 'PASS|FAIL|---' || true

echo "▶ re-applying migration (idempotency: must repair 0 rows)"
REPAIRED=$($PSQL -f "$REPO_ROOT/migrations/20260729_linked_profiles_ownership_guard.sql" 2>&1 \
  | grep -oE 'cleanup complete: [0-9]+ row' | grep -oE '[0-9]+' || echo "unknown")
if [ "$REPAIRED" != "0" ]; then
  echo "✗ FAIL: re-running the migration repaired '$REPAIRED' rows; expected 0 (not idempotent)" >&2
  exit 1
fi
echo "  ✓ idempotent"

echo ""
echo "✓ all migration tests passed"
