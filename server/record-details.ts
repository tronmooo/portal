// ─── Record details: the server half ────────────────────────────────────────
//
// The one place that reads and writes user-defined characteristics. The REST
// routes (/api/details/*) and the chat tools (set_record_detail,
// find_records_by_detail) both call these functions, so "Condition = Good"
// typed on the car page and said in chat are validated by the same rules and
// land in the same row.
//
// Storage is preferences-backed (shared/record-details for the keys). Every
// read-modify-write runs under a per-account lock, so two devices setting two
// different characteristics on the same record at once both land — neither
// overwrites the other with an older copy (Rule 6).

import { storage } from "./storage";
import { routeForEntity } from "@shared/entity-routes";
import {
  applyDetailChange, buildDefinition, buildRecordDetailsView, definitionAppliesTo, defaultScopeFor,
  evaluateDetailRules, findDefinition, findDefinitionByLabel, formatDetailValue, isDetailEntityType,
  isDetailOp, isValueCurrent, matchesDetail, normalizeDetailValue, normalizeOperand, opNeedsOperand,
  opsForKind, recordScopeTokens, slugifyDetailId, sortKeyForValue, suggestedTemplates, valueDistribution,
  MAX_DEFINITIONS, DETAIL_OP_LABELS, fieldKeyIdentity, inferDetailDefinition, labelIdentity,
  type DefinitionInput, type DetailDefinition, type DetailEntityType, type DetailFlag, type DetailOp,
  type DetailTemplate, type DetailValue, type RecordDetails, type RecordDetailsView,
} from "@shared/record-details";

export class DetailError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ── Locking ─────────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 4_000;

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    held = await storage.acquireUserLock(name, LOCK_TTL_MS);
    if (held) break;
    if (Date.now() > deadline) throw new DetailError(409, "Another change to this record is still saving — try again in a moment");
    await new Promise((r) => setTimeout(r, 120));
  }
  try {
    return await fn();
  } finally {
    await storage.releaseUserLock(name).catch(() => { /* the ttl frees it */ });
  }
}

const DEFS_LOCK = "detail-definitions";
const recordLock = (t: string, id: string) => `details:${t}:${id}`;

// ── Records ─────────────────────────────────────────────────────────────────

export interface DetailRecordRef {
  entityType: DetailEntityType;
  entityId: string;
  name: string;
  href: string;
  /** What scope tokens are computed from ({ type, type_key }). */
  shape: { type?: string; type_key?: string };
}

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

/**
 * The record a detail is about, or null when it doesn't exist for this user
 * (storage is per-account, so another account's id is simply not found).
 */
export async function loadDetailRecord(entityType: DetailEntityType, entityId: string): Promise<DetailRecordRef | null> {
  const ref = (name: string, shape: DetailRecordRef["shape"], hrefType: string = entityType): DetailRecordRef => ({
    entityType, entityId, name: name || "Untitled", shape, href: routeForEntity(hrefType, entityId),
  });
  switch (entityType) {
    case "profile": {
      const p: any = await storage.getProfile(entityId);
      if (!p || p.deletedAt) return null;
      return ref(str(p.name), { type: str(p.type), type_key: str(p.type_key ?? p.typeKey) });
    }
    case "document": {
      const d: any = await storage.getDocumentMeta(entityId);
      if (!d || d.deletedAt) return null;
      return ref(str(d.name), { type: str(d.type) });
    }
    case "obligation": {
      const o: any = await storage.getObligation(entityId);
      if (!o || o.deletedAt) return null;
      return ref(str(o.name), { type: str(o.category) });
    }
    case "task": {
      const t: any = await storage.getTask(entityId);
      return t && !t.deletedAt ? ref(str(t.title), {}) : null;
    }
    case "event": {
      const e: any = await storage.getEvent(entityId);
      return e && !e.deletedAt ? ref(str(e.title), { type: str(e.category) }) : null;
    }
    case "tracker": {
      const t: any = await storage.getTracker(entityId);
      return t && !t.deletedAt ? ref(str(t.name), { type: str(t.category) }) : null;
    }
    case "habit": {
      const h: any = await storage.getHabit(entityId);
      return h && !h.deletedAt ? ref(str(h.name), {}) : null;
    }
    case "goal": {
      const g: any = await storage.getGoal(entityId);
      return g && !g.deletedAt ? ref(str(g.title), {}) : null;
    }
    case "expense": {
      const x: any = await storage.getExpense(entityId);
      return x && !x.deletedAt ? ref(str(x.description), { type: str(x.category) }) : null;
    }
    case "artifact": {
      const a: any = await storage.getArtifact(entityId);
      return a && !a.deletedAt ? ref(str(a.title), { type: str(a.type) }) : null;
    }
  }
}

async function requireRecord(entityType: unknown, entityId: unknown): Promise<DetailRecordRef> {
  if (!isDetailEntityType(entityType)) throw new DetailError(400, `Details can't be attached to "${String(entityType)}"`);
  const id = String(entityId || "").trim();
  if (!id) throw new DetailError(400, "Which record?");
  const rec = await loadDetailRecord(entityType, id);
  if (!rec) throw new DetailError(404, "Record not found");
  return rec;
}

// ── One record ──────────────────────────────────────────────────────────────

export interface RecordDetailsPayload extends RecordDetailsView {
  name: string;
  suggestions: DetailTemplate[];
}

function payload(rec: DetailRecordRef, defs: DetailDefinition[], details: RecordDetails, todayISO: string): RecordDetailsPayload {
  const view = buildRecordDetailsView({
    entityType: rec.entityType, entityId: rec.entityId, record: rec.shape, definitions: defs, details, todayISO,
  });
  return { ...view, name: rec.name, suggestions: suggestedTemplates(view.scopeTokens, defs) };
}

export async function getRecordDetailsPayload(entityType: unknown, entityId: unknown, todayISO: string): Promise<RecordDetailsPayload> {
  const rec = await requireRecord(entityType, entityId);
  const [defs, details] = await Promise.all([
    storage.getDetailDefinitions(),
    storage.getRecordDetails(rec.entityType, rec.entityId),
  ]);
  return payload(rec, defs, details, todayISO);
}

export interface SetDetailResult {
  payload: RecordDetailsPayload;
  definition: DetailDefinition;
  value: DetailValue | null;
  previous: DetailValue | null;
  display: string;
  record: DetailRecordRef;
  createdDefinition: boolean;
}

/**
 * Set one characteristic on a record. `definition` names an existing one (id
 * or label). The value is normalized against it ("good" → "Good"); a value it
 * can't take is a 400 with the reason, never a silent text fallback.
 */
export async function setRecordDetail(args: {
  entityType: unknown; entityId: unknown; definition: unknown; value: unknown; todayISO: string;
}): Promise<SetDetailResult> {
  const rec = await requireRecord(args.entityType, args.entityId);
  const defs = await storage.getDetailDefinitions();
  const def = findDefinition(defs, String(args.definition ?? ""));
  if (!def) throw new DetailError(404, `No characteristic called "${String(args.definition ?? "")}" yet`);
  return writeValue(rec, defs, def, args.value, args.todayISO, false);
}

async function writeValue(
  rec: DetailRecordRef, defs: DetailDefinition[], def: DetailDefinition, raw: unknown, todayISO: string, createdDefinition: boolean,
): Promise<SetDetailResult> {
  const clearing = raw === null;
  let value: DetailValue | null = null;
  if (!clearing) {
    const norm = normalizeDetailValue(def, raw);
    if (!norm.ok) throw new DetailError(400, norm.error);
    value = norm.value;
  }
  const now = new Date().toISOString();
  return withLock(recordLock(rec.entityType, rec.entityId), async () => {
    // Read the latest row INSIDE the lock: the change is applied to what is
    // stored now, not to what the caller saw.
    const current = await storage.getRecordDetails(rec.entityType, rec.entityId);
    const previous = current.values[def.id]?.value ?? null;
    const next = applyDetailChange(current, def.id, value, now);
    if (next !== current) await storage.saveRecordDetails(rec.entityType, rec.entityId, next);
    return {
      payload: payload(rec, defs, next, todayISO),
      definition: def,
      value,
      previous,
      display: value === null ? "—" : formatDetailValue(def, value),
      record: rec,
      createdDefinition,
    };
  });
}

export async function clearRecordDetail(args: { entityType: unknown; entityId: unknown; definition: unknown; todayISO: string }): Promise<SetDetailResult> {
  const rec = await requireRecord(args.entityType, args.entityId);
  const defs = await storage.getDetailDefinitions();
  const def = findDefinition(defs, String(args.definition ?? ""));
  if (!def) throw new DetailError(404, "Characteristic not found");
  return writeValue(rec, defs, def, null, args.todayISO, false);
}

/**
 * "Add a detail" on the spot: name a characteristic (and its type when it's
 * new) and give its value, in one step. An existing characteristic with the
 * same name is REUSED — one "Condition", not one per record — and its scope
 * widened to cover this record if it didn't already.
 */
export async function defineAndSetRecordDetail(args: {
  entityType: unknown; entityId: unknown; definition: DefinitionInput; value: unknown; todayISO: string;
}): Promise<SetDetailResult> {
  const rec = await requireRecord(args.entityType, args.entityId);
  const scope = defaultScopeFor(rec.entityType, rec.shape);
  const tokens = recordScopeTokens(rec.entityType, rec.shape);
  const { definition, created } = await upsertDefinition(
    { ...args.definition, appliesTo: args.definition.appliesTo ?? [scope] },
    { widenTo: tokens.includes(scope) ? scope : rec.entityType, tokens },
  );
  const defs = await storage.getDetailDefinitions();
  if (args.value === undefined || args.value === null || args.value === "") {
    // A definition with no value yet: nothing to write on the record.
    const details = await storage.getRecordDetails(rec.entityType, rec.entityId);
    return { payload: payload(rec, defs, details, args.todayISO), definition, value: null, previous: null, display: "—", record: rec, createdDefinition: created };
  }
  return writeValue(rec, defs, definition, args.value, args.todayISO, created);
}

// ── Definitions ─────────────────────────────────────────────────────────────

export async function listDefinitions(): Promise<DetailDefinition[]> {
  return storage.getDetailDefinitions();
}

/**
 * Create a definition, or return the existing one with the same name. When
 * reusing, the kind must agree (a "Condition" that is a scale can't become a
 * free-text field by being named again), and `widenTo` is added to its scope
 * if the record it's being used on isn't covered.
 */
export async function upsertDefinition(
  input: DefinitionInput,
  opts: { widenTo?: string; tokens?: readonly string[] } = {},
): Promise<{ definition: DetailDefinition; created: boolean }> {
  return withLock(DEFS_LOCK, async () => {
    const defs = await storage.getDetailDefinitions();
    const existing = typeof input.label === "string" ? findDefinitionByLabel(defs, input.label) : undefined;
    if (existing) {
      if (input.kind !== undefined && input.kind !== existing.kind) {
        throw new DetailError(409, `"${existing.label}" already exists as a ${kindName(existing)} characteristic`);
      }
      if (opts.widenTo && opts.tokens && !definitionAppliesTo(existing, opts.tokens)) {
        const widened = { ...existing, appliesTo: [...existing.appliesTo, opts.widenTo], updatedAt: new Date().toISOString() };
        await storage.saveDetailDefinitions(defs.map((d) => (d.id === existing.id ? widened : d)));
        return { definition: widened, created: false };
      }
      return { definition: existing, created: false };
    }
    if (defs.length >= MAX_DEFINITIONS) throw new DetailError(400, `You can have up to ${MAX_DEFINITIONS} characteristics`);
    const id = slugifyDetailId(String(input.label ?? ""), new Set(defs.map((d) => d.id)));
    const built = buildDefinition(input, { id, now: new Date().toISOString() });
    if (!built.ok) throw new DetailError(400, built.error);
    await storage.saveDetailDefinitions([...defs, built.value]);
    return { definition: built.value, created: true };
  });
}

function kindName(def: DetailDefinition): string {
  const names: Record<string, string> = {
    text: "text", longtext: "long text", number: "number", currency: "money", percent: "percent", date: "date",
    boolean: "yes/no", select: "dropdown", multiselect: "multiple-choice", condition: "condition-scale", rating: "rating", url: "link",
  };
  return names[def.kind] || def.kind;
}

/**
 * Edit a definition. Renaming an option (`renameOptions: { Old: New }`)
 * rewrites every record that holds the old option, so a value never silently
 * falls out of its list. A change of type is refused while any stored value
 * wouldn't fit the new type.
 */
export async function updateDefinition(id: string, input: DefinitionInput & { renameOptions?: unknown }): Promise<DetailDefinition> {
  const renames = cleanRenames(input.renameOptions);
  const updated = await withLock(DEFS_LOCK, async () => {
    const defs = await storage.getDetailDefinitions();
    const existing = defs.find((d) => d.id === id);
    if (!existing) throw new DetailError(404, "Characteristic not found");
    if (typeof input.label === "string") {
      const clash = findDefinitionByLabel(defs, input.label);
      if (clash && clash.id !== id) throw new DetailError(409, `There is already a characteristic called "${clash.label}"`);
    }
    const built = buildDefinition(input, { id, now: new Date().toISOString(), existing });
    if (!built.ok) throw new DetailError(400, built.error);
    if (built.value.kind !== existing.kind) {
      const rows = await storage.listRecordDetails();
      const misfits = rows.filter((r) => {
        const v = r.details.values[id]?.value;
        return v !== undefined && !isValueCurrent(built.value, v);
      }).length;
      if (misfits > 0) {
        throw new DetailError(409, `${misfits} record${misfits === 1 ? " has a value" : "s have values"} that wouldn't fit a ${kindName(built.value)} — clear or change ${misfits === 1 ? "it" : "them"} first`);
      }
    }
    await storage.saveDetailDefinitions(defs.map((d) => (d.id === id ? built.value : d)));
    return built.value;
  });
  if (Object.keys(renames).length > 0 && ["select", "multiselect", "condition"].includes(updated.kind)) {
    await rewriteValues(id, (v) => {
      if (typeof v === "string") return renames[v] ?? v;
      if (Array.isArray(v)) return [...new Set(v.map((x) => renames[x] ?? x))];
      return v;
    });
  }
  return updated;
}

function cleanRenames(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof to === "string" && to.trim() && from !== to) out[from] = to.trim();
  }
  return out;
}

/** Apply `map` to every stored value of one definition (record by record, each under its lock). */
async function rewriteValues(defId: string, map: (v: DetailValue) => DetailValue | null): Promise<number> {
  const rows = await storage.listRecordDetails();
  let changed = 0;
  for (const row of rows) {
    if (!(defId in row.details.values)) continue;
    await withLock(recordLock(row.entityType, row.entityId), async () => {
      const current = await storage.getRecordDetails(row.entityType, row.entityId);
      const entry = current.values[defId];
      if (!entry) return;
      const nextValue = map(entry.value);
      const next = applyDetailChange(current, defId, nextValue, new Date().toISOString());
      if (next !== current) { await storage.saveRecordDetails(row.entityType, row.entityId, next); changed++; }
    });
  }
  return changed;
}

/** Delete a definition and every value recorded under it. */
export async function deleteDefinition(id: string): Promise<{ removedValues: number }> {
  await withLock(DEFS_LOCK, async () => {
    const defs = await storage.getDetailDefinitions();
    if (!defs.some((d) => d.id === id)) throw new DetailError(404, "Characteristic not found");
    await storage.saveDetailDefinitions(defs.filter((d) => d.id !== id));
  });
  const removedValues = await rewriteValues(id, () => null);
  return { removedValues };
}

/** How many records hold a value for each definition (the catalog's "used on" count). */
export async function definitionUsage(): Promise<Record<string, number>> {
  const rows = await storage.listRecordDetails();
  const out: Record<string, number> = {};
  for (const r of rows) for (const k of Object.keys(r.details.values)) out[k] = (out[k] || 0) + 1;
  return out;
}

// ── Reports ─────────────────────────────────────────────────────────────────

export interface DetailReportRow {
  entityType: DetailEntityType;
  entityId: string;
  name: string;
  href: string;
  scope: string;
  value: DetailValue | null;
  display: string;
  updatedAt: string | null;
  flags: DetailFlag[];
}

export interface DetailReport {
  definition: DetailDefinition;
  filter: { op: DetailOp; value?: unknown; label: string } | null;
  /** Records the characteristic applies to or has a value on. */
  total: number;
  rows: DetailReportRow[];
  distribution: Array<{ value: string; count: number }>;
}

/**
 * Resolve the records behind a set of (type, id) pairs. Profiles come from
 * one list read; the rest are read one by one (a user's details live on a
 * handful of non-profile records, not thousands).
 */
async function resolveRecords(pairs: Array<{ entityType: DetailEntityType; entityId: string }>): Promise<Map<string, DetailRecordRef>> {
  const out = new Map<string, DetailRecordRef>();
  const profiles: any[] = await storage.getProfiles().catch(() => [] as any[]);
  const byId = new Map(profiles.map((p: any) => [String(p.id), p]));
  await Promise.all(pairs.map(async ({ entityType, entityId }) => {
    const key = `${entityType}:${entityId}`;
    if (entityType === "profile") {
      const p = byId.get(entityId);
      if (p && !p.deletedAt) {
        out.set(key, {
          entityType, entityId, name: str(p.name) || "Untitled", href: routeForEntity("profile", entityId),
          shape: { type: str(p.type), type_key: str(p.type_key ?? p.typeKey) },
        });
      }
      return;
    }
    const rec = await loadDetailRecord(entityType, entityId).catch(() => null);
    if (rec) out.set(key, rec);
  }));
  return out;
}

/**
 * Every record that has, or is expected to have, one characteristic — with an
 * optional filter ("Condition is at or worse than Fair"). Records it applies
 * to but that have no value are included (as "—"), so "which cars have no
 * condition recorded" is answerable too.
 */
export async function detailReport(args: { definition: unknown; op?: unknown; value?: unknown; todayISO: string }): Promise<DetailReport> {
  const defs = await storage.getDetailDefinitions();
  const def = findDefinition(defs, String(args.definition ?? ""));
  if (!def) throw new DetailError(404, `No characteristic called "${String(args.definition ?? "")}"`);

  let filter: DetailReport["filter"] = null;
  let operand: unknown;
  if (args.op !== undefined && args.op !== null && args.op !== "") {
    if (!isDetailOp(args.op) || !opsForKind(def.kind).includes(args.op)) {
      throw new DetailError(400, `"${String(args.op)}" isn't a comparison for ${def.label}`);
    }
    if (opNeedsOperand(args.op)) {
      const o = normalizeOperand(def, args.op, args.value);
      if (!o.ok) throw new DetailError(400, o.error);
      operand = o.value;
    }
    filter = { op: args.op, ...(operand !== undefined ? { value: operand } : {}), label: DETAIL_OP_LABELS[args.op] };
  }

  const stored = await storage.listRecordDetails();
  const withValue = stored.filter((r) => def.id in r.details.values);
  // Records the characteristic applies to but that carry no value: only
  // profiles can be enumerated cheaply, and they are where "expected but
  // missing" matters (every car should have a condition).
  const profiles: any[] = await storage.getProfiles().catch(() => [] as any[]);
  const has = new Set(withValue.map((r) => `${r.entityType}:${r.entityId}`));
  const missingProfiles = profiles.filter((p: any) => !p.deletedAt && !has.has(`profile:${p.id}`)
    && definitionAppliesTo(def, recordScopeTokens("profile", { type: p.type, type_key: p.type_key ?? p.typeKey })));

  const refs = await resolveRecords(withValue.map((r) => ({ entityType: r.entityType, entityId: r.entityId })));
  const rows: DetailReportRow[] = [];
  for (const r of withValue) {
    const ref = refs.get(`${r.entityType}:${r.entityId}`);
    if (!ref) continue; // the record was deleted; its details wait for a restore
    const entry = r.details.values[def.id];
    const applies = definitionAppliesTo(def, recordScopeTokens(ref.entityType, ref.shape));
    rows.push({
      entityType: ref.entityType, entityId: ref.entityId, name: ref.name, href: ref.href,
      scope: ref.shape.type || ref.entityType,
      value: entry.value, display: formatDetailValue(def, entry.value), updatedAt: entry.updatedAt || null,
      flags: evaluateDetailRules(def, entry.value, args.todayISO, applies),
    });
  }
  for (const p of missingProfiles) {
    rows.push({
      entityType: "profile", entityId: String(p.id), name: str(p.name) || "Untitled", href: routeForEntity("profile", String(p.id)),
      scope: str(p.type) || "profile", value: null, display: "—", updatedAt: null,
      flags: evaluateDetailRules(def, null, args.todayISO, true),
    });
  }

  const distribution = valueDistribution(def, rows.map((r) => r.value));
  const matched = filter
    ? rows.filter((r) => matchesDetail(def, r.value, filter!.op, operand as any, args.todayISO))
    : rows;
  matched.sort((a, b) => {
    // Missing values last, whatever the type's own ordering.
    if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
    const ka = sortKeyForValue(def, a.value), kb = sortKeyForValue(def, b.value);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.name.localeCompare(b.name);
  });
  return { definition: def, filter, total: rows.length, rows: matched, distribution };
}

export interface DetailFlagRow {
  entityType: DetailEntityType;
  entityId: string;
  name: string;
  href: string;
  flag: DetailFlag;
}

/** Every flag every rule raises right now, worst first — derived, never stored. */
export async function allDetailFlags(todayISO: string): Promise<DetailFlagRow[]> {
  const [defs, stored, profiles] = await Promise.all([
    storage.getDetailDefinitions(),
    storage.listRecordDetails(),
    storage.getProfiles().catch(() => [] as any[]),
  ]);
  if (defs.length === 0) return [];
  const refs = await resolveRecords(stored.map((r) => ({ entityType: r.entityType, entityId: r.entityId })));
  const out: DetailFlagRow[] = [];
  const seen = new Set<string>();
  for (const r of stored) {
    const ref = refs.get(`${r.entityType}:${r.entityId}`);
    if (!ref) continue;
    seen.add(`${r.entityType}:${r.entityId}`);
    const tokens = recordScopeTokens(ref.entityType, ref.shape);
    for (const def of defs) {
      const applies = definitionAppliesTo(def, tokens);
      const v = r.details.values[def.id]?.value ?? null;
      if (v === null && !applies) continue;
      for (const flag of evaluateDetailRules(def, v, todayISO, applies)) {
        out.push({ entityType: ref.entityType, entityId: ref.entityId, name: ref.name, href: ref.href, flag });
      }
    }
  }
  // Profiles with no details row at all can still be missing a required one.
  const required = defs.filter((d) => d.required || (d.rules || []).some((x) => x.op === "empty"));
  if (required.length > 0) {
    for (const p of profiles as any[]) {
      if (p.deletedAt || seen.has(`profile:${p.id}`)) continue;
      const tokens = recordScopeTokens("profile", { type: p.type, type_key: p.type_key ?? p.typeKey });
      for (const def of required) {
        if (!definitionAppliesTo(def, tokens)) continue;
        for (const flag of evaluateDetailRules(def, null, todayISO, true)) {
          out.push({ entityType: "profile", entityId: String(p.id), name: str(p.name) || "Untitled", href: routeForEntity("profile", String(p.id)), flag });
        }
      }
    }
  }
  const rank = { critical: 2, warning: 1, info: 0 } as const;
  return out.sort((a, b) => rank[b.flag.severity] - rank[a.flag.severity] || a.name.localeCompare(b.name));
}

/**
 * Records whose detail values match a free-text query ("good", "red") — what
 * global search adds so a characteristic is findable, not only visible.
 */
export async function searchDetailValues(query: string, limit = 20): Promise<Array<DetailReportRow & { definition: string }>> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const [defs, stored] = await Promise.all([storage.getDetailDefinitions(), storage.listRecordDetails()]);
  if (defs.length === 0 || stored.length === 0) return [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const hits: Array<{ r: (typeof stored)[number]; def: DetailDefinition; value: DetailValue; display: string; updatedAt: string }> = [];
  for (const r of stored) {
    for (const [defId, entry] of Object.entries(r.details.values)) {
      const def = byId.get(defId);
      if (!def) continue;
      const display = formatDetailValue(def, entry.value);
      const hay = `${def.label} ${display}`.toLowerCase();
      if (hay.includes(q) || display.toLowerCase() === q) hits.push({ r, def, value: entry.value, display, updatedAt: entry.updatedAt });
    }
  }
  const refs = await resolveRecords(hits.slice(0, limit * 2).map((h) => ({ entityType: h.r.entityType, entityId: h.r.entityId })));
  const out: Array<DetailReportRow & { definition: string }> = [];
  for (const h of hits) {
    const ref = refs.get(`${h.r.entityType}:${h.r.entityId}`);
    if (!ref) continue;
    out.push({
      entityType: ref.entityType, entityId: ref.entityId, name: ref.name, href: ref.href, scope: ref.shape.type || ref.entityType,
      value: h.value, display: h.display, updatedAt: h.updatedAt || null, flags: [], definition: h.def.label,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Chat helpers ────────────────────────────────────────────────────────────

/**
 * One source per value: when chat's update_profile writes a field whose name
 * is a characteristic the user DEFINED ("Condition", "Roof age"), the value
 * goes to that characteristic — typed and validated — not into a loose field
 * next to it. A value the characteristic can't hold stays in `fields` (nothing
 * is lost), and so does a key the record already carries as a field (moving
 * one of two copies would leave them disagreeing). Mutates `fields`.
 */
export async function divertDefinedDetails(
  entityType: DetailEntityType,
  entityId: string,
  fields: Record<string, unknown>,
  existingFields: Record<string, unknown> | null | undefined,
  todayISO: string,
): Promise<Array<{ label: string; display: string; previous: string | null }>> {
  // Best effort, never in the way of the profile write that called it.
  let defs: DetailDefinition[] = [];
  try { defs = await storage.getDetailDefinitions(); } catch { return []; }
  if (!Array.isArray(defs) || defs.length === 0) return [];
  const held = new Set(Object.keys(existingFields || {}).map(fieldKeyIdentity));
  const out: Array<{ label: string; display: string; previous: string | null }> = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === null || raw === undefined || (typeof raw === "object" && !Array.isArray(raw))) continue;
    const id = fieldKeyIdentity(key);
    if (held.has(id)) continue;
    const def = defs.find((d) => labelIdentity(d.label) === id);
    if (!def || !normalizeDetailValue(def, raw).ok) continue;
    try {
      const r = await setRecordDetail({ entityType, entityId, definition: def.id, value: raw, todayISO });
      delete fields[key];
      out.push({ label: def.label, display: r.display, previous: r.previous === null ? null : formatDetailValue(def, r.previous) });
    } catch { /* leave it in fields */ }
  }
  return out;
}

/** The type to give a characteristic the chat names for the first time. */
export function inferDefinitionForRecord(rec: DetailRecordRef, label: string, value: unknown): DefinitionInput {
  return inferDetailDefinition(label, value, recordScopeTokens(rec.entityType, rec.shape));
}

/**
 * Global search: add the records whose characteristic VALUES match the query
 * ("poor", "signed"), tagged like any other /api/search row plus
 * `_matchedDetail` ("Condition: Poor") so the palette can say why it matched.
 * A record already in the results is not repeated. Best effort — search never
 * fails because of details.
 */
export async function appendDetailSearchHits(results: any[], query: string): Promise<any[]> {
  let hits: Awaited<ReturnType<typeof searchDetailValues>> = [];
  try { hits = await searchDetailValues(query, 15); } catch { return results; }
  if (hits.length === 0) return results;
  const have = new Set(results.map((r) => `${r?._type}:${r?.id}`));
  const profiles: any[] = hits.some((h) => h.entityType === "profile") ? await storage.getProfiles().catch(() => [] as any[]) : [];
  const out = [...results];
  for (const h of hits) {
    const key = `${h.entityType}:${h.entityId}`;
    if (have.has(key)) continue;
    have.add(key);
    let row: any = null;
    if (h.entityType === "profile") row = profiles.find((p: any) => String(p.id) === h.entityId) || null;
    else if (h.entityType === "document") {
      const meta: any = await storage.getDocumentMeta(h.entityId).catch(() => null);
      if (meta) { row = { ...meta }; delete row.fileData; }
    }
    if (!row) row = { id: h.entityId, name: h.name, title: h.name };
    out.push({ ...row, _type: h.entityType, href: h.href, _matchedDetail: `${h.definition}: ${h.display}` });
  }
  return out;
}
