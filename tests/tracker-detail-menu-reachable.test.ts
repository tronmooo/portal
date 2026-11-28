// The tracker detail's ⋯ menu (Rename, Delete) must not sit under the dialog's
// close X. The X is `absolute right-2 top-2` with a 44px touch target
// (components/ui/dialog.tsx), so it covers the 52px at the header's right.
// The header reserved that room with `pr-12`, but `sm:px-5` overrode the
// right padding from the `sm` breakpoint up: on a desktop the X covered the
// whole ⋯ button and a mouse could neither rename nor delete a tracker
// (integrity run ui-records.tracker, 2026-11-27).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SPACING_PX = (v: string) => Number(v) * 4;

/** The effective right padding (px) of a Tailwind class list at a breakpoint. */
function rightPadding(classes: string[], bp: "" | "sm" | "md" | "lg"): number | null {
  const order = ["", "sm", "md", "lg"];
  let out: number | null = null;
  for (const b of order.slice(0, order.indexOf(bp) + 1)) {
    // within one breakpoint `pr-*` is more specific than `px-*`/`p-*` in Tailwind's output order
    for (const prefix of ["p", "px", "pr"]) {
      for (const c of classes) {
        const m = c.match(new RegExp(`^${b ? `${b}:` : ""}${prefix}-(\\d+(?:\\.\\d+)?)$`));
        if (m) out = SPACING_PX(m[1]);
      }
    }
  }
  return out;
}

describe("tracker detail header leaves room for the dialog's close X", () => {
  const src = fs.readFileSync(path.join(__dirname, "../client/src/pages/trackers.tsx"), "utf8");
  const m = src.match(/className="(td-header [^"]+)"/);
  const dialog = fs.readFileSync(path.join(__dirname, "../client/src/components/ui/dialog.tsx"), "utf8");
  it("finds the header and the close button's footprint", () => {
    expect(m).toBeTruthy();
    expect(dialog).toMatch(/DialogPrimitive\.Close className="absolute right-2 top-2[^"]*min-w-\[44px\]/);
  });
  it.each(["", "sm", "md", "lg"] as const)("right padding at %s covers right-2 + 44px", (bp) => {
    const classes = m![1].split(/\s+/);
    const pr = rightPadding(classes, bp);
    expect(pr).not.toBeNull();
    expect(pr!).toBeGreaterThanOrEqual(8 + 44);
  });
});
