// ── PopupHost — the single mount point for every dashboard panel ─────────────
// Two rules this file exists to enforce:
//
//  1. MOUNT ONLY WHEN OPEN. Panels used to be rendered unconditionally with an
//     `open={...}` prop, so their hooks, queries and mutations ran on every
//     dashboard render while closed. Nothing below renders until a panel is
//     actually requested.
//  2. ONE STATE ATOM. The ~12 scattered `useState<PopupKind>` hooks collapse
//     into one `PanelRequest`, mirrored into `?panel=` so the Android/iOS back
//     gesture closes the panel instead of leaving the dashboard.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PANELS, prefetchPanel, type PanelId, type PanelRequest, type PanelScope } from "./registry";

const TasksPanel = lazy(() => import("@/components/dashboard/TaskHabitPopups").then(m => ({ default: m.TasksPopup })));
const HabitsPanel = lazy(() => import("@/components/dashboard/TaskHabitPopups").then(m => ({ default: m.HabitsPopup })));
const ObligationsPanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.ObligationsPopup })));
const TimelinePanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.TimelinePopup })));
const GoalsPanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.GoalsPopup })));
const NotesPanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.NotesPopup })));
const RemindersPanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.RemindersPopup })));
const AttentionPanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.AttentionPopup })));
const TodayPanel = lazy(() => import("@/components/dashboard/BriefingPopups").then(m => ({ default: m.TodayOverviewPopup })));
const NetWorthPanel = lazy(() => import("@/components/dashboard/HeroKPIPopups").then(m => ({ default: m.NetWorthPopup })));
const CashFlowPanel = lazy(() => import("@/components/dashboard/HeroKPIPopups").then(m => ({ default: m.CashFlowPopup })));
const BudgetPanel = lazy(() => import("@/components/dashboard/HeroKPIPopups").then(m => ({ default: m.BudgetPopup })));

/** Rows the data-driven panels render. The Executive tab already holds all of
 *  it, so passing it down costs nothing and the panel paints immediately. */
export interface PanelData {
  todayStr: string;
  bills: any[];
  docs: any[];
  timeline: any[];
  goals: any[];
  notes: any[];
  reminders: any[];
  attention: Array<{ id: string; title: string; reason: string; severity: "critical" | "warning" | "info"; group: string; go?: () => void }>;
  monthlyIncome?: number;
  /** Today's Overview panel — the merged chronological view behind the board's
   *  full-width Today strip. */
  todayEntries: any[];
  todayTomorrow: any[];
  todayCompletedTasks: number;
  todayAlerts: string[];
}

const EMPTY_DATA: PanelData = {
  todayStr: "", bills: [], docs: [], timeline: [], goals: [], notes: [], reminders: [], attention: [],
  todayEntries: [], todayTomorrow: [], todayCompletedTasks: 0, todayAlerts: [],
};

export function PopupHost({ request, onClose, scope, data }: {
  request: PanelRequest | null;
  onClose: () => void;
  scope: PanelScope;
  data?: Partial<PanelData>;
}) {
  if (!request) return null;
  const d = { ...EMPTY_DATA, ...data };
  const { id, sub } = request;
  const mode = scope.filterMode as "all" | "selected" | "everyone";

  // No fallback UI: the chunk is prefetched on pointerdown, so by the time a
  // click resolves it is almost always resident. Rendering a skeleton dialog
  // for the rare cold case would flash a frame of empty chrome — worse than
  // the dialog appearing a beat later.
  return (
    <Suspense fallback={null}>
      {id === "tasks" && <TasksPanel open onClose={onClose} filterMode={scope.filterMode} filterIds={scope.filterIds} />}
      {id === "habits" && <HabitsPanel open onClose={onClose} filterMode={scope.filterMode} filterIds={scope.filterIds} />}
      {id === "obligations" && <ObligationsPanel open onClose={onClose} bills={d.bills} docs={d.docs} sub={sub} />}
      {id === "timeline" && <TimelinePanel open onClose={onClose} items={d.timeline} todayStr={d.todayStr} sub={sub} />}
      {id === "goals" && <GoalsPanel open onClose={onClose} goals={d.goals} />}
      {id === "notes" && <NotesPanel open onClose={onClose} notes={d.notes} />}
      {id === "reminders" && <RemindersPanel open onClose={onClose} reminders={d.reminders} />}
      {id === "attention" && <AttentionPanel open onClose={onClose} items={d.attention} />}
      {id === "today" && <TodayPanel open onClose={onClose} entries={d.todayEntries} tomorrow={d.todayTomorrow}
        completedTasks={d.todayCompletedTasks} alerts={d.todayAlerts} />}
      {id === "networth" && <NetWorthPanel open onOpenChange={(o: boolean) => { if (!o) onClose(); }} filterMode={mode} filterIds={scope.filterIds} />}
      {id === "cashflow" && <CashFlowPanel open onOpenChange={(o: boolean) => { if (!o) onClose(); }} filterMode={mode} filterIds={scope.filterIds} />}
      {id === "budget" && <BudgetPanel open onOpenChange={(o: boolean) => { if (!o) onClose(); }} filterMode={mode} filterIds={scope.filterIds} monthlyIncome={d.monthlyIncome ?? 0} />}
    </Suspense>
  );
}

const PANEL_IDS = Object.keys(PANELS) as PanelId[];

/** Owns the single panel-request atom and keeps it in sync with `?panel=`.
 *  Returns everything a tile or row needs: `open` to show a panel, and
 *  `intentProps` to spread onto the trigger so it prefetches on pointerdown. */
export function usePanelRouter(scope: PanelScope) {
  const qc = useQueryClient();
  const [request, setRequest] = useState<PanelRequest | null>(() => readPanelFromUrl());

  const open = useCallback((id: PanelId, sub?: string, focus?: string) => {
    setRequest({ id, sub, focus });
    writePanelToUrl({ id, sub, focus });
  }, []);

  const close = useCallback(() => {
    setRequest(null);
    clearPanelFromUrl();
  }, []);

  // Back gesture / browser back pops the history entry the open pushed.
  useEffect(() => {
    const onPop = () => setRequest(readPanelFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** Spread onto any tile/row that opens `id`. Warms chunk + queries on press,
   *  which lands ~80–120 ms before the click on touch devices. */
  const intentProps = useCallback((id: PanelId) => {
    const warm = () => prefetchPanel(id, qc, scope);
    return { onPointerDown: warm, onTouchStart: warm };
  }, [qc, scope.filterMode, scope.filterIds.join(",")]);

  return useMemo(() => ({ request, open, close, intentProps }), [request, open, close, intentProps]);
}

function readPanelFromUrl(): PanelRequest | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const id = params.get("panel");
  if (!id || !PANEL_IDS.includes(id as PanelId)) return null;
  return { id: id as PanelId, sub: params.get("sub") || undefined, focus: params.get("focus") || undefined };
}

function writePanelToUrl(req: PanelRequest): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("panel", req.id);
  if (req.sub) url.searchParams.set("sub", req.sub); else url.searchParams.delete("sub");
  if (req.focus) url.searchParams.set("focus", req.focus); else url.searchParams.delete("focus");
  // pushState (not replace) so back closes the panel rather than leaving the page.
  window.history.pushState({ panel: req.id }, "", url.toString());
}

function clearPanelFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("panel")) return;
  url.searchParams.delete("panel");
  url.searchParams.delete("sub");
  url.searchParams.delete("focus");
  window.history.replaceState({}, "", url.toString());
}
