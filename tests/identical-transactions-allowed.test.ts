// Owner, 2026-11-27: "Identical expenses must be allowed, just like identical
// loan payments. A person can legitimately purchase two items for the same
// price on the same day. Do not prevent a transaction simply because its
// amount, merchant, or date matches another transaction. Prevent technical
// duplicates through idempotency keys, request identifiers, and retry
// protection. Distinguish between an accidental repeated submission and an
// intentional new transaction."
//
// Before: POST /api/expenses answered 409 POSSIBLE_DUPLICATE for a second
// same-priced purchase on the same day, and chat held it back as a question
// ("$18 on a movie ticket" after "$18 pizza" was not saved).
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import { startHarness, type Harness } from "./helpers/route-harness";
import { idempotentId, validIdempotencyKey } from "../server/idempotent-id";
import { beginSubmission, isKeyedSubmission, resetSubmissionKeys, KEEP_UNANSWERED_MS } from "../client/src/lib/submission-key";

let h: Harness;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
beforeAll(async () => { h = await startHarness({ profiles: [{ id: "self", type: "self", name: "Me", fields: {}, tags: [], documents: [] }] as any }); });
afterAll(async () => { await h.close(); });

const expense = (over: any = {}, headers: Record<string, string> = {}) => h.api("POST", "/api/expenses", { amount: 18, description: "Pizza", category: "food", date: TODAY, ...over }, headers);
const income = (over: any = {}, headers: Record<string, string> = {}) => h.api("POST", "/api/incomes", { amount: 2400, description: "Paycheck", category: "salary", frequency: "once", date: TODAY, ...over }, headers);
const count = (rows: any[], pred: (r: any) => boolean) => rows.filter(pred).length;

describe("identical transactions are allowed through the API", () => {
  it("the same expense twice, with no key, is two expenses — neither refused nor questioned", async () => {
    const a = await expense({ description: "Pizza A1" });
    const b = await expense({ description: "Pizza A1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.data.id).not.toBe(a.data.id);
    expect(JSON.stringify(b.data)).not.toContain("POSSIBLE_DUPLICATE");
    expect(count(h.db.expenses, (e) => e.description === "Pizza A1")).toBe(2);
  });

  it("the same amount and day under another description is saved too (the old 'medium' question)", async () => {
    const a = await expense({ description: "Movie ticket B1" });
    const b = await expense({ description: "Parking B1" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(count(h.db.expenses, (e) => /B1$/.test(e.description))).toBe(2);
  });

  it("the same KEY is the same expense: one row, and the second answer is the first row", async () => {
    const key = { "Idempotency-Key": "sub-cccc-0001" };
    const a = await expense({ description: "Coffee C1" }, key);
    const b = await expense({ description: "Coffee C1" }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.replayed).toBe(true);
    expect(count(h.db.expenses, (e) => e.description === "Coffee C1")).toBe(1);
  });

  it("two different keys are two expenses, however alike", async () => {
    const a = await expense({ description: "Coffee D1" }, { "Idempotency-Key": "sub-dddd-0001" });
    const b = await expense({ description: "Coffee D1" }, { "Idempotency-Key": "sub-dddd-0002" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.data.id).not.toBe(a.data.id);
    expect(count(h.db.expenses, (e) => e.description === "Coffee D1")).toBe(2);
  });

  it("the same key sent five times at once is still one expense", async () => {
    const key = { "Idempotency-Key": "sub-eeee-0001" };
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => expense({ description: "Lunch E1" }, key)));
    expect(answers.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(answers.map((r) => r.data.id)).size).toBe(1);
    expect(count(h.db.expenses, (e) => e.description === "Lunch E1")).toBe(1);
  });

  it("incomes follow the same rule", async () => {
    const a = await income({ description: "Paycheck F1" });
    const b = await income({ description: "Paycheck F1" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.data.id).not.toBe(a.data.id);
    const k = { "Idempotency-Key": "sub-ffff-0001" };
    const c = await income({ description: "Bonus F1" }, k);
    const d = await income({ description: "Bonus F1" }, k);
    expect(d.data.id).toBe(c.data.id);
    expect(d.status).toBe(200);
    expect(count(h.db.incomes, (i) => i.description === "Paycheck F1")).toBe(2);
    expect(count(h.db.incomes, (i) => i.description === "Bonus F1")).toBe(1);
  });
});

describe("the id a keyed request gets", () => {
  it("is stable for one account, kind and key, and differs when any of them does", () => {
    const a = idempotentId("user-1", "expense", "sub-12345678");
    expect(a).toBe(idempotentId("user-1", "expense", "sub-12345678"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotentId("user-2", "expense", "sub-12345678")).not.toBe(a);
    expect(idempotentId("user-1", "income", "sub-12345678")).not.toBe(a);
    expect(idempotentId("user-1", "expense", "sub-12345679")).not.toBe(a);
  });
  it("a key is 8–128 visible characters", () => {
    expect(validIdempotencyKey("sub-12345678")).toBe("sub-12345678");
    expect(validIdempotencyKey("short")).toBeNull();
    expect(validIdempotencyKey("has space 123")).toBeNull();
    expect(validIdempotencyKey(42)).toBeNull();
  });
});

describe("the app's submission key: an accidental repeat or an intentional second one", () => {
  beforeEach(() => resetSubmissionKeys());
  const body = { amount: 18, description: "Pizza", date: TODAY };

  it("only a transaction's create is keyed", () => {
    expect(isKeyedSubmission("POST", "/api/expenses")).toBe(true);
    expect(isKeyedSubmission("POST", "/api/incomes?x=1")).toBe(true);
    expect(isKeyedSubmission("PATCH", "/api/expenses/abc")).toBe(false);
    expect(isKeyedSubmission("POST", "/api/tasks")).toBe(false);
  });

  it("a double tap (the second sent while the first is in the air) carries the same key", () => {
    const a = beginSubmission("POST", "/api/expenses", body);
    const b = beginSubmission("POST", "/api/expenses", body);
    expect(b.key).toBe(a.key);
  });

  it("after the server answered, the same form sent again is a NEW submission", () => {
    const a = beginSubmission("POST", "/api/expenses", body);
    a.settle(true);
    const b = beginSubmission("POST", "/api/expenses", body);
    expect(b.key).not.toBe(a.key);
  });

  it("a request that ended without an answer is retried under the same key", () => {
    const a = beginSubmission("POST", "/api/expenses", body);
    a.settle(false);
    const b = beginSubmission("POST", "/api/expenses", body);
    expect(b.key).toBe(a.key);
    b.settle(true);
    expect(beginSubmission("POST", "/api/expenses", body).key).not.toBe(a.key);
  });

  it("an unanswered request is forgotten after ten minutes", () => {
    const t0 = 1_000_000;
    const a = beginSubmission("POST", "/api/expenses", body, t0);
    a.settle(false);
    const later = Date.now() + KEEP_UNANSWERED_MS + 1000;
    expect(beginSubmission("POST", "/api/expenses", body, later).key).not.toBe(a.key);
  });

  it("a different amount is a different submission", () => {
    const a = beginSubmission("POST", "/api/expenses", body);
    expect(beginSubmission("POST", "/api/expenses", { ...body, amount: 19 }).key).not.toBe(a.key);
  });

  it("settling twice does not disturb a later submission", () => {
    const a = beginSubmission("POST", "/api/expenses", body);
    a.settle(true); a.settle(false);
    const b = beginSubmission("POST", "/api/expenses", body);
    const c = beginSubmission("POST", "/api/expenses", body);
    expect(c.key).toBe(b.key);
  });
});

describe("wiring", () => {
  const read = (rel: string) => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");
  it("the client sends the key and settles it on an answer and on no answer", () => {
    const src = read("client/src/lib/queryClient.ts");
    expect(src).toContain("headers[SUBMISSION_KEY_HEADER] = submission.key");
    expect(src).toContain("submission?.settle(true)");
    expect(src).toContain("submission?.settle(false)");
  });
  it("chat's expense and income tools make no content duplicate check", () => {
    const src = read("server/ai-engine.ts");
    for (const tool of ['case "create_expense": {', 'case "log_income": {']) {
      const at = src.lastIndexOf(tool);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf("\n    case \"", at + 20));
      expect(body).not.toContain("findPossibleDuplicates(");
      expect(body).not.toContain("duplicateQuestion(");
    }
  });
  it("neither create route answers POSSIBLE_DUPLICATE", () => {
    const src = read("server/routes.ts");
    for (const route of ['app.post("/api/expenses"', 'app.post("/api/incomes"']) {
      const at = src.indexOf(route);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf("\n  app.", at + 20));
      expect(body).not.toContain('code: "POSSIBLE_DUPLICATE"');
      expect(body).toContain("idempotencyKeyOf(req)");
    }
  });
});
