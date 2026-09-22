// shared/domain/dedup.ts — ONE duplicate detector for every record kind.
//
// Ten independent duplicate checks existed (exact-name people, bank-csv
// date|amount|description, a 30-second in-memory chat lock, a fuzzy
// finance-import insight, …) and the three highest-volume creates —
// expenses, events, tasks — had none at the storage chokepoint. "Dinner at
// Chili's — $100 — Aug 9" and "Chilis dinner $100 on August 9" were two rows.
//
// This module scores a candidate against existing records on the fields that
// identify the SAME real-world thing — owner + entity + type + date + amount +
// name/merchant + source — with tolerant text matching, and returns a
// confidence the caller acts on: HIGH → do not create; UNCERTAIN → warn.
//
// Pure. Pinned by tests/consistency-layer-dedup.test.ts.

export type DuplicateConfidence = "high" | "uncertain" | "none";

export interface DedupRecord {
  id?: string;
  /** Record kind: "expense" | "event" | "task" | "profile" | "income" | "payment" | … */
  kind: string;
  /** Owner ids (linkedProfiles / parent). */
  ownerIds?: readonly string[] | null;
  /** Name, title, description or merchant. */
  name?: string | null;
  /** Secondary text (merchant/vendor for an expense, location for an event). */
  merchant?: string | null;
  amount?: number | null;
  /** YYYY-MM-DD */
  date?: string | null;
  /** HH:MM for timed events. */
  time?: string | null;
  /** Sub-type discriminator (profile.type, event.category, obligation.kind). */
  type?: string | null;
  /** Where it came from ("manual" | "chat" | "import" | …). */
  source?: string | null;
  /** The record this one relates to (a payment's liability id, a task's parent). */
  relatedId?: string | null;
}

export interface DuplicateMatch<T extends DedupRecord = DedupRecord> {
  record: T;
  confidence: DuplicateConfidence;
  score: number;
  reasons: string[];
}

export interface DedupResult<T extends DedupRecord = DedupRecord> {
  confidence: DuplicateConfidence;
  /** Best match, when confidence is not "none". */
  match: DuplicateMatch<T> | null;
  /** All candidates above the "uncertain" bar, best first. */
  candidates: DuplicateMatch<T>[];
  /** The sentence to show for an uncertain match. */
  warning: string | null;
}

export const SIMILAR_RECORD_WARNING = "This looks similar to an existing record.";

const STOP = new Set(["a", "an", "the", "at", "on", "in", "for", "of", "to", "and", "with", "my", "our", "from", "by", "&"]);
const MONTHS: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04",
  may: "05", jun: "06", june: "06", jul: "07", july: "07", aug: "08", august: "08", sep: "09", sept: "09",
  september: "09", oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12",
};

/** "Chili's" → "chilis"; strips punctuation, possessives, money and dates. */
export function normalizeText(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’']s?\b/g, "")
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokensOf(s: unknown): string[] {
  return normalizeText(s).split(" ").filter((t) => t && !STOP.has(t));
}

/** Jaccard similarity over content tokens, 0..1. */
export function tokenSimilarity(a: unknown, b: unknown): number {
  const ta = new Set(tokensOf(a));
  const tb = new Set(tokensOf(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** A date named inside free text ("Aug 9", "August 9", "8/9"), as YYYY-MM-DD in `year`. */
export function dateMentionedIn(text: unknown, year: number): string | null {
  const s = String(text ?? "").toLowerCase();
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(s);
  if (m) return `${year}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}`;
  const n = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  if (n) {
    const y = n[3] ? (n[3].length === 2 ? `20${n[3]}` : n[3]) : String(year);
    return `${y}-${n[1].padStart(2, "0")}-${n[2].padStart(2, "0")}`;
  }
  return null;
}

function daysApart(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = /^\d{4}-\d{2}-\d{2}/.exec(String(a || ""));
  const pb = /^\d{4}-\d{2}-\d{2}/.exec(String(b || ""));
  if (!pa || !pb) return null;
  const da = Date.UTC(+pa[0].slice(0, 4), +pa[0].slice(5, 7) - 1, +pa[0].slice(8, 10));
  const db = Date.UTC(+pb[0].slice(0, 4), +pb[0].slice(5, 7) - 1, +pb[0].slice(8, 10));
  return Math.abs(da - db) / 86400000;
}

function amountsAgree(a: number | null | undefined, b: number | null | undefined): boolean | null {
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const tol = Math.max(0.01, Math.abs(a) * 0.005);
  return Math.abs(a - b) <= tol;
}

function ownersOverlap(a?: readonly string[] | null, b?: readonly string[] | null): boolean | null {
  const A = (a || []).filter(Boolean), B = (b || []).filter(Boolean);
  if (A.length === 0 || B.length === 0) return null; // unknown owner on one side — do not block on it
  return A.some((id) => B.includes(id));
}

/**
 * Score one candidate against one existing record. The rules are per kind:
 *   expense/income/payment: amount + date (±1d) + name/merchant similarity
 *   event: date (+time) + title similarity
 *   task: title similarity + same due date (or both undated)
 *   profile: same type + name similarity (people: exact normalized name)
 * Different owners → never a duplicate. Same relatedId + date + amount → high.
 */
export function scoreDuplicate<T extends DedupRecord>(candidate: DedupRecord, existing: T): DuplicateMatch<T> {
  const reasons: string[] = [];
  const none = (why: string): DuplicateMatch<T> => ({ record: existing, confidence: "none", score: 0, reasons: [why] });
  if (candidate.kind !== existing.kind) return none("different kind");
  const owners = ownersOverlap(candidate.ownerIds, existing.ownerIds);
  if (owners === false) return none("different owner");
  if (candidate.type && existing.type && String(candidate.type).toLowerCase() !== String(existing.type).toLowerCase()) {
    return none("different type");
  }

  const nameSim = Math.max(
    tokenSimilarity(candidate.name, existing.name),
    tokenSimilarity(`${candidate.name ?? ""} ${candidate.merchant ?? ""}`, `${existing.name ?? ""} ${existing.merchant ?? ""}`),
    candidate.merchant && existing.merchant ? tokenSimilarity(candidate.merchant, existing.merchant) : 0,
  );
  const amt = amountsAgree(candidate.amount, existing.amount);
  const year = Number(String(candidate.date || existing.date || "").slice(0, 4)) || new Date().getFullYear();
  const cDate = candidate.date || dateMentionedIn(candidate.name, year);
  const eDate = existing.date || dateMentionedIn(existing.name, year);
  const days = daysApart(cDate, eDate);

  let score = 0;
  if (owners === true) { score += 0.1; reasons.push("same owner"); }
  if (candidate.relatedId && existing.relatedId && candidate.relatedId === existing.relatedId) { score += 0.2; reasons.push("same related record"); }

  const moneyKind = /^(expense|income|payment|transaction)$/.test(candidate.kind);
  if (moneyKind) {
    if (amt === false) return none("different amount");
    if (amt === true) { score += 0.35; reasons.push("same amount"); }
    if (days === null) { /* unknown date — rely on text */ }
    else if (days === 0) { score += 0.3; reasons.push("same date"); }
    else if (days <= 1) { score += 0.2; reasons.push("a day apart"); }
    else if (days <= 3) { score += 0.05; reasons.push("within 3 days"); }
    else return none("dates far apart");
    if (nameSim >= 0.5) { score += 0.35; reasons.push("similar description"); }
    else if (nameSim >= 0.25) { score += 0.2; reasons.push("partly similar description"); }
    else if (amt === true && days === 0 && candidate.merchant && existing.merchant && normalizeText(candidate.merchant) === normalizeText(existing.merchant)) {
      score += 0.35; reasons.push("same merchant");
    }
  } else if (candidate.kind === "event") {
    if (days === null || days > 0) {
      if (days !== null && days <= 1 && nameSim >= 0.8) { score += 0.45; reasons.push("same title a day apart"); }
      else return none("different date");
    } else { score += 0.35; reasons.push("same date"); }
    if (candidate.time && existing.time) {
      if (candidate.time.slice(0, 5) === existing.time.slice(0, 5)) { score += 0.15; reasons.push("same time"); }
      else { score -= 0.2; reasons.push("different time"); }
    }
    if (nameSim >= 0.6) { score += 0.45; reasons.push("similar title"); }
    else if (nameSim >= 0.34) { score += 0.25; reasons.push("partly similar title"); }
    else return none("different title");
  } else if (candidate.kind === "task" || candidate.kind === "reminder" || candidate.kind === "habit") {
    const bothUndated = !candidate.date && !existing.date;
    if (bothUndated) { score += 0.2; }
    else if (days === 0) { score += 0.3; reasons.push("same due date"); }
    else if (days !== null && days <= 1) { score += 0.1; }
    else if (candidate.date && existing.date) return none("different due date");
    if (nameSim >= 0.75) { score += 0.55; reasons.push("same title"); }
    else if (nameSim >= 0.5) { score += 0.35; reasons.push("similar title"); }
    else return none("different title");
  } else if (candidate.kind === "profile") {
    const isPerson = /^(person|self|pet)$/i.test(String(candidate.type || ""));
    if (isPerson) {
      if (normalizeText(candidate.name) === normalizeText(existing.name)) { score += 0.9; reasons.push("same name"); }
      else return none("different name");
    } else {
      if (nameSim >= 0.9) { score += 0.75; reasons.push("same name"); }
      else if (nameSim >= 0.6) { score += 0.45; reasons.push("similar name"); }
      else return none("different name");
    }
  } else {
    // Generic: name + date + amount, whichever exist.
    if (nameSim >= 0.75) { score += 0.5; reasons.push("same name"); } else if (nameSim >= 0.5) { score += 0.3; reasons.push("similar name"); } else return none("different name");
    if (days === 0) { score += 0.2; reasons.push("same date"); }
    if (amt === true) { score += 0.2; reasons.push("same amount"); }
  }

  const confidence: DuplicateConfidence = score >= 0.8 ? "high" : score >= 0.5 ? "uncertain" : "none";
  return { record: existing, confidence, score: Math.round(score * 100) / 100, reasons };
}

/**
 * Find the best duplicate of `candidate` among `existing`.
 *
 *   high      → the caller must NOT create a second record
 *   uncertain → create, but show `warning`
 *   none      → create
 */
export function findDuplicate<T extends DedupRecord>(candidate: DedupRecord, existing: readonly T[]): DedupResult<T> {
  const candidates = existing
    .filter((e) => !candidate.id || e.id !== candidate.id)
    .map((e) => scoreDuplicate(candidate, e))
    .filter((m) => m.confidence !== "none")
    .sort((a, b) => b.score - a.score);
  const match = candidates[0] ?? null;
  const confidence = match?.confidence ?? "none";
  return {
    confidence,
    match,
    candidates,
    warning: confidence === "uncertain" ? SIMILAR_RECORD_WARNING : null,
  };
}

// ─── Adapters from app records ──────────────────────────────────────────────

export function dedupRecordFromExpense(e: any): DedupRecord {
  return {
    id: e?.id, kind: "expense", ownerIds: e?.linkedProfiles, name: e?.description, merchant: e?.vendor,
    amount: typeof e?.amount === "number" ? e.amount : Number(e?.amount) || null, date: e?.date ?? null, source: e?.source ?? null,
  };
}
export function dedupRecordFromIncome(i: any): DedupRecord {
  return { id: i?.id, kind: "income", ownerIds: i?.linkedProfiles, name: i?.description, amount: Number(i?.amount) || null, date: i?.date ?? null };
}
export function dedupRecordFromEvent(ev: any): DedupRecord {
  return { id: ev?.id, kind: "event", ownerIds: ev?.linkedProfiles, name: ev?.title, merchant: ev?.location, date: ev?.date ?? null, time: ev?.time ?? null, source: ev?.source ?? null };
}
export function dedupRecordFromTask(t: any): DedupRecord {
  return { id: t?.id, kind: "task", ownerIds: t?.linkedProfiles, name: t?.title, date: t?.dueDate ?? null };
}
export function dedupRecordFromProfile(p: any): DedupRecord {
  return { id: p?.id, kind: "profile", ownerIds: p?.parentProfileId ? [p.parentProfileId] : null, name: p?.name, type: p?.type ?? null };
}
export function dedupRecordFromPayment(p: any): DedupRecord {
  return { id: p?.id, kind: "payment", name: p?.description ?? p?.name, amount: Number(p?.amount) || null, date: p?.date ?? null, relatedId: p?.liabilityId ?? p?.obligationId ?? null };
}

// ─── Activity feed collapse ─────────────────────────────────────────────────

export interface ActivityEntryLike {
  /** Stable id when the emitter knows the canonical action it came from. */
  activityId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  action?: string | null;
  description?: string | null;
  timestamp?: string | null;
}

/**
 * One real-world action → one activity row. Entries sharing an `activityId`
 * collapse; so do entries on the same entity with the same action inside a
 * short window (two internal systems reacting to one change), and entries
 * whose descriptions are near-identical at the same minute.
 */
export function collapseActivityEntries<T extends ActivityEntryLike>(entries: readonly T[], windowMs = 5 * 60_000): T[] {
  const kept: T[] = [];
  const seenActivity = new Set<string>();
  const ts = (e: ActivityEntryLike) => { const t = Date.parse(String(e.timestamp || "")); return Number.isFinite(t) ? t : null; };
  for (const e of entries) {
    if (e.activityId) {
      if (seenActivity.has(e.activityId)) continue;
      seenActivity.add(e.activityId);
      kept.push(e);
      continue;
    }
    const t = ts(e);
    const dup = kept.some((k) => {
      const kt = ts(k);
      const close = t === null || kt === null ? String(k.timestamp || "") === String(e.timestamp || "") : Math.abs(kt - t) <= windowMs;
      if (!close) return false;
      const sameEntity = !!e.entityId && k.entityId === e.entityId && (k.entityType || "") === (e.entityType || "");
      if (sameEntity && (k.action || "") === (e.action || "")) return true;
      return tokenSimilarity(k.description, e.description) >= 0.8;
    });
    if (!dup) kept.push(e);
  }
  return kept;
}
