// shared/duplicate-guard.ts
//
// Rule 35 — the universal duplicate guard that runs before every CREATE.
//
// Every create surface used to carry its own ad-hoc check (a 2-minute window
// here, a 30-second lock there, a name-only match somewhere else), and the
// ones that had none (income) logged the same paycheck twice. This is the one
// scorer they share. It is pure: the caller fetches the plausible existing
// rows (same owner / date / amount — or all rows for a small table) and the
// guard says how sure it is that the candidate already exists:
//
//   high   — the same operation stamp (requestId / operationId) already landed,
//            or same owner + same date + same amount + same normalized
//            name/description. Reuse the existing row (idempotent create).
//   medium — same owner + amount + date but a different description, or the
//            same normalized name for the same owner created within the recent
//            window (default 2 minutes) but on another date/amount. ASK.
//   low    — nothing of the sort. Create.
//
// Precedents this generalizes: shared/obligation-windows findDuplicatePaycheck
// (pure, source + day + amount) and the confidence ladder in
// shared/extraction-actions resolveEntity.
import { createNameKey } from "./ai-tool-routing";

export type DuplicateTier = "high" | "medium" | "low";

export interface DuplicateCandidate {
  entityType: string;
  ownerIds?: string[];
  date?: string | null;
  amount?: number | null;
  name?: string | null;
  description?: string | null;
  source?: string | null;
  relationshipId?: string | null;
  requestId?: string | null;
  operationId?: string | null;
  /** Clock time (HH:MM) for date-shaped rows such as events. */
  time?: string | null;
}

export interface DuplicateMatch {
  id: string;
  score: number;
  reasons: string[];
}

export interface DuplicateVerdict {
  tier: DuplicateTier;
  matches: DuplicateMatch[];
}

export interface DuplicateGuardOptions {
  now?: Date;
  /** How long a same-name create counts as "just now". Default 2 minutes. */
  recentWindowMs?: number;
}

export const DEFAULT_RECENT_WINDOW_MS = 2 * 60 * 1000;

/** Names normalized like shared/ai-tool-routing createNameKey ("My Rent!" → "rent"). */
export function normalizeDuplicateName(s: unknown): string {
  return createNameKey(typeof s === "string" ? s : s == null ? "" : String(s));
}

function dayOf(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function moneyOf(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function sameMoney(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 0.005;
}

/** The owner ids an existing row carries, whichever spelling the row uses. */
function ownersOf(row: Record<string, any>): string[] {
  const raw = row.ownerIds ?? row.linkedProfiles ?? row.linked_profiles ?? row.profileId ?? row.profile_id ?? row.ownerProfileId ?? row.owner_profile_id;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string" && !!x);
  if (typeof raw === "string" && raw) return [raw];
  return [];
}

/**
 * Do two owner lists describe the same owner? An unowned row (no owners)
 * compares equal to an unowned candidate only; otherwise the primary owners
 * (first ids) must agree, or the sets must intersect.
 */
function sameOwner(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  if (a[0] === b[0]) return true;
  const set = new Set(a);
  for (const id of b) if (set.has(id)) return true;
  return false;
}

function rowStamp(row: Record<string, any>, key: "requestId" | "operationId"): string {
  const snake = key === "requestId" ? "request_id" : "operation_id";
  const v = row[key] ?? row[snake] ?? row[`__${key}`] ?? row.metadata?.[key] ?? row.metadata?.[snake];
  return typeof v === "string" ? v : "";
}

function createdAtMs(row: Record<string, any>): number | null {
  const v = row.createdAt ?? row.created_at ?? row.timestamp;
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The label a row goes by: its name, else its description/title/source. */
function labelOf(row: Record<string, any>): string {
  const v = row.name ?? row.title ?? row.description ?? row.source;
  return normalizeDuplicateName(v);
}

function candidateLabel(c: DuplicateCandidate): string {
  return normalizeDuplicateName(c.name ?? c.description ?? c.source ?? "");
}

/**
 * Score `existing` rows against a candidate create. Rows are the storage's
 * own shapes (camelCase or snake_case both work). See the module comment for
 * the tiers.
 */
export function findPossibleDuplicates(
  candidate: DuplicateCandidate,
  existing: ReadonlyArray<Record<string, any>> | null | undefined,
  opts: DuplicateGuardOptions = {},
): DuplicateVerdict {
  const now = (opts.now ?? new Date()).getTime();
  const window = opts.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const owners = (candidate.ownerIds || []).filter(Boolean);
  const day = dayOf(candidate.date);
  const amount = moneyOf(candidate.amount);
  const label = candidateLabel(candidate);
  const reqId = candidate.requestId || "";
  const opId = candidate.operationId || "";
  const relId = candidate.relationshipId || "";

  const matches: DuplicateMatch[] = [];
  for (const row of existing || []) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id ?? "");
    if (!id) continue;
    if (row.deletedAt || row.deleted_at) continue;

    // Same operation already landed: the strongest signal there is.
    if ((reqId && rowStamp(row, "requestId") === reqId) || (opId && rowStamp(row, "operationId") === opId)) {
      matches.push({ id, score: 1, reasons: ["same_request"] });
      continue;
    }

    const rowOwners = ownersOf(row);
    const ownerOk = sameOwner(owners, rowOwners);
    if (!ownerOk) continue; // a different person's identical lunch is not a duplicate

    const rowDay = dayOf(row.date ?? row.dueDate ?? row.due_date ?? row.nextDueDate ?? row.next_due_date);
    const rowAmount = moneyOf(row.amount);
    const rowLabel = labelOf(row);
    const sameDay = !!day && day === rowDay;
    const sameAmt = sameMoney(amount, rowAmount);
    const sameName = !!label && label === rowLabel;
    const sameRel = !!relId && String(row.relationshipId ?? row.relationship_id ?? row.linkedLiabilityId ?? row.trackerId ?? "") === relId;
    const created = createdAtMs(row);
    const recent = created != null && now - created >= 0 && now - created <= window;

    const reasons: string[] = ["same_owner"];
    if (sameDay) reasons.push("same_date");
    if (sameAmt) reasons.push("same_amount");
    if (sameName) reasons.push("same_name");
    if (sameRel) reasons.push("same_relationship");
    if (recent) reasons.push("recent");

    const dated = day !== "" || rowDay !== "";
    const moneyed = amount != null;
    let score = 0;
    if (moneyed && dated) {
      // Ledger-shaped (expense, income, bill instalment).
      if (sameDay && sameAmt && sameName) score = 0.95;
      else if (sameDay && sameAmt) score = 0.7;
      else if (sameName && recent) score = 0.6;
    } else if (dated) {
      // Date-shaped without money (event, task with a due date). Two events
      // with the same title on the same day at DIFFERENT clock times are a
      // question, not a certainty (a 9 am and a 3 pm "Meeting").
      const t1 = typeof candidate.time === "string" ? candidate.time.slice(0, 5) : "";
      const t2 = typeof row.time === "string" ? row.time.slice(0, 5) : "";
      const clockDiffers = !!t1 && !!t2 && t1 !== t2;
      if (sameDay && sameName) score = clockDiffers ? 0.7 : 0.95;
      else if (sameName && recent) score = 0.6;
    } else {
      // Name-shaped (task without a date, tracker, habit, profile, document):
      // only a same-name create moments ago is suspicious.
      if (sameName && recent) score = 0.6;
    }
    if (score > 0) matches.push({ id, score, reasons });
  }

  matches.sort((a, b) => b.score - a.score);
  const top = matches[0]?.score ?? 0;
  const tier: DuplicateTier = top >= 0.9 ? "high" : top >= 0.6 ? "medium" : "low";
  return { tier, matches };
}

/** Control keys a create payload may carry for the guard; never stored. */
export const DUPLICATE_CONTROL_KEYS = ["__allowDuplicate", "__requestId", "__operationId"] as const;

/** Split the guard's control keys off a create payload. */
export function takeDuplicateControls<T extends Record<string, any>>(data: T): {
  data: T;
  allowDuplicate: boolean;
  requestId: string | null;
  operationId: string | null;
} {
  if (!data || typeof data !== "object") return { data, allowDuplicate: false, requestId: null, operationId: null };
  const { __allowDuplicate, __requestId, __operationId, ...rest } = data as Record<string, any>;
  return {
    data: rest as T,
    allowDuplicate: __allowDuplicate === true,
    requestId: typeof __requestId === "string" && __requestId ? __requestId : null,
    operationId: typeof __operationId === "string" && __operationId ? __operationId : null,
  };
}

/** The one sentence a surface shows when it wants confirmation. */
export function duplicateQuestion(match: Record<string, any> | null | undefined): string {
  const name = match?.description ?? match?.title ?? match?.name ?? match?.source ?? "that";
  const day = dayOf(match?.date ?? match?.dueDate ?? match?.due_date);
  return `This looks like ${name}${day ? ` from ${day}` : ""} — log it again?`;
}
