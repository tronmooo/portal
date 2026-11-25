// ── Chat home ────────────────────────────────────────────────────────────────
// What the chat page shows before the first message (owner's design,
// 2026-11-25): a daily summary, six headline figures, one insight per domain
// and today at a glance.
//
// EVERY FIGURE IS ONE ANOTHER SCREEN ALREADY SHOWS (Rule 1). Nothing here
// invents a number or keeps a copy:
//   · wellness figures are the Wellness tab's own (`overviewTiles`,
//     `summarize`, `periodInsights`, `moodSummary`) over the last 7 days;
//   · spending, net worth, the category split and the bills are the
//     dashboard's finance snapshot;
//   · task counts are `countTasksByDay` (the Tasks card's rule).
//
// A LIST THAT HAS NOT LOADED IS NOT AN EMPTY LIST (Rule 7): each input is
// `undefined` while loading and named in `failed` when its request failed, and
// the figure then reads "loading" / "error" — never a zero. Something never
// recorded is "untracked", never a zero (H4).
//
// Pure: no I/O, no clock beyond `todayISO`. Pinned by tests/chat-home.test.ts.

import { countTasksByDay, type CountableTask } from "./task-counts";
import { overviewTiles, periodInsights, moodSummary, type OverviewTile, type WellnessCardsInput } from "./wellness-cards";
import { summarize, metricDailyPoints, pctChange } from "./wellness-period";
import { moveIsGood, resolveSeries } from "./wellness-widgets";
import type { MetricSeries } from "./wellness-readout";
import { isQuietAutoPayBill } from "./autopay";
import { categoryLabel } from "./category-canon";
import type { GroupedDocumentDate } from "./document-dates";

/** The range every wellness figure on the home is read over. */
export const HOME_RANGE = "7d" as const;

export type HomeState = "ready" | "loading" | "error" | "untracked";
export type HomeIcon =
  | "activity" | "sleep" | "heart" | "weight" | "spending" | "networth"
  | "tasks" | "event" | "bill" | "document" | "workout" | "water"
  | "wellness" | "finance" | "mindset" | "assets";

/** Where a tap goes: a route, or a message put in the chat box. */
export interface HomeTarget { href?: string; prompt?: string }

export interface HomeKpi extends HomeTarget {
  key: "activity" | "sleep" | "rhr" | "weight" | "spending" | "networth";
  icon: HomeIcon;
  label: string;
  state: HomeState;
  /** "6.4" */
  value: string | null;
  /** "mi" */
  unit?: string;
  /** "+18%" — and whether that move is good, bad or not judged. */
  delta?: { text: string; dir: "up" | "down" | "flat"; good: boolean | null };
  /** "Last: Oct 21" / "this month". */
  note?: string;
}

export interface HomeLine extends HomeTarget { key: string; icon: HomeIcon; text: string; tone: "good" | "info" | "warn" }
export interface HomeInsight extends HomeTarget { key: "wellness" | "finance" | "mindset" | "assets"; icon: HomeIcon; title: string; text: string; state: HomeState }
export interface HomeGlance extends HomeTarget { key: "tasks" | "events" | "bills" | "workout" | "hydration"; icon: HomeIcon; label: string; detail: string; state: HomeState; progress?: number }

export interface HomeEvent { title?: string | null; time?: string | null }
export interface HomeBill { id?: string; name?: string | null; amount?: number | null; daysUntil?: number | null; autopay?: unknown; autopayReminders?: unknown }

export type HomeList = "trackers" | "snapshot" | "tasks" | "events" | "journal";

export interface ChatHomeInput {
  todayISO: string;
  timezone?: string;
  /** The wellness subject's canonical series (undefined = trackers not loaded). */
  metrics?: Map<string, MetricSeries>;
  /** The wellness subject's trackers. */
  trackers?: any[];
  /** `dashboard-enhanced.financeSnapshot`. */
  snapshot?: Record<string, any> | null;
  tasks?: readonly CountableTask[];
  eventsToday?: readonly HomeEvent[];
  /** Dated document rows, already grouped and with dismissed ones removed. */
  expiring?: readonly GroupedDocumentDate[];
  journal?: readonly any[];
  /** Lists whose request FAILED (they are also undefined above). */
  failed?: ReadonlySet<HomeList>;
}

export interface ChatHome {
  lines: HomeLine[];
  kpis: HomeKpi[];
  insights: HomeInsight[];
  glance: HomeGlance[];
}

// ── Formatting ───────────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "$562" for whole dollars, "$9.99" when there are cents. */
export function homeMoney(n: number): string {
  const v = Number(n) || 0;
  const cents = Math.round(Math.abs(v) * 100) % 100 !== 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}

/** "$42,350" / "$1.4M" — a headline figure, whole dollars. */
export function homeMoneyCompact(n: number): string {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${v < 0 ? "−" : ""}$${round1(a / 1_000_000)}M`;
  return `${v < 0 ? "−" : ""}$${Math.round(a).toLocaleString("en-US")}`;
}

/** "21:00" → "9:00 PM". Anything else is returned as given. */
export function homeClock(time: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ""));
  if (!m) return "";
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

/** "5.9 hrs avg" → ["5.9", "hrs"]; "128 / 82" → ["128 / 82", ""]. */
function splitValue(v: string): { value: string; unit?: string } {
  const m = /^(≈?[\d.,]+(?: \/ [\d.,]+)?)\s*(.*)$/.exec(v.replace(/ avg$/, ""));
  return m ? { value: m[1], unit: m[2] || undefined } : { value: v };
}

const stateOf = (i: ChatHomeInput, list: HomeList, loaded: boolean): HomeState | null =>
  i.failed?.has(list) ? "error" : loaded ? null : "loading";

// ── Wellness tiles ───────────────────────────────────────────────────────────

const TILE_PROMPT: Record<string, string> = { activity: "Log a workout: ", sleep: "I slept ", weight: "Track my weight: " };

function kpiFromTile(key: "activity" | "sleep" | "weight", icon: HomeIcon, t: OverviewTile | undefined): HomeKpi {
  const base = { key, icon, label: t?.label ?? key } as const;
  if (!t || !t.tracked) return { ...base, state: "untracked", value: null, prompt: TILE_PROMPT[key] };
  const parts = t.value ? splitValue(t.value) : { value: null as string | null, unit: undefined };
  return {
    ...base, state: "ready", value: parts.value, unit: parts.unit,
    delta: t.delta ? { text: t.delta.text.replace(/ vs prior.*$/, ""), dir: t.delta.dir, good: t.delta.good } : undefined,
    note: !t.value || t.stale ? t.last : undefined,
    href: t.href ?? "/wellness",
  };
}

function restingHeartRate(i: ChatHomeInput): HomeKpi {
  const base = { key: "rhr", icon: "heart", label: "RHR" } as const;
  const m = i.metrics!.get("resting_hr");
  const s = summarize(metricDailyPoints(m), HOME_RANGE, i.todayISO);
  if (!m || !s.latestEver) return { ...base, state: "untracked", value: null, prompt: "My resting heart rate is " };
  const d = s.avg != null && s.priorAvg != null ? Math.round(s.avg - s.priorAvg) : null;
  return {
    ...base, state: "ready", value: String(Math.round(s.latestEver.value)), unit: "bpm",
    delta: d != null && d !== 0 ? { text: `${d > 0 ? "+" : "−"}${Math.abs(d)}`, dir: d > 0 ? "up" : "down", good: moveIsGood(m.metric, s.priorAvg!, s.avg!) } : undefined,
    note: !s.last ? `Last: ${s.latestEver.day.slice(5).replace("-", "/")}` : undefined,
    href: "/wellness",
  };
}

// ── The build ────────────────────────────────────────────────────────────────

export function buildChatHome(i: ChatHomeInput): ChatHome {
  const lines: Array<HomeLine & { urgent: boolean }> = [];
  const kpis: HomeKpi[] = [];
  const insights: HomeInsight[] = [];
  const glance: HomeGlance[] = [];

  // ── Wellness: the Wellness tab's own tiles over the last 7 days ───────────
  const wellState = stateOf(i, "trackers", !!i.metrics && !!i.trackers);
  if (wellState) {
    for (const [key, icon, label] of [["activity", "activity", "Activity"], ["sleep", "sleep", "Sleep"], ["rhr", "heart", "RHR"], ["weight", "weight", "Weight"]] as const) {
      kpis.push({ key, icon, label, state: wellState, value: null, href: "/wellness" });
    }
    insights.push({ key: "wellness", icon: "wellness", title: "Wellness", state: wellState, text: wellState === "error" ? "Couldn't load your trackers." : "Loading…", href: "/wellness" });
  } else {
    const input: WellnessCardsInput = { metrics: i.metrics!, trackers: i.trackers!, range: HOME_RANGE, todayISO: i.todayISO, timezone: i.timezone };
    const tiles = overviewTiles(input);
    const tile = (k: string) => tiles.find((t) => t.key === k);
    kpis.push(kpiFromTile("activity", "activity", tile("activity")), kpiFromTile("sleep", "sleep", tile("sleep")), restingHeartRate(i), kpiFromTile("weight", "weight", tile("weight")));

    // Summary lines, from the same summaries the tiles read.
    const workouts = resolveSeries({ kind: "workouts" }, { metrics: i.metrics!, trackers: i.trackers!, timezone: i.timezone });
    const w = workouts ? summarize(workouts.points, HOME_RANGE, i.todayISO) : null;
    if (w && w.entries > 0) {
      const pct = pctChange(w.entries, w.priorEntries || null);
      const n = plural(w.entries, "session");
      lines.push(pct != null && Math.round(pct) !== 0
        ? { key: "activity", icon: "activity", urgent: false, tone: pct > 0 ? "good" : "info", href: "/wellness", text: `You're ${Math.abs(Math.round(pct))}% ${pct > 0 ? "more" : "less"} active this week (${n}).` }
        : { key: "activity", icon: "activity", urgent: false, tone: "good", href: "/wellness", text: `You logged ${n} this week.` });
    }
    const sl = summarize(metricDailyPoints(i.metrics!.get("sleep_hours")), HOME_RANGE, i.todayISO);
    if (sl.avg != null) {
      const d = sl.priorAvg != null ? round1(sl.avg - sl.priorAvg) : null;
      lines.push(d != null && Math.abs(d) >= 0.25
        ? { key: "sleep", icon: "sleep", urgent: false, tone: d > 0 ? "good" : "info", href: "/wellness", text: `Your sleep is ${d > 0 ? "up" : "down"} ${Math.abs(d)} hours (avg ${round1(sl.avg)} hrs).` }
        : { key: "sleep", icon: "sleep", urgent: false, tone: "info", href: "/wellness", text: `Sleep is averaging ${round1(sl.avg)} hrs a night this week.` });
    }

    const found = periodInsights(input);
    const top = found.find((x) => x.tone === "warn") ?? found[0];
    insights.push(top
      ? { key: "wellness", icon: "wellness", title: "Wellness", state: "ready", text: top.text, href: "/wellness" }
      : { key: "wellness", icon: "wellness", title: "Wellness", state: "untracked", text: "Nothing logged in the last 7 days. Tell me a workout, a weigh-in or how you slept.", prompt: "Log a workout: " });

    // Today: was a workout logged, and how much water.
    if (w?.latestEver) {
      const done = w.points.some((p) => p.day === i.todayISO);
      glance.push({ key: "workout", icon: "workout", label: "Workout", state: "ready", detail: done ? "Logged today" : "Not logged yet", ...(done ? { href: "/trackers" } : { prompt: "Log a workout: " }) });
    }
    const water = i.metrics!.get("hydration");
    const ws = summarize(metricDailyPoints(water), HOME_RANGE, i.todayISO);
    if (water && ws.latestEver) {
      const today = ws.points.find((p) => p.day === i.todayISO)?.value ?? 0;
      const unit = water.metric.unit || "oz";
      // The bar is today against this week's average day — the app stores no water goal.
      glance.push({
        key: "hydration", icon: "water", label: "Hydration", state: "ready",
        detail: ws.avg != null && ws.avg > 0 ? `${Math.round(today)} ${unit} · avg ${Math.round(ws.avg)}` : `${Math.round(today)} ${unit} today`,
        progress: ws.avg != null && ws.avg > 0 ? Math.max(0, Math.min(1, today / ws.avg)) : undefined,
        prompt: "I drank ",
      });
    }
  }

  // ── Money: the dashboard's finance snapshot ───────────────────────────────
  const moneyState = stateOf(i, "snapshot", i.snapshot != null);
  if (moneyState) {
    kpis.push({ key: "spending", icon: "spending", label: "Spending", state: moneyState, value: null, href: "/dashboard/finance" });
    kpis.push({ key: "networth", icon: "networth", label: "Net Worth", state: moneyState, value: null, href: "/dashboard/finance" });
    for (const [key, title, icon, href] of [["finance", "Finance", "finance", "/dashboard/finance"], ["assets", "Assets", "assets", "/linked?tab=assets"]] as const) {
      insights.push({ key, icon, title, state: moneyState, text: moneyState === "error" ? "Couldn't load your finances." : "Loading…", href });
    }
    glance.push({ key: "bills", icon: "bill", label: "Bills", state: moneyState, detail: moneyState === "error" ? "Couldn't load" : "…", href: "/dashboard/finance" });
  } else {
    const snap = i.snapshot!;
    const spend = Number(snap.totalMonthlySpend) || 0;
    const lastMonth = Number(snap.lastMonthTotal) || 0;
    const trend = lastMonth > 0 ? Math.round(((spend - lastMonth) / lastMonth) * 100) : null;
    kpis.push({
      key: "spending", icon: "spending", label: "Spending", state: "ready", value: homeMoneyCompact(spend), note: "this month",
      delta: trend != null && trend !== 0 ? { text: `${trend > 0 ? "+" : "−"}${Math.abs(trend)}%`, dir: trend > 0 ? "up" : "down", good: trend < 0 } : undefined,
      href: "/dashboard/finance",
    });
    const assets = Number(snap.totalAssetValue) || 0;
    const debt = Number(snap.totalLiabilities) || 0;
    kpis.push({ key: "networth", icon: "networth", label: "Net Worth", state: "ready", value: homeMoneyCompact(assets - debt), href: "/dashboard/finance" });

    if (spend > 0) {
      lines.push(trend != null && trend !== 0
        ? { key: "spending", icon: "spending", urgent: false, tone: trend > 0 ? "info" : "good", href: "/dashboard/finance", text: `Spending is ${trend > 0 ? "up" : "down"} ${Math.abs(trend)}% on last month (${homeMoney(Math.round(spend))} so far).` }
        : { key: "spending", icon: "spending", urgent: false, tone: "info", href: "/dashboard/finance", text: `You've spent ${homeMoney(Math.round(spend))} this month.` });
    }

    // Finance insight: where the month's money went.
    const cats = Object.entries((snap.spendByCategory || {}) as Record<string, number>)
      .map(([k, v]) => [k, Number(v) || 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    insights.push(cats.length === 0
      ? { key: "finance", icon: "finance", title: "Finance", state: "untracked", text: "No spending logged this month. Tell me what you spent and I'll file it.", prompt: "I spent $" }
      : {
        key: "finance", icon: "finance", title: "Finance", state: "ready", href: "/dashboard/finance",
        text: cats.length === 1
          ? `${categoryLabel(cats[0][0])} is your only spending this month (${homeMoney(Math.round(cats[0][1]))}).`
          : `${categoryLabel(cats[0][0])} and ${categoryLabel(cats[1][0]).toLowerCase()} are your highest expenses this month (${homeMoney(Math.round(cats[0][1]))}, ${homeMoney(Math.round(cats[1][1]))}).`,
      });

    // Assets insight: what is owned, and the largest.
    const owned = (Array.isArray(snap.assetBreakdown) ? snap.assetBreakdown : []).filter((a: any) => Number(a?.value) > 0);
    insights.push(owned.length === 0
      ? { key: "assets", icon: "assets", title: "Assets", state: "untracked", text: "Nothing on file yet. Add a car, a home or an account and I'll keep its value current.", prompt: "Add my car: " }
      : {
        key: "assets", icon: "assets", title: "Assets", state: "ready", href: "/linked?tab=assets",
        text: `${plural(owned.length, "asset")} worth ${homeMoneyCompact(assets)}. Largest: ${owned[0].name} at ${homeMoneyCompact(Number(owned[0].value))}.`,
      });

    // Bills due in the next 7 days. A bill on Auto Pay is quiet (A6).
    const seen = new Set<string>();
    const due = ((Array.isArray(snap.upcomingBills) ? snap.upcomingBills : []) as HomeBill[]).filter((b) => {
      const id = String(b?.id ?? `${b?.name}|${b?.amount}|${b?.daysUntil}`);
      if (seen.has(id)) return false;
      seen.add(id);
      return typeof b?.daysUntil === "number" && b.daysUntil >= 0 && b.daysUntil <= 7 && !isQuietAutoPayBill(b, b.daysUntil);
    });
    glance.push({
      key: "bills", icon: "bill", label: due.length === 0 ? "No Bills Due" : `${plural(due.length, "Bill")} Due`, state: "ready",
      detail: due.length === 0 ? "next 7 days" : due.slice(0, 2).map((b) => homeMoney(Number(b.amount) || 0)).join(", ") + (due.length > 2 ? ` +${due.length - 2}` : ""),
      href: "/dashboard/finance",
    });
    if (due.length === 1) {
      lines.push({ key: "bills", icon: "bill", urgent: (due[0].daysUntil ?? 9) <= 3, tone: "info", href: "/dashboard/finance", text: `${due[0].name || "A bill"} (${homeMoney(Number(due[0].amount) || 0)}) is due ${inDays(due[0].daysUntil!)}.` });
    } else if (due.length > 1) {
      const total = due.reduce((s, b) => s + (Number(b.amount) || 0), 0);
      lines.push({ key: "bills", icon: "bill", urgent: due.some((b) => (b.daysUntil ?? 9) <= 3), tone: "info", href: "/dashboard/finance", text: `${due.length} bills are due in the next 7 days (${homeMoney(total)}).` });
    }
  }

  // ── Tasks: the Tasks card's own counts ────────────────────────────────────
  const taskState = stateOf(i, "tasks", Array.isArray(i.tasks));
  if (taskState) {
    glance.unshift({ key: "tasks", icon: "tasks", label: "Tasks", state: taskState, detail: taskState === "error" ? "Couldn't load" : "…", href: "/dashboard/tasks" });
  } else {
    const c = countTasksByDay(i.tasks!, i.todayISO, i.timezone);
    const open = c.overdue + c.dueToday + c.upcoming + c.undated;
    const dueNow = c.dueToday + c.overdue;
    glance.unshift({
      key: "tasks", icon: "tasks", state: "ready", href: "/dashboard/tasks",
      label: dueNow > 0 ? `${plural(dueNow, "Task")} Due` : open > 0 ? `${plural(open, "Task")} Open` : "No Tasks Due",
      detail: c.overdue > 0 ? `${c.overdue} late` : dueNow > 0 ? "today" : open > 0 ? "none due today" : "all clear",
    });
    if (open > 0) {
      const bits = [c.dueToday > 0 ? `${c.dueToday} due today` : "", c.overdue > 0 ? `${c.overdue} late` : ""].filter(Boolean);
      lines.push({ key: "tasks", icon: "tasks", urgent: dueNow > 0, tone: c.overdue > 0 ? "warn" : "info", href: "/dashboard/tasks", text: `${plural(open, "task")} open${bits.length ? ` — ${bits.join(", ")}` : ""}.` });
    }
  }

  // ── Today's events ────────────────────────────────────────────────────────
  const eventState = stateOf(i, "events", Array.isArray(i.eventsToday));
  if (eventState) {
    glance.splice(1, 0, { key: "events", icon: "event", label: "Events", state: eventState, detail: eventState === "error" ? "Couldn't load" : "…", href: "/calendar" });
  } else {
    const ev = i.eventsToday!;
    const first = ev[0];
    const firstText = first ? [String(first.title || "Event").trim(), homeClock(first.time)].filter(Boolean).join(" – ") : "";
    glance.splice(1, 0, {
      key: "events", icon: "event", state: "ready", href: "/calendar",
      label: ev.length === 0 ? "No Events" : plural(ev.length, "Event"),
      detail: ev.length === 0 ? "today" : firstText,
    });
    if (ev.length > 0) {
      lines.push({ key: "events", icon: "event", urgent: true, tone: "info", href: "/calendar", text: ev.length === 1 ? `Today: ${firstText}.` : `${ev.length} events today, starting with ${firstText}.` });
    }
  }

  // ── The nearest dated document ────────────────────────────────────────────
  const nextDoc = [...(i.expiring || [])].filter((d) => typeof d.daysUntil === "number").sort((a, b) => a.daysUntil! - b.daysUntil!)[0];
  if (nextDoc) {
    const n = nextDoc.daysUntil!;
    const kind = (nextDoc.typesLabel || "Expiration").split(" · ")[0].toLowerCase();
    const name = nextDoc.baseName || nextDoc.documentName || "A document";
    lines.push({
      key: "document", icon: "document", urgent: n <= 14, tone: n < 0 ? "warn" : "info", href: "/linked?tab=documents",
      text: n < 0 ? `${name}: ${kind} was ${plural(Math.abs(n), "day")} ago.` : `${name}: ${kind} ${inDays(n)}.`,
    });
  }

  // ── Mindset: the journal's own mood summary ───────────────────────────────
  const journalState = stateOf(i, "journal", Array.isArray(i.journal));
  if (journalState) {
    insights.splice(2, 0, { key: "mindset", icon: "mindset", title: "Mindset", state: journalState, text: journalState === "error" ? "Couldn't load your journal." : "Loading…", href: "/dashboard/journal" });
  } else {
    const mood = moodSummary(i.journal!, HOME_RANGE, i.todayISO, i.timezone);
    const written = i.journal!.filter((j: any) => {
      const day = String(j?.date || "").slice(0, 10);
      return day && day <= i.todayISO && day > shiftDay(i.todayISO, -7);
    }).length;
    insights.splice(2, 0, written === 0
      ? { key: "mindset", icon: "mindset", title: "Mindset", state: "untracked", text: "No journal entries this week. Write a few lines and I'll keep track of how you're doing.", href: "/workspace/journal" }
      : {
        key: "mindset", icon: "mindset", title: "Mindset", state: "ready", href: "/dashboard/journal",
        text: mood.average
          ? `${plural(written, "journal entry", "journal entries")} this week. Mood has averaged ${mood.average.toLowerCase()}${mood.delta ? ` — ${mood.delta.toLowerCase().replace(/ vs prior.*$/, "")} than the week before` : ""}.`
          : `${plural(written, "journal entry", "journal entries")} this week.`,
      });
  }

  // Urgent things first, then the trends; at most five, each once.
  const ordered = [...lines.filter((l) => l.urgent), ...lines.filter((l) => !l.urgent)].slice(0, 5);
  return {
    lines: ordered.map(({ urgent: _u, ...l }) => l),
    kpis,
    insights: (["wellness", "finance", "mindset", "assets"] as const).map((k) => insights.find((x) => x.key === k)!).filter(Boolean),
    glance: GLANCE_ORDER.map((k) => glance.find((g) => g.key === k)!).filter(Boolean),
  };
}

const GLANCE_ORDER = ["tasks", "events", "bills", "workout", "hydration"] as const;

/** A calendar day moved by whole days (no timezone: both ends are YYYY-MM-DD). */
function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}
