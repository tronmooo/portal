// server/content-service.ts — THE CANONICAL MUTATION SERVICE for the three
// generic content types, plus the temporal synchronisation step that follows
// every write.
//
// One rule governs this file: AI CHAT AND MANUAL CREATION USE THE SAME CODE.
// The chat tools in server/ai-engine call these functions after resolving a
// profile NAME to a profile id; the REST routes in server/routes call them with
// the id the client already has. There is no second implementation for either
// door, so a fix to dedup, linking, or date-rule sync lands on both at once.
//
// STORAGE MODEL — no migration.
//
//   Note          → an `artifact` row of type "note". Artifacts are already a
//                   first-class, profile-linked, searchable, soft-shareable
//                   content record with full CRUD in both storage backends and
//                   a page of their own. Adding a `notes` table would have been
//                   a fourth place for text to live.
//   Journal Entry → the existing `journal_entries` row, now honouring
//                   `entryDate` (the day the experience happened) instead of
//                   always stamping today.
//   Task          → the existing `tasks` row, untouched.
//
// The temporal layer is shared/temporal-rules: Date Rules are DERIVED from the
// canonical record through the same adapters the Calendar reads, so "sync" here
// means re-derive and report, never write a second copy of the truth.

import type { IStorage } from "./storage";
import { detectMoodFromText } from "@shared/mood-detect";
import { fallbackTitle } from "@shared/capture-target";
import { deriveDateRulesForRecord, ownsDateRules, type DateRule, type RuleSourceSystem } from "@shared/temporal-rules";
import { findActionableTime } from "@shared/temporal-rules";

// ─── Notes ───────────────────────────────────────────────────────────────────

export interface NoteInput {
  content: string;
  title?: string;
  /** Resolved profile id — never a name. Name resolution belongs to the caller. */
  profileId?: string | null;
  tags?: string[];
  source?: "chat" | "manual" | "ai";
}

export interface NoteResult {
  note: any;
  /** True when an identical note already existed and was returned untouched. */
  deduped: boolean;
  /** Set when the note's text also carries a date a calendar object would want. */
  actionableTime?: { dateText: string | null; cue: string | null };
}

const NOTE_TYPE = "note";

/** Title from the first sentence/clause of the body, capped for the card UI. */
export function deriveNoteTitle(content: string): string {
  const flat = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "Note";
  const firstClause = flat.split(/(?<=[.!?])\s|[—;:]\s/)[0] || flat;
  const title = firstClause.length > 60 ? `${firstClause.slice(0, 57).trimEnd()}…` : firstClause;
  return title || "Note";
}

const normalizeText = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export async function listNotes(
  storage: IStorage,
  opts: { profileId?: string | null; query?: string; limit?: number } = {},
): Promise<any[]> {
  const all = await storage.getArtifacts();
  const q = normalizeText(opts.query);
  const out = (all || []).filter((a: any) => {
    if (a?.type !== NOTE_TYPE) return false;
    // PROFILE ISOLATION. A note belonging to Robert must never surface under
    // Sarah. An UNLINKED note is the user's own and is only returned when no
    // profile filter was asked for.
    if (opts.profileId) {
      if (!Array.isArray(a.linkedProfiles) || !a.linkedProfiles.includes(opts.profileId)) return false;
    }
    if (!q) return true;
    return normalizeText(`${a.title} ${a.content}`).includes(q);
  });
  out.sort((a: any, b: any) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return typeof opts.limit === "number" ? out.slice(0, Math.max(1, opts.limit)) : out;
}

/**
 * Create a Note.
 *
 * IDEMPOTENT: a note with the same normalized body for the same profile is
 * returned rather than duplicated, so a retried chat turn cannot produce three
 * copies of one thought.
 */
export async function createNote(storage: IStorage, input: NoteInput): Promise<NoteResult> {
  const content = String(input.content ?? "").trim();
  if (!content) throw new Error("Note content is required");
  const profileId = input.profileId || null;

  const existing = await listNotes(storage, { profileId });
  const incoming = normalizeText(content);
  const dup = existing.find((n: any) => normalizeText(n.content) === incoming);
  if (dup) {
    return { note: dup, deduped: true, ...actionableHint(content) };
  }

  const note = await storage.createArtifact({
    type: NOTE_TYPE,
    title: (input.title || "").trim() || deriveNoteTitle(content),
    content,
    items: [],
    tags: input.tags || [],
    pinned: false,
    linkedProfiles: profileId ? [profileId] : [],
    source: input.source || "chat",
  } as any);

  if (profileId) {
    // The junction row is what makes the note appear on the profile page.
    await storage.linkProfileTo(profileId, "artifact", note.id).catch(() => { /* non-fatal */ });
  }
  return { note, deduped: false, ...actionableHint(content) };
}

function actionableHint(content: string): { actionableTime?: { dateText: string | null; cue: string | null } } {
  const hit = findActionableTime(content);
  if (!hit.actionable) return {};
  return { actionableTime: { dateText: hit.dateText, cue: hit.cue } };
}

export async function updateNote(
  storage: IStorage,
  id: string,
  changes: { title?: string; content?: string; append?: string; tags?: string[] },
): Promise<any | undefined> {
  const current = await storage.getArtifact(id);
  if (!current || current.type !== NOTE_TYPE) return undefined;
  const patch: Record<string, any> = {};
  if (changes.title !== undefined) patch.title = String(changes.title).trim();
  if (changes.content !== undefined) patch.content = String(changes.content);
  if (changes.append) {
    const base = changes.content !== undefined ? String(changes.content) : String(current.content || "");
    patch.content = base ? `${base}\n${String(changes.append).trim()}` : String(changes.append).trim();
  }
  if (changes.tags !== undefined) patch.tags = changes.tags;
  if (Object.keys(patch).length === 0) return current;
  return storage.updateArtifact(id, patch);
}

/** Deleting a Note has NO temporal consequence — notes never owned a rule. */
export async function deleteNote(storage: IStorage, id: string): Promise<boolean> {
  const current = await storage.getArtifact(id);
  if (!current || current.type !== NOTE_TYPE) return false;
  return storage.deleteArtifact(id);
}

// ─── Journal entries ─────────────────────────────────────────────────────────

export interface JournalInput {
  content: string;
  mood?: string;
  /** The day the EXPERIENCE happened, YYYY-MM-DD. Not a calendar commitment. */
  entryDate: string;
  /** Whose journal this is. Null = the writer's own. */
  profileId?: string | null;
  /** The writer's own profile, so an own entry can be told from Bob's. */
  selfProfileId?: string | null;
  energy?: number;
  gratitude?: string[];
  highlights?: string[];
  /** Tags for a new entry; joined onto the tags an existing entry has. */
  tags?: string[];
  /** Headline for a new entry. Left to the caller (AI-written); the first
   *  clause of the text when absent. */
  title?: string;
  /**
   * "new" (default): every write is its own entry — a day can hold several,
   * and several people's. "append": join the text onto that person's latest
   * entry for the day ("add this to today's journal"); creates one if there
   * is none.
   */
  mode?: "new" | "append";
  /** False for a composer DRAFT: its first autosave is a fragment, and must
   *  always get a row of its own. Default true. */
  dedupe?: boolean;
  /**
   * The writer PICKED this mood (the journal page's mood buttons). A picked
   * mood is kept as given. Any other mood is a guess — chat's model sent
   * "neutral" for "frustrated and overwhelmed" — and a neutral guess gives way
   * to what the text itself says (shared/mood-detect).
   */
  moodPicked?: boolean;
}

const MOODS = ["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"];

/**
 * Write a journal entry for a specific DATE and PERSON.
 *
 * A day can hold several entries, and entries written on behalf of other
 * profiles ("Bob's journal"): each write is a new entry unless the caller asks
 * to append (owner decision 2026-11-20; the one-entry-per-day rule and its
 * unique index are gone — migrations/20261120_journal_many_per_day_and_title).
 *
 * IDEMPOTENT: the same text for the same person on the same day is returned,
 * not written twice, so a retried chat turn or a double tap makes one entry.
 *
 * The entry date never produces a Date Rule. See NON_TEMPORAL_ENTITIES in
 * shared/temporal-rules for why.
 */
export async function upsertJournalEntry(
  storage: IStorage,
  input: JournalInput,
): Promise<{ entry: any; appended: boolean }> {
  const content = String(input.content ?? "").trim();
  const date = String(input.entryDate).slice(0, 10);
  const given = MOODS.includes(String(input.mood)) ? String(input.mood) : null;
  const detected = detectMoodFromText(content);
  // What this piece of writing says about the day: the picked mood, else a
  // non-neutral guess, else the text's own, else nothing.
  const said: string | null = input.moodPicked && given
    ? given
    : given && given !== "neutral" ? given
    : detected !== "neutral" ? detected
    : null;
  const mood = said ?? given ?? "neutral";

  // "This person's entries": Bob's are the rows linked to Bob. The writer's
  // own are the rows linked to their self profile, plus rows linked to no one
  // (an entry with no owner is the account holder's).
  const ownerId = input.profileId || null;
  const isTheirs = (row: any): boolean => {
    const linked: string[] = row.linkedProfiles || [];
    if (ownerId && ownerId !== input.selfProfileId) return linked.includes(ownerId);
    return linked.length === 0 || (!!input.selfProfileId && linked.includes(input.selfProfileId)) || (!input.selfProfileId && !ownerId);
  };
  const all = ((await storage.getJournalEntries()) || []) as any[];
  const sameDay = all
    .filter((j) => String(j.date).slice(0, 10) === date && isTheirs(j))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  // IDEMPOTENCY: a retried turn must not write the same entry twice. A NEW
  // entry is a duplicate only when its whole text equals an entry's — never
  // "contained in": a draft that begins "I" is not every entry with an "i"
  // in it, and treating it as one would hand the composer someone else's row
  // to overwrite.
  const wanted = normalizeText(content);
  if (content && input.mode !== "append" && input.dedupe !== false) {
    const dup = sameDay.find((j) => normalizeText(j.content) === wanted);
    if (dup) return { entry: { ...dup, unchanged: true }, appended: false };
  }

  if (input.mode === "append" && sameDay[0]) {
    const row = sameDay[0];
    // The paragraph is already in the entry (a retried "add this to today's").
    if (content && normalizeText(row.content).includes(wanted)) {
      return { entry: { ...row, unchanged: true }, appended: false };
    }
    const merged = row.content ? `${row.content}\n\n${content}` : content;
    const linked = Array.from(new Set([...(row.linkedProfiles || []), ...(ownerId ? [ownerId] : [])]));
    const updated = await storage.updateJournalEntry(row.id, {
      content: merged,
      // The entry's mood follows the latest writing that says something about
      // it; a paragraph with no feeling in it leaves the mood alone.
      mood: (said ?? row.mood) as any,
      energy: input.energy ?? row.energy,
      gratitude: input.gratitude || row.gratitude,
      highlights: input.highlights || row.highlights,
      ...(input.tags?.length ? { tags: Array.from(new Set([...(row.tags || []), ...input.tags])) } : {}),
      linkedProfiles: linked,
    } as any);
    if (ownerId) await storage.linkProfileTo(ownerId, "journal", row.id).catch(() => { /* non-fatal */ });
    return { entry: updated || row, appended: true };
  }

  const created: any = await storage.createJournalEntry({
    date,
    mood: mood as any,
    title: (input.title || "").trim().slice(0, 120) || fallbackTitle(content, "Journal entry"),
    content,
    tags: input.tags || [],
    energy: input.energy,
    gratitude: input.gratitude,
    highlights: input.highlights,
  } as any);
  if (ownerId) {
    // Return the row AS LINKED, not the pre-link row: the create answered
    // with Self as owner while the store held Linda, so the journal page's
    // optimistic cache (and the write manifest) filed the entry under the
    // wrong person until a refetch — under Linda's scope it vanished.
    const linkedRow = await storage.updateJournalEntry(created.id, { linkedProfiles: [ownerId] } as any);
    await storage.linkProfileTo(ownerId, "journal", created.id).catch(() => { /* non-fatal */ });
    return { entry: linkedRow || { ...created, linkedProfiles: [ownerId] }, appended: false };
  }
  return { entry: created, appended: false };
}

// ─── Temporal synchronisation ────────────────────────────────────────────────

export interface DateRuleSyncResult {
  system: string;
  id: string;
  /** Every Date Rule the record owns right now, freshly derived. */
  rules: DateRule[];
  /** Why there are none, when there are none. */
  reason?: string;
}

/**
 * Re-derive the Date Rules a canonical record owns and report them.
 *
 * This is the step every dated write ends with. It does not INSERT a rule —
 * there is no rule table (see shared/temporal-rules) — it proves the record now
 * projects onto the calendar, and gives the caller the exact rule identities so
 * a reply can name them and a UI can show them.
 *
 * An empty result is a legitimate outcome, not an error: a task with no due
 * date, a note, and a journal entry all correctly own nothing.
 */
export async function syncDateRulesForEntity(
  storage: IStorage,
  userId: string,
  system: string,
  id: string,
): Promise<DateRuleSyncResult> {
  const kind = String(system || "").toLowerCase();
  if (!ownsDateRules(kind)) {
    return {
      system: kind, id, rules: [],
      reason: `${kind} records never own a Date Rule — their dates describe the past, not a commitment`,
    };
  }

  const record = await loadRecord(storage, kind, id);
  if (!record) return { system: kind, id, rules: [], reason: "record not found" };

  const rules = deriveDateRulesForRecord(userId, kind as RuleSourceSystem, record);
  return {
    system: kind, id, rules,
    reason: rules.length === 0 ? "record carries no actionable date" : undefined,
  };
}

async function loadRecord(storage: IStorage, system: string, id: string): Promise<any | null> {
  try {
    switch (system) {
      case "task": return (await storage.getTask(id)) || null;
      case "event": return ((await storage.getEvents()) || []).find((e: any) => e.id === id) || null;
      case "profile": return (await storage.getProfile(id)) || null;
      case "document": return ((await storage.getDocuments()) || []).find((d: any) => d.id === id) || null;
      case "obligation": return ((await storage.getObligations()) || []).find((o: any) => o.id === id) || null;
      default: return null;
    }
  } catch {
    return null;
  }
}
