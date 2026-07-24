// ── Panel registry — lazy chunks + prefetch-on-intent ───────────────────────
// Before this file all ~3,500 lines of popup code were statically imported into
// the dashboard chunk and parsed before first paint, for popups a session might
// never open. Every panel now lives behind a dynamic import, and every tile /
// row warms its chunk AND its query on `pointerdown` — which on touch fires
// ~80–120 ms before the click resolves, so the chunk is usually already in
// flight before the finger lifts.
import type { QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type PanelId =
  | "tasks" | "habits" | "obligations" | "timeline"
  | "goals" | "notes" | "reminders" | "attention"
  | "networth" | "cashflow" | "budget";

/** Scope of the dashboard's current profile filter — part of every query key. */
export interface PanelScope { filterMode: string; filterIds: string[] }

export interface PanelRequest {
  id: PanelId;
  /** Sub-tab inside the panel ("bills" | "docs", a timeline filter, …). */
  sub?: string;
  /** Row to scroll to / highlight once the panel is open. */
  focus?: string;
}

// One module import per source file — three chunks, shared by 11 panels.
const loadTaskHabit = () => import("@/components/dashboard/TaskHabitPopups");
const loadBriefing = () => import("@/components/dashboard/BriefingPopups");
const loadHeroKPI = () => import("@/components/dashboard/HeroKPIPopups");

const scopeParam = (s: PanelScope) =>
  s.filterMode === "selected" && s.filterIds.length > 0 ? `?profileIds=${s.filterIds.join(",")}` : "";

/** Warm a list query under the SAME key the panel will read, so its
 *  `initialData` hits and the panel paints with real rows on frame 1. */
const warm = (qc: QueryClient, path: string, s: PanelScope, scoped = true) =>
  qc.prefetchQuery({
    queryKey: scoped ? [path, s.filterMode, ...s.filterIds] : [path],
    queryFn: () => apiRequest("GET", `${path}${scoped ? scopeParam(s) : ""}`).then(r => r.json()),
    staleTime: 30_000,
  });

export interface PanelDef {
  /** Dynamic import of the module holding this panel. */
  load: () => Promise<unknown>;
  /** Warm the queries the panel reads. Never throws — prefetch is best-effort. */
  prefetch?: (qc: QueryClient, scope: PanelScope) => void;
}

export const PANELS: Record<PanelId, PanelDef> = {
  tasks: {
    load: loadTaskHabit,
    prefetch: (qc, s) => { void warm(qc, "/api/tasks", s); void warm(qc, "/api/profiles", s, false); },
  },
  habits: {
    load: loadTaskHabit,
    prefetch: (qc, s) => { void warm(qc, "/api/habits", s); void warm(qc, "/api/profiles", s, false); },
  },
  obligations: {
    load: loadBriefing,
    prefetch: (qc, s) => {
      void warm(qc, "/api/obligations", s, false);
      void warm(qc, "/api/documents", s, false);
      void warm(qc, "/api/profiles", s, false);
    },
  },
  timeline: { load: loadBriefing, prefetch: (qc, s) => { void warm(qc, "/api/profiles", s, false); } },
  goals: { load: loadBriefing, prefetch: (qc, s) => { void warm(qc, "/api/goals", s); } },
  notes: { load: loadBriefing, prefetch: (qc, s) => { void warm(qc, "/api/journal", s); } },
  reminders: { load: loadBriefing, prefetch: (qc, s) => { void warm(qc, "/api/reminders", s); } },
  attention: { load: loadBriefing },
  networth: { load: loadHeroKPI, prefetch: (qc, s) => { void warm(qc, "/api/profiles", s, false); } },
  cashflow: {
    load: loadHeroKPI,
    prefetch: (qc, s) => { void warm(qc, "/api/incomes", s, false); void warm(qc, "/api/obligations", s, false); },
  },
  budget: { load: loadHeroKPI },
};

/** Call on pointerdown/touchstart. Best-effort: a failed warm-up is invisible,
 *  the panel just falls back to its own fetch. */
export function prefetchPanel(id: PanelId, qc: QueryClient, scope: PanelScope): void {
  const def = PANELS[id];
  if (!def) return;
  try {
    void def.load();
    def.prefetch?.(qc, scope);
  } catch { /* prefetch is never load-bearing */ }
}

/** After the dashboard is interactive, warm the two panels that are opened
 *  most. requestIdleCallback so it never competes with first paint. */
export function warmCommonPanels(qc: QueryClient, scope: PanelScope): () => void {
  const run = () => { prefetchPanel("tasks", qc, scope); prefetchPanel("obligations", qc, scope); };
  const ric = (globalThis as any).requestIdleCallback as undefined | ((cb: () => void, o?: any) => number);
  if (typeof ric === "function") {
    const handle = ric(run, { timeout: 3000 });
    return () => (globalThis as any).cancelIdleCallback?.(handle);
  }
  const t = setTimeout(run, 1500);
  return () => clearTimeout(t);
}
