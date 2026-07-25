// ============================================================
// starter-prompts.ts — personalized chat starter prompts
// ============================================================
// Replaces the static suggestion chips with prompts generated from the
// user's OWN data — unfinished work, overdue items, upcoming events,
// expiring documents, spending trends, health trackers, habit gaps — plus a
// learning loop: what they click and what they habitually type re-ranks
// future suggestions, and prompts that keep being shown but never clicked
// decay out of rotation.
//
// Everything here is pure and deterministic (no LLM call, no I/O) so the
// endpoint answers instantly, the output is unit-testable, and a sparse or
// brand-new account degrades gracefully to useful onboarding prompts.

export interface StarterPrompt {
  /** Stable id — click/served stats attach to this across regenerations. */
  id: string;
  /** The text inserted into the composer (phrased as a user message). */
  text: string;
  theme: string;
  /** Why this prompt was chosen — provenance for the UI/debugging. */
  reason: string;
  score: number;
}

export interface StarterPromptSnapshot {
  now?: string | Date;
  tasks?: Array<{ title?: string; status?: string; dueDate?: string | null }>;
  events?: Array<{ title?: string; date?: string | null }>;
  habits?: Array<{ name?: string; frequency?: string; currentStreak?: number; checkins?: Array<{ date?: string }> }>;
  documents?: Array<{ name?: string; type?: string | null; expirationDate?: string | null; createdAt?: string | null }>;
  expenses?: Array<{ amount?: number; date?: string | null; category?: string | null }>;
  obligations?: Array<{ name?: string; amount?: number; nextDueDate?: string | null; status?: string | null }>;
  trackers?: Array<{ name?: string; category?: string | null; entries?: Array<{ timestamp?: string | null }> }>;
  journalEntries?: Array<{ date?: string | null }>;
  profiles?: Array<{ name?: string; type?: string | null }>;
}

export interface StarterPromptUsage {
  /** How many times each prompt id has been served to this user. */
  served: Record<string, number>;
  /** Clicks per prompt id, with the most recent click time. */
  clicked: Record<string, { n: number; last: string }>;
  /** Theme affinity learned from what the user types + clicks. */
  themeCounts: Record<string, number>;
}

export function emptyUsage(): StarterPromptUsage {
  return { served: {}, clicked: {}, themeCounts: {} };
}

// ── Theme learning from typed messages ──────────────────────────────────────
// Deterministic keyword classifier over the user's chat history (captures
// already store every typed message). Recurring vocabulary = recurring theme.

const THEME_KEYWORDS: Array<[string, RegExp]> = [
  ["finance", /\b(spend|spent|spending|expense|budget|money|income|net ?worth|balance|owe|debt|loan|mortgage|bill|pay|paid|subscription|bank|invest)\b/i],
  ["health", /\b(weight|bp|blood pressure|sleep|steps|calorie|protein|workout|run|ran|walk|gym|mood|medication|meds|dose|symptom|doctor|glucose)\b/i],
  ["tasks", /\b(task|todo|to-do|remind|reminder|due|overdue|deadline|finish|complete)\b/i],
  ["calendar", /\b(calendar|event|appointment|schedule|meeting|birthday|anniversary)\b/i],
  ["documents", /\b(document|license|licence|passport|registration|insurance|policy|warranty|receipt|statement|upload|expir)\b/i],
  ["habits", /\b(habit|streak|check ?in|daily|routine)\b/i],
  ["vehicles", /\b(car|vehicle|truck|honda|toyota|tesla|ford|vin|plate|mileage|odometer|oil change)\b/i],
  ["people", /\b(mom|dad|wife|husband|son|daughter|brother|sister|kid|family|profile)\b/i],
  ["pets", /\b(dog|cat|pet|vet|vaccination|rabies)\b/i],
  ["journal", /\b(journal|diary|gratitude|reflect)\b/i],
];

export function classifyMessageTheme(text: string): string | null {
  const t = String(text || "");
  if (!t.trim()) return null;
  for (const [theme, re] of THEME_KEYWORDS) {
    if (re.test(t)) return theme;
  }
  return null;
}

export function themeCountsFromMessages(messages: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of messages || []) {
    const theme = classifyMessageTheme(m);
    if (theme) counts[theme] = (counts[theme] || 0) + 1;
  }
  return counts;
}

// ── Candidate generation ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

interface Candidate { id: string; text: string; theme: string; reason: string; base: number }

function buildCandidates(snapshot: StarterPromptSnapshot, now: Date): Candidate[] {
  const out: Candidate[] = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in7d = new Date(today.getTime() + 7 * DAY_MS);
  const tasks = snapshot.tasks || [];
  const events = snapshot.events || [];
  const habits = snapshot.habits || [];
  const documents = snapshot.documents || [];
  const expenses = snapshot.expenses || [];
  const obligations = snapshot.obligations || [];
  const trackers = snapshot.trackers || [];
  const journal = snapshot.journalEntries || [];
  const profiles = snapshot.profiles || [];

  // Unfinished / overdue work — highest urgency.
  const openTasks = tasks.filter(t => t.status !== "done");
  const overdue = openTasks.filter(t => {
    const d = toDate(t.dueDate);
    return d !== null && d < today;
  });
  if (overdue.length > 0) {
    out.push({
      id: "overdue_tasks", theme: "tasks", base: 100,
      text: overdue.length === 1
        ? `I have an overdue task ("${String(overdue[0].title || "untitled").slice(0, 40)}") — help me deal with it`
        : `Help me work through my ${overdue.length} overdue tasks`,
      reason: `${overdue.length} task(s) past their due date`,
    });
  }
  if (openTasks.length > 0) {
    out.push({
      id: "focus_today", theme: "tasks", base: overdue.length > 0 ? 72 : 80,
      text: "What tasks should I focus on today?",
      reason: `${openTasks.length} open task(s)`,
    });
  }

  // Due this week — tasks + bills together.
  const dueWeekTasks = openTasks.filter(t => {
    const d = toDate(t.dueDate);
    return d !== null && d >= today && d <= in7d;
  });
  const dueWeekBills = obligations.filter(o => {
    if (o.status === "cancelled") return false;
    const d = toDate(o.nextDueDate);
    return d !== null && d <= in7d;
  });
  if (dueWeekTasks.length + dueWeekBills.length > 0) {
    out.push({
      id: "due_this_week", theme: "tasks", base: 90,
      text: "Review everything that's due this week",
      reason: `${dueWeekTasks.length} task(s) + ${dueWeekBills.length} bill(s) due within 7 days`,
    });
  }

  // Expiring documents.
  const expiring = documents.filter(d => {
    const exp = toDate(d.expirationDate);
    return exp !== null && exp >= today && exp <= new Date(today.getTime() + 60 * DAY_MS);
  });
  if (expiring.length > 0) {
    out.push({
      id: "docs_expiring", theme: "documents", base: 85,
      text: "Any documents expiring soon?",
      reason: `${expiring.length} document(s) expire within 60 days (e.g. ${String(expiring[0].name || "").slice(0, 40)})`,
    });
  }

  // Upcoming calendar.
  const upcoming = events.filter(e => {
    const d = toDate(e.date);
    return d !== null && d >= today && d <= in7d;
  });
  if (upcoming.length > 0) {
    out.push({
      id: "calendar_week", theme: "calendar", base: 65,
      text: "What's on my calendar this week?",
      reason: `${upcoming.length} event(s) in the next 7 days`,
    });
  }

  // Habit gaps: an active streak the user hasn't checked in on recently.
  const staleHabits = habits.filter(h => {
    if (!h.checkins || h.checkins.length === 0) return false;
    const last = h.checkins.map(c => toDate(c.date)).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
    return last !== null && last !== undefined && (today.getTime() - last!.getTime()) >= 2 * DAY_MS;
  });
  if (staleHabits.length > 0) {
    out.push({
      id: "habits_missed", theme: "habits", base: 70,
      text: "Did I miss any habits this week?",
      reason: `${staleHabits.length} habit(s) with no recent check-in`,
    });
  }

  // Spending: month-over-month comparison + anomaly hunt.
  const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = monthKey(today);
  const prevMonth = monthKey(new Date(today.getFullYear(), today.getMonth() - 1, 15));
  let curTotal = 0, prevTotal = 0, count = 0;
  for (const e of expenses) {
    const d = toDate(e.date);
    if (!d) continue;
    const k = monthKey(d);
    const amt = Number(e.amount) || 0;
    if (k === thisMonth) { curTotal += amt; count++; }
    else if (k === prevMonth) { prevTotal += amt; count++; }
  }
  if (count >= 5) {
    const spike = prevTotal > 0 && curTotal > prevTotal * 1.25;
    out.push({
      id: "spending_anomaly", theme: "finance", base: spike ? 82 : 55,
      text: "Find anything unusual in my spending",
      reason: spike
        ? `this month ($${Math.round(curTotal)}) is running >25% above last month ($${Math.round(prevTotal)})`
        : `${count} expense(s) across the last two months`,
    });
    out.push({
      id: "financial_health", theme: "finance", base: 45,
      text: "How is my financial health compared to last month?",
      reason: "expense history exists for both months",
    });
  }

  // Debts.
  const debts = profiles.filter(p => p.type === "loan" || p.type === "liability");
  if (debts.length > 0) {
    out.push({
      id: "debt_outlook", theme: "finance", base: 40,
      text: "How much do I owe across all my debts, and what's the payoff outlook?",
      reason: `${debts.length} liability profile(s)`,
    });
  }

  // Health trends: the tracker with the most recent activity.
  const healthy = trackers
    .map(t => ({
      name: String(t.name || ""),
      recent: (t.entries || []).filter(e => {
        const d = toDate(e.timestamp);
        return d !== null && (now.getTime() - d.getTime()) <= 30 * DAY_MS;
      }).length,
    }))
    .filter(t => t.name && t.recent >= 3)
    .sort((a, b) => b.recent - a.recent);
  if (healthy.length > 0) {
    out.push({
      id: "health_trends", theme: "health", base: 50,
      text: "Summarize my health trends over the last 30 days",
      reason: `${healthy.length} tracker(s) active in the last 30 days`,
    });
    out.push({
      id: `tracker_trend`, theme: "health", base: 48,
      text: `What's my ${healthy[0].name} trend?`,
      reason: `"${healthy[0].name}" is the most-logged tracker (${healthy[0].recent} entries in 30 days)`,
    });
  }

  // Recent activity diff.
  const recentDoc = documents.some(d => {
    const c = toDate(d.createdAt);
    return c !== null && (now.getTime() - c.getTime()) <= 36 * 3600_000;
  });
  const recentExpense = expenses.some(e => {
    const d = toDate(e.date);
    return d !== null && (now.getTime() - d.getTime()) <= 36 * 3600_000;
  });
  if (recentDoc || recentExpense) {
    out.push({
      id: "changed_since_yesterday", theme: "activity", base: 60,
      text: "Show me what changed since yesterday",
      reason: "new data was added in the last day and a half",
    });
  }

  // Journal nudge — only for people who actually journal.
  if (journal.length >= 3) {
    const last = journal.map(j => toDate(j.date)).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
    if (last && (today.getTime() - last!.getTime()) >= 2 * DAY_MS) {
      out.push({
        id: "journal_nudge", theme: "journal", base: 35,
        text: "Help me write today's journal entry",
        reason: "regular journaler with no entry in 2+ days",
      });
    }
  }

  // Pets / vehicles — light personalization by owned profile types.
  const pet = profiles.find(p => p.type === "pet");
  if (pet?.name) {
    out.push({
      id: "pet_status", theme: "pets", base: 30,
      text: `What's coming up for ${String(pet.name).slice(0, 30)}?`,
      reason: "has a pet profile",
    });
  }
  const vehicle = profiles.find(p => p.type === "vehicle");
  if (vehicle?.name) {
    out.push({
      id: "vehicle_status", theme: "vehicles", base: 30,
      text: `Summarize everything about my ${String(vehicle.name).slice(0, 30)}`,
      reason: "has a vehicle profile",
    });
  }

  // Fallbacks — guarantee a useful set for sparse/new accounts.
  out.push(
    { id: "fb_log_day", theme: "activity", base: 15, text: "Log what I ate and did today", reason: "fallback" },
    { id: "fb_add_task", theme: "tasks", base: 14, text: "Remind me to do something this week", reason: "fallback" },
    { id: "fb_track", theme: "health", base: 13, text: "Start tracking my weight", reason: "fallback" },
    { id: "fb_upload", theme: "documents", base: 12, text: "What documents should I upload to get started?", reason: "fallback" },
    { id: "fb_tour", theme: "activity", base: 11, text: "What can you do with my data?", reason: "fallback" },
  );

  return out;
}

// ── Ranking with learned usage ───────────────────────────────────────────────

const MIN_PROMPTS = 4;
const MAX_PROMPTS = 8;
const MAX_PER_THEME = 2;
/** A prompt served this often with zero clicks is considered low-performing
 *  and decays out so something else gets a chance. */
export const FATIGUE_SERVED_THRESHOLD = 8;

export function generateStarterPrompts(
  snapshot: StarterPromptSnapshot,
  usage: StarterPromptUsage = emptyUsage(),
  count = 6,
): StarterPrompt[] {
  const now = toDate(snapshot.now) || new Date();
  const n = Math.max(MIN_PROMPTS, Math.min(MAX_PROMPTS, count));
  const themeCounts = usage.themeCounts || {};
  const served = usage.served || {};
  const clicked = usage.clicked || {};

  const scored = buildCandidates(snapshot, now).map(c => {
    let score = c.base;
    // Theme affinity: things the user talks about (and clicks) rank higher.
    score += Math.min(Number(themeCounts[c.theme]) || 0, 20) * 2;
    // Direct reinforcement: prompts this user actually clicks come back.
    const click = clicked[c.id];
    if (click && click.n > 0) {
      score += Math.min(click.n, 5) * 8;
      const last = toDate(click.last);
      if (last && now.getTime() - last.getTime() <= 7 * DAY_MS) score += 10;
    }
    // Fatigue: shown many times, never clicked → decay out of rotation.
    const shows = Number(served[c.id]) || 0;
    if (shows >= FATIGUE_SERVED_THRESHOLD && (!click || click.n === 0)) {
      score -= 30 + Math.min(shows - FATIGUE_SERVED_THRESHOLD, 10) * 2;
    }
    return { id: c.id, text: c.text, theme: c.theme, reason: c.reason, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Diversity: at most MAX_PER_THEME prompts per theme so one hot theme
  // doesn't crowd out the rest of the user's life.
  const out: StarterPrompt[] = [];
  const perTheme: Record<string, number> = {};
  for (const p of scored) {
    if (out.length >= n) break;
    if ((perTheme[p.theme] || 0) >= MAX_PER_THEME) continue;
    perTheme[p.theme] = (perTheme[p.theme] || 0) + 1;
    out.push(p);
  }
  // Backfill if the diversity cap left us short.
  for (const p of scored) {
    if (out.length >= Math.max(MIN_PROMPTS, Math.min(n, scored.length))) break;
    if (!out.some(x => x.id === p.id)) out.push(p);
  }
  return out;
}

// ── Usage-stats bookkeeping (shared by the routes) ──────────────────────────

const MAX_TRACKED_PROMPTS = 60;

/** Parse the persisted stats blob defensively — any corruption resets. */
export function parseUsage(raw: string | null | undefined): StarterPromptUsage {
  if (!raw) return emptyUsage();
  try {
    const p = JSON.parse(raw);
    return {
      served: p && typeof p.served === "object" && p.served ? p.served : {},
      clicked: p && typeof p.clicked === "object" && p.clicked ? p.clicked : {},
      themeCounts: p && typeof p.themeCounts === "object" && p.themeCounts ? p.themeCounts : {},
    };
  } catch {
    return emptyUsage();
  }
}

export function recordServed(usage: StarterPromptUsage, ids: string[]): StarterPromptUsage {
  for (const id of ids) usage.served[id] = (Number(usage.served[id]) || 0) + 1;
  // Bound the maps so the pref blob can't grow without limit.
  const keys = Object.keys(usage.served);
  if (keys.length > MAX_TRACKED_PROMPTS) {
    for (const k of keys.slice(0, keys.length - MAX_TRACKED_PROMPTS)) delete usage.served[k];
  }
  return usage;
}

export function recordClick(usage: StarterPromptUsage, id: string, theme?: string, at: Date = new Date()): StarterPromptUsage {
  const cur = usage.clicked[id];
  usage.clicked[id] = { n: (cur?.n || 0) + 1, last: at.toISOString() };
  // A click is a strong theme signal too.
  if (theme) usage.themeCounts[theme] = (Number(usage.themeCounts[theme]) || 0) + 2;
  const keys = Object.keys(usage.clicked);
  if (keys.length > MAX_TRACKED_PROMPTS) {
    for (const k of keys.slice(0, keys.length - MAX_TRACKED_PROMPTS)) delete usage.clicked[k];
  }
  return usage;
}
