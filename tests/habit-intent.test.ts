// Pins the explicit-habit-language detectors that keep activity reports out
// of the habit system. Regression source (user report 2026-07-15): "I went
// to the bathroom at 8:15 AM" was matched to ANOTHER profile's "Go to the
// bathroom 3x daily" habit and turned into a clarifying question; showers
// went unlogged. Rule: "I did / I took / I smoked / I went" are tracker
// logs; habits move only on explicit language.
import { describe, it, expect } from "vitest";
import {
  hasExplicitHabitCreateIntent,
  hasExplicitHabitCheckinIntent,
} from "@shared/habit-intent";

const EXACT_USER_COMMAND =
  "I played soccer for an hour. I smoked a blunt. I took a shower once. I went to the bathroom at 8:15 AM.";

describe("hasExplicitHabitCheckinIntent", () => {
  it("rejects plain activity reports (the reported bug)", () => {
    for (const msg of [
      EXACT_USER_COMMAND,
      "I went to the bathroom at 8:15 AM",
      "I took a shower once",
      "I smoked a blunt",
      "I played soccer for an hour",
      "I went on my morning run",
      "I did 30 pushups",
    ]) {
      expect(hasExplicitHabitCheckinIntent(msg), msg).toBe(false);
    }
  });

  it("accepts explicit check-in language", () => {
    for (const msg of [
      "mark off my run",
      "Mark off that I meditated",
      "check off stretching",
      "checked in my reading habit",
      "Joe completed his water habit",
      "done meditation",
      "completed morning pages",
      "✅ vitamins",
      "keep my streak going for journaling",
    ]) {
      expect(hasExplicitHabitCheckinIntent(msg), msg).toBe(true);
    }
  });
});

describe("hasExplicitHabitCreateIntent", () => {
  it("rejects activity reports — never convert an activity into a habit", () => {
    for (const msg of [
      EXACT_USER_COMMAND,
      "I took a shower once",
      "I went to the bathroom at 8:15 AM",
      "I vacuumed and washed the dishes",
    ]) {
      expect(hasExplicitHabitCreateIntent(msg), msg).toBe(false);
    }
  });

  it("accepts explicit habit-creation language", () => {
    for (const msg of [
      "make this a habit",
      "add a habit to meditate",
      "I want to meditate every day",
      "remind me to stretch each morning",
      "track my reading as a daily routine",
      "start a streak for flossing",
      "drink water every morning",
    ]) {
      expect(hasExplicitHabitCreateIntent(msg), msg).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Mark <name> done" is a completion COMMAND, not an activity report
// (user report 2026-08-17). The gate only fired on "mark off/it/that/my/the",
// so "Mark Daily run done" — the plainest way anyone says this — was treated as
// narration. checkin_habit bailed out before looking the habit up, and the
// model relayed that as "no such habit, want me to log a tracker entry?" while
// the habit was on screen.
// ─────────────────────────────────────────────────────────────────────────────
describe("completion commands reach the habit", () => {
  const COMMANDS = [
    "Mark Daily run done",
    "Mark Clean my room done",
    "mark daily run complete",
    "mark my meditation finished",
    "complete Daily run",
    "finish Daily run",
    "check off Daily run",
    "Mark habit Daily run done",
    "mark off my run",
    "done meditation",
  ];
  it.each(COMMANDS)("%s is an explicit check-in", (msg) => {
    expect(hasExplicitHabitCheckinIntent(msg)).toBe(true);
  });

  // The guard this gate exists for must still hold.
  const REPORTS = [
    "I went to the bathroom at 8:15 AM",
    "I drank a glass of water",
    "I ran 3 miles this morning",
    "I smoked a cigarette",
    "had coffee",
  ];
  it.each(REPORTS)("%s is NOT a check-in — it is a tracker log", (msg) => {
    expect(hasExplicitHabitCheckinIntent(msg)).toBe(false);
  });

  it("does not drag a 'done' from a later sentence into range", () => {
    // Sentence-bounded: the completion word must belong to the mark clause.
    // ("mark my …" is a check-in by the older rule, so this case deliberately
    // avoids the off/it/that/my/the forms to isolate the new one.)
    expect(hasExplicitHabitCheckinIntent("mark rex's bowl. the laundry is done"))
      .toBe(false);
  });
});
