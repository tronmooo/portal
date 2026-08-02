// Pins the deterministic multi-action clause heuristic that routes long
// "here's my day" recaps to the bulk extraction path. Regression source:
// user report 2026-07-15 — "I played soccer for an hour. I smoked some
// cannabis. I took a shower and I went to the bathroom at 8:15 AM." only
// logged soccer and the AI declined the rest.
import { describe, it, expect } from "vitest";
import {
  splitActionClauses,
  countActionClauses,
  countCommandClauses,
  shouldUseBulkPath,
  shouldUseMegaPlanPath,
  BULK_ACTION_THRESHOLD,
  MEGA_CHAR_THRESHOLD,
  MEGA_CLAUSE_THRESHOLD,
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

  it("bulk-routes the 4-action reported message (plan → execute → verify)", () => {
    expect(shouldUseBulkPath(REPORTED_MESSAGE)).toBe(true);
  });

  it("bulk-routes the exact fix command with blunt/shower/bathroom details", () => {
    const msg = "I played soccer for an hour. I smoked a blunt. I took a shower once. I went to the bathroom at 8:15 AM.";
    expect(countActionClauses(msg)).toBe(4);
    expect(shouldUseBulkPath(msg)).toBe(true);
  });

  it("bulk-routes the 20-action recap", () => {
    expect(shouldUseBulkPath(TWENTY_ACTION_MESSAGE)).toBe(true);
  });

  it("does NOT bulk-route mixed commands — CRUD/habit/question content needs the full loop", () => {
    for (const msg of [
      "I ran 3 miles. I ate lunch. I took a nap. I read a book. Delete my old Soccer tracker.",
      "I ran 3 miles. I ate lunch. I took a nap. Mark off my meditation habit.",
      "I ran 3 miles. I ate lunch. I took a nap. I read a book. How much did I spend today?",
      "I ran 3 miles. I ate lunch. I took a nap. Remind me to stretch every day.",
    ]) {
      expect(shouldUseBulkPath(msg), msg).toBe(false);
    }
  });

  it("bulk-routes generated 10/20/50-action messages", () => {
    for (const n of [10, 20, 50]) {
      const msg = buildActions(n);
      expect(countActionClauses(msg), `${n}-action message`).toBeGreaterThanOrEqual(n - 2);
      expect(shouldUseBulkPath(msg), `${n}-action message`).toBe(true);
    }
  });

  it("threshold catches 4-action recaps without swallowing 1-3 action chat", () => {
    expect(BULK_ACTION_THRESHOLD).toBeGreaterThanOrEqual(3);
    expect(BULK_ACTION_THRESHOLD).toBeLessThanOrEqual(8);
  });
});

// ── Mega-plan router ──
// A giant mixed-CRUD "set up my whole dashboard" message must route to the
// mega path even though it is stuffed with the CRUD verbs and question marks
// that suppress the bulk path.

const MEGA_MESSAGE = [
  "Review and update every section of my Executive dashboard separately, but skip Documents entirely.",
  "Attention: Create an urgent alert for my overdue vehicle-registration renewal due tomorrow at 5:00 PM; create an alert for the unpaid electric bill that was due yesterday; add a high-priority dentist task due today.",
  "Tasks: Create a high-priority task to call the dentist today at 9:00 AM. Create a medium-priority task to finish my monthly budget by Friday. Create a low-priority task to clean my car Saturday morning.",
  "Events: Add a doctor's appointment on August 6 from 2:00 PM to 3:00 PM. Add soccer practice every Sunday at 5:30 PM. Add my mom's birthday as an annual all-day event.",
  "Bills: Create a one-time electric bill for $142 due tomorrow. Create a monthly phone bill for $86.50 due on the 15th. Create a monthly internet bill for $74.99 due on the 20th.",
  "Habits: Schedule a daily morning medication habit at 8:00 AM. Schedule a workout habit every Monday, Wednesday, and Friday at 6:00 PM. Set a daily water goal of 96 ounces. Add guitar practice every evening at 7:30 PM.",
  "Trackers: Log that I ran 3.2 miles in 29 minutes. Log 7,800 steps. Log 84 ounces of water. Log 7 hours and 20 minutes of sleep. Record a weight of 183.6 pounds. Record blood pressure of 122/77 and a resting heart rate of 59 BPM. Log 40 minutes of guitar practice and a 55-minute strength workout. Record mood 8/10 and energy 7/10.",
  "Finance: Record $1,000 of income. Record a $62 grocery purchase and $45 for gas. Record the $86.50 phone payment. Record a $250 transfer from checking to savings.",
  "Assets: Create a Honda CR-V asset linked to my profile with a current value of $24,500 and 48,250 miles. Link the auto loan to it. Add an oil change completed today for $78.40.",
  "Liabilities: Create a recurring Progressive auto-insurance liability for $186.42 due on the 15th of every month. Create an auto loan with a remaining balance of $13,800 and a $412 monthly payment due on the 8th. Generate the next 12 payment dates.",
  "Finally, refresh every dashboard bubble and verify that everything matches the underlying records?",
].join("\n");

describe("shouldUseMegaPlanPath", () => {
  it("routes the giant mixed-CRUD dashboard command to the mega path", () => {
    expect(MEGA_MESSAGE.length).toBeGreaterThanOrEqual(MEGA_CHAR_THRESHOLD);
    expect(shouldUseMegaPlanPath(MEGA_MESSAGE)).toBe(true);
  });

  it("is not vetoed by CRUD verbs or question marks (unlike the bulk path)", () => {
    expect(shouldUseBulkPath(MEGA_MESSAGE)).toBe(false);
    expect(shouldUseMegaPlanPath(MEGA_MESSAGE)).toBe(true);
  });

  it("never fires on short messages, even command-dense ones", () => {
    const short = "Create a task to call the dentist. Create a bill for $50. Add an event Friday.";
    expect(short.length).toBeLessThan(MEGA_CHAR_THRESHOLD);
    expect(shouldUseMegaPlanPath(short)).toBe(false);
  });

  it("never fires on long but sparse prose (few operations)", () => {
    const essay = ("The quick brown fox jumps over the lazy dog and considers its life choices at length. ").repeat(40);
    expect(essay.length).toBeGreaterThan(MEGA_CHAR_THRESHOLD);
    expect(shouldUseMegaPlanPath(essay)).toBe(false);
  });

  it("does not steal the bulk path's homogeneous recaps", () => {
    // A pure activity recap stays on the bulk path (shorter than the mega
    // char floor) — mega only takes messages that are both long AND dense.
    expect(TWENTY_ACTION_MESSAGE.length).toBeLessThan(MEGA_CHAR_THRESHOLD);
    expect(shouldUseBulkPath(TWENTY_ACTION_MESSAGE)).toBe(true);
    expect(shouldUseMegaPlanPath(TWENTY_ACTION_MESSAGE)).toBe(false);
  });

  it("countCommandClauses sees imperative CRUD clauses that countActionClauses misses", () => {
    const cmd = "Create a task to call the dentist; add a doctor's appointment on August 6; schedule a workout habit; log 84 ounces of water.";
    expect(countCommandClauses(cmd)).toBeGreaterThanOrEqual(4);
    expect(MEGA_CLAUSE_THRESHOLD).toBeGreaterThanOrEqual(8);
  });
});
