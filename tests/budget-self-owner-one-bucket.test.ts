// The account holder's budget is one bucket whether it was stored with their
// Self profile id (set on a screen under their own scope) or with no owner (set
// by chat or the API). Integrity run, 2026-11-28: "Copy last month" — and a
// second Add — gave the month two "housing" caps, both listed on Finance.
import { describe, it, expect } from "vitest";
import { upsertBudget, applyBudgetUpdate, mergeBudgetsForCopy, type BudgetEntry } from "../shared/budget-ledger";

const SELF = "self-1";
const ctx = { selfProfileId: SELF };
let n = 0; const id = () => `b${++n}`;

describe("one owner: the account holder, however stored", () => {
  it("copying last month adds nothing for a category the month already has (Self vs no owner)", () => {
    const dest: BudgetEntry[] = [{ id: "d1", category: "housing", amount: 1200, profileId: SELF }];
    const src: BudgetEntry[] = [{ id: "s1", category: "housing", amount: 1100 }, { id: "s2", category: "food", amount: 400 }];
    const { list, added } = mergeBudgetsForCopy(dest, src, id, ctx);
    expect(added).toBe(1);
    expect(list.filter((b) => b.category === "housing")).toHaveLength(1);
    expect(list.find((b) => b.category === "housing")?.amount).toBe(1200);
  });
  it("the same in the other direction (no owner in the month, Self in the source)", () => {
    const { list } = mergeBudgetsForCopy([{ id: "d1", category: "housing", amount: 1200 }], [{ id: "s1", category: "housing", amount: 1100, profileId: SELF }], id, ctx);
    expect(list.filter((b) => b.category === "housing")).toHaveLength(1);
  });
  it("adding the account holder's cap updates the no-owner cap instead of adding a second", () => {
    const list: BudgetEntry[] = [{ id: "a", category: "food", amount: 300 }];
    const e = upsertBudget(list, { category: "food", amount: 350, profileId: SELF }, id, ctx);
    expect(list).toHaveLength(1);
    expect(e.id).toBe("a");
    expect(list[0].amount).toBe(350);
  });
  it("an edit that would duplicate the account holder's bucket is refused", () => {
    const list: BudgetEntry[] = [{ id: "a", category: "food", amount: 300 }, { id: "b", category: "fun", amount: 50, profileId: SELF }];
    expect(() => applyBudgetUpdate(list, "b", { category: "food" }, ctx)).toThrow(/already exists/);
  });
  it("another person's cap stays its own bucket", () => {
    const list: BudgetEntry[] = [{ id: "a", category: "food", amount: 300, profileId: SELF }];
    upsertBudget(list, { category: "food", amount: 90, profileId: "kid-1" }, id, ctx);
    expect(list).toHaveLength(2);
  });
  it("both storages pass the account holder's id to every ledger write", () => {
    const fs = require("node:fs");
    for (const f of ["server/supabase-storage.ts", "server/storage.ts"]) {
      const src: string = fs.readFileSync(`${process.cwd()}/${f}`, "utf8");
      for (const call of ["upsertBudget(", "applyBudgetUpdate(", "mergeBudgetsForCopy("]) {
        const lines = src.split("\n").filter((l) => l.includes(call) && !l.includes("import"));
        expect(lines.length, `${f} ${call}`).toBeGreaterThan(0);
        for (const l of lines) expect(l, `${f}: ${l.trim()}`).toMatch(/selfProfileId/);
      }
    }
  });
});
