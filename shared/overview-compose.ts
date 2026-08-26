// ── Overview composition (2026-08-26) ────────────────────────────────────────
// Turns canonical entity data + relationships (+ optional AI hints) into an
// OverviewSpec. Pure and synchronous: same inputs → same spec, no I/O, no
// model call, no clock except the `now` you hand it.
//
// The important property: VALUES ARE RESOLVED HERE, EVERY TIME. The AI hints
// this consumes describe SHAPE only (what to call a field, how important it
// is, which card it belongs in). Every number, date and string on the returned
// spec is read out of the canonical record on this call, so a layout cached
// from last week can never render last week's balance.
//
// Pinned by tests/overview-compose.test.ts.

import { parseMoney } from "./asset-value";
import { toMonthlyAmount } from "./obligation-windows";
import { canonicalFieldKey } from "./profile-field-canon";
import { humanizeFieldName } from "./field-label";
import {
  ACTIONABLE_DATE_MEANINGS,
  classifyOverviewEntity,
  fieldSemantics,
  groupOrderFor,
  isAdministrativeKey,
  type OverviewEntityClassification,
} from "./overview-semantics";
import {
  overviewSignature,
  type Importance,
  type OverviewAttentionItem,
  type OverviewMissingItem,
  type OverviewRelationship,
  type OverviewSchemaHints,
  type OverviewSection,
  type OverviewSpec,
  type OverviewValue,
} from "./overview-spec";

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ComposeEntity {
  id: string;
  name: string;
  type?: string | null;
  type_key?: string | null;
  tags?: string[] | null;
  fields?: Record<string, any> | null;
  notes?: string | null;
  updatedAt?: string | null;
}

/** A linked record summarized on this Overview. Its values stay ITS values —
 *  we render a view of them and point `sourceReference` back at it. */
export interface ComposeRelated {
  id: string;
  name: string;
  kind: string;                       // profile type / type_key
  relation: RelationKind;
  fields?: Record<string, any> | null;
}

export type RelationKind =
  | "financing" | "insurance" | "warranty" | "contains" | "containedBy"
  | "obligation" | "linked";

export interface ComposeOwner {
  profileId: string;
  name: string;
  percentage: number;
}

export interface ComposeDocument {
  id: string;
  name: string;
  type?: string | null;
  createdAt?: string | null;
}

export interface ComposeObligation {
  id?: string;
  name: string;
  amount?: number | string | null;
  frequency?: string | null;
  nextDueDate?: string | null;
  autopay?: boolean | null;
}

export interface ComposeInput {
  entity: ComposeEntity;
  owners?: ComposeOwner[];
  related?: ComposeRelated[];
  documents?: ComposeDocument[];
  obligations?: ComposeObligation[];
  /** Rolled-up spend against this entity. Totals, not rows. */
  expenses?: { count: number; total: number; monthlyAverage?: number | null };
  income?: { total: number; monthlyAverage?: number | null } | null;
  maintenance?: { lastServiceDate?: string | null; nextServiceDate?: string | null; openItems?: number | null } | null;
  timeline?: Array<{ title: string; timestamp: string; type?: string }>;
  hints?: OverviewSchemaHints | null;
  now?: Date;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MS_DAY = 86_400_000;

function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const s = typeof v === "string" ? v : String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_DAY);
}

/**
 * Monthly-equivalent of an amount on a frequency. The cadence→multiplier math
 * itself belongs to toMonthlyAmount(); this only maps the free-text cadences
 * that reach an Overview ("every other month", "one-time") onto the canonical
 * vocabulary. Unknown cadence → already monthly, the one assumption that
 * cannot silently 12x a number.
 */
export function monthlyEquivalent(amount: number, frequency?: string | null): number {
  const f = String(frequency || "monthly").toLowerCase().trim();
  if (/one.?time|once/.test(f)) return 0;
  if (/bi.?month|every other month/.test(f)) return amount / 2;
  const canonical =
    /bi.?week|fortnight|every other week|every.?2.?weeks/.test(f) ? "biweekly"
      : /week/.test(f) ? "weekly"
      : /day|daily/.test(f) ? "daily"
      : /quarter/.test(f) ? "quarterly"
      : /semi|half.?year|6 ?month/.test(f) ? "semiannual"
      : /year|annual/.test(f) ? "annual"
      : "monthly";
  return toMonthlyAmount(amount, canonical);
}

function firstMoney(fields: Record<string, any>, keys: string[]): { key: string; value: number } | null {
  for (const k of keys) {
    if (!hasValue(fields[k])) continue;
    const n = parseMoney(fields[k]);
    if (Number.isFinite(n) && n !== 0) return { key: k, value: n };
  }
  return null;
}

/** Canonicalize a field bag: alias spellings collapse, admin keys drop out,
 *  empty values drop out. Everything downstream reads THIS, so "marketValue"
 *  and "currentValue" can never both render. */
function canonicalFields(raw: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!hasValue(v)) continue;
    if (isAdministrativeKey(k)) continue;
    const key = canonicalFieldKey(k);
    if (!(key in out)) out[key] = v;
  }
  return out;
}

function valueFor(
  key: string,
  raw: any,
  entityId: string,
  hints: OverviewSchemaHints | null | undefined,
): OverviewValue {
  const sem = fieldSemantics(key, raw);
  const hint = hints?.fieldHints?.[key];
  const displayType = hint?.displayType || sem.displayType;
  const isMoney = displayType === "money" || displayType === "moneyPerMonth";
  const value = isMoney && typeof raw !== "number" && hasValue(raw) ? parseMoney(raw) : raw;
  return {
    semanticKey: sem.key,
    label: hint?.label || sem.label,
    value: Array.isArray(value) ? value.join(", ") : (typeof value === "object" ? JSON.stringify(value) : value),
    displayType,
    importance: hint?.importance || sem.importance,
    provenance: "user",
    sourceReference: { kind: "field", fieldKey: sem.key, entityId },
    dateMeaning: hint?.dateMeaning || sem.dateMeaning,
    editable: { profileId: entityId, fieldKey: sem.key },
  };
}

// ── Derived financial intelligence ───────────────────────────────────────────

const VALUE_KEYS = ["currentValue", "estimatedValue", "appraisedValue", "assessedValue", "marketValue"];
const PURCHASE_KEYS = ["purchasePrice", "originalPrice", "costBasis"];
const BALANCE_KEYS = ["balance", "principal", "payoffAmount", "statementBalance"];
const ORIGINAL_DEBT_KEYS = ["originalPrincipal", "originalBalance", "loanAmount", "originalAmount"];
const PAYMENT_KEYS = ["monthlyPayment", "minimumPayment", "payment", "premium"];

function derived(
  semanticKey: string,
  label: string,
  value: number | null,
  inputs: string[],
  opts: Partial<OverviewValue> = {},
): OverviewValue {
  return {
    semanticKey,
    label,
    value,
    displayType: "money",
    importance: "primary",
    provenance: "calculated",
    sourceReference: { kind: "derived", inputs },
    ...opts,
  };
}

export interface DerivedMetrics {
  metrics: OverviewValue[];
  /** Field keys already represented by a derived metric — used to keep the
   *  same number from printing three times under three names. */
  consumedKeys: Set<string>;
  linkedDebt: number | null;
  monthlyCarryingCost: number | null;
  ownedPercentage: number | null;
}

/**
 * Everything computable from what's actually present. Nothing is invented: a
 * metric appears only when every input it names exists, and each metric
 * carries `sourceReference.inputs` so the reader can see what it was built
 * from. These are DISPLAY values — nothing here is written back as a stored
 * fact unless the user explicitly saves it.
 */
export function computeDerivedMetrics(
  input: ComposeInput,
  classification: OverviewEntityClassification,
  fields: Record<string, any>,
): DerivedMetrics {
  const metrics: OverviewValue[] = [];
  const consumedKeys = new Set<string>();
  const related = input.related || [];
  const isLiability = classification.entityClass === "liability";

  const value = firstMoney(fields, VALUE_KEYS);
  const purchase = firstMoney(fields, PURCHASE_KEYS);
  const balance = firstMoney(fields, BALANCE_KEYS);
  const originalDebt = firstMoney(fields, ORIGINAL_DEBT_KEYS);
  const payment = firstMoney(fields, PAYMENT_KEYS);

  // Debt attached to this asset, owned by the liabilities themselves.
  const financing = related.filter(r => r.relation === "financing");
  const linkedDebt = financing.length
    ? financing.reduce((sum, r) => {
        const b = firstMoney(canonicalFields(r.fields), BALANCE_KEYS);
        return sum + (b?.value || 0);
      }, 0)
    : null;

  // Appreciation / depreciation — only with both endpoints.
  if (value && purchase) {
    const delta = value.value - purchase.value;
    const pct = purchase.value !== 0 ? (delta / purchase.value) * 100 : 0;
    metrics.push(derived(
      delta >= 0 ? "appreciation" : "depreciation",
      delta >= 0 ? "Appreciation" : "Depreciation",
      delta,
      [value.key, purchase.key],
      {
        tone: delta >= 0 ? "positive" : "negative",
        note: `${delta >= 0 ? "+" : ""}${pct.toFixed(1)}% vs purchase`,
      },
    ));
  }

  // Equity — value minus what is still owed against it.
  if (value && linkedDebt != null && linkedDebt > 0) {
    metrics.push(derived("equity", "Estimated equity", value.value - linkedDebt, [value.key, "linkedLiability.balance"], {
      note: financing.length === 1 ? `after ${financing[0].name}` : `after ${financing.length} liabilities`,
    }));
    consumedKeys.add("__linkedDebt");
  }

  // Ownership-adjusted value — only when the user does NOT own all of it.
  const owners = input.owners || [];
  const ownedPercentage = owners.length
    ? owners.reduce((s, o) => s + (Number(o.percentage) || 0), 0)
    : null;
  if (value && ownedPercentage != null && ownedPercentage > 0 && ownedPercentage < 100) {
    metrics.push(derived("ownershipAdjustedValue", "Your share", (value.value * ownedPercentage) / 100, [value.key, "ownership.percentage"], {
      note: `${ownedPercentage}% ownership`,
    }));
  }

  // Payoff progress — a liability's most useful single number after balance.
  if (isLiability && balance && originalDebt && originalDebt.value > 0) {
    const paid = originalDebt.value - balance.value;
    const pct = Math.max(0, Math.min(100, (paid / originalDebt.value) * 100));
    metrics.push(derived("payoffProgress", "Paid off", pct, [balance.key, originalDebt.key], {
      displayType: "percent",
      tone: "positive",
      note: `${fmtShortMoney(paid)} of ${fmtShortMoney(originalDebt.value)}`,
    }));
  }

  // Remaining payments — from the two numbers that make it honest.
  if (isLiability && balance && payment && payment.value > 0) {
    const rate = Number(fields.interestRate ?? fields.apr ?? 0);
    // With no rate we can still say how many payments of this size remain.
    if (!rate) {
      metrics.push(derived("remainingPayments", "Payments remaining", Math.ceil(balance.value / payment.value), [balance.key, payment.key], {
        displayType: "number",
        importance: "secondary",
      }));
    }
  }

  // Utilization — wherever a balance sits against a limit. Generic on
  // purpose: a credit line, a gift card, a storage unit's capacity contract —
  // anything that records both reads the same way.
  const limit = firstMoney(fields, ["creditLimit", "limit", "creditLine"]);
  if (limit && balance && limit.value > 0) {
    const pct = (balance.value / limit.value) * 100;
    metrics.push(derived("utilization", "Utilization", pct, [balance.key, limit.key], {
      displayType: "percent",
      tone: pct >= 80 ? "negative" : pct >= 30 ? "warning" : "positive",
      note: `${fmtShortMoney(balance.value)} of ${fmtShortMoney(limit.value)}`,
    }));
    metrics.push(derived("availableCredit", "Available", limit.value - balance.value, [limit.key, balance.key], {
      importance: "secondary",
    }));
  }

  // Carrying cost — recurring money this entity costs to hold, from every
  // source we can see: its own financing, its obligations, its spend history.
  let monthly = 0;
  const carryInputs: string[] = [];
  for (const r of financing) {
    const p = firstMoney(canonicalFields(r.fields), PAYMENT_KEYS);
    if (p) { monthly += p.value; carryInputs.push(`${r.name}.${p.key}`); }
  }
  for (const o of input.obligations || []) {
    const amt = parseMoney(o.amount);
    if (Number.isFinite(amt) && amt > 0) {
      monthly += monthlyEquivalent(amt, o.frequency);
      carryInputs.push(`obligation.${o.name}`);
    }
  }
  if (!isLiability && payment && financing.length === 0) {
    // The entity carries its own recurring payment (a premium, a plan fee).
    monthly += payment.value;
    carryInputs.push(payment.key);
  }
  const expenseMonthly = input.expenses?.monthlyAverage;
  if (Number.isFinite(expenseMonthly as number) && (expenseMonthly as number) > 0) {
    monthly += expenseMonthly as number;
    carryInputs.push("expenses.monthlyAverage");
  }
  const monthlyCarryingCost = carryInputs.length ? monthly : null;
  if (monthlyCarryingCost != null && monthlyCarryingCost > 0) {
    metrics.push(derived("monthlyCarryingCost", "Monthly cost", monthlyCarryingCost, carryInputs, {
      displayType: "moneyPerMonth",
      importance: "primary",
    }));
    metrics.push(derived("annualCarryingCost", "Annual cost", monthlyCarryingCost * 12, carryInputs, {
      importance: "secondary",
    }));
  }

  // Spend to date against this entity.
  if (input.expenses && input.expenses.count > 0 && input.expenses.total > 0) {
    metrics.push(derived("totalExpenses", "Spent to date", input.expenses.total, ["expenses"], {
      importance: "secondary",
      sourceReference: { kind: "aggregate", inputs: ["expenses"] },
    }));
  }
  if (input.income && input.income.total > 0) {
    metrics.push(derived("totalIncome", "Income generated", input.income.total, ["income"], {
      importance: "secondary",
      tone: "positive",
      sourceReference: { kind: "aggregate", inputs: ["income"] },
    }));
  }

  // Net contribution to net worth — the number that says what this entity
  // does to the bottom line, ownership-adjusted where we know the share.
  const share = ownedPercentage != null && ownedPercentage > 0 ? ownedPercentage / 100 : 1;
  if (isLiability && balance) {
    metrics.push(derived("netContribution", "Net worth impact", -balance.value * share, [balance.key], {
      tone: "negative",
      importance: "secondary",
    }));
  } else if (value) {
    const net = (value.value - (linkedDebt || 0)) * share;
    metrics.push(derived("netContribution", "Net worth impact", net, [value.key, ...(linkedDebt ? ["linkedLiability.balance"] : [])], {
      tone: net >= 0 ? "positive" : "negative",
      importance: "secondary",
    }));
  }

  return { metrics, consumedKeys, linkedDebt, monthlyCarryingCost, ownedPercentage };
}

function fmtShortMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

// ── Dates & attention ────────────────────────────────────────────────────────

function buildAttention(
  fields: Record<string, any>,
  values: OverviewValue[],
  input: ComposeInput,
  now: Date,
): OverviewAttentionItem[] {
  const items: OverviewAttentionItem[] = [];

  for (const v of values) {
    if (v.displayType !== "date" || !v.dateMeaning || !ACTIONABLE_DATE_MEANINGS.has(v.dateMeaning)) continue;
    const d = toDate(v.value);
    if (!d) continue;
    const days = daysBetween(now, d);
    if (days > 90) continue;
    const severity: OverviewAttentionItem["severity"] = days < 0 ? "critical" : days <= 30 ? "warning" : "info";
    items.push({
      id: `date:${v.semanticKey}`,
      severity,
      title: days < 0
        ? `${v.label} passed ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`
        : days === 0
          ? `${v.label} is today`
          : `${v.label} in ${days} day${days === 1 ? "" : "s"}`,
      date: d.toISOString().slice(0, 10),
      daysUntil: days,
      sourceReference: v.sourceReference,
    });
  }

  for (const o of input.obligations || []) {
    const d = toDate(o.nextDueDate);
    if (!d) continue;
    const days = daysBetween(now, d);
    if (days > 45) continue;
    items.push({
      id: `obligation:${o.id || o.name}`,
      severity: days < 0 ? "critical" : days <= 14 ? "warning" : "info",
      title: days < 0 ? `${o.name} is overdue` : days === 0 ? `${o.name} due today` : `${o.name} due in ${days} days`,
      detail: o.autopay ? "Autopay is on" : undefined,
      date: d.toISOString().slice(0, 10),
      daysUntil: days,
    });
  }

  return items.sort((a, b) => (a.daysUntil ?? 999) - (b.daysUntil ?? 999)).slice(0, 5);
}

// ── Missing information ──────────────────────────────────────────────────────

/** A suggestion is only worth making when it UNLOCKS something concrete for
 *  THIS entity — a metric that is one input short, or a date that would drive
 *  a real reminder. No exhaustive "here is every field you could fill". */
function buildMissingInformation(
  fields: Record<string, any>,
  classification: OverviewEntityClassification,
  d: DerivedMetrics,
  input: ComposeInput,
  hints: OverviewSchemaHints | null | undefined,
): OverviewMissingItem[] {
  const out: OverviewMissingItem[] = [];
  const has = (keys: string[]) => keys.some(k => hasValue(fields[k]));
  const isLiability = classification.entityClass === "liability";
  const push = (item: OverviewMissingItem) => {
    if (!out.some(o => o.semanticKey === item.semanticKey)) out.push(item);
  };

  if (!isLiability) {
    if (has(VALUE_KEYS) && !has(PURCHASE_KEYS)) {
      push({
        semanticKey: "purchasePrice", fieldKey: "purchasePrice", label: "Purchase price",
        reason: "Unlocks appreciation since you bought it", importance: "primary",
        unlocks: "appreciation",
      });
    }
    if (!has(VALUE_KEYS)) {
      push({
        semanticKey: "currentValue", fieldKey: "currentValue", label: "Current value",
        reason: "Needed before this counts toward your net worth", importance: "primary",
        unlocks: "netContribution",
      });
    }
    if (has(VALUE_KEYS) && (input.owners || []).length === 0) {
      push({
        semanticKey: "ownershipPercentage", fieldKey: "ownershipPercentage", label: "Ownership share",
        reason: "Splits the value correctly if you don't own 100%", importance: "secondary",
        unlocks: "ownershipAdjustedValue",
      });
    }
  } else {
    if (!has(BALANCE_KEYS)) {
      push({
        semanticKey: "balance", fieldKey: "balance", label: "Current balance",
        reason: "The one number this liability is judged by", importance: "primary",
        unlocks: "netContribution",
      });
    }
    if (has(BALANCE_KEYS) && !has(ORIGINAL_DEBT_KEYS)) {
      push({
        semanticKey: "originalPrincipal", fieldKey: "originalPrincipal", label: "Original principal",
        reason: "Unlocks payoff progress", importance: "secondary", unlocks: "payoffProgress",
      });
    }
    if (has(BALANCE_KEYS) && !has(["interestRate", "apr"])) {
      push({
        semanticKey: "interestRate", fieldKey: "interestRate", label: "Interest rate",
        reason: "Unlocks payoff timeline and cost of borrowing", importance: "primary",
        unlocks: "payoffDate",
      });
    }
    if (!has(PAYMENT_KEYS)) {
      push({
        semanticKey: "monthlyPayment", fieldKey: "monthlyPayment", label: "Monthly payment",
        reason: "Needed to track what this costs each month", importance: "primary",
        unlocks: "monthlyCarryingCost",
      });
    }
  }

  // A date that would drive a real reminder, where the family expects one.
  const dateKeys = Object.keys(fields).filter(k => fieldSemantics(k, fields[k]).role === "date");
  const hasActionableDate = dateKeys.some(k => ACTIONABLE_DATE_MEANINGS.has(fieldSemantics(k, fields[k]).dateMeaning!));
  if (!hasActionableDate) {
    const byCategory: Record<string, { key: string; label: string; reason: string } | undefined> = {
      insurance: { key: "expirationDate", label: "Policy expiration", reason: "So renewal doesn't sneak up on you" },
      real_estate: { key: "propertyTaxDueDate", label: "Property tax due date", reason: "So the tax deadline shows up on your calendar" },
      vehicle: { key: "registrationExpiration", label: "Registration expiration", reason: "So renewal doesn't sneak up on you" },
      electronics: { key: "warrantyExpiration", label: "Warranty expiration", reason: "So you know how long it's covered" },
      recurring_bill: { key: "nextDueDate", label: "Next due date", reason: "So this bill can be tracked and reminded on" },
    };
    const suggestion = byCategory[classification.semanticCategory];
    if (suggestion) {
      push({
        semanticKey: suggestion.key, fieldKey: suggestion.key, label: suggestion.label,
        reason: suggestion.reason, importance: "secondary",
      });
    }
  }

  // Model suggestions come last and never displace a computed one.
  for (const m of hints?.missingInformation || []) {
    if (hasValue(fields[m.semanticKey])) continue;
    push({
      semanticKey: m.semanticKey,
      fieldKey: m.semanticKey,
      label: m.label || humanizeFieldName(m.semanticKey),
      reason: m.reason || "Suggested for this kind of entity",
      importance: m.importance || "secondary",
    });
  }

  return out.slice(0, 5);
}

// ── Relationship summaries ───────────────────────────────────────────────────

const RELATION_LABEL: Record<RelationKind, string> = {
  financing: "Financing",
  insurance: "Insurance",
  warranty: "Warranty",
  contains: "Contains",
  containedBy: "Part of",
  obligation: "Recurring",
  linked: "Linked",
};

/** Summarize a linked entity WITHOUT flattening it: we read a couple of its
 *  headline facts and keep `sourceReference.entityId` pointed at it, so the
 *  data keeps belonging to the record that owns it. */
function relationshipFor(r: ComposeRelated): OverviewRelationship {
  const f = canonicalFields(r.fields);
  const facts: OverviewValue[] = [];
  const push = (keys: string[], label: string, displayType: OverviewValue["displayType"]) => {
    const hit = firstMoney(f, keys);
    if (!hit) return;
    facts.push({
      semanticKey: hit.key,
      label,
      value: hit.value,
      displayType,
      importance: "primary",
      provenance: "linked",
      sourceReference: { kind: "relationship", fieldKey: hit.key, entityId: r.id, entityName: r.name, entityKind: r.kind },
    });
  };
  if (r.relation === "financing") {
    push(BALANCE_KEYS, "Current balance", "money");
    push(PAYMENT_KEYS, "Monthly payment", "moneyPerMonth");
  } else if (r.relation === "insurance" || r.relation === "warranty") {
    push(["premium", "monthlyPayment"], "Premium", "money");
    push(["deductible"], "Deductible", "money");
    const expires = Object.keys(f).find(k => /expir|renew|coverageEnd/i.test(k));
    if (expires) {
      facts.push({
        semanticKey: expires, label: "Expires", value: f[expires], displayType: "date",
        importance: "primary", provenance: "linked",
        sourceReference: { kind: "relationship", fieldKey: expires, entityId: r.id, entityName: r.name, entityKind: r.kind },
        dateMeaning: "expiration",
      });
    }
  } else {
    push(VALUE_KEYS, "Value", "money");
    push(BALANCE_KEYS, "Balance", "money");
  }
  return {
    relation: r.relation,
    label: RELATION_LABEL[r.relation] || "Linked",
    entityId: r.id,
    entityName: r.name,
    entityKind: r.kind,
    facts,
  };
}

// ── Composition ──────────────────────────────────────────────────────────────

const IMPORTANCE_RANK: Record<Importance, number> = {
  primary: 0, secondary: 1, detailed: 2, administrative: 3,
};

/** Where information we deliberately keep OFF the Overview lives instead. */
const DESTINATIONS: Record<string, string> = {
  specification: "Details",
  contact: "Details",
  note: "Notes",
  administrative: "Details",
};

export function composeOverview(input: ComposeInput): OverviewSpec {
  const now = input.now || new Date();
  const entity = input.entity;
  const fields = canonicalFields(entity.fields);
  const classification = classifyOverviewEntity({
    type: entity.type, type_key: entity.type_key, name: entity.name,
    tags: entity.tags, fields,
  });
  const hints = input.hints || null;
  const related = input.related || [];

  if (hints?.semanticCategory) classification.semanticCategory = hints.semanticCategory;
  if (hints?.entityLabel) classification.entityLabel = hints.entityLabel;
  if (hints?.subtype) classification.subtype = hints.subtype;

  // 1 — every stored fact, classified and resolved.
  const allValues = Object.entries(fields).map(([k, v]) => valueFor(k, v, entity.id, hints));

  // 2 — derived intelligence.
  const d = computeDerivedMetrics(input, classification, fields);

  // 3 — headline. One canonical home for the entity's defining number; every
  //     other appearance of that same number has to earn its place by meaning
  //     something different (value vs debt vs equity), which is what keeps the
  //     old "$345,000 four times" problem from coming back.
  const headlineKeys = classification.entityClass === "liability"
    ? [...BALANCE_KEYS, ...PAYMENT_KEYS]
    : [...VALUE_KEYS, ...PAYMENT_KEYS, ...PURCHASE_KEYS];
  const headlineHit = firstMoney(fields, headlineKeys);
  const headline = headlineHit
    ? allValues.find(v => v.semanticKey === headlineHit.key)
    : undefined;
  const claimed = new Set<string>();
  if (headline) claimed.add(headline.semanticKey);

  // 4 — summary metrics: derived first (they say something the headline
  //     can't), then any model-nominated field, capped so the row stays a row.
  const summaryMetrics: OverviewValue[] = [];
  const pushMetric = (v: OverviewValue | undefined) => {
    if (!v || v.value == null || claimed.has(v.semanticKey)) return;
    if (summaryMetrics.length >= 4) return;
    claimed.add(v.semanticKey);
    summaryMetrics.push(v);
  };
  for (const m of d.metrics) {
    if (m.importance === "primary") pushMetric(m);
  }
  for (const key of hints?.summaryMetricKeys || []) {
    pushMetric(allValues.find(v => v.semanticKey === canonicalFieldKey(key)));
  }
  if (summaryMetrics.length === 0) {
    // Nothing derived — fall back to the strongest primary facts so the top of
    // the page still says something.
    for (const v of allValues.filter(v => v.importance === "primary" && v.displayType !== "date")) {
      pushMetric(v);
      if (summaryMetrics.length >= 3) break;
    }
  }

  const sections: OverviewSection[] = [];
  const routedElsewhere: Array<{ semanticKey: string; destination: string }> = [];

  // 5 — status.
  const statusValue = allValues.find(v => fieldSemantics(v.semanticKey, v.value).role === "status");
  const status = statusValue && typeof statusValue.value === "string"
    ? { label: statusValue.value, tone: statusToneFor(statusValue.value) }
    : undefined;
  if (statusValue) claimed.add(statusValue.semanticKey);

  // 6 — financial summary. Only when there is more than one money fact to
  //     relate; a lone number already lives in the headline.
  const financialValues = [
    ...d.metrics.filter(m => !claimed.has(m.semanticKey) && m.value != null),
  ];
  if (d.linkedDebt != null && d.linkedDebt > 0 && !claimed.has("linkedDebt")) {
    financialValues.unshift({
      semanticKey: "linkedDebt",
      label: "Outstanding debt",
      value: d.linkedDebt,
      displayType: "money",
      importance: "primary",
      provenance: "linked",
      tone: "negative",
      sourceReference: {
        kind: "relationship",
        inputs: related.filter(r => r.relation === "financing").map(r => r.id),
      },
    });
  }
  if (financialValues.length > 0) {
    sections.push({
      id: "financial",
      component: "financialSummary",
      title: "Financial position",
      priority: 10,
      values: financialValues.slice(0, 6),
    });
    financialValues.slice(0, 6).forEach(v => claimed.add(v.semanticKey));
  }

  // 7 — payoff / warranty style progress, when a percentage means something.
  const progress = d.metrics.find(m => m.semanticKey === "payoffProgress");
  if (progress && typeof progress.value === "number") {
    sections.push({
      id: "progress",
      component: "progressIndicator",
      title: "Payoff progress",
      priority: 15,
      data: {
        percent: Math.round(progress.value),
        label: progress.note || "",
        inputs: progress.sourceReference.inputs || [],
      },
    });
  }

  // 8 — ownership.
  if ((input.owners || []).length > 0) {
    sections.push({
      id: "ownership",
      component: "ownershipSummary",
      title: "Ownership",
      priority: 20,
      values: (input.owners || []).map(o => ({
        semanticKey: `owner:${o.profileId}`,
        label: o.name,
        value: o.percentage,
        displayType: "percent" as const,
        importance: "primary" as const,
        provenance: "linked" as const,
        sourceReference: { kind: "relationship" as const, entityId: o.profileId, entityName: o.name, entityKind: "person" },
      })),
    });
  }

  // 9 — relationships that change how the entity is understood.
  const summarizable = related.filter(r => r.relation !== "linked");
  if (summarizable.length > 0) {
    sections.push({
      id: "relationships",
      component: "relationshipSummary",
      title: "Linked records",
      priority: 25,
      relationships: summarizable.slice(0, 6).map(relationshipFor),
    });
  }

  // 10 — dates worth knowing, with what they mean attached.
  const dateValues = allValues
    .filter(v => v.displayType === "date" && !claimed.has(v.semanticKey))
    .map(v => {
      const dt = toDate(v.value);
      return { v, days: dt ? daysBetween(now, dt) : null };
    })
    .filter(x => x.days != null)
    .sort((a, b) => {
      // Upcoming first, then most recent past.
      const av = a.days! >= 0 ? a.days! : 10_000 - a.days!;
      const bv = b.days! >= 0 ? b.days! : 10_000 - b.days!;
      return av - bv;
    });
  const actionableDates = dateValues.filter(x => x.v.dateMeaning && ACTIONABLE_DATE_MEANINGS.has(x.v.dateMeaning));
  if (actionableDates.length > 0) {
    sections.push({
      id: "dates",
      component: "dateCard",
      title: "Important dates",
      priority: 30,
      values: actionableDates.slice(0, 4).map(x => ({ ...x.v, note: relativeNote(x.days!) })),
    });
    actionableDates.slice(0, 4).forEach(x => claimed.add(x.v.semanticKey));
  }

  // 11 — grouped details for everything primary/secondary that hasn't found a
  //      home. Detailed/administrative facts are NOT dumped here; they are
  //      recorded as routed elsewhere so the Overview stays a summary.
  const remaining = allValues.filter(v => !claimed.has(v.semanticKey));
  const groups = new Map<string, OverviewValue[]>();
  for (const v of remaining) {
    const sem = fieldSemantics(v.semanticKey, v.value);
    const rank = IMPORTANCE_RANK[v.importance];
    if (rank >= IMPORTANCE_RANK.detailed) {
      routedElsewhere.push({ semanticKey: v.semanticKey, destination: DESTINATIONS[sem.role] || "Details" });
      continue;
    }
    const title = hints?.fieldHints?.[v.semanticKey]?.group || sem.group;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title)!.push(v);
  }

  const order = hints?.sectionOrder?.length ? hints.sectionOrder : groupOrderFor(classification.semanticCategory);
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Partial-data guard: a handful of facts scattered over four one-row cards
  // reads as an empty profile. Below the threshold they collapse into one.
  const remainingCount = orderedGroups.reduce((n, [, vs]) => n + vs.length, 0);
  if (orderedGroups.length > 2 && remainingCount <= 5) {
    sections.push({
      id: "details",
      component: "groupedDetails",
      title: "Details",
      priority: 40,
      values: orderedGroups.flatMap(([, vs]) => vs),
    });
  } else {
    orderedGroups.forEach(([title, vs], i) => {
      sections.push({
        id: `group:${title.toLowerCase().replace(/\s+/g, "-")}`,
        component: "groupedDetails",
        title,
        priority: 40 + i,
        // Everything past the first two groups opens on demand — progressive
        // disclosure rather than a wall.
        collapsed: i >= 2 || vs.every(v => v.importance !== "primary"),
        values: vs.sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]),
      });
    });
  }

  // 12 — supporting summaries.
  if ((input.documents || []).length > 0) {
    const docs = input.documents!;
    sections.push({
      id: "documents",
      component: "documentSummary",
      title: "Documents",
      priority: 60,
      data: {
        count: docs.length,
        recent: docs.slice(0, 3).map(doc => ({ id: doc.id, name: doc.name, type: doc.type || null, createdAt: doc.createdAt || null })),
      },
    });
  }
  if (input.maintenance && (input.maintenance.lastServiceDate || input.maintenance.nextServiceDate || input.maintenance.openItems)) {
    sections.push({
      id: "maintenance",
      component: "maintenanceSummary",
      title: "Service",
      priority: 65,
      data: {
        lastServiceDate: input.maintenance.lastServiceDate || null,
        nextServiceDate: input.maintenance.nextServiceDate || null,
        openItems: input.maintenance.openItems || 0,
      },
    });
  }
  if ((input.timeline || []).length >= 2) {
    sections.push({
      id: "timeline",
      component: "miniTimeline",
      title: "Recent activity",
      priority: 70,
      collapsed: true,
      data: { events: (input.timeline || []).slice(0, 4) },
    });
  }

  const attentionItems = buildAttention(fields, allValues, input, now);
  const missingInformation = buildMissingInformation(fields, classification, d, input, hints);

  if (missingInformation.length > 0) {
    sections.push({
      id: "missing",
      component: "missingInfo",
      title: "Complete this profile",
      priority: 80,
      data: { items: missingInformation },
    });
  }

  const insights = (hints?.insights || []).map((i, idx) => ({
    id: `insight:${idx}`,
    title: i.title,
    detail: i.detail,
    confidence: i.confidence,
  }));
  if (insights.length > 0) {
    sections.push({
      id: "insights",
      component: "aiInsight",
      title: "AI insight",
      priority: 85,
      data: { insights },
    });
  }

  const subtitleParts = [
    classification.entityLabel,
    ...allValues
      .filter(v => v.importance === "primary" && fieldSemantics(v.semanticKey, v.value).role === "identity")
      .slice(0, 2)
      .map(v => String(v.value)),
  ].filter(p => p && p.toLowerCase() !== entity.name.trim().toLowerCase());

  return {
    identity: {
      profileId: entity.id,
      name: entity.name,
      entityLabel: classification.entityLabel,
      entityClass: classification.entityClass,
      semanticCategory: classification.semanticCategory,
      subtype: classification.subtype,
      subtitle: subtitleParts.length ? [...new Set(subtitleParts)].join(" · ") : undefined,
      status,
      headline,
    },
    summaryMetrics,
    sections: sections.sort((a, b) => a.priority - b.priority),
    attentionItems,
    missingInformation,
    insights,
    meta: {
      signature: overviewSignature({
        type: entity.type,
        typeKey: entity.type_key,
        fieldKeys: Object.keys(fields),
        relationKinds: related.map(r => r.relation),
        hasDocuments: (input.documents || []).length > 0,
      }),
      schemaSource: hints ? "ai-assisted" : "deterministic",
      composedAt: now.toISOString(),
      routedElsewhere: routedElsewhere.length ? routedElsewhere : undefined,
    },
  };
}

function statusToneFor(raw: string): "positive" | "neutral" | "warning" | "critical" {
  const s = raw.toLowerCase();
  if (/(active|good|excellent|current|paid|owned|insured|operational|new)/.test(s)) return "positive";
  if (/(expired|overdue|lapsed|totaled|delinquent|default|repossess|sold)/.test(s)) return "critical";
  if (/(pending|due|needs|fair|poor|maintenance|review|inactive|paused)/.test(s)) return "warning";
  return "neutral";
}

function relativeNote(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  if (days === 0) return "Today";
  if (days < 45) return `in ${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  return `in ${months} month${months === 1 ? "" : "s"}`;
}
