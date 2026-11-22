// Which dashboard cards show, in what order and at what size, and the cards
// the user built (shared/exec-card-prefs). Owner request 2026-11-22.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXEC_CARD_PREFS, EXEC_CARD_IDS, QUIET_MODE_CARDS,
  parseExecCardPrefs, isExecCardVisible, hiddenExecCards, orderedExecCards,
  execCardPosition, moveExecCard, setExecCardVisible, placeExecCard,
  execCardSize, setExecCardSize, addExecWidget, removeExecWidget, resetExecCardLayout, execCardTitle, lonelyMediumCards,
  type ExecCardPrefs,
} from "../shared/exec-card-prefs";

const prefs = (over: Partial<ExecCardPrefs> = {}): ExecCardPrefs => ({ quiet: false, hidden: [], order: [], sizes: {}, widgets: [], ...over });
const journal = { id: "journal", title: "Recent Journal", icon: "book" as const, source: "journal" as const, limit: 3 };

describe("exec card preferences", () => {
  it("defaults to quiet mode: alerts, timeline, money and tasks", () => {
    const p = parseExecCardPrefs(null);
    expect(p).toEqual({ quiet: true, hidden: [], order: [], sizes: {}, widgets: [] });
    expect(EXEC_CARD_IDS.filter((id) => isExecCardVisible(p, id)).sort()).toEqual([...QUIET_MODE_CARDS].sort());
    expect(hiddenExecCards(p)).toEqual(["habits", "documents", "wellness", "activity"]);
  });

  it("reads a saved choice and ignores anything it does not recognise", () => {
    expect(parseExecCardPrefs(JSON.stringify({ quiet: false, hidden: ["money", "nope", "money"], order: ["money", 7], sizes: { money: "medium", tasks: "huge", nope: "large" } })))
      .toEqual({ quiet: false, hidden: ["money"], order: ["money"], sizes: { money: "medium" }, widgets: [] });
    expect(parseExecCardPrefs("not json")).toEqual(DEFAULT_EXEC_CARD_PREFS);
    expect(parseExecCardPrefs("[]")).toEqual(DEFAULT_EXEC_CARD_PREFS);
    // A choice saved before sizes and widgets existed still reads.
    expect(parseExecCardPrefs(JSON.stringify({ quiet: false, hidden: [], order: [] }))).toEqual(prefs());
  });

  it("never hands out the same default object twice", () => {
    const a = parseExecCardPrefs(null);
    a.hidden.push("money");
    expect(parseExecCardPrefs(null).hidden).toEqual([]);
  });

  it("with quiet mode off, only the cards the user hid are hidden", () => {
    const p = prefs({ hidden: ["wellness"] });
    expect(isExecCardVisible(p, "wellness")).toBe(false);
    expect(isExecCardVisible(p, "habits")).toBe(true);
    expect(hiddenExecCards(p)).toEqual(["wellness"]);
  });

  it("has no explicit positions until the user reorders", () => {
    expect(execCardPosition(DEFAULT_EXEC_CARD_PREFS, "money")).toBeNull();
    const moved = moveExecCard(DEFAULT_EXEC_CARD_PREFS, "money", -1);
    expect(orderedExecCards(moved).slice(0, 4)).toEqual(["attention", "tasks", "money", "schedule"]);
    expect(execCardPosition(moved, "money")).toBe(3);
    expect(execCardPosition(moved, "schedule")).toBe(4);
  });

  it("does not move a card past either end", () => {
    expect(moveExecCard(DEFAULT_EXEC_CARD_PREFS, "attention", -1)).toBe(DEFAULT_EXEC_CARD_PREFS);
    expect(moveExecCard(DEFAULT_EXEC_CARD_PREFS, "activity", 1)).toBe(DEFAULT_EXEC_CARD_PREFS);
  });

  it("drops a dragged card where it was let go", () => {
    const p = placeExecCard(prefs(), "activity", 0);
    expect(orderedExecCards(p)[0]).toBe("activity");
    expect(orderedExecCards(placeExecCard(p, "activity", 99)).slice(-1)).toEqual(["activity"]);
    expect(placeExecCard(prefs(), "attention", 0)).toEqual(prefs()); // already there
  });

  it("keeps cards the user never placed, after the ones they did", () => {
    expect(orderedExecCards(prefs({ order: ["money"] })))
      .toEqual(["money", "attention", "tasks", "schedule", "habits", "documents", "wellness", "activity"]);
  });

  it("touching one card in quiet mode changes exactly that card", () => {
    const shown = setExecCardVisible(DEFAULT_EXEC_CARD_PREFS, "habits", true);
    expect(shown.quiet).toBe(false);
    expect(EXEC_CARD_IDS.filter((id) => isExecCardVisible(shown, id)).sort())
      .toEqual([...QUIET_MODE_CARDS, "habits"].sort());
    const hid = setExecCardVisible(DEFAULT_EXEC_CARD_PREFS, "money", false);
    expect(EXEC_CARD_IDS.filter((id) => isExecCardVisible(hid, id)).sort()).toEqual(["attention", "schedule", "tasks"]);
  });
});

describe("card sizes", () => {
  it("uses the built-in layout until the user picks a size", () => {
    expect(execCardSize(prefs(), "money")).toBe("large");
    expect(execCardSize(prefs(), "tasks")).toBe("medium");
    const p = setExecCardSize(prefs(), "tasks", "large");
    expect(execCardSize(p, "tasks")).toBe("large");
    expect(p.sizes).toEqual({ tasks: "large" });
  });
});

describe("cards the user built", () => {
  it("are part of the tab: listed, ordered, titled, and shown in quiet mode", () => {
    const p = addExecWidget(parseExecCardPrefs(null), journal);
    expect(orderedExecCards(p).slice(-1)).toEqual(["w:journal"]);
    expect(isExecCardVisible(p, "w:journal")).toBe(true); // quiet mode trims built-ins only
    expect(execCardTitle(p, "w:journal")).toBe("Recent Journal");
    expect(execCardSize(p, "w:journal")).toBe("medium");
    // With a custom card on the tab every card has a position.
    expect(execCardPosition(p, "attention")).toBe(1);
    expect(execCardPosition(p, "w:journal")).toBe(9);
    // …and can be hidden like any other.
    expect(isExecCardVisible(setExecCardVisible(p, "w:journal", false), "w:journal")).toBe(false);
  });

  it("survive a save and a reload, and a malformed one is dropped", () => {
    const stored = JSON.stringify({ quiet: false, hidden: ["w:journal"], order: ["w:journal", "money"], sizes: { "w:journal": "large" },
      widgets: [journal, { id: "bad", title: "x", source: "passwords" }, journal] });
    const p = parseExecCardPrefs(stored);
    expect(p.widgets).toEqual([journal]);
    expect(p.order).toEqual(["w:journal", "money"]);
    expect(p.hidden).toEqual(["w:journal"]);
    expect(p.sizes).toEqual({ "w:journal": "large" });
  });

  it("removing one clears every trace of it", () => {
    const p = removeExecWidget(prefs({ widgets: [journal], hidden: ["w:journal"], order: ["w:journal", "money"], sizes: { "w:journal": "large", money: "medium" } }), "journal");
    expect(p).toEqual(prefs({ order: ["money"], sizes: { money: "medium" } }));
  });

  it("adding the same card twice adds it once", () => {
    const p = addExecWidget(prefs(), journal);
    expect(addExecWidget(p, journal)).toBe(p);
  });

  it("Reset to Default restores the layout and keeps what the user built", () => {
    const p = resetExecCardLayout(prefs({ widgets: [journal], hidden: ["money"], order: ["money"], sizes: { money: "medium" } }));
    expect(p).toEqual({ quiet: true, hidden: [], order: [], sizes: {}, widgets: [journal] });
  });
});

describe("no half-empty rows on a phone", () => {
  const cards = (spec: string) => spec.split(" ").map((c, i) => ({ id: `${c}${i}`, size: c === "L" ? "large" as const : "medium" as const }));
  it("finds the medium cards that have nobody beside them", () => {
    expect([...lonelyMediumCards(cards("M M L L"))]).toEqual([]);
    expect([...lonelyMediumCards(cards("M L M M"))]).toEqual(["M0"]);        // before a large card
    expect([...lonelyMediumCards(cards("L M M M"))]).toEqual(["M3"]);        // left over at the end
    expect([...lonelyMediumCards(cards("M L M L M"))]).toEqual(["M0", "M2", "M4"]);
    expect([...lonelyMediumCards([])]).toEqual([]);
  });
});
