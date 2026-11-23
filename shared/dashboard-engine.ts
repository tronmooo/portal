// shared/dashboard-engine.ts — the one customizable-dashboard system.
//
// Owner, 2026-11-23: "The Executive and Wellness tabs should use the same
// customizable dashboard system … rather than building two different widget
// systems that eventually behave differently."
//
// What a customizable tab IS, whatever it shows:
//   - a fixed set of built-in cards plus cards the user built (`w:<id>`);
//   - a LAYOUT per dashboard: what is hidden, the order, the sizes;
//   - several named DASHBOARDS over the one set of cards, one of them active;
//   - cards are shared, layouts are not: a card built while editing one
//     dashboard starts hidden on the rest, and removing it removes it everywhere.
//
// The Executive tab (shared/exec-card-prefs, shared/exec-dashboards) and the
// Wellness tab (shared/wellness-dashboards) are both instances of this file.
// A rule about ordering, sizing or dashboards is changed HERE, never in one tab.
//
// Pure and deterministic. Pinned by tests/dashboard-engine.test.ts.

export type CardSize = "large" | "medium";

export const widgetCardId = (widgetId: string): `w:${string}` => `w:${widgetId}`;
export const isWidgetCardId = (id: string): id is `w:${string}` => id.startsWith("w:");

export interface CardLayout<Id extends string = string> {
  /** Cards switched off on this dashboard. */
  hidden: Id[];
  /** The user's order. Empty = the built-in order. */
  order: Id[];
  /** Sizes the user picked; a card with no entry keeps the built-in size. */
  sizes: Partial<Record<string, CardSize>>;
}

// ── Order ────────────────────────────────────────────────────────────────────

/** Every card in the user's order; cards never placed keep the built-in order after it. */
export function orderedCards<Id extends string>(all: readonly Id[], order: readonly Id[]): Id[] {
  const placed = order.filter((id) => all.includes(id));
  return [...placed, ...all.filter((id) => !placed.includes(id))];
}

/** The order with a card put at an index (drag and drop); null when nothing moves. */
export function placeCard<Id extends string>(all: readonly Id[], order: readonly Id[], id: Id, toIndex: number): Id[] | null {
  const next = orderedCards(all, order);
  const at = next.indexOf(id);
  if (at < 0) return null;
  const to = Math.max(0, Math.min(next.length - 1, toIndex));
  if (to === at) return null;
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

/** The order with a card moved one place earlier (-1) or later (+1); null when it cannot. */
export function moveCard<Id extends string>(all: readonly Id[], order: readonly Id[], id: Id, dir: -1 | 1): Id[] | null {
  const next = orderedCards(all, order);
  const at = next.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= next.length) return null;
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/**
 * Medium cards with no partner on a two-column (phone) grid: a medium card
 * followed by a large one, or left over at the end, would hold half a row
 * with nothing beside it. The tab lets such a card take the whole row on a
 * phone instead. `cards` is what is on screen, in order.
 */
export function lonelyMediumCards(cards: ReadonlyArray<{ id: string; size: CardSize }>): Set<string> {
  const lonely = new Set<string>();
  let open: string | null = null; // a medium card waiting for a partner
  for (const c of cards) {
    if (c.size === "large") {
      if (open) lonely.add(open);
      open = null;
    } else if (open) {
      open = null; // paired
    } else {
      open = c.id;
    }
  }
  if (open) lonely.add(open);
  return lonely;
}

/** A stored layout, cut down to the card ids that exist. */
export function cleanLayout<Id extends string>(raw: any, known: ReadonlySet<string>): CardLayout<Id> {
  const ids = (xs: unknown): Id[] => (Array.isArray(xs)
    ? Array.from(new Set(xs.filter((x): x is Id => typeof x === "string" && known.has(x)))) : []);
  const sizes: Partial<Record<string, CardSize>> = {};
  if (raw?.sizes && typeof raw.sizes === "object") {
    for (const [id, v] of Object.entries(raw.sizes)) if (known.has(id) && (v === "large" || v === "medium")) sizes[id] = v;
  }
  return { hidden: ids(raw?.hidden), order: ids(raw?.order), sizes };
}

// ── Several dashboards ───────────────────────────────────────────────────────

export const MAX_DASHBOARDS = 8;

export interface NamedBoard { id: string; name: string }
export interface BoardSet<D extends NamedBoard> { active: string; dashboards: D[] }

export const cleanBoardName = (raw: unknown) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
export const cleanBoardId = (raw: unknown) => String(raw ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);

export function activeBoard<D extends NamedBoard>(b: BoardSet<D>): D {
  return b.dashboards.find((d) => d.id === b.active) ?? b.dashboards[0];
}

export function setActiveBoard<D extends NamedBoard, B extends BoardSet<D>>(b: B, id: string): B {
  return b.dashboards.some((d) => d.id === id) ? { ...b, active: id } : b;
}

export function renameBoard<D extends NamedBoard, B extends BoardSet<D>>(b: B, id: string, name: string): B {
  const clean = cleanBoardName(name);
  if (!clean) return b;
  return { ...b, dashboards: b.dashboards.map((d) => (d.id === id ? { ...d, name: clean } : d)) };
}

/** Delete a dashboard (never the last one). The cards themselves are kept. */
export function removeBoard<D extends NamedBoard, B extends BoardSet<D>>(b: B, id: string): B {
  if (b.dashboards.length <= 1 || !b.dashboards.some((d) => d.id === id)) return b;
  const dashboards = b.dashboards.filter((d) => d.id !== id);
  return { ...b, dashboards, active: b.active === id ? dashboards[0].id : b.active };
}

/** A fresh dashboard id from its name. */
export function newBoardId(existing: ReadonlyArray<NamedBoard>, name: string): string {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "dashboard";
  for (let n = 2; existing.some((d) => d.id === id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
  return id;
}

/**
 * The OTHER dashboards after the set of custom cards changed while one was
 * being edited: a card ADDED starts hidden on them (building a card for one
 * dashboard must not drop it into another), and a card REMOVED leaves no
 * trace in any layout.
 */
export function carryWidgetChange<D extends NamedBoard & CardLayout>(
  d: D, addedWidgetIds: readonly string[], goneWidgetIds: readonly string[],
): D {
  const added = addedWidgetIds.map(widgetCardId) as string[];
  const gone = new Set<string>(goneWidgetIds.map(widgetCardId));
  return {
    ...d,
    hidden: Array.from(new Set([...d.hidden.filter((id) => !gone.has(id)), ...added])),
    order: d.order.filter((id) => !gone.has(id)),
    sizes: Object.fromEntries(Object.entries(d.sizes).filter(([id]) => !gone.has(id))),
  };
}

/** Which custom cards were added and which removed between two lists. */
export function widgetDiff(before: ReadonlyArray<{ id: string }>, after: ReadonlyArray<{ id: string }>): { added: string[]; gone: string[] } {
  const was = new Set(before.map((w) => w.id));
  const is = new Set(after.map((w) => w.id));
  return { added: after.filter((w) => !was.has(w.id)).map((w) => w.id), gone: before.filter((w) => !is.has(w.id)).map((w) => w.id) };
}

/** A fresh id for a card the user is adding. */
export function newWidgetId(existing: ReadonlyArray<{ id: string }>, seed: string): string {
  const base = String(seed ?? "").replace(/\s+/g, " ").trim().slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "widget";
  let id = base;
  for (let n = 2; existing.some((w) => w.id === id); n++) id = `${base}-${n}`;
  return id;
}
