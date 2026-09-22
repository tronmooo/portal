// shared/entity-integrity.ts — conflicting canonical facts are an integrity
// warning, not a coin toss (Rule 33).
//
// A record that carries `apr: 6` and `annualInterestRate: 0.1` names one fact
// twice with two answers. Before this module, shared/profile-field-canon kept
// both keys ("never lose a differing value") and told nobody, so whichever
// reader probed the aliases first won — 6% on the detail page, 0.1% in chat.
//
// `validateEntityIntegrity(entity)` groups a record's fields by identity
// (shared/profile-field-identity `fieldIdentity`) and reports:
//
//   alias_conflict     same identity, different values (`looselyEqual`)
//   impossible_date    a dated field naming a day that does not exist (Feb 30)
//   negative_money     a money field below zero
//   schedule_conflict  `dueDate` and its mirror `nextDueDate` disagree
//
// `resolveCanonicalFields(fields)` then CHOOSES: the canonical key keeps the
// canonical value, the alternates are dropped from the visible fields and
// parked under `_integrity.stale` (a system field — Rule 25 hides `_`-keys
// from the UI), and the warnings come back so the SERVER can log them
// (server/integrity-log). Nothing here logs or throws: shared stays
// dependency-free and a write is never rejected for carrying a warning.
//
// Pinned by tests/entity-integrity.test.ts.

import { fieldIdentity, normalizeKey } from "./profile-field-identity";
import { canonicalFieldKey, looselyEqual } from "./profile-field-canon";
import { impossibleCalendarDays } from "./date-rules";
import { normalizeDateString } from "./extraction-normalize";

export type IntegrityWarningCode = "alias_conflict" | "impossible_date" | "negative_money" | "schedule_conflict";

export interface IntegrityWarning {
  code: IntegrityWarningCode;
  /** The key that holds (or should hold) the canonical value. */
  canonicalKey: string;
  canonicalValue: unknown;
  /** The other spellings / values that disagree with it. */
  conflicts: Array<{ key: string; value: unknown }>;
  message: string;
}

export interface IntegrityResult {
  ok: boolean;
  warnings: IntegrityWarning[];
}

export interface IntegrityEntity {
  id?: string;
  type?: string;
  fields?: Record<string, any> | null;
}

/** The metadata `resolveCanonicalFields` writes under `fields._integrity`. */
export interface IntegrityMeta {
  /** alternate key → the value it held when it lost to the canonical key */
  stale: Record<string, unknown>;
  /** the warning codes observed at the last resolve */
  codes: IntegrityWarningCode[];
  /** ISO timestamp the caller may stamp; absent when resolved without a clock */
  at?: string;
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Money identities checked for a negative value. */
const MONEY_IDENTITIES: ReadonlySet<string> = new Set(
  ["balance", "monthlyPayment", "currentValue", "purchasePrice", "originalBalance", "amount", "creditLimit", "minimumPayment", "monthlyCost", "cost"].map(fieldIdentity),
);

/**
 * The due-date spellings that are MIRRORS of one another (the pay path writes
 * `dueDate` and `nextDueDate` together) and so must agree. `nextPaymentDate`
 * is deliberately absent: it is the user's explicit "next due" override on a
 * loan, which legitimately differs from the creation-time `dueDate` (shared/
 * loan-facts reads it first) — a difference there is a schedule, not a conflict.
 */
const SCHEDULE_KEYS = ["nextDueDate", "next_due_date", "dueDate", "due_date"] as const;

const moneyNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !/\d/.test(v)) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const fmt = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** "6" vs "6%" vs 6, "$26,000" vs 26000: the same fact written differently. */
const scalarNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !/\d/.test(v)) return null;
  const n = Number(v.trim().replace(/^[$€£]/, "").replace(/[,\s]/g, "").replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
};

/** Two alias values agree when the canon says so or when both parse to one number. */
function valuesAgree(a: unknown, b: unknown): boolean {
  if (looselyEqual(a, b)) return true;
  const na = scalarNumber(a);
  const nb = scalarNumber(b);
  return na != null && nb != null && Math.abs(na - nb) < 1e-9;
}

/**
 * The key that should carry a cluster's value: the canonical spelling when
 * one of the keys IS it (or folds to it through profile-field-canon), else
 * the first key present.
 */
function canonicalKeyFor(keys: string[]): string {
  for (const k of keys) {
    const id = fieldIdentity(k);
    if (canonicalFieldKey(k) === k && (id === k || id === normalizeKey(k))) return k;
  }
  const folded = canonicalFieldKey(keys[0]);
  if (keys.includes(folded)) return folded;
  // The canonical spelling is absent: name it anyway so the caller knows
  // where the value belongs (resolveCanonicalFields writes it there).
  return folded !== keys[0] ? folded : keys[0];
}

/** The value the canonical key should hold for a cluster: the canonical key's own, else the first non-blank. */
function canonicalValueFor(fields: Record<string, any>, canonical: string, keys: string[]): { key: string; value: unknown } {
  if (keys.includes(canonical) && !isBlank(fields[canonical])) return { key: canonical, value: fields[canonical] };
  for (const k of keys) if (!isBlank(fields[k])) return { key: k, value: fields[k] };
  return { key: keys[0], value: fields[keys[0]] };
}

/**
 * Report every way this record contradicts itself. Never throws; an entity
 * without fields is trivially ok.
 */
export function validateEntityIntegrity(entity: IntegrityEntity | null | undefined): IntegrityResult {
  const warnings: IntegrityWarning[] = [];
  const fields = entity?.fields && typeof entity.fields === "object" && !Array.isArray(entity.fields) ? entity.fields : null;
  if (!fields) return { ok: true, warnings };

  // ── alias clusters ────────────────────────────────────────────────────────
  const byIdentity = new Map<string, string[]>();
  for (const key of Object.keys(fields)) {
    if (key.startsWith("_")) continue;
    const v = fields[key];
    if (v && typeof v === "object") continue; // nested groups are not values
    const id = fieldIdentity(key);
    if (!id) continue;
    (byIdentity.get(id) || byIdentity.set(id, []).get(id)!).push(key);
  }
  for (const [, keys] of byIdentity) {
    if (keys.length < 2) continue;
    const canonical = canonicalKeyFor(keys);
    const winner = canonicalValueFor(fields, canonical, keys);
    const conflicts = keys
      .filter((k) => k !== winner.key && !isBlank(fields[k]) && !valuesAgree(fields[k], winner.value))
      .map((k) => ({ key: k, value: fields[k] }));
    if (conflicts.length === 0) continue;
    warnings.push({
      code: "alias_conflict",
      canonicalKey: canonical,
      canonicalValue: winner.value,
      conflicts,
      message: `${canonical} is ${fmt(winner.value)} but ${conflicts.map((c) => `${c.key} is ${fmt(c.value)}`).join(", ")}`,
    });
  }

  // ── impossible calendar days ──────────────────────────────────────────────
  for (const path of impossibleCalendarDays(fields, { contextKey: entity?.type })) {
    const value = path.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), fields);
    warnings.push({
      code: "impossible_date",
      canonicalKey: path,
      canonicalValue: value,
      conflicts: [],
      message: `${path} names a day that does not exist: ${fmt(value)}`,
    });
  }

  // ── negative money ────────────────────────────────────────────────────────
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("_") || !MONEY_IDENTITIES.has(fieldIdentity(key))) continue;
    const n = moneyNumber(value);
    if (n != null && n < 0) {
      warnings.push({ code: "negative_money", canonicalKey: key, canonicalValue: value, conflicts: [], message: `${key} is negative: ${fmt(value)}` });
    }
  }

  // ── schedule conflict ─────────────────────────────────────────────────────
  const dated = SCHEDULE_KEYS
    .filter((k) => !isBlank(fields[k]))
    .map((k) => ({ key: k, value: fields[k], iso: normalizeDateString(fields[k]) }))
    .filter((d) => !!d.iso);
  if (dated.length > 1) {
    const head = dated[0];
    const conflicts = dated.slice(1).filter((d) => d.iso !== head.iso).map((d) => ({ key: d.key, value: d.value }));
    if (conflicts.length > 0) {
      warnings.push({
        code: "schedule_conflict",
        canonicalKey: head.key,
        canonicalValue: head.value,
        conflicts,
        message: `${head.key} is ${fmt(head.value)} but ${conflicts.map((c) => `${c.key} is ${fmt(c.value)}`).join(", ")}`,
      });
    }
  }

  return { ok: warnings.length === 0, warnings };
}

export interface ResolvedFields {
  fields: Record<string, any>;
  warnings: IntegrityWarning[];
  /** True when a key was moved, dropped or parked — the caller has something to write. */
  changed: boolean;
}

/**
 * The fields with every alias cluster collapsed onto its canonical key: the
 * canonical value wins, agreeing alternates are simply dropped, DISAGREEING
 * alternates are parked under `_integrity.stale` so nothing is lost and the
 * UI (which hides `_`-keys) shows one number. Schedule keys are not folded —
 * they are distinct facts — only reported.
 */
export function resolveCanonicalFields(
  fields: Record<string, any> | null | undefined,
  opts: { at?: string } = {},
): ResolvedFields {
  const src = fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};
  const { warnings } = validateEntityIntegrity({ fields: src });
  const out: Record<string, any> = { ...src };
  const stale: Record<string, unknown> = {};
  let changed = false;

  const byIdentity = new Map<string, string[]>();
  for (const key of Object.keys(src)) {
    if (key.startsWith("_")) continue;
    const v = src[key];
    if (v && typeof v === "object") continue;
    const id = fieldIdentity(key);
    if (!id) continue;
    (byIdentity.get(id) || byIdentity.set(id, []).get(id)!).push(key);
  }
  for (const [, keys] of byIdentity) {
    if (keys.length < 2) continue;
    const canonical = canonicalKeyFor(keys);
    const winner = canonicalValueFor(src, canonical, keys);
    for (const k of keys) {
      if (k === canonical) continue;
      const v = src[k];
      if (!isBlank(v) && k !== winner.key && !looselyEqual(v, winner.value)) stale[k] = v;
      delete out[k];
      changed = true;
    }
    out[canonical] = winner.value;
  }

  const codes = warnings.map((w) => w.code);
  if (Object.keys(stale).length > 0 || codes.length > 0) {
    const prior = src._integrity && typeof src._integrity === "object" ? (src._integrity as Partial<IntegrityMeta>) : {};
    const meta: IntegrityMeta = {
      stale: { ...(prior.stale || {}), ...stale },
      codes: [...new Set(codes)],
      ...(opts.at ? { at: opts.at } : {}),
    };
    out._integrity = meta;
    changed = true;
  }
  return { fields: out, warnings, changed };
}

/** The `_integrity` metadata on a fields object, if any. */
export function readIntegrityMeta(fields: Record<string, any> | null | undefined): IntegrityMeta | null {
  const m = fields?._integrity;
  return m && typeof m === "object" ? (m as IntegrityMeta) : null;
}
