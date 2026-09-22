// shared/write-validation.ts
//
// Rule 34 — every write passes schema AND relationship validation before it
// is committed. Zod covers the shape at the REST edge and validateAiPayload
// covers the AI tools, but neither knows the user's data: whether the owner
// ids exist, whether the parent exists, whether a money value is sane. This
// is the storage-level gate the create methods call right before the insert,
// so a write that skipped the edge (an importer, a cron, a new tool) is held
// to the same rule.
//
// Deliberately strict only about what is CERTAINLY invalid — an owner id the
// user does not have, a parent that does not exist, a date that is not a
// date, money that is not a number — and silent about legacy shapes (a full
// ISO timestamp where a day is expected still parses; a missing optional
// field is not an error).
import { ISO_DAY_RE, isCalendarDay, MAX_TRANSACTION_AMOUNT } from "./schema";

export type WriteValidationResult = { ok: true } | { ok: false; errors: string[] };

export interface WriteValidationContext {
  /**
   * Every profile id the user owns. `null` skips the ownership checks (a
   * store with no profiles yet — a brand-new account, a reference store).
   */
  validProfileIds: ReadonlySet<string> | null;
  /** Whether a parent/relationship id exists; defaults to the profile set. */
  parentExists?: (id: string) => boolean;
}

/** Fields that hold a calendar day (or a timestamp) on the entities we write. */
const DATE_FIELDS = ["date", "dueDate", "endDate", "startDate", "nextDueDate", "recurrenceEnd", "expectedDate", "balanceAsOf"] as const;

/** Money fields and whether they must be non-negative. */
const MONEY_FIELDS: ReadonlyArray<{ key: string; nonNegative: boolean }> = [
  { key: "amount", nonNegative: true },
  { key: "target", nonNegative: false },
  { key: "balance", nonNegative: false },
];

/** Entities whose `amount` is a single ledger transaction (capped at MAX_TRANSACTION_AMOUNT). */
const TRANSACTION_ENTITIES = new Set(["expense", "income", "obligation", "paycheck", "liability_payment"]);

/** Entities that may be created with a negative amount (a refund is an expense adjustment, never a create). */
const SIGNED_AMOUNT_ENTITIES = new Set<string>([]);

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** A day string must be a real calendar day; anything else must at least parse as a date. */
export function validateDateValue(label: string, v: unknown): string | null {
  if (isBlank(v)) return null;
  if (typeof v !== "string") {
    if (v instanceof Date) return Number.isFinite(v.getTime()) ? null : `${label} is not a valid date`;
    return `${label} must be a date string (YYYY-MM-DD)`;
  }
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return ISO_DAY_RE.test(s) && isCalendarDay(s) ? null : `${label} must be a real calendar day (YYYY-MM-DD)`;
  }
  return Number.isFinite(new Date(s).getTime()) ? null : `${label} is not a valid date`;
}

export function validateMoneyValue(label: string, v: unknown, opts: { nonNegative: boolean; max?: number }): string | null {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  if (!Number.isFinite(n)) return `${label} must be a finite number`;
  if (opts.nonNegative && n < 0) return `${label} cannot be negative`;
  if (opts.max != null && Math.abs(n) > opts.max) return `${label} must be at most ${opts.max.toLocaleString("en-US")}`;
  return null;
}

/**
 * Validate a create payload against the user's data. `entityType` is the
 * storage entity ("expense", "task", "profile", …). Returns every problem
 * found, so the caller can report them together.
 */
export function validateWriteCandidate(
  entityType: string,
  data: Record<string, any> | null | undefined,
  ctx: WriteValidationContext,
): WriteValidationResult {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    return { ok: false, errors: [`${entityType}: payload must be an object`] };
  }
  const valid = ctx.validProfileIds;
  const parentExists = ctx.parentExists ?? ((id: string) => (valid ? valid.has(id) : true));

  // Owner ids must exist (Rule 34 "owner exists"). Non-strings are a caller
  // bug regardless of the profile set.
  const owners = data.linkedProfiles ?? data.ownerIds;
  if (owners !== undefined && owners !== null) {
    if (!Array.isArray(owners)) {
      errors.push("linkedProfiles must be an array of profile ids");
    } else {
      for (const id of owners) {
        if (typeof id !== "string" || !id.trim()) { errors.push("linkedProfiles contains an empty owner id"); continue; }
        if (valid && !valid.has(id)) errors.push(`owner profile ${id} does not exist`);
      }
    }
  }
  for (const key of ["profileId", "ownerProfileId"] as const) {
    const id = data[key];
    if (isBlank(id)) continue;
    if (typeof id !== "string") errors.push(`${key} must be a profile id`);
    else if (valid && !valid.has(id)) errors.push(`${key} ${id} does not exist`);
  }

  // Parent must exist when named.
  const parentId = data.parentProfileId ?? data.parent_profile_id;
  if (!isBlank(parentId)) {
    if (typeof parentId !== "string") errors.push("parentProfileId must be a profile id");
    else if (!parentExists(parentId)) errors.push(`parent profile ${parentId} does not exist`);
  }

  // Dates must be dates.
  for (const key of DATE_FIELDS) {
    const problem = validateDateValue(key, data[key]);
    if (problem) errors.push(problem);
  }

  // Money must be money.
  const isTransaction = TRANSACTION_ENTITIES.has(entityType);
  for (const { key, nonNegative } of MONEY_FIELDS) {
    if (!(key in data)) continue;
    const problem = validateMoneyValue(key, data[key], {
      nonNegative: key === "amount" ? (nonNegative && !SIGNED_AMOUNT_ENTITIES.has(entityType)) : nonNegative,
      max: key === "amount" && isTransaction ? MAX_TRANSACTION_AMOUNT : undefined,
    });
    if (problem) errors.push(problem);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Thrown by a writer whose payload failed `validateWriteCandidate`. Carries
 * HTTP 400 and the `WRITE_INVALID` code for the API error handler.
 */
export class WriteValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "WRITE_INVALID";
  readonly errors: string[];
  constructor(entityType: string, errors: string[]) {
    super(`${entityType}: ${errors.join("; ")}`);
    this.name = "WriteValidationError";
    this.errors = errors;
  }
}

/** Validate and throw — the one-liner the storage create methods use. */
export function assertWriteCandidate(entityType: string, data: Record<string, any>, ctx: WriteValidationContext): void {
  const result = validateWriteCandidate(entityType, data, ctx);
  if (!result.ok) throw new WriteValidationError(entityType, result.errors);
}
