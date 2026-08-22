// ─── Canonical calendar-event creation/update ───────────────────────────────
//
// THE single pipeline for writing a calendar event, whatever door asked.
// Modeled on habit-completion.ts / expense-service.ts.
//
// Doors: chat tool create_event/update_event · REST POST/PATCH /api/events ·
// extraction confirm (Phase 4). The chat door keeps its interpretation layer
// ("my license expires July 18" is a fact about the license, not an event —
// those redirects live in the engine until the profile-fact service lands);
// once a request really IS an event, everything below is shared:
//
//   · title/date validation
//   · duplicate guard — same title on the same date is the same event, for
//     every door (structural idempotency; a replayed confirm or a chatty
//     model can't mint twins)
//   · category canon — alias mapping ("medical" → "health") and unknown
//     labels bucketed to "other" instead of failing the write
//   · weekday-set recurrence canonicalization ("weekly:1,3,5") including
//     pulling the start date onto the first day actually in the set
//   · profile attribution — explicit ids, else forProfile through THE
//     resolver (server/entity-resolver.ts resolveProfileByName)
//   · shared insert schema, junction-table linking
import type { IStorage } from "../storage";
import { insertEventSchema } from "@shared/schema";
import { weekdaySetFor, weekdaySetToRecurrence } from "@shared/date-math";
import { resolveProfileByName } from "../entity-resolver";

export const EVENT_CATEGORIES = ["personal", "work", "health", "finance", "family", "social", "travel", "education", "other"] as const;

/** Fold a caller-supplied category onto the schema vocabulary. */
export function canonicalEventCategory(raw: unknown): string {
  const value = raw === "medical" ? "health" : String(raw || "personal");
  return (EVENT_CATEGORIES as readonly string[]).includes(value) ? value : "other";
}

export interface CreateEventArgs {
  title?: string;
  date?: string;
  time?: string;
  endTime?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  recurrence?: string;
  recurrenceEnd?: string;
  category?: string;
  tags?: string[];
  /** Source documents (extraction door). */
  linkedDocuments?: string[];
  /** Explicit profile ids to link. */
  linkedProfiles?: string[];
  /** A profile NAME to resolve when no explicit ids were given. */
  forProfile?: string;
  /** Recorded on the row ("chat", "manual", "extraction"). */
  source?: string;
}

export type CreateEventResult = Record<string, any> & { error?: string; deduped?: boolean };

export async function createEventRecord(
  storage: IStorage,
  args: CreateEventArgs,
): Promise<CreateEventResult> {
  const title = String(args.title || "").trim();
  if (!title) return { error: "Event title is required" };
  if (!args.date || typeof args.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(args.date)) {
    return { error: "Valid event date (YYYY-MM-DD) is required" };
  }

  // Weekday-set recurrence ("weekly:1,3,5"): canonicalize the token, and pull
  // the START DATE onto the first day actually in the set — expansion always
  // emits the base date, so a Mon/Wed/Fri series started on a Sunday would
  // show one stray Sunday occurrence forever.
  let recurrence = String(args.recurrence || "none").trim().toLowerCase();
  let date = args.date;
  const daySet = weekdaySetFor(recurrence);
  if (daySet) {
    recurrence = weekdaySetToRecurrence(Array.from(daySet));
    const startD = new Date(`${String(date).slice(0, 10)}T00:00:00`);
    if (!isNaN(startD.getTime())) {
      let guard = 7;
      while (!daySet.has(startD.getDay()) && guard-- > 0) startD.setDate(startD.getDate() + 1);
      date = startD.toLocaleDateString("en-CA");
    }
  }

  // Duplicate guard: same title on the same date IS the same event.
  const allEvents = await storage.getEvents();
  const dup = allEvents.find((e) => e.title.toLowerCase() === title.toLowerCase() && e.date === date);
  if (dup) {
    return { ...dup, deduped: true, message: `"${dup.title}" already exists on ${dup.date} — I didn't create it twice.` };
  }

  // Profile attribution.
  let linkedProfiles: string[] = Array.isArray(args.linkedProfiles) ? args.linkedProfiles.filter(Boolean) : [];
  if (linkedProfiles.length === 0 && args.forProfile) {
    const resolved = resolveProfileByName(await storage.getProfiles(), args.forProfile);
    if (resolved.kind === "found") linkedProfiles = [(resolved.profile as any).id];
    // "ambiguous"/"none" deliberately attribute nothing — never guess an owner.
  }

  const parsed = insertEventSchema.safeParse({
    title,
    date,
    time: args.time,
    endTime: args.endTime,
    allDay: args.allDay || false,
    location: args.location,
    description: args.description,
    recurrence,
    ...(args.recurrenceEnd ? { recurrenceEnd: String(args.recurrenceEnd).slice(0, 10) } : {}),
    category: canonicalEventCategory(args.category),
    source: args.source || "manual",
    linkedProfiles,
    linkedDocuments: args.linkedDocuments || [],
    tags: args.tags || [],
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || "Event validation failed" };
  }

  const event = await storage.createEvent(parsed.data);
  for (const pid of linkedProfiles) {
    await storage.linkProfileTo(pid, "event", event.id).catch(() => { /* junction is best-effort */ });
  }
  return event;
}
