// Which dashboard cards show and in what order (shared/exec-card-prefs).
// Owner request 2026-11-22: hide / reorder cards and a quiet mode that is on
// by default, saved to the account.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXEC_CARD_PREFS, EXEC_CARD_IDS, QUIET_MODE_CARDS,
  parseExecCardPrefs, isExecCardVisible, hiddenExecCards, orderedExecCards,
  execCardPosition, moveExecCard, setExecCardVisible,
} from "../shared/exec-card-prefs";

describe("exec card preferences", () => {
  it("defaults to quiet mode: alerts, timeline, money and tasks", () => {
    const p = parseExecCardPrefs(null);
    expect(p).toEqual({ quiet: true, hidden: [], order: [] });
    expect(EXEC_CARD_IDS.filter((id) => isExecCardVisible(p, id)).sort()).toEqual([...QUIET_MODE_CARDS].sort());
    expect(hiddenExecCards(p)).toEqual(["habits", "documents", "wellness", "activity"]);
  });

  it("reads a saved choice and ignores anything it does not recognise", () => {
    expect(parseExecCardPrefs(JSON.stringify({ quiet: false, hidden: ["money", "nope", "money"], order: ["money", 7] })))
      .toEqual({ quiet: false, hidden: ["money"], order: ["money"] });
    expect(parseExecCardPrefs("not json")).toEqual(DEFAULT_EXEC_CARD_PREFS);
    expect(parseExecCardPrefs("[]")).toEqual({ quiet: true, hidden: [], order: [] });
  });

  it("with quiet mode off, only the cards the user hid are hidden", () => {
    const p = { quiet: false, hidden: ["wellness" as const], order: [] };
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

  it("keeps cards the user never placed, after the ones they did", () => {
    expect(orderedExecCards({ quiet: false, hidden: [], order: ["money"] }))
      .toEqual(["money", "attention", "tasks", "schedule", "habits", "documents", "wellness", "activity"]);
  });

  it("touching one card in quiet mode changes exactly that card", () => {
    // Showing Habits leaves quiet mode, but what quiet mode hid stays hidden.
    const shown = setExecCardVisible(DEFAULT_EXEC_CARD_PREFS, "habits", true);
    expect(shown.quiet).toBe(false);
    expect(EXEC_CARD_IDS.filter((id) => isExecCardVisible(shown, id)).sort())
      .toEqual([...QUIET_MODE_CARDS, "habits"].sort());
    // Hiding Money from quiet mode hides Money and nothing else new.
    const hid = setExecCardVisible(DEFAULT_EXEC_CARD_PREFS, "money", false);
    expect(EXEC_CARD_IDS.filter((id) => isExecCardVisible(hid, id)).sort()).toEqual(["attention", "schedule", "tasks"]);
  });
});
