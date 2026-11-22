// shared/exec-dashboards.ts — several Executive dashboards, each its own.
//
// Owner request 2026-11-22: "different customizations for different types of
// executive dashboards of whatever they want — make it fully customizable …
// but obviously have the ones that are standard, the ones we already have."
//
// A DASHBOARD is a named layout: which cards show, in what order, at what
// size, and whether Quiet Mode trims it. The cards themselves — the eight
// standard ones and any the user built — exist once and are available to
// every dashboard; a dashboard only decides what to show. So a "Money"
// dashboard and a "Health" dashboard can share a card, and removing a custom
// card removes it everywhere.
//
// One preference row holds all of it (`exec_card_prefs`). Every function here
// returns the per-dashboard view the rest of the app already speaks
// (`ExecCardPrefs`, shared/exec-card-prefs), so a screen that only draws the
// active dashboard needs to know nothing about the others.

import {
  DEFAULT_EXEC_CARD_PREFS, EXEC_CARD_IDS, parseExecCardPrefs, widgetCardId,
  type BuiltInCardId, type ExecCardId, type ExecCardPrefs, type ExecCardSize,
} from "./exec-card-prefs";
import { EXTRA_WIDGETS, WIDGET_TEMPLATES, newWidgetId, sanitizeWidget, type ExecWidget } from "./exec-widgets";

export interface ExecDashboard {
  id: string;
  name: string;
  quiet: boolean;
  hidden: ExecCardId[];
  order: ExecCardId[];
  sizes: Partial<Record<string, ExecCardSize>>;
}

export interface ExecDashboards {
  /** The dashboard the Executive tab is showing. */
  active: string;
  dashboards: ExecDashboard[];
  /** Every card the user built; each dashboard chooses which to show. */
  widgets: ExecWidget[];
}

export const MAX_DASHBOARDS = 8;
const MAIN: Pick<ExecDashboard, "id" | "name"> = { id: "main", name: "Main" };

const layoutOf = (p: Pick<ExecCardPrefs, "quiet" | "hidden" | "order" | "sizes">): Omit<ExecDashboard, "id" | "name"> =>
  ({ quiet: p.quiet, hidden: [...p.hidden], order: [...p.order], sizes: { ...p.sizes } });

export function defaultExecDashboards(): ExecDashboards {
  return { active: MAIN.id, dashboards: [{ ...MAIN, ...layoutOf(parseExecCardPrefs(null)) }], widgets: [] };
}

const cleanName = (raw: unknown) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
const cleanId = (raw: unknown) => String(raw ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);

/**
 * Read the stored row. A row saved before there were several dashboards is a
 * single layout: it becomes the one dashboard, "Main", unchanged.
 */
export function parseExecDashboards(raw: string | null | undefined): ExecDashboards {
  if (!raw) return defaultExecDashboards();
  let saved: any;
  try { saved = JSON.parse(raw); } catch { return defaultExecDashboards(); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaultExecDashboards();
  if (!Array.isArray(saved.dashboards)) {
    const one = parseExecCardPrefs(raw);
    return { active: MAIN.id, dashboards: [{ ...MAIN, ...layoutOf(one) }], widgets: one.widgets };
  }
  // Widgets first: a dashboard's hidden / order / sizes may name them.
  const widgets = parseExecCardPrefs(JSON.stringify({ widgets: saved.widgets })).widgets;
  const dashboards: ExecDashboard[] = [];
  for (const d of saved.dashboards.slice(0, MAX_DASHBOARDS)) {
    if (!d || typeof d !== "object") continue;
    const id = cleanId(d.id);
    const name = cleanName(d.name);
    if (!id || !name || dashboards.some((x) => x.id === id)) continue;
    dashboards.push({ id, name, ...layoutOf(parseExecCardPrefs(JSON.stringify({ ...d, widgets }))) });
  }
  if (dashboards.length === 0) return { ...defaultExecDashboards(), widgets };
  const active = dashboards.some((d) => d.id === saved.active) ? String(saved.active) : dashboards[0].id;
  return { active, dashboards, widgets };
}

export function serializeExecDashboards(b: ExecDashboards): string {
  return JSON.stringify({ v: 2, active: b.active, dashboards: b.dashboards, widgets: b.widgets });
}

export function activeDashboard(b: ExecDashboards): ExecDashboard {
  return b.dashboards.find((d) => d.id === b.active) ?? b.dashboards[0];
}

/** The active dashboard as the layout the tab draws. */
export function activeExecPrefs(b: ExecDashboards): ExecCardPrefs {
  const d = activeDashboard(b);
  return d ? { ...layoutOf(d), widgets: b.widgets } : { ...DEFAULT_EXEC_CARD_PREFS };
}

/**
 * Write an edited layout back onto the active dashboard.
 *
 * Cards are shared, layouts are not: a card ADDED while editing this dashboard
 * starts hidden on the others (building a "Vet visits" card for Home must not
 * drop it into Money), and a card REMOVED is removed from every dashboard.
 */
export function withActiveExecPrefs(b: ExecDashboards, next: ExecCardPrefs): ExecDashboards {
  const cur = activeDashboard(b);
  const before = new Set(b.widgets.map((w) => w.id));
  const after = new Set(next.widgets.map((w) => w.id));
  const added = next.widgets.filter((w) => !before.has(w.id)).map((w) => widgetCardId(w.id));
  const gone = new Set(b.widgets.filter((w) => !after.has(w.id)).map((w) => widgetCardId(w.id)));
  const dashboards = b.dashboards.map((d) => {
    if (d.id === cur.id) return { ...d, ...layoutOf(next) };
    const sizes = Object.fromEntries(Object.entries(d.sizes).filter(([id]) => !gone.has(id as any)));
    return {
      ...d,
      hidden: Array.from(new Set<ExecCardId>([...d.hidden.filter((id) => !gone.has(id)), ...added])),
      order: d.order.filter((id) => !gone.has(id)),
      sizes,
    };
  });
  return { ...b, dashboards, widgets: next.widgets };
}

export function setActiveDashboard(b: ExecDashboards, id: string): ExecDashboards {
  return b.dashboards.some((d) => d.id === id) ? { ...b, active: id } : b;
}

export function renameDashboard(b: ExecDashboards, id: string, name: string): ExecDashboards {
  const clean = cleanName(name);
  if (!clean) return b;
  return { ...b, dashboards: b.dashboards.map((d) => (d.id === id ? { ...d, name: clean } : d)) };
}

/** Delete a dashboard (never the last one). Cards the user built are kept. */
export function removeDashboard(b: ExecDashboards, id: string): ExecDashboards {
  if (b.dashboards.length <= 1 || !b.dashboards.some((d) => d.id === id)) return b;
  const dashboards = b.dashboards.filter((d) => d.id !== id);
  return { ...b, dashboards, active: b.active === id ? dashboards[0].id : b.active };
}

// ── Starting points ──────────────────────────────────────────────────────────

export interface DashboardTemplate {
  key: string;
  name: string;
  hint: string;
  /** Standard cards it shows, in order. */
  cards: BuiltInCardId[];
  /** Custom cards it shows (created if the user does not have them yet). */
  widgets: Array<Omit<ExecWidget, "id">>;
  quiet?: boolean;
}

const idea = (key: string) => WIDGET_TEMPLATES.find((t) => t.key === key)!.widget;

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  { key: "standard", name: "Essentials", hint: "Needs Attention, Tasks, Timeline, Money", cards: ["attention", "tasks", "schedule", "money"], widgets: [], quiet: true },
  { key: "everything", name: "Everything", hint: "All eight standard cards", cards: [...EXEC_CARD_IDS], widgets: [] },
  { key: "money", name: "Money", hint: "Finances, bills, accounts, spending", cards: ["money", "attention"], widgets: [idea("spending"), EXTRA_WIDGETS.bills, EXTRA_WIDGETS.accounts] },
  { key: "health", name: "Health", hint: "Wellness, habits, fitness, goals", cards: ["wellness", "habits"], widgets: [idea("fitness"), EXTRA_WIDGETS.health, EXTRA_WIDGETS.goals] },
  { key: "home", name: "Home & Family", hint: "Calendar, tasks, family, pets, vehicles, property", cards: ["schedule", "tasks", "attention"], widgets: [EXTRA_WIDGETS.family, idea("pets"), idea("vehicles"), idea("home")] },
  { key: "blank", name: "Blank", hint: "Start empty and add what you want", cards: [], widgets: [] },
];

/**
 * Add a dashboard from a starting point and make it the active one. Widgets
 * the template names are reused when the user already has a card by that
 * title, and created otherwise — hidden on the dashboards that existed.
 */
export function addDashboard(b: ExecDashboards, name: string, templateKey = "standard"): ExecDashboards {
  if (b.dashboards.length >= MAX_DASHBOARDS) return b;
  const t = DASHBOARD_TEMPLATES.find((x) => x.key === templateKey) ?? DASHBOARD_TEMPLATES[0];
  const clean = cleanName(name) || t.name;
  let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "dashboard";
  for (let n = 2; b.dashboards.some((d) => d.id === id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;

  let widgets = b.widgets;
  const created: ExecCardId[] = [];
  const shown: ExecCardId[] = [];
  for (const base of t.widgets) {
    let w = widgets.find((x) => x.title === base.title);
    if (!w) {
      const wid = newWidgetId(widgets, base.title);
      w = sanitizeWidget({ ...base, id: wid }, wid) ?? undefined;
      if (!w) continue;
      widgets = [...widgets, w];
      created.push(widgetCardId(w.id));
    }
    shown.push(widgetCardId(w.id));
  }
  const all: ExecCardId[] = [...EXEC_CARD_IDS, ...widgets.map((w) => widgetCardId(w.id))];
  const keep = new Set<ExecCardId>([...t.cards, ...shown]);
  const fresh: ExecDashboard = t.quiet
    // Quiet Mode already is "the four essentials"; other custom cards stay off.
    ? { id, name: clean, quiet: true, hidden: all.filter((c) => c.startsWith("w:")), order: [], sizes: {} }
    : { id, name: clean, quiet: false, hidden: all.filter((c) => !keep.has(c)), order: [...t.cards, ...shown], sizes: {} };
  const dashboards = [
    ...b.dashboards.map((d) => ({ ...d, hidden: Array.from(new Set<ExecCardId>([...d.hidden, ...created])) })),
    fresh,
  ];
  return { active: id, dashboards, widgets };
}
