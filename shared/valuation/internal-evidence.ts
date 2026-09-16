// ─── Internal (deterministic) evidence ──────────────────────────────────────
//
// Evidence that needs no network: what the user typed, what a document
// appraised, what was paid, where the asset's own history is heading, and
// what its income would capitalize to. Each observation carries the same
// reliability / relevance / half-life that external evidence does, so the
// engine can weigh a two-year-old purchase against a live comparable on one
// scale. Pure.

import { MS_PER_DAY } from "../obligation-windows";
import type { ValuationContext, ValuationEvidence, ValuationPlan } from "./types";
import { DEFAULT_CURRENCY } from "./types";

const YEAR_DAYS = 365.25;

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return isNaN(d.getTime()) ? null : d;
}

function money(n: number): string { return `$${Math.round(n).toLocaleString()}`; }

/** Annualized drift implied by the last two valued history points. */
export function historyDrift(ctx: ValuationContext): number | null {
  const pts = ctx.history.filter(h => h.status === "valued" && h.value && h.value > 0);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const ta = parseIso(a.valuedAt), tb = parseIso(b.valuedAt);
  if (!ta || !tb) return null;
  const years = (tb.getTime() - ta.getTime()) / (YEAR_DAYS * MS_PER_DAY);
  if (years < 14 / YEAR_DAYS) return null; // two points a week apart say nothing about a year
  const ratio = b.value! / a.value!;
  if (!(ratio > 0)) return null;
  const drift = Math.pow(ratio, 1 / years) - 1;
  return Math.max(-0.6, Math.min(0.6, drift));
}

export function deriveInternalEvidence(ctx: ValuationContext, plan: ValuationPlan, now: Date = new Date()): ValuationEvidence[] {
  const out: ValuationEvidence[] = [];
  const nowIso = now.toISOString();
  const wants = new Set(plan.methods.map(m => m.id));
  const base = { provider: "internal", currency: DEFAULT_CURRENCY, fetchedAt: nowIso, relevance: 1 };

  if (wants.has("user_verified_value") && ctx.userValue) {
    out.push({
      ...base,
      id: `user:${ctx.userValue.key}`, kind: "user_value", source: "Entered by you",
      observedAt: ctx.userValue.asOf ? `${ctx.userValue.asOf}T12:00:00.000Z` : nowIso,
      value: ctx.userValue.value, low: null, high: null,
      reliability: 0.9, halfLifeMs: 180 * MS_PER_DAY,
      reference: `field:${ctx.userValue.key}`,
      note: `You recorded ${money(ctx.userValue.value)}${ctx.userValue.asOf ? ` as of ${ctx.userValue.asOf}` : ""}`,
    });
  }

  if (wants.has("document_appraisal")) {
    ctx.appraisals.forEach((a, i) => {
      out.push({
        ...base,
        id: `appraisal:${i}:${a.source}`, kind: "document_appraisal", source: a.label,
        observedAt: a.date ? `${a.date}T12:00:00.000Z` : nowIso,
        value: a.value, low: null, high: null,
        reliability: a.source.startsWith("document:") ? 0.85 : 0.7,
        halfLifeMs: 365 * MS_PER_DAY,
        reference: a.source,
        note: `${a.label}: ${money(a.value)}${a.date ? ` (${a.date})` : ""}`,
      });
    });
  }

  const price = ctx.purchase.price;
  const purchasedAt = parseIso(ctx.purchase.date);
  if (wants.has("recent_transaction") && price && purchasedAt) {
    out.push({
      ...base,
      id: "purchase", kind: "transaction", source: "Your purchase",
      observedAt: purchasedAt.toISOString(),
      value: price, low: price * 0.93, high: price * 1.05,
      reliability: 0.95, halfLifeMs: 120 * MS_PER_DAY,
      reference: "field:purchasePrice",
      note: `Bought for ${money(price)} on ${ctx.purchase.date}`,
    });
  }

  if (wants.has("value_trajectory") && price) {
    const ageYears = purchasedAt ? Math.max(0, (now.getTime() - purchasedAt.getTime()) / (YEAR_DAYS * MS_PER_DAY)) : (ctx.ageYears ?? null);
    const drift = ctx.understanding?.expectedAnnualChangePct ?? historyDrift(ctx);
    const life = ctx.understanding?.usefulLifeYears ?? null;
    let projected: number;
    let basis: string;
    let reliability: number;
    let spread: number;
    if (ageYears == null) {
      projected = price; basis = "purchase price, age unknown"; reliability = 0.2; spread = 0.4;
    } else if (drift != null) {
      projected = price * Math.pow(1 + drift, ageYears);
      basis = `${money(price)} drifting ${(drift * 100).toFixed(0)}%/yr for ${ageYears.toFixed(1)} yrs`;
      reliability = ctx.understanding?.expectedAnnualChangePct != null ? 0.55 : 0.45;
      spread = Math.min(0.5, 0.12 + 0.06 * ageYears);
    } else if (life && life > 0) {
      projected = price * Math.max(0.1, 1 - ageYears / life);
      basis = `${money(price)} straight-line over a ${life}-year useful life (${ageYears.toFixed(1)} yrs used)`;
      reliability = 0.45; spread = Math.min(0.5, 0.15 + 0.06 * ageYears);
    } else {
      projected = price;
      basis = `${money(price)} paid ${ageYears.toFixed(1)} yrs ago — drift unknown`;
      reliability = 0.3; spread = Math.min(0.6, 0.15 + 0.12 * ageYears);
    }
    // Half of what was spent on improvements is retained, as a rule of thumb.
    const retained = ctx.improvements.upgradesTotal * 0.5;
    if (retained > 0) { projected += retained; basis += ` + ${money(retained)} retained from upgrades`; }
    out.push({
      ...base,
      id: "trajectory", kind: "trajectory", source: "Purchase price trajectory",
      observedAt: nowIso,
      value: Math.max(1, projected), low: projected * (1 - spread), high: projected * (1 + spread),
      reliability, halfLifeMs: 3650 * MS_PER_DAY,
      reference: "field:purchasePrice",
      note: basis,
    });
  }

  if (wants.has("historical_trend")) {
    const pts = ctx.history.filter(h => h.status === "valued" && h.value && h.value > 0);
    const last = pts[pts.length - 1];
    const drift = historyDrift(ctx);
    const lastAt = last ? parseIso(last.valuedAt) : null;
    if (last && lastAt) {
      const years = (now.getTime() - lastAt.getTime()) / (YEAR_DAYS * MS_PER_DAY);
      const projected = drift == null ? last.value! : last.value! * Math.pow(1 + drift, years);
      out.push({
        ...base,
        id: "history-trend", kind: "prior_valuation", source: "Your valuation history",
        observedAt: last.valuedAt,
        value: projected, low: last.low ?? projected * 0.9, high: last.high ?? projected * 1.1,
        reliability: 0.5, relevance: 0.8, halfLifeMs: 180 * MS_PER_DAY,
        note: drift == null
          ? `Last valued at ${money(last.value!)}`
          : `Last valued at ${money(last.value!)}, trending ${(drift * 100).toFixed(0)}%/yr`,
      });
    }
  }

  if (wants.has("income_based") && ctx.income) {
    const annual = ctx.income.monthly * 12;
    out.push({
      ...base,
      id: "income-cap", kind: "income_based", source: "Income capitalization",
      observedAt: nowIso,
      value: annual / 0.08, low: annual / 0.10, high: annual / 0.06,
      reliability: 0.4, relevance: 0.7, halfLifeMs: 365 * MS_PER_DAY,
      note: `${money(annual)}/yr capitalized at 6–10%`,
    });
  }

  return out;
}
