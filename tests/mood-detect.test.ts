// Pins shared/mood-detect.ts — the single mood detector used by the chat
// journal fast-path, the journal composer, and POST /api/journal's fallback.
// Regression source (user report 2026-07-16): "I'm really pissed off today"
// journal entries carried no detected mood in the UI path.
import { describe, it, expect } from "vitest";
import { detectMoodFromText } from "@shared/mood-detect";

describe("detectMoodFromText", () => {
  it("detects the user's reported entry as a bad mood", () => {
    expect(detectMoodFromText(
      "I'm really pissed off today. My father and other people keep interrupting me while I'm watching the World Cup, and they keep texting me",
    )).toBe("bad");
  });

  it("maps anger/stress/anxiety words to bad", () => {
    for (const t of ["so frustrated with work", "feeling anxious about tomorrow", "really stressed out", "I'm mad at everyone"]) {
      expect(detectMoodFromText(t), t).toBe("bad");
    }
  });

  it("maps strong negatives above bad", () => {
    expect(detectMoodFromText("today was absolutely terrible, the worst")).toBe("terrible");
    expect(detectMoodFromText("horrible day, cried all afternoon")).toBe("awful");
  });

  it("negative signal outweighs positive words in mixed passages", () => {
    expect(detectMoodFromText("started great but then everything got horrible")).toBe("awful");
  });

  it("maps positives correctly", () => {
    expect(detectMoodFromText("what an amazing, incredible day")).toBe("amazing");
    expect(detectMoodFromText("felt really motivated and grateful")).toBe("great");
    expect(detectMoodFromText("a calm, pleasant afternoon")).toBe("good");
    expect(detectMoodFromText("it was okay I guess")).toBe("okay");
  });

  it("defaults to neutral on empty or signal-free text", () => {
    expect(detectMoodFromText("")).toBe("neutral");
    expect(detectMoodFromText("went to the store and bought bread")).toBe("neutral");
  });
});
