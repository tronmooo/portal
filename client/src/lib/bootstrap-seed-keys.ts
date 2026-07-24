// Pure (queryClient-free) projection of a /api/dashboard-bootstrap payload into
// the exact list of react-query [key, data] pairs the dashboard + every tab
// read. Kept dependency-free so BOTH the runtime seeder (bootstrap-seed.ts,
// after a live fetch) and the pre-mount hydrator (queryClient.ts, from the
// persisted blob) can share ONE key list — the audit's "key shapes must stay
// in lockstep" hazard is eliminated by having a single source of truth here.
import { scopedKey, type ProfileFilterMode } from "@shared/query-keys";

export interface BootstrapSeedEntry {
  key: unknown[];
  data: unknown;
}

/**
 * Build the [key, data] seed pairs from a bootstrap payload for a given scope.
 * Only pairs whose data is present (not null/undefined) are returned, so a
 * partial bootstrap never clobbers a slot with an empty value.
 */
export function bootstrapSeedEntries(
  b: any,
  mode: string,
  ids: string[],
  month: string,
): BootstrapSeedEntry[] {
  if (!b || typeof b !== "object") return [];
  const m: ProfileFilterMode = mode === "selected" ? "selected" : "everyone";
  const k = (endpoint: string, ...extra: unknown[]) => [...scopedKey(endpoint, m, ids, ...extra)];
  const out: BootstrapSeedEntry[] = [];
  const add = (key: unknown[], data: unknown) => {
    if (data !== undefined && data !== null) out.push({ key, data });
  };
  add(k("/api/stats"), b.stats);
  add(k("/api/dashboard-enhanced"), b.enhanced);
  add(["/api/profiles"], b.profiles);
  add(k("/api/incomes", "hero"), b.incomes);
  add(k("/api/incomes"), b.incomes);
  add(k("/api/budgets/summary", month, "hero"), b.budgetSummary);
  add(k("/api/budgets/summary", month), b.budgetSummary);
  add(k("/api/expenses"), b.expenses);
  add(k("/api/budgets", month), b.budgets);
  add(k("/api/obligations"), b.obligations);
  add(["/api/asset-party-links"], b.assetPartyLinks);
  add(["/api/liability-profile-links"], b.liabilityProfileLinks);
  add(k("/api/tasks"), b.tasks);
  add(k("/api/habits"), b.habits);
  // goalsQueryKey(ids) collapses to this exact key (see @shared/query-keys), so
  // one entry covers the dashboard, goals and trackers pages — no double-seed.
  add(k("/api/goals"), b.goals);
  add(k("/api/journal"), b.journal);
  add(k("/api/events"), b.events);
  add(k("/api/documents"), b.documents);
  add(k("/api/trackers"), b.trackers);
  add(k("/api/trackers", "trends"), b.trackers);
  add(k("/api/reminders"), b.reminders);

  // [PERF 2026-07-17, user report "every tile shows loading on scope switch"]
  // Events tile is gated on the 45-day calendar-timeline query and the AI
  // Executive Brief on /api/notifications; without these seeds a scope switch
  // leaves both cold and the tiles stuck on "loading" for 12s+ on weak mobile.
  //
  // Calendar-timeline's live key shape is [endpoint, start, end, mode, ...ids]
  // (dates BEFORE mode — see ExecutiveBriefing.tsx line 189), so it can't be
  // built via scopedKey(); we assemble it manually to stay bit-identical.
  if (b.calendarTimeline && Array.isArray(b.calendarTimeline.items)
      && b.calendarTimeline.start && b.calendarTimeline.end) {
    add(
      ["/api/calendar/timeline", b.calendarTimeline.start, b.calendarTimeline.end, m, ...ids],
      b.calendarTimeline.items,
    );
  }
  add(k("/api/notifications"), b.notifications);
  return out;
}

// The list-domain arrays inside a bootstrap payload that scale with a user's
// dataset size. Aggregate/summary fields (stats, enhanced, budgetSummary) and
// the small link/profile arrays are deliberately NOT trimmed — they drive the
// dashboard KPI numbers and must stay whole for the shell to be correct.
const TRIMMABLE_LIST_FIELDS = [
  "expenses",
  "incomes",
  "budgets",
  "obligations",
  "tasks",
  "habits",
  "goals",
  "journal",
  "events",
  "documents",
  "trackers",
  "reminders",
] as const;

export interface BootstrapShellMeta {
  /** true when at least one list was truncated relative to the full payload. */
  trimmed: boolean;
  /** per-domain full row counts so a consumer can show "N of M" if desired. */
  counts: Record<string, number>;
}

/**
 * Project a bootstrap payload down to a bounded "shell": every scaling list is
 * sliced to at most `maxRows` above-the-fold rows while aggregates/summaries
 * stay whole. Used when the full payload exceeds the localStorage per-entry cap
 * so power users still get an instant cached dashboard shell on reload (the
 * previous behavior silently dropped the whole entry, regressing exactly the
 * heavy-data users who most need the cache). The full bootstrap refetches in
 * the background and swaps in the complete lists.
 *
 * Pure: returns a new shallow object; the input is never mutated. A
 * `__shell` marker records the true per-domain counts and that trimming
 * occurred (schema-additive — older readers ignore it).
 */
export function projectBootstrapShell(b: any, maxRows: number): any {
  if (!b || typeof b !== "object") return b;
  const counts: Record<string, number> = {};
  let trimmed = false;
  const shell: any = { ...b };
  for (const field of TRIMMABLE_LIST_FIELDS) {
    const arr = (b as any)[field];
    if (!Array.isArray(arr)) continue;
    counts[field] = arr.length;
    if (arr.length > maxRows) {
      shell[field] = arr.slice(0, maxRows);
      trimmed = true;
    }
  }
  const meta: BootstrapShellMeta = { trimmed, counts };
  shell.__shell = meta;
  return shell;
}

