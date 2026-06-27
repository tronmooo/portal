import { describe, it, expect } from "vitest";
import {
  validateFinanceImport,
  transactionHash,
  normalizeCategory,
  extractJsonBlock,
} from "../shared/finance-import-schema";
import { planImport, type FinanceImportStore } from "../server/finance-import";
import { detectImportSignals } from "../shared/finance-import-insights";

// ── Schema validation ────────────────────────────────────────────────────────
describe("validateFinanceImport", () => {
  const valid = JSON.stringify({
    version: "1.0",
    base_currency: "USD",
    transactions: [
      { unique_id: "t1", date: "2026-06-01", amount: 4.5, currency: "USD", merchant: "Starbucks", category: "food", type: "expense", confidence: 0.9 },
    ],
    budgets: [{ unique_id: "b1", category: "food", amount: 400, month: "2026-06" }],
  });

  it("accepts a well-formed payload and counts records", () => {
    const r = validateFinanceImport(valid);
    expect(r.ok).toBe(true);
    expect(r.recordCount).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it("strips markdown code fences ChatGPT sometimes adds", () => {
    const r = validateFinanceImport("```json\n" + valid + "\n```");
    expect(r.ok).toBe(true);
  });

  it("reports a precise path + message for a bad amount", () => {
    const bad = JSON.stringify({ transactions: [{ unique_id: "t1", date: "2026-06-01", merchant: "X", amount: -5 }] });
    const r = validateFinanceImport(bad);
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe("transactions[0].amount");
    expect(r.errors[0].message).toMatch(/>= 0/);
  });

  it("rejects an unknown field inside a strict record", () => {
    const bad = JSON.stringify({ transactions: [{ unique_id: "t1", date: "2026-06-01", merchant: "X", amount: 5, bogus: true }] });
    const r = validateFinanceImport(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /bogus|Unrecognized/.test(e.message) || e.path.includes("bogus"))).toBe(true);
  });

  it("rejects a bad date format with a helpful message", () => {
    const bad = JSON.stringify({ transactions: [{ unique_id: "t1", date: "06/01/2026", merchant: "X", amount: 5 }] });
    const r = validateFinanceImport(bad);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/YYYY-MM-DD/);
  });

  it("rejects non-JSON with a clear error and never throws", () => {
    const r = validateFinanceImport("here is your data: not json");
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/Not valid JSON|Nothing to import/);
  });

  it("rejects duplicate unique_ids within a section", () => {
    const bad = JSON.stringify({ transactions: [
      { unique_id: "dup", date: "2026-06-01", merchant: "A", amount: 1 },
      { unique_id: "dup", date: "2026-06-02", merchant: "B", amount: 2 },
    ] });
    const r = validateFinanceImport(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /Duplicate unique_id/.test(e.message))).toBe(true);
  });
});

describe("hashing & normalization", () => {
  it("transactionHash is stable across merchant casing/spacing", () => {
    expect(transactionHash({ date: "2026-06-01", merchant: "Star Bucks", amount: 4.5 }))
      .toBe(transactionHash({ date: "2026-06-01", merchant: "STAR  BUCKS", amount: 4.5 }));
  });
  it("normalizeCategory maps to Portol taxonomy and falls back to general", () => {
    expect(normalizeCategory("Groceries")).toBe("food");
    expect(normalizeCategory("Rideshare")).toBe("transport");
    expect(normalizeCategory("???")).toBe("general");
  });
  it("extractJsonBlock pulls the object out of surrounding prose", () => {
    expect(extractJsonBlock('Sure! {"a":1} hope that helps')).toBe('{"a":1}');
  });
});

// ── Planning (dedup / diff) with a fake store ────────────────────────────────
function fakeStore(over: Partial<FinanceImportStore> = {}): FinanceImportStore {
  const base: FinanceImportStore = {
    getExpenses: async () => [
      // an existing Starbucks charge → import of the same should be a duplicate
      { id: "e1", amount: 4.5, category: "food", description: "Starbucks", vendor: "Starbucks", date: "2026-06-01", linkedProfiles: ["p1"], tags: [], createdAt: "" } as any,
    ],
    getObligations: async () => [
      { id: "o1", name: "Netflix", amount: 15.99, frequency: "monthly" } as any,
    ],
    getIncomes: async () => [],
    getProfiles: async () => [{ id: "p1", type: "self", name: "Me" } as any],
    getBudgets: async (_m: string) => [{ id: "bud1", category: "food", amount: 300 }],
    createExpense: async (d: any) => ({ id: "new", ...d }),
    createObligation: async (d: any) => ({ id: "new", ...d }),
    createIncome: async (d: any) => ({ id: "new", ...d }),
    createProfile: async (d: any) => ({ id: "new", ...d }),
    addBudget: async (_m, c, a) => ({ id: "newb", category: c, amount: a }),
    updateBudget: async () => true,
    deleteExpense: async () => true,
    deleteObligation: async () => true,
    deleteIncome: async () => true,
    deleteProfile: async () => true,
    deleteBudget: async () => true,
    createFinanceImport: async (r: any) => ({ ...r, createdAt: "" }),
    listFinanceImports: async () => [],
    getFinanceImport: async () => null,
    setFinanceImportStatus: async () => {},
  };
  return { ...base, ...over };
}

describe("planImport", () => {
  it("flags an existing charge as duplicate and a new one as create", async () => {
    const payload = validateFinanceImport(JSON.stringify({
      transactions: [
        { unique_id: "t1", date: "2026-06-01", merchant: "Starbucks", amount: 4.5, type: "expense" }, // dup
        { unique_id: "t2", date: "2026-06-02", merchant: "Chipotle", amount: 12, type: "expense" },    // new
        { unique_id: "t3", date: "2026-06-03", merchant: "Transfer to savings", amount: 100, type: "transfer" }, // skip
      ],
    })).data!;
    const plan = await planImport(fakeStore(), payload, "p1");
    expect(plan.summary.created).toBe(1);
    expect(plan.summary.duplicates).toBe(1);
    expect(plan.summary.skipped).toBe(1);
    const t1 = plan.ops.find((o) => o.uniqueId === "t1")!;
    expect(t1.action).toBe("duplicate");
    expect(plan.ops.find((o) => o.uniqueId === "t2")!.action).toBe("create");
  });

  it("dedups subscriptions and updates existing budgets", async () => {
    const payload = validateFinanceImport(JSON.stringify({
      subscriptions: [
        { unique_id: "s1", name: "Netflix", amount: 15.99, frequency: "monthly" }, // dup
        { unique_id: "s2", name: "Spotify", amount: 9.99, frequency: "monthly" },   // new
      ],
      budgets: [
        { unique_id: "b1", category: "food", amount: 500, month: "2026-06" },   // update (exists)
        { unique_id: "b2", category: "travel", amount: 200, month: "2026-06" }, // create
      ],
    })).data!;
    const plan = await planImport(fakeStore(), payload, "p1");
    expect(plan.ops.find((o) => o.uniqueId === "s1")!.action).toBe("duplicate");
    expect(plan.ops.find((o) => o.uniqueId === "s2")!.action).toBe("create");
    expect(plan.ops.find((o) => o.uniqueId === "b1")!.action).toBe("update");
    expect(plan.ops.find((o) => o.uniqueId === "b2")!.action).toBe("create");
    expect(plan.summary.updated).toBe(1);
  });

  it("warns on mixed currencies", async () => {
    const payload = validateFinanceImport(JSON.stringify({
      base_currency: "USD",
      transactions: [{ unique_id: "t1", date: "2026-06-01", merchant: "Eurostar", amount: 50, currency: "EUR", type: "expense" }],
    })).data!;
    const plan = await planImport(fakeStore(), payload, "p1");
    expect(plan.warnings.some((w) => /currenc/i.test(w))).toBe(true);
  });
});

// ── Smart detection ──────────────────────────────────────────────────────────
function pl(json: any) { return validateFinanceImport(JSON.stringify(json)).data!; }
const emptyExisting = { existingExpenses: [], existingObligations: [], existingIncomes: [], budgets: [], month: "2026-06" };

describe("detectImportSignals", () => {
  it("flags a new subscription not already tracked", () => {
    const sig = detectImportSignals({ payload: pl({ subscriptions: [{ unique_id: "s1", name: "Spotify", amount: 9.99, frequency: "monthly" }] }), ...emptyExisting });
    expect(sig.some((s) => s.kind === "new_subscription")).toBe(true);
  });

  it("does NOT flag a subscription that already exists", () => {
    const sig = detectImportSignals({
      payload: pl({ subscriptions: [{ unique_id: "s1", name: "Netflix", amount: 15.99, frequency: "monthly" }] }),
      ...emptyExisting,
      existingObligations: [{ name: "Netflix", amount: 15.99, kind: "subscription", frequency: "monthly" }],
    });
    expect(sig.some((s) => s.kind === "new_subscription")).toBe(false);
  });

  it("detects a salary change vs prior income", () => {
    const sig = detectImportSignals({
      payload: pl({ income: [{ unique_id: "i1", source_name: "Acme Corp", amount: 6000, frequency: "monthly", category: "salary" }] }),
      ...emptyExisting,
      existingIncomes: [{ description: "Acme Corp", amount: 5000, category: "salary" }],
    });
    const s = sig.find((x) => x.kind === "salary_change");
    expect(s).toBeTruthy();
    expect(s!.title).toMatch(/increased/i);
  });

  it("flags a large purchase and a new loan", () => {
    const sig = detectImportSignals({
      payload: pl({
        transactions: [{ unique_id: "t1", date: "2026-06-01", merchant: "Apple Store", amount: 2999, type: "expense" }],
        liabilities: [{ unique_id: "l1", name: "Tesla Auto Loan", value: 40000 }],
      }),
      ...emptyExisting,
    });
    expect(sig.some((s) => s.kind === "large_purchase")).toBe(true);
    expect(sig.some((s) => s.kind === "new_liability")).toBe(true);
  });

  it("detects a possible duplicate charge (same merchant+amount within a few days)", () => {
    const sig = detectImportSignals({
      payload: pl({ transactions: [
        { unique_id: "t1", date: "2026-06-01", merchant: "Uber", amount: 23.5, type: "expense" },
        { unique_id: "t2", date: "2026-06-02", merchant: "Uber", amount: 23.5, type: "expense" },
      ] }),
      ...emptyExisting,
    });
    expect(sig.some((s) => s.kind === "possible_duplicate")).toBe(true);
  });

  it("flags a budget overrun from existing + imported spend", () => {
    const sig = detectImportSignals({
      payload: pl({ transactions: [{ unique_id: "t1", date: "2026-06-10", merchant: "Whole Foods", amount: 250, category: "food", type: "expense" }] }),
      existingExpenses: [{ date: "2026-06-02", amount: 300, category: "food", description: "groceries" }],
      existingObligations: [], existingIncomes: [],
      budgets: [{ category: "food", amount: 400 }],
      month: "2026-06",
    });
    const s = sig.find((x) => x.kind === "budget_overrun");
    expect(s).toBeTruthy();
    expect(s!.severity).toBe("alert");
  });

  it("reports net-worth impact from new assets and liabilities", () => {
    const sig = detectImportSignals({
      payload: pl({ assets: [{ unique_id: "a1", name: "Car", value: 20000 }], liabilities: [{ unique_id: "l1", name: "Loan", value: 5000 }] }),
      ...emptyExisting,
    });
    const s = sig.find((x) => x.kind === "net_worth_impact");
    expect(s).toBeTruthy();
    expect(s!.detail).toMatch(/15,000/);
  });

  it("orders alerts before info", () => {
    const sig = detectImportSignals({
      payload: pl({
        transactions: [{ unique_id: "t1", date: "2026-06-01", merchant: "Jeweler", amount: 5000, type: "expense" }],
        assets: [{ unique_id: "a1", name: "Ring", value: 5000 }],
      }),
      ...emptyExisting,
    });
    expect(sig.length).toBeGreaterThan(1);
    expect(sig[0].severity).toBe("alert");
  });
});
