// shared/finance-import-insights.ts
//
// The "smart detection" layer for finance imports. Given a validated payload and
// the user's existing finance data, it surfaces human-meaningful SIGNALS:
//   new / possibly-cancelled subscriptions, salary changes, new loans/credit,
//   large purchases, possible duplicate charges, budget overruns, top spending
//   categories, and the net-worth impact of the import.
//
// Deterministic on purpose: no LLM call, so it's instant, free, reproducible and
// unit-testable. (A future "explain these in prose" pass can layer an LLM on top
// of these structured signals — but the detection itself never depends on one.)
//
// Pure module — takes already-fetched data, returns signals. Runs identically on
// client and server.

import type { FinanceImportPayload } from "./finance-import-schema";
import { normalizeMerchant } from "./finance-import-schema";

export type SignalSeverity = "info" | "warn" | "alert";
export interface ImportSignal {
  kind: string;
  severity: SignalSeverity;
  title: string;
  detail: string;
  confidence: number;
}

export interface ExistingExpenseLite { date: string; amount: number; category: string; vendor?: string; description: string; }
export interface ExistingObligationLite { name: string; amount: number; kind?: string; frequency: string; }
export interface ExistingIncomeLite { description: string; amount: number; category: string; }
export interface BudgetLite { category: string; amount: number; }

export interface DetectInput {
  payload: FinanceImportPayload;
  existingExpenses: ExistingExpenseLite[];
  existingObligations: ExistingObligationLite[];
  existingIncomes: ExistingIncomeLite[];
  budgets: BudgetLite[];
  /** Month being imported into, YYYY-MM. */
  month: string;
}

const MAX_PER_KIND = 5;          // don't flood the review screen
const FUZZY_DUP_DAYS = 3;        // same merchant+amount within N days = possible dup
const SALARY_CATEGORIES = new Set(["salary", "income", "paycheck", "wages", "payroll"]);

function fmt(n: number): string { return `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}`; }
function daysBetween(a: string, b: string): number {
  const t1 = Date.parse(a.slice(0, 10)); const t2 = Date.parse(b.slice(0, 10));
  if (isNaN(t1) || isNaN(t2)) return Infinity;
  return Math.abs(t1 - t2) / 86400000;
}
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Analyze an import and return a prioritized list of signals (alerts first). */
export function detectImportSignals(input: DetectInput): ImportSignal[] {
  const { payload, existingExpenses, existingObligations, existingIncomes, budgets, month } = input;
  const out: ImportSignal[] = [];
  const importExpenses = payload.transactions.filter((t) => t.type === "expense");

  // ── New subscriptions / bills ───────────────────────────────────────────────
  const existingOblNames = new Set(existingObligations.map((o) => normalizeMerchant(o.name)));
  for (const sub of payload.subscriptions.slice(0, MAX_PER_KIND)) {
    if (!existingOblNames.has(normalizeMerchant(sub.name))) {
      out.push({ kind: "new_subscription", severity: "info", confidence: 0.85,
        title: "New subscription", detail: `${sub.name} — ${fmt(sub.amount)}/${sub.frequency}` });
    }
  }

  // ── New loans / credit cards (from liabilities) ─────────────────────────────
  const creditRe = /(loan|mortgage|auto|credit|card|financ|line of credit)/i;
  let loanCount = 0;
  for (const liab of payload.liabilities) {
    if (loanCount >= MAX_PER_KIND) break;
    const isCredit = creditRe.test(liab.name) || creditRe.test(liab.category || "");
    if (isCredit) {
      loanCount++;
      out.push({ kind: "new_liability", severity: "warn", confidence: 0.7,
        title: "New loan / credit", detail: `${liab.name} — balance ${fmt(liab.value)}` });
    }
  }

  // ── Salary / income changes ─────────────────────────────────────────────────
  for (const inc of payload.income) {
    if (!SALARY_CATEGORIES.has((inc.category || "").toLowerCase())) continue;
    const prior = existingIncomes.find((e) => normalizeMerchant(e.description) === normalizeMerchant(inc.source_name));
    if (prior && Math.abs(prior.amount - inc.amount) / Math.max(prior.amount, 1) > 0.01) {
      const up = inc.amount > prior.amount;
      out.push({ kind: "salary_change", severity: up ? "info" : "warn", confidence: 0.75,
        title: up ? "Income increased" : "Income decreased",
        detail: `${inc.source_name}: ${fmt(prior.amount)} → ${fmt(inc.amount)} (${up ? "+" : "−"}${fmt(Math.abs(inc.amount - prior.amount))}/${inc.frequency})` });
    }
  }

  // ── Possibly cancelled subscriptions ────────────────────────────────────────
  // Only meaningful when the import actually contains subscription data — otherwise
  // an import of only transactions would flag every subscription as "cancelled".
  if (payload.subscriptions.length > 0) {
    const importedSubNames = new Set(payload.subscriptions.map((s) => normalizeMerchant(s.name)));
    let cancelled = 0;
    for (const o of existingObligations) {
      if (cancelled >= MAX_PER_KIND) break;
      if ((o.kind || "") !== "subscription") continue;
      if (!importedSubNames.has(normalizeMerchant(o.name))) {
        cancelled++;
        out.push({ kind: "cancelled_subscription", severity: "warn", confidence: 0.45,
          title: "Possibly cancelled", detail: `${o.name} (${fmt(o.amount)}/${o.frequency}) wasn't in this import — verify it's still active.` });
      }
    }
  }

  // ── Large purchases ─────────────────────────────────────────────────────────
  const med = median(existingExpenses.map((e) => e.amount));
  const largeThreshold = Math.max(500, med * 5);
  const large = importExpenses.filter((t) => t.amount >= largeThreshold).sort((a, b) => b.amount - a.amount).slice(0, MAX_PER_KIND);
  for (const t of large) {
    out.push({ kind: "large_purchase", severity: "alert", confidence: 0.8,
      title: "Large purchase", detail: `${t.merchant} — ${fmt(t.amount)} on ${t.date.slice(0, 10)}` });
  }

  // ── Possible duplicate charges (fuzzy: same merchant+amount within N days) ───
  // Distinct from the importer's exact dedup (date+merchant+amount). This catches
  // a charge billed twice a day or two apart.
  const cents = (n: number) => Math.round(n * 100);
  const seenPairs = new Set<string>();
  const candidates = [
    ...importExpenses.map((t) => ({ merchant: t.merchant, amount: t.amount, date: t.date })),
    ...existingExpenses.map((e) => ({ merchant: e.vendor || e.description, amount: e.amount, date: e.date })),
  ];
  let dupCount = 0;
  for (let i = 0; i < importExpenses.length && dupCount < MAX_PER_KIND; i++) {
    const a = importExpenses[i];
    for (const b of candidates) {
      if (a.merchant === b.merchant && a.date === b.date && cents(a.amount) === cents(b.amount)) continue; // identical row, skip self
      if (normalizeMerchant(a.merchant) === normalizeMerchant(b.merchant) && cents(a.amount) === cents(b.amount) && daysBetween(a.date, b.date) <= FUZZY_DUP_DAYS && a.date !== b.date) {
        const key = [normalizeMerchant(a.merchant), cents(a.amount), [a.date, b.date].sort().join("/")].join("|");
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        dupCount++;
        out.push({ kind: "possible_duplicate", severity: "warn", confidence: 0.55,
          title: "Possible duplicate charge", detail: `${a.merchant} ${fmt(a.amount)} on ${a.date.slice(0, 10)} and ${b.date.slice(0, 10)}` });
        break;
      }
    }
  }

  // ── Budget overruns (existing month spend + imported new expenses) ───────────
  if (budgets.length > 0) {
    const spendByCat = new Map<string, number>();
    const add = (cat: string, amt: number) => spendByCat.set(cat.toLowerCase(), (spendByCat.get(cat.toLowerCase()) || 0) + amt);
    for (const e of existingExpenses) if ((e.date || "").slice(0, 7) === month) add(e.category || "general", e.amount);
    for (const t of importExpenses) if ((t.date || "").slice(0, 7) === month) add(t.category || "general", t.amount);
    let over = 0;
    for (const b of budgets) {
      if (over >= MAX_PER_KIND) break;
      const spent = spendByCat.get((b.category || "").toLowerCase()) || 0;
      if (b.amount > 0 && spent > b.amount) {
        over++;
        out.push({ kind: "budget_overrun", severity: "alert", confidence: 0.8,
          title: "Over budget", detail: `${b.category}: spent ${fmt(spent)} of ${fmt(b.amount)} (${fmt(spent - b.amount)} over)` });
      }
    }
  }

  // ── Top imported spending category (insight) ────────────────────────────────
  if (importExpenses.length > 0) {
    const byCat = new Map<string, number>();
    for (const t of importExpenses) byCat.set(t.category || "general", (byCat.get(t.category || "general") || 0) + t.amount);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) out.push({ kind: "top_category", severity: "info", confidence: 0.9,
      title: "Top imported spending", detail: `${top[0]} — ${fmt(top[1])} across ${importExpenses.filter((t) => (t.category || "general") === top[0]).length} transactions` });
  }

  // ── Net-worth impact of the import (insight) ────────────────────────────────
  const newAssets = payload.assets.reduce((s, a) => s + (a.value || 0), 0) + payload.investments.reduce((s, a) => s + (a.value || 0), 0);
  const newLiab = payload.liabilities.reduce((s, l) => s + (l.value || 0), 0);
  const nwDelta = newAssets - newLiab;
  if (newAssets !== 0 || newLiab !== 0) {
    out.push({ kind: "net_worth_impact", severity: "info", confidence: 0.9,
      title: "Net-worth impact", detail: `${nwDelta >= 0 ? "+" : "−"}${fmt(Math.abs(nwDelta))} (${fmt(newAssets)} assets − ${fmt(newLiab)} liabilities)` });
  }

  // Order: alerts → warnings → info, preserving insertion order within a tier.
  const tier: Record<SignalSeverity, number> = { alert: 0, warn: 1, info: 2 };
  return out.sort((a, b) => tier[a.severity] - tier[b.severity]);
}
