// ── Executive briefing — eight blocks (2026-07-25) ──────────────────────────
// Render order, each absorbing what it replaces:
//
//   1 Pulse            NOT RENDERED HERE — components/hub/HubKpiStrip.tsx is
//                      block 1. The hub shell already pins net worth / cash
//                      flow / wellness / streak above every tab, so a second
//                      strip on the board showed the same four numbers twice.
//   2 Needs Attention  the only red on screen · hides at zero
//   3 Today            merged timeline + progress bar + one synthesis line
//   4 Next 14 Days     collapsed count row, expands on tap
//   5 Money            near-term view · hides at zero
//   6 Habits & Trackers streaks + one-tap logging · hides at zero
//   7 Open Projects    hides at zero
//   8 Quick Capture    always present, bottom — last thing the thumb reaches
//
// Cut, not moved: Notifications (the bell owns it), Recently Added (⌘K owns
// it), the six-tile KPI grid (Pulse owns it), the standalone AI Executive Brief
// (one line inside Today), Document Expirations as its own card (splits into
// blocks 2 and 4).
//
// Which datum lands in which block is decided ONCE, by the priority cascade in
// useBriefingModel — nothing here re-filters. Empty hide-at-zero blocks roll up
// into a single grey "All clear" line directly above Quick Capture.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, recoverWedgedQueries, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { PopupHost, usePanelRouter } from "@/components/dashboard/popups/PopupHost";
import { warmCommonPanels, type PanelId } from "@/components/dashboard/popups/registry";
import {
  buildBriefingModel, BUCKET_CAPS, BLOCK_LABELS,
  type BriefingBucket, type BriefingItem, type BriefingModel,
} from "@/components/dashboard/useBriefingModel";
import type { DashboardStats } from "@shared/schema";

const ACCENTS: Record<BriefingBucket | "pulse" | "capture", string> = {
  attention: "0 72% 58%",    // red — the ONLY red on the board
  today:     "262 80% 66%",  // violet
  next14:    "239 84% 67%",  // indigo
  money:     "43 85% 52%",   // amber
  habits:    "155 65% 45%",  // emerald
  projects:  "142 70% 45%",  // green
  pulse:     "199 89% 60%",  // sky
  capture:   "240 10% 60%",  // stone
};

const money = (n: number) => {
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${abs.toLocaleString()}`;
};

function Block({ accent, title, count, summary, children, defaultOpen = true, testId, collapsedLabel }: {
  accent: string; title: string; count?: number; summary?: string; children: React.ReactNode;
  defaultOpen?: boolean; testId: string;
  /** When set, the collapsed state shows this instead of nothing (block 4). */
  collapsedLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-2 rounded-lg border bg-card/40 px-2 pt-0.5 pb-1.5"
      style={{ borderColor: `hsl(${accent} / 0.25)` }} data-testid={testId}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 py-1.5 text-left group" aria-expanded={open}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">{title}</span>
        {typeof count === "number" && count > 0 && (
          <span className="text-[10px] px-1.5 rounded-full" style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}>{count}</span>
        )}
        {!open && collapsedLabel && (
          <span className="ml-1 text-[11px] text-muted-foreground truncate">{collapsedLabel}</span>
        )}
        {summary && <span className="ml-auto mr-1 text-[10px] tabular-nums" style={{ color: `hsl(${accent})` }}>{summary}</span>}
        {open
          ? <ChevronDown className={`h-3 w-3 ${summary ? "" : "ml-auto"} text-muted-foreground`} />
          : <ChevronRight className={`h-3 w-3 ${summary ? "" : "ml-auto"} text-muted-foreground`} />}
      </button>
      {open && children}
    </div>
  );
}

function ItemRow({ item, onOpen, intent, showReason, onToggle, toggling }: {
  item: BriefingItem; onOpen: () => void; showReason?: boolean;
  intent?: { onPointerDown: () => void; onTouchStart: () => void };
  /** Habits and trackers log in place — no popup, no navigation. */
  onToggle?: () => void; toggling?: boolean;
}) {
  const toneCls = item.tone === "pos" ? "text-emerald-500"
    : item.tone === "neg" ? "text-red-500"
    : item.tone === "warn" ? "text-amber-500" : "";
  return (
    <div className="flex items-center gap-1">
      <button onClick={onOpen} {...intent} data-testid={`brief-row-${item.key}`}
        className={`flex-1 min-w-0 flex items-baseline gap-2 py-[3px] px-1 text-left text-xs hover:bg-muted/40 rounded-sm ${
          item.severity === "critical" ? "text-red-500" : ""}`}>
        <span className="text-[10px] uppercase text-muted-foreground w-14 shrink-0 truncate">{item.when}</span>
        <span className={`flex-1 truncate ${item.done ? "line-through text-muted-foreground" : ""}`}>
          {item.title}
          {showReason && item.reason && <span className="text-muted-foreground"> — {item.reason}</span>}
        </span>
        {item.meta && <span className={`text-[11px] tabular-nums text-right shrink-0 ${toneCls}`}>{item.meta}</span>}
      </button>
      {onToggle && (
        <button onClick={onToggle} disabled={toggling} data-testid={`brief-log-${item.key}`}
          aria-label={item.done ? `Undo ${item.title}` : `Log ${item.title}`}
          className={`shrink-0 h-5 w-5 rounded border text-[11px] leading-none flex items-center justify-center transition-colors disabled:opacity-40 ${
            item.done ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-500" : "border-border hover:bg-muted"}`}>
          {item.done ? "✓" : "+"}
        </button>
      )}
    </div>
  );
}

const Empty = ({ label }: { label: string }) => (
  <p className="text-[11px] text-muted-foreground py-0.5 px-1">{label}</p>
);

// ── Block 8 — Quick Capture ─────────────────────────────────────────────────
// Always present, always last. Capture is the thing your thumb reaches for, so
// it sits where the thumb already is.
function QuickCapture({ filterIds }: { filterIds: string[] }) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const save = useMutation({
    mutationFn: async (content: string) => {
      await apiRequest("POST", "/api/journal", {
        content,
        date: new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE }),
        ...(filterIds.length === 1 ? { linkedProfiles: filterIds } : {}),
      });
    },
    onSuccess: () => { setText(""); toast({ title: "Captured" }); invalidateDomain("journal"); },
    onError: (e: any) => toast({ title: "Couldn't save", description: e?.message, variant: "destructive" }),
  });
  const submit = () => { const t = text.trim(); if (t && !save.isPending) save.mutate(t); };
  return (
    <div className="mt-2 mb-1 rounded-lg border bg-card/40 px-2 py-1.5"
      style={{ borderColor: `hsl(${ACCENTS.capture} / 0.25)` }} data-testid="block-capture">
      <div className="flex items-center gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Capture a note…"
          aria-label="Quick capture"
          data-testid="capture-input"
          className="flex-1 min-w-0 h-8 px-2 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground"
        />
        <button onClick={submit} disabled={!text.trim() || save.isPending} data-testid="capture-save"
          className="shrink-0 h-8 px-2.5 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1 hover:bg-muted disabled:opacity-40">
          <Plus className="h-3 w-3" />Save
        </button>
      </div>
    </div>
  );
}

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced, ready = true }: {
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
  /** Gate for this component's own queries (PERF 2026-07-16): the dashboard
   * passes bootstrapSettled so these resolve from the bootstrap-seeded cache
   * instead of firing network requests that race the bootstrap download on
   * weak mobile links. Defaults true so other callers are unaffected; the
   * dashboard's gate self-releases after 8s even if bootstrap hangs. */
  ready?: boolean;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
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
  // undefined → block shows empty NOW but refetches on mount/focus/switch).
  const list = (path: string, staleTime = 30_000) => ({
    queryKey: [path, mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `${path}${param}`).then((r: Response) => r.json()),
    staleTime,
  });
  const { data: tasks = [], isPending: tasksPending } = useQuery<any[]>(list("/api/tasks"));
  const { data: habits = [], isPending: habitsPending } = useQuery<any[]>(list("/api/habits"));
  const { data: reminders = [] } = useQuery<any[]>(list("/api/reminders", 60_000));
  const { data: goals = [] } = useQuery<any[]>(list("/api/goals", 60_000));
  const { data: trackers = [] } = useQuery<any[]>(list("/api/trackers", 60_000));
  const { data: incomes = [] } = useQuery<any[]>(list("/api/incomes", 60_000));
  // 45-day window: Today and Next 14 Days both slice from this one fetch. Only
  // `type: "event"` rows are consumed — see BriefingInput.timeline.
  const { data: timeline = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, in45, mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/calendar/timeline${param}${amp}start=${todayStr}&end=${in45}`).then(r => r.json()),
    staleTime: 60_000,
  });

  // STUCK-LOADING DEADLINE (2026-07-16): if any feeding query is still
  // unresolved after 12s (wedged fetch, failed enhanced, cold instance), show
  // the Retry banner instead of letting "loading" cells sit forever.
  const anyPending = tasksPending || habitsPending || timelinePending || enhanced === undefined;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!anyPending) { setStuck(false); return; }
    const t = setTimeout(() => setStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [anyPending]);

  useEffect(() => {
    if (!ready) return;
    return warmCommonPanels(qc, scope);
  }, [ready, qc, scope]);

  // One-tap habit check-in (block 3) and tracker log (block 6). Optimistic so
  // the row flips on the frame of the tap, not after the round-trip.
  const [pendingLog, setPendingLog] = useState<string | null>(null);
  const checkinHabit = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", `/api/habits/${id}/checkin`, { date: todayStr }).then(r => r.json()),
    onMutate: async (id: string) => {
      setPendingLog(`habit:${id}`);
      const key = ["/api/habits", mode, ...ids];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<any[]>(key);
      qc.setQueryData<any[]>(key, (old) => (old || []).map((h: any) =>
        h.id === id ? { ...h, checkins: [...(h.checkins || []), { id: `tmp-${Date.now()}`, date: todayStr }] } : h));
      return { prev, key };
    },
    onSuccess: (serverHabit: any, id: string) => {
      // Swap the optimistic "tmp-" check-in for the server's real row so an
      // immediate un-check has a real id to delete.
      if (!serverHabit || !Array.isArray(serverHabit.checkins)) return;
      qc.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === id ? { ...h, ...serverHabit } : h));
    },
    onError: (e: any, _id, ctx: any) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast({ title: "Couldn't check in", description: e?.message, variant: "destructive" });
    },
    onSettled: () => { setPendingLog(null); invalidateDomain("habits"); },
  });
  // Tapping the ✓ on a habit that is already done used to be wired to a no-op,
  // so the row could be completed but never undone from the board. Un-check it
  // for real — same semantics as the Habits popup (clear today's check-ins).
  const uncheckHabit = useMutation({
    mutationFn: async ({ id, checkinIds }: { id: string; checkinIds: string[] }) => {
      for (const cid of checkinIds) {
        try {
          await apiRequest("DELETE", `/api/habits/${id}/checkin/${cid}`);
        } catch (e: any) {
          // 404 = already gone; the desired state holds, so not an error.
          if (!String(e?.message || "").startsWith("404")) throw e;
        }
      }
    },
    onMutate: async ({ id }) => {
      setPendingLog(`habit:${id}`);
      const key = ["/api/habits", mode, ...ids];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<any[]>(key);
      qc.setQueryData<any[]>(key, (old) => (old || []).map((h: any) =>
        h.id === id ? { ...h, checkins: (h.checkins || []).filter((c: any) => c.date !== todayStr) } : h));
      return { prev, key };
    },
    onError: (e: any, _v, ctx: any) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast({ title: "Couldn't undo check-in", description: e?.message, variant: "destructive" });
    },
    onSettled: () => { setPendingLog(null); invalidateDomain("habits"); },
  });
  const toggleHabitRow = (item: BriefingItem) => {
    const h = item.raw || {};
    const checkinIds = (h.checkins || [])
      .filter((c: any) => String(c.date).slice(0, 10) === todayStr)
      .map((c: any) => c.id)
      .filter(Boolean);
    if (item.done) uncheckHabit.mutate({ id: item.id, checkinIds });
    else checkinHabit.mutate(item.id);
  };
  const logTracker = useMutation({
    mutationFn: async (t: any) => {
      const field = (t.fields || []).find((f: any) => f?.type === "number" || f?.type === "integer" || f?.type === "decimal")
        || (t.fields || [])[0];
      if (!field) throw new Error("This tracker has no fields to log");
      // One tap logs a single unit against the primary field; anything richer
      // belongs in the tracker's own surface, not on the board.
      await apiRequest("POST", `/api/trackers/${t.id}/entries`, { values: { [field.name]: 1 } });
    },
    onMutate: (t: any) => { setPendingLog(`tracker:${t.id}`); },
    onSuccess: () => toast({ title: "Logged" }),
    onError: (e: any) => toast({ title: "Couldn't log", description: e?.message, variant: "destructive" }),
    onSettled: () => { setPendingLog(null); invalidateDomain("trackers"); },
  });

  // Docs respect the shared 30-day dismisses (same map the Obligations panel
  // uses) so a dismissed alert disappears everywhere at once.
  const docSnooze = loadDocSnoozeMap();
  const allExpiringDocs = useMemo(
    () => (enhanced?.expiringDocuments || []).filter((d: any) => !docSnooze[d.documentId]),
    [enhanced?.expiringDocuments, docSnooze],
  );
  const bills = enhanced?.financeSnapshot?.upcomingBills || [];
  const monthlyIncome = useMemo(
    () => (Array.isArray(incomes) ? incomes : []).reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0),
    [incomes],
  );

  // ── The ONE derivation. Every block below reads off `model`. ───────────────
  const model = useMemo(() => buildBriefingModel({
    todayStr, nowMs: Date.now(),
    tasks, habits, timeline, reminders, goals, trackers,
    bills, expiringDocs: allExpiringDocs,
    finance: {
      // Net worth totals come from the SERVER snapshot, never a client re-walk
      // — see docs/dashboard-scope-contract.md.
      assets: enhanced?.financeSnapshot?.totalAssetValue ?? 0,
      liabilities: enhanced?.financeSnapshot?.totalLiabilities ?? 0,
      monthlyIncome,
      monthlySpend: enhanced?.financeSnapshot?.totalMonthlySpend ?? stats?.monthlySpend ?? 0,
      monthlyObligations: enhanced?.financeSnapshot?.monthlyObligationTotal ?? 0,
    },
    streaks: stats?.streaks || [],
    journalStreak: stats?.journalStreak || 0,
  }), [todayStr, tasks, habits, timeline, reminders, goals, trackers, bills,
       allExpiringDocs, enhanced?.financeSnapshot, monthlyIncome, stats?.streaks,
       stats?.journalStreak, stats?.monthlySpend]);

  const openItem = (item: BriefingItem) => panel.open(item.panel as PanelId, item.sub, item.key);
  const rowIntent = (id: PanelId) => panel.intentProps(id);

  const rows = (bucket: BriefingBucket, opts?: { showReason?: boolean; loggable?: boolean }) => {
    const all = model.buckets[bucket];
    const shown = all.slice(0, BUCKET_CAPS[bucket]);
    const overflow = all.length - shown.length;
    return (
      <div className="divide-y divide-border/30">
        {shown.map(item => (
          <ItemRow key={item.key} item={item} onOpen={() => openItem(item)}
            intent={rowIntent(item.panel as PanelId)} showReason={opts?.showReason}
            onToggle={
              opts?.loggable && item.kind === "habit"
                ? () => toggleHabitRow(item)
                : opts?.loggable && item.kind === "tracker" ? () => logTracker.mutate(item.raw)
                : undefined
            }
            toggling={pendingLog === item.key} />
        ))}
        {overflow > 0 && (
          <button onClick={() => panel.open(shown[0]?.panel as PanelId || "tasks")}
            data-testid={`brief-${bucket}-overflow`}
            className="w-full text-left text-[11px] text-muted-foreground py-1 px-1 hover:bg-muted/40 rounded-sm">
            +{overflow} more →
          </button>
        )}
      </div>
    );
  };

  return (
    <div data-testid="executive-briefing">
      {stuck && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2" data-testid="brief-stuck-banner">
          <span className="text-xs text-muted-foreground">Some blocks are taking too long to load.</span>
          <button className="text-xs font-medium text-primary hover:underline shrink-0"
            onClick={() => { setStuck(false); void recoverWedgedQueries(); }}
            data-testid="brief-stuck-retry">Retry</button>
        </div>
      )}

      {/* 2 — NEEDS ATTENTION. Hides at zero. The only red on screen. */}
      {model.counts.attention > 0 && (
        <Block accent={ACCENTS.attention} title={BLOCK_LABELS.attention}
          count={model.counts.attention} testId="block-attention">
          {rows("attention", { showReason: true })}
        </Block>
      )}

      {/* 3 — TODAY. Always renders. Progress bar + the one synthesis line that
          the standalone AI Executive Brief collapsed into. */}
      <Block accent={ACCENTS.today} title={BLOCK_LABELS.today} count={model.counts.today}
        summary={model.todayTotal > 0 ? `${model.todayPct}%` : undefined} testId="block-today">
        <p className="text-[11px] px-1 pb-1 leading-snug" style={{ color: `hsl(${ACCENTS.today})` }}
          data-testid="today-synthesis">✦ {model.synthesis}</p>
        {model.todayTotal > 0 && (
          <div className="mx-1 mb-1.5 h-1 rounded-full bg-muted overflow-hidden" data-testid="today-progress">
            <div className="h-full rounded-full transition-all"
              style={{ width: `${model.todayPct}%`, background: `hsl(${ACCENTS.today})` }} />
          </div>
        )}
        {model.counts.today === 0
          ? <Empty label="Nothing scheduled today." />
          : rows("today", { loggable: true })}
      </Block>

      {/* 4 — NEXT 14 DAYS. Collapsed count row; expands on tap. */}
      <Block accent={ACCENTS.next14} title={BLOCK_LABELS.next14} count={model.counts.next14}
        defaultOpen={false} testId="block-next14"
        collapsedLabel={model.counts.next14 === 0 ? "nothing coming up" : `${model.counts.next14} coming up`}>
        {model.counts.next14 === 0 ? <Empty label="Nothing in the next two weeks." /> : rows("next14")}
      </Block>

      {/* 5 — MONEY. Near-term only, not a Finance tab replacement. Hides at zero. */}
      {model.counts.money > 0 && (
        <Block accent={ACCENTS.money} title={BLOCK_LABELS.money} count={model.counts.money}
          summary={money(model.money.billsTotal)} testId="block-money">
          {rows("money")}
          <div className="mt-1 pt-1 border-t border-border/30 px-1 space-y-0.5">
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="text-muted-foreground">Cash flow</span>
              <span className={`tabular-nums font-medium ${model.money.cashFlow < 0 ? "text-red-500" : "text-emerald-500"}`}>
                {money(model.money.monthlyIn)} in · {money(model.money.monthlyOut)} out
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">{model.money.balanceLine}</p>
          </div>
        </Block>
      )}

      {/* 6 — HABITS & TRACKERS. Streak chips are aggregates over the habit rows
          in Today, not copies of them; trackers are the one-tap log surface. */}
      {(model.habits.total > 0 || model.counts.habits > 0) && (
        <Block accent={ACCENTS.habits} title={BLOCK_LABELS.habits}
          count={model.habits.total + model.counts.habits}
          summary={model.habits.total > 0 ? `${model.habits.doneToday}/${model.habits.total}` : undefined}
          testId="block-habits">
          {model.habits.streaks.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1 pb-1" data-testid="habit-streaks">
              {model.habits.streaks.map(s => (
                <span key={s.id} data-testid={`streak-${s.id}`}
                  className={`text-[10px] px-1.5 py-px rounded-full border ${
                    s.doneToday ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-border text-muted-foreground"}`}>
                  {s.name}{s.days > 0 ? ` · ${s.days}🔥` : ""}
                </span>
              ))}
            </div>
          )}
          {model.counts.habits > 0 && rows("habits", { loggable: true })}
        </Block>
      )}

      {/* 7 — OPEN PROJECTS. Hides at zero. */}
      {model.counts.projects > 0 && (
        <Block accent={ACCENTS.projects} title={BLOCK_LABELS.projects}
          count={model.counts.projects} testId="block-projects">
          {rows("projects")}
        </Block>
      )}

      {/* Empty hide-at-zero blocks roll up into one grey line. */}
      {model.allClear.length > 0 && (
        <p className="px-1 py-1 text-[11px] text-muted-foreground" data-testid="all-clear">
          All clear · {model.allClear.join(" · ")}
        </p>
      )}

      {/* 8 — QUICK CAPTURE. Always present, always last. */}
      <QuickCapture filterIds={ids} />

      {/* One mount point, lazily loaded, nothing rendered while closed. */}
      <PopupHost
        request={panel.request} onClose={panel.close} scope={scope}
        data={{
          todayStr, bills,
          docs: enhanced?.expiringDocuments || [],
          timeline, goals,
          notes: [],
          reminders,
          monthlyIncome,
          attention: model.buckets.attention.map(i => ({
            id: i.key, title: i.title, reason: i.reason || i.when,
            severity: i.severity, group: i.group, go: () => openItem(i),
          })),
        }}
      />
    </div>
  );
}
