// Billing models for liabilities, and the per-occurrence money model.
//
// WHY THIS EXISTS
// ---------------
// A liability used to carry ONE amount: `fields.monthlyAmount`. That is only
// true for a fixed bill ("$86.50 phone bill every month"). The real world has
// four other shapes, and every one of them breaks a single amount field:
//
//   * A VARIABLE bill recurs on schedule but costs a different amount each
//     cycle (electric: Jan $72, Feb $91, Mar $84). Writing March's $84 into the
//     definition rewrites January and February too — the historical record is
//     destroyed by an ordinary edit.
//   * A USAGE-BASED bill is a base subscription plus charges accrued during the
//     period (AI service: $20 base + $14 credits + $8 usage = $42). The extra
//     charges belong to THAT billing period; adding credits in August must not
//     touch July or September.
//   * A ONE-TIME debt has no recurrence at all.
//   * An INSTALLMENT/LOAN has a balance that falls as payments are made.
//
// So money lives at THREE levels, and this module owns the boundary between
// them:
//
//   1. DEFINITION   — the obligation and its recurrence rule (the liability
//                     profile). Owns the base/expected amount ONLY.
//   2. OCCURRENCE   — one billing period. Owns its own estimated amount, actual
//                     amount, due date, status, and payment. Stored in
//                     `fields.occurrences[<canonical YYYY-MM-DD>]`.
//   3. CHARGE       — one line item inside an occurrence (base, credits, usage,
//                     fee, tax, discount). Stored on the occurrence.
//
// Editing an occurrence NEVER edits the definition, and editing the definition
// never rewrites an occurrence that already recorded its own amount. That is
// the whole point: past months stay put.
//
// Pure + dependency-light (only the family classifier) so the client, the
// server, the calendar and the AI tools all resolve the same number.

import { liabilityFamily } from "./liability-types";

// ─── Billing model ───────────────────────────────────────────────────────────

export type BillingModel =
  /** Same amount every cycle. $86.50 phone bill. */
  | "fixed"
  /** Recurs on schedule, amount differs per cycle. Electric, water, gas. */
  | "variable"
  /** Base subscription + charges accrued during the period. AI/API services. */
  | "usage_based"
  /** A single bill owed once, no recurrence. */
  | "one_time"
  /** A balance paid down on a schedule: principal, interest, payoff date. */
  | "installment";

export const BILLING_MODELS: ReadonlyArray<{
  key: BillingModel;
  label: string;
  description: string;
  /** True when occurrences carry their own per-period amount. */
  perOccurrenceAmount: boolean;
  /** True when the occurrence total is assembled from charge line items. */
  usesCharges: boolean;
  /** True when the model recurs at all. */
  recurs: boolean;
}> = [
  {
    key: "fixed", label: "Fixed", recurs: true,
    description: "Same amount every billing cycle.",
    perOccurrenceAmount: false, usesCharges: false,
  },
  {
    key: "variable", label: "Variable", recurs: true,
    description: "Recurs on schedule, but the amount changes each cycle.",
    perOccurrenceAmount: true, usesCharges: true,
  },
  {
    key: "usage_based", label: "Usage-based", recurs: true,
    description: "A base amount plus whatever usage or credits were added this period.",
    perOccurrenceAmount: true, usesCharges: true,
  },
  {
    key: "one_time", label: "One-time", recurs: false,
    description: "A single bill or amount owed, with no recurrence.",
    perOccurrenceAmount: true, usesCharges: true,
  },
  {
    key: "installment", label: "Installment / loan", recurs: true,
    description: "A balance that decreases as payments are made.",
    perOccurrenceAmount: false, usesCharges: false,
  },
];

const BILLING_MODEL_KEYS = new Set<string>(BILLING_MODELS.map((m) => m.key));

export function billingModelMeta(model: BillingModel) {
  return BILLING_MODELS.find((m) => m.key === model) ?? BILLING_MODELS[0];
}

/** Free-text → a canonical billing model, or null when nothing matches. */
export function normalizeBillingModel(input?: string | null): BillingModel | null {
  const s = String(input ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return null;
  if (BILLING_MODEL_KEYS.has(s)) return s as BillingModel;
  if (["variable_recurring", "varies", "changing", "estimated"].includes(s)) return "variable";
  if (["usage", "metered", "consumption", "usage_based_recurring", "pay_as_you_go", "prepaid_credits"].includes(s)) return "usage_based";
  if (["once", "onetime", "single", "one_off"].includes(s)) return "one_time";
  if (["loan", "amortizing", "installments", "financing"].includes(s)) return "installment";
  if (["flat", "same", "static", "recurring"].includes(s)) return "fixed";
  return null;
}

/**
 * The billing model for a liability.
 *
 * Explicit `fields.billingModel` always wins — the user (or the AI) said so.
 * Otherwise fall back to the behavioral family so every liability that existed
 * before this module still resolves to something sane WITHOUT a migration:
 * loans and cards amortize (installment), one-off debts are one_time, and a
 * recurring service bill is fixed until someone says it varies.
 */
export function resolveBillingModel(liability: {
  fields?: Record<string, any> | null;
  type_key?: string | null;
  typeKey?: string | null;
} | null | undefined): BillingModel {
  const f = liability?.fields || {};
  const explicit = normalizeBillingModel(f.billingModel ?? f.billing_model ?? f.amountModel);
  if (explicit) return explicit;
  const fam = liabilityFamily(liability?.type_key ?? liability?.typeKey);
  if (fam === "amortizing" || fam === "revolving") return "installment";
  if (fam === "one_time") return "one_time";
  return "fixed";
}

/** True when this liability's occurrences carry their own amounts. */
export function hasVariableAmounts(liability: any): boolean {
  const m = resolveBillingModel(liability);
  return m === "variable" || m === "usage_based";
}

// ─── Charges ─────────────────────────────────────────────────────────────────

export type ChargeKind =
  /** Replaces the definition's base amount for this period. */
  | "base"
  /** Metered consumption on top of the base. */
  | "usage"
  /** Prepaid credits / top-ups purchased during the period. */
  | "credits"
  /** Overage, late, service or processing fee. */
  | "fee"
  /** Tax or surcharge. */
  | "tax"
  /** A credit against the bill. Stored NEGATIVE. */
  | "discount"
  /** Anything else that moves this period's total. */
  | "adjustment";

export const CHARGE_KINDS: ReadonlyArray<{ key: ChargeKind; label: string; sign: 1 | -1 }> = [
  { key: "base", label: "Base charge", sign: 1 },
  { key: "usage", label: "Usage", sign: 1 },
  { key: "credits", label: "Credits", sign: 1 },
  { key: "fee", label: "Fee", sign: 1 },
  { key: "tax", label: "Tax", sign: 1 },
  { key: "discount", label: "Discount", sign: -1 },
  { key: "adjustment", label: "Adjustment", sign: 1 },
];

const CHARGE_KIND_KEYS = new Set<string>(CHARGE_KINDS.map((c) => c.key));

export function normalizeChargeKind(input?: string | null): ChargeKind {
  const s = String(input ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CHARGE_KIND_KEYS.has(s)) return s as ChargeKind;
  if (["credit", "topup", "top_up", "tokens", "prepaid"].includes(s)) return "credits";
  if (["overage", "metered", "consumption", "api_usage"].includes(s)) return "usage";
  if (["late_fee", "service_fee", "surcharge"].includes(s)) return "fee";
  if (["subscription", "plan", "base_price", "base_subscription"].includes(s)) return "base";
  if (["refund", "rebate", "credit_back"].includes(s)) return "discount";
  return "adjustment";
}

export interface OccurrenceCharge {
  /** Stable id so a charge can be edited or removed without ambiguity. */
  id: string;
  kind: ChargeKind;
  label?: string;
  /** Signed dollars. Discounts are stored negative. */
  amount: number;
  /** YYYY-MM-DD the charge was incurred. Informational — the OCCURRENCE the
   *  charge is filed under is what decides which billing period it belongs to. */
  date?: string;
  notes?: string;
  /** Who added it: the user, the AI chat, or an import. */
  source?: "user" | "ai" | "import" | "system";
  createdAt?: string;
}

// ─── Occurrence override ─────────────────────────────────────────────────────

export type OccurrenceOverrideStatus = "paid" | "skipped";

/**
 * The stored state of ONE billing period, living in
 * `liability.fields.occurrences[<canonical YYYY-MM-DD>]`.
 *
 * Everything here is optional: an occurrence with no override at all is a plain
 * instance of the definition. The moment a period records anything of its own —
 * an estimate, a charge, an actual amount, a payment — that period is pinned
 * and no edit to the definition can rewrite it.
 */
export interface OccurrenceOverride {
  status?: OccurrenceOverrideStatus;
  /** Per-occurrence reschedule target (YYYY-MM-DD). */
  movedTo?: string;
  notes?: string;
  /** liability_payments row id, set when the occurrence is paid. */
  paymentId?: string;
  /** Account the payment came out of (a `type: "account"` profile id). */
  accountId?: string;
  /**
   * Legacy per-occurrence amount, and still the field a manual "amount for this
   * occurrence" edit writes. Treated as the base for this period.
   */
  amount?: number;
  /** What we EXPECT this period to cost, before it posts. */
  estimatedAmount?: number;
  /** What was ACTUALLY charged. Authoritative once set — this is history. */
  actualAmount?: number;
  /** What was actually paid (may differ from actualAmount on a partial pay). */
  paidAmount?: number;
  /** Line items accrued during this period. */
  charges?: OccurrenceCharge[];
  /** When the actual amount posted. */
  postedAt?: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Charges on an override, normalized and safe to iterate. */
export function occurrenceCharges(override: OccurrenceOverride | null | undefined): OccurrenceCharge[] {
  const raw = override?.charges;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === "object")
    .map((c: any, i: number) => ({
      id: String(c.id ?? `charge-${i}`),
      kind: normalizeChargeKind(c.kind),
      label: c.label ? String(c.label) : undefined,
      amount: num(c.amount) ?? 0,
      date: c.date ? String(c.date).slice(0, 10) : undefined,
      notes: c.notes ? String(c.notes) : undefined,
      source: c.source,
      createdAt: c.createdAt ? String(c.createdAt) : undefined,
    }));
}

export interface OccurrenceAmount {
  /** The base/expected portion before charges. */
  base: number;
  /** Sum of every charge line item (discounts subtract). */
  chargeTotal: number;
  charges: OccurrenceCharge[];
  /** The estimate for this period, or null when none was recorded. */
  estimated: number | null;
  /** The posted amount, or null while the bill has not posted. */
  actual: number | null;
  /** THE number to display and to sum. */
  current: number;
  /** True while `current` is still a forecast rather than a posted charge. */
  isEstimate: boolean;
  /** "Estimated" | "Current" | "Actual" — the word to render beside `current`. */
  label: "Estimated" | "Current" | "Actual";
  /** The billing model this was resolved under. */
  billingModel: BillingModel;
}

/**
 * Resolve what ONE billing period costs.
 *
 * The rule is a single line, and it is the same for every billing model:
 *
 *     current = actualAmount ?? (base + sum(charges))
 *
 * where `base` is the occurrence's own amount, else its estimate, else the
 * definition's amount — UNLESS a charge of kind "base" was filed for the
 * period, in which case that charge IS the base and the definition's amount is
 * not added on top (otherwise a recorded "$20 base subscription" would double).
 *
 * That one rule produces every behaviour the product needs:
 *
 *   fixed        → no charges, no estimate  → definition amount.
 *   variable     → estimate $35             → "Estimated $35"
 *                  + $15 usage              → "Current $50"
 *                  bill posts at $50        → "Actual $50", frozen forever.
 *   usage_based  → $20 base + $14 credits + $8 usage → $42.
 *   installment  → the scheduled payment, per the definition.
 */
export function resolveOccurrenceAmount(
  /** The definition's base amount for one period. */
  definitionAmount: number,
  override: OccurrenceOverride | null | undefined,
  billingModel: BillingModel = "fixed",
): OccurrenceAmount {
  const charges = occurrenceCharges(override);
  const chargeTotal = round2(charges.reduce((s, c) => s + (c.amount || 0), 0));
  const hasExplicitBase = charges.some((c) => c.kind === "base");

  const ownAmount = num(override?.amount);
  const estimated = num(override?.estimatedAmount);
  const actual = num(override?.actualAmount);

  const base = hasExplicitBase
    ? 0
    : (ownAmount ?? estimated ?? (Number.isFinite(definitionAmount) ? definitionAmount : 0));

  const computed = round2(base + chargeTotal);
  const current = actual != null ? round2(actual) : computed;

  // An amount is a forecast only while nothing has posted AND the model is one
  // whose amount genuinely moves. A fixed bill's $86.50 is not "estimated".
  const variableModel = billingModel === "variable" || billingModel === "usage_based";
  const isEstimate = actual == null && variableModel;
  const label: OccurrenceAmount["label"] = actual != null
    ? "Actual"
    : (isEstimate && chargeTotal !== 0 ? "Current" : isEstimate ? "Estimated" : "Actual");

  return {
    base: round2(base),
    chargeTotal,
    charges,
    estimated: estimated ?? (variableModel && actual == null ? round2(computed) : null),
    actual: actual != null ? round2(actual) : null,
    current,
    isEstimate,
    label: variableModel ? label : "Actual",
    billingModel,
  };
}

// ─── Pure mutators ───────────────────────────────────────────────────────────
//
// Every one returns a NEW override object. Storage writes the result back into
// `fields.occurrences[date]`; nothing here touches the definition.

/** Deterministic-enough charge id. Not a uuid — it only has to be unique within
 *  one occurrence, and staying dependency-free keeps this module isomorphic. */
export function newChargeId(seed?: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `chg_${Date.now().toString(36)}${seed ? `_${seed}` : ""}_${rand}`;
}

export interface ChargeInput {
  amount: number;
  kind?: string | null;
  label?: string | null;
  date?: string | null;
  notes?: string | null;
  source?: OccurrenceCharge["source"];
  id?: string;
}

/**
 * File a charge against one billing period.
 *
 * A discount is stored negative whatever sign the caller passed, so
 * "add a $5 discount" and "add -$5" mean the same thing.
 */
export function addCharge(
  override: OccurrenceOverride | null | undefined,
  input: ChargeInput,
  nowISO?: string,
): OccurrenceOverride {
  const kind = normalizeChargeKind(input.kind);
  const magnitude = Math.abs(num(input.amount) ?? 0);
  const signed = kind === "discount" ? -magnitude : (num(input.amount) ?? 0);
  const charge: OccurrenceCharge = {
    id: input.id || newChargeId(kind),
    kind,
    amount: round2(signed),
    ...(input.label ? { label: String(input.label) } : {}),
    ...(input.date ? { date: String(input.date).slice(0, 10) } : {}),
    ...(input.notes ? { notes: String(input.notes) } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt: nowISO || new Date().toISOString(),
  };
  return { ...(override || {}), charges: [...occurrenceCharges(override), charge] };
}

export function removeCharge(
  override: OccurrenceOverride | null | undefined,
  chargeId: string,
): OccurrenceOverride {
  return { ...(override || {}), charges: occurrenceCharges(override).filter((c) => c.id !== chargeId) };
}

/** Set (or clear, with null) what we expect this period to cost. */
export function setEstimate(
  override: OccurrenceOverride | null | undefined,
  amount: number | null,
): OccurrenceOverride {
  const next: OccurrenceOverride = { ...(override || {}) };
  if (amount == null) delete next.estimatedAmount;
  else next.estimatedAmount = round2(Number(amount) || 0);
  return next;
}

/**
 * Record what actually posted. This freezes the period: `resolveOccurrenceAmount`
 * stops recomputing from charges, so later edits to the definition — or a stray
 * charge — can no longer move a historical bill.
 */
export function setActual(
  override: OccurrenceOverride | null | undefined,
  amount: number | null,
  postedAtISO?: string,
): OccurrenceOverride {
  const next: OccurrenceOverride = { ...(override || {}) };
  if (amount == null) {
    delete next.actualAmount;
    delete next.postedAt;
    return next;
  }
  next.actualAmount = round2(Number(amount) || 0);
  next.postedAt = postedAtISO || new Date().toISOString();
  return next;
}

// ─── Period selection ────────────────────────────────────────────────────────

/** The YYYY-MM billing period a date falls in. */
export function periodKey(dateISO: string): string {
  return String(dateISO || "").slice(0, 7);
}

export interface PeriodSelectable {
  date: string;
  effectiveDate: string;
  status?: string;
}

/**
 * Resolve a human period reference — "this month", "august", "2026-08",
 * "2026-08-20", "next" — to ONE occurrence in a generated schedule.
 *
 * This is what keeps "I spent another $30 on ChatGPT credits this month" from
 * creating a second liability: the charge has to land on an EXISTING occurrence
 * of an EXISTING definition, and if we can't find one we say so rather than
 * inventing anything.
 */
export function findOccurrenceForPeriod<T extends PeriodSelectable>(
  occurrences: readonly T[],
  selector: string | null | undefined,
  todayISO: string,
): T | null {
  const list = Array.isArray(occurrences) ? occurrences : [];
  if (list.length === 0) return null;
  const sel = String(selector ?? "").trim().toLowerCase();

  const open = list.filter((o) => o.status !== "paid" && o.status !== "skipped");

  if (!sel || sel === "current" || sel === "this month" || sel === "this_month") {
    // The period we're living in: the occurrence whose month is this month,
    // else the next open one.
    const thisMonth = periodKey(todayISO);
    return list.find((o) => periodKey(o.date) === thisMonth)
      ?? open.find((o) => o.date >= todayISO)
      ?? open[0]
      ?? null;
  }
  if (sel === "next" || sel === "upcoming" || sel === "next month" || sel === "next_month") {
    if (sel.startsWith("next month") || sel === "next_month") {
      const d = new Date(todayISO + "T00:00:00");
      d.setMonth(d.getMonth() + 1);
      const nextMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const hit = list.find((o) => periodKey(o.date) === nextMonth);
      if (hit) return hit;
    }
    return open.find((o) => o.date >= todayISO) ?? open[0] ?? null;
  }
  if (sel === "last" || sel === "previous" || sel === "last month" || sel === "last_month") {
    const d = new Date(todayISO + "T00:00:00");
    d.setMonth(d.getMonth() - 1);
    const lastMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return list.find((o) => periodKey(o.date) === lastMonth) ?? null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(sel)) {
    return list.find((o) => o.date === sel || o.effectiveDate === sel) ?? null;
  }
  if (/^\d{4}-\d{2}$/.test(sel)) {
    return list.find((o) => periodKey(o.date) === sel) ?? null;
  }
  // A bare month name ("august") means the one in the current year, and if that
  // month is already behind us by more than a little, the coming one.
  const monthIdx = MONTH_NAMES.findIndex((m) => sel.startsWith(m));
  if (monthIdx >= 0) {
    const year = Number(todayISO.slice(0, 4));
    const key = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
    return list.find((o) => periodKey(o.date) === key)
      ?? list.find((o) => periodKey(o.date) === `${year + 1}-${String(monthIdx + 1).padStart(2, "0")}`)
      ?? null;
  }
  return null;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
