// App-wide CRUD coverage. Static, so it runs in milliseconds and catches the
// whole class of "it's not letting me delete/edit this" before it ships.
//
// User, 2026-07-25:
//   "test out all crud functionality throughout my entire app because shit
//    like this should never happen… I come back in a month and it's still not
//    fixed or it is fixed and then I come back and it's not fixed."
//
// The Info-tab bug was one instance of a general shape: a resource the UI lets
// you create, but not fully edit or remove — or a mutation whose result the
// client never re-reads, so the change appears not to have happened. Chasing
// those one screen at a time is exactly the loop that keeps reopening. This
// enumerates the surface instead.
//
// What it found on first run:
//   • reminders  — create + delete, no update. `storage.updateReminder` had
//     existed for months with no route calling it, so a typo'd reminder could
//     only be deleted and retyped.  → PATCH /api/reminders/:id added.
//   • paychecks  — no general update (see EXEMPT below).
//
// A new resource that ships without a delete now fails here, with the resource
// name in the message, instead of surfacing as a bug report in a month.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const repo = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const ROUTES = repo("server/routes.ts");

interface Route { method: string; path: string; }

function parseRoutes(src: string): Route[] {
  const out: Route[] = [];
  const re = /app\.(get|post|put|patch|delete)\("(\/api\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}

const ROUTE_LIST = parseRoutes(ROUTES);
const resourceOf = (p: string) => p.split("/")[2];
/** `/api/tasks/:id` — a top-level operation on one record, not a sub-resource. */
const isRecordPath = (p: string) => p.split("/").length === 4 && /^:/.test(p.split("/")[3]);

/**
 * POST endpoints that are remote procedures, not collections. Posting to them
 * runs something; it does not create a row you would later edit or delete.
 */
const RPC_ENDPOINTS = new Set([
  "chat", "upload", "ai", "ai-transform", "receipt-extract", "import",
  "finance-import", "smart-fill", "search", "wellness", "weekly-review",
  "onboarding", "cron", "cleanup", "admin", "loans", "calendar", "relationships",
  "client-errors", "cashflow",
]);

/**
 * Resources deliberately missing a verb, each with the reason. An entry here is
 * a decision on the record — not a silent gap. Adding one is how you say "this
 * really is append-only", and it has to be written down to pass.
 */
const EXEMPT: Record<string, { verb: "UPDATE" | "DELETE"; why: string }[]> = {
  "audit-log": [
    { verb: "UPDATE", why: "append-only by design — an editable audit trail is not an audit trail" },
    { verb: "DELETE", why: "append-only by design" },
  ],
  "entity-links": [
    { verb: "UPDATE", why: "a link has no editable body; changing one means deleting it and making another" },
  ],
};

function exempt(resource: string, verb: "UPDATE" | "DELETE"): boolean {
  return (EXEMPT[resource] || []).some((e) => e.verb === verb);
}

/** Resources with a `POST /api/<resource>` collection-create route. */
const CREATABLE = [
  ...new Set(
    ROUTE_LIST.filter((r) => r.method === "POST" && r.path === `/api/${resourceOf(r.path)}`)
      .map((r) => resourceOf(r.path))
      .filter((r) => !RPC_ENDPOINTS.has(r)),
  ),
].sort();

describe("every resource you can create, you can also change and remove", () => {
  it("finds the resource surface at all", () => {
    // Guards the parser itself: if a refactor changes how routes are declared
    // this test would otherwise pass by finding nothing.
    expect(ROUTE_LIST.length).toBeGreaterThan(150);
    expect(CREATABLE.length).toBeGreaterThan(15);
    expect(CREATABLE).toContain("tasks");
    expect(CREATABLE).toContain("obligations");
    expect(CREATABLE).toContain("reminders");
  });

  it.each(CREATABLE)("%s can be deleted", (resource) => {
    if (exempt(resource, "DELETE")) return;
    const has = ROUTE_LIST.some(
      (r) => r.method === "DELETE" && resourceOf(r.path) === resource && isRecordPath(r.path),
    );
    expect(has, `no DELETE /api/${resource}/:id — the user can create these and never remove them`).toBe(true);
  });

  it.each(CREATABLE)("%s can be edited", (resource) => {
    if (exempt(resource, "UPDATE")) return;
    const has = ROUTE_LIST.some(
      (r) => (r.method === "PATCH" || r.method === "PUT") &&
        resourceOf(r.path) === resource && isRecordPath(r.path),
    );
    expect(has, `no PATCH /api/${resource}/:id — a mistake in one can only be deleted, not corrected`).toBe(true);
  });

  it("every exemption names a resource that still exists", () => {
    // Stops the exemption list rotting into a permanent excuse for resources
    // that were renamed or removed.
    for (const resource of Object.keys(EXEMPT)) {
      expect(
        ROUTE_LIST.some((r) => resourceOf(r.path) === resource),
        `EXEMPT lists "${resource}" but no route serves it — delete the entry`,
      ).toBe(true);
    }
  });
});

describe("a delete tells the truth about what it deleted", () => {
  const deleteRoutes = ROUTE_LIST.filter((r) => r.method === "DELETE" && isRecordPath(r.path));

  it("there are plenty to check", () => {
    expect(deleteRoutes.length).toBeGreaterThan(10);
  });

  const handlerFor = (p: string) => {
    const at = ROUTES.indexOf(`app.delete("${p}"`);
    expect(at, `route ${p} not found`).toBeGreaterThan(-1);
    const body = ROUTES.slice(at, at + 1600);
    const end = body.indexOf("\n  }));");
    return end > -1 ? body.slice(0, end) : body;
  };
  /** Handler with `//` comments stripped, so quoting old code doesn't trip a check. */
  const codeOf = (p: string) =>
    handlerFor(p).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it.each(deleteRoutes.map((r) => r.path))("%s never reports 200 with success:false", (p) => {
    // THE invariant. `res.json({ success: ok })` on a 200 is the shape that
    // produces "it's not letting me delete anything": the client checks the
    // HTTP status, sees 200, shows "Deleted", refetches — and the row is still
    // there, with no error anywhere. DELETE /api/incomes/:id did exactly this.
    //
    // A delete either removed the row (200) or it did not (4xx). It must never
    // claim both at once.
    expect(codeOf(p), `DELETE ${p} answers 200 with a success flag that can be false`)
      .not.toMatch(/res\.json\(\{\s*success:\s*(?!true)[A-Za-z_]/);
  });

  it.each(deleteRoutes.map((r) => r.path))("%s either 404s or says why it is idempotent", (p) => {
    // Returning 200 for an id that no longer exists is correct REST — a repeat
    // DELETE should succeed. But it has to be a decision, not an oversight, so
    // the handler must either 404 or carry the word "idempotent" saying so.
    const handler = handlerFor(p);
    const answers404 = /404/.test(handler);
    const declaresIdempotent = /idempotent/i.test(handler);
    expect(
      answers404 || declaresIdempotent,
      `DELETE ${p} always returns success and never explains why — either 404 on a missing row, or say "Idempotent:" in a comment and mean it`,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The other half of "the delete didn't work": the server removed the row and
// the client kept showing its cached copy.
// ─────────────────────────────────────────────────────────────────────────────
describe("every write is followed by a re-read", () => {
  it("the server busts its response cache on ANY mutation, centrally", () => {
    // Per-route bustCache() calls are best-effort and were missing on several
    // handlers. The middleware is what makes it unconditional, so it must stay
    // registered and stay method-based.
    expect(ROUTES).toMatch(/app\.use\(cacheBustMiddleware\)/);
    expect(ROUTES).toMatch(/function cacheBustMiddleware/);
    expect(ROUTES).toMatch(/export function shouldBustCaches/);
  });

  it("no client file mutates without invalidating something", () => {
    const files = walk(path.resolve(__dirname, "..", "client/src"));
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      if (!/apiRequest\(\s*"(DELETE|PATCH|PUT)"/.test(src)) continue;
      // Any of the sanctioned refresh mechanisms counts.
      const refreshes =
        /invalidateDomains?\(|invalidateQueries|refetchQueries|useAppMutation|invalidateAll/.test(src);
      // …or the file hands the result to a parent that does.
      const delegates = /onSaved\(|onSuccess\?\.\(|props\.onDone/.test(src);
      // …or it is writing a preference that only local state reads.
      const localOnly = /\/api\/preferences\//.test(src);
      if (!refreshes && !delegates && !localOnly) {
        offenders.push(path.relative(path.resolve(__dirname, ".."), file));
      }
    }
    expect(offenders, `these mutate and never re-read:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(p);
  }
  return acc;
}
