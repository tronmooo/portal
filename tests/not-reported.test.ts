// A sentence that reports nothing of the user's is not recorded.
//
// Chat variations, 2026-11-24 (production): "I didn't go to the gym today"
// logged a gym session (≈30 min, ≈165 kcal) and created a Gym tracker; "my
// sister spent $200 on shoes" was filed as the user's own $200 expense.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordsAnOccurrence, whyNotReported } from "../shared/not-reported";
import { notReportedViolation } from "../shared/ai-tool-routing";

describe("whyNotReported", () => {
  it("a sentence that says it did NOT happen", () => {
    for (const m of [
      "I didn't go to the gym today", "I did not take my vitamins", "I haven't had any coffee today",
      "didn't run this morning", "I couldn't sleep last night", "I forgot to take my medication",
      "I wasn't able to work out", "We didn't go out to eat", "I never got to the gym this week",
      "I really didn't feel like running",
    ]) expect(whyNotReported(m), m).toBe("denied");
  });

  it("a denial with a real report beside it is left to the model", () => {
    for (const m of [
      "I didn't sleep well, only 5 hours", "I skipped lunch but had a $4 coffee", "I didn't run but I walked 2 miles",
      "I haven't logged my weight yet: 181", "I didn't go to the gym and spent $12 on lunch instead",
      "I couldn't finish, only did 20 minutes", "didn't eat breakfast, just 2 cups of coffee",
    ]) expect(whyNotReported(m), m).toBeNull();
  });

  it("an ordinary report, a plan, a request and a question are not refused here", () => {
    for (const m of [
      "I went to the gym today", "spent $12.50 on lunch", "weight 182.4", "ran 3 miles in 28 minutes",
      "remind me to call the plumber tomorrow", "don't let me forget to water the ferns tomorrow",
      "I bought Sarah a birthday gift for $35", "I got Sarah a gift", "did I go to the gym today?",
      "I paid 40 bucks for gas yesterday", "Just walked the dog", "Took my vitamins",
    ]) expect(whyNotReported(m), m).toBeNull();
  });

  it("something that happened to someone else, filed under the speaker", () => {
    for (const m of [
      "my sister spent $200 on shoes", "My brother ran a marathon yesterday", "my wife bought groceries for $80",
      "our neighbour's dog ate a whole pizza", "my best friend lost 10 pounds", "My mom paid $60 for dinner",
      "John walked the dog", "She ran 5 miles",
    ]) expect(whyNotReported(m, {}), m).toBe("someone_else");
  });

  it("a call that names that person's own profile is their record, not a refusal", () => {
    expect(whyNotReported("Rex ran 2 miles", { trackerName: "Running", forProfile: "Rex" })).toBeNull();
    expect(whyNotReported("my wife bought groceries for $80", { description: "Groceries", amount: 80, forProfile: "Dana" })).toBeNull();
    // "me" is not another owner.
    expect(whyNotReported("my sister spent $200 on shoes", { description: "Shoes", amount: 200, forProfile: "me" })).toBe("someone_else");
  });

  it("only tools that record that something happened are held to it", () => {
    for (const t of ["log_tracker_entry", "create_expense", "log_income", "checkin_habit", "log_medication_dose", "pay_obligation"]) expect(recordsAnOccurrence(t), t).toBe(true);
    for (const t of ["create_task", "create_event", "create_note", "journal_entry", "save_memory", "update_expense", "delete_task", "create_profile"]) expect(recordsAnOccurrence(t), t).toBe(false);
  });

  it("the refusal is a directive to the model and puts nothing on the user's checklist", () => {
    const denied = notReportedViolation("log_tracker_entry", "denied");
    expect(denied.mismatchType).toBe("not_reported");
    expect(denied.modelDirective).toMatch(/did NOT happen/);
    expect(denied.userMessage).toBe("");
    expect(notReportedViolation("create_expense", "someone_else").modelDirective).toMatch(/SOMEONE ELSE/);
  });
});

// The quick paths that answer without the model must not record these either.
const db = { writes: [] as string[], modelCalls: 0 };
vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/New_York",
    getProfiles: async () => [{ id: "p-self", name: "Robert", type: "self", fields: {} }],
    getSelfProfile: async () => ({ id: "p-self", name: "Robert", type: "self", fields: {} }),
    getPreference: async () => null,
  };
  const storage = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (/^(create|update|delete|log|checkin|complete|set|save|add|upsert)/.test(prop)) {
        return async (...args: any[]) => { db.writes.push(`${prop}:${JSON.stringify(args).slice(0, 80)}`); return undefined; };
      }
      return async () => [];
    },
  });
  return { storage };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { db.modelCalls++; throw new Error("model unavailable in this test"); },
      stream: () => { db.modelCalls++; throw new Error("model unavailable in this test"); },
    };
  },
}));

describe("no quick path records a non-report", () => {
  let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
  beforeEach(async () => {
    db.writes = []; db.modelCalls = 0;
    ({ processMessage } = await import("../server/ai-engine") as any);
  });

  it("a denial or someone else's doing writes nothing before the model is asked", async () => {
    for (const m of ["I didn't go to the gym today", "my sister spent $200 on shoes", "I haven't had any coffee today", "John walked the dog"]) {
      db.writes = [];
      await processMessage(m, [], "user-1").catch(() => undefined);
      expect(db.writes, `${m} → ${db.writes.join(" ; ")}`).toEqual([]);
    }
  });
});
