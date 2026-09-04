// ─── Lazily-loaded dashboard overlays ────────────────────────────────────────
// PERF (first paint): the dashboard renders ~8 popups/dialogs unconditionally
// with an `open={false}` prop. Even closed, their code — the hero KPI popups,
// the cash-flow waterfall, the task/habit sheets, quick-add, the drill-downs —
// was statically imported by pages/dashboard.tsx, which pulled recharts (~430 KB
// raw), @shared/schema and the recurrence rules into the dashboard chunk. Every
// cold open paid for all of it before a single number appeared on screen.
//
// These wrappers keep the exact same prop API and the exact same rendered
// output, but nothing is fetched until the overlay is opened for the first
// time. After that it stays mounted, so Radix's close animation still runs and
// reopening never re-suspends.
import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";

const NetWorthPopupImpl = lazy(() =>
  import("@/components/dashboard/HeroKPIPopups").then((m) => ({ default: m.NetWorthPopup })));
const BudgetPopupImpl = lazy(() =>
  import("@/components/dashboard/HeroKPIPopups").then((m) => ({ default: m.BudgetPopup })));
const CashFlowViewImpl = lazy(() =>
  import("@/components/finance/CashFlowView").then((m) => ({ default: m.CashFlowView })));
const TasksPopupImpl = lazy(() =>
  import("@/components/dashboard/TaskHabitPopups").then((m) => ({ default: m.TasksPopup })));
const HabitsPopupImpl = lazy(() =>
  import("@/components/dashboard/TaskHabitPopups").then((m) => ({ default: m.HabitsPopup })));
const QuickAddDialogImpl = lazy(() =>
  import("@/components/dashboard/quick-add/QuickAddDialog").then((m) => ({ default: m.QuickAddDialog })));
const ChatGPTImportDialogImpl = lazy(() =>
  import("@/components/ChatGPTImportDialog").then((m) => ({ default: m.ChatGPTImportDialog })));
const DrillDownDialogImpl = lazy(() =>
  import("@/components/DrillDownDialog").then((m) => ({ default: m.DrillDownDialog })));
const BillsPopupImpl = lazy(() =>
  import("@/components/dashboard/BriefingPopups").then((m) => ({ default: m.BillsPopup })));
const EventsPopupImpl = lazy(() =>
  import("@/components/dashboard/BriefingPopups").then((m) => ({ default: m.EventsPopup })));
const DocsPopupImpl = lazy(() =>
  import("@/components/dashboard/BriefingPopups").then((m) => ({ default: m.DocsPopup })));
const WellnessPopupImpl = lazy(() =>
  import("@/components/wellness/WellnessPopups").then((m) => ({ default: m.WellnessPopup })));

/** True once `open` has been true at least once. */
function useEverOpened(open: boolean): boolean {
  const [ever, setEver] = useState(open);
  useEffect(() => {
    if (open) setEver(true);
  }, [open]);
  return ever || open;
}

/**
 * Wrap a lazy overlay so its chunk is requested only after the first open.
 * The returned component has the same props as the wrapped one (which must
 * include `open`).
 */
function gated<P extends { open: boolean }>(Impl: React.ComponentType<P>) {
  return function GatedOverlay(props: P) {
    const mounted = useEverOpened(props.open);
    if (!mounted) return null;
    return (
      <Suspense fallback={null}>
        <Impl {...props} />
      </Suspense>
    );
  };
}

type HeroKPIPopups = typeof import("@/components/dashboard/HeroKPIPopups");
type TaskHabitPopups = typeof import("@/components/dashboard/TaskHabitPopups");
type QuickAdd = typeof import("@/components/dashboard/quick-add/QuickAddDialog");
type CashFlow = typeof import("@/components/finance/CashFlowView");
type ChatGPTImport = typeof import("@/components/ChatGPTImportDialog");
type DrillDown = typeof import("@/components/DrillDownDialog");
type BriefingPopups = typeof import("@/components/dashboard/BriefingPopups");
type WellnessPopups = typeof import("@/components/wellness/WellnessPopups");

export const NetWorthPopup = gated<ComponentProps<HeroKPIPopups["NetWorthPopup"]>>(NetWorthPopupImpl as any);
export const BudgetPopup = gated<ComponentProps<HeroKPIPopups["BudgetPopup"]>>(BudgetPopupImpl as any);
export const CashFlowView = gated<ComponentProps<CashFlow["CashFlowView"]>>(CashFlowViewImpl as any);
export const TasksPopup = gated<ComponentProps<TaskHabitPopups["TasksPopup"]>>(TasksPopupImpl as any);
export const HabitsPopup = gated<ComponentProps<TaskHabitPopups["HabitsPopup"]>>(HabitsPopupImpl as any);
export const QuickAddDialog = gated<ComponentProps<QuickAdd["QuickAddDialog"]>>(QuickAddDialogImpl as any);
export const DrillDownDialog = gated<ComponentProps<DrillDown["DrillDownDialog"]>>(DrillDownDialogImpl as any);

// ChatGPT import uses `open`/`onOpenChange` like the others but is spelled
// separately because its prop type lives on a differently-named export.
export const ChatGPTImportDialog =
  gated<ComponentProps<ChatGPTImport["ChatGPTImportDialog"]>>(ChatGPTImportDialogImpl as any);

export const BillsPopup = gated<ComponentProps<BriefingPopups["BillsPopup"]>>(BillsPopupImpl as any);
export const EventsPopup = gated<ComponentProps<BriefingPopups["EventsPopup"]>>(EventsPopupImpl as any);
export const DocsPopup = gated<ComponentProps<BriefingPopups["DocsPopup"]>>(DocsPopupImpl as any);

// WellnessPopup has no `open` prop — callers render it conditionally — so it
// only needs the Suspense boundary, not the open gate.
export function WellnessPopup(props: ComponentProps<WellnessPopups["WellnessPopup"]>) {
  return (
    <Suspense fallback={null}>
      <WellnessPopupImpl {...(props as any)} />
    </Suspense>
  );
}

export type { QuickAddKind } from "@/components/dashboard/quick-add/QuickAddDialog";
