// Pins the natural-language rules the chat uses to turn "twice", "again",
// "two more" and "so far" into a completion count — and, critically, into the
// right KIND of count. ADD vs SET is the difference between 2/3 and 4/3.
import { describe, it, expect } from "vitest";
import {
  parseCompletionCount,
  parseCompletionTime,
  parseDailyTargetChange,
  hasMultipleCountPhrases,
  hasMultipleDailyTargets,
  wordToNumber,
} from "@shared/habit-count-language";

describe("wordToNumber", () => {
  it("reads number words and digits", () => {
    expect(wordToNumber("once")).toBe(1);
    expect(wordToNumber("twice")).toBe(2);
    expect(wordToNumber("three")).toBe(3);
    expect(wordToNumber("eight")).toBe(8);
    expect(wordToNumber("4")).toBe(4);
    expect(wordToNumber("couple")).toBe(2);
    expect(wordToNumber("banana")).toBeNull();
  });
});

describe("parseCompletionCount — how many", () => {
  const cases: Array<[string, number]> = [
    ["I walked the dog twice", 2],
    ["I walked the dog three times", 3],
    ["I took my medication once", 1],
    ["drank water 4 times", 4],
    ["I did it 3x", 3],
    ["I did it again", 1],
    ["one more", 1],
    ["two more", 2],
    ["I did it twice more", 2],
    ["another one", 1],
  ];
  for (const [msg, count] of cases) {
    it(`"${msg}" → ${count}`, () => {
      expect(parseCompletionCount(msg)?.count).toBe(count);
    });
  }

  it("treats \"all N\" and \"N instead of M\" as today's TOTAL, not an increment", () => {
    // "I completed all three" and "I did four instead of three" both report
    // where the day LANDED — adding them on top of existing completions would
    // double-count.
    expect(parseCompletionCount("I completed all three")).toEqual({ count: 3, mode: "set", at: undefined });
    expect(parseCompletionCount("I did four instead of three")).toEqual({ count: 4, mode: "set", at: undefined });
  });

  it("returns null when the sentence carries no count at all", () => {
    expect(parseCompletionCount("I walked the dog")).toBeNull();
    expect(parseCompletionCount("")).toBeNull();
  });
});

describe("parseCompletionCount — ADD vs SET", () => {
  it("ADDs by default and for explicit increments", () => {
    for (const msg of [
      "I walked the dog twice",
      "I did it twice more",
      "two more",
      "I did it again",
      "another one",
      "I walked the dog twice today",
    ]) {
      expect(parseCompletionCount(msg)?.mode, msg).toBe("add");
    }
  });

  it("SETs today's total for running totals and corrections", () => {
    for (const msg of [
      "I've done it twice so far",
      "I only walked the dog twice today",
      "I've only taken it once in total",
      "make today 3 times",
    ]) {
      expect(parseCompletionCount(msg)?.mode, msg).toBe("set");
    }
  });

  it('"more" beats a SET marker — "only twice more" is still an increment', () => {
    expect(parseCompletionCount("I only did it twice more")?.mode).toBe("add");
    expect(parseCompletionCount("I only did it twice more")?.count).toBe(2);
  });
});

describe("parseCompletionTime", () => {
  it("reads explicit clock times", () => {
    expect(parseCompletionTime("I did it at 8 AM")).toBe("08:00");
    expect(parseCompletionTime("I did it at 8:15am")).toBe("08:15");
    expect(parseCompletionTime("I did it at 8 PM")).toBe("20:00");
    expect(parseCompletionTime("I did it at 20:15")).toBe("20:15");
    expect(parseCompletionTime("took it at 12 AM")).toBe("00:00");
  });

  it("reads named parts of the day so a backdated completion isn't stamped 'now'", () => {
    expect(parseCompletionTime("I brushed my teeth this morning")).toBe("08:00");
    expect(parseCompletionTime("I did it this afternoon")).toBe("13:00");
    expect(parseCompletionTime("I did it this evening")).toBe("18:00");
    expect(parseCompletionTime("I brushed them again tonight")).toBe("20:00");
  });

  it("stays out of the way when no time is given", () => {
    expect(parseCompletionTime("I walked the dog twice")).toBeUndefined();
  });

  it("rides along on a parsed count", () => {
    const r = parseCompletionCount("I already brushed my teeth once this morning");
    expect(r?.count).toBe(1);
    expect(r?.at).toBe("08:00");
  });
});

describe("parseDailyTargetChange", () => {
  it("reads a new daily target", () => {
    expect(parseDailyTargetChange("Set my water habit to 8 times per day")).toBe(8);
    expect(parseDailyTargetChange("make it 3 times a day")).toBe(3);
    expect(parseDailyTargetChange("walk the dog twice a day")).toBe(2);
    expect(parseDailyTargetChange("brush teeth 2x daily")).toBe(2);
    expect(parseDailyTargetChange("stretch three times each day")).toBe(3);
  });

  it("takes the target AFTER 'to' when the user names both", () => {
    // Reading the first number would set the target back to what the user is
    // changing away from.
    expect(parseDailyTargetChange("Change walking the dog from twice a day to three times a day")).toBe(3);
    expect(parseDailyTargetChange("go from 2 times a day to 5 times a day")).toBe(5);
  });

  it("returns null when no target is stated", () => {
    expect(parseDailyTargetChange("I walked the dog twice")).toBeNull();
    expect(parseDailyTargetChange("")).toBeNull();
  });
});

describe("multi-habit messages disable the whole-message fallback", () => {
  it("flags a message carrying several different counts", () => {
    // Reading one count off this sentence and applying it to every habit
    // would log two doses of medication.
    expect(hasMultipleCountPhrases(
      "I walked the dog twice, took my medication once, drank water four times, and brushed my teeth this morning and again tonight",
    )).toBe(true);
    expect(hasMultipleCountPhrases("I walked the dog twice")).toBe(false);
    expect(hasMultipleCountPhrases("I walked the dog")).toBe(false);
  });

  it("flags a message stating several daily targets", () => {
    expect(hasMultipleDailyTargets("set water to 8 times a day and stretching to 3 times a day")).toBe(true);
    expect(hasMultipleDailyTargets("walk the dog twice a day")).toBe(false);
    // "from X to Y" is ONE change; parseDailyTargetChange already resolves it.
    expect(hasMultipleDailyTargets("change walking the dog from twice a day to three times a day")).toBe(false);
  });
});
