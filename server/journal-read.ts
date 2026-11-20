// Reading the journal and notes back, for chat.
//
// The chat could write a journal entry and a note but not read either: "Show
// me my journal entry from today" opened a piano warranty, "What was my mood
// earlier today?" said the journal was not visible, and "Find my note about
// buying new tires" opened a tire-warranty PDF (Journal tutorial QA,
// 2026-11-20). These answers are built from the stored rows, never from the
// model's memory of the conversation.
//
// Pinned by tests/chat-journal-read.test.ts.
import type { IStorage } from "./storage";
import { listNotes } from "./content-service";
import { rankNotesByTopic, type JournalReadIntent, type NoteFindIntent } from "@shared/journal-intent";

const MOOD_LABEL: Record<string, string> = {
  amazing: "Amazing", great: "Great", good: "Good", okay: "Okay", neutral: "Neutral",
  bad: "Bad", awful: "Awful", terrible: "Terrible",
};
export const moodLabel = (m: unknown): string => MOOD_LABEL[String(m || "")] || "Neutral";

const dayInZone = (d: Date, tz: string): string => d.toLocaleDateString("en-CA", { timeZone: tz });

/** "today" / "yesterday" / YYYY-MM-DD → a calendar day in the user's zone. */
export function resolveJournalDay(day: JournalReadIntent["day"], tz: string, now: Date = new Date()): string | null {
  if (!day) return null;
  const today = dayInZone(now, tz);
  if (day === "today") return today;
  if (day === "yesterday") {
    const [y, m, d] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** "Friday, November 20" for a bare YYYY-MM-DD (never shifted by a zone). */
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export interface JournalReadRow { id: string; date: string; mood: string; content: string }

/** The entries a read is about: that day's, or the most recent when no day was named. */
export async function journalEntriesFor(
  storage: IStorage,
  opts: { day?: string | null; from?: string | null; to?: string | null; query?: string | null; limit?: number },
): Promise<JournalReadRow[]> {
  const all = ((await storage.getJournalEntries()) || []) as any[];
  let rows = all
    .map((e) => ({ id: String(e.id), date: String(e.date || "").slice(0, 10), mood: String(e.mood || "neutral"), content: String(e.content || "") }))
    .filter((e) => e.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (opts.day) rows = rows.filter((e) => e.date === opts.day);
  if (opts.from) rows = rows.filter((e) => e.date >= opts.from!);
  if (opts.to) rows = rows.filter((e) => e.date <= opts.to!);
  const q = String(opts.query || "").trim().toLowerCase();
  if (q) rows = rows.filter((e) => e.content.toLowerCase().includes(q));
  return rows.slice(0, Math.max(1, opts.limit ?? 10));
}

/** Mood tracker readings logged on `day` ("my mood is 7/10" lands there, not in the journal). */
async function moodTrackerReadings(storage: IStorage, day: string, tz: string): Promise<string[]> {
  try {
    const trackers = ((await storage.getTrackers()) || []) as any[];
    const out: string[] = [];
    for (const t of trackers) {
      if (!/\bmood\b/i.test(String(t?.name || ""))) continue;
      for (const e of (t.entries || []) as any[]) {
        const ts = new Date(e?.timestamp);
        if (isNaN(ts.getTime()) || dayInZone(ts, tz) !== day) continue;
        const vals = Object.entries(e.values || {})
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (/^(?:value|rating|score|mood)$/i.test(k) ? String(v) : `${k} ${v}`));
        const at = ts.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
        if (vals.length > 0) out.push(`${vals.join(", ")} at ${at}`);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The reply to "show me my journal entry from today" / "what was my mood
 * earlier today". Null for a summary: that needs the model, which is handed
 * the same rows (journalContextBlock).
 */
export async function answerJournalRead(
  storage: IStorage, intent: JournalReadIntent, tz: string, now: Date = new Date(),
): Promise<string | null> {
  if (intent.kind === "summarize") return null;
  const day = resolveJournalDay(intent.day, tz, now);
  const today = dayInZone(now, tz);
  const rows = await journalEntriesFor(storage, { day, limit: 1 });
  const entry = rows[0];
  const dayPhrase = (d: string) => (d === today ? "today" : `on ${longDay(d)}`);

  if (intent.kind === "mood") {
    const moodDay = day || entry?.date || today;
    const readings = await moodTrackerReadings(storage, moodDay, tz);
    const parts: string[] = [];
    if (entry) parts.push(`Your journal entry ${dayPhrase(entry.date)} is marked **${moodLabel(entry.mood)}**.`);
    if (readings.length > 0) parts.push(`Mood tracker ${dayPhrase(moodDay)}: ${readings.join("; ")}.`);
    if (parts.length === 0) {
      return `You haven't recorded a mood ${dayPhrase(moodDay)} — there's no journal entry or Mood tracker reading for that day.`;
    }
    if (entry?.content) parts.push(`You wrote: "${excerpt(entry.content, 280)}"`);
    return parts.join("\n\n");
  }

  if (!entry) {
    return day
      ? `You don't have a journal entry ${dayPhrase(day)}. Say "journal this: …" to write one.`
      : `You don't have any journal entries yet. Say "journal this: …" to write one.`;
  }
  const head = `Your journal entry ${entry.date === today ? "from today" : `from ${longDay(entry.date)}`} · Mood: **${moodLabel(entry.mood)}**`;
  return `${head}\n\n${entry.content || "(no text — mood only)"}\n\n[Open Journal](/journal)`;
}

function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The journal text a summary (or any other question about the journal) is
 * answered from, handed to the model beside the user's message. Empty when the
 * day has no entry, with a line saying so, so silence is never read as text.
 */
export async function journalContextBlock(
  storage: IStorage, intent: JournalReadIntent, tz: string, now: Date = new Date(),
): Promise<string> {
  const day = resolveJournalDay(intent.day, tz, now);
  const rows = await journalEntriesFor(storage, { day, limit: day ? 1 : 3 });
  if (rows.length === 0) {
    return `[JOURNAL] The user is asking about their journal${day ? ` for ${day}` : ""}. There is NO journal entry${day ? " for that day" : ""}. Say so plainly; do not open a document and do not write anything.`;
  }
  const body = rows.map((e) => `— ${e.date} · mood ${moodLabel(e.mood)}:\n${e.content}`).join("\n\n");
  return `[JOURNAL] The user is asking about their journal. This is the stored text — answer from it (do not open a document, do not write anything):\n${body}`;
}

/** The reply to "find my note about buying new tires". */
export async function answerNoteFind(storage: IStorage, intent: NoteFindIntent): Promise<string> {
  const all = await listNotes(storage, {});
  const found = rankNotesByTopic(all as any[], intent.query).slice(0, 5);
  if (all.length === 0) return `You don't have any notes yet. Say "save a quick note: …" to make one.`;
  if (found.length === 0) {
    return `I couldn't find a note about "${intent.query}". You have ${all.length} note${all.length === 1 ? "" : "s"}: ${all.slice(0, 5).map((n: any) => `"${n.title}"`).join(", ")}${all.length > 5 ? ", …" : ""}.\n\n[Open Notes](/artifacts)`;
  }
  const show = (n: any) => `**${n.title}**\n${excerpt(String(n.content || ""), 400)}`;
  const head = intent.query
    ? (found.length === 1 ? `Here's your note about ${intent.query}:` : `I found ${found.length} notes about ${intent.query}:`)
    : `Your ${found.length === all.length ? "" : "most recent "}notes:`;
  return `${head}\n\n${found.map(show).join("\n\n")}\n\n[Open Notes](/artifacts)`;
}
