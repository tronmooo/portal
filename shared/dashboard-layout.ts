// ── Dashboard layout — the ONE source of truth for section defs + version ────
// Shared between client/src/pages/dashboard.tsx (renders; adds icons) and the
// AI's configure_dashboard_sections tool (reads/writes the dashboard_layout
// preference). The version MUST be stamped by every writer: the client's
// parseSavedLayout discards any saved layout with version < LAYOUT_VERSION, so
// a server writer with a stale local copy would silently un-customize the
// dashboard. tests/dashboard-layout-guard.test.ts fails if the client ever
// redefines these locally again.

export interface DashboardSectionDef {
  id: string;
  label: string;
  visible: boolean;
  column: "full";
}

export const LAYOUT_VERSION = 16; // Briefing-only Executive: hero card + quick actions removed from defaults (user request)

export const DEFAULT_SECTION_DEFS: DashboardSectionDef[] = [
  // ── Executive daily briefing (2026-07, LAYOUT_VERSION 15) ─────────────────
  { id: "exec-briefing",    label: "Daily Briefing",        visible: true,  column: "full" },

  // ── Hidden by default (available via Customize / chat) ────────────────────
  { id: "hero-briefing",    label: "Briefing",              visible: false, column: "full" },
  { id: "quick-actions",    label: "Quick Actions",         visible: false, column: "full" },
  { id: "needs-attention",  label: "Action Required",       visible: false, column: "full" },
  { id: "today",            label: "Today's Schedule",      visible: false, column: "full" },
  { id: "now-queue",        label: "Now",                   visible: false, column: "full" },
  { id: "notifications",    label: "Notifications",         visible: false, column: "full" },
  { id: "upcoming-dates",   label: "Upcoming",              visible: false, column: "full" },
  { id: "obligations",      label: "Bills & Subscriptions", visible: false, column: "full" },
  { id: "hero-kpis",        label: "Hero Metrics",          visible: false, column: "full" },
  { id: "kpis",             label: "Key Metrics",           visible: false, column: "full" },
  { id: "weekly-summary",   label: "Weekly Summary",        visible: false, column: "full" },
  { id: "trends",           label: "Trends",                visible: false, column: "full" },
  { id: "health",           label: "Health",                visible: false, column: "full" },
  { id: "goals",            label: "Goals",                 visible: false, column: "full" },
  { id: "key-findings",     label: "Key Findings",          visible: false, column: "full" },
  { id: "domain-hubs",      label: "Explore",               visible: false, column: "full" },
  { id: "activity",         label: "Recent Activity",       visible: false, column: "full" },
  { id: "ai-summary",       label: "AI Summary",            visible: false, column: "full" },
  { id: "finance",          label: "Finance",               visible: false, column: "full" },
];

/** Parse a saved dashboard_layout preference value into plain section defs.
 *  Mirrors the client's parseSavedLayout semantics: outdated version ⇒ null
 *  (treat as defaults), unknown ids dropped, missing known ids appended. */
export function parseLayoutValue(saved: string | null): DashboardSectionDef[] | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    let sections: any[];
    let version = 0;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sections) {
      version = parsed.version || 0;
      sections = parsed.sections;
    } else if (Array.isArray(parsed)) {
      sections = parsed;
    } else return null;
    if (version < LAYOUT_VERSION) return null;
    if (!Array.isArray(sections) || sections.length === 0) return null;
    const validIds = new Set(DEFAULT_SECTION_DEFS.map((s) => s.id));
    const filtered = sections
      .filter((s) => validIds.has(s?.id))
      .map((s) => ({ id: String(s.id), label: String(s.label || ""), visible: s.visible !== false, column: "full" as const }));
    const savedIds = new Set(filtered.map((s) => s.id));
    for (const def of DEFAULT_SECTION_DEFS) {
      if (!savedIds.has(def.id)) filtered.push({ ...def });
    }
    return filtered;
  } catch {
    return null;
  }
}

/** Serialize section defs with the CURRENT version stamp. */
export function serializeLayoutValue(sections: DashboardSectionDef[]): string {
  return JSON.stringify({
    version: LAYOUT_VERSION,
    sections: sections.map(({ id, label, visible, column }) => ({ id, label, visible, column })),
  });
}

/** Resolve a human section reference ("quick notes", "bills") to a def. */
export function findSection(sections: DashboardSectionDef[], ref: string): DashboardSectionDef | undefined {
  const needle = String(ref || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!needle) return undefined;
  return sections.find((s) => s.id === needle)
    || sections.find((s) => s.label.toLowerCase() === needle)
    || sections.find((s) => s.label.toLowerCase().includes(needle))
    || sections.find((s) => s.id.includes(needle.replace(/\s+/g, "-")));
}
