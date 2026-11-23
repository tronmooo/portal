// shared/exec-card-prefs.ts — which dashboard cards show, and in what order.
//
// Owner request 2026-11-22: "Give people control over how much they see" — a
// single panel to hide cards, reorder them and switch a quiet mode, remembered
// across sessions and devices. Stored as one preference row (`exec_card_prefs`),
// the way the Needs Attention filters are.
//
// Quiet mode is ON by default (owner: "My default would be Quiet Mode
// enabled"): the dashboard shows what needs attention, what is coming, money
// and tasks. The rest — habits, documents, wellness, recent activity — is one
// tap away, never gone: the dashboard names what is hidden (Rule 4).

import { sanitizeWidget, type ExecWidget } from "./exec-widgets";
// Ordering, sizing and the phone-grid rule are the shared dashboard engine's
// (shared/dashboard-engine) — the Wellness tab uses the same functions.
import * as engine from "./dashboard-engine";

export const EXEC_CARD_IDS = ["attention", "tasks", "schedule", "money", "habits", "documents", "wellness", "activity"] as const;
/** A built-in card. */
export type BuiltInCardId = (typeof EXEC_CARD_IDS)[number];
/** Any card on the tab: a built-in one, or a custom widget as `w:<widget id>`. */
export type ExecCardId = BuiltInCardId | `w:${string}`;

export type ExecCardSize = "large" | "medium";
/** The built-in layout: which cards take the full row on a phone. */
export const DEFAULT_CARD_SIZE: Record<BuiltInCardId, ExecCardSize> = {
  attention: "medium", tasks: "medium", schedule: "large", money: "large",
  habits: "large", documents: "medium", wellness: "medium", activity: "large",
};

export const widgetCardId = (widgetId: string): ExecCardId => `w:${widgetId}`;
export const isWidgetCardId = (id: string): id is `w:${string}` => id.startsWith("w:");

export const EXEC_CARD_TITLES: Record<BuiltInCardId, string> = {
  attention: "Needs Attention",
  tasks: "Tasks",
  schedule: "Timeline",
  money: "Money",
  habits: "Habits",
  documents: "Documents",
  wellness: "Wellness",
  activity: "Recent Activity",
};

/** One line under each title in the Customize panel. */
export const EXEC_CARD_HINTS: Record<BuiltInCardId, string> = {
  attention: "Expiring documents, important items, and alerts",
  tasks: "Things you decided to do",
  schedule: "Today's events, upcoming items, and reminders",
  money: "Assets, debt, net worth, and upcoming payments",
  habits: "Today's habits and check-ins",
  documents: "Recent uploads and key documents",
  wellness: "Latest health readings",
  activity: "What was logged recently",
};

/** A card's name, built-in or custom. */
export function execCardTitle(prefs: ExecCardPrefs, id: ExecCardId): string {
  if (isWidgetCardId(id)) return prefs.widgets.find((w) => widgetCardId(w.id) === id)?.title ?? "Custom card";
  return EXEC_CARD_TITLES[id];
}

/** What quiet mode keeps on screen. */
export const QUIET_MODE_CARDS: readonly BuiltInCardId[] = ["attention", "schedule", "money", "tasks"];

export interface ExecCardPrefs {
  /** Show only QUIET_MODE_CARDS. */
  quiet: boolean;
  /** Cards the user switched off themselves (applies with quiet mode off). */
  hidden: ExecCardId[];
  /** The user's order. Empty = the built-in order. */
  order: ExecCardId[];
  /** Sizes the user picked. A card with no entry keeps the built-in layout. */
  sizes: Partial<Record<string, ExecCardSize>>;
  /** Cards the user built (shared/exec-widgets). Shown in every mode: a card
   *  someone made is one they asked to see. */
  widgets: ExecWidget[];
}

export const DEFAULT_EXEC_CARD_PREFS: ExecCardPrefs = { quiet: true, hidden: [], order: [], sizes: {}, widgets: [] };

const isBuiltIn = (x: unknown): x is BuiltInCardId => typeof x === "string" && (EXEC_CARD_IDS as readonly string[]).includes(x);
/** Every card id these preferences know: the built-ins, then the widgets. */
export function allExecCardIds(prefs: Pick<ExecCardPrefs, "widgets">): ExecCardId[] {
  return [...EXEC_CARD_IDS, ...prefs.widgets.map((w) => widgetCardId(w.id))];
}

/** Read a stored blob; anything unrecognised falls back to the defaults. */
export function parseExecCardPrefs(raw: string | null | undefined): ExecCardPrefs {
  const base = (): ExecCardPrefs => ({ ...DEFAULT_EXEC_CARD_PREFS, hidden: [], order: [], sizes: {}, widgets: [] });
  if (!raw) return base();
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return base();
    const widgets: ExecWidget[] = [];
    for (const w of Array.isArray(saved.widgets) ? saved.widgets.slice(0, 20) : []) {
      const ok = sanitizeWidget(w);
      if (ok && !widgets.some((x) => x.id === ok.id)) widgets.push(ok);
    }
    const known = new Set<string>(allExecCardIds({ widgets }));
    const ids = (xs: unknown): ExecCardId[] => (Array.isArray(xs)
      ? Array.from(new Set(xs.filter((x): x is ExecCardId => typeof x === "string" && known.has(x)))) : []);
    const sizes: Partial<Record<string, ExecCardSize>> = {};
    if (saved.sizes && typeof saved.sizes === "object") {
      for (const [id, v] of Object.entries(saved.sizes)) if (known.has(id) && (v === "large" || v === "medium")) sizes[id] = v;
    }
    return {
      quiet: typeof saved.quiet === "boolean" ? saved.quiet : DEFAULT_EXEC_CARD_PREFS.quiet,
      hidden: ids(saved.hidden),
      order: ids(saved.order),
      sizes,
      widgets,
    };
  } catch {
    return base();
  }
}

/** Is this card on screen under these preferences? */
export function isExecCardVisible(prefs: ExecCardPrefs, id: ExecCardId): boolean {
  if (prefs.hidden.includes(id)) return false;
  // A card the user built is theirs to see in quiet mode too; quiet mode trims
  // the BUILT-IN cards down to the essentials.
  if (isWidgetCardId(id)) return true;
  if (prefs.quiet) return QUIET_MODE_CARDS.includes(id);
  return true;
}

/** The size a card is drawn at: the user's pick, else the built-in layout. */
export function execCardSize(prefs: ExecCardPrefs, id: ExecCardId): ExecCardSize {
  return prefs.sizes[id] ?? (isBuiltIn(id) ? DEFAULT_CARD_SIZE[id] : "medium");
}

/** Cards these preferences keep off screen, in display order. */
export function hiddenExecCards(prefs: ExecCardPrefs): ExecCardId[] {
  return orderedExecCards(prefs).filter((id) => !isExecCardVisible(prefs, id));
}

/** Every card in the user's order; cards they never placed keep the built-in order after it. */
export function orderedExecCards(prefs: ExecCardPrefs): ExecCardId[] {
  return engine.orderedCards(allExecCardIds(prefs), prefs.order);
}

/** A card's position (1-based), or null when the user never reordered (built-in layout applies). */
export function execCardPosition(prefs: ExecCardPrefs, id: ExecCardId): number | null {
  // With custom cards on the tab every card needs a place, so the built-in
  // (source-order) layout no longer applies on its own.
  if (prefs.order.length === 0 && prefs.widgets.length === 0) return null;
  return orderedExecCards(prefs).indexOf(id) + 1;
}

/** Put a card at a given index (drag and drop). */
export function placeExecCard(prefs: ExecCardPrefs, id: ExecCardId, toIndex: number): ExecCardPrefs {
  const order = engine.placeCard(allExecCardIds(prefs), prefs.order, id, toIndex);
  return order ? { ...prefs, order } : prefs;
}

export function setExecCardSize(prefs: ExecCardPrefs, id: ExecCardId, size: ExecCardSize): ExecCardPrefs {
  return { ...prefs, sizes: { ...prefs.sizes, [id]: size } };
}

/** Add a card the user built; it lands at the end and is shown. */
export function addExecWidget(prefs: ExecCardPrefs, widget: ExecWidget): ExecCardPrefs {
  if (prefs.widgets.some((w) => w.id === widget.id)) return prefs;
  return { ...prefs, widgets: [...prefs.widgets, widget] };
}

/** Remove a custom card and every trace of it in the layout. */
export function removeExecWidget(prefs: ExecCardPrefs, widgetId: string): ExecCardPrefs {
  const id = widgetCardId(widgetId);
  const { [id]: _gone, ...sizes } = prefs.sizes;
  return {
    ...prefs,
    widgets: prefs.widgets.filter((w) => w.id !== widgetId),
    hidden: prefs.hidden.filter((x) => x !== id),
    order: prefs.order.filter((x) => x !== id),
    sizes,
  };
}

/** "Reset to Default": the built-in layout and quiet mode. The cards the user
 *  built are kept — a reset of the layout is not a delete (Rule 8). */
export function resetExecCardLayout(prefs: ExecCardPrefs): ExecCardPrefs {
  return { ...DEFAULT_EXEC_CARD_PREFS, hidden: [], order: [], sizes: {}, widgets: prefs.widgets };
}

/** Move a card one place earlier (-1) or later (+1). */
export function moveExecCard(prefs: ExecCardPrefs, id: ExecCardId, dir: -1 | 1): ExecCardPrefs {
  const order = engine.moveCard(allExecCardIds(prefs), prefs.order, id, dir);
  return order ? { ...prefs, order } : prefs;
}

/**
 * Show or hide one card. Changing a single card while quiet mode is on leaves
 * quiet mode: the cards it was hiding stay hidden, so the screen changes by
 * exactly the one card the user touched.
 */
export function setExecCardVisible(prefs: ExecCardPrefs, id: ExecCardId, visible: boolean): ExecCardPrefs {
  const hiddenNow: ExecCardId[] = prefs.quiet
    ? Array.from(new Set<ExecCardId>([...prefs.hidden, ...EXEC_CARD_IDS.filter((c) => !QUIET_MODE_CARDS.includes(c))]))
    : prefs.hidden;
  const hidden = visible ? hiddenNow.filter((c) => c !== id) : Array.from(new Set<ExecCardId>([...hiddenNow, id]));
  return { ...prefs, quiet: false, hidden };
}

/** Medium cards with no partner on a phone's two-column grid (shared/dashboard-engine). */
export const lonelyMediumCards: (cards: ReadonlyArray<{ id: string; size: ExecCardSize }>) => Set<string> = engine.lonelyMediumCards;
