// ─── Record details: user-defined characteristics on ANY record ─────────────
//
// Before this module a profile could only hold the fields its type declared
// (profile_type_definitions.field_schema) plus free-text "Add field" pairs.
// "Condition = Good" on a car was either impossible or a string nothing could
// search, sort or report on.
//
// The detail layer has two halves:
//
//   · DEFINITIONS — the user's catalog of characteristics ("Condition",
//     "Roof age", "Signed"). Each one has a value TYPE (a condition scale, a
//     rating, a dropdown, money, a date …), the kinds of record it applies to,
//     optional constraints (required, min/max) and RULES that raise a flag
//     from the value ("Condition at or worse than Fair → warning").
//   · VALUES — per record, keyed by definition id, each with when it was set
//     and a short history, so "it was Good last spring" stays answerable.
//
// One definition, one meaning: the same "Condition" on the car, the house and
// the guitar is the same characteristic, which is what makes "everything in
// Poor condition" a question the app can answer.
//
// Flags are DERIVED from the current value every time (Rule 5): there is no
// stored "resolved" state — change the value and the flag is gone.
//
// Pure. Imports nothing from client/ or server/.

// ── Where it lives ──────────────────────────────────────────────────────────

/** Preference row holding the user's catalog of definitions (JSON array). */
export const DETAIL_DEFS_PREF = "detail_definitions";
/** Prefix of the per-record value rows: `details:<entityType>:<entityId>`. */
export const RECORD_DETAILS_PREFIX = "details:";

export function recordDetailsKey(entityType: string, entityId: string): string {
  return `${RECORD_DETAILS_PREFIX}${entityType}:${entityId}`;
}

/** Inverse of recordDetailsKey; null for anything that isn't one. */
export function parseRecordDetailsKey(key: string): { entityType: DetailEntityType; entityId: string } | null {
  if (!key.startsWith(RECORD_DETAILS_PREFIX)) return null;
  const rest = key.slice(RECORD_DETAILS_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const entityType = rest.slice(0, i);
  const entityId = rest.slice(i + 1);
  if (!isDetailEntityType(entityType) || !entityId) return null;
  return { entityType, entityId };
}

// ── Which records can carry details ─────────────────────────────────────────

/**
 * Every record the app stores by id. Profiles cover people, pets, vehicles,
 * property, assets, accounts, loans, cards and subscriptions; documents cover
 * contracts, policies and IDs.
 */
export const DETAIL_ENTITY_TYPES = [
  "profile", "document", "obligation", "task", "event", "tracker", "habit", "goal", "expense", "artifact",
] as const;
export type DetailEntityType = (typeof DETAIL_ENTITY_TYPES)[number];

export function isDetailEntityType(v: unknown): v is DetailEntityType {
  return typeof v === "string" && (DETAIL_ENTITY_TYPES as readonly string[]).includes(v);
}

/**
 * The scope tokens a record answers to. A definition applies to a record when
 * one of its `appliesTo` tokens is here (or it applies to "*").
 *
 * A vehicle answers to "vehicle" (its type), "asset" (its family), its
 * registry type_key, and "profile"; a contract document answers to
 * "document" and its document type.
 */
export function recordScopeTokens(entityType: DetailEntityType, record: { type?: unknown; type_key?: unknown; typeKey?: unknown } | null | undefined): string[] {
  const out = new Set<string>([entityType]);
  const type = typeof record?.type === "string" ? record.type.trim().toLowerCase() : "";
  const typeKey = String(record?.type_key ?? record?.typeKey ?? "").trim().toLowerCase();
  if (type) out.add(type);
  if (typeKey) out.add(typeKey);
  if (entityType === "profile") {
    const family = PROFILE_FAMILY[type];
    if (family) out.add(family);
  }
  return [...out];
}

/** A profile type's family, so "applies to assets" covers cars and houses. */
const PROFILE_FAMILY: Record<string, string> = {
  vehicle: "asset", property: "asset", investment: "asset", asset: "asset",
  loan: "liability", liability: "liability",
  self: "person", person: "person",
};

/** Human label for a scope token, used by the "applies to" picker. */
export function scopeLabel(token: string): string {
  if (token === "*") return "All records";
  const known = SCOPE_LABELS[token];
  if (known) return known;
  return token.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SCOPE_LABELS: Record<string, string> = {
  profile: "All profiles",
  person: "People",
  self: "Me",
  pet: "Pets",
  vehicle: "Vehicles",
  property: "Property",
  investment: "Investments",
  asset: "Assets",
  account: "Accounts",
  liability: "Liabilities",
  loan: "Loans",
  subscription: "Subscriptions",
  medical: "Medical",
  document: "Documents",
  obligation: "Bills",
  task: "Tasks",
  event: "Events",
  tracker: "Trackers",
  habit: "Habits",
  goal: "Goals",
  expense: "Expenses",
  artifact: "Notes",
};

/**
 * The narrowest useful scope for a definition born on a record: its type
 * ("vehicle", "contract"), falling back to the entity type.
 */
export function defaultScopeFor(entityType: DetailEntityType, record: { type?: unknown } | null | undefined): string {
  const type = typeof record?.type === "string" ? record.type.trim().toLowerCase() : "";
  if (entityType === "profile" && type && type !== "self") return type;
  if (entityType === "profile" && type === "self") return "person";
  if (entityType === "document" && type && type !== "other") return type;
  return entityType;
}

// ── Value types ─────────────────────────────────────────────────────────────

export const DETAIL_KINDS = [
  "text", "longtext", "number", "currency", "percent", "date", "boolean",
  "select", "multiselect", "condition", "rating", "url",
] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export function isDetailKind(v: unknown): v is DetailKind {
  return typeof v === "string" && (DETAIL_KINDS as readonly string[]).includes(v);
}

export const DETAIL_KIND_LABELS: Record<DetailKind, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  currency: "Money",
  percent: "Percent",
  date: "Date",
  boolean: "Yes / No",
  select: "Dropdown",
  multiselect: "Multiple choice",
  condition: "Condition scale",
  rating: "Rating",
  url: "Link",
};

/** Ordered best → worst. The order is what makes "Fair or worse" meaningful. */
export const DEFAULT_CONDITION_SCALE: readonly string[] = ["Excellent", "Good", "Fair", "Poor"];
export const DEFAULT_RATING_MAX = 5;
export const MAX_OPTIONS = 30;
export const MAX_LABEL_LENGTH = 60;
export const MAX_TEXT_LENGTH = 2000;
export const MAX_RULES = 10;
export const MAX_DEFINITIONS = 300;
export const HISTORY_LIMIT = 20;

/** What a stored value is. Dates are calendar days ("YYYY-MM-DD"). */
export type DetailValue = string | number | boolean | string[];

// ── Rules ───────────────────────────────────────────────────────────────────

export const DETAIL_OPS = [
  "is", "is_not", "any_of", "contains",
  "lt", "lte", "gt", "gte",
  "worse_than", "at_or_worse", "better_than",
  "past", "within_days",
  "empty", "not_empty",
] as const;
export type DetailOp = (typeof DETAIL_OPS)[number];

export function isDetailOp(v: unknown): v is DetailOp {
  return typeof v === "string" && (DETAIL_OPS as readonly string[]).includes(v);
}

export const DETAIL_OP_LABELS: Record<DetailOp, string> = {
  is: "is",
  is_not: "is not",
  any_of: "is any of",
  contains: "contains",
  lt: "is less than",
  lte: "is at most",
  gt: "is more than",
  gte: "is at least",
  worse_than: "is worse than",
  at_or_worse: "is at or worse than",
  better_than: "is better than",
  past: "is in the past",
  within_days: "is within (days)",
  empty: "is missing",
  not_empty: "is set",
};

/** Which comparisons make sense for a value type. */
export function opsForKind(kind: DetailKind): DetailOp[] {
  switch (kind) {
    case "number": case "currency": case "percent":
      return ["is", "is_not", "lt", "lte", "gt", "gte", "empty", "not_empty"];
    case "rating":
      return ["is", "lt", "lte", "gt", "gte", "empty", "not_empty"];
    case "condition":
      return ["is", "is_not", "any_of", "worse_than", "at_or_worse", "better_than", "empty", "not_empty"];
    case "select":
      return ["is", "is_not", "any_of", "empty", "not_empty"];
    case "multiselect":
      return ["contains", "empty", "not_empty"];
    case "date":
      return ["past", "within_days", "lt", "gt", "empty", "not_empty"];
    case "boolean":
      return ["is", "empty", "not_empty"];
    default:
      return ["is", "is_not", "contains", "empty", "not_empty"];
  }
}

/** Does the operator need an operand? */
export function opNeedsOperand(op: DetailOp): boolean {
  return !["past", "empty", "not_empty"].includes(op);
}

export type DetailSeverity = "info" | "warning" | "critical";
export const DETAIL_SEVERITIES: readonly DetailSeverity[] = ["info", "warning", "critical"];

export interface DetailRule {
  id: string;
  op: DetailOp;
  /** Operand: an option, a number, a day count, or a list for any_of. */
  value?: string | number | boolean | string[];
  severity: DetailSeverity;
  /** What the flag says. Generated from the rule when absent. */
  message?: string;
}

// ── Definitions ─────────────────────────────────────────────────────────────

export interface DetailDefinition {
  /** Stable slug ("condition", "roof-age"). Values are keyed by it. */
  id: string;
  label: string;
  kind: DetailKind;
  /** select / multiselect / condition (ordered best → worst). */
  options?: string[];
  /** number: a unit shown after the value ("mi", "sq ft"). */
  unit?: string;
  /** number / currency / percent / rating bounds, enforced on write. */
  min?: number;
  max?: number;
  /** rating: the top of the scale (default 5). */
  scaleMax?: number;
  /** A record this applies to without a value is flagged "missing". */
  required?: boolean;
  /** Scope tokens (see recordScopeTokens); ["*"] = every record. */
  appliesTo: string[];
  rules?: DetailRule[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DetailHistoryEntry { value: DetailValue | null; at: string }

export interface DetailEntry {
  value: DetailValue;
  updatedAt: string;
  /** Older values, newest last, bounded by HISTORY_LIMIT. */
  history?: DetailHistoryEntry[];
}

export interface RecordDetails {
  values: Record<string, DetailEntry>;
  updatedAt: string;
}

export function emptyRecordDetails(): RecordDetails {
  return { values: {}, updatedAt: "" };
}

/** The options a definition offers (condition falls back to the default scale). */
export function optionsFor(def: Pick<DetailDefinition, "kind" | "options">): string[] {
  const own = Array.isArray(def.options) ? def.options.filter((o) => typeof o === "string" && o.trim()) : [];
  if (def.kind === "condition" && own.length === 0) return [...DEFAULT_CONDITION_SCALE];
  return own;
}

export function ratingMax(def: Pick<DetailDefinition, "scaleMax">): number {
  const n = Number(def.scaleMax);
  return Number.isInteger(n) && n >= 2 && n <= 10 ? n : DEFAULT_RATING_MAX;
}

export function definitionAppliesTo(def: Pick<DetailDefinition, "appliesTo">, tokens: readonly string[]): boolean {
  const scope = Array.isArray(def.appliesTo) ? def.appliesTo : [];
  if (scope.includes("*")) return true;
  return scope.some((t) => tokens.includes(t));
}

/** "Roof age" → "roof-age"; unique against `taken`. */
export function slugifyDetailId(label: string, taken: ReadonlySet<string> = new Set()): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "detail";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Labels are one-per-catalog, compared without case or extra spaces. */
export function labelIdentity(label: string): string {
  return String(label || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function findDefinitionByLabel(defs: readonly DetailDefinition[], label: string): DetailDefinition | undefined {
  const id = labelIdentity(label);
  return defs.find((d) => labelIdentity(d.label) === id);
}

/** Read a definition by id, else by label — what a chat tool or URL names. */
export function findDefinition(defs: readonly DetailDefinition[], idOrLabel: string): DetailDefinition | undefined {
  const raw = String(idOrLabel || "").trim();
  if (!raw) return undefined;
  return defs.find((d) => d.id === raw) || findDefinitionByLabel(defs, raw);
}

// ── Parsing stored JSON (anything malformed degrades, never throws) ────────

export function parseDefinitions(raw: unknown): DetailDefinition[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out: DetailDefinition[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, any>;
    if (typeof d.id !== "string" || !d.id || seen.has(d.id)) continue;
    if (typeof d.label !== "string" || !d.label.trim()) continue;
    if (!isDetailKind(d.kind)) continue;
    seen.add(d.id);
    out.push({
      id: d.id,
      label: d.label,
      kind: d.kind,
      ...(Array.isArray(d.options) ? { options: d.options.filter((o: unknown) => typeof o === "string") } : {}),
      ...(typeof d.unit === "string" && d.unit ? { unit: d.unit } : {}),
      ...(Number.isFinite(d.min) ? { min: Number(d.min) } : {}),
      ...(Number.isFinite(d.max) ? { max: Number(d.max) } : {}),
      ...(Number.isFinite(d.scaleMax) ? { scaleMax: Number(d.scaleMax) } : {}),
      ...(d.required === true ? { required: true } : {}),
      appliesTo: Array.isArray(d.appliesTo) ? d.appliesTo.filter((t: unknown) => typeof t === "string" && t) : ["*"],
      ...(Array.isArray(d.rules) ? { rules: d.rules.filter(isStoredRule) } : {}),
      ...(typeof d.description === "string" && d.description ? { description: d.description } : {}),
      createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
      updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : "",
    });
  }
  return out;
}

function isStoredRule(r: unknown): r is DetailRule {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  return typeof x.id === "string" && isDetailOp(x.op) && DETAIL_SEVERITIES.includes(x.severity as DetailSeverity);
}

export function parseRecordDetails(raw: unknown): RecordDetails {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return emptyRecordDetails(); }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return emptyRecordDetails();
  const o = obj as Record<string, any>;
  const values: Record<string, DetailEntry> = {};
  if (o.values && typeof o.values === "object" && !Array.isArray(o.values)) {
    for (const [k, e] of Object.entries(o.values as Record<string, any>)) {
      if (!e || typeof e !== "object" || !isStoredValue(e.value)) continue;
      values[k] = {
        value: e.value,
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
        ...(Array.isArray(e.history) ? { history: e.history.filter((h: any) => h && typeof h.at === "string" && (h.value === null || isStoredValue(h.value))) } : {}),
      };
    }
  }
  return { values, updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "" };
}

function isStoredValue(v: unknown): v is DetailValue {
  if (typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ── Building / validating a definition ──────────────────────────────────────

export interface DefinitionInput {
  label?: unknown;
  kind?: unknown;
  options?: unknown;
  unit?: unknown;
  min?: unknown;
  max?: unknown;
  scaleMax?: unknown;
  required?: unknown;
  appliesTo?: unknown;
  rules?: unknown;
  description?: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function cleanOptions(raw: unknown): Result<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/) : null;
  if (!list) return { ok: false, error: "Options must be a list" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of list) {
    const s = String(o ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  if (out.length > MAX_OPTIONS) return { ok: false, error: `At most ${MAX_OPTIONS} options` };
  return { ok: true, value: out };
}

function cleanScope(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [...new Set(list.map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean))];
  if (out.includes("*")) return ["*"];
  return out.slice(0, 20);
}

function finiteOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Validate a create (no `existing`) or an update (merged over `existing`).
 * Returns the definition to store; ids and timestamps are the caller's.
 */
export function buildDefinition(
  input: DefinitionInput,
  ctx: { id: string; now: string; existing?: DetailDefinition },
): Result<DetailDefinition> {
  const ex = ctx.existing;
  const label = input.label === undefined && ex ? ex.label
    : String(input.label ?? "").trim().replace(/\s+/g, " ");
  if (!label) return { ok: false, error: "Give the characteristic a name" };
  if (label.length > MAX_LABEL_LENGTH) return { ok: false, error: `Names are at most ${MAX_LABEL_LENGTH} characters` };

  const kind = input.kind === undefined && ex ? ex.kind : input.kind;
  if (!isDetailKind(kind)) return { ok: false, error: `Unknown type "${String(kind)}"` };

  const opts = cleanOptions(input.options);
  if (!opts.ok) return opts;
  let options = opts.value ?? (ex && ex.kind === kind ? ex.options : undefined);
  if (kind === "select" || kind === "multiselect") {
    if (!options || options.length === 0) return { ok: false, error: "A dropdown needs at least one option" };
  } else if (kind === "condition") {
    if (!options || options.length < 2) options = [...DEFAULT_CONDITION_SCALE];
  } else {
    options = undefined;
  }

  const appliesTo = cleanScope(input.appliesTo) ?? ex?.appliesTo ?? ["*"];
  if (appliesTo.length === 0) return { ok: false, error: "Choose what this applies to" };

  const pick = (k: "min" | "max" | "scaleMax") => (input[k] === undefined ? ex?.[k] : finiteOrUndefined(input[k]));
  const numeric = ["number", "currency", "percent", "rating"].includes(kind);
  const min = numeric ? pick("min") : undefined;
  const max = numeric ? pick("max") : undefined;
  if (min !== undefined && max !== undefined && min > max) return { ok: false, error: "Minimum is above maximum" };
  const scaleMax = kind === "rating" ? (pick("scaleMax") ?? DEFAULT_RATING_MAX) : undefined;
  if (scaleMax !== undefined && (!Number.isInteger(scaleMax) || scaleMax < 2 || scaleMax > 10)) {
    return { ok: false, error: "A rating scale goes up to between 2 and 10" };
  }
  const unitRaw = input.unit === undefined ? ex?.unit : input.unit;
  const unit = kind === "number" && typeof unitRaw === "string" && unitRaw.trim() ? unitRaw.trim().slice(0, 16) : undefined;
  const required = input.required === undefined ? ex?.required === true : input.required === true;
  const descRaw = input.description === undefined ? ex?.description : input.description;
  const description = typeof descRaw === "string" && descRaw.trim() ? descRaw.trim().slice(0, 280) : undefined;

  const draft: DetailDefinition = {
    id: ctx.id,
    label,
    kind,
    ...(options ? { options } : {}),
    ...(unit ? { unit } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(scaleMax !== undefined ? { scaleMax } : {}),
    ...(required ? { required: true } : {}),
    appliesTo,
    ...(description ? { description } : {}),
    createdAt: ex?.createdAt || ctx.now,
    updatedAt: ctx.now,
  };

  const rulesRaw = input.rules === undefined ? (ex && ex.kind === kind ? ex.rules : undefined) : input.rules;
  if (rulesRaw !== undefined && rulesRaw !== null) {
    if (!Array.isArray(rulesRaw)) return { ok: false, error: "Rules must be a list" };
    if (rulesRaw.length > MAX_RULES) return { ok: false, error: `At most ${MAX_RULES} rules` };
    const rules: DetailRule[] = [];
    for (let i = 0; i < rulesRaw.length; i++) {
      const r = buildRule(draft, rulesRaw[i], i);
      if (!r.ok) return r;
      rules.push(r.value);
    }
    if (rules.length > 0) draft.rules = rules;
  }
  return { ok: true, value: draft };
}

function buildRule(def: DetailDefinition, raw: unknown, index: number): Result<DetailRule> {
  if (!raw || typeof raw !== "object") return { ok: false, error: `Rule ${index + 1} is not a rule` };
  const r = raw as Record<string, unknown>;
  if (!isDetailOp(r.op) || !opsForKind(def.kind).includes(r.op)) {
    return { ok: false, error: `Rule ${index + 1}: "${String(r.op)}" doesn't apply to ${DETAIL_KIND_LABELS[def.kind].toLowerCase()} values` };
  }
  const severity = DETAIL_SEVERITIES.includes(r.severity as DetailSeverity) ? (r.severity as DetailSeverity) : "warning";
  const id = typeof r.id === "string" && r.id ? r.id.slice(0, 40) : `r${index + 1}`;
  const message = typeof r.message === "string" && r.message.trim() ? r.message.trim().slice(0, 200) : undefined;
  let value: DetailRule["value"];
  if (opNeedsOperand(r.op)) {
    const operand = normalizeOperand(def, r.op, r.value);
    if (!operand.ok) return { ok: false, error: `Rule ${index + 1}: ${operand.error}` };
    value = operand.value;
  }
  return { ok: true, value: { id, op: r.op, ...(value !== undefined ? { value } : {}), severity, ...(message ? { message } : {}) } };
}

/** Normalize a rule's / filter's operand against the definition. */
export function normalizeOperand(def: DetailDefinition, op: DetailOp, raw: unknown): Result<DetailRule["value"]> {
  if (op === "within_days") {
    const n = finiteOrUndefined(raw);
    if (n === undefined || n < 0 || !Number.isInteger(n)) return { ok: false, error: "enter a whole number of days" };
    return { ok: true, value: n };
  }
  if (op === "any_of") {
    const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    const out: string[] = [];
    for (const item of list) {
      const v = normalizeDetailValue({ ...def, kind: def.kind === "multiselect" ? "select" : def.kind }, item);
      if (v.ok && typeof v.value === "string") out.push(v.value);
    }
    if (out.length === 0) return { ok: false, error: "pick at least one option" };
    return { ok: true, value: out };
  }
  if (op === "contains" && def.kind === "multiselect") {
    const v = normalizeDetailValue({ ...def, kind: "select" }, raw);
    return v.ok ? { ok: true, value: v.value as string } : v;
  }
  if (op === "contains") {
    const s = String(raw ?? "").trim();
    return s ? { ok: true, value: s } : { ok: false, error: "enter some text" };
  }
  // The operand is a value of the definition's own type ("Fair", 100000, a date).
  // Bounds are not applied: "less than 0" is a fine thing to ask.
  const v = normalizeDetailValue({ ...def, min: undefined, max: undefined }, raw);
  if (!v.ok) return v;
  if (Array.isArray(v.value)) return { ok: false, error: "enter one value" };
  return { ok: true, value: v.value };
}

// ── Values ──────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  let s = raw.trim().toLowerCase().replace(/[$€£,%\s]/g, "");
  let mult = 1;
  if (/^-?\d+(\.\d+)?k$/.test(s)) { mult = 1_000; s = s.slice(0, -1); }
  else if (/^-?\d+(\.\d+)?m$/.test(s)) { mult = 1_000_000; s = s.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s) && !/^-?\.\d+$/.test(s)) return undefined;
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : undefined;
}

function matchOption(options: readonly string[], raw: unknown): string | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return options.find((o) => o.toLowerCase() === s);
}

function validDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Turn what someone typed (or what the chat sent) into the stored value, or
 * say why it can't be. "12,500" → 12500; "good" → "Good" on a condition
 * scale; "yes" → true; "2026-3-5" → "2026-03-05".
 */
export function normalizeDetailValue(def: Pick<DetailDefinition, "kind" | "options" | "min" | "max" | "scaleMax" | "label">, raw: unknown): Result<DetailValue> {
  const name = def.label || "This";
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return { ok: false, error: `${name} needs a value` };
  }
  const bounds = (n: number): Result<DetailValue> => {
    if (def.min !== undefined && n < def.min) return { ok: false, error: `${name} must be at least ${def.min}` };
    if (def.max !== undefined && n > def.max) return { ok: false, error: `${name} must be at most ${def.max}` };
    return { ok: true, value: n };
  };
  switch (def.kind) {
    case "text": {
      const s = String(raw).trim().replace(/\s+/g, " ");
      if (s.length > 200) return { ok: false, error: `${name} is too long (200 characters max)` };
      return { ok: true, value: s };
    }
    case "longtext": {
      const s = String(raw).trim();
      if (s.length > MAX_TEXT_LENGTH) return { ok: false, error: `${name} is too long (${MAX_TEXT_LENGTH} characters max)` };
      return { ok: true, value: s };
    }
    case "url": {
      let s = String(raw).trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
      try {
        const u = new URL(s);
        if (!["http:", "https:", "mailto:", "tel:"].includes(u.protocol)) return { ok: false, error: `${name} must be a web link` };
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, error: `${name} must be a web link` };
      }
    }
    case "number": case "currency": case "percent": {
      const n = parseNumber(raw);
      if (n === undefined) return { ok: false, error: `${name} must be a number` };
      return bounds(def.kind === "currency" ? Math.round(n * 100) / 100 : n);
    }
    case "rating": {
      const max = ratingMax(def);
      const s = typeof raw === "string" ? raw.trim() : raw;
      const stars = typeof s === "string" && /^★+☆*$/.test(s) ? (s.match(/★/g) || []).length : undefined;
      const n = stars ?? parseNumber(typeof s === "string" ? s.replace(/\/\s*\d+$/, "") : s);
      if (n === undefined || !Number.isInteger(n) || n < 1 || n > max) return { ok: false, error: `${name} is a rating from 1 to ${max}` };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["yes", "y", "true", "1", "on", "done", "signed"].includes(s)) return { ok: true, value: true };
      if (["no", "n", "false", "0", "off"].includes(s)) return { ok: true, value: false };
      return { ok: false, error: `${name} is yes or no` };
    }
    case "date": {
      const s = String(raw).trim();
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(s);
      if (m) {
        const day = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
        if (validDay(day)) return { ok: true, value: day };
      }
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (us) {
        const day = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
        if (validDay(day)) return { ok: true, value: day };
      }
      return { ok: false, error: `${name} must be a date (YYYY-MM-DD)` };
    }
    case "select": case "condition": {
      const options = optionsFor(def);
      const hit = matchOption(options, Array.isArray(raw) ? raw[0] : raw);
      if (!hit) return { ok: false, error: `${name} must be one of: ${options.join(", ")}` };
      return { ok: true, value: hit };
    }
    case "multiselect": {
      const options = optionsFor(def);
      const list = Array.isArray(raw) ? raw : String(raw).split(",");
      const out: string[] = [];
      for (const item of list) {
        if (String(item ?? "").trim() === "") continue;
        const hit = matchOption(options, item);
        if (!hit) return { ok: false, error: `"${String(item).trim()}" is not an option for ${name} (${options.join(", ")})` };
        if (!out.includes(hit)) out.push(hit);
      }
      if (out.length === 0) return { ok: false, error: `${name} needs at least one choice` };
      return { ok: true, value: options.filter((o) => out.includes(o)) };
    }
  }
}

function formatNumber(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How a value reads on a screen, in a chat reply or in a report. */
export function formatDetailValue(def: Pick<DetailDefinition, "kind" | "unit" | "scaleMax">, value: DetailValue | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (def.kind) {
    case "currency": return typeof value === "number"
      ? (value < 0 ? "-$" : "$") + Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })
      : String(value);
    case "percent": return typeof value === "number" ? `${formatNumber(value)}%` : String(value);
    case "number": return typeof value === "number" ? `${formatNumber(value)}${def.unit ? ` ${def.unit}` : ""}` : String(value);
    case "rating": return typeof value === "number" ? `${value} / ${ratingMax(def)}` : String(value);
    case "boolean": return value === true ? "Yes" : value === false ? "No" : String(value);
    case "date": {
      const s = String(value);
      if (!ISO_DAY.test(s)) return s;
      const [y, m, d] = s.split("-").map(Number);
      return `${MONTHS[m - 1]} ${d}, ${y}`;
    }
    case "multiselect": return Array.isArray(value) ? value.join(", ") : String(value);
    default: return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/** Is this stored value still a valid value of the (possibly edited) definition? */
export function isValueCurrent(def: DetailDefinition, value: DetailValue): boolean {
  return normalizeDetailValue({ ...def, min: undefined, max: undefined }, value).ok;
}

/** Set (value) or clear (null) one characteristic, keeping a short history. */
export function applyDetailChange(rec: RecordDetails, definitionId: string, value: DetailValue | null, at: string): RecordDetails {
  const values = { ...rec.values };
  const prev = values[definitionId];
  if (value === null) {
    delete values[definitionId];
  } else {
    if (prev && sameValue(prev.value, value)) return rec;
    const history = prev
      ? [...(prev.history || []), { value: prev.value, at: prev.updatedAt }].slice(-HISTORY_LIMIT)
      : undefined;
    values[definitionId] = { value, updatedAt: at, ...(history && history.length ? { history } : {}) };
  }
  return { values, updatedAt: at };
}

export function sameValue(a: DetailValue | null | undefined, b: DetailValue | null | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

// ── Comparisons, rules and flags ────────────────────────────────────────────

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Does `value` satisfy `op operand`? The single comparison both rules and
 * report filters use, so "flagged as Fair or worse" and "show me Fair or
 * worse" can never disagree.
 */
export function matchesDetail(
  def: DetailDefinition,
  value: DetailValue | null | undefined,
  op: DetailOp,
  operand: DetailRule["value"] | undefined,
  todayISO: string,
): boolean {
  const missing = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (op === "empty") return missing;
  if (op === "not_empty") return !missing;
  if (missing) return false;

  if (def.kind === "condition" && (op === "worse_than" || op === "at_or_worse" || op === "better_than")) {
    const scale = optionsFor(def);
    const vi = scale.indexOf(String(value));
    const oi = scale.indexOf(String(operand));
    if (vi < 0 || oi < 0) return false;
    if (op === "worse_than") return vi > oi;
    if (op === "at_or_worse") return vi >= oi;
    return vi < oi;
  }

  if (def.kind === "date") {
    const day = String(value);
    if (!ISO_DAY.test(day)) return false;
    if (op === "past") return day < todayISO;
    if (op === "within_days") {
      const n = Number(operand);
      const diff = daysBetween(todayISO, day);
      return diff >= 0 && diff <= n;
    }
    if (op === "lt") return day < String(operand);
    if (op === "gt") return day > String(operand);
    if (op === "is") return day === String(operand);
    if (op === "is_not") return day !== String(operand);
    return false;
  }

  if (typeof value === "number") {
    const n = Number(operand);
    if (!Number.isFinite(n)) return false;
    switch (op) {
      case "is": return value === n;
      case "is_not": return value !== n;
      case "lt": return value < n;
      case "lte": return value <= n;
      case "gt": return value > n;
      case "gte": return value >= n;
      default: return false;
    }
  }

  if (Array.isArray(value)) {
    if (op === "contains") return value.some((v) => v.toLowerCase() === String(operand).toLowerCase());
    return false;
  }

  if (typeof value === "boolean") {
    const want = typeof operand === "boolean" ? operand : String(operand).toLowerCase() === "true" || String(operand).toLowerCase() === "yes";
    if (op === "is") return value === want;
    if (op === "is_not") return value !== want;
    return false;
  }

  const s = String(value).toLowerCase();
  switch (op) {
    case "is": return s === String(operand).toLowerCase();
    case "is_not": return s !== String(operand).toLowerCase();
    case "any_of": return Array.isArray(operand) && operand.some((o) => String(o).toLowerCase() === s);
    case "contains": return s.includes(String(operand).toLowerCase());
    default: return false;
  }
}

export interface DetailFlag {
  definitionId: string;
  label: string;
  /** "required" for a missing required value, else the rule id. */
  ruleId: string;
  severity: DetailSeverity;
  message: string;
}

/** "Condition is at or worse than Fair". */
export function describeCondition(def: DetailDefinition, op: DetailOp, operand: DetailRule["value"] | undefined): string {
  const opText = op === "within_days" ? `is within ${operand} days` : DETAIL_OP_LABELS[op];
  if (!opNeedsOperand(op) || op === "within_days") return `${def.label} ${opText}`;
  const shown = Array.isArray(operand)
    ? operand.join(" or ")
    : formatDetailValue(def, operand as DetailValue);
  return `${def.label} ${opText} ${shown}`;
}

/**
 * The flags a record's value raises under its definition, worst first.
 * `applies` = the definition applies to the record (a missing value is only
 * a problem where the characteristic is expected).
 */
export function evaluateDetailRules(
  def: DetailDefinition,
  value: DetailValue | null | undefined,
  todayISO: string,
  applies = true,
): DetailFlag[] {
  const flags: DetailFlag[] = [];
  const missing = value === null || value === undefined || value === "";
  if (missing && !applies) return flags;
  if (def.required && missing) {
    flags.push({ definitionId: def.id, label: def.label, ruleId: "required", severity: "warning", message: `${def.label} is missing` });
  }
  for (const rule of def.rules || []) {
    if (rule.op === "empty" && def.required && missing) continue; // already said
    if (!matchesDetail(def, value, rule.op, rule.value, todayISO)) continue;
    flags.push({
      definitionId: def.id,
      label: def.label,
      ruleId: rule.id,
      severity: rule.severity,
      message: rule.message || describeCondition(def, rule.op, rule.value),
    });
  }
  return flags.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

const SEVERITY_RANK: Record<DetailSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function worstSeverity(flags: readonly DetailFlag[]): DetailSeverity | null {
  let worst: DetailSeverity | null = null;
  for (const f of flags) if (!worst || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  return worst;
}

// ── A record's details, assembled for a screen or a tool ────────────────────

export interface DetailRow {
  definition: DetailDefinition;
  value: DetailValue | null;
  display: string;
  updatedAt: string | null;
  history: DetailHistoryEntry[];
  /** The value no longer fits the definition (an option was removed). */
  stale: boolean;
  flags: DetailFlag[];
}

export interface RecordDetailsView {
  entityType: DetailEntityType;
  entityId: string;
  scopeTokens: string[];
  defaultScope: string;
  /** Characteristics with a value, plus the ones this record is expected to carry. */
  rows: DetailRow[];
  /** Applicable characteristics not yet filled in. */
  available: DetailDefinition[];
  flags: DetailFlag[];
}

/**
 * Everything a screen needs about one record's details. A row shows when the
 * record has a value OR the definition is required here; other applicable
 * characteristics are offered under `available`.
 */
export function buildRecordDetailsView(args: {
  entityType: DetailEntityType;
  entityId: string;
  record: { type?: unknown; type_key?: unknown } | null | undefined;
  definitions: readonly DetailDefinition[];
  details: RecordDetails;
  todayISO: string;
}): RecordDetailsView {
  const tokens = recordScopeTokens(args.entityType, args.record);
  const rows: DetailRow[] = [];
  const available: DetailDefinition[] = [];
  for (const def of args.definitions) {
    const entry = args.details.values[def.id];
    const applies = definitionAppliesTo(def, tokens);
    if (!entry) {
      if (applies && def.required) {
        rows.push({ definition: def, value: null, display: "—", updatedAt: null, history: [], stale: false, flags: evaluateDetailRules(def, null, args.todayISO, true) });
      } else if (applies) {
        available.push(def);
      }
      continue;
    }
    rows.push({
      definition: def,
      value: entry.value,
      display: formatDetailValue(def, entry.value),
      updatedAt: entry.updatedAt || null,
      history: entry.history || [],
      stale: !isValueCurrent(def, entry.value),
      flags: evaluateDetailRules(def, entry.value, args.todayISO, applies),
    });
  }
  return {
    entityType: args.entityType,
    entityId: args.entityId,
    scopeTokens: tokens,
    defaultScope: defaultScopeFor(args.entityType, args.record),
    rows,
    available,
    flags: rows.flatMap((r) => r.flags),
  };
}

/** Count of each value across records — the "how many in each condition" report. */
export function valueDistribution(def: DetailDefinition, values: ReadonlyArray<DetailValue | null>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const v of values) {
    if (v === null || v === undefined || v === "") { bump("—"); continue; }
    if (Array.isArray(v)) { for (const x of v) bump(x); continue; }
    bump(formatDetailValue(def, v));
  }
  const order = ["select", "multiselect", "condition"].includes(def.kind) ? optionsFor(def) : [];
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      const ai = order.indexOf(a.value), bi = order.indexOf(b.value);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      if (a.value === "—") return 1;
      if (b.value === "—") return -1;
      return b.count - a.count || a.value.localeCompare(b.value);
    });
}

/** A sortable key for a value, so a report can order by it. */
export function sortKeyForValue(def: DetailDefinition, value: DetailValue | null): number | string {
  if (value === null || value === undefined) return "￿";
  if (def.kind === "condition" || def.kind === "select") {
    const i = optionsFor(def).indexOf(String(value));
    return i < 0 ? 999 : i;
  }
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 0 : 1;
  return Array.isArray(value) ? value.join(",").toLowerCase() : String(value).toLowerCase();
}

// ── Suggested characteristics (a fixed library, never random) ───────────────

export interface DetailTemplate {
  label: string;
  kind: DetailKind;
  options?: string[];
  unit?: string;
  scaleMax?: number;
  rules?: Array<Omit<DetailRule, "id">>;
  /** The scope the template is offered for; it becomes the definition's appliesTo. */
  scope: string;
}

const CONDITION_RULE: Omit<DetailRule, "id"> = { op: "at_or_worse", value: "Poor", severity: "warning" };

export const DETAIL_TEMPLATES: readonly DetailTemplate[] = [
  // Vehicles
  { scope: "vehicle", label: "Condition", kind: "condition", rules: [CONDITION_RULE] },
  { scope: "vehicle", label: "Color", kind: "text" },
  { scope: "vehicle", label: "Fuel type", kind: "select", options: ["Gas", "Diesel", "Hybrid", "Plug-in hybrid", "Electric"] },
  { scope: "vehicle", label: "Drivetrain", kind: "select", options: ["FWD", "RWD", "AWD", "4WD"] },
  { scope: "vehicle", label: "Tire condition", kind: "condition", rules: [CONDITION_RULE] },
  { scope: "vehicle", label: "Next service due", kind: "date", rules: [{ op: "within_days", value: 30, severity: "info" }, { op: "past", severity: "warning" }] },
  // Property
  { scope: "property", label: "Condition", kind: "condition", rules: [CONDITION_RULE] },
  { scope: "property", label: "Roof condition", kind: "condition", rules: [CONDITION_RULE] },
  { scope: "property", label: "Square footage", kind: "number", unit: "sq ft" },
  { scope: "property", label: "Year built", kind: "number", },
  { scope: "property", label: "Last inspection", kind: "date" },
  { scope: "property", label: "Occupancy", kind: "select", options: ["Owner-occupied", "Rented", "Vacant"] },
  // Any asset
  { scope: "asset", label: "Condition", kind: "condition", rules: [CONDITION_RULE] },
  { scope: "asset", label: "Location", kind: "text" },
  { scope: "asset", label: "Serial number", kind: "text" },
  { scope: "asset", label: "Warranty expires", kind: "date", rules: [{ op: "within_days", value: 30, severity: "info" }] },
  { scope: "asset", label: "Insured", kind: "boolean" },
  // Liabilities
  { scope: "liability", label: "Priority", kind: "select", options: ["High", "Medium", "Low"] },
  { scope: "liability", label: "Refinance candidate", kind: "boolean" },
  { scope: "liability", label: "Lender satisfaction", kind: "rating", scaleMax: 5 },
  // People / pets
  { scope: "person", label: "Relationship", kind: "select", options: ["Family", "Friend", "Partner", "Coworker", "Neighbor", "Other"] },
  { scope: "person", label: "Blood type", kind: "select", options: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] },
  { scope: "person", label: "Allergies", kind: "longtext" },
  { scope: "person", label: "Shirt size", kind: "select", options: ["XS", "S", "M", "L", "XL", "XXL"] },
  { scope: "pet", label: "Breed", kind: "text" },
  { scope: "pet", label: "Microchip ID", kind: "text" },
  { scope: "pet", label: "Spayed / neutered", kind: "boolean" },
  // Documents (contracts, policies, IDs)
  { scope: "document", label: "Status", kind: "select", options: ["Active", "Under review", "Expired", "Terminated"] },
  { scope: "document", label: "Signed", kind: "boolean", rules: [{ op: "is", value: false, severity: "warning", message: "Not signed yet" }] },
  { scope: "document", label: "Counterparty", kind: "text" },
  { scope: "document", label: "Renewal date", kind: "date", rules: [{ op: "within_days", value: 30, severity: "warning" }, { op: "past", severity: "critical" }] },
  { scope: "document", label: "Contract value", kind: "currency" },
  // Subscriptions
  { scope: "subscription", label: "Worth it?", kind: "rating", scaleMax: 5, rules: [{ op: "lte", value: 2, severity: "info", message: "Low value — consider cancelling" }] },
  { scope: "subscription", label: "Shared with", kind: "text" },
  // Anything
  { scope: "*", label: "Condition", kind: "condition", rules: [CONDITION_RULE] },
  { scope: "*", label: "Priority", kind: "select", options: ["High", "Medium", "Low"] },
  { scope: "*", label: "Rating", kind: "rating", scaleMax: 5 },
];

/**
 * Templates for this record whose label isn't in the catalog yet. Most
 * specific scope first; one per label.
 */
export function suggestedTemplates(tokens: readonly string[], defs: readonly DetailDefinition[], limit = 8): DetailTemplate[] {
  const have = new Set(defs.map((d) => labelIdentity(d.label)));
  const seen = new Set<string>();
  const ranked = DETAIL_TEMPLATES
    .map((t, i) => ({ t, rank: t.scope === "*" ? 1000 + i : tokens.includes(t.scope) ? (tokens.indexOf(t.scope) * 100 + i) : -1 }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  const out: DetailTemplate[] = [];
  for (const { t } of ranked) {
    const id = labelIdentity(t.label);
    if (have.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** A template as definition input; the scope is the record's narrowest one. */
export function templateToInput(t: DetailTemplate, scope?: string): DefinitionInput {
  return {
    label: t.label,
    kind: t.kind,
    options: t.options,
    unit: t.unit,
    scaleMax: t.scaleMax,
    appliesTo: [scope || t.scope],
    rules: t.rules?.map((r, i) => ({ ...r, id: `r${i + 1}` })),
  };
}

// ── Inferring a new characteristic's type (chat, where no type was picked) ──

const CONDITION_WORDS = new Set(["excellent", "good", "fair", "poor", "like new", "new", "used", "damaged", "broken"]);

/**
 * When the chat names a characteristic that doesn't exist yet and the model
 * didn't say what type it is, pick the type the words imply — a template
 * first ("Condition" on a car is the condition scale), then the value's
 * shape. Text is the last resort, never the default for something that is
 * plainly a number, a date, a yes/no or a condition.
 */
export function inferDetailDefinition(label: string, value: unknown, tokens: readonly string[]): DefinitionInput {
  const id = labelIdentity(label);
  const template = DETAIL_TEMPLATES
    .filter((t) => labelIdentity(t.label) === id && (t.scope === "*" || tokens.includes(t.scope)))
    .sort((a, b) => (a.scope === "*" ? 1 : 0) - (b.scope === "*" ? 1 : 0))[0];
  if (template) return templateToInput(template);
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/\bcondition\b/.test(id) || (s && CONDITION_WORDS.has(s) && /\b(state|shape|quality)\b/.test(id))) {
    return { label, kind: "condition" };
  }
  if (/\b(rating|stars?|score)\b/.test(id) && (typeof value === "number" || /^\d+(\s*\/\s*\d+)?$/.test(s))) {
    return { label, kind: "rating" };
  }
  if (typeof value === "boolean" || ["yes", "no", "true", "false"].includes(s)) return { label, kind: "boolean" };
  if (typeof value === "number" || /^-?[\d,]+(\.\d+)?$/.test(s)) return { label, kind: "number" };
  if (/^\$\s?[\d,]+(\.\d+)?k?$/.test(s)) return { label, kind: "currency" };
  if (/^-?[\d.]+\s?%$/.test(s)) return { label, kind: "percent" };
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return { label, kind: "date" };
  if (/^https?:\/\//.test(s)) return { label, kind: "url" };
  return { label, kind: typeof value === "string" && value.length > 200 ? "longtext" : "text" };
}

/** "roofCondition" / "roof_condition" → "roof condition", for matching a field key to a characteristic. */
export function fieldKeyIdentity(key: string): string {
  return labelIdentity(String(key || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));
}

// ── Quick add: one line of what the user typed → a typed detail ─────────────
//
// Owner request 2026-11-21: "I have a cracked screen on my iPhone. I type
// 'Cracked screen' — that's it." One box, no characteristic/type/value form:
//   "Cracked screen"          → Cracked screen = Yes   (a yes/no flag)
//   "Color: Blue" / "Color = Blue"
//                             → Color = Blue            (label : value)
//   "Condition good"          → Condition = Good        (a known name + value)
//   "Mileage 45000"           → Mileage = 45,000        (a trailing number)
//   "Condition"               → asks for a value (an existing non-yes/no name)
// The result is still a TYPED value (Rule D2): a flag is a yes/no, a value is
// inferred by `inferDetailDefinition`, and an existing name keeps its type.

export type QuickDetail =
  | {
      status: "ready";
      label: string;
      /** The existing characteristic this reuses, if any. */
      existing: DetailDefinition | null;
      /** The new characteristic to define (null when reusing). */
      input: DefinitionInput | null;
      kind: DetailKind;
      value: DetailValue;
      /** "Cracked screen · Yes" — what will be saved. */
      display: string;
    }
  | {
      status: "needs_value";
      label: string;
      existing: DetailDefinition | null;
      input: DefinitionInput | null;
      kind: DetailKind;
    }
  | { status: "invalid"; label: string; error: string };

const TRAILING_PREPOSITION = /\b(in|on|at|since|from|for|of|by|to|with|about)$/i;

function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function cleanQuickLabel(s: string): string {
  return sentenceCase(String(s || "").trim().replace(/\s+/g, " ").replace(/[.!]+$/, "")).slice(0, MAX_LABEL_LENGTH);
}

function applicableTemplate(label: string, tokens: readonly string[]): DetailTemplate | undefined {
  const id = labelIdentity(label);
  return DETAIL_TEMPLATES
    .filter((t) => labelIdentity(t.label) === id && (t.scope === "*" || tokens.includes(t.scope)))
    .sort((a, b) => (a.scope === "*" ? 1 : 0) - (b.scope === "*" ? 1 : 0))[0];
}

function inputAsDefinition(input: DefinitionInput, label: string): Pick<DetailDefinition, "kind" | "options" | "min" | "max" | "scaleMax" | "label" | "unit"> {
  return {
    label,
    kind: isDetailKind(input.kind) ? input.kind : "text",
    options: Array.isArray(input.options) ? (input.options as string[]) : undefined,
    unit: typeof input.unit === "string" ? input.unit : undefined,
    scaleMax: typeof input.scaleMax === "number" ? input.scaleMax : undefined,
  };
}

/** A label and a value the user typed → the characteristic it lands in. */
function resolveQuickPair(labelRaw: string, valueRaw: string, defs: readonly DetailDefinition[], tokens: readonly string[]): QuickDetail {
  const existing = findDefinitionByLabel(defs, labelRaw);
  if (existing) {
    const v = normalizeDetailValue(existing, valueRaw);
    if (!v.ok) return { status: "invalid", label: existing.label, error: v.error };
    return { status: "ready", label: existing.label, existing, input: null, kind: existing.kind, value: v.value, display: `${existing.label} · ${formatDetailValue(existing, v.value)}` };
  }
  const label = cleanQuickLabel(labelRaw);
  const template = applicableTemplate(label, tokens);
  const candidates: DefinitionInput[] = [];
  if (template) candidates.push(templateToInput(template));
  candidates.push(inferDetailDefinition(label, valueRaw, tokens));
  for (const c of candidates) {
    const input = { ...c, label: template && c.label === template.label ? template.label : label };
    const def = inputAsDefinition(input, String(input.label));
    const v = normalizeDetailValue(def, valueRaw);
    if (v.ok) return { status: "ready", label: def.label, existing: null, input, kind: def.kind, value: v.value, display: `${def.label} · ${formatDetailValue(def, v.value)}` };
  }
  return { status: "invalid", label, error: `Couldn't read "${valueRaw}" as ${label}` };
}

export function parseQuickDetail(text: string, defs: readonly DetailDefinition[], tokens: readonly string[]): QuickDetail | null {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return null;

  // 1. "Label: value" / "Label = value".
  const pair = /^([^:=]+?)\s*[:=]\s*(.+)$/.exec(t);
  if (pair && pair[1].trim() && pair[2].trim()) return resolveQuickPair(pair[1], pair[2].trim(), defs, tokens);

  // 2. The whole line names a characteristic already tracked (or a library one).
  const existing = findDefinitionByLabel(defs, t);
  if (existing) {
    if (existing.kind === "boolean") {
      return { status: "ready", label: existing.label, existing, input: null, kind: "boolean", value: true, display: `${existing.label} · Yes` };
    }
    return { status: "needs_value", label: existing.label, existing, input: null, kind: existing.kind };
  }
  const template = applicableTemplate(t, tokens);
  if (template) {
    const input = templateToInput(template);
    if (template.kind === "boolean") {
      return { status: "ready", label: template.label, existing: null, input, kind: "boolean", value: true, display: `${template.label} · Yes` };
    }
    return { status: "needs_value", label: template.label, existing: null, input, kind: template.kind };
  }

  // 3. A known name followed by its value: "Condition good", "Year built 1998".
  const known = [
    ...defs.map((d) => d.label),
    ...DETAIL_TEMPLATES.filter((tp) => tp.scope === "*" || tokens.includes(tp.scope)).map((tp) => tp.label),
  ].sort((a, b) => b.length - a.length);
  const lower = labelIdentity(t);
  for (const name of known) {
    const id = labelIdentity(name);
    if (lower.startsWith(`${id} `)) {
      const rest = t.slice(id.length).trim();
      const r = resolveQuickPair(name, rest, defs, tokens);
      if (r.status === "ready") return r;
    }
  }

  // 4. A trailing number, amount or percent: "Mileage 45000", "Battery health 87%".
  const num = /^(.*[a-z].*?)\s+(\$?\s?-?[\d,]*\.?\d+\s?%?)$/i.exec(t);
  if (num && !TRAILING_PREPOSITION.test(num[1].trim())) {
    const r = resolveQuickPair(num[1], num[2], defs, tokens);
    if (r.status === "ready" && r.kind !== "text") return r;
  }

  // 5. Anything else is a flag on the record: "Cracked screen" → Yes.
  const label = cleanQuickLabel(t);
  if (!label) return null;
  const input: DefinitionInput = { label, kind: "boolean" };
  return { status: "ready", label, existing: null, input, kind: "boolean", value: true, display: `${label} · Yes` };
}
