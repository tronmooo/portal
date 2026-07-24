// ── Executive briefing (2026-07-24 de-duplication pass) ─────────────────────
// This board used to render 24 surfaces off 7 queries: 6 stat tiles, a Today
// strip, and 17 collapsible sections. The sections overlapped by construction —
// `upcomingTasks` was an unbounded superset of both Today's Agenda and High
// Priority, "Calendar · Next 14d" re-rendered Birthdays + Appointments +
// Important Dates wholesale, and the AI Executive Brief plus the Attention tile
// restated the tiles in prose and as a count. One high-priority task due today
// could appear five times on one screen.
//
// Now: 4 tiles + 5 sections, all read off buildBriefingModel(), which assigns
// every datum to exactly ONE bucket via a priority cascade. Tiles carry counts
// and one headline — they never list rows. Sections carry rows, each row type
// owned by exactly one section. Panels carry the full list plus actions, and
// every row opens one (rows no longer navigate away).
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, recoverWedgedQueries, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { ChevronDown } from "lucide-react";
import { PopupHost, usePanelRouter } from "@/components/dashboard/popups/PopupHost";
import { warmCommonPanels, type PanelId } from "@/components/dashboard/popups/registry";
import {
  buildBriefingModel, BUCKET_CAPS,
  type BriefingBucket, type BriefingItem,
} from "@/components/dashboard/useBriefingModel";
import type { DashboardStats } from "@shared/schema";

// One accent per surviving section. The old map had 17 entries for 17 sections.
const ACCENTS: Record<BriefingBucket | "tiles", string> = {
  attention: "0 72% 58%",    // red
  today:     "262 80% 66%",  // violet
  next14:    "239 84% 67%",  // indigo
  open:      "217 91% 65%",  // blue
  recent:    "240 10% 60%",  // stone
  tiles:     "155 65% 45%",
};

const SECTIONS: Array<{
  bucket: BriefingBucket; title: string; empty: string; testId: string;
  defaultOpen: boolean | "whenNonEmpty";
}> = [
  { bucket: "attention", title: "Needs Attention", empty: "Nothing needs your attention. 🎉", testId: "brief-attention", defaultOpen: true },
  { bucket: "today",     title: "Today",           empty: "Nothing scheduled today.",          testId: "brief-today",     defaultOpen: true },
  { bucket: "next14",    title: "Next 14 Days",    empty: "Nothing coming up.",                testId: "brief-next14",    defaultOpen: true },
  { bucket: "open",      title: "Open Work",       empty: "No open work.",                     testId: "brief-open",      defaultOpen: "whenNonEmpty" },
  { bucket: "recent",    title: "Recent",          empty: "No recent activity.",               testId: "brief-recent",    defaultOpen: false },
];

function Section({ accent, title, count, summary, children, defaultOpen = true, testId }: {
  accent: string; title: string; count?: number; summary?: string; children: React.ReactNode;
  defaultOpen?: boolean; testId: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="break-inside-avoid mb-2 rounded-lg border bg-card/40 px-2 pt-0.5 pb-1.5"
      style={{ borderColor: `hsl(${accent} / 0.25)` }}
      data-testid={testId}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 py-1.5 text-left group"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">{title}</span>
        {typeof count === "number" && count > 0 && (
          <span className="text-[10px] px-1.5 rounded-full" style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}>{count}</span>
        )}
        {summary && <span className="ml-auto mr-1 text-[10px] tabular-nums" style={{ color: `hsl(${accent})` }}>{summary}</span>}
        <ChevronDown className={`h-3 w-3 ${summary ? "" : "ml-auto"} text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && children}
    </div>
  );
}

/** Tiles carry a count and ONE headline. They never list rows — that was half
 *  the old redundancy (the Attention tile was a count of the section under it). */
function StatTile({ label, value, unit, sub, accent, onClick, testId, intentProps, prominent }: {
  label: string; value: string; unit?: string; sub?: string; accent: string;
  onClick: () => void; testId: string; prominent?: boolean;
  intentProps?: { onPointerDown: () => void; onTouchStart: () => void };
}) {
  return (
    <button
      onClick={onClick}
      {...intentProps}
      data-testid={testId}
      className="rounded-xl border px-2.5 py-2 text-left card-lift transition-all"
      style={{
        borderColor: `hsl(${accent} / ${prominent ? 0.55 : 0.30})`,
        background: `linear-gradient(135deg, hsl(${accent} / ${prominent ? 0.20 : 0.12}) 0%, hsl(var(--card)) 75%)`,
        ...(prominent ? { boxShadow: `0 0 16px hsl(${accent} / 0.18)` } : {}),
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-0.5 min-w-0">
        <span className={`metric-value ${prominent ? "text-2xl" : "text-xl"}`} style={{ color: `hsl(${accent})` }}>{value}</span>
        {unit && <span className="text-[11px] font-medium truncate" style={{ color: `hsl(${accent})` }}>{unit}</span>}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </button>
  );
}

function ItemRow({ item, onOpen, intentProps, showReason }: {
  item: BriefingItem; onOpen: () => void; showReason?: boolean;
  intentProps?: { onPointerDown: () => void; onTouchStart: () => void };
}) {
  const toneCls = item.tone === "pos" ? "text-emerald-500"
    : item.tone === "neg" ? "text-red-500"
    : item.tone === "warn" ? "text-amber-500" : "";
  return (
    <button
      onClick={onOpen}
      {...intentProps}
      data-testid={`brief-row-${item.key}`}
      className={`w-full flex items-baseline gap-2 py-[3px] px-1 text-left text-xs hover:bg-muted/40 rounded-sm ${
        item.severity === "critical" ? "text-red-500" : ""}`}
    >
      <span className="text-[10px] uppercase text-muted-foreground w-16 shrink-0 truncate">{item.when}</span>
      <span className={`flex-1 truncate ${item.done ? "line-through text-muted-foreground" : ""}`}>
        {item.title}
        {showReason && item.reason && <span className="text-muted-foreground"> — {item.reason}</span>}
      </span>
      {item.meta && <span className={`text-[11px] tabular-nums text-right shrink-0 ${toneCls}`}>{item.meta}</span>}
    </button>
  );
}

const Empty = ({ label }: { label: string }) => (
  <p className="text-[11px] text-muted-foreground py-0.5 px-1">{label}</p>
);

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced, ready = true }: {
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
  /** Gate for this component's own queries (PERF 2026-07-16): the dashboard
   * passes bootstrapSettled so these resolve from the bootstrap-seeded cache
   * instead of firing 7 network requests that race the bootstrap download on
   * weak mobile links. Defaults true so other callers are unaffected; the
   * dashboard's gate self-releases after 8s even if bootstrap hangs. */
  ready?: boolean;
}) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const mode = filterMode;
  const ids = filterIds;
  const scope = useMemo(() => ({ filterMode: mode, filterIds: ids }), [mode, ids.join(",")]);
  const panel = usePanelRouter(scope);

  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const amp = param ? "&" : "?";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
  const in45 = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

  // NOTE (BUG-20260715-everyone-zeros): none of these query functions may
  // swallow errors into a cached-as-success empty value (`.catch(() => [])`).
  // A transient failure — e.g. the pre-auth boot window racing token restore —
  // then renders as "0 in every category" for the whole staleTime window.
  // Letting the error propagate keeps react-query in error state (data stays
  // undefined → section shows empty NOW but refetches on mount/focus/switch).
  const { data: tasks = [], isPending: tasksPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habits = [], isPending: habitsPending } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  // 45-day window: Today + Next 14 Days + Open Work all slice from this one
  // fetch. Only `type: "event"` rows are consumed — see BriefingInput.timeline.
  const { data: timeline = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, in45, mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/calendar/timeline${param}${amp}start=${todayStr}&end=${in45}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Reminders are profile-scoped like every other briefing section — pass the
  // active filter so a selected profile shows only its own reminders (the
  // server enforces strict isolation; unlinked reminders appear only in the
  // unfiltered "Everyone" view). Keying on mode/ids makes switching profiles
  // refetch instead of showing another profile's cached reminders.
  const { data: reminders = [] } = useQuery<any[]>({
    queryKey: ["/api/reminders", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/reminders${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: goals = [], isPending: goalsPending } = useQuery<any[]>({
    queryKey: ["/api/goals", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/goals${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: journal = [] } = useQuery<any[]>({
    queryKey: ["/api/journal", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/journal${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: notifications = [] } = useQuery<any[]>({
    queryKey: ["/api/notifications", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/notifications${param}`).then(r => r.json()),
    staleTime: 60_000,
  });

  // STUCK-LOADING DEADLINE (2026-07-16): if any tile-feeding query is still
  // unresolved after 12s (wedged fetch, failed enhanced, cold instance), show
  // the Retry banner instead of letting "loading" tiles sit forever.
  const anyBriefPending = tasksPending || habitsPending || timelinePending || goalsPending || enhanced === undefined;
  const [briefStuck, setBriefStuck] = useState(false);
  useEffect(() => {
    if (!anyBriefPending) { setBriefStuck(false); return; }
    const t = setTimeout(() => setBriefStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [anyBriefPending]);

  // Warm the two most-opened panels once the board is interactive.
  useEffect(() => {
    if (!ready) return;
    return warmCommonPanels(qc, scope);
  }, [ready, qc, scope]);

  // Docs respect the shared 30-day dismisses (same map DocsBody uses) so a
  // dismissed alert disappears everywhere at once.
  const docSnooze = loadDocSnoozeMap();
  const allExpiringDocs = useMemo(
    () => (enhanced?.expiringDocuments || []).filter((d: any) => !docSnooze[d.documentId]),
    [enhanced?.expiringDocuments, docSnooze],
  );
  const bills = enhanced?.financeSnapshot?.upcomingBills || [];

  // ── The ONE derivation. Everything below reads off `model`. ────────────────
  const model = useMemo(() => buildBriefingModel({
    todayStr, nowMs: Date.now(),
    tasks, habits, timeline, reminders, goals, journal, notifications,
    bills, expiringDocs: allExpiringDocs, activity: stats?.recentActivity || [],
  }), [todayStr, tasks, habits, timeline, reminders, goals, journal, notifications,
       bills, allExpiringDocs, stats?.recentActivity]);

  const openItem = (item: BriefingItem) => {
    if (item.navTo) { navigate(item.navTo); return; }
    panel.open(item.panel as PanelId, item.sub, item.key);
  };

  const loadingTile = tasksPending || enhanced === undefined;

  return (
    <div data-testid="executive-briefing">
      {/* STUCK-LOADING BANNER (2026-07-16): a tile must never say "loading"
          forever. If any feeding query is still unresolved after 12s, surface
          a Retry that cancels wedged requests and refetches what's on screen. */}
      {briefStuck && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2" data-testid="brief-stuck-banner">
          <span className="text-xs text-muted-foreground">Some sections are taking too long to load.</span>
          <button
            className="text-xs font-medium text-primary hover:underline shrink-0"
            onClick={() => { setBriefStuck(false); void recoverWedgedQueries(); }}
            data-testid="brief-stuck-retry"
          >Retry</button>
        </div>
      )}

      {/* Four tiles, down from six. The Attention tile is gone (it counted the
          section directly below it) and Bills + Documents merged into
          Obligations — both are "a dated thing that costs you if ignored". */}
      <div className="grid grid-cols-2 gap-2 mb-2" data-testid="brief-stat-row">
        <StatTile label="Today" prominent
          value={loadingTile ? "…" : model.tiles.today.value}
          unit={loadingTile ? undefined : model.tiles.today.unit}
          sub={loadingTile ? "loading" : model.tiles.today.sub}
          accent={ACCENTS.today}
          onClick={() => panel.open("timeline")} intentProps={panel.intentProps("timeline")}
          testId="brief-stat-today" />
        <StatTile label="Tasks"
          value={tasksPending ? "…" : model.tiles.tasks.value}
          unit={tasksPending ? undefined : model.tiles.tasks.unit}
          sub={tasksPending ? "loading" : model.tiles.tasks.sub}
          accent={ACCENTS.open}
          onClick={() => panel.open("tasks")} intentProps={panel.intentProps("tasks")}
          testId="brief-stat-tasks" />
        <StatTile label="Obligations"
          value={loadingTile ? "…" : model.tiles.obligations.value}
          unit={loadingTile ? undefined : model.tiles.obligations.unit}
          sub={loadingTile ? "loading" : model.tiles.obligations.sub}
          accent={model.tiles.obligations.critical ? "0 72% 58%" : "48 96% 53%"}
          onClick={() => panel.open("obligations", "bills")} intentProps={panel.intentProps("obligations")}
          testId="brief-stat-obligations" />
        <StatTile label="Habits"
          value={habitsPending ? "…" : model.tiles.habits.value}
          unit={habitsPending ? undefined : model.tiles.habits.unit}
          sub={habitsPending ? "loading" : model.tiles.habits.sub}
          accent={ACCENTS.tiles}
          onClick={() => panel.open("habits")} intentProps={panel.intentProps("habits")}
          testId="brief-stat-habits" />
      </div>

      {/* Five sections, down from seventeen. Each row type has exactly one home
          here — the cascade in buildBriefingModel guarantees it. */}
      <div className="md:columns-2 xl:columns-3 gap-2">
        {SECTIONS.map(({ bucket, title, empty, testId, defaultOpen }) => {
          const rows = model.buckets[bucket];
          const shown = rows.slice(0, BUCKET_CAPS[bucket]);
          const overflow = rows.length - shown.length;
          const accent = bucket === "attention" && !model.hasCritical && rows.length > 0
            ? "43 96% 56%" : ACCENTS[bucket];
          return (
            <Section key={bucket} accent={accent} title={title} count={rows.length} testId={testId}
              summary={bucket === "today" && model.tiles.today.pct > 0 ? `${model.tiles.today.pct}% done` : undefined}
              defaultOpen={defaultOpen === "whenNonEmpty" ? rows.length > 0 : defaultOpen}>
              {rows.length === 0 ? <Empty label={empty} /> : (
                <div className="divide-y divide-border/30">
                  {shown.map(item => (
                    <ItemRow key={item.key} item={item} onOpen={() => openItem(item)}
                      intentProps={panel.intentProps(item.panel as PanelId)}
                      showReason={bucket === "attention"} />
                  ))}
                  {overflow > 0 && (
                    <button onClick={() => panel.open("attention")}
                      className="w-full text-left text-[11px] text-muted-foreground py-1 px-1 hover:bg-muted/40 rounded-sm"
                      data-testid={`${testId}-overflow`}>
                      +{overflow} more →
                    </button>
                  )}
                </div>
              )}
            </Section>
          );
        })}
      </div>

      {/* One mount point, lazily loaded, nothing rendered while closed. */}
      <PopupHost
        request={panel.request}
        onClose={panel.close}
        scope={scope}
        data={{
          todayStr,
          bills,
          docs: enhanced?.expiringDocuments || [],
          timeline,
          goals,
          notes: (journal || []).slice(0, 20),
          reminders,
          attention: model.buckets.attention.map(i => ({
            id: i.key, title: i.title, reason: i.reason || i.when,
            severity: i.severity, group: i.group,
            go: () => openItem(i),
          })),
        }}
      />
    </div>
  );
}
