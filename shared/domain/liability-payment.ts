// shared/domain/liability-payment.ts — an obligation is not its payments.
//
// A liability is an OBLIGATION (the auto loan). A payment is ACTIVITY against
// it ($912.40 on the 15th). `storage.createObligation` ends in
// `createProfile({type:"liability"})`, so any door that reached it with a
// payment description minted a second liability beside the loan.
//
// This module decides, before anything is written, whether a write is a new
// liability or a payment against an existing one, and owns the derived
// asset ↔ liability math (equity, loan-to-value, depreciation).
//
// Pure. Pinned by tests/consistency-layer-liabilities.test.ts.

import { normalizeLiabilityName, isPaymentBillName } from "../liability-types";
import { nameLooselyMatches } from "../name-match";

export interface LiabilityLike {
  id: string;
  name: string;
  type?: string | null;
  type_key?: string | null;
  parentProfileId?: string | null;
  fields?: Record<string, any> | null;
}

export interface LiabilityWriteInput {
  name?: string | null;
  description?: string | null;
  amount?: number | null;
  /** The liability the caller already knows this belongs to. */
  linkedLiabilityId?: string | null;
  /** True when the caller is recording money moving. */
  isPayment?: boolean | null;
  date?: string | null;
}

export type LiabilityWriteKind = "payment" | "liability";

export interface LiabilityWriteDecision {
  kind: LiabilityWriteKind;
  /** The liability a payment lands on. */
  targetLiabilityId: string | null;
  targetLiabilityName: string | null;
  reason: string;
}

const PAYMENT_PHRASE = /\b(payment|paid|pay(?:ing)?|installment|instalment|monthly (?:amount|due)|per month|\/mo\b|a month)\b/i;
const NEW_DEBT_PHRASE = /\b(new|opened|took out|borrowed|financed|refinanced|balance of|owe)\b/i;

/**
 * Is this write a payment against an existing liability, or a new liability?
 *
 * A write that names an existing liability (or is linked to one) AND reads
 * as money moving is a payment. A write with no existing target is a new
 * liability. Never both.
 */
export function classifyLiabilityWrite(input: LiabilityWriteInput, existing: readonly LiabilityLike[]): LiabilityWriteDecision {
  const text = `${input.name ?? ""} ${input.description ?? ""}`.trim();
  const linked = input.linkedLiabilityId ? existing.find((l) => l.id === input.linkedLiabilityId) : undefined;
  if (linked) {
    return { kind: "payment", targetLiabilityId: linked.id, targetLiabilityName: linked.name, reason: "linked to an existing liability" };
  }
  const paymentShaped = input.isPayment === true || PAYMENT_PHRASE.test(text) || isPaymentBillName(text);
  const candidateName = normalizeLiabilityName(text.replace(PAYMENT_PHRASE, " ").replace(/\$\s?[\d,.]+/g, " "));
  const target = existing.find((l) => {
    const ln = normalizeLiabilityName(l.name);
    if (!ln || !candidateName) return false;
    return ln === candidateName || nameLooselyMatches(candidateName, ln) || nameLooselyMatches(ln, candidateName)
      || (l.parentProfileId && candidateName && nameLooselyMatches(text, l.name));
  });
  if (target && (paymentShaped || !NEW_DEBT_PHRASE.test(text))) {
    return { kind: "payment", targetLiabilityId: target.id, targetLiabilityName: target.name, reason: paymentShaped ? "names an existing liability as a payment" : "names an existing liability" };
  }
  if (paymentShaped && existing.length > 0 && !NEW_DEBT_PHRASE.test(text)) {
    // A payment with no resolvable target is still not a liability; the
    // caller should ask which one rather than mint a debt.
    return { kind: "payment", targetLiabilityId: null, targetLiabilityName: null, reason: "payment-shaped, target unresolved" };
  }
  return { kind: "liability", targetLiabilityId: null, targetLiabilityName: null, reason: "no existing liability named" };
}

export interface LiabilityPaymentRecord {
  id: string;
  amount: number;
  date: string;
  method?: string | null;
  notes?: string | null;
  /** Principal / interest split when the caller knows it. */
  principal?: number | null;
  interest?: number | null;
}

/** The payment history stored on a liability (`fields.payments`). */
export function paymentHistoryOf(liability: LiabilityLike | null | undefined): LiabilityPaymentRecord[] {
  const raw = liability?.fields?.payments ?? liability?.fields?.paymentHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && typeof p === "object" && Number.isFinite(Number(p.amount))).map((p) => ({
    id: String(p.id ?? `${p.date}-${p.amount}`), amount: Number(p.amount), date: String(p.date ?? ""),
    method: p.method ?? null, notes: p.notes ?? null, principal: p.principal ?? null, interest: p.interest ?? null,
  }));
}

/**
 * Attach a payment INSIDE the liability's history (pure — returns the fields
 * patch). The balance falls by the principal portion; a recurring service bill
 * has no balance and only its due date moves (handled by the bill engine).
 */
export function attachPayment(liability: LiabilityLike, payment: Omit<LiabilityPaymentRecord, "id"> & { id?: string }): Record<string, any> {
  const history = paymentHistoryOf(liability);
  const id = payment.id ?? `pay-${payment.date}-${Math.round(payment.amount * 100)}`;
  if (history.some((p) => p.id === id || (p.date === payment.date && Math.abs(p.amount - payment.amount) < 0.005))) {
    return { payments: history };
  }
  const next = [...history, { ...payment, id }].sort((a, b) => a.date.localeCompare(b.date));
  const patch: Record<string, any> = { payments: next };
  const balance = Number(liability.fields?.balance ?? liability.fields?.currentBalance ?? liability.fields?.currentValue);
  if (Number.isFinite(balance)) {
    const principal = Number.isFinite(Number(payment.principal)) ? Number(payment.principal) : payment.amount;
    patch.balance = Math.max(0, Math.round((balance - principal) * 100) / 100);
  }
  return patch;
}

// ─── Asset ↔ liability derived facts ────────────────────────────────────────

export interface EquityResult {
  assetValue: number;
  liabilityBalance: number;
  /** assetValue − liabilityBalance; negative when underwater. */
  equity: number;
  negative: boolean;
  /** liabilityBalance / assetValue, 0..∞; null when the asset has no value. */
  loanToValue: number | null;
  label: string;
}

export function assetEquity(assetValue: number | null | undefined, liabilityBalance: number | null | undefined): EquityResult {
  const a = Number(assetValue) || 0;
  const l = Number(liabilityBalance) || 0;
  const equity = Math.round((a - l) * 100) / 100;
  const ltv = a > 0 ? Math.round((l / a) * 10000) / 10000 : null;
  return {
    assetValue: a, liabilityBalance: l, equity, negative: equity < 0, loanToValue: ltv,
    label: equity < 0 ? "Negative equity" : "Equity",
  };
}

export interface ValuationPoint { date: string; value: number }

export interface DepreciationResult {
  first: ValuationPoint | null;
  latest: ValuationPoint | null;
  change: number;
  changePct: number | null;
  /** Annualised change, from the first to the latest valuation. */
  annualizedPct: number | null;
  direction: "appreciating" | "depreciating" | "flat" | "unknown";
}

export function depreciation(history: readonly ValuationPoint[]): DepreciationResult {
  const pts = history
    .filter((p) => p && Number.isFinite(Number(p.value)) && /^\d{4}-\d{2}-\d{2}/.test(String(p.date)))
    .map((p) => ({ date: String(p.date).slice(0, 10), value: Number(p.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 2) {
    return { first: pts[0] ?? null, latest: pts[0] ?? null, change: 0, changePct: null, annualizedPct: null, direction: "unknown" };
  }
  const first = pts[0], latest = pts[pts.length - 1];
  const change = Math.round((latest.value - first.value) * 100) / 100;
  const changePct = first.value !== 0 ? change / first.value : null;
  const days = (Date.parse(latest.date) - Date.parse(first.date)) / 86400000;
  const annualizedPct = changePct !== null && days > 0 && first.value > 0
    ? Math.pow(latest.value / first.value, 365 / days) - 1
    : null;
  const direction = Math.abs(change) < 0.005 ? "flat" : change > 0 ? "appreciating" : "depreciating";
  return { first, latest, change, changePct, annualizedPct, direction };
}
