// server/action-executor.ts — the "Save" stage of document processing.
// =============================================================================
//
// `shared/extraction-actions.ts` decided what should happen and the user
// reviewed it. This performs those writes, and its whole job is to do so in an
// order that respects the dependencies between them and to report honestly when
// part of it fails.
//
// FOUR STAGES, AND WHY THE ORDER IS NOT A CONVENTION
//
//   1. Entities   — the records everything else refers to.
//   2. Records    — fields, trackers, obligations, expenses, notes.
//   3. Links      — relationships and document filing. A link needs both ends
//                   to exist, which is the entire reason stages 1 and 2 come
//                   first rather than everything running in one loop.
//   4. Dates      — calendar opt-outs and the standalone events that are the
//                   only home for a date no record derives.
//
// A stage-1 failure marks every action targeting that entity `skipped` rather
// than attempting it. Attempting it produces a cascade of secondary errors that
// bury the one real cause; skipping it says "the property could not be written,
// so the six things about the property did not happen" — which is what the user
// actually needs to read.
//
// IDEMPOTENCY IS BY dedupeKey. The planner computes it purely, from the
// document id and the target identity, so confirming twice, re-extracting, or a
// double-tapped Confirm button all produce the same keys — and the second run
// finds its own marks already on the records and writes nothing. That is what
// makes this safe to retry.
// =============================================================================

import { storage } from "./storage";
import { logger } from "./logger";
import type { ProposedAction } from "@shared/extraction-actions";
import { canonicalizeProfileFields } from "@shared/profile-field-canon";
import { mergeFieldWrite, fieldIdentity, fieldValuePersisted } from "@shared/profile-field-identity";
import { canonicalExpenseCategory, canonicalObligationCategory } from "@shared/category-canon";
import { normalizeTrackerEntry } from "./tracker-normalize";
import { findIdentityMatches } from "@shared/tracker-identity";
import { MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE, type Tracker } from "@shared/schema";
import { getUserToday } from "@shared/timezone";

const CAT = "action-executor";

export interface ActionResult {
  actionId: string;
  status: "ok" | "failed" | "skipped";
  message: string;
}

export interface ExecuteOutcome {
  results: ActionResult[];
  saved: string[];
  failures: string[];
  /**
   * Field paths the user chose to keep on the document only. The caller folds
   * these into the document's `_calendarOptOut` so the rule engine stops
   * deriving a calendar entry for them.
   */
  calendarOptOuts: string[];
  /** Profile ids this run wrote to — the caller busts their caches. */
  touchedProfileIds: string[];
}

/** The marker a write leaves so a re-run recognises its own work. */
const APPLIED_KEY = "_extractionActions";

export interface ExecuteInput {
  actions: ProposedAction[];
  documentId: string;
  documentName?: string;
}

/**
 * Run a reviewed plan.
 *
 * Never throws: a single bad action must not cost the user the other eleven.
 * Every failure is caught, named against its action, and reported.
 */
export async function executeActions(input: ExecuteInput): Promise<ExecuteOutcome> {
  const out: ExecuteOutcome = {
    results: [], saved: [], failures: [], calendarOptOuts: [], touchedProfileIds: [],
  };
  const actions = [...(input.actions || [])]
    .filter((a) => a && a.id && a.operation !== "NO_ACTION" && a.selected !== false)
    .sort((a, b) => (a.stage ?? 2) - (b.stage ?? 2));

  // Reference rows carry no write, but they DO carry a decision: keep this on
  // the document and derive nothing from it. Collected separately because they
  // are filtered out above.
  for (const a of input.actions || []) {
    if (a?.destination === "reference" && a?.payload?.calendarOptOut && a.payload?.key) {
      out.calendarOptOuts.push(String(a.payload.key));
    }
  }

  if (actions.length === 0) return out;

  /**
   * Records a write failed against. Everything else aimed at them is SKIPPED
   * rather than attempted — not because of which stage it happened in, but
   * because the record is known to be unwritable right now, and eleven more
   * failures against it bury the one real cause.
   */
  const brokenTargets = new Set<string>();
  const touched = new Set<string>();

  const ok = (a: ProposedAction, message: string) => {
    out.results.push({ actionId: a.id, status: "ok", message });
    out.saved.push(message);
  };
  const failed = (a: ProposedAction, message: string) => {
    out.results.push({ actionId: a.id, status: "failed", message });
    out.failures.push(message);
    logger.warn(CAT, `${a.id}: ${message}`);
  };
  const skipped = (a: ProposedAction, message: string) => {
    out.results.push({ actionId: a.id, status: "skipped", message });
  };

  for (const action of actions) {
    const targetId = action.target?.id
      ?? (action.payload?.profileId ? String(action.payload.profileId) : undefined)
      ?? undefined;
    if (targetId && brokenTargets.has(targetId)) {
      skipped(action, `${action.title} — skipped: ${action.target.name} could not be written`);
      continue;
    }
    try {
      switch (action.destination) {
        case "profile":
        case "entity_field":
        case "entity_record": {
          const res = await writeFieldsToProfile(action, input.documentId);
          if (res.wrote > 0) {
            touched.add(res.profileId);
            ok(action, `Saved ${res.wrote} field${res.wrote === 1 ? "" : "s"} to ${res.profileName}${action.payload.group ? ` (${action.payload.group})` : ""}`);
          } else if (res.alreadyApplied) {
            skipped(action, `${action.title} — already saved`);
          } else {
            failed(action, `fields did not persist to ${res.profileName}: ${res.unsaved.join(", ")}`);
            if (res.profileId) brokenTargets.add(res.profileId);
          }
          break;
        }

        case "calendar": {
          // A date the record carries IS a field write — writing it is what
          // puts the date on the calendar, derived. Only a date with no record
          // behind it needs a standalone event, which is stage 4.
          if (action.payload?.fields && action.payload?.profileId) {
            const res = await writeFieldsToProfile(action, input.documentId);
            if (res.wrote > 0 || res.alreadyApplied) {
              touched.add(res.profileId);
              ok(action, `${action.title} — ${action.payload.date} on ${res.profileName}`);
            } else {
              failed(action, `${action.title}: date did not persist to ${res.profileName}`);
            }
          } else {
            const ev = await storage.createEvent({
              title: String(action.payload?.title || action.title),
              date: String(action.payload?.date),
              category: "other",
              tags: ["document-extraction", "date-rule-uncovered"],
              linkedDocuments: [input.documentId],
            } as any);
            ok(action, `Added "${ev.title}" to the calendar`);
          }
          break;
        }

        case "tracker":
        case "profile_tracker": {
          const msg = await appendTrackerEntry(action, input.documentId);
          ok(action, msg);
          break;
        }

        case "obligation": {
          const msg = await writeObligation(action, input.documentId);
          ok(action, msg);
          break;
        }

        case "expense": {
          const msg = await writeExpense(action, input.documentId);
          ok(action, msg);
          break;
        }

        case "income": {
          const amount = requireAmount(action.payload?.amount);
          const inc = await storage.createIncome({
            source: String(action.payload?.name || action.title),
            amount,
            date: String(action.payload?.date || today()),
            category: "general",
            linkedProfiles: targetId ? [targetId] : [],
          } as any);
          ok(action, `Recorded income: $${amount.toFixed(2)} ${(inc as any).source}`);
          break;
        }

        case "note": {
          const art = await storage.createArtifact({
            type: "note",
            title: String(action.payload?.title || action.title),
            content: String(action.payload?.content || ""),
            linkedProfiles: targetId ? [targetId] : [],
            linkedDocuments: [input.documentId],
          } as any);
          ok(action, `Saved note: ${(art as any).title}`);
          break;
        }

        case "relationship_link": {
          const msg = await writeRelationship(action);
          ok(action, msg);
          break;
        }

        case "document_attach": {
          const pid = String(action.payload?.profileId || targetId || "");
          if (!pid) { skipped(action, "nothing to attach to"); break; }
          await storage.linkProfileTo(pid, "document", input.documentId);
          try { await storage.propagateDocumentToAncestors(input.documentId, pid); } catch { /* best effort */ }
          ok(action, `Filed under ${action.target.name}`);
          break;
        }

        case "structured_append": {
          const res = await appendStructured(action, input.documentId);
          touched.add(res.profileId);
          ok(action, res.message);
          break;
        }

        default:
          skipped(action, `${action.title} — no writer for ${action.destination}`);
          break;
      }
    } catch (err: any) {
      failed(action, `${action.title}: ${err?.message || "unknown error"}`);
      // Any write that failed against a record makes that record broken for
      // this run. Gating this on stage 1 was wrong: a storage failure surfaces
      // as a throw from whatever stage the write happened to be in, and the
      // dependents were then attempted one by one and failed one by one.
      const failedTargetId = targetId || (action.payload?.profileId ? String(action.payload.profileId) : "");
      if (failedTargetId) brokenTargets.add(failedTargetId);
    }
  }

  out.touchedProfileIds = [...touched];
  return out;
}

// ─── Field writes ────────────────────────────────────────────────────────────

interface FieldWriteResult {
  profileId: string;
  profileName: string;
  wrote: number;
  unsaved: string[];
  alreadyApplied: boolean;
}

/**
 * Write a bag of fields onto ONE profile, with the same discipline the
 * single-profile confirm path has always used:
 *
 *   canonicalize spellings → merge without clobbering → record provenance →
 *   read back and verify by field IDENTITY, not by literal key.
 *
 * The identity check matters: a value written as `streetAddress` HAS landed
 * when the profile holds it under `address`, and an exact-key comparison
 * reports a perfectly good save as a failure.
 *
 * `_docFields[documentId]` is written PER PROFILE, which is what lets deleting
 * one document remove exactly what it contributed to each of the several
 * profiles it touched — and nothing the user edited since.
 */
async function writeFieldsToProfile(action: ProposedAction, documentId: string): Promise<FieldWriteResult> {
  const profileId = String(action.payload?.profileId || action.target?.id || "");
  if (!profileId) throw new Error("no target profile");
  const profile = await storage.getProfile(profileId);
  if (!profile) throw new Error(`profile ${profileId} not found`);

  const group = action.payload?.group ? String(action.payload.group) : undefined;
  const incomingFields: Record<string, any> = { ...(action.payload?.fields || {}) };
  if (Object.keys(incomingFields).length === 0) {
    return { profileId, profileName: profile.name, wrote: 0, unsaved: [], alreadyApplied: true };
  }

  const existingFields: Record<string, any> = (profile as any).fields || {};

  // Idempotency: this exact action already ran against this profile.
  const appliedMarks = (existingFields[APPLIED_KEY] && typeof existingFields[APPLIED_KEY] === "object")
    ? existingFields[APPLIED_KEY] as Record<string, any>
    : {};
  if (appliedMarks[action.dedupeKey]) {
    return { profileId, profileName: profile.name, wrote: 0, unsaved: [], alreadyApplied: true };
  }

  let merged: Record<string, any>;
  let written: Record<string, any>;

  if (group) {
    // A namespaced group — `insurance.policyNumber`, `loan.accountNumber`.
    // These are the groups shared/profile-field-identity already promotes for
    // display and shared/date-rules already keys its rule ids on by dotted
    // path, so a nested expiration is a distinct date from a top-level one
    // rather than colliding with it.
    const priorGroup = (existingFields[group] && typeof existingFields[group] === "object")
      ? existingFields[group] as Record<string, any>
      : {};
    merged = { ...existingFields, [group]: { ...priorGroup, ...incomingFields } };
    written = incomingFields;
  } else {
    const canonical = canonicalizeProfileFields(incomingFields, existingFields).fields;
    const result = mergeFieldWrite(existingFields, canonical);
    merged = result.fields;
    written = result.written;
  }

  const priorSources = (existingFields._docFields && typeof existingFields._docFields === "object")
    ? existingFields._docFields as Record<string, any>
    : {};
  const contribution = group
    ? Object.fromEntries(Object.entries(written).map(([k, v]) => [`${group}.${k}`, v]))
    : Object.fromEntries(Object.entries(written).filter(([k]) => !k.startsWith("_")));
  merged._docFields = {
    ...priorSources,
    [documentId]: { ...(priorSources[documentId] || {}), ...contribution },
  };
  merged[APPLIED_KEY] = { ...appliedMarks, [action.dedupeKey]: new Date().toISOString() };

  await storage.updateProfile(profileId, { fields: merged });

  // Verify. Claiming a save that did not land is worse than reporting a failure.
  const after = await storage.getProfile(profileId);
  const afterFields: Record<string, any> = (after as any)?.fields || {};
  const unsaved: string[] = [];
  const seen = new Set<string>();
  let wrote = 0;
  for (const [k, v] of Object.entries(written)) {
    if (k.startsWith("_")) continue;
    const landed = group
      ? valueLanded((afterFields[group] || {}) as Record<string, any>, k, v)
      : fieldValuePersisted(afterFields, k, v);
    if (!landed) { unsaved.push(k); continue; }
    const identity = fieldIdentity(k);
    if (seen.has(identity)) continue;
    seen.add(identity);
    wrote++;
  }
  return { profileId, profileName: profile.name, wrote, unsaved, alreadyApplied: false };
}

function valueLanded(bag: Record<string, any>, key: string, value: unknown): boolean {
  const want = fieldIdentity(key);
  for (const [k, v] of Object.entries(bag)) {
    if (fieldIdentity(k) !== want) continue;
    return String(v ?? "").trim() === String(value ?? "").trim() || v === value;
  }
  return false;
}

/**
 * Append a row to a JSONB array on a profile — coverages, holdings, the same
 * convention `fields.allergies[]` already uses. Deduped on a caller-supplied
 * key so a re-uploaded document adds nothing.
 */
async function appendStructured(action: ProposedAction, documentId: string): Promise<{ profileId: string; message: string }> {
  const profileId = String(action.payload?.profileId || action.target?.id || "");
  const arrayKey = String(action.payload?.arrayKey || "");
  const rows: any[] = Array.isArray(action.payload?.rows) ? action.payload.rows : [];
  const keyField = String(action.payload?.keyField || "name");
  if (!profileId || !arrayKey || rows.length === 0) throw new Error("nothing to append");

  const profile = await storage.getProfile(profileId);
  if (!profile) throw new Error(`profile ${profileId} not found`);
  const fields: Record<string, any> = { ...((profile as any).fields || {}) };
  const existing: any[] = Array.isArray(fields[arrayKey]) ? fields[arrayKey] : [];

  const keyOf = (r: any) => String(r?.[keyField] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const byKey = new Map(existing.map((r) => [keyOf(r), r]));
  let added = 0;
  for (const row of rows) {
    const k = keyOf(row);
    if (!k) continue;
    if (byKey.has(k)) {
      // Fill blanks on what is already there; never clobber an edited value.
      const prior = byKey.get(k);
      for (const [f, v] of Object.entries(row)) {
        if (v === null || v === undefined || v === "") continue;
        if (prior[f] === null || prior[f] === undefined || prior[f] === "") prior[f] = v;
      }
      continue;
    }
    const rec = { ...row, source: documentId };
    byKey.set(k, rec);
    existing.push(rec);
    added++;
  }
  fields[arrayKey] = existing;
  await storage.updateProfile(profileId, { fields });
  return {
    profileId,
    message: added > 0
      ? `Saved ${added} ${arrayKey} entr${added === 1 ? "y" : "ies"} to ${profile.name}`
      : `${arrayKey} on ${profile.name} already up to date`,
  };
}

// ─── Trackers ────────────────────────────────────────────────────────────────

/**
 * A measurement becomes a point on a tracker.
 *
 * Tracker choice mirrors `pickTrackerForLog`: a tracker the target profile owns
 * first, then one nobody has claimed. A tracker owned by SOMEONE ELSE is never
 * adopted — that is how one person's reading lands on another person's chart.
 */
async function appendTrackerEntry(action: ProposedAction, documentId: string): Promise<string> {
  const name = String(action.payload?.trackerName || action.target?.name || "").trim();
  if (!name) throw new Error("no tracker named");
  const profileId = action.payload?.profileId ? String(action.payload.profileId) : undefined;

  const trackers = await storage.getTrackers();
  const matches = findIdentityMatches(trackers as any[], name);
  let tracker: any = action.payload?.trackerId
    ? (trackers as any[]).find((t) => t.id === action.payload.trackerId)
    : undefined;
  if (!tracker) {
    tracker = profileId
      ? (matches.find((t: any) => (t.linkedProfiles || []).includes(profileId))
          ?? matches.find((t: any) => (t.linkedProfiles || []).length === 0))
      : matches[0];
  }

  const rawValues = (action.payload?.values && typeof action.payload.values === "object")
    ? action.payload.values : { value: action.payload?.values ?? 0 };
  const unit = String(action.payload?.unit || "");

  let created = false;
  if (!tracker) {
    const fieldKeys = Object.keys(rawValues);
    tracker = await storage.createTracker({
      name,
      unit,
      category: "health",
      fields: fieldKeys.length > 0
        ? fieldKeys.map((k, i) => ({ name: k, type: "number" as const, unit, isPrimary: i === 0, options: [] }))
        : [{ name: "value", type: "number" as const, unit, isPrimary: true, options: [] }],
      linkedProfiles: profileId ? [profileId] : [],
    } as any);
    created = true;
  } else if (profileId && !(tracker.linkedProfiles || []).includes(profileId)) {
    try {
      await storage.updateTracker(tracker.id, {
        linkedProfiles: [...(tracker.linkedProfiles || []), profileId],
      } as Partial<Tracker>);
    } catch { /* non-critical */ }
  }

  const { values } = normalizeTrackerEntry(tracker as any, rawValues);
  await storage.logEntry({
    trackerId: tracker.id,
    values,
    notes: "From document extraction",
    profileId,
  } as any);

  const rendered = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(", ");
  return created
    ? `Started tracking ${tracker.name} — ${rendered}`
    : `Logged ${tracker.name}: ${rendered}`;
}

// ─── Money ───────────────────────────────────────────────────────────────────

function requireAmount(v: unknown): number {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) throw new Error("amount must be a positive number");
  if (n > MAX_TRANSACTION_AMOUNT) throw new Error(TRANSACTION_TOO_LARGE_MESSAGE);
  return n;
}

/**
 * Today, in the user's timezone. Never a hardcoded zone: an expense stamped
 * with a fixed West-Coast date lands on the wrong day for anyone east of it,
 * and a bill dated one day late is a bill that looks paid late.
 */
const today = () => getUserToday();

/**
 * Create or update the ONE record a recurrence produces.
 *
 * `linkedAssetId` plus `autoLogExpense` is how a cost reaches the asset's
 * carrying costs (shared/cost-of-ownership derives them from expenses against
 * owned assets). Writing a separate expense row alongside would count the same
 * commitment twice, which is the failure the whole double-count rule exists to
 * prevent.
 */
async function writeObligation(action: ProposedAction, documentId: string): Promise<string> {
  const p = action.payload || {};
  const amount = requireAmount(p.amount);
  const existingId = p.existingObligationId ? String(p.existingObligationId) : (action.target?.id ?? undefined);

  if (existingId) {
    const patch: Record<string, any> = {
      amount,
      frequency: p.frequency || "monthly",
      linkedDocumentId: documentId,
    };
    if (p.nextDueDate) patch.nextDueDate = String(p.nextDueDate);
    if (p.recurrenceEnd) patch.recurrenceEnd = String(p.recurrenceEnd);
    const updated = await storage.updateObligation(existingId, patch as any);
    if (!updated) throw new Error(`obligation ${existingId} not found`);
    return `Updated recurring bill: $${amount.toFixed(2)} ${(updated as any).name}`;
  }

  if (!p.nextDueDate) throw new Error("a recurring bill needs a next due date");

  // Idempotency across confirms: a bill this document already created is not
  // created again. Keyed on the document plus the planner's dedupeKey, both of
  // which are stable across re-extraction.
  const priors = await storage.getObligations();
  const dup = (priors || []).find((o: any) =>
    o?.linkedDocumentId === documentId &&
    (o?.fields?._extractionAction === action.dedupeKey ||
      Math.abs(Number(o?.amount) - amount) < 0.005));
  if (dup) return `Recurring bill already exists (${(dup as any).name}) — not duplicated`;

  const created = await storage.createObligation({
    name: String(p.name || action.title),
    amount,
    frequency: p.frequency || "monthly",
    category: canonicalObligationCategory(String(p.category || "general")),
    kind: "bill",
    nextDueDate: String(p.nextDueDate),
    autopay: false,
    autoLogExpense: p.autoLogExpense !== false,
    linkedAssetId: p.linkedAssetId || undefined,
    linkedLiabilityId: p.linkedLiabilityId || undefined,
    linkedDocumentId: documentId,
    linkedProfiles: p.linkedAssetId ? [String(p.linkedAssetId)] : [],
    recurrenceEnd: p.recurrenceEnd ? String(p.recurrenceEnd) : undefined,
  } as any);
  try {
    await storage.updateObligation((created as any).id, {
      fields: { ...((created as any).fields || {}), _extractionAction: action.dedupeKey, _source: { documentId } },
    } as any);
  } catch { /* the marker is an optimisation, not a requirement */ }
  return `Created recurring bill: $${amount.toFixed(2)}/${p.frequency || "mo"} ${(created as any).name}`;
}

/**
 * A one-off charge.
 *
 * Dedupe is on date + amount + the profile it belongs to. Date and amount ALONE
 * — which is what this used to be — collapses two genuinely distinct $12.00
 * charges on the same day into one, and the second one silently never exists.
 */
async function writeExpense(action: ProposedAction, documentId: string): Promise<string> {
  const p = action.payload || {};
  const amount = requireAmount(p.amount);
  const date = String(p.date || today());
  const owner = p.linkedProfileId ? String(p.linkedProfileId) : (action.target?.id ?? undefined);

  const priors = await storage.getExpenses();
  const dup = (priors || []).find((e: any) =>
    String(e?.date) === date &&
    Math.abs(Number(e?.amount) - amount) < 0.005 &&
    String((e?.linkedProfiles || [])[0] || "") === String(owner || ""));
  if (dup) {
    try { await storage.linkProfileTo((dup as any).id, "document", documentId); } catch { /* already linked */ }
    return `Expense $${amount.toFixed(2)} already exists (${(dup as any).description}) — not duplicated`;
  }

  const expense = await storage.createExpense({
    description: String(p.description || action.title),
    amount,
    category: canonicalExpenseCategory(String(p.category || "general")),
    vendor: p.vendor ? String(p.vendor) : undefined,
    date,
    tags: [],
    linkedProfiles: owner ? [owner] : [],
  } as any);
  try { await storage.linkProfileTo((expense as any).id, "document", documentId); } catch { /* best effort */ }
  return `Created expense: $${amount.toFixed(2)} ${(expense as any).description}`;
}

// ─── Relationships ───────────────────────────────────────────────────────────

/** Relationship types that mean "this liability is secured by this asset". */
const LIABILITY_ASSET_TYPES = new Set(["financed_by", "finances", "owes"]);

/**
 * Link two records.
 *
 * The typed liability/asset table is used when the relationship is one, but it
 * is NOT assumed to exist: `server/storage.ts` MemStorage throws on
 * `createLiabilityAssetLink`, so a dev run or a route test would blow up on
 * every mortgage-bearing document. The generic `entity_links` table is the
 * fallback, and it is a real one — the link is queryable either way.
 */
async function writeRelationship(action: ProposedAction): Promise<string> {
  const p = action.payload || {};
  const fromId = String(p.fromId || "");
  const toId = String(p.toId || "");
  const type = String(p.type || "related_to");
  if (!fromId || !toId) throw new Error("a link needs both ends");

  // A link that already exists is not created again. Without this, confirming
  // twice — or a double-tapped Confirm — leaves two identical edges, and every
  // surface that walks them renders the same relationship twice.
  try {
    const existing = await storage.getEntityLinks("profile", fromId);
    if ((existing || []).some((l: any) =>
      l?.targetId === toId && l?.relationship === type)) {
      return `${action.target.name} was already linked`;
    }
  } catch { /* the check is an optimisation; the create below is the contract */ }

  if (LIABILITY_ASSET_TYPES.has(type)) {
    try {
      const liabilityId = type === "financed_by" ? toId : fromId;
      const assetId = type === "financed_by" ? fromId : toId;
      const priorTyped = await storage.getLiabilityAssetLinks(liabilityId);
      if ((priorTyped || []).some((l: any) => l?.assetProfileId === assetId)) {
        return `${action.target.name} was already linked`;
      }
    } catch { /* the typed table may not exist here — fall through */ }
    try {
      // `financed_by` reads asset → liability; the table stores it the other
      // way round, so the ends are swapped rather than stored backwards.
      await storage.createLiabilityAssetLink({
        liabilityProfileId: type === "financed_by" ? toId : fromId,
        assetProfileId: type === "financed_by" ? fromId : toId,
        role: "collateral",
      } as any);
      return `Linked ${action.target.name}`;
    } catch {
      // Fall through to the generic table.
    }
  }

  await storage.createEntityLink({
    sourceType: "profile",
    sourceId: fromId,
    targetType: "profile",
    targetId: toId,
    relationship: type,
    confidence: typeof action.confidence === "number" ? action.confidence : 1,
  });
  return `Linked ${action.target.name}`;
}
