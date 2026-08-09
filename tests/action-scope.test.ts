// Pins the "only do what the user actually asked for" guard.
//
// Reported bug (2026-08-09, screenshot): the user sent "Create me a habit too
// walk the dog twice a day" and the assistant created the Walk the Dog habit
// AND re-created the PREVIOUS turn's "Mow the lawn" reminder. That second
// action came entirely from the conversation history.
import { describe, it, expect } from "vitest";
import {
  checkHistoryReplay,
  isAnaphoricFollowUp,
  toolSubject,
  scopeTokens,
  REPLAY_GUARDED_TOOLS,
} from "@shared/action-scope";

const MOW_HISTORY = [
  { role: "user" as const, content: "remind me to mow the lawn on Tuesday" },
  { role: "assistant" as const, content: "Reminder set for Tuesday." },
];

describe("checkHistoryReplay — the reported bug", () => {
  it("blocks the previous turn's reminder when the current message never mentions it", () => {
    const res = checkHistoryReplay({
      toolName: "create_reminder",
      input: { title: "Mow the lawn", date: "2026-08-11" },
      userMessage: "Create me a habit too walk the dog twice a day",
      history: MOW_HISTORY,
    });
    expect(res.replay).toBe(true);
    expect(res.subject).toBe("Mow the lawn");
  });

  it("allows the habit the user actually asked for in the same message", () => {
    const res = checkHistoryReplay({
      toolName: "create_habit",
      input: { name: "Walk the Dog", targetPerDay: 2 },
      userMessage: "Create me a habit too walk the dog twice a day",
      history: MOW_HISTORY,
    });
    expect(res.replay).toBe(false);
  });
});

describe("checkHistoryReplay — never blocks legitimate work", () => {
  it("allows a subject the current message names, even if history named it too", () => {
    const res = checkHistoryReplay({
      toolName: "create_reminder",
      input: { title: "Mow the lawn" },
      userMessage: "actually move the mow the lawn reminder to Friday and remind me again",
      history: MOW_HISTORY,
    });
    expect(res.replay).toBe(false);
  });

  it("allows anaphoric follow-ups, where the subject SHOULD come from history", () => {
    for (const msg of [
      "do it again",
      "add another one",
      "same thing for tomorrow",
      "one more please",
      "yes",
    ]) {
      const res = checkHistoryReplay({
        toolName: "create_task",
        input: { title: "Mow the lawn" },
        userMessage: msg,
        history: MOW_HISTORY,
      });
      expect(res.replay, msg).toBe(false);
    }
  });

  it("allows a partially-overlapping subject — one shared word is not a replay", () => {
    // "walk" appears in the history, but "walk to work" is a NEW thing.
    const res = checkHistoryReplay({
      toolName: "create_task",
      input: { title: "Walk to work" },
      userMessage: "add a task",
      history: [{ role: "user", content: "remind me to walk the dog" }],
    });
    expect(res.replay).toBe(false);
  });

  it("allows a first message (no history at all)", () => {
    const res = checkHistoryReplay({
      toolName: "create_reminder",
      input: { title: "Mow the lawn" },
      userMessage: "add something",
      history: [],
    });
    expect(res.replay).toBe(false);
  });

  it("ignores tools whose subject the model derives rather than quotes", () => {
    // "I ran 2 miles" → tracker "Running": no reliable overlap, so
    // log_tracker_entry is deliberately outside the guard.
    expect(REPLAY_GUARDED_TOOLS.has("log_tracker_entry")).toBe(false);
    expect(REPLAY_GUARDED_TOOLS.has("update_task")).toBe(false);
    expect(REPLAY_GUARDED_TOOLS.has("delete_habit")).toBe(false);
    const res = checkHistoryReplay({
      toolName: "log_tracker_entry",
      input: { trackerName: "Mow the lawn" },
      userMessage: "walk the dog twice a day",
      history: MOW_HISTORY,
    });
    expect(res.replay).toBe(false);
  });

  it("does not treat the assistant's own prior words as a user request", () => {
    const res = checkHistoryReplay({
      toolName: "create_task",
      input: { title: "Mow the lawn" },
      userMessage: "add a task",
      history: [{ role: "assistant", content: "Should I add mow the lawn?" }],
    });
    expect(res.replay).toBe(false);
  });

  it("allows a subject made only of generic words", () => {
    const res = checkHistoryReplay({
      toolName: "create_task",
      input: { title: "the thing today" },
      userMessage: "add it",
      history: MOW_HISTORY,
    });
    expect(res.replay).toBe(false);
  });
});

describe("helpers", () => {
  it("reads the subject from the tool's name/title field", () => {
    expect(toolSubject({ title: "Mow the lawn" })).toBe("Mow the lawn");
    expect(toolSubject({ name: "Walk the Dog" })).toBe("Walk the Dog");
    expect(toolSubject({ amount: 5 })).toBe("");
    expect(toolSubject(null)).toBe("");
  });

  it("stems tokens so 'walking' and 'walked' agree with 'walk'", () => {
    expect(scopeTokens("Walking the dogs")).toContain("walk");
    expect(scopeTokens("I walked the dog")).toContain("walk");
  });

  it("detects anaphora", () => {
    expect(isAnaphoricFollowUp("I did it again")).toBe(true);
    expect(isAnaphoricFollowUp("two more")).toBe(true);
    expect(isAnaphoricFollowUp("create a habit to floss")).toBe(false);
  });
});
