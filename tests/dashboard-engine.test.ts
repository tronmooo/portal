// The one customizable-dashboard system (shared/dashboard-engine) the
// Executive and Wellness tabs both run on. A rule about order, sizes or
// several dashboards is pinned HERE, once, and each tab is checked to be an
// instance of it rather than a copy.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  carryWidgetChange, cleanLayout, lonelyMediumCards, moveCard, newBoardId, newWidgetId, orderedCards, placeCard, removeBoard,
  renameBoard, setActiveBoard, widgetCardId, widgetDiff,
} from "../shared/dashboard-engine";
import { lonelyMediumCards as execLonely, orderedExecCards, parseExecCardPrefs } from "../shared/exec-card-prefs";

const ALL = ["a", "b", "c", "d"];

describe("card order", () => {
  it("keeps the built-in order for cards the user never placed, after the ones they did", () => {
    expect(orderedCards(ALL, [])).toEqual(ALL);
    expect(orderedCards(ALL, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
    // An id that no longer exists is ignored, not kept as a hole.
    expect(orderedCards(ALL, ["gone", "d"])).toEqual(["d", "a", "b", "c"]);
  });

  it("places and moves a card, and answers null when nothing moves", () => {
    expect(placeCard(ALL, [], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(placeCard(ALL, [], "a", 0)).toBeNull();
    expect(placeCard(ALL, [], "nope", 1)).toBeNull();
    expect(moveCard(ALL, [], "b", 1)).toEqual(["a", "c", "b", "d"]);
    expect(moveCard(ALL, [], "a", -1)).toBeNull();
  });

  it("a medium card with nobody beside it is lonely; a pair is not", () => {
    const lonely = lonelyMediumCards([
      { id: "m1", size: "medium" }, { id: "m2", size: "medium" }, { id: "m3", size: "medium" }, { id: "L", size: "large" }, { id: "m4", size: "medium" },
    ]);
    expect([...lonely].sort()).toEqual(["m3", "m4"]);
  });

  it("a stored layout keeps only cards that exist and sizes that are sizes", () => {
    const l = cleanLayout({ hidden: ["a", "zzz", "a"], order: ["b", 4, "a"], sizes: { a: "medium", b: "huge", zzz: "large" } }, new Set(ALL));
    expect(l).toEqual({ hidden: ["a"], order: ["b", "a"], sizes: { a: "medium" } });
    expect(cleanLayout(null, new Set(ALL))).toEqual({ hidden: [], order: [], sizes: {} });
  });
});

describe("several dashboards over one set of cards", () => {
  const boards = { active: "one", dashboards: [{ id: "one", name: "One" }, { id: "two", name: "Two" }] };

  it("switches, renames and deletes — but never the last one", () => {
    expect(setActiveBoard(boards, "two").active).toBe("two");
    expect(setActiveBoard(boards, "nope")).toBe(boards);
    expect(renameBoard(boards, "two", "  Fitness   plan ").dashboards[1].name).toBe("Fitness plan");
    expect(renameBoard(boards, "two", "   ")).toBe(boards);
    const one = removeBoard(boards, "one");
    expect(one.dashboards.map((d) => d.id)).toEqual(["two"]);
    expect(one.active).toBe("two");
    expect(removeBoard(one, "two")).toBe(one);
  });

  it("makes fresh ids that do not collide", () => {
    expect(newBoardId(boards.dashboards, "One")).toBe("one-2");
    expect(newBoardId(boards.dashboards, "My Fitness!")).toBe("my-fitness");
    expect(newWidgetId([{ id: "sleep" }], "Sleep")).toBe("sleep-2");
  });

  it("a card added elsewhere starts hidden here; a removed card leaves no trace", () => {
    const d = { id: "two", name: "Two", hidden: ["w:old", "a"], order: ["w:old", "a"], sizes: { "w:old": "medium" as const, a: "large" as const } };
    const { added, gone } = widgetDiff([{ id: "old" }, { id: "kept" }], [{ id: "kept" }, { id: "new" }]);
    expect({ added, gone }).toEqual({ added: ["new"], gone: ["old"] });
    const next = carryWidgetChange(d, added, gone);
    expect(next.hidden).toEqual(["a", widgetCardId("new")]);
    expect(next.order).toEqual(["a"]);
    expect(next.sizes).toEqual({ a: "large" });
  });
});

describe("both tabs are instances of the engine, not copies of it", () => {
  it("the Executive tab's order and phone-grid rule ARE the engine's", () => {
    expect(execLonely).toBe(lonelyMediumCards);
    const prefs = { ...parseExecCardPrefs(null), order: ["money", "tasks"] as any };
    expect(orderedExecCards(prefs).slice(0, 2)).toEqual(["money", "tasks"]);
  });

  it.each(["shared/exec-card-prefs.ts", "shared/exec-dashboards.ts", "shared/wellness-dashboards.ts"])("%s imports the engine", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/from "\.\/dashboard-engine"/);
  });

  it("neither tab re-implements the reorder splice or the lonely-card walk", () => {
    for (const file of ["shared/exec-card-prefs.ts", "shared/exec-dashboards.ts", "shared/wellness-dashboards.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\.splice\(/);
      expect(src, file).not.toMatch(/waiting for a partner/);
    }
  });
});
