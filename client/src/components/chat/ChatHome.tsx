// ── Chat home ────────────────────────────────────────────────────────────────
// What the chat page shows before the first message (owner's design,
// 2026-11-25): greeting, the daily summary, six headline figures, one insight
// per domain, today at a glance, things to ask, and the suggestions earned
// from the user's records.
//
// This file DRAWS; `shared/chat-home.ts` decides every word and number, from
// the same lists the dashboard and the Wellness tab read (Rule 1). The hook
// below uses those screens' own query keys, so after the bootstrap it mostly
// reads memory, and a write anywhere invalidates these the same way (Rule 2).
// Opening the page writes nothing (Rule 3). A figure whose list failed says
// so; one still loading shows a placeholder, never a zero (Rule 7).
//
// Every row goes somewhere: a route (`href`) or a message put in the chat box
// (`prompt`). Nothing on it is decoration that looks tappable.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, BarChart3, Brain, CalendarDays, Car, CheckSquare, ChevronRight, Coins, Droplet, Dumbbell,
  FileText, HeartPulse, Lightbulb, Moon, Receipt, RefreshCw, Scale, Sparkles, Target, TrendingDown,
  TrendingUp, Wallet, ArrowUp, ArrowDown, NotebookPen, Layers, MessageCircle, type LucideIcon,
} from "lucide-react";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useDismissedAlertIds } from "@/hooks/useDismissedAlerts";
import { useDocSnoozeMap } from "@/lib/docSnooze";
import { useShowTestData } from "@/lib/showTestData";
import { isTestDataRow } from "@shared/test-data";
import { isDateRowDismissed } from "@shared/alert-ids";
import { groupDocumentDates } from "@shared/document-dates";
import { canonicalTimelineWindow, timelineQueryKey, timelineUrl } from "@shared/calendar-window";
import { collectMetrics, resolveWellnessSubject, belongsToSubject } from "@shared/wellness-readout";
import { getUserToday } from "@shared/timezone";
import {
  buildChatHome, type ChatHome as ChatHomeData, type HomeGlance, type HomeIcon, type HomeInsight,
  type HomeKpi, type HomeLine, type HomeList, type HomeTarget,
} from "@shared/chat-home";
import type { ChatSuggestion } from "@shared/chat-suggestions";
import { ChatSuggestions } from "./ChatSuggestions";
import { CHAT_APPS } from "./ChatComposer";
import { WORKSPACES, type WorkspaceKind } from "@/components/workspace/WorkspaceShell";

// ── Looks ────────────────────────────────────────────────────────────────────

const ICONS: Record<HomeIcon, LucideIcon> = {
  activity: Activity, sleep: Moon, heart: HeartPulse, weight: Scale, spending: Wallet, networth: BarChart3,
  tasks: CheckSquare, event: CalendarDays, bill: Receipt, document: FileText, workout: Dumbbell, water: Droplet,
  wellness: HeartPulse, finance: Coins, mindset: Brain, assets: Car,
};

/** One hue per kind of thing, as an HSL triple — the same hues the tabs use. */
const HUE: Record<HomeIcon, string> = {
  activity: "152 70% 50%", sleep: "262 85% 70%", heart: "350 85% 62%", weight: "200 95% 60%",
  spending: "38 95% 58%", networth: "152 70% 50%", tasks: "262 85% 70%", event: "190 92% 52%",
  bill: "43 95% 58%", document: "350 85% 62%", workout: "152 70% 50%", water: "200 95% 60%",
  wellness: "152 70% 50%", finance: "43 95% 58%", mindset: "262 85% 70%", assets: "200 95% 60%",
};

function greetingFor(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// ── Things to ask ────────────────────────────────────────────────────────────
// Whole requests, sent as typed. Refresh shows the next four.

interface AskCard { id: string; mode: string; icon: LucideIcon; hue: string; text: string }
const ASKS: AskCard[] = [
  { id: "focus", mode: "Focus", icon: Target, hue: "25 95% 60%", text: "Create a plan to improve my sleep and energy." },
  { id: "analyze", mode: "Analyze", icon: BarChart3, hue: "152 70% 50%", text: "Review my spending and find savings opportunities." },
  { id: "brainstorm", mode: "Brainstorm", icon: Lightbulb, hue: "48 95% 60%", text: "Give me 5 new income or project ideas." },
  { id: "plan", mode: "Plan", icon: CalendarDays, hue: "280 85% 70%", text: "Build my plan for the rest of this week." },
  { id: "review", mode: "Review", icon: Sparkles, hue: "190 92% 52%", text: "What needs my attention this week?" },
  { id: "money", mode: "Money", icon: Coins, hue: "43 95% 58%", text: "Show me my bills and payments for this month." },
  { id: "health", mode: "Health", icon: HeartPulse, hue: "350 85% 62%", text: "How has my health trended this month?" },
  { id: "reflect", mode: "Reflect", icon: NotebookPen, hue: "262 85% 70%", text: "Summarize my journal entries from this week." },
];

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * The home's figures, from the lists other screens already keep. `enabled`
 * is false once a conversation has started: nothing is fetched for a screen
 * that is not shown.
 */
export function useChatHome(enabled: boolean): { home: ChatHomeData; name: string | null; todayISO: string; retry: () => void } {
  const { mode, selectedIds: ids } = useProfileScope();
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const todayISO = getUserToday(BROWSER_TIMEZONE);
  const showTestData = useShowTestData();

  const list = <T,>(endpoint: string) => async (): Promise<T> => {
    const data = await apiRequest("GET", `${endpoint}${param}`).then((r) => r.json());
    return data as T;
  };
  const tasksQ = useQuery<any[]>({ queryKey: ["/api/tasks", mode, ...ids], queryFn: list("/api/tasks"), enabled, staleTime: 30_000 });
  const enhancedQ = useQuery<any>({ queryKey: ["/api/dashboard-enhanced", mode, ...ids], queryFn: list("/api/dashboard-enhanced"), enabled, staleTime: 30_000 });
  const trackersQ = useQuery<any[]>({ queryKey: ["/api/trackers", mode, ...ids], queryFn: list("/api/trackers"), enabled, staleTime: 60_000 });
  const window = useMemo(() => canonicalTimelineWindow(todayISO), [todayISO]);
  const timelineQ = useQuery<any[]>({
    queryKey: timelineQueryKey(window, mode, ids), enabled, staleTime: 60_000,
    queryFn: () => apiRequest("GET", timelineUrl(window, mode, ids)).then((r) => r.json()),
  });
  const journalQ = useQuery<any[]>({
    queryKey: ["/api/journal", mode, ...ids, "wellness"], enabled, staleTime: 60_000,
    queryFn: async () => {
      const data = await apiRequest("GET", `/api/journal${param}`).then((r) => r.json());
      if (!Array.isArray(data)) throw new Error("Unexpected response");
      return data;
    },
  });
  const { data: profilesLite } = useQuery<any[]>({
    queryKey: ["/api/profiles", "lite"], enabled, staleTime: 300_000,
    queryFn: () => apiRequest("GET", "/api/profiles/lite").then((r) => r.json()),
  });
  const [docSnoozeMap] = useDocSnoozeMap();
  const dismissed = useDismissedAlertIds(enabled);

  // Health is read for ONE person, never a blend (H10).
  const people = Array.isArray(profilesLite) ? profilesLite : [];
  const { subject, isSelf } = resolveWellnessSubject(people as any[], mode === "selected" ? ids : []);
  const subjectId = (subject as any)?.id ?? null;
  const trackers = Array.isArray(trackersQ.data) ? trackersQ.data : undefined;
  const myTrackers = useMemo(
    () => trackers?.filter((t: any) => belongsToSubject(t.linkedProfiles, subject, isSelf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackers, subjectId, isSelf],
  );
  const metrics = useMemo(() => (myTrackers ? collectMetrics(myTrackers as any, { timezone: BROWSER_TIMEZONE }) : undefined), [myTrackers]);
  const journal = Array.isArray(journalQ.data) ? journalQ.data : undefined;
  const myJournal = useMemo(
    () => journal?.filter((j: any) => belongsToSubject(j.linkedProfiles, subject, isSelf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [journal, subjectId, isSelf],
  );

  const home = useMemo(() => {
    const visible = (title: unknown, description?: unknown) => showTestData || (!isTestDataRow(title as any) && !isTestDataRow(description as any));
    const tasks = Array.isArray(tasksQ.data) ? tasksQ.data.filter((t: any) => visible(t?.title, t?.description)) : undefined;
    const timeline = Array.isArray(timelineQ.data) ? timelineQ.data : undefined;
    const eventsToday = timeline
      ?.filter((it: any) => it?.type === "event" && String(it?.date || "").slice(0, 10) === todayISO && visible(it?.title))
      .sort((a: any, b: any) => String(a.time || "99:99").localeCompare(String(b.time || "99:99")));
    const enhanced = enhancedQ.data;
    const expiring = enhanced
      ? groupDocumentDates((enhanced.expiringDocuments || []).filter((d: any) =>
        visible(d?.documentName) && !docSnoozeMap[d?.ruleId] && !docSnoozeMap[d?.documentId] && !isDateRowDismissed(d, dismissed)))
      : undefined;
    const failed = new Set<HomeList>();
    const mark = (k: HomeList, q: { isError: boolean; data: unknown }) => { if (q.isError && q.data === undefined) failed.add(k); };
    mark("tasks", tasksQ); mark("snapshot", enhancedQ); mark("trackers", trackersQ); mark("events", timelineQ); mark("journal", journalQ);
    return buildChatHome({
      todayISO, timezone: BROWSER_TIMEZONE, metrics, trackers: myTrackers,
      snapshot: enhanced ? enhanced.financeSnapshot ?? {} : undefined,
      tasks, eventsToday, expiring, journal: myJournal, failed,
    });
  }, [tasksQ.data, tasksQ.isError, timelineQ.data, timelineQ.isError, enhancedQ.data, enhancedQ.isError, trackersQ.isError,
    journalQ.isError, metrics, myTrackers, myJournal, docSnoozeMap, dismissed, showTestData, todayISO]);

  // Whoever holds the account, by first name. Chat is not scoped to a
  // profile, so this is never the selected person.
  const self = people.find((p: any) => p?.type === "self");
  const name = self?.name ? String(self.name).trim().split(/\s+/)[0] : null;
  const retry = () => { for (const q of [tasksQ, enhancedQ, trackersQ, timelineQ, journalQ]) if (q.isError) void q.refetch(); };
  return { home, name, todayISO, retry };
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function useGo(onPick: (text: string) => void) {
  return (t: HomeTarget) => { if (t.prompt != null) onPick(t.prompt); else if (t.href) hashNavigate(t.href); };
}

function SectionTitle({ icon: Icon, children, action }: { icon: LucideIcon; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2">
      <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
        <Icon className="h-[18px] w-[18px] text-primary" aria-hidden="true" /> {children}
      </h2>
      {action}
    </div>
  );
}

const MODE_TILE = "aurora-mode pressable shrink-0 min-w-[68px] px-2.5 py-2.5 rounded-2xl text-[11.5px] font-medium flex flex-col items-center justify-center gap-1.5";
const linkCls = "aurora-link inline-flex items-center gap-0.5 text-xs font-semibold";

function Delta({ d }: { d: NonNullable<HomeKpi["delta"]> }) {
  const tone = d.good == null ? "text-muted-foreground" : d.good ? "text-emerald-400" : "text-rose-400";
  const Arrow = d.dir === "up" ? ArrowUp : d.dir === "down" ? ArrowDown : null;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold tabular-nums ${tone}`}>
      {Arrow && <Arrow className="h-3 w-3" aria-hidden="true" />}{d.text}
    </span>
  );
}

function KpiTile({ k, go }: { k: HomeKpi; go: (t: HomeTarget) => void }) {
  const Icon = ICONS[k.icon];
  const quiet = k.state !== "ready";
  return (
    <button
      type="button"
      onClick={() => go(k)}
      className="aurora-tile pressable flex flex-col items-center text-center px-1.5 py-2.5 min-w-0"
      style={{ ["--accent-hsl" as any]: HUE[k.icon] }}
      data-testid={`home-kpi-${k.key}`}
      data-state={k.state}
    >
      <Icon className="h-5 w-5 mb-1" style={{ color: `hsl(${HUE[k.icon]})` }} aria-hidden="true" />
      <span className="text-[11px] font-medium text-muted-foreground leading-tight">{k.label}</span>
      <span className="text-[17px] font-bold leading-tight tabular-nums mt-0.5 whitespace-nowrap">
        {k.state === "loading" ? "…" : k.state === "error" ? "—" : k.value ?? "—"}
        {!quiet && k.value && k.unit && <span className="text-[11px] font-semibold text-muted-foreground ml-0.5">{k.unit}</span>}
      </span>
      <span className="min-h-[16px] mt-0.5 flex items-center justify-center text-[10.5px] text-muted-foreground leading-tight">
        {k.state === "untracked" ? "Not tracked" : k.state === "error" ? "Couldn't load" : k.delta ? <Delta d={k.delta} /> : k.note ?? ""}
      </span>
    </button>
  );
}

function SummaryLine({ l, go }: { l: HomeLine; go: (t: HomeTarget) => void }) {
  const Icon = l.icon === "activity" ? (l.tone === "good" ? TrendingUp : TrendingDown) : ICONS[l.icon];
  return (
    <button
      type="button"
      onClick={() => go(l)}
      className="aurora-line pressable w-full flex items-center gap-3 py-2 text-left"
      data-testid={`home-line-${l.key}`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" style={{ color: `hsl(${HUE[l.icon]})` }} aria-hidden="true" />
      <span className="flex-1 min-w-0 text-[13px] leading-snug">{l.text}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function InsightCard({ x, go }: { x: HomeInsight; go: (t: HomeTarget) => void }) {
  const Icon = ICONS[x.icon];
  return (
    <button
      type="button"
      onClick={() => go(x)}
      className="aurora-tile pressable snap-start shrink-0 w-[46%] sm:w-auto sm:shrink text-left p-3 flex flex-col gap-1.5"
      style={{ ["--accent-hsl" as any]: HUE[x.icon] }}
      data-testid={`home-insight-${x.key}`}
      data-state={x.state}
    >
      <span className="flex items-center gap-2 text-[13px] font-bold">
        <Icon className="h-[18px] w-[18px]" style={{ color: `hsl(${HUE[x.icon]})` }} aria-hidden="true" /> {x.title}
      </span>
      <span className={`text-[12.5px] leading-snug ${x.state === "ready" ? "" : "text-muted-foreground"}`}>{x.text}</span>
    </button>
  );
}

function GlanceChip({ g, go }: { g: HomeGlance; go: (t: HomeTarget) => void }) {
  const Icon = ICONS[g.icon];
  return (
    <button
      type="button"
      onClick={() => go(g)}
      className="aurora-tile pressable snap-start shrink-0 flex items-center gap-2.5 pl-2 pr-3.5 py-2 text-left"
      style={{ ["--accent-hsl" as any]: HUE[g.icon] }}
      data-testid={`home-glance-${g.key}`}
      data-state={g.state}
    >
      <span className="aurora-chip-icon" aria-hidden="true"><Icon className="h-4 w-4" /></span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-bold leading-tight whitespace-nowrap">{g.label}</span>
        <span className="block text-[11.5px] text-muted-foreground leading-tight whitespace-nowrap max-w-[11rem] truncate">{g.detail}</span>
        {g.progress != null && (
          <span className="block h-1 w-full min-w-[4.5rem] rounded-full bg-foreground/10 mt-1 overflow-hidden" aria-hidden="true">
            <span className="block h-full rounded-full" style={{ width: `${Math.round(g.progress * 100)}%`, background: `hsl(${HUE[g.icon]})` }} />
          </span>
        )}
      </span>
    </button>
  );
}

/** The sunrise beside the summary: drawn, so it costs no request. */
function Sunrise() {
  return (
    <svg className="aurora-sunrise hidden min-[400px]:block w-[30%] shrink-0 self-stretch" viewBox="0 0 120 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="sr-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="hsl(238 62% 14%)" /><stop offset="0.45" stopColor="hsl(262 55% 30%)" />
          <stop offset="0.72" stopColor="hsl(18 85% 52%)" /><stop offset="0.82" stopColor="hsl(40 100% 66%)" />
        </linearGradient>
        <radialGradient id="sr-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="hsl(48 100% 92%)" /><stop offset="0.22" stopColor="hsl(40 100% 70%)" />
          <stop offset="0.55" stopColor="hsl(22 100% 58% / 0.55)" /><stop offset="1" stopColor="hsl(22 100% 58% / 0)" />
        </radialGradient>
      </defs>
      <rect width="120" height="150" fill="url(#sr-sky)" />
      <circle cx="56" cy="104" r="46" fill="url(#sr-sun)" />
      <path d="M0 112 L18 96 L30 106 L48 84 L62 102 L78 90 L96 108 L120 94 V150 H0 Z" fill="hsl(250 45% 20%)" opacity="0.92" />
      <path d="M0 126 L22 112 L40 122 L60 108 L84 124 L102 114 L120 122 V150 H0 Z" fill="hsl(236 52% 11%)" />
      <path d="M0 138 Q30 128 60 136 T120 132 V150 H0 Z" fill="hsl(232 55% 8%)" />
    </svg>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

export interface ChatHomeViewProps {
  home: ChatHomeData;
  /** The account holder's first name. */
  name?: string | null;
  todayISO: string;
  suggestions: ChatSuggestion[];
  /** Put text in the chat box (the user finishes it). */
  onPick: (text: string) => void;
  /** Send a whole request now. */
  onSend: (text: string) => void;
  onRetry?: () => void;
  /** Open a full-screen workspace (Notes, Journal, Document, Fill In). */
  onOpenWorkspace?: (kind: WorkspaceKind) => void;
  /** Put the cursor in the chat box. */
  onFocusChat?: () => void;
  now?: Date;
}

/** Presentation only: everything it shows was decided by `buildChatHome`. */
export function ChatHomeView({ home, name, todayISO, suggestions, onPick, onSend, onRetry, onOpenWorkspace, onFocusChat, now = new Date() }: ChatHomeViewProps) {
  const go = useGo(onPick);
  const [askPage, setAskPage] = useState(0);
  const asks = [0, 1, 2, 3].map((n) => ASKS[(askPage * 4 + n) % ASKS.length]);
  const [y, m, d] = todayISO.split("-").map(Number);
  const dateLabel = new Date(y, (m || 1) - 1, d || 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const anyFailed = [...home.kpis, ...home.insights, ...home.glance].some((x) => x.state === "error");

  return (
    <div className="chat-home w-full space-y-4" data-testid="chat-home">
      {/* Greeting */}
      <header className="flex items-center gap-3">
        <span className="aurora-orb shrink-0" aria-hidden="true">
          <img src="/portol-logo-clean.png" alt="" className="w-9 h-9 object-contain" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-extrabold tracking-tight leading-tight" data-testid="home-greeting">
            {greetingFor(now)}{name ? `, ${name}` : ""}.
          </h1>
          <p className="text-[12.5px] text-muted-foreground leading-snug">Here's what I've found, what's coming up, and how you're doing.</p>
        </div>
        <button
          type="button"
          onClick={() => onSend("Give me my briefing for today.")}
          className="aurora-pill pressable shrink-0 inline-flex items-center gap-1.5 px-3 h-9 text-xs font-semibold"
          title="Ask Portol for today's briefing"
          data-testid="home-briefing"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI Briefing
        </button>
      </header>

      {/* Daily summary */}
      <section className="aurora-card overflow-hidden" data-testid="home-summary" aria-label="Your daily summary">
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" /> Your Daily Summary
          </h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Today, {dateLabel}
          </span>
        </div>
        <div className="flex items-stretch">
          <Sunrise />
          <div className="flex-1 min-w-0 px-4 pb-2 pt-1 divide-y divide-white/[0.07]">
            {home.lines.length > 0
              ? home.lines.map((l) => <SummaryLine key={l.key} l={l} go={go} />)
              : (
                <p className="py-4 text-[13px] text-muted-foreground" data-testid="home-summary-empty">
                  {home.kpis.some((k) => k.state === "loading") ? "Reading your records…" : "Nothing needs you right now. Tell me what happened today and I'll file it."}
                </p>
              )}
          </div>
        </div>
      </section>

      {/* Headline figures */}
      <section aria-label="Headline figures">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {home.kpis.map((k) => <KpiTile key={k.key} k={k} go={go} />)}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="home-kpi-caption">Health: last 7 days against the 7 before. Spending: this month against last.</p>
        {anyFailed && onRetry && (
          <button type="button" onClick={onRetry} className={`${linkCls} mt-2`} data-testid="home-retry">
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Some figures couldn't load. Try again
          </button>
        )}
      </section>

      {/* Insights */}
      <section aria-label="Insights">
        <SectionTitle
          icon={Brain}
          action={<button type="button" onClick={() => hashNavigate("/insights")} className={linkCls} data-testid="home-insights-all">See All <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>}
        >
          Insights &amp; Recommendations
        </SectionTitle>
        <div className="flex sm:grid sm:grid-cols-4 gap-2 overflow-x-auto no-scrollbar snap-x -mx-4 px-4 sm:mx-0 sm:px-0 pb-1" data-swipe-ignore>
          {home.insights.map((x) => <InsightCard key={x.key} x={x} go={go} />)}
        </div>
      </section>

      {/* Today */}
      <section aria-label="Today at a glance">
        <SectionTitle
          icon={CalendarDays}
          action={<button type="button" onClick={() => hashNavigate("/calendar")} className={linkCls} data-testid="home-calendar">View Calendar <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>}
        >
          Today at a Glance
        </SectionTitle>
        <div className="flex gap-2 overflow-x-auto no-scrollbar snap-x -mx-4 px-4 pb-1" data-swipe-ignore>
          {home.glance.map((g) => <GlanceChip key={g.key} g={g} go={go} />)}
        </div>
      </section>

      {/* Things to ask */}
      <section aria-label="Suggestions">
        <SectionTitle
          icon={Sparkles}
          action={<button type="button" onClick={() => setAskPage((p) => p + 1)} className={linkCls} data-testid="home-asks-refresh">Refresh <RefreshCw className="h-3.5 w-3.5 ml-0.5" aria-hidden="true" /></button>}
        >
          AI Suggestions for You
        </SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {asks.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSend(a.text)}
              className="aurora-ask pressable text-left flex flex-col justify-end p-3 min-h-[124px]"
              style={{ ["--accent-hsl" as any]: a.hue }}
              data-testid={`home-ask-${a.id}`}
            >
              <a.icon className="aurora-ask-art" aria-hidden="true" />
              <span className="relative flex items-center gap-1.5 text-[13px] font-bold">
                <a.icon className="h-4 w-4" style={{ color: `hsl(${a.hue})` }} aria-hidden="true" /> {a.mode}
              </span>
              <span className="relative flex items-end gap-1 mt-1">
                <span className="flex-1 text-[12.5px] leading-snug">{a.text}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Earned from the user's own records */}
      {suggestions.length > 0 && <ChatSuggestions suggestions={suggestions} onPick={onPick} now={now} bare />}

      {/* AI Modes. Chat is the box below; each of the others is its own tool. */}
      {onOpenWorkspace && (
        <section aria-label="AI modes" data-testid="chat-modes">
          <SectionTitle icon={Layers}>AI Modes <span className="text-xs font-medium text-muted-foreground">(Apps)</span></SectionTitle>
          <div className="flex items-stretch gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1" data-swipe-ignore>
            <button type="button" onClick={onFocusChat} aria-current="true" className={`${MODE_TILE} aurora-mode-active`} data-testid="button-mode-chat">
              <MessageCircle className="h-5 w-5" aria-hidden="true" /> Chat
            </button>
            {(Object.keys(WORKSPACES) as WorkspaceKind[]).map((kind) => {
              const { label, icon: Icon, blurb } = WORKSPACES[kind];
              return (
                <button key={kind} type="button" onClick={() => onOpenWorkspace(kind)} title={blurb} className={MODE_TILE} data-testid={`button-workspace-${kind}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" /> {label}
                </button>
              );
            })}
            {CHAT_APPS.map(({ id, label, icon: Icon, href, blurb }) => (
              <button key={id} type="button" onClick={() => hashNavigate(href)} title={blurb} className={MODE_TILE} data-testid={`button-app-${id}`}>
                <Icon className="h-5 w-5" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** The home, wired to the app's data. */
export function ChatHome(p: Pick<ChatHomeViewProps, "suggestions" | "onPick" | "onSend" | "onOpenWorkspace" | "onFocusChat">) {
  const { home, name, todayISO, retry } = useChatHome(true);
  return <ChatHomeView {...p} home={home} name={name} todayISO={todayISO} onRetry={retry} />;
}

export default ChatHome;
