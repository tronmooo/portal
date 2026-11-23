// shared/wellness-dashboards.ts — the Wellness tab's cards, layouts and options.
//
// Owner, 2026-11-23: "One Wellness tab, multiple customizable dashboards
// covering different aspects of your health … Nothing is permanently locked
// into the dashboard." Executive answers "what's happening in my life?";
// Wellness answers "how am I doing over time?".
//
// This is the Wellness INSTANCE of the shared dashboard system
// (shared/dashboard-engine): the same ordering, sizing, hiding and
// several-dashboards rules the Executive tab runs on. What is Wellness's own:
// its built-in cards, its widget shape (shared/wellness-widgets), its
// templates and its display options (the default time range, density, trend
// graphs, comparison %, last-updated date).
//
// One preference row holds all of it (`wellness_card_prefs`), on the account —
// never browser storage. A widget stores a description, not health data.
//
// Pure and deterministic. Pinned by tests/wellness-dashboards.test.ts.

import {
  MAX_DASHBOARDS, activeBoard, carryWidgetChange, cleanBoardId, cleanBoardName, cleanLayout, isWidgetCardId,
  moveCard, newBoardId, newWidgetId, orderedCards, placeCard, removeBoard, renameBoard, setActiveBoard, widgetCardId, widgetDiff,
  type CardLayout, type CardSize,
} from "./dashboard-engine";
import { DEFAULT_WELLNESS_RANGE, isWellnessRange, type WellnessRange } from "./wellness-period";
import {
  MAX_WELLNESS_WIDGETS, WELLNESS_WIDGET_IDEAS, describeWellnessWidget, sanitizeWellnessWidget, type WellnessWidget,
} from "./wellness-widgets";

export const WELLNESS_PREFS_KEY = "wellness_card_prefs";

export const WELLNESS_CARD_IDS = [
  "overview", "trends", "activity", "sleep", "nutrition", "body", "labs", "medications", "sources", "insights",
  "mood", "symptoms", "graphs", "goals", "score",
] as const;
export type WellnessBuiltInCardId = (typeof WELLNESS_CARD_IDS)[number];
export type WellnessCardId = WellnessBuiltInCardId | `w:${string}`;

/** Built-in cards that start switched off: they are offered under "Available Sections". */
export const WELLNESS_DEFAULT_HIDDEN: readonly WellnessBuiltInCardId[] = ["mood", "symptoms", "graphs", "goals", "score"];

export const WELLNESS_CARD_TITLES: Record<WellnessBuiltInCardId, string> = {
  overview: "Wellness Overview",
  trends: "Health Trends",
  activity: "Activity Summary",
  sleep: "Sleep & Recovery",
  nutrition: "Nutrition & Hydration",
  body: "Body & Vitals",
  labs: "Labs",
  medications: "Medications & Care",
  sources: "Connected Sources",
  insights: "AI Wellness Insights",
  mood: "Mood & Energy",
  symptoms: "Symptoms & Notes",
  graphs: "Vitals Graphs (Advanced)",
  goals: "Health Goals",
  score: "Wellness Score",
};

export const WELLNESS_CARD_HINTS: Record<WellnessBuiltInCardId, string> = {
  overview: "Sleep, activity, weight, blood pressure, water and food at a glance",
  trends: "Where each measurement started and where it is now",
  activity: "Workouts, time, distance and what you trained at",
  sleep: "Sleep, resting heart rate and HRV over the period",
  nutrition: "Calories, macros and water per day",
  body: "Weight, BMI, blood pressure and other vitals against their ranges",
  labs: "Lab values by panel, flagged when out of range",
  medications: "Medications, appointments, conditions and health documents",
  sources: "What is feeding this tab",
  insights: "What changed over the period, read back from your records",
  mood: "Mood and energy from your journal",
  symptoms: "Symptom trackers and what you noted",
  graphs: "A larger graph for each vital",
  goals: "Health and fitness goals and their progress",
  score: "Today's score and what it is made of",
};

export type WellnessCardSize = CardSize;
/** Every built-in card takes the full row unless the user makes it medium. */
export const wellnessDefaultSize = (_id: string): CardSize => "large";

// ── Display options ──────────────────────────────────────────────────────────

export interface WellnessOptions {
  /** The range the tab opens on. The on-screen range tabs only change the view. */
  range: WellnessRange;
  density: "compact" | "comfortable";
  /** Draw the small trend graphs. */
  trends: boolean;
  /** Show "+12% vs prior 30d". */
  comparison: boolean;
  /** Show when a figure was last recorded. */
  updated: boolean;
}

export const DEFAULT_WELLNESS_OPTIONS: WellnessOptions = { range: DEFAULT_WELLNESS_RANGE, density: "compact", trends: true, comparison: true, updated: true };

function cleanOptions(raw: any): WellnessOptions {
  const d = DEFAULT_WELLNESS_OPTIONS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    range: isWellnessRange(raw?.range) ? raw.range : d.range,
    density: raw?.density === "comfortable" ? "comfortable" : "compact",
    trends: bool(raw?.trends, d.trends), comparison: bool(raw?.comparison, d.comparison), updated: bool(raw?.updated, d.updated),
  };
}

// ── The stored row ───────────────────────────────────────────────────────────

export interface WellnessBoard extends CardLayout<WellnessCardId> { id: string; name: string }

export interface WellnessBoards {
  /** The dashboard the Wellness tab is showing. */
  active: string;
  dashboards: WellnessBoard[];
  /** Every card the user built; each dashboard chooses which to show. */
  widgets: WellnessWidget[];
  options: WellnessOptions;
}

const OVERVIEW: Pick<WellnessBoard, "id" | "name"> = { id: "overview", name: "Overview" };
const freshLayout = (): CardLayout<WellnessCardId> => ({ hidden: [...WELLNESS_DEFAULT_HIDDEN], order: [], sizes: {} });

export function defaultWellnessBoards(): WellnessBoards {
  return { active: OVERVIEW.id, dashboards: [{ ...OVERVIEW, ...freshLayout() }], widgets: [], options: { ...DEFAULT_WELLNESS_OPTIONS } };
}

export function allWellnessCardIds(widgets: ReadonlyArray<{ id: string }>): WellnessCardId[] {
  return [...WELLNESS_CARD_IDS, ...widgets.map((w) => widgetCardId(w.id))];
}

/** Read the stored row; anything unrecognised falls back to the defaults. */
export function parseWellnessBoards(raw: string | null | undefined): WellnessBoards {
  if (!raw) return defaultWellnessBoards();
  let saved: any;
  try { saved = JSON.parse(raw); } catch { return defaultWellnessBoards(); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaultWellnessBoards();
  const widgets: WellnessWidget[] = [];
  for (const w of Array.isArray(saved.widgets) ? saved.widgets.slice(0, MAX_WELLNESS_WIDGETS) : []) {
    const ok = sanitizeWellnessWidget(w);
    if (ok && !widgets.some((x) => x.id === ok.id)) widgets.push(ok);
  }
  const known = new Set<string>(allWellnessCardIds(widgets));
  const dashboards: WellnessBoard[] = [];
  for (const d of Array.isArray(saved.dashboards) ? saved.dashboards.slice(0, MAX_DASHBOARDS) : []) {
    if (!d || typeof d !== "object") continue;
    const id = cleanBoardId(d.id);
    const name = cleanBoardName(d.name);
    if (!id || !name || dashboards.some((x) => x.id === id)) continue;
    dashboards.push({ id, name, ...cleanLayout<WellnessCardId>(d, known) });
  }
  const options = cleanOptions(saved.options);
  if (dashboards.length === 0) return { ...defaultWellnessBoards(), widgets, options };
  const active = dashboards.some((d) => d.id === saved.active) ? String(saved.active) : dashboards[0].id;
  return { active, dashboards, widgets, options };
}

export function serializeWellnessBoards(b: WellnessBoards): string {
  return JSON.stringify({ v: 1, active: b.active, dashboards: b.dashboards, widgets: b.widgets, options: b.options });
}

// ── The active dashboard ─────────────────────────────────────────────────────

export const activeWellnessBoard = (b: WellnessBoards): WellnessBoard => activeBoard(b);
export const setActiveWellnessBoard = (b: WellnessBoards, id: string): WellnessBoards => setActiveBoard(b, id);
export const renameWellnessBoard = (b: WellnessBoards, id: string, name: string): WellnessBoards => renameBoard(b, id, name);
/** Delete a dashboard (never the last one). The cards themselves are kept. */
export const removeWellnessBoard = (b: WellnessBoards, id: string): WellnessBoards => removeBoard(b, id);

const editActive = (b: WellnessBoards, fn: (d: WellnessBoard) => WellnessBoard): WellnessBoards => {
  const cur = activeBoard(b);
  return { ...b, dashboards: b.dashboards.map((d) => (d.id === cur.id ? fn(d) : d)) };
};

/** Every card of the active dashboard, in its order. */
export function orderedWellnessCards(b: WellnessBoards): WellnessCardId[] {
  return orderedCards(allWellnessCardIds(b.widgets), activeBoard(b).order);
}
export function isWellnessCardVisible(b: WellnessBoards, id: WellnessCardId): boolean {
  return !activeBoard(b).hidden.includes(id);
}
export const visibleWellnessCards = (b: WellnessBoards): WellnessCardId[] => orderedWellnessCards(b).filter((id) => isWellnessCardVisible(b, id));
export const hiddenWellnessCards = (b: WellnessBoards): WellnessCardId[] => orderedWellnessCards(b).filter((id) => !isWellnessCardVisible(b, id));

export function wellnessCardSize(b: WellnessBoards, id: WellnessCardId): CardSize {
  return activeBoard(b).sizes[id] ?? wellnessDefaultSize(id);
}
export function wellnessCardTitle(b: Pick<WellnessBoards, "widgets">, id: WellnessCardId): string {
  if (isWidgetCardId(id)) return b.widgets.find((w) => widgetCardId(w.id) === id)?.title ?? "Custom card";
  return WELLNESS_CARD_TITLES[id];
}
export function wellnessCardHint(b: Pick<WellnessBoards, "widgets">, id: WellnessCardId): string {
  if (isWidgetCardId(id)) {
    const w = b.widgets.find((x) => widgetCardId(x.id) === id);
    return w ? describeWellnessWidget(w) : "";
  }
  return WELLNESS_CARD_HINTS[id];
}

export function setWellnessCardVisible(b: WellnessBoards, id: WellnessCardId, visible: boolean): WellnessBoards {
  return editActive(b, (d) => ({ ...d, hidden: visible ? d.hidden.filter((x) => x !== id) : Array.from(new Set([...d.hidden, id])) }));
}
export function setWellnessCardSize(b: WellnessBoards, id: WellnessCardId, size: CardSize): WellnessBoards {
  return editActive(b, (d) => ({ ...d, sizes: { ...d.sizes, [id]: size } }));
}
/** Put a card at an index of the active dashboard's order (drag and drop). */
export function placeWellnessCard(b: WellnessBoards, id: WellnessCardId, toIndex: number): WellnessBoards {
  const order = placeCard(allWellnessCardIds(b.widgets), activeBoard(b).order, id, toIndex);
  return order ? editActive(b, (d) => ({ ...d, order })) : b;
}
export function moveWellnessCard(b: WellnessBoards, id: WellnessCardId, dir: -1 | 1): WellnessBoards {
  const order = moveCard(allWellnessCardIds(b.widgets), activeBoard(b).order, id, dir);
  return order ? editActive(b, (d) => ({ ...d, order })) : b;
}
export function setWellnessOptions(b: WellnessBoards, patch: Partial<WellnessOptions>): WellnessBoards {
  return { ...b, options: cleanOptions({ ...b.options, ...patch }) };
}
/** "Reset to Default": the active dashboard's built-in layout and the default options. Cards the user built are kept (Rule 8: a reset is not a delete). */
export function resetWellnessLayout(b: WellnessBoards): WellnessBoards {
  const next = editActive(b, (d) => ({ ...d, ...freshLayout() }));
  return { ...next, options: { ...DEFAULT_WELLNESS_OPTIONS } };
}

// ── Custom cards ─────────────────────────────────────────────────────────────

function withWidgets(b: WellnessBoards, widgets: WellnessWidget[]): WellnessBoards {
  const { added, gone } = widgetDiff(b.widgets, widgets);
  const cur = activeBoard(b);
  return {
    ...b, widgets,
    // The dashboard being edited shows a card it was built on; the rest start with it hidden.
    dashboards: b.dashboards.map((d) => (d.id === cur.id ? carryWidgetChange(d, [], gone) : carryWidgetChange(d, added, gone))),
  };
}

/** Add a card the user built: shown on the active dashboard, hidden on the others. */
export function addWellnessWidget(b: WellnessBoards, base: Omit<WellnessWidget, "id">): { boards: WellnessBoards; widget: WellnessWidget | null } {
  if (b.widgets.length >= MAX_WELLNESS_WIDGETS) return { boards: b, widget: null };
  const id = newWidgetId(b.widgets, base.title);
  const widget = sanitizeWellnessWidget({ ...base, id }, id);
  if (!widget) return { boards: b, widget: null };
  return { boards: withWidgets(b, [...b.widgets, widget]), widget };
}

/** Replace a card's description (the editor). An invalid edit changes nothing. */
export function updateWellnessWidget(b: WellnessBoards, next: WellnessWidget): WellnessBoards {
  const ok = sanitizeWellnessWidget(next, next.id);
  if (!ok || !b.widgets.some((w) => w.id === ok.id)) return b;
  return { ...b, widgets: b.widgets.map((w) => (w.id === ok.id ? ok : w)) };
}

/** A copy of a card, to vary. */
export function duplicateWellnessWidget(b: WellnessBoards, widgetId: string): { boards: WellnessBoards; widget: WellnessWidget | null } {
  const src = b.widgets.find((w) => w.id === widgetId);
  if (!src) return { boards: b, widget: null };
  const { id: _id, ...rest } = src;
  return addWellnessWidget(b, { ...rest, title: `${src.title.slice(0, 35)} copy` });
}

/** Remove a custom card from every dashboard. The records it read are untouched. */
export function removeWellnessWidget(b: WellnessBoards, widgetId: string): WellnessBoards {
  return withWidgets(b, b.widgets.filter((w) => w.id !== widgetId));
}

// ── Starting points ──────────────────────────────────────────────────────────

export interface WellnessTemplate {
  key: string;
  name: string;
  hint: string;
  cards: WellnessBuiltInCardId[];
  /** Widget Ideas it shows (created if the user does not have them yet). */
  ideas: string[];
}

export const WELLNESS_TEMPLATES: readonly WellnessTemplate[] = [
  { key: "overview", name: "Overview", hint: "Balanced summary of everything", cards: WELLNESS_CARD_IDS.filter((c) => !WELLNESS_DEFAULT_HIDDEN.includes(c)), ideas: [] },
  { key: "fitness", name: "Fitness", hint: "Running, workouts, strength, recovery", cards: ["activity", "sleep", "trends", "goals"], ideas: ["consistency", "sleep-exercise"] },
  { key: "medical", name: "Medical", hint: "Vitals, labs, medications, appointments", cards: ["body", "labs", "medications", "graphs", "symptoms"], ideas: [] },
  { key: "nutrition", name: "Nutrition", hint: "Food, hydration, weight and goals", cards: ["nutrition", "trends", "goals"], ideas: [] },
  { key: "mind", name: "Mind", hint: "Mood, energy, sleep and what you noted", cards: ["mood", "sleep", "symptoms"], ideas: ["mood-activity"] },
  { key: "blank", name: "Blank", hint: "Start empty and add what you want", cards: [], ideas: [] },
];

/**
 * Add a dashboard from a starting point and make it the active one. A Widget
 * Idea the template names is reused when the user already has a card by that
 * title, and created otherwise — hidden on the dashboards that existed.
 */
export function addWellnessDashboard(b: WellnessBoards, name: string, templateKey = "overview"): WellnessBoards {
  if (b.dashboards.length >= MAX_DASHBOARDS) return b;
  const t = WELLNESS_TEMPLATES.find((x) => x.key === templateKey) ?? WELLNESS_TEMPLATES[0];
  const clean = cleanBoardName(name) || t.name;
  const id = newBoardId(b.dashboards, clean);

  let widgets = b.widgets;
  const created: string[] = [];
  const shown: WellnessCardId[] = [];
  for (const key of t.ideas) {
    const base = WELLNESS_WIDGET_IDEAS.find((i) => i.key === key)?.widget;
    if (!base) continue;
    let w = widgets.find((x) => x.title === base.title);
    if (!w && widgets.length < MAX_WELLNESS_WIDGETS) {
      const wid = newWidgetId(widgets, base.title);
      w = sanitizeWellnessWidget({ ...base, id: wid }, wid) ?? undefined;
      if (w) { widgets = [...widgets, w]; created.push(w.id); }
    }
    if (w) shown.push(widgetCardId(w.id));
  }
  const keep = new Set<WellnessCardId>([...t.cards, ...shown]);
  const fresh: WellnessBoard = {
    id, name: clean,
    hidden: allWellnessCardIds(widgets).filter((c) => !keep.has(c)),
    order: [...t.cards, ...shown], sizes: {},
  };
  return { ...b, active: id, widgets, dashboards: [...b.dashboards.map((d) => carryWidgetChange(d, created, [])), fresh] };
}

/**
 * A new dashboard holding exactly these cards (the AI Builder's "make a
 * dashboard from these"). It becomes the active one; the cards start hidden on
 * every dashboard that already existed.
 */
export function addWellnessDashboardWithWidgets(b: WellnessBoards, name: string, bases: ReadonlyArray<Omit<WellnessWidget, "id">>): WellnessBoards {
  if (b.dashboards.length >= MAX_DASHBOARDS) return b;
  let next = addWellnessDashboard(b, name, "blank");
  for (const base of bases) next = addWellnessWidget(next, base).boards;
  return next;
}

export { MAX_DASHBOARDS };
