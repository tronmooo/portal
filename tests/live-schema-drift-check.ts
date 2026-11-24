// Live check (production, smoke account): the database has every table and
// column the migrations add (shared/schema-expectations.ts). Reads no rows
// and writes nothing. Run it after applying a migration and after a deploy:
//   npx tsx tests/live-schema-drift-check.ts
import { api } from "./smoke/fixture/api";
import { EXPECTED_COLUMNS, EXPECTED_TABLES } from "../shared/schema-expectations";

(async () => {
  const r = await api("GET", "/diagnostics/schema");
  if (r.status === 404) {
    console.log("FAIL  GET /api/diagnostics/schema is not deployed yet (404): the database cannot be checked from here");
    process.exit(1);
  }
  if (!r.ok || !Array.isArray(r.data?.missing)) {
    console.log(`FAIL  GET /api/diagnostics/schema: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    process.exit(1);
  }
  const missing: Array<{ kind: string; table: string; column?: string; migration: string }> = r.data.missing;
  console.log(`checked ${EXPECTED_TABLES.length} tables and ${EXPECTED_COLUMNS.length} columns`);
  for (const m of missing) console.log(`FAIL  missing ${m.kind} ${m.table}${m.column ? `.${m.column}` : ""} — apply migrations/${m.migration}`);
  console.log(missing.length ? "\nFAILED" : "PASS  the database has everything the migrations add\n\nALL PASS");
  process.exit(missing.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
