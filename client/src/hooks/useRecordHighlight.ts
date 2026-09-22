// client/src/hooks/useRecordHighlight.ts — land on a RECORD, not a page.
//
// Rules 23/24 (2026-09-22). A canonical route for a list-page entity carries
// `?highlight=<type>:<id>` (shared/entity-routes → shared/record-highlight).
// The page mounts this hook with the type(s) it renders; the hook reads the
// param from the hash route the same way finance.tsx does, strips it so a
// refresh does not re-flash, then waits for the element that carries
// `data-record-id="<id>"` (list data loads asynchronously), scrolls it into
// view and lights it for HIGHLIGHT_MS.
//
// Pages that render the row themselves only need `data-record-id` on the row.
// Pages that can do better (the calendar selecting the day) also get the
// parsed highlight back and act on it.

import { useEffect, useState } from "react";
import { parseHighlight, stripHighlight, HIGHLIGHT_MS, type RecordHighlight } from "@shared/record-highlight";

export const HIGHLIGHT_CLASS = "record-highlight";
/** How long to keep looking for the row while its list is still loading. */
const FIND_TIMEOUT_MS = 6000;
const FIND_INTERVAL_MS = 150;

function readHighlight(types: readonly string[]): RecordHighlight | null {
  try {
    const h = parseHighlight(window.location.hash || "");
    if (!h) return null;
    return types.length === 0 || types.includes(h.type) ? h : null;
  } catch { return null; }
}

function stripFromUrl(): void {
  try {
    const hash = window.location.hash || "";
    const cleaned = stripHighlight(hash);
    if (cleaned !== hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
    }
  } catch { /* ignore */ }
}

/** Scroll `el` into view and flash it. Exported so tests and pages can reuse it. */
export function flashRecordElement(el: HTMLElement): () => void {
  try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* jsdom */ }
  el.classList.add(HIGHLIGHT_CLASS);
  el.setAttribute("data-highlighted", "true");
  const t = setTimeout(() => {
    el.classList.remove(HIGHLIGHT_CLASS);
    el.removeAttribute("data-highlighted");
  }, HIGHLIGHT_MS);
  return () => { clearTimeout(t); el.classList.remove(HIGHLIGHT_CLASS); el.removeAttribute("data-highlighted"); };
}

export interface UseRecordHighlightOptions {
  /** Called once with the highlight before the row lookup starts (open a tab, pick a date…). */
  onHighlight?: (h: RecordHighlight) => void;
  /** Skip the DOM lookup entirely (the page lights the row from state instead). */
  manual?: boolean;
}

/**
 * The record this page was asked to land on, or null. `types` is the
 * highlight type (or types) this page renders; a highlight for another type
 * is ignored and left in the URL for whoever reads it.
 */
export function useRecordHighlight(
  types: string | readonly string[],
  opts: UseRecordHighlightOptions = {},
): RecordHighlight | null {
  const list = typeof types === "string" ? [types] : types;
  const key = list.join(",");
  const [highlight, setHighlight] = useState<RecordHighlight | null>(() => readHighlight(list));

  // A second search while already on the page changes only the hash query.
  useEffect(() => {
    const check = () => { const h = readHighlight(list); if (h) setHighlight(h); };
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!highlight) return;
    stripFromUrl();
    try { opts.onHighlight?.(highlight); } catch { /* page's business */ }
    if (opts.manual) return;
    let cancelled = false;
    let undo: (() => void) | null = null;
    const started = Date.now();
    const selector = `[data-record-id="${String(highlight.id).replace(/"/g, '\\"')}"]`;
    const tick = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(selector);
      if (el) { undo = flashRecordElement(el); return; }
      if (Date.now() - started < FIND_TIMEOUT_MS) timer = setTimeout(tick, FIND_INTERVAL_MS);
    };
    let timer = setTimeout(tick, 0);
    return () => { cancelled = true; clearTimeout(timer); undo?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.type, highlight?.id]);

  return highlight;
}
