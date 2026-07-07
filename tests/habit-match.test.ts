import { describe, it, expect } from "vitest";
import { matchHabitByName, habitTokens, normalizeHabitText } from "../shared/habit-match";

// Regression for the reported bug: the user has a habit named "POOP" and typed
// "I pooped today, mark off habit" in the AI chat. The model extracted the verb
// "pooped" as the habit name, but the old lookup did
// `habit.name.toLowerCase().includes("pooped")` → "poop".includes("pooped") is
// FALSE, so the assistant replied "No habit matching 'poop' found in your data."
// These tests pin the stem-aware, bidirectional matcher so it can't regress.

const HABITS = [
  { id: "1", name: "Stretch Every Morning" },
  { id: "2", name: "POOP" },
  { id: "3", name: "Take Creatine" },
  { id: "4", name: "Take Lisinopril" },
  { id: "5", name: "Test Habit QA" },
];

describe("matchHabitByName", () => {
  it("matches the verb 'pooped' to the 'POOP' habit (the reported bug)", () => {
    expect(matchHabitByName(HABITS, "pooped")?.id).toBe("2");
  });

  it("matches a whole sentence like the user typed", () => {
    expect(matchHabitByName(HABITS, "I pooped today mark off habit")?.id).toBe("2");
  });

  it("matches the exact stored name case-insensitively", () => {
    expect(matchHabitByName(HABITS, "poop")?.id).toBe("2");
  });

  it("matches a medication habit by its drug name", () => {
    expect(matchHabitByName(HABITS, "lisinopril")?.id).toBe("4");
    expect(matchHabitByName(HABITS, "take my lisinopril")?.id).toBe("4");
  });

  it("matches when the query is the stored name embedded in a phrase", () => {
    expect(matchHabitByName(HABITS, "creatine")?.id).toBe("3");
    expect(matchHabitByName(HABITS, "did I take creatine today")?.id).toBe("3");
  });

  it("bridges verb tenses to the stored noun via stemming", () => {
    expect(matchHabitByName(HABITS, "stretching")?.id).toBe("1");
    expect(matchHabitByName(HABITS, "stretched this morning")?.id).toBe("1");
  });

  it("returns undefined when nothing meaningfully matches", () => {
    expect(matchHabitByName(HABITS, "buy a car")).toBeUndefined();
    expect(matchHabitByName(HABITS, "")).toBeUndefined();
  });

  it("handles an empty habit list without throwing", () => {
    expect(matchHabitByName([], "anything")).toBeUndefined();
  });

  it("prefers the most specific (shortest) name on overlap", () => {
    const habits = [
      { id: "a", name: "Run" },
      { id: "b", name: "Run a marathon training block" },
    ];
    expect(matchHabitByName(habits, "did my run")?.id).toBe("a");
  });
});

describe("habitTokens", () => {
  it("drops filler words and stems the meaningful token", () => {
    expect(habitTokens("I pooped today mark off habit")).toEqual(["poop"]);
  });
  it("collapses doubled consonants left by -ing", () => {
    expect(habitTokens("running")).toEqual(["run"]);
  });
});

describe("normalizeHabitText", () => {
  it("lowercases, splits camelCase, and strips punctuation", () => {
    expect(normalizeHabitText("Take-Lisinopril!")).toBe("take lisinopril");
    expect(normalizeHabitText("TakeCreatine")).toBe("take creatine");
  });
});
