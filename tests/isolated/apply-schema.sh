#!/usr/bin/env bash
# Apply schema.sql (the production schema's STRUCTURE: no rows) to the isolated
# database, section by section. Functions are created twice: before the tables
# (column defaults call them) and after (some take a table's row type).
set -u
cd "$(dirname "$0")"
DB=${ISOLATED_DB_CONTAINER:-isolated-db-1}
run() { docker exec -i "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=0 -q "$@" 2>&1; }
section() { awk -v want="$1" '/^-- @@section /{on=($3==want); next} on' schema.sql; }
fail=0
apply() {  # apply <section> <tolerate-errors:0|1>
  out=$(section "$1" | { echo "set check_function_bodies = off; set client_min_messages = warning;"; cat; } | run)
  n=$(printf '%s\n' "$out" | grep -c '^ERROR' || true)
  echo "  $1: $(section "$1" | grep -c ';$') statements, $n error(s)"
  if [ "$n" -gt 0 ] && [ "$2" = "0" ]; then printf '%s\n' "$out" | grep -A2 '^ERROR' | head -30; fail=1; fi
}
run -c 'create extension if not exists "uuid-ossp" with schema extensions; create extension if not exists pgcrypto with schema extensions;' >/dev/null
apply sequences 0
apply functions 1
apply tables 0
apply functions 0
apply constraints 0
apply indexes 0
apply triggers 0
apply rls 0
apply policies 0
apply grants 0
run -c "grant usage on schema public to anon, authenticated, service_role; notify pgrst, 'reload schema';" >/dev/null
echo "  tables in public: $(run -Atc "select count(*) from pg_tables where schemaname='public'")"
exit $fail
