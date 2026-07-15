// Pins the deterministic multi-action clause heuristic that routes long
// "here's my day" recaps to the bulk extraction path. Regression source:
// user report 2026-07-15 — "I played soccer for an hour. I smoked some
// cannabis. I took a shower and I went to the bathroom at 8:15 AM." only
// logged soccer and the AI declined the rest.
import { describe, it, expect } from "vitest";
import {
  splitActionClauses,
  countActionClauses,
  shouldUseBulkPath,
  BULK_ACTION_THRESHOLD,
} from "@shared/action-split";

const REPORTED_MESSAGE =
  "I played soccer for an hour. I smoked some cannabis. I took a shower and I went to the bathroom at 8:15 AM.";

const TWENTY_ACTION_MESSAGE =
  "I woke up at 6:15. Showered. Used the bathroom. Brushed my teeth. Took lisinopril. Took fish oil. Drank 32 oz of water. Drank coffee. Ate oatmeal. Walked 2 miles. Played soccer for 60 minutes. Smoked cannabis. Read for 45 minutes. Meditated for 10 minutes. Practiced guitar for an hour. Vacuumed. Washed dishes. Paid my electric bill. Journaled. Went to bed at 10:30.";

function buildActions(n: number): string {
  const bank = [
    "I drank a glass of water",
    "I walked a mile",
    "I took a vitamin",
    "I read for 10 minutes",
    "I meditated for 5 minutes",
    "I washed the dishes",
    "I vacuumed the living room",
    "I practiced piano",
    "I ate an apple",
    "I stretched for 15 minutes",
  ];
  return Array.from({ length: n }, (_, i) => `${bank[i % bank.length]} (#${i + 1}).`).join(" ");
}

describe("splitActionClauses", () => {
  it("extracts all four actions from the reported message", () => {
    const clauses = splitActionClauses(REPORTED_MESSAGE);
    expect(clauses.length).toBe(4);
    expect(clauses.join(" | ").toLowerCase()).toContain("soccer");
    expect(clauses.join(" | ").toLowerCase()).toContain("cannabis");
    expect(clauses.join(" | ").toLowerCase()).toContain("shower");
    expect(clauses.join(" | ").toLowerCase()).toContain("bathroom");
  });

  it("extracts ~20 actions from the 20-sentence day recap", () => {
    const clauses = splitActionClauses(TWENTY_ACTION_MESSAGE);
    expect(clauses.length).toBeGreaterThanOrEqual(18);
    expect(clauses.length).toBeLessThanOrEqual(22);
  });

  it("splits intra-sentence conjunctions between actions", () => {
    const clauses = splitActionClauses("I took a shower and I went to the bathroom.");
    expect(clauses.length).toBe(2);
  });

  it("does not split compound nouns joined by 'and'", () => {
    const clauses = splitActionClauses("I ate mac and cheese.");
    expect(clauses.length).toBe(1);
    expect(clauses[0].toLowerCase()).toContain("mac and cheese");
  });

  it("ignores questions", () => {
    expect(countActionClauses("How much did I spend this month?")).toBe(0);
    expect(countActionClauses("What did I eat yesterday?")).toBe(0);
  });

  it("counts bare imperative-style clauses (no subject)", () => {
    const clauses = splitActionClauses("Showered. Vacuumed. Used the bathroom.");
    expect(clauses.length).toBe(3);
  });
});

describe("shouldUseBulkPath routing", () => {
  it("does NOT bulk-route single-intent messages", () => {
    for (const msg of [
      "weight 183",
      "I ran 3 miles today",
      "add a task to buy milk",
      "bp 120/80",
      "I ate a chicken sandwich for lunch",
      "remind me to call the dentist Friday at 10am",
    ]) {
      expect(shouldUseBulkPath(msg), msg).toBe(false);
    }
  });

  it("does NOT bulk-route the 4-action reported message (agentic loop handles it)", () => {
    expect(shouldUseBulkPath(REPORTED_MESSAGE)).toBe(false);
  });

  it("bulk-routes the 20-action recap", () => {
    expect(shouldUseBulkPath(TWENTY_ACTION_MESSAGE)).toBe(true);
  });

  it("bulk-routes generated 10/20/50-action messages", () => {
    for (const n of [10, 20, 50]) {
      const msg = buildActions(n);
      expect(countActionClauses(msg), `${n}-action message`).toBeGreaterThanOrEqual(n - 2);
      expect(shouldUseBulkPath(msg), `${n}-action message`).toBe(true);
    }
  });

  it("threshold sits above typical conversational multi-action messages", () => {
    expect(BULK_ACTION_THRESHOLD).toBeGreaterThanOrEqual(5);
    expect(BULK_ACTION_THRESHOLD).toBeLessThanOrEqual(12);
  });
});
