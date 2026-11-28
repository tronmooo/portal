// A double click on the event form's Create: the first click saves and closes
// the form, the second lands on the month grid's day cell, whose double-click
// opened a NEW empty New Event form (integrity run, ui-planning.event,
// 2026-11-28 — recorded as a finding). The grid ignores a press that arrives
// within a double click's span of a form closing.
// Live: npx tsx tests/integrity/run.ts --only '^ui-planning\.event$' (isolated stack).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GRID_PRESS_AFTER_CLOSE_MS } from "../client/src/components/CalendarView";

const src = readFileSync("client/src/components/CalendarView.tsx", "utf8");

describe("the calendar grid does not take the second click of a form's button", () => {
  it("the window is a double click's span", () => {
    expect(GRID_PRESS_AFTER_CLOSE_MS).toBeGreaterThanOrEqual(400);
    expect(GRID_PRESS_AFTER_CLOSE_MS).toBeLessThanOrEqual(1000);
  });
  it("the day cell's click and double click both check it", () => {
    const cell = src.slice(src.indexOf("aria-pressed={isSelected}"), src.indexOf("data-testid={`day-cell-${day.date}`}"));
    expect(cell).toMatch(/onClick=\{\(\) => \{\s*if \(pressFollowsClose\(\)\) return;/);
    expect(cell).toMatch(/onDoubleClick=\{\(\) => \{ if \(pressFollowsClose\(\)\) return;/);
  });
  it("closing the add form and the edit form both start the window", () => {
    expect(src.match(/onClose=\{\(\) => \{ formClosedAt\.current = Date\.now\(\);/g)?.length).toBe(2);
  });
});
