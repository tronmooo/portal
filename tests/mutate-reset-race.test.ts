import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Regression tripwire for the mutate-then-reset race (2026-07-01).
 *
 * Bug class: a submit handler calls `someMutation.mutate()` with NO variables
 * and then synchronously resets the form state its mutationFn reads. React
 * Query re-reads the mutationFn closure after the reset re-render, so the
 * request is built from the EMPTIED form. Users saw "Amount must be a positive
 * number" / "source is required" / "Please fill in at least one field" on
 * fully-filled forms (expense, paycheck, income, cashflow, tracker entries,
 * tracker create, calendar quick-add/event/obligation/birthday/task).
 *
 * Fix: payloads are snapshotted in the click handler and passed as mutation
 * VARIABLES. This test fails if a no-arg `.mutate();` immediately followed by
 * a `setX(...)` reset reappears in the previously-affected files.
 */
const FILES = [
  "client/src/pages/finance.tsx",
  "client/src/pages/trackers.tsx",
  "client/src/components/CalendarManagerPanel.tsx",
];

// `.mutate();` (no args) then — allowing comment lines between — a setState
// reset call with an "empty" argument shape on the following lines.
const RACE = /\.mutate\(\);(?:\s*(?:\/\/[^\n]*)?\n){0,3}\s*set[A-Z]\w*\(\s*(?:""|''|\{\}|\[\]|null|false)/;

describe("mutate-then-reset race regression guard", () => {
  for (const rel of FILES) {
    it(`${rel} has no no-arg mutate() followed by a state reset`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const m = src.match(RACE);
      expect(
        m,
        m ? `Found the race pattern near: ${m[0].slice(0, 120)}… — pass the payload as mutation variables instead.` : undefined,
      ).toBeNull();
    });
  }
});
