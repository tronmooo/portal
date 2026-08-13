// tests/account-isolation-guard.test.ts — every server query names its owner.
//
// Reported 2026-08-13: "Make sure data is not spilling over from other accounts
// into this account… There must be zero data leakage between accounts."
//
// WHY A SOURCE SCAN AND NOT A RUNTIME TEST. The server talks to Postgres with
// the SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level Security by design —
// it has to, because one request legitimately writes rows for whichever user is
// authenticated. RLS is still enabled with owner-scoped policies on every table
// (that is the wall against a stolen anon key hitting PostgREST directly, and
// it is verified against the live database, not here). But for the APPLICATION
// path, RLS is not the enforcement — the `.eq("user_id", …)` on each query is.
//
// That makes isolation a property of the source text, and a property of source
// text is exactly what a test can hold. One forgotten `.eq("user_id", …)` on a
// SELECT is a silent cross-account read that no unit test of that feature would
// notice, because in development there is only ever one account.
//
// The rule: every `.from("<table>")` statement in the server that reads or
// mutates a user-owned table must mention `user_id`. Exceptions are listed
// below WITH their reason — adding one is a deliberate act, not an oversight.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SERVER_DIR = path.resolve(__dirname, "..", "server");

/**
 * Tables that are not user-owned, so a query against them cannot leak between
 * accounts.
 *   profile_type_definitions — a global reference table of profile shapes,
 *     read-only to clients (RLS: public SELECT, INSERT denied).
 *   finance_webhook_events  — raw Stripe webhook receipts, keyed by Stripe's
 *     event id. There is no user until the payload is resolved against
 *     financial_accounts; RLS denies all client access.
 *   captures                — falls back to an in-process Map when the table is
 *     absent; every real query in that module is user-scoped.
 */
const NOT_USER_OWNED = new Set([
  "profile_type_definitions",
  "finance_webhook_events",
]);

/**
 * Specific statements that are deliberately not user-filtered, each with the
 * reason it is safe. Matched on `<file>:<table>:<snippet>`.
 */
const JUSTIFIED = [
  // Public share links: an artifact is fetched by an unguessable random share
  // token precisely BECAUSE the viewer is not the owner and may not be signed
  // in at all. Both call sites project a whitelist of columns and never echo
  // the token or the owner back.
  { file: "supabase-storage.ts", table: "artifacts", needle: "shareToken" },
  { file: "routes.ts", table: "artifacts", needle: "shareToken" },
  // Daily cron sweep of EXPIRED cache rows across all users. Deletes only rows
  // whose expires_at has passed; reads nothing and returns nothing.
  { file: "supabase-storage.ts", table: "response_cache", needle: "sweepResponseCache" },
];

function serverFiles(): string[] {
  return fs
    .readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(SERVER_DIR, f));
}

interface Finding {
  file: string;
  line: number;
  table: string;
  statement: string;
}

/**
 * Every `.from("<table>")` in a file, paired with the statement it starts —
 * from the `.from(` to the end of the chained expression. Approximated by
 * reading to the first `;`, which is where a supabase-js chain always ends.
 */
function unscopedQueries(file: string): Finding[] {
  const src = fs.readFileSync(file, "utf8");
  const base = path.basename(file);
  const out: Finding[] = [];
  const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const table = m[1];
    if (NOT_USER_OWNED.has(table)) continue;
    const rest = src.slice(m.index, m.index + 1200);
    const end = rest.indexOf(";");
    const statement = end > 0 ? rest.slice(0, end) : rest.slice(0, 600);
    if (/user_id/.test(statement)) continue;

    // An INSERT carries its ownership in the row object, which may be built
    // further up. Accept it when the surrounding function assigns user_id.
    if (/\.insert\(|\.upsert\(/.test(statement)) {
      const context = src.slice(Math.max(0, m.index - 2500), m.index + 400);
      if (/user_id\s*:/.test(context)) continue;
    }

    const line = src.slice(0, m.index).split("\n").length;
    const justified = JUSTIFIED.some(
      (j) => j.file === base && j.table === table &&
        src.slice(Math.max(0, m.index - 2500), m.index + 900).includes(j.needle),
    );
    if (justified) continue;

    out.push({ file: base, line, table, statement: statement.replace(/\s+/g, " ").slice(0, 160) });
  }
  return out;
}

describe("account isolation — every server query names its owner", () => {
  it("no Supabase query reads or writes a user-owned table without user_id", () => {
    const findings = serverFiles().flatMap(unscopedQueries);
    const report = findings
      .map((f) => `  ${f.file}:${f.line}  ${f.table}\n      ${f.statement}`)
      .join("\n");
    expect(
      findings,
      findings.length === 0 ? "" :
        `Queries missing a user_id filter — each one can return another ` +
        `account's rows, because the service-role key bypasses RLS:\n${report}\n\n` +
        `Add .eq("user_id", this.userId), or add a JUSTIFIED entry above ` +
        `explaining why the query is safe without it.`,
    ).toEqual([]);
  });

  it("the shared response cache is read by owner, not by key alone", () => {
    // The cross-instance cache stores whole dashboard payloads. Its keys embed
    // the owner by convention (`<uid>@v<N>`); the ownership filter is what makes
    // a mis-built key impossible to exploit rather than merely unlikely.
    const src = fs.readFileSync(path.join(SERVER_DIR, "supabase-storage.ts"), "utf8");
    const start = src.indexOf("async getResponseCache(");
    expect(start, "getResponseCache not found").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("async setResponseCache(", start));
    expect(body).toContain('.eq("user_id", this.userId)');
  });

  it("scoped storage is constructed per request from the authenticated user id", () => {
    // The global storage singleton is built with the placeholder userId
    // "anonymous". Every authenticated request must run inside a scoped
    // instance instead — that AsyncLocalStorage context is what stops a
    // concurrent request from reading through another user's storage.
    const auth = fs.readFileSync(path.join(SERVER_DIR, "auth.ts"), "utf8");
    expect(auth).toContain("createScopedStorage(user.id)");
    expect(auth).toContain("requestStorageContext.run(scopedStorage");
    // The legacy mutate-the-singleton path must stay gone: flipping a shared
    // userId between a write and a later read is how rows get credited to the
    // wrong account under concurrency.
    expect(auth).not.toMatch(/setStorageUserId\s*\(/);
  });

  it("an unauthenticated request never reaches user-scoped storage", () => {
    // /api/warmup is public so the client can pay the cold start before login.
    // It must return before touching the database when no user resolves —
    // otherwise it queries with the literal string "anonymous" as a user id.
    const routes = fs.readFileSync(path.join(SERVER_DIR, "routes.ts"), "utf8");
    const start = routes.indexOf('app.get("/api/warmup"');
    expect(start, "/api/warmup not found").toBeGreaterThan(-1);
    const body = routes.slice(start, start + 4000);
    const guard = body.indexOf("if (!authed) return res.json(");
    const firstStorageUse = body.indexOf("createScopedStorage(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstStorageUse);
  });

  it("response-cache keys can never collapse two accounts into one bucket", () => {
    // With no userId there is no shared bucket to fall into: the key is made
    // per-request unique instead of a constant like "anon".
    const routes = fs.readFileSync(path.join(SERVER_DIR, "routes.ts"), "utf8");
    const start = routes.indexOf("function cacheUserKey(");
    expect(start, "cacheUserKey not found").toBeGreaterThan(-1);
    const body = routes.slice(start, routes.indexOf("function getCached(", start));
    expect(body).toMatch(/nouser-\$\{Math\.random\(\)/);
    expect(body).toContain("req.userId");
  });
});
