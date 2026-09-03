// server/finance-import.ts
//
// The "Import from ChatGPT" engine. Three responsibilities:
//   1. buildImportPrompt()  — generate the strict prompt (seeded with the user's
//      current finance state) that the user pastes into ChatGPT.
//   2. planImport()         — validate-already-done payload → a dry-run diff
//      (new / duplicate / update / warnings). NO writes. Unit-testable.
//   3. applyImport()/undoImport() — execute the plan as one batch, tag every
//      row (source=chatgpt_import, import batch id, confidence), record the
//      created ids for a clean undo.
//
// Scope rule (per product decision): every imported record is linked to ONE
// selected profile. Nothing is auto-assigned across Bob/Jim/Me — the caller
// passes the active profileId and we never write to any other profile.
//
// Source-agnostic by design: planImport/applyImport take an already-normalized
// `FinanceImportPayload`. A future CSV/Plaid/PDF adapter only has to produce the
// same payload shape; the dashboard, budgets and net-worth never learn where the
// data came from.

import { randomUUID } from "crypto";
import { normalizeMonthKey, budgetCategoryKey } from "@shared/budget-ledger";
import {
  type FinanceImportPayload,
  FINANCE_IMPORT_SOURCE,
  transactionHash,
  normalizeMerchant,
  normalizeCategory,
} from "@shared/finance-import-schema";
import { detectImportSignals, type ImportSignal } from "@shared/finance-import-insights";
import type { Expense, Obligation, Income, Profile } from "@shared/schema";

// ── Minimal storage surface the engine needs (keeps planImport testable) ─────
export interface FinanceImportStore {
  getExpenses(): Promise<Expense[]>;
  getObligations(): Promise<Obligation[]>;
  getIncomes(): Promise<Income[]>;
  getProfiles(): Promise<Profile[]>;
  getBudgets(month: string): Promise<Array<{ id: string; category: string; amount: number; notes?: string; profileId?: string }>>;
  getSelfProfile?(): Promise<Profile | undefined>;

  createExpense(data: any): Promise<Expense>;
  createObligation(data: any): Promise<Obligation>;
  createIncome(data: any): Promise<Income>;
  createProfile(data: any): Promise<Profile>;
  addBudget(month: string, category: string, amount: number, notes?: string, profileId?: string): Promise<{ id: string; category: string; amount: number }>;
  updateBudget(month: string, budgetId: string, updates: { amount?: number; category?: string; notes?: string; profileId?: string }): Promise<boolean>;

  deleteExpense(id: string): Promise<boolean>;
  deleteObligation(id: string): Promise<boolean>;
  deleteIncome(id: string): Promise<boolean>;
  deleteProfile(id: string): Promise<boolean>;
  deleteBudget(month: string, budgetId: string): Promise<boolean>;

  // Import-batch persistence (history + undo).
  createFinanceImport(rec: FinanceImportRecordInput): Promise<FinanceImportRecord>;
  listFinanceImports(limit?: number): Promise<FinanceImportRecord[]>;
  getFinanceImport(id: string): Promise<FinanceImportRecord | null>;
  setFinanceImportStatus(id: string, status: "committed" | "undone"): Promise<void>;
}

export interface FinanceImportRecordInput {
  id: string;
  profileId: string | null;
  status: "committed" | "undone";
  /** Persisted summary; carries the smart-detection signals so history can show them. */
  summary: ImportSummary & { signals?: ImportSignal[] };
  recordCount: number;
  createdRecords: CreatedRecords;
}
export interface FinanceImportRecord extends FinanceImportRecordInput {
  createdAt: string;
  undoneAt?: string | null;
}

export interface CreatedRecords {
  expenses: string[];
  obligations: string[];
  incomes: string[];
  profiles: string[];
  budgets: Array<{ month: string; id: string }>;
}

export type OpAction = "create" | "duplicate" | "update" | "skip";
export interface PlannedOp {
  section: string;
  action: OpAction;
  uniqueId: string;
  label: string;
  reason?: string;
}
export interface SectionCount { create: number; duplicate: number; update: number; skip: number; }
export interface ImportSummary {
  created: number;
  duplicates: number;
  updated: number;
  skipped: number;
  warnings: number;
  bySection: Record<string, SectionCount>;
  /** Records the commit could not write (reported per record, never aborting the batch). */
  failed?: number;
}
export interface ImportPlan {
  batchId: string;
  profileId: string;
  ops: PlannedOp[];
  warnings: string[];
  summary: ImportSummary;
  /** Smart-detection signals (new/cancelled subs, large purchases, overruns…). */
  signals: ImportSignal[];
}

function emptySection(): SectionCount { return { create: 0, duplicate: 0, update: 0, skip: 0 }; }
function fmtMoney(n: number): string { return `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}`; }

/**
 * Dry-run the import: classify every record as new / duplicate / update against
 * existing data, accumulate warnings, and return a plan. Performs NO writes.
 */
export async function planImport(
  store: FinanceImportStore,
  payload: FinanceImportPayload,
  profileId: string,
): Promise<ImportPlan> {
  const ops: PlannedOp[] = [];
  const warnings: string[] = [];
  const bySection: Record<string, SectionCount> = {};
  const sec = (name: string) => (bySection[name] ||= emptySection());

  const [expenses, obligations, incomes, profiles] = await Promise.all([
    store.getExpenses(), store.getObligations(), store.getIncomes(), store.getProfiles(),
  ]);

  // Existing fingerprints (loose hash: date+merchant+amount — Portol expenses
  // don't store an account, so we don't include it when matching existing rows).
  const existingTxn = new Set(
    expenses.map((e) => looseHash(e.date, e.vendor || e.description, e.amount)),
  );
  const existingObl = new Set(
    obligations.map((o) => `${normalizeMerchant(o.name)}|${Math.round(o.amount * 100)}|${o.frequency}`),
  );
  const existingInc = new Set(
    incomes.map((i) => `${normalizeMerchant(i.description)}|${Math.round(i.amount * 100)}|${i.frequency}`),
  );
  const existingProfileByKey = new Set(
    profiles.map((p) => `${p.type}|${normalizeMerchant(p.name)}`),
  );

  // ── transactions → expenses / incomes ──────────────────────────────────────
  for (const t of payload.transactions) {
    const s = sec("transactions");
    if (t.type === "transfer") {
      ops.push({ section: "transactions", action: "skip", uniqueId: t.unique_id, label: `${t.merchant} ${fmtMoney(t.amount)}`, reason: "transfer — not counted as spend or income" });
      s.skip++;
      continue;
    }
    const h = looseHash(t.date, t.merchant, t.amount);
    if (existingTxn.has(h)) {
      ops.push({ section: "transactions", action: "duplicate", uniqueId: t.unique_id, label: `${t.merchant} ${fmtMoney(t.amount)} · ${t.date.slice(0, 10)}`, reason: "matches an existing transaction (date + merchant + amount)" });
      s.duplicate++;
      continue;
    }
    existingTxn.add(h); // guard against in-payload dups too
    ops.push({ section: "transactions", action: "create", uniqueId: t.unique_id, label: `${t.merchant} ${fmtMoney(t.amount)} · ${t.date.slice(0, 10)}` });
    s.create++;
  }

  // ── subscriptions + recurring_bills → obligations ──────────────────────────
  for (const [section, rows] of [["subscriptions", payload.subscriptions], ["recurring_bills", payload.recurring_bills]] as const) {
    for (const r of rows) {
      const s = sec(section);
      const key = `${normalizeMerchant(r.name)}|${Math.round(r.amount * 100)}|${r.frequency}`;
      if (existingObl.has(key)) {
        ops.push({ section, action: "duplicate", uniqueId: r.unique_id, label: `${r.name} ${fmtMoney(r.amount)}/${r.frequency}`, reason: "already tracked" });
        s.duplicate++;
        continue;
      }
      existingObl.add(key);
      ops.push({ section, action: "create", uniqueId: r.unique_id, label: `${r.name} ${fmtMoney(r.amount)}/${r.frequency}` });
      s.create++;
    }
  }

  // ── income ────────────────────────────────────────────────────────────────
  for (const inc of payload.income) {
    const s = sec("income");
    const key = `${normalizeMerchant(inc.source_name)}|${Math.round(inc.amount * 100)}|${inc.frequency}`;
    if (existingInc.has(key)) {
      ops.push({ section: "income", action: "duplicate", uniqueId: inc.unique_id, label: `${inc.source_name} ${fmtMoney(inc.amount)}/${inc.frequency}`, reason: "already tracked" });
      s.duplicate++;
      continue;
    }
    existingInc.add(key);
    ops.push({ section: "income", action: "create", uniqueId: inc.unique_id, label: `${inc.source_name} ${fmtMoney(inc.amount)}/${inc.frequency}` });
    s.create++;
  }

  // ── accounts / assets / liabilities / investments → profiles ───────────────
  const holdingSections: Array<[string, string, Array<{ unique_id: string; name: string; value?: number; balance?: number }>]> = [
    ["accounts", "account", payload.accounts as any],
    ["assets", "asset", payload.assets as any],
    ["liabilities", "liability", payload.liabilities as any],
    ["investments", "investment", payload.investments as any],
  ];
  for (const [section, profileType, rows] of holdingSections) {
    for (const r of rows) {
      const s = sec(section);
      const key = `${profileType}|${normalizeMerchant(r.name)}`;
      const val = Number(r.value ?? r.balance ?? 0);
      if (existingProfileByKey.has(key)) {
        ops.push({ section, action: "duplicate", uniqueId: r.unique_id, label: `${r.name} ${fmtMoney(val)}`, reason: `a ${profileType} named "${r.name}" already exists` });
        s.duplicate++;
        continue;
      }
      existingProfileByKey.add(key);
      ops.push({ section, action: "create", uniqueId: r.unique_id, label: `${r.name} ${fmtMoney(val)}` });
      s.create++;
    }
  }

  // ── budgets → addBudget / updateBudget ─────────────────────────────────────
  const budgetMonths = new Map<string, Array<{ id: string; category: string; amount: number }>>();
  const defaultMonth = new Date().toISOString().slice(0, 7);
  for (const b of payload.budgets) {
    const s = sec("budgets");
    const month = b.month || defaultMonth;
    if (!budgetMonths.has(month)) budgetMonths.set(month, await store.getBudgets(month).catch(() => []));
    // The same bucket rule the caps themselves use (budgetCategoryKey): an
    // imported "Groceries" cap is the month's food cap, not a second one.
    const existing = budgetMonths.get(month)!.find((x) => budgetCategoryKey(x.category) === budgetCategoryKey(b.category));
    if (existing) {
      ops.push({ section: "budgets", action: "update", uniqueId: b.unique_id, label: `${b.category} ${fmtMoney(b.amount)} (${month})`, reason: "updates the existing budget for this category" });
      s.update++;
    } else {
      ops.push({ section: "budgets", action: "create", uniqueId: b.unique_id, label: `${b.category} ${fmtMoney(b.amount)} (${month})` });
      s.create++;
    }
  }

  // ── currency sanity warning ────────────────────────────────────────────────
  const base = payload.base_currency || "USD";
  const foreign = new Set<string>();
  for (const t of payload.transactions) if (t.currency && t.currency !== base) foreign.add(t.currency);
  if (foreign.size > 0) warnings.push(`Mixed currencies detected (${[...foreign].join(", ")} alongside ${base}). Amounts are imported as-is, not converted.`);

  // ── Smart detection ─────────────────────────────────────────────────────────
  // Run the deterministic signal detector over the payload + existing data.
  const importMonth = dominantMonth(payload.transactions.map((t) => t.date)) || new Date().toISOString().slice(0, 7);
  const monthBudgets = budgetMonths.get(importMonth) || (await store.getBudgets(importMonth).catch(() => []));
  const signals = detectImportSignals({
    payload,
    existingExpenses: expenses.map((e) => ({ date: e.date, amount: e.amount, category: e.category, vendor: e.vendor, description: e.description })),
    existingObligations: obligations.map((o) => ({ name: o.name, amount: o.amount, kind: (o as any).kind, frequency: o.frequency })),
    existingIncomes: incomes.map((i) => ({ description: i.description, amount: i.amount, category: i.category })),
    budgets: monthBudgets.map((b) => ({ category: b.category, amount: b.amount })),
    month: importMonth,
  });

  const summary = summarize(bySection, warnings.length);
  return { batchId: randomUUID(), profileId, ops, warnings, summary, signals };
}

/** Most common YYYY-MM among a list of dates, or "" if none. */
function dominantMonth(dates: string[]): string {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const m = (d || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) counts.set(m, (counts.get(m) || 0) + 1);
  }
  let best = "", bestN = 0;
  for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n; }
  return best;
}

function summarize(bySection: Record<string, SectionCount>, warnings: number): ImportSummary {
  let created = 0, duplicates = 0, updated = 0, skipped = 0;
  for (const s of Object.values(bySection)) { created += s.create; duplicates += s.duplicate; updated += s.update; skipped += s.skip; }
  return { created, duplicates, updated, skipped, warnings, bySection };
}

/**
 * Execute a validated payload as one batch, scoped to `profileId`. Only records
 * the plan classified as create/update are written; duplicates/skips are left
 * alone. Every row is tagged with the source + batch id + confidence. The set of
 * created ids is persisted so the batch can be undone cleanly.
 */
export interface ImportFailure { section: string; uniqueId: string; label: string; error: string }

export async function applyImport(
  store: FinanceImportStore,
  payload: FinanceImportPayload,
  profileId: string,
  plan: ImportPlan,
  opts: { month?: string } = {},
): Promise<{ batchId: string; summary: ImportSummary; record: FinanceImportRecord; failed: ImportFailure[] }> {
  const batchId = plan.batchId;
  const created: CreatedRecords = { expenses: [], obligations: [], incomes: [], profiles: [], budgets: [] };
  // One record that fails to write must not abort the batch with the rows
  // already written and no batch record to undo them with: each write is
  // attempted on its own, failures are reported, and the batch record is
  // written for whatever landed so "undo" still covers it.
  const failed: ImportFailure[] = [];
  const attempt = async (section: string, uniqueId: string, label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e: any) { failed.push({ section, uniqueId, label, error: String(e?.message || e) }); }
  };
  const actionByUid = new Map(plan.ops.map((o) => [o.uniqueId, o.action] as const));
  const tag = (conf: number | undefined) => [`source:${FINANCE_IMPORT_SOURCE}`, `import:${batchId}`, `conf:${conf ?? 0.8}`];
  const importMeta = (conf: number | undefined) => ({ source: FINANCE_IMPORT_SOURCE, importBatchId: batchId, confidence: conf ?? 0.8 });

  // transactions
  for (const t of payload.transactions) {
    if (actionByUid.get(t.unique_id) !== "create") continue;
    await attempt("transactions", t.unique_id, `${t.merchant} ${fmtMoney(t.amount)}`, async () => {
      if (t.type === "income") {
        const row = await store.createIncome({
          description: t.merchant, amount: t.amount, category: normalizeCategory(t.category), frequency: "once",
          date: t.date.slice(0, 10), linkedProfiles: [profileId], tags: tag(t.confidence),
        });
        created.incomes.push(row.id);
      } else {
        const row = await store.createExpense({
          amount: t.amount, category: normalizeCategory(t.category), description: t.merchant, vendor: t.merchant,
          date: t.date.slice(0, 10), isRecurring: false, linkedProfiles: [profileId], tags: tag(t.confidence),
          source: FINANCE_IMPORT_SOURCE,
        });
        created.expenses.push(row.id);
      }
    });
  }

  // subscriptions + recurring_bills → obligations
  for (const [kind, rows] of [["subscription", payload.subscriptions], ["bill", payload.recurring_bills]] as const) {
    for (const r of rows) {
      if (actionByUid.get(r.unique_id) !== "create") continue;
      await attempt(kind === "subscription" ? "subscriptions" : "recurring_bills", r.unique_id, `${r.name} ${fmtMoney(r.amount)}`, async () => {
        const row = await store.createObligation({
          name: r.name, amount: r.amount, frequency: r.frequency, category: r.category || (kind === "subscription" ? "subscription" : "general"),
          kind, nextDueDate: r.next_due_date || nextDueFallback(r.frequency), currency: r.currency || "USD",
          linkedProfiles: [profileId], notes: r.notes || "", fields: { _import: importMeta(r.confidence) },
        });
        created.obligations.push(row.id);
      });
    }
  }

  // income section
  for (const inc of payload.income) {
    if (actionByUid.get(inc.unique_id) !== "create") continue;
    await attempt("income", inc.unique_id, `${inc.source_name} ${fmtMoney(inc.amount)}`, async () => {
      const row = await store.createIncome({
        description: inc.source_name, amount: inc.amount, category: inc.category || "salary", frequency: inc.frequency,
        date: inc.date?.slice(0, 10), linkedProfiles: [profileId], tags: tag(inc.confidence),
      });
      created.incomes.push(row.id);
    });
  }

  // accounts / assets / liabilities / investments → profiles (owned by profileId)
  const holdingSections: Array<[string, Array<any>]> = [
    ["account", payload.accounts], ["asset", payload.assets], ["liability", payload.liabilities], ["investment", payload.investments],
  ];
  for (const [profileType, rows] of holdingSections) {
    for (const r of rows) {
      if (actionByUid.get(r.unique_id) !== "create") continue;
      await attempt(`${profileType}s`, r.unique_id, String(r.name), async () => {
        const value = Number(r.value ?? r.balance ?? 0);
        const fields: Record<string, any> = { _import: importMeta(r.confidence) };
        if (profileType === "liability") fields.balance = value; else fields.value = value;
        if (r.symbol) fields.symbol = r.symbol;
        if (r.currency) fields.currency = r.currency;
        const row = await store.createProfile({
          type: profileType, name: r.name, parentProfileId: profileId,
          fields, notes: r.notes || "", tags: [`source:${FINANCE_IMPORT_SOURCE}`, `import:${batchId}`],
        });
        created.profiles.push(row.id);
      });
    }
  }

  // budgets
  // The caller's month (the user's calendar), not the host's UTC month.
  const defaultMonth = normalizeMonthKey(opts.month) || new Date().toISOString().slice(0, 7);
  for (const b of payload.budgets) {
    const action = actionByUid.get(b.unique_id);
    if (action !== "create" && action !== "update") continue;
    const month = normalizeMonthKey(b.month) || defaultMonth;
    await attempt("budgets", b.unique_id, `${b.category} ${fmtMoney(b.amount)} (${month})`, async () => {
      if (action === "update") {
        const existing = (await store.getBudgets(month).catch(() => [])).find((x) => budgetCategoryKey(x.category) === budgetCategoryKey(b.category) && (!x.profileId || x.profileId === profileId));
        if (existing) { await store.updateBudget(month, existing.id, { amount: b.amount, notes: `${FINANCE_IMPORT_SOURCE}:${batchId}` }); return; }
      }
      const row = await store.addBudget(month, normalizeCategory(b.category), b.amount, `${FINANCE_IMPORT_SOURCE}:${batchId}`, profileId);
      created.budgets.push({ month, id: row.id });
    });
  }

  const record = await store.createFinanceImport({
    id: batchId, profileId, status: "committed", summary: { ...plan.summary, signals: plan.signals, failed: failed.length },
    recordCount: created.expenses.length + created.obligations.length + created.incomes.length + created.profiles.length + created.budgets.length,
    createdRecords: created,
  });
  return { batchId, summary: plan.summary, record, failed };
}

/** Reverse a committed import: delete every row it created, mark it undone. */
export async function undoImport(store: FinanceImportStore, batchId: string): Promise<{ removed: number }> {
  const batch = await store.getFinanceImport(batchId);
  if (!batch) throw new Error("Import not found");
  if (batch.status === "undone") return { removed: 0 };
  const cr = batch.createdRecords;
  let removed = 0;
  for (const id of cr.expenses) if (await store.deleteExpense(id).catch(() => false)) removed++;
  for (const id of cr.obligations) if (await store.deleteObligation(id).catch(() => false)) removed++;
  for (const id of cr.incomes) if (await store.deleteIncome(id).catch(() => false)) removed++;
  for (const id of cr.profiles) if (await store.deleteProfile(id).catch(() => false)) removed++;
  for (const b of cr.budgets) if (await store.deleteBudget(b.month, b.id).catch(() => false)) removed++;
  await store.setFinanceImportStatus(batchId, "undone");
  return { removed };
}

function looseHash(date: string, merchant: string, amount: number): string {
  return `${(date || "").slice(0, 10)}|${normalizeMerchant(merchant)}|${Math.round(Number(amount) * 100)}`;
}

function nextDueFallback(frequency: string): string {
  const d = new Date();
  const add = frequency === "weekly" ? 7 : frequency === "biweekly" ? 14 : frequency === "quarterly" ? 90 : frequency === "yearly" ? 365 : 30;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

// ── Prompt generation ────────────────────────────────────────────────────────
export interface PromptContext {
  accounts: string[];
  subscriptions: string[];
  budgets: string[];
  liabilities: string[];
  assets: string[];
  lastImportAt: string | null;
  profileName: string;
  baseCurrency: string;
}

/** Build the strict prompt the user pastes into ChatGPT. Seeded with the user's
 *  current finance state so ChatGPT returns *deltas* and reuses known names. */
export function buildImportPrompt(ctx: PromptContext): string {
  const known = (label: string, items: string[]) => items.length ? `${label}: ${items.slice(0, 40).join("; ")}` : `${label}: (none yet)`;
  const since = ctx.lastImportAt ? `Only include items dated on or after ${ctx.lastImportAt.slice(0, 10)} (the last import).` : `Include all financial data you can find.`;
  return `You are a financial data extractor for the app "Portol". Convert the user's financial information into STRICT JSON for profile "${ctx.profileName}".

OUTPUT RULES (critical):
- Respond with a SINGLE JSON object and NOTHING else. No markdown, no code fences, no commentary.
- Use this exact top-level shape (omit a section if you have no data for it):
{
  "version": "1.0",
  "base_currency": "${ctx.baseCurrency}",
  "accounts":       [{ "unique_id","name","type","balance","currency","confidence","notes" }],
  "transactions":   [{ "unique_id","date","amount","currency","merchant","category","account","type","confidence","notes" }],
  "subscriptions":  [{ "unique_id","name","amount","currency","frequency","category","next_due_date","confidence","notes" }],
  "recurring_bills":[{ "unique_id","name","amount","currency","frequency","category","next_due_date","confidence","notes" }],
  "income":         [{ "unique_id","source_name","amount","currency","frequency","category","date","confidence","notes" }],
  "assets":         [{ "unique_id","name","value","currency","category","confidence","notes" }],
  "liabilities":    [{ "unique_id","name","value","currency","category","confidence","notes" }],
  "investments":    [{ "unique_id","name","symbol","value","currency","confidence","notes" }],
  "budgets":        [{ "unique_id","category","amount","month","currency","notes" }]
}

FIELD RULES:
- "amount"/"value"/"balance": positive numbers only. For transactions use "type" = "expense" | "income" | "transfer" to indicate direction (never use negative numbers).
- "date": "YYYY-MM-DD". "month": "YYYY-MM". "currency": 3-letter ISO (e.g. ${ctx.baseCurrency}).
- "confidence": 0.0–1.0 — how sure you are about each row.
- "unique_id": a stable id per row (e.g. "txn-2026-06-01-starbucks-450").
- Categories should be simple words like food, housing, utilities, transport, insurance, medical, entertainment, shopping, subscription, education, travel.

DEDUPLICATION:
- ${since}
- Reuse these known names exactly where they match so Portol doesn't create duplicates:
  ${known("Accounts", ctx.accounts)}
  ${known("Subscriptions", ctx.subscriptions)}
  ${known("Bills/Liabilities", ctx.liabilities)}
  ${known("Assets", ctx.assets)}
  ${known("Budgets", ctx.budgets)}

Return ONLY the JSON object now.`;
}
