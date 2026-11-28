// "I meditated today" did not match a habit called "Meditate": the stemmer
// made "meditate" and "meditat", so the chat refused the check-in ("2 steps
// didn't go through"; chat variations on the preview, 2026-11-28). Any habit
// whose name ends in a silent e (Exercise, Dance, Hike, Bike, Ride) had the
// same gap.
import { describe, it, expect } from "vitest";
import { habitTokens } from "../shared/habit-match";
import { matchHabitForCompletionReport } from "../shared/habit-completion-intent";

const habits = [
  { id: "m", name: "Meditate" }, { id: "x", name: "Exercise" }, { id: "d", name: "Dance" },
  { id: "h", name: "Hike" }, { id: "w", name: "Walk the Dog" }, { id: "t", name: "Drink Green Tea" },
];
const match = (msg: string) => matchHabitForCompletionReport(habits, msg)?.habit.name ?? null;

describe("a habit's noun meets its verb forms", () => {
  it("meditate / meditated / meditating share a stem", () => {
    expect(habitTokens("Meditate")).toEqual(habitTokens("meditated"));
    expect(habitTokens("meditating")).toEqual(habitTokens("Meditate"));
  });
  it("a plain report checks the right habit in", () => {
    expect(match("I meditated today")).toBe("Meditate");
    expect(match("I exercised this morning")).toBe("Exercise");
    expect(match("I danced tonight")).toBe("Dance");
    expect(match("went hiking today")).toBe("Hike");
  });
  it("what already matched still does, and a double e keeps its e", () => {
    expect(match("I walked the dog")).toBe("Walk the Dog");
    expect(habitTokens("tea")).toEqual(["tea"]);
    expect(habitTokens("free")).toEqual(["free"]);
  });
  it("a report that names no habit still matches nothing", () => {
    expect(match("I walked for twenty minutes")).toBeNull();
  });
});
