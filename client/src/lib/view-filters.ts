// ─── Presentation filters: rules 3 and 4 ────────────────────────────────────
//
// A filter chip, a section tab, a "Has children" pill, a type picker: these
// change WHAT IS SHOWN, never what exists. Two failures made them look like
// data loss, and both are handled here once instead of on each screen:
//
//   1. A filter outlived the gesture that set it. The Assets tab kept its
//      nesting filter in sessionStorage, so a single tap on "Has children"
//      followed the user to every later visit of the tab (user report
//      2026-10-09: "I pressed on bubbles and now all my assets are missing").
//      Filters made with this module live in component state and are reset
//      whenever the section they belong to changes — never persisted.
//
//   2. The control that showed (and cleared) a filter could disappear while
//      the filter stayed on. The chip row rendered only when there was more
//      than one option, and its options were counted AFTER the filter — so
//      with one asset left there was one option, the row vanished, and nothing
//      on screen said a filter was hiding the other four. `showFilterControls`
//      keeps the controls up for as long as any filter is active, and
//      `emptyReason` tells an empty screen apart from an empty account.
//
// Everything here is pure except the hook, so the rules are unit-tested
// directly (tests/sync-rules-filters.test.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { syncLog } from "@shared/sync-log";

export interface ViewFilterState {
  /** Stable name ("assetNesting"), used in logs and test ids. */
  key: string;
  /** What the user sees for the CURRENT value ("Has children"). */
  label: string;
  value: string;
  defaultValue: string;
}

export function isViewFilterActive(f: Pick<ViewFilterState, "value" | "defaultValue">): boolean {
  return f.value !== f.defaultValue;
}

export function activeViewFilters<T extends Pick<ViewFilterState, "value" | "defaultValue">>(filters: readonly T[]): T[] {
  return filters.filter(isViewFilterActive);
}

/**
 * Should a filter control row render?
 *
 * More than one option to choose between — OR any filter in the row is on.
 * The second half is the whole fix for "my records vanished": a row that can
 * hide itself while it is filtering is a filter the user can neither see nor
 * clear.
 */
export function showFilterControls(
  optionCount: number,
  filters: readonly Pick<ViewFilterState, "value" | "defaultValue">[],
): boolean {
  return optionCount > 1 || activeViewFilters(filters).length > 0;
}

export type EmptyReason =
  /** Something is on screen; no empty state at all. */
  | "none"
  /** Records exist but the active filters hide all of them. */
  | "filtered"
  /** The request failed and nothing was ever loaded — not "no records". */
  | "error"
  /** Not known yet. */
  | "loading"
  /** Genuinely nothing here. */
  | "empty";

/**
 * Why is this list empty? The only answer that may say "No X yet" is
 * `"empty"`; every other one must say what is actually going on (rule 4: a
 * filter cannot masquerade as deletion; rule 10: a failed request is not an
 * empty account).
 */
export function emptyReason(input: {
  /** Rows on screen after every filter. */
  shown: number;
  /** Rows in scope BEFORE the presentation filters. */
  total: number;
  filters?: readonly Pick<ViewFilterState, "value" | "defaultValue">[];
  loading?: boolean;
  error?: boolean;
}): EmptyReason {
  if (input.shown > 0) return "none";
  if (input.total > 0 && activeViewFilters(input.filters || []).length > 0) return "filtered";
  if (input.error) return "error";
  if (input.loading) return "loading";
  return "empty";
}

/** "Showing 1 of 5 assets" — the line an active filter must always carry. */
export function filterSummary(shown: number, total: number, noun: { one: string; many: string }): string {
  const word = total === 1 ? noun.one : noun.many;
  return `Showing ${shown} of ${total} ${word}`;
}

/**
 * A presentation filter that belongs to one section of a page.
 *
 * Plain component state — deliberately NOT sessionStorage/localStorage — and
 * reset to its default whenever `sectionKey` changes, so moving between major
 * sections (Assets → Documents) never carries a temporary filter along. The
 * page unmounting (Assets → Executive) drops it too, which is the point.
 */
export function useSectionFilter<T extends string>(
  sectionKey: string,
  name: string,
  defaultValue: T,
): [T, (next: T) => void, () => void] {
  const [value, setValue] = useState<T>(defaultValue);
  const lastSection = useRef(sectionKey);
  useEffect(() => {
    if (lastSection.current === sectionKey) return;
    lastSection.current = sectionKey;
    setValue((cur) => {
      if (cur !== defaultValue) syncLog("filter", `reset ${name} on section change`, { from: cur, section: sectionKey });
      return defaultValue;
    });
  }, [sectionKey, defaultValue, name]);
  const set = useCallback((next: T) => {
    setValue(next);
    syncLog("filter", next === defaultValue ? `cleared ${name}` : `applied ${name}`, { value: next, section: sectionKey });
  }, [defaultValue, name, sectionKey]);
  const reset = useCallback(() => set(defaultValue), [set, defaultValue]);
  return [value, set, reset];
}
