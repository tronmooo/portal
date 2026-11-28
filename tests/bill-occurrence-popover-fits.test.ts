// The bill occurrence popover opens from a pencil at the right edge of its row.
// On a desktop the html's "scrollbar-gutter: stable both-edges" shifts fixed
// popovers ~15 px right of where Radix places them, so the start-aligned
// popover ran past the window and its "Move" button could not be pressed by a
// mouse (integrity run, 2026-11-27, ui-money.bill). It opens aligned to its
// trigger's END, and every input beside a button may shrink (min-w-0 flex-1).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("bill occurrence popover rows", () => {
  it("open aligned to the pencil's end, and let their input shrink so the button stays inside", () => {
    const src = readFileSync(`${process.cwd()}/client/src/components/liability/BillScheduleSection.tsx`, "utf8");
    expect(src).toMatch(/<PopoverContent className="w-72 space-y-3" align="end"/);
    const rows = [...src.matchAll(/<div className="flex gap-1">\s*<Input([\s\S]*?)\/>/g)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const props of rows) {
      const cls = /className="([^"]*)"/.exec(props)?.[1] ?? "";
      expect(cls).toContain("min-w-0");
      expect(cls).toContain("flex-1");
    }
  });
});
