// A payment is named by its idempotency key, not recognised by its amount and
// the minute it arrived (owner, 2026-11-27: "Two identical payments could be
// legitimate. Use unique transaction IDs and idempotency keys to prevent
// accidental double submissions instead of comparing payment amounts and
// timestamps.").
//
// Same key → the same payment, answered with the first row.
// A different key → always another payment, however alike.
// No key (an older client) → the amount-and-time fold still guards a double tap
// (pinned by tests/chat-payment-recorded.test.ts and the live scenario).
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";
import { claimPaymentKey, PAYMENT_KEYS_FIELD, PAYMENT_KEYS_KEPT } from "../server/liability-payments";
import { freeFormFieldEntries } from "../client/src/components/AddFieldPanel";

let h: Harness;
const [L1, L2, L3, L4] = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const loan = (id: string) => ({
  id, type: "liability", type_key: "personal_loan", name: `Loan ${id}`, tags: [], notes: "", documents: [],
  fields: { balance: 5000, monthlyPayment: 200, dueDay: 5, interestRate: 0, _interestRateUnit: "percent" },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

beforeAll(async () => { h = await startHarness({ profiles: [{ id: "self", type: "self", name: "Me", fields: {}, tags: [], documents: [] }, loan(L1), loan(L2), loan(L3), loan(L4)] as any }); });
afterAll(async () => { await h.close(); });

const pay = (id: string, body: any, headers: Record<string, string> = {}) => h.api("POST", `/api/liabilities/${id}/payments`, { amount: 200, paymentDate: TODAY, ...body }, headers);
const rows = (id: string) => h.db.liabilityPayments.filter((p: any) => p.liabilityProfileId === id);
// (The harness's storage double records ledger rows but does not move balances;
// the balance is checked against the oracle by the live scenario money.loan-payments.)

describe("loan payments and idempotency keys", () => {
  it("the same key twice is one payment: one row, the balance moves once, the second answer is the first row", async () => {
    const a = await pay(L1, { idempotencyKey: "key-aaaa-0001" });
    const b = await pay(L1, { idempotencyKey: "key-aaaa-0001" });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.deduped).toBe(true);
    expect(rows(L1)).toHaveLength(1);
  });

  it("two different keys are two payments, though the money and the moment are the same", async () => {
    const a = await pay(L2, { idempotencyKey: "key-bbbb-0001" });
    const b = await pay(L2, { idempotencyKey: "key-bbbb-0002" });
    expect(a.data.id).not.toBe(b.data.id);
    expect(rows(L2)).toHaveLength(2);
  });

  it("the key may come in the Idempotency-Key header; five at once with one key are one payment", async () => {
    const answers = await Promise.all(Array.from({ length: 5 }, () => pay(L3, {}, { "Idempotency-Key": "key-cccc-0001" })));
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(new Set(answers.map((r) => r.data.id)).size).toBe(1);
    expect(rows(L3)).toHaveLength(1);
  });

  it("a key that is too short or not printable is ignored, not trusted", async () => {
    const r = await pay(L4, { amount: 37, idempotencyKey: "x" });
    expect(r.status).toBe(200);
    expect(rows(L4)).toHaveLength(1);
    expect(Object.keys(h.db.profiles.find((p: any) => p.id === L4).fields[PAYMENT_KEYS_FIELD] ?? {})).not.toContain("x");
  });

  it("the keys are bookkeeping: bounded, and never listed among the record's own fields", async () => {
    const fake: any = {
      p: { id: "Z", fields: {} as Record<string, any> },
      getProfile: async () => fake.p,
      updateProfile: async (_id: string, patch: any) => { fake.p = { ...fake.p, fields: { ...fake.p.fields, ...patch.fields } }; return fake.p; },
    };
    for (let i = 0; i < PAYMENT_KEYS_KEPT + 15; i++) await claimPaymentKey(fake, "Z", `key-${String(i).padStart(4, "0")}-xxxx`, `pay-${i}`);
    expect(Object.keys(fake.p.fields[PAYMENT_KEYS_FIELD])).toHaveLength(PAYMENT_KEYS_KEPT);
    // a held key answers its holder; force hands a key whose payment never landed to the retry
    const lastKey = `key-${String(PAYMENT_KEYS_KEPT + 14).padStart(4, "0")}-xxxx`;
    expect(await claimPaymentKey(fake, "Z", lastKey, "other")).toBe(`pay-${PAYMENT_KEYS_KEPT + 14}`);
    expect(await claimPaymentKey(fake, "Z", lastKey, "other", true)).toBe("other");
    expect(PAYMENT_KEYS_FIELD.startsWith("_")).toBe(true);
    expect(freeFormFieldEntries({ [PAYMENT_KEYS_FIELD]: fake.p.fields[PAYMENT_KEYS_FIELD], garageCode: "B-14" } as any).map(([k]) => k)).toEqual(["garageCode"]);
  });
});
