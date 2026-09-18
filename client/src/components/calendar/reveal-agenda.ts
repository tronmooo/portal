// Bring the selected day's agenda panel to the reader.
//
// In month view the panel sits beside the grid on a wide screen and BELOW
// the whole grid (and its legend) on anything narrower. "+3 more" selected
// the day and highlighted the cell, and the items it promised rendered far
// below the fold with no scroll (QA 2026-09-18 F-26). `block: "nearest"`
// leaves a panel that is already on screen alone, so the wide layout does
// not jump.

export type RevealSchedule = (fn: () => void) => void;

const nextFrame: RevealSchedule = (fn) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
  else setTimeout(fn, 0);
};

/**
 * Scroll `el` into view (once it has re-rendered with the new day) and move
 * focus to it. Returns false when there is nothing to reveal.
 */
export function revealAgendaPanel(el: HTMLElement | null | undefined, schedule: RevealSchedule = nextFrame): boolean {
  if (!el) return false;
  schedule(() => {
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
  });
  return true;
}
