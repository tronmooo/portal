// The isolated database must be the schema the code expects: ask the app's own
// diagnostic (GET /api/diagnostics/schema, shared/schema-expectations.ts) and
// fail if anything a migration adds is missing — so tests/isolated/schema.sql
// can never silently fall behind a new migration.
import { api } from "../smoke/fixture/api";

(async () => {
  const r = await api<{ ok: boolean; missing: unknown[] }>("GET", "/diagnostics/schema");
  if (!r.ok || !r.data || typeof r.data.ok !== "boolean" || !Array.isArray(r.data.missing)) {
    console.error(`could not read the schema diagnostic: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    process.exit(1);
  }
  if (!r.data.ok || r.data.missing.length) {
    console.error(`the isolated schema is behind the code. Missing: ${JSON.stringify(r.data.missing)}\nRegenerate tests/isolated/schema.sql (tests/isolated/README.md).`);
    process.exit(1);
  }
  console.log("schema: nothing the code expects is missing");
})();
