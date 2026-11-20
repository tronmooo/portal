// Journal tutorial QA (2026-11-20): the chat's read of journal and note
// requests. Every message below is one the tester typed, or a near neighbour
// that must NOT be captured.
import { describe, it, expect } from "vitest";
import {
  journalFilingContent, isWholeMessageJournalFiling,
  parseJournalReadIntent, parseNoteFindIntent, rankNotesByTopic,
} from "../shared/journal-intent";
import { isBareFilingDirective, routeContent } from "../shared/content-routing";
import { detectMoodFromText } from "../shared/mood-detect";

describe("save this as today's journal entry", () => {
  const STEP2 = "I had a pretty good day today. I went for a 3 mile run this morning and took a walk after dinner. Save this as today's journal entry";

  it("the entry's text is the message, without the instruction", () => {
    expect(journalFilingContent(STEP2)).toBe(
      "I had a pretty good day today. I went for a 3 mile run this morning and took a walk after dinner.",
    );
  });

  it.each([
    ["Work was rough and I skipped lunch. Journal this.", "Work was rough and I skipped lunch."],
    ["Slept badly, felt off all day. Please add this to my journal", "Slept badly, felt off all day."],
    ["Journal this: I finally fixed the fence", "I finally fixed the fence"],
    ["Save this as a journal entry: quiet day at home", "quiet day at home"],
    ["Long day but worth it - put this in my diary", "Long day but worth it"],
  ])("%s", (msg, text) => {
    expect(journalFilingContent(msg)).toBe(text);
  });

  it.each([
    "Add a journal entry saying I had a great day",
    "Show me my journal entry from today",
    "Save this as a note",
    "I ran 3 miles today",
    "Save this as today's journal entry",
  ])("is not a whole-message filing: %s", (msg) => {
    expect(isWholeMessageJournalFiling(msg)).toBe(false);
  });

  it("the router treats the instruction as a filing directive, not a second object", () => {
    expect(isBareFilingDirective("Save this as today's journal entry")).toBe(true);
    expect(isBareFilingDirective("add this to my journal for today")).toBe(true);
    const plan = routeContent(STEP2);
    const last = plan.actions[plan.actions.length - 1];
    expect(last.kind).toBe("journal");
    expect(last.explicit).toBe(true);
  });
});

describe("reading the journal", () => {
  it.each([
    ["Show me my journal entry from today", "show", "today"],
    ["What did I write in my journal yesterday?", "show", "yesterday"],
    ["read my journal", "show", null],
    ["What was my mood earlier today?", "mood", "today"],
    ["How was I feeling yesterday?", "mood", "yesterday"],
    ["Summarize what I wrote in my journal today", "summarize", "today"],
    ["Show me my journal entry for 2026-11-18", "show", "2026-11-18"],
  ] as const)("%s", (msg, kind, day) => {
    expect(parseJournalReadIntent(msg)).toEqual({ kind, day });
  });

  it.each([
    "Add a journal entry saying I had a great day",
    "Journal this: I had a stressful day",
    "Delete today's journal entry",
    "I'm feeling frustrated and overwhelmed today",
    "My mood is 7 out of 10",
    "Chart my mood over time",
    "What's my mood trend this month?",
    "Show me my tasks",
  ])("is not a journal read: %s", (msg) => {
    expect(parseJournalReadIntent(msg)).toBeNull();
  });
});

describe("finding a note", () => {
  it.each([
    ["Find my note about buying new tires", "buying new tires"],
    ["Show me my notes", ""],
    ["search my notes for the gate code", "the gate code"],
    ["What notes do I have about the car?", "the car"],
    ["Where is my note on car maintenance", "car maintenance"],
    ["find my tire note", "tire"],
  ])("%s", (msg, query) => {
    expect(parseNoteFindIntent(msg)).toEqual({ query });
  });

  it.each([
    "Save a quick note: buy new tires",
    "Make a note that the gate code is 4821",
    "Find my tire warranty",
    "Note for Mike: his dog's food is in the garage",
  ])("is not a note lookup: %s", (msg) => {
    expect(parseNoteFindIntent(msg)).toBeNull();
  });

  const notes = [
    { id: "1", title: "Gate code", content: "Robert's gate code is 4821" },
    { id: "2", title: "Buy new tires", content: "Need to buy new tires for the Honda before winter" },
    { id: "3", title: "New recipe", content: "Try the new lentil soup" },
  ];

  it("matches the note by its words, not by an exact phrase", () => {
    expect(rankNotesByTopic(notes, "buying new tires").map((n) => n.id)).toEqual(["2"]);
    expect(rankNotesByTopic(notes, "tire").map((n) => n.id)).toEqual(["2"]);
    expect(rankNotesByTopic(notes, "the gate code").map((n) => n.id)).toEqual(["1"]);
  });

  it("a topic nothing is about matches nothing; no topic lists everything", () => {
    expect(rankNotesByTopic(notes, "piano warranty")).toEqual([]);
    expect(rankNotesByTopic(notes, "")).toHaveLength(3);
  });
});

describe("mood from the tester's sentence", () => {
  it("frustrated and overwhelmed is not Neutral", () => {
    expect(detectMoodFromText("I'm feeling frustrated and overwhelmed with work today")).toBe("bad");
  });
});
