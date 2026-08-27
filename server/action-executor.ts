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
import { findCompatibleTracker } from "@shared/tracker-identity";
import { MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE, type EventCategory, type Tracker } from "@shared/schema";
import { getUserToday, parseUserDateTime } from "@shared/timezone";
import { applyLiabilityPayment } from "./liability-payments";
import { recurrenceToTags } from "@shared/recurrence";

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

  // ── RULE 1, ENFORCED AGAIN AT THE WRITE ──────────────────────────────────
  // The planner already refuses to make these savable, and the UI already
  // refuses to tick them. This is the third gate, and it is here because it is
  // the only one an edited request body cannot get past: a client that sends
  // `savable: true` on an action that would create a liability still writes
  // nothing. Cheap to check, and the thing it prevents is a phantom profile in
  // someone's net worth.
  const refused = actions.filter((a) => a.savable === false
    || (a.operation === "CREATE" && (a.target?.kind === "profile" || a.target?.kind === "obligation")));
  for (const a of refused) {
    out.results.push({
      actionId: a.id, status: "skipped",
      message: `${a.title} — not saved: ${a.unsupportedReason || "document extraction never creates profiles, assets or liabilities"}`,
    });
  }
  const refusedIds = new Set(refused.map((a) => a.id));

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
    if (refusedIds.has(action.id)) continue;
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
          //
          // A BIRTHDAY does both, and that is deliberate (user, 2026-08-27:
          // "it should create a reoccurring event every year for the birthday
          // and it should be in the calendar under reoccurring"). The date goes
          // on the person's record — that is where the app derives their yearly
          // rule from — AND a yearly event is created so it appears under
          // Calendar → Recurring & Important. It does not double up, because
          // seriesFromEvents (shared/calendar-adapters) shadows an event whose
          // kind is "birthday" and whose linkedProfiles[0] already owns a
          // birthday rule. The event below is linked to that profile for
          // exactly that reason.
          const parts: string[] = [];
          let didSomething = false;

          if (action.payload?.fields && action.payload?.profileId) {
            const res = await writeFieldsToProfile(action, input.documentId);
            if (res.wrote > 0 || res.alreadyApplied) {
              touched.add(res.profileId);
              parts.push(`${action.title} — ${action.payload.date} on ${res.profileName}`);
              didSomething = true;
            } else {
              failed(action, `${action.title}: date did not persist to ${res.profileName}`);
              break;
            }
          }

          const wantsEvent = action.payload?.createEvent === true
            || !(action.payload?.fields && action.payload?.profileId);
          if (wantsEvent) {
            const profileId = action.payload?.profileId ? String(action.payload.profileId) : "";
            const recurrence = String(action.payload?.recurrence || "none");
            const ev = await storage.createEvent({
              title: String(action.payload?.title || action.title),
              date: String(action.payload?.date),
              category: eventCategoryFor(action.payload?.ruleType),
              recurrence,
              recurrenceEnd: action.payload?.recurrenceEnd
                ? String(action.payload.recurrenceEnd)
                : undefined,
              linkedProfiles: profileId ? [profileId] : [],
              tags: [
                "document-extraction",
                ...(action.payload?.ruleType ? [`rule:${action.payload.ruleType}`] : []),
                ...(recurrence !== "none" ? ["recurring"] : []),
              ],
              linkedDocuments: [input.documentId],
            } as any);
            parts.push(
              recurrence !== "none"
                ? `Added "${ev.title}" to the calendar, repeating ${recurrence}`
                : `Added "${ev.title}" to the calendar`,
            );
            didSomething = true;
          }

          if (didSomething) ok(action, parts.join("; "));
          else skipped(action, `${action.title} — nothing to write`);
          break;
        }

        case "tracker": {
          const msg = await appendTrackerEntry(action, input.documentId);
          ok(action, msg);
          break;
        }

        case "profile_tracker": {
          // ONE fact, TWO jobs — a balance is the number owed right now AND a
          // point in its history. Both writes happen, or the row lied about
          // what it would do.
          let fieldMsg = "";
          if (action.payload?.fields && action.payload?.profileId) {
            const res = await writeFieldsToProfile(action, input.documentId);
            if (res.wrote > 0 || res.alreadyApplied) {
              touched.add(res.profileId);
              fieldMsg = `Updated ${res.wrote} field${res.wrote === 1 ? "" : "s"} on ${res.profileName}`;
            } else {
              failed(action, `fields did not persist to ${res.profileName}: ${res.unsaved.join(", ")}`);
              if (res.profileId) brokenTargets.add(res.profileId);
              break;
            }
          }
          const msg = await appendTrackerEntry(action, input.documentId);
          ok(action, fieldMsg ? `${fieldMsg}; ${msg}` : msg);
          break;
        }

        case "obligation": {
          const msg = await writeObligation(action, input.documentId);
          ok(action, msg);
          break;
        }

        case "liability_payment": {
          const msg = await writeLiabilityPayment(action, input.documentId);
          if (targetId) touched.add(targetId);
          ok(action, msg);
          break;
        }

        case "task": {
          const msg = await writeTask(action, input.documentId);
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
          const label = String(action.payload?.name || action.title);
          // `description` is what insertIncomeSchema declares (it has no
          // `source` field), so passing only `source` left extracted income
          // with an empty description. Both are sent: the schema takes the one
          // it knows and the other is harmless.
          const frequency = action.payload?.frequency
            ? String(action.payload.frequency)
            : undefined;
          const inc = await storage.createIncome({
            description: label,
            source: label,
            amount,
            date: String(action.payload?.date || today()),
            category: "general",
            ...(frequency ? { frequency } : {}),
            linkedProfiles: targetId ? [targetId] : [],
          } as any);
          ok(
            action,
            frequency && frequency !== "once"
              ? `Recorded recurring income: $${amount.toFixed(2)} ${label} (${frequency})`
              : `Recorded income: $${amount.toFixed(2)} ${(inc as any).description || label}`,
          );
          break;
        }

        case "journal": {
          // A dated history entry with nowhere else to go. JournalEntry needs a
          // MoodLevel and an extracted record has no mood, so it takes the
          // neutral one — the entry is a record of something that happened, not
          // a feeling about it.
          const entry = await storage.createJournalEntry({
            title: String(action.payload?.title || action.title),
            content: String(action.payload?.content || action.detail || ""),
            date: String(action.payload?.date || today()),
            mood: String(action.payload?.mood || "neutral"),
            tags: ["document-extraction"],
            linkedProfiles: targetId ? [targetId] : [],
            linkedDocuments: [input.documentId],
          } as any);
          ok(action, `Saved journal entry: ${(entry as any).title || action.title}`);
          break;
        }

        case "habit": {
          const habit = await storage.createHabit({
            name: String(action.payload?.name || action.title),
            frequency: String(action.payload?.frequency || "daily"),
            ...(action.payload?.targetPerDay
              ? { targetPerDay: Number(action.payload.targetPerDay) }
              : {}),
            ...(action.payload?.startDate ? { startDate: String(action.payload.startDate) } : {}),
            linkedProfiles: targetId ? [targetId] : [],
          } as any);
          ok(action, `Started tracking the habit "${(habit as any).name || action.title}"`);
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
  const unit = String(action.payload?.unit || "");
  let tracker: any = action.payload?.trackerId
    ? (trackers as any[]).find((t) => t.id === action.payload.trackerId)
    : undefined;
  // ONE resolution ladder, shared with the planner (shared/tracker-identity),
  // so what the review promised and what gets written cannot disagree: an
  // owned tracker, then an orphan, never someone else's — and never one whose
  // unit measures a different KIND of thing.
  if (!tracker) {
    tracker = findCompatibleTracker(trackers as any[], name, { unit, ownerProfileId: profileId }) ?? undefined;
  }

  const rawValues = (action.payload?.values && typeof action.payload.values === "object")
    ? action.payload.values : { value: action.payload?.values ?? 0 };

  let created = false;
  if (!tracker) {
    const fieldKeys = Object.keys(rawValues);
    tracker = await storage.createTracker({
      name,
      unit,
      // The value's own category. Hardcoding "health" filed an odometer and a
      // property valuation under health; `custom` is what the planner sends for
      // anything the metric registry does not recognise, and it is visible
      // (unlike "finance", which shared/hidden-tracker-categories rejects).
      category: String(action.payload?.category || "health"),
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
  // The measurement's OWN date, when the document printed one — a lab drawn
  // last Tuesday charts on last Tuesday, not on upload day. Anchored at local
  // noon (parseUserDateTime) so the calendar day never rolls across the
  // timezone offset. No date on the payload → the entry stamps now, as before.
  const when = String(action.payload?.date || "").slice(0, 10);
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(when)
    ? parseUserDateTime(when, (storage as any)._timezone).toISOString()
    : undefined;
  await storage.logEntry({
    trackerId: tracker.id,
    values,
    // Traceable back to its page: the id is the document id.
    notes: `From document extraction (${documentId})`,
    profileId,
    timestamp,
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
 * Update an EXISTING recurring bill. It never creates one.
 *
 * `storage.createObligation` is not called from here and must not be: in this
 * app a recurring bill is a liability profile — supabase-storage's
 * implementation ends in `createProfile({ type: "liability" })` — so "create an
 * obligation" and "create a liability from a document" are the same operation
 * wearing different names, and the second is forbidden.
 *
 * A recurrence with no existing bill behind it never reaches this function: the
 * planner routes it to the liability's own terms, to a repeating task, or to a
 * row that says plainly there is nowhere to put it.
 */
async function writeObligation(action: ProposedAction, documentId: string): Promise<string> {
  const p = action.payload || {};
  const amount = requireAmount(p.amount);
  const existingId = p.existingObligationId ? String(p.existingObligationId) : (action.target?.id ?? undefined);

  if (!existingId) {
    throw new Error("no existing bill to update — a new one would create a liability");
  }

  {
    const patch: Record<string, any> = {
      amount,
      frequency: p.frequency || "monthly",
      linkedDocumentId: documentId,
    };
    // ONE lead time, not a list of intervals: the app escalates every date
    // through a single attention ladder (shared/attention), so this only sets
    // how far out the date starts mattering.
    if (typeof p.leadTimeDays === "number") patch.leadTimeDays = p.leadTimeDays;
    if (p.nextDueDate) patch.nextDueDate = String(p.nextDueDate);
    if (p.recurrenceEnd) patch.recurrenceEnd = String(p.recurrenceEnd);
    const updated = await storage.updateObligation(existingId, patch as any);
    if (!updated) throw new Error(`bill ${existingId} not found`);
    return `Updated recurring bill: $${amount.toFixed(2)} ${(updated as any).name}`;
  }
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

  // A charge the document says repeats is stored as one, so the app stops
  // reading a monthly subscription as a single Tuesday in March.
  const isRecurring = Boolean(p.isRecurring)
    || Boolean(p.frequency && String(p.frequency) !== "once");
  const expense = await storage.createExpense({
    description: String(p.description || action.title),
    amount,
    category: canonicalExpenseCategory(String(p.category || "general")),
    vendor: p.vendor ? String(p.vendor) : undefined,
    date,
    ...(isRecurring ? { isRecurring: true } : {}),
    ...(p.frequency ? { frequency: String(p.frequency) } : {}),
    tags: isRecurring ? ["recurring"] : [],
    linkedProfiles: owner ? [owner] : [],
  } as any);
  try { await storage.linkProfileTo((expense as any).id, "document", documentId); } catch { /* best effort */ }
  return isRecurring
    ? `Created recurring expense: $${amount.toFixed(2)} ${(expense as any).description}`
    : `Created expense: $${amount.toFixed(2)} ${(expense as any).description}`;
}

/**
 * The calendar category a date rule belongs to.
 *
 * `category: "other"` was hardcoded on every extracted event, so a renewal, a
 * birthday and a service reminder all arrived colourless and indistinguishable.
 * The rule type is already computed by `classifyDateField` — this just spends
 * it.
 */
function eventCategoryFor(ruleType: unknown): EventCategory {
  switch (String(ruleType || "")) {
    case "birthday":
    case "anniversary":
      return "family";
    case "payment":
    case "income":
    case "due":
      return "finance";
    case "appointment":
      return "health";
    case "expiration":
    case "renewal":
    case "cancellation":
    case "deadline":
    case "maintenance":
    case "reminder":
      return "personal";
    default:
      return "other";
  }
}

/**
 * Record a payment against an existing liability.
 *
 * Delegates to `applyLiabilityPayment` (server/liability-payments.ts) rather
 * than writing the payment row here, because that function does the part this
 * one must not get wrong: it splits the amount into principal and interest with
 * the canonical amortization math, moves the balance, and advances the due date
 * — all in one place. A payment written without that is the exact shape of "the
 * payment saved but the balance didn't change".
 *
 * The user asked for the payment and the balance to be separately toggleable.
 * They are: the planner emits the balance as its own `entity_field` action from
 * the figure the statement PRINTS, which is not always the figure implied by
 * the payment — a statement's balance often predates the payment on it.
 */
async function writeLiabilityPayment(action: ProposedAction, documentId: string): Promise<string> {
  const p = action.payload || {};
  const liabilityId = String(p.liabilityId || action.target?.id || "");
  if (!liabilityId) throw new Error("no liability to record this against");
  const liability = await storage.getProfile(liabilityId);
  if (!liability) throw new Error(`liability ${liabilityId} not found`);

  const amount = requireAmount(p.amount);

  // Idempotency: the same payment from the same document is recorded once.
  try {
    const priors = await storage.getLiabilityPayments(liabilityId);
    const dup = (priors || []).find((x: any) =>
      x?.documentId === documentId &&
      Math.abs(Number(x?.amount) - amount) < 0.005 &&
      String(x?.paymentDate || "") === String(p.date || x?.paymentDate || ""));
    if (dup) return `Payment of $${amount.toFixed(2)} from this document is already recorded`;
  } catch { /* the check is an optimisation; a missing reader must not block the write */ }

  const result = await applyLiabilityPayment(storage, liability, {
    amount,
    paymentDate: p.date ? String(p.date) : null,
    principal: typeof p.principal === "number" ? p.principal : null,
    interest: typeof p.interest === "number" ? p.interest : null,
    escrow: typeof p.escrow === "number" ? p.escrow : null,
    fees: typeof p.fees === "number" ? p.fees : null,
    // "partial" is a real, named payment type — a statement showing less than
    // the scheduled amount is not a malformed standard payment.
    paymentType: p.paymentType ? String(p.paymentType) as any : null,
    notes: `From document extraction`,
  });

  try {
    await storage.updateLiabilityPayment?.((result.payment as any)?.id, { documentId } as any);
  } catch { /* provenance is best-effort; the payment itself is the contract */ }

  return result.recurring
    ? `Recorded $${amount.toFixed(2)} paid on ${(liability as any).name}`
    : `Recorded $${amount.toFixed(2)} on ${(liability as any).name} — balance now $${Number(result.newBalance).toFixed(2)}`;
}

/**
 * A thing to do, one-off or repeating.
 *
 * Repetition lives in `tags` (shared/recurrence: `recur:`/`runtil:`), which is
 * how every other repeating task in the app is expressed — so an extracted
 * "renew the registration every year" is indistinguishable from one typed by
 * hand, and every surface that already understands repeating tasks understands
 * this one too.
 */
async function writeTask(action: ProposedAction, documentId: string): Promise<string> {
  const p = action.payload || {};
  const title = String(p.title || action.title).trim();
  if (!title) throw new Error("a task needs a title");
  const dueDate = p.dueDate ? String(p.dueDate) : undefined;

  // Idempotency: one document does not produce the same to-do twice.
  const priors = await storage.getTasks();
  const dup = (priors || []).find((t: any) =>
    String(t?.title || "").trim().toLowerCase() === title.toLowerCase() &&
    String(t?.dueDate || "") === String(dueDate || ""));
  if (dup) return `Task "${title}" already exists`;

  let tags: string[] = [`document:${documentId}`];
  if (p.recurrence) {
    tags = recurrenceToTags(
      { freq: String(p.recurrence), until: p.recurrenceEnd ? String(p.recurrenceEnd) : undefined } as any,
      tags,
    );
  }

  const task = await storage.createTask({
    title,
    description: p.description ? String(p.description) : undefined,
    status: "todo",
    priority: "medium",
    dueDate,
    linkedProfiles: p.linkedProfileId ? [String(p.linkedProfileId)] : [],
    tags,
  } as any);
  return p.recurrence
    ? `Created repeating task: ${(task as any).title}`
    : `Created task: ${(task as any).title}${dueDate ? ` (due ${dueDate})` : ""}`;
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
