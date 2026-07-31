// ── Chat suggestions ─────────────────────────────────────────────────────────
// What to suggest typing, derived from what the user actually has.
//
// The chat page shipped with eight hardcoded strings — "I ate a chicken
// sandwich and ran 2 miles", "Add my cat Luna". Demo copy. They don't know who
// you are, what you track, or what's due, and they were identical on every
// visit for every user.
//
// This computes them instead, from records the app has already loaded. Two
// consequences worth stating, because they're the whole design:
//
//   1. NO NETWORK, NO MODEL. /api/dashboard-bootstrap already seeds trackers,
//      habits, obligations, expenses, documents and profiles into the query
//      cache, so this runs on data in memory and the chips paint with the page.
//      An LLM call would cost a second of latency and money per visit to guess
//      at facts we can simply read.
//
//   2. EVERY SUGGESTION IS TRUE. Each one is generated from a specific record
//      and carries the observation that produced it — "last logged 6 days ago",
//      "due Friday". "Log weight" is a guess; "Log weight · last logged 6 days
//      ago" is something the app noticed.
//
// Pure and I/O-free so it's unit-testable and can run on either side.
// Pinned by tests/chat-suggestions.test.ts.

import { isHabitOutstandingOn, type HabitScheduleShape } from "./habit-schedule";
import { dayLabel } from "./now-rank";
import type { ConceptIcon } from "./icon-vocabulary";

export type SuggestionKind =
  | "due"       // something has a deadline
  | "gap"       // something usually logged has gone quiet
  | "routine"   // the time of day says so
  | "scope"     // about whoever the chat is pointed at
  | "followup"  // reacting to what just happened
  | "explore";  // no signal — teach the surface

export interface ChatSuggestion {
  id: string;
  /** The exact message sent to chat when pressed. Must be phrased so the
   *  existing parser can action it — a chip that produces an unparseable
   *  message is worse than no chip. */
  text: string;
  /** Short label for the chip. Often the same as `text`. */
  label: string;
  /** Why this is being suggested. Rendered under the label. */
  reason?: string;
  icon: ConceptIcon;
  kind: SuggestionKind;
  /** Higher wins. Ties break on insertion order. */
  score: number;
}

// ── Input shapes ─────────────────────────────────────────────────────────────
// Deliberately structural rather than importing the full row types: this file
// is consumed by tests and by both runtimes, and only needs these fields.

export interface SuggestTracker {
  id: string;
  name: string;
  unit?: string | null;
  entries?: Array<{ timestamp: string }>;
}
export interface SuggestHabit extends HabitScheduleShape { id: string; name: string; }
export interface SuggestObligation {
  id: string; name: string; amount?: number | null; nextDueDate?: string | null;
}
export interface SuggestDocument {
  id: string; name: string; type?: string | null; expiryDate?: string | null;
}
export interface SuggestExpense { category?: string | null; date?: string | null; amount?: number | null; }
export interface SuggestProfile { id: string; name: string; type?: string | null; }

export interface SuggestionInput {
  now: Date;
  /** Profiles the chat is currently scoped to. Empty = Everyone. */
  scopeProfiles?: SuggestProfile[];
  trackers?: SuggestTracker[];
  habits?: SuggestHabit[];
  obligations?: SuggestObligation[];
  documents?: SuggestDocument[];
  expenses?: SuggestExpense[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(from: Date, toISO: string | null | undefined): number | null {
  if (!toISO) return null;
  const t = new Date(String(toISO).length === 10 ? `${toISO}T00:00:00` : String(toISO));
  if (isNaN(t.getTime())) return null;
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * The typical gap between this tracker's entries, in days.
 *
 * Median rather than mean: one three-week holiday shouldn't convince us that a
 * daily weigh-in is a fortnightly habit.
 */
export function medianCadenceDays(entries: Array<{ timestamp: string }> = []): number | null {
  const times = entries
    .map((e) => new Date(e.timestamp).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 86400000);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return median > 0 ? median : null;
}

function daysSinceLastEntry(now: Date, entries: Array<{ timestamp: string }> = []): number | null {
  const times = entries.map((e) => new Date(e.timestamp).getTime()).filter(Number.isFinite);
  if (times.length === 0) return null;
  return Math.floor((now.getTime() - Math.max(...times)) / 86400000);
}

function agoLabel(days: number): string {
  if (days <= 0) return "logged today";
  if (days === 1) return "last logged yesterday";
  return `last logged ${days} days ago`;
}

/** morning · afternoon · evening — drives which routine we surface. */
export function partOfDay(now: Date): "morning" | "afternoon" | "evening" {
  const h = now.getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Matches a tracker by name against a set of words, case-insensitively. */
const nameMatches = (name: string, re: RegExp) => re.test(String(name || ""));

const SLEEP_RE = /\bsleep\b/i;
const WEIGHT_RE = /\bweight\b/i;
const STEPS_RE = /\b(steps?|walk(ing)?)\b/i;
const WATER_RE = /\b(hydration|water)\b/i;
const MOOD_RE = /\bmood\b/i;

// ── The engine ───────────────────────────────────────────────────────────────

export function buildChatSuggestions(input: SuggestionInput, max = 6): ChatSuggestion[] {
  const {
    now, scopeProfiles = [], trackers = [], habits = [],
    obligations = [], documents = [], expenses = [],
  } = input;
  const today = localDateStr(now);
  const out: ChatSuggestion[] = [];
  const push = (s: ChatSuggestion) => { out.push(s); };

  // ── 1. A habit scheduled today that hasn't been done ──────────────────────
  // The highest-signal thing there is: it's actionable, it's today, and one tap
  // closes it.
  for (const h of habits) {
    if (!h?.name) continue;
    if (!isHabitOutstandingOn(h, today)) continue;
    push({
      id: `habit:${h.id}`,
      text: `Mark ${h.name} done`,
      label: `Mark ${h.name} done`,
      reason: "still due today",
      icon: "habits",
      kind: "due",
      score: 100,
    });
  }

  // ── 2. A bill due within three days ───────────────────────────────────────
  for (const o of obligations) {
    if (!o?.name) continue;
    const d = daysBetween(now, o.nextDueDate);
    if (d == null || d > 3) continue;
    const amount = typeof o.amount === "number" && o.amount > 0
      ? ` $${Math.round(o.amount).toLocaleString("en-US")}` : "";
    push({
      id: `bill:${o.id}`,
      text: `Pay ${o.name}${amount}`,
      label: `Pay ${o.name}`,
      reason: dayLabel(d),
      icon: "finance",
      // Overdue outranks an outstanding habit; merely upcoming does not.
      kind: "due",
      score: d < 0 ? 110 : 95 - d,
    });
  }

  // ── 3. A document expiring within a month ─────────────────────────────────
  for (const doc of documents) {
    const d = daysBetween(now, doc?.expiryDate);
    if (d == null || d > 30) continue;
    const what = (doc.type || doc.name || "document").replace(/_/g, " ");
    push({
      id: `doc:${doc.id}`,
      text: `Open my ${what}`,
      label: `Open my ${what}`,
      reason: d < 0 ? `expired ${Math.abs(d)}d ago` : `expires ${dayLabel(d)}`,
      icon: "documents",
      kind: "due",
      score: d < 0 ? 105 : 90 - Math.floor(d / 5),
    });
  }

  // ── 4. A tracker that's gone quiet ────────────────────────────────────────
  // Not "you haven't logged in N days" against a fixed N — against the
  // tracker's OWN rhythm. A weekly weigh-in at 8 days is fine; a daily one at
  // 3 is not. Needs 3+ entries before we claim to know its cadence.
  for (const t of trackers) {
    if (!t?.name) continue;
    const cadence = medianCadenceDays(t.entries);
    const since = daysSinceLastEntry(now, t.entries);
    if (cadence == null || since == null) continue;
    if (since < cadence * 1.5) continue;
    push({
      id: `gap:${t.id}`,
      text: `Log ${t.name.toLowerCase()}`,
      label: `Log ${t.name.toLowerCase()}`,
      reason: agoLabel(since),
      icon: "trackers",
      kind: "gap",
      // The further past its rhythm, the louder — capped so it never outranks
      // something with an actual deadline.
      score: Math.min(85, 60 + Math.floor(since - cadence)),
    });
  }

  // ── 5. Time of day, but only for trackers that exist ──────────────────────
  // Suggesting "log sleep" to someone with no sleep tracker is the generic-copy
  // problem again, one level subtler.
  const has = (re: RegExp) => trackers.find((t) => nameMatches(t.name, re));
  const when = partOfDay(now);
  const routine = (t: SuggestTracker | undefined, text: string, icon: ConceptIcon, reason: string) => {
    if (!t) return;
    push({ id: `routine:${t.id}`, text, label: text, reason, icon, kind: "routine", score: 55 });
  };
  if (when === "morning") {
    routine(has(SLEEP_RE), "Log sleep: 7.5 hours", "sleep", "most people log this in the morning");
    routine(has(WEIGHT_RE), "Log my weight", "health", "morning is your usual time");
  } else if (when === "afternoon") {
    routine(has(WATER_RE), "Log 16 oz of water", "health", "halfway through the day");
    routine(has(STEPS_RE), "Log my steps", "activity", "check in on today's movement");
  } else {
    routine(has(STEPS_RE), "Log my steps", "activity", "wrap up today's movement");
    routine(has(MOOD_RE), "Log my mood", "mental", "end-of-day check-in");
  }

  // ── 6. Whoever the chat is pointed at ─────────────────────────────────────
  // Chatting as a pet or a vehicle should suggest things about THAT thing —
  // records created here get linked to it anyway.
  for (const p of scopeProfiles) {
    if (!p?.name) continue;
    if (p.type === "pet") {
      push({
        id: `scope:${p.id}`,
        text: `Log a vet visit for ${p.name}`,
        label: `Log a vet visit for ${p.name}`,
        reason: `you're chatting as ${p.name}`,
        icon: "health", kind: "scope", score: 70,
      });
    } else if (p.type === "vehicle") {
      push({
        id: `scope:${p.id}`,
        text: `Log fuel for ${p.name}`,
        label: `Log fuel for ${p.name}`,
        reason: `you're chatting as ${p.name}`,
        icon: "assets", kind: "scope", score: 70,
      });
    }
  }

  // ── 7. The category you actually spend in ─────────────────────────────────
  const cutoff = now.getTime() - 30 * 86400000;
  const byCategory = new Map<string, number>();
  for (const e of expenses) {
    const t = e?.date ? new Date(String(e.date).length === 10 ? `${e.date}T00:00:00` : String(e.date)).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const c = String(e.category || "").trim().toLowerCase();
    if (!c || c === "other" || c === "general") continue;
    byCategory.set(c, (byCategory.get(c) || 0) + 1);
  }
  const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCategory) {
    push({
      id: `spend:${topCategory[0]}`,
      text: `Spent $40 on ${topCategory[0]}`,
      label: `Log a ${topCategory[0]} expense`,
      reason: `${topCategory[1]} logged in the last 30 days`,
      icon: "finance", kind: "explore", score: 45,
    });
  }

  // ── 8. Nothing to go on ───────────────────────────────────────────────────
  // A brand-new account has no records to read, so it gets taught the surface
  // instead. These are the ONLY hardcoded strings left, and they appear only
  // when there is genuinely nothing else to say.
  if (out.length === 0) {
    const starters: Array<[string, ConceptIcon]> = [
      ["Track my weight", "health"],
      ["Spent $50 on groceries", "finance"],
      ["Remind me to call the dentist Friday", "alerts"],
      ["Add my car", "assets"],
    ];
    starters.forEach(([text, icon], i) =>
      push({ id: `explore:${i}`, text, label: text, icon, kind: "explore", score: 10 - i }));
  }

  // Stable: sort by score, then by first-seen so equal scores don't shuffle
  // between renders and move a chip out from under a thumb.
  const order = new Map(out.map((s, i) => [s.id, i]));
  return out
    .sort((a, b) => b.score - a.score || (order.get(a.id)! - order.get(b.id)!))
    .slice(0, max);
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

/**
 * What to offer straight after the assistant did something.
 *
 * Reads the action types the reply reported, so the next step is about what
 * just happened rather than a fresh generic list.
 */
export function buildFollowUps(
  actions: Array<{ type?: string; data?: any }> | undefined,
  max = 3,
): ChatSuggestion[] {
  if (!actions || actions.length === 0) return [];
  const out: ChatSuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: ChatSuggestion) => { if (!seen.has(s.id)) { seen.add(s.id); out.push(s); } };

  for (const a of actions) {
    const type = String(a?.type || "");
    const d = a?.data || {};
    if (/^(log_entry|log_tracker_entry|add_tracker_entry)$/.test(type)) {
      const name = d._trackerName || d.trackerName || d.name;
      if (name) {
        add({ id: `fu:trend:${name}`, text: `What's my ${String(name).toLowerCase()} trend?`,
          label: `What's my ${String(name).toLowerCase()} trend?`, icon: "trackers", kind: "followup", score: 90 });
      }
    } else if (type === "create_task") {
      add({ id: "fu:remind", text: "Remind me about that tomorrow",
        label: "Remind me about that tomorrow", icon: "alerts", kind: "followup", score: 85 });
    } else if (/^(create_liability|create_bill|create_obligation)$/.test(type)) {
      add({ id: "fu:due", text: "When is it due?", label: "When is it due?",
        icon: "dates", kind: "followup", score: 85 });
    } else if (type === "create_profile") {
      const name = d.name || d._name;
      add({ id: "fu:details", text: name ? `Add details for ${name}` : "Add more details",
        label: name ? `Add details for ${name}` : "Add more details",
        icon: "people", kind: "followup", score: 80 });
    } else if (/expense/i.test(type)) {
      add({ id: "fu:spend", text: "How much have I spent this month?",
        label: "How much have I spent this month?", icon: "finance", kind: "followup", score: 80 });
    }
  }
  return out.slice(0, max);
}
