// The five screenshots of 2026-08-20, pinned.
//
// Every one of them put the right data in the wrong place, or refused work the
// user had plainly asked for:
//
//   1. 'Updated asset "John Hancock".'         — John is a person.
//   2. "Create Artifact" for a note for John   — a note is a note.
//   3. Journal entry FOR JOHN, badged "YOU"    — filed under the user.
//   4. "Actually make that $92."               — nothing changed; the user was
//                                                asked whether to create a
//                                                SECOND bill.
//   5. "…, note that he hates cilantro, and his birthday is April 7"
//                                              — the note and the birthday
//                                                were both refused with
//                                                "you asked for a task".
//
// Each test names the sentence from the report it protects.

import { describe, it, expect } from "vitest";
import {
  splitIntentClauses,
  detectOperation,
  detectCorrection,
  hasExplicitUpdateIntent,
  parseTurnPlan,
} from "@shared/ai-intent";
import { routeContent, checkContentRouting } from "@shared/content-routing";
import { checkToolAgainstIntent } from "@shared/ai-tool-routing";
import { groundedSummary } from "@shared/ai-claim-check";
import { profileNoun, profileNounLower } from "@shared/entity-nouns";
import { ownershipHintFor, correctionConfirmation, writtenEntityNoun } from "../server/ai-engine";

const FOUR_CLAUSE =
  "John's email is john@test.com, remind me to call him Friday, note that he hates cilantro, and his birthday is April 7.";

describe("1. a person is not an asset", () => {
  it("names the row, not the table it shares with assets", () => {
    expect(
      groundedSummary([{ tool: "update_profile", status: "ok", raw: "John Hancock", entityLabel: "person" }]),
    ).toBe("Updated John Hancock's profile.");
  });

  it("still calls a truck an asset", () => {
    expect(
      groundedSummary([{ tool: "update_profile", status: "ok", raw: "Dodge Ram 2025", entityLabel: "asset" }]),
    ).toBe('Updated asset "Dodge Ram 2025".');
  });

  it("profileNoun maps every profile type the card knows", () => {
    expect(profileNoun("person")).toBe("Person");
    expect(profileNoun("pet")).toBe("Pet");
    expect(profileNoun("vehicle")).toBe("Asset");
    expect(profileNoun("investment")).toBe("Asset");
    expect(profileNounLower("person")).toBe("person");
    // An unknown type says nothing rather than guessing "asset".
    expect(profileNoun("wormhole")).toBeNull();
    expect(profileNoun(undefined)).toBeNull();
  });
});

describe("2. a note is a note", () => {
  it("summarises create_note as a note, never an artifact", () => {
    expect(
      groundedSummary([{ tool: "create_note", status: "ok", raw: "Appointment Preference", entityLabel: "note" }]),
    ).toBe('Created note "Appointment Preference".');
  });
});

describe("3. the entry belongs to whoever it names", () => {
  it("the router reads John out of 'Journal entry for John: …'", () => {
    const hints = routeContent("Journal entry for John: He seemed much happier today.")
      .actions.map((a) => a.profileHint)
      .filter(Boolean);
    expect(hints).toEqual(["John"]);
  });

  it("'make a note for John' names John too", () => {
    const plan = routeContent("Make a note for John that he prefers morning appointments.");
    expect(plan.actions[0].kind).toBe("note");
    expect(plan.actions[0].profileHint).toBe("John");
  });
});

describe("4. 'Actually make that $92.' is a correction, not a create", () => {
  it("reads as an update even though 'make' is a create verb", () => {
    expect(detectOperation("Actually make that $92.")).toBe("update");
    expect(hasExplicitUpdateIntent("Actually make that $92.")).toBe(true);
    expect(detectCorrection("Actually make that $92.")).toEqual({ isCorrection: true, value: "$92" });
  });

  it("no longer blocks the update tool as a downgraded create", () => {
    const plan = parseTurnPlan("Actually make that $92.");
    expect(checkToolAgainstIntent("update_obligation", plan)).toBeNull();
    expect(checkToolAgainstIntent("update_expense", plan)).toBeNull();
  });

  it("leaves ordinary creates alone", () => {
    expect(detectOperation("Create an asset for my Dodge Ram 2025")).toBe("create");
    expect(detectOperation("Add a task to call the dentist")).toBe("create");
    expect(detectCorrection("actually, add a task for Friday").isCorrection).toBe(false);
    const plan = parseTurnPlan("Create an asset for my Dodge Ram 2025");
    expect(checkToolAgainstIntent("update_profile", plan)?.mismatchType).toBe("create_downgraded_to_update");
  });
});

describe("5. every clause of a compound message is its own request", () => {
  it("splits the note and the birthday off the reminder", () => {
    expect(splitIntentClauses(FOUR_CLAUSE)).toEqual([
      "John's email is john@test.com",
      "remind me to call him Friday",
      "note that he hates cilantro",
      "his birthday is April 7",
    ]);
  });

  it("classifies all four clauses", () => {
    const kinds = routeContent(FOUR_CLAUSE).actions.map((a) => `${a.kind}:${a.structuredDomain ?? ""}`);
    expect(kinds).toEqual(["profile_field:profile_contact", "task:", "note:", "profile_field:profile_dob"]);
  });

  it("refuses none of the tools those clauses need", () => {
    for (const tool of ["create_note", "create_task", "create_event", "update_profile"]) {
      expect(checkContentRouting(tool, FOUR_CLAUSE)).toBeNull();
    }
  });

  it("still refuses a journal entry when the user said NOTE and nothing else", () => {
    const v = checkContentRouting("journal_entry", "jane doe note: I have the look that one gives somebody");
    expect(v?.requestedKind).toBe("note");
  });

  it("does not split a name or a dish that merely contains 'and'", () => {
    expect(splitIntentClauses("mac and cheese for dinner")).toHaveLength(1);
    expect(splitIntentClauses("Create an asset for my Dodge Ram 2025, it's white four-wheel-drive")).toHaveLength(1);
  });

  it("keeps an email address whole", () => {
    expect(splitIntentClauses("Robert's email is robert@example.com")).toEqual([
      "Robert's email is robert@example.com",
    ]);
  });
});

// ── The server-side halves of the same five turns ───────────────────────────
//
// These are the functions server/ai-engine.ts runs between a tool call and the
// write. The model's choice of tool is supplied by hand here — everything
// after it is the production path.

describe("ownership is applied, not suggested", () => {
  it("fills in forProfile for a journal entry that names one person", () => {
    expect(ownershipHintFor("journal_entry", {}, "Journal entry for John: He seemed much happier today."))
      .toBe("John");
    expect(ownershipHintFor("create_note", {}, "Make a note for John that he prefers morning appointments."))
      .toBe("John");
  });

  it("never overrides a choice the model already made", () => {
    expect(ownershipHintFor("journal_entry", { forProfile: "Jane" }, "Journal entry for John: …")).toBeNull();
  });

  it("stays out of it when the message names nobody", () => {
    expect(ownershipHintFor("journal_entry", {}, "Today was a good day.")).toBeNull();
  });

  it("leaves untargeted tools alone", () => {
    expect(ownershipHintFor("create_expense", {}, "Log $20 for lunch with John")).toBeNull();
  });
});

describe("a correction asks before it writes", () => {
  const bill = [{ id: "ob1", name: "QA Phone Bill", amount: 86.5, frequency: "monthly" }];

  it("asks the question from the report, in the user's own units", () => {
    const ask = correctionConfirmation(
      "update_obligation", { name: "QA Phone Bill", amount: 92 }, "Actually make that $92.", bill,
    );
    expect(ask?.userMessage).toBe("Do you want me to change the QA Phone Bill from $86.50 to $92?");
  });

  it("writes on the confirmation instead of asking again", () => {
    expect(correctionConfirmation("update_obligation", { name: "QA Phone Bill", amount: 92 }, "yes", bill)).toBeNull();
  });

  it("says nothing when the value is already what was asked for", () => {
    expect(correctionConfirmation(
      "update_obligation", { name: "QA Phone Bill", amount: 86.5 }, "Actually make that $86.50.", bill,
    )).toBeNull();
  });

  it("does not hold an ordinary update", () => {
    expect(correctionConfirmation(
      "update_obligation", { name: "QA Phone Bill", amount: 92 }, "Change the QA Phone Bill to $92.", bill,
    )).toBeNull();
  });

  it("falls through when no stored record matches", () => {
    expect(correctionConfirmation("update_obligation", { name: "Gas Bill", amount: 92 }, "Actually make that $92.", bill))
      .toBeNull();
  });
});

describe("the noun comes from the row that was written", () => {
  it("reads a person as a person and a truck as an asset", () => {
    expect(writtenEntityNoun("update_profile", { type: "person" })).toBe("person");
    expect(writtenEntityNoun("update_profile", { type: "vehicle" })).toBe("asset");
    expect(writtenEntityNoun("create_note", { type: "note" })).toBe("note");
  });

  it("says nothing rather than guessing", () => {
    expect(writtenEntityNoun("update_profile", {})).toBeUndefined();
    expect(writtenEntityNoun("create_task", { type: "person" })).toBeUndefined();
  });
});
