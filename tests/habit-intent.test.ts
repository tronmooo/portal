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
