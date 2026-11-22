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

export const EXEC_CARD_IDS = ["attention", "tasks", "schedule", "money", "habits", "documents", "wellness", "activity"] as const;
export type ExecCardId = (typeof EXEC_CARD_IDS)[number];

export const EXEC_CARD_TITLES: Record<ExecCardId, string> = {
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
export const EXEC_CARD_HINTS: Record<ExecCardId, string> = {
  attention: "Expired documents and deadlines worth reviewing",
  tasks: "Things you decided to do",
  schedule: "Today's events and what is coming up",
  money: "Assets, debt, this month and upcoming payments",
  habits: "Today's habits and check-ins",
  documents: "Your library and recent uploads",
  wellness: "Latest health readings",
  activity: "What was logged recently",
};

/** What quiet mode keeps on screen. */
export const QUIET_MODE_CARDS: readonly ExecCardId[] = ["attention", "schedule", "money", "tasks"];

export interface ExecCardPrefs {
  /** Show only QUIET_MODE_CARDS. */
  quiet: boolean;
  /** Cards the user switched off themselves (applies with quiet mode off). */
  hidden: ExecCardId[];
  /** The user's order. Empty = the built-in order. */
  order: ExecCardId[];
}

export const DEFAULT_EXEC_CARD_PREFS: ExecCardPrefs = { quiet: true, hidden: [], order: [] };

const isId = (x: unknown): x is ExecCardId => typeof x === "string" && (EXEC_CARD_IDS as readonly string[]).includes(x);
const uniqueIds = (xs: unknown): ExecCardId[] => (Array.isArray(xs) ? Array.from(new Set(xs.filter(isId))) : []);

/** Read a stored blob; anything unrecognised falls back to the defaults. */
export function parseExecCardPrefs(raw: string | null | undefined): ExecCardPrefs {
  if (!raw) return { ...DEFAULT_EXEC_CARD_PREFS };
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return { ...DEFAULT_EXEC_CARD_PREFS };
    return {
      quiet: typeof saved.quiet === "boolean" ? saved.quiet : DEFAULT_EXEC_CARD_PREFS.quiet,
      hidden: uniqueIds(saved.hidden),
      order: uniqueIds(saved.order),
    };
  } catch {
    return { ...DEFAULT_EXEC_CARD_PREFS };
  }
}

/** Is this card on screen under these preferences? */
export function isExecCardVisible(prefs: ExecCardPrefs, id: ExecCardId): boolean {
  if (prefs.quiet) return QUIET_MODE_CARDS.includes(id);
  return !prefs.hidden.includes(id);
}

/** Cards these preferences keep off screen, in display order. */
export function hiddenExecCards(prefs: ExecCardPrefs): ExecCardId[] {
  return orderedExecCards(prefs).filter((id) => !isExecCardVisible(prefs, id));
}

/** Every card in the user's order; cards they never placed keep the built-in order after it. */
export function orderedExecCards(prefs: ExecCardPrefs): ExecCardId[] {
  const placed = prefs.order.filter(isId);
  return [...placed, ...EXEC_CARD_IDS.filter((id) => !placed.includes(id))];
}

/** A card's position (1-based), or null when the user never reordered (built-in layout applies). */
export function execCardPosition(prefs: ExecCardPrefs, id: ExecCardId): number | null {
  if (prefs.order.length === 0) return null;
  return orderedExecCards(prefs).indexOf(id) + 1;
}

/** Move a card one place earlier (-1) or later (+1). */
export function moveExecCard(prefs: ExecCardPrefs, id: ExecCardId, dir: -1 | 1): ExecCardPrefs {
  const order = orderedExecCards(prefs);
  const at = order.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= order.length) return prefs;
  [order[at], order[to]] = [order[to], order[at]];
  return { ...prefs, order };
}

/**
 * Show or hide one card. Changing a single card while quiet mode is on leaves
 * quiet mode: the cards it was hiding stay hidden, so the screen changes by
 * exactly the one card the user touched.
 */
export function setExecCardVisible(prefs: ExecCardPrefs, id: ExecCardId, visible: boolean): ExecCardPrefs {
  const hiddenNow = prefs.quiet ? EXEC_CARD_IDS.filter((c) => !QUIET_MODE_CARDS.includes(c)) : prefs.hidden;
  const hidden = visible ? hiddenNow.filter((c) => c !== id) : Array.from(new Set([...hiddenNow, id]));
  return { ...prefs, quiet: false, hidden };
}
