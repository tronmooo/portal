// Two rules the chat's date tools hold regardless of the model's choice.
//
// 1. Owner, 2026-11-27: "Friday on a Friday should mean today unless the user
//    specifies next Friday or otherwise indicates a future date." (The chat
//    check, on a Friday: "todo pick up dry cleaning friday" was filed a week
//    out on some runs.)
// 2. A statement of something new does not move something that exists
//    (chat-variations check on the preview: "lunch with Sam tomorrow at noon"
//    moved the existing December 3 "Lunch with Sam" to tomorrow).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { bareWeekdayMeansToday, correctBareWeekday, asksForAChange, changesWhen } from "../shared/chat-date-intent";

const FRI = "2026-11-27"; // a Friday
const NEXT_FRI = "2026-12-04";

describe("a weekday named on that weekday is today", () => {
  it.each([
    "todo pick up dry cleaning friday",
    "team offsite Friday 9am to 5pm at the Marriott",
    "add a task to submit the timesheet by end of day Friday",
    "this Friday: call the plumber",
  ])("today: %s", (m) => expect(bareWeekdayMeansToday(m, FRI)).toBe(true));

  it.each([
    "book a dentist check-up next Friday at 3pm",
    "Friday next week: team lunch",
    "a week from Friday",
    "the following Friday works",
    "every Friday take out the bins",
    "call mom on Monday",                       // another weekday
    "between Friday and Sunday",                // two weekdays
    "Friday December 11 dinner",                // an explicit date decides
    "what's on today",
  ])("not today: %s", (m) => expect(bareWeekdayMeansToday(m, FRI)).toBe(false));

  it("only a date the model put exactly a week out is pulled back to today", () => {
    expect(correctBareWeekday(NEXT_FRI, "todo pick up dry cleaning friday", FRI)).toBe(FRI);
    expect(correctBareWeekday(FRI, "todo pick up dry cleaning friday", FRI)).toBeNull();          // already today
    expect(correctBareWeekday(NEXT_FRI, "dentist next Friday at 3", FRI)).toBeNull();               // they said next
    expect(correctBareWeekday("2026-12-11", "todo pick up dry cleaning friday", FRI)).toBeNull();   // not ours to guess
    expect(correctBareWeekday(undefined, "friday", FRI)).toBeNull();
    // said on a Wednesday, "Friday" is this coming Friday — untouched
    expect(correctBareWeekday("2026-11-27", "pick up dry cleaning friday", "2026-11-25")).toBeNull();
  });
});

describe("a new statement does not move what exists", () => {
  it.each([
    "lunch with Sam tomorrow at noon",
    "dentist on the 14th at 3pm",
    "team offsite Friday 9am to 5pm",
    "oil change on Wednesday at 10am",
  ])("states something new: %s", (m) => expect(asksForAChange(m)).toBe(false));

  it.each([
    "push it back a week",
    "no wait, make it Friday",
    "move the dentist to Thursday",
    "reschedule lunch with Sam to noon tomorrow",
    "actually it's at 3pm",
    "change the offsite to Monday",
    "cancel the haircut",
    "make that high priority and move it to Monday",
  ])("asks for a change: %s", (m) => expect(asksForAChange(m)).toBe(true));

  it("an update re-dates when it carries a date or time", () => {
    expect(changesWhen({ date: "2026-12-01" })).toBe(true);
    expect(changesWhen({ time: "15:00" })).toBe(true);
    expect(changesWhen({ dueDate: "2026-12-01" })).toBe(true);
    expect(changesWhen({ location: "Cafe" })).toBe(false);
    expect(changesWhen(null)).toBe(false);
  });

  it("the gate refuses the re-date, and both creates correct a bare weekday", () => {
    const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
    const at = src.indexOf("return movedExistingViolation(toolUse.name, label);");
    expect(at).toBeGreaterThan(0);
    const gate = src.slice(at - 900, at);
    expect(gate).toContain('toolUse.name === "update_event" || toolUse.name === "update_task"');
    expect(gate).toContain("changesWhen(input.changes)");
    expect(gate).toContain("!asksForAChange(userMessage)");
    expect(src).toContain("correctBareWeekday(input.dueDate, (input as any).__userMessage");
    expect(src).toContain("correctBareWeekday(input.date, (input as any).__userMessage");
  });

  it("a daily habit already done today does not get a second mirror entry unless the person says 'again'", () => {
    const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
    expect(src).toContain("isHabitDoneOn(habit as any, todayStr) && todays.length > 0");
    expect(src).toMatch(/saysAgain = \/\\b\(\?:again\|twice\|second/);
  });
});
