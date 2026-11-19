// An expense added on an asset shows on that asset's Money tab, in the
// category the user picked.
//
// 2026-11-19 (owner report):
//  • An expense added from the asset's own page saved (toast, Cash Flow,
//    dashboard, the asset's Activity tab) but its Money tab said "No expenses
//    logged", even after a reload. The form created it under the account
//    holder and linked the asset afterwards, so the asset was the SECOND
//    linked profile and the tab only listed first-entry (owned) expenses.
//  • "General" was stored as Entertainment: the route re-categorized any
//    expense arriving as "general", including a deliberate pick.
//
// The route tests boot the real Express app (tests/helpers/route-harness.ts).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { expenseShownOnProfile } from "../shared/expense-on-profile";
import { thingNamedInSpend } from "../shared/expense-attribution";

// The categorizer always answers "entertainment", so a test that expects
// "general" fails unless the route really skipped it.
const picks: any[] = [];
vi.mock("../server/ai-decide", () => ({
  aiDecide: async () => ({ value: null }),
  aiPickIndex: async (args: any) => {
    picks.push(args);
    return { value: { index: (args.options as string[]).indexOf("entertainment") } };
  },
}));

import { startHarness, type Harness } from "./helpers/route-harness";

const SELF = { id: "p-self", name: "Bob Robertson", type: "self", fields: {} };
const SONY = { id: "a-sony", name: "Sony WH-1000XM5 headphones", type: "asset", fields: {} };

describe("which expenses a Money tab lists", () => {
  it("an asset lists an expense it owns", () => {
    expect(expenseShownOnProfile({ linkedProfiles: [SONY.id] }, SONY.id, "asset")).toBe(true);
  });
  it("an asset lists an expense filed under the account holder and linked to it (the rows already saved)", () => {
    expect(expenseShownOnProfile({ linkedProfiles: [SELF.id, SONY.id] }, SONY.id, "asset")).toBe(true);
  });
  it("an asset does not list an expense that is not linked to it", () => {
    expect(expenseShownOnProfile({ linkedProfiles: [SELF.id] }, SONY.id, "asset")).toBe(false);
    expect(expenseShownOnProfile({ linkedProfiles: [] }, SONY.id, "asset")).toBe(false);
    expect(expenseShownOnProfile({}, SONY.id, "asset")).toBe(false);
  });
  it("a person still sees only what they own, not what they are co-linked to", () => {
    expect(expenseShownOnProfile({ linkedProfiles: ["p-jane", "p-test"] }, "p-test", "person")).toBe(false);
    expect(expenseShownOnProfile({ linkedProfiles: ["p-test", "p-jane"] }, "p-test", "person")).toBe(true);
    expect(expenseShownOnProfile({ linkedProfiles: [SONY.id, SELF.id] }, SELF.id, "self")).toBe(false);
  });
});

describe("a chat spend that names an asset in full is linked to it", () => {
  const CRV = { id: "a-crv", name: "Honda CR-V" };
  const CRV_EX = { id: "a-crv-ex", name: "Honda CR-V EX" };
  const things = [SONY, CRV, CRV_EX];
  it("links the asset the sentence names", () => {
    expect(thingNamedInSpend("I spent $40 on ear pads for my Sony WH-1000XM5 headphones", things)?.id).toBe(SONY.id);
  });
  it("prefers the longer of two names when one contains the other", () => {
    expect(thingNamedInSpend("oil change on the Honda CR-V EX, $60", things)?.id).toBe(CRV_EX.id);
    expect(thingNamedInSpend("oil change on the Honda CR-V, $60", things)?.id).toBe(CRV.id);
  });
  it("attributes nothing when two different things are named", () => {
    expect(thingNamedInSpend("gas for the Honda CR-V and pads for the Sony WH-1000XM5 headphones", things)).toBeNull();
  });
  it("does not match part of a word or a partial name", () => {
    expect(thingNamedInSpend("I spent $12 at Sony Pictures", things)).toBeNull();
    expect(thingNamedInSpend("coffee $5", things)).toBeNull();
    expect(thingNamedInSpend("", things)).toBeNull();
  });
});

describe("POST /api/expenses from the asset page", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ profiles: [SELF, SONY] }); });
  afterAll(async () => { await h.close(); });

  it("files the expense under the asset the form names, so its Money tab lists it", async () => {
    const r = await h.api("POST", "/api/expenses", {
      description: "Replacement ear pads", amount: 39.99, category: "general", categoryChosen: true,
      date: "2026-11-18", linkedProfiles: [SONY.id],
    });
    expect(r.status).toBe(201);
    const saved = h.db.expenses.find((e) => e.id === r.data.id);
    expect(saved.linkedProfiles).toEqual([SONY.id]);
    expect(expenseShownOnProfile(saved, SONY.id, SONY.type)).toBe(true);
    expect(saved.date).toBe("2026-11-18");
  });

  it("stores a picked 'General' as General", async () => {
    picks.length = 0;
    const r = await h.api("POST", "/api/expenses", {
      description: "Concert tickets", amount: 80, category: "general", categoryChosen: true, date: "2026-11-17",
    });
    expect(r.status).toBe(201);
    expect(h.db.expenses.find((e) => e.id === r.data.id).category).toBe("general");
    expect(picks).toEqual([]);
    // The flag is the caller's answer, not a stored field.
    expect("categoryChosen" in h.db.expenses.find((e) => e.id === r.data.id)).toBe(false);
  });

  it("still categorizes when the form's default was left untouched", async () => {
    picks.length = 0;
    const r = await h.api("POST", "/api/expenses", {
      description: "Movie night", amount: 30, category: "general", date: "2026-11-16",
    });
    expect(r.status).toBe(201);
    expect(picks).toHaveLength(1);
    expect(h.db.expenses.find((e) => e.id === r.data.id).category).toBe("entertainment");
  });
});

describe("the Add Expense dialog on a profile page", () => {
  const src = readFileSync(resolve(__dirname, "../client/src/pages/profile-detail.tsx"), "utf8");
  const start = src.indexOf("const createExpenseMutation = useMutation(");
  const body = src.slice(start, src.indexOf("const updateExpenseMutation", start));
  it("creates the expense under the profile in one write", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/linkedProfiles: \[profileId\]/);
    expect(body).not.toMatch(/\/link`/);
  });
  it("shows a required-field error only after the field was visited", () => {
    expect(src).toMatch(/expTouched\.desc && expDesc\.trim\(\) === ""/);
    expect(src).not.toMatch(/showAddExpense && expDesc\.trim\(\) === ""/);
  });
});
