// Corrections must survive replay protection, and references must resolve.
//
// From the QA report: replay protection blocked a legitimate correction to an
// existing event. "I moved it to September 10" is not a replay of "Create
// appointment September 8" — it is the correction OF that appointment, and it
// has to name the appointment to point at it.

import { describe, it, expect } from "vitest";
import { isStaleTurnReplay } from "@shared/ai-tool-routing";
import { hasBackReference } from "@shared/ai-intent";

const DENTIST = "Sarah has a dentist appointment on September 8 at 2pm";
const MACBOOK = "Sarah owns a MacBook Air worth $1,200";
const VITAMIN = "Sarah takes a multivitamin every morning";

describe("QA req 7 — replay protection must not block corrections", () => {
  it("lets an update to an earlier-created event through", () => {
    // The exact reported failure.
    expect(
      isStaleTurnReplay(
        { name: "dentist appointment", date: "2026-09-10" },
        "Actually I moved it to September 10",
        [DENTIST],
        "update_event",
      ),
    ).toBe(false);
  });

  it("lets an asset revaluation through", () => {
    expect(
      isStaleTurnReplay(
        { name: "MacBook Air", value: 950 },
        "Actually I checked and it's probably worth $950 now",
        [MACBOOK],
        "revalue_asset",
      ),
    ).toBe(false);
  });

  it("lets a habit completion through", () => {
    expect(
      isStaleTurnReplay(
        { name: "Multivitamin" },
        "She already took it today",
        [VITAMIN],
        "checkin_habit",
      ),
    ).toBe(false);
  });

  it("lets a delete of an earlier-created record through", () => {
    expect(
      isStaleTurnReplay(
        { name: "dentist appointment" },
        "Cancel it",
        [DENTIST],
        "delete_event",
      ),
    ).toBe(false);
  });

  it("still blocks a CREATE replaying an earlier turn", () => {
    // The behaviour replay protection exists for is untouched.
    expect(
      isStaleTurnReplay(
        { name: "dentist appointment", date: "2026-09-08" },
        "Add my Dodge Ram 2025",
        [DENTIST],
        "create_event",
      ),
    ).toBe(true);
  });

  it("keeps blocking creates when no tool name is supplied", () => {
    expect(
      isStaleTurnReplay({ name: "dentist appointment" }, "Add my Dodge Ram 2025", [DENTIST]),
    ).toBe(true);
  });
});

describe("QA req 4 — past-tense corrections read as back-references", () => {
  const backRefs = [
    "Actually I moved it to September 10",
    "I changed it to three times a day",
    "I updated it yesterday",
    "Actually, it's probably worth $950 now",
    "scratch that",
    "correction: it was $85",
    "I rescheduled it for Friday",
    "push it to next week",
  ];

  for (const msg of backRefs) {
    it(`treats "${msg}" as pointing at earlier context`, () => {
      expect(hasBackReference(msg)).toBe(true);
    });
  }

  it("does not see a back-reference in a fresh request", () => {
    expect(hasBackReference("Sarah owns a MacBook Air worth $1,200")).toBe(false);
    expect(hasBackReference("Add my Dodge Ram 2025")).toBe(false);
  });
});
