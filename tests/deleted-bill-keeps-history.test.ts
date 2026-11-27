// Deleting a bill or a debt stops what is scheduled; it does not erase money
// that was already spent (owner, 2026-11-27). Each recorded payment's expense
// stays, untouched except for one tag naming what it was paid to, unless the
// person explicitly asks for the history to be deleted too.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";
import { DELETED_SOURCE_TAG_PREFIX, deletedSourceName, paymentExpensesOf, withDeletedSourceTag } from "../shared/deleted-source";

const WATER = "00000000-0000-4000-8000-0000000000a1";
const GAS = "00000000-0000-4000-8000-0000000000a2";
const CAR = "00000000-0000-4000-8000-0000000000a3";
const bill = (id: string, name: string) => ({ id, type: "liability", type_key: "utility", name, tags: [], notes: "", documents: [], fields: { amount: 40, frequency: "monthly", dueDate: "2026-11-15" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
const paid = (id: string, liab: string, amount: number) => ({ id, description: `payment ${id}`, amount, category: "utilities", date: "2026-11-15", linkedProfiles: ["self"], tags: ["bill-payment", `liability:${liab}`, `payment:p-${id}`], createdAt: "2026-11-15T00:00:00Z" });

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    profiles: [{ id: "self", type: "self", name: "Me", fields: {}, tags: [], documents: [] }, bill(WATER, "Harbor Water"), bill(GAS, "City Gas"),
      { id: CAR, type: "vehicle", name: "Wagon", fields: { currentValue: 9000 }, tags: [], documents: [] }] as any,
    expenses: [paid("e1", WATER, 40), paid("e2", WATER, 41.5), paid("e3", GAS, 22), { id: "e4", description: "groceries", amount: 60, category: "food", date: "2026-11-15", linkedProfiles: ["self"], tags: [], createdAt: "2026-11-15T00:00:00Z" }] as any,
  });
});
afterAll(async () => { await h.close(); });

const exp = (id: string) => h.db.expenses.find((e: any) => e.id === id);

describe("deleting a bill", () => {
  it("keeps its recorded payments, each marked with the bill's name and otherwise untouched", async () => {
    const r = await h.api("DELETE", `/api/profiles/${WATER}`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ success: true, keptPayments: 2, deletedPayments: 0 });
    for (const [id, amount] of [["e1", 40], ["e2", 41.5]] as const) {
      const e = exp(id);
      expect(e, `${id} is still there`).toBeTruthy();
      expect(e.amount).toBe(amount);
      expect(e.date).toBe("2026-11-15");
      expect(e.category).toBe("utilities");
      expect(deletedSourceName(e.tags)).toBe("Harbor Water");
      expect(e.tags).toContain(`liability:${WATER}`); // the original reference is kept too
      expect(e.tags).toContain(`payment:p-${id}`);
    }
    // nobody else's spending is touched
    expect(deletedSourceName(exp("e3").tags)).toBeNull();
    expect(exp("e4").tags).toEqual([]);
    expect(h.db.profiles.some((p: any) => p.id === WATER)).toBe(false);
  });

  it("deletes the history only when asked to, explicitly", async () => {
    const r = await h.api("DELETE", `/api/profiles/${GAS}?deleteHistory=1`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ success: true, keptPayments: 0, deletedPayments: 1 });
    expect(exp("e3")).toBeUndefined();
    expect(exp("e1")).toBeTruthy();
    expect(exp("e4")).toBeTruthy();
  });

  it("deleting something that is not a bill touches no expense", async () => {
    const before = JSON.stringify(h.db.expenses);
    const r = await h.api("DELETE", `/api/profiles/${CAR}`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ keptPayments: 0, deletedPayments: 0 });
    expect(JSON.stringify(h.db.expenses)).toBe(before);
  });
});

describe("the tag", () => {
  it("is written once, holds the name as it was, and finds only that liability's payments", () => {
    const tags = withDeletedSourceTag(withDeletedSourceTag(["bill-payment"], "Old Name"), "  Harbor   Water ");
    expect(tags.filter((t) => t.startsWith(DELETED_SOURCE_TAG_PREFIX))).toEqual([`${DELETED_SOURCE_TAG_PREFIX}Harbor Water`]);
    expect(deletedSourceName(tags)).toBe("Harbor Water");
    expect(paymentExpensesOf([{ tags: ["liability:a"] }, { tags: ["liability:ab"] }, { tags: null }, {}], "a")).toHaveLength(1);
  });

  it("the delete dialog says what stays and offers the explicit choice", () => {
    const src = require("node:fs").readFileSync(`${process.cwd()}/client/src/pages/liability-detail.tsx`, "utf8") as string;
    expect(src).toMatch(/Payments already recorded stay in your\s+spending history/);
    expect(src).toMatch(/data-testid="checkbox-delete-history"/);
    expect(src).not.toMatch(/permanently delete this liability and all its data/);
    expect(src).toMatch(/deleteHistoryToo \? "\?deleteHistory=1" : ""/);
  });
});
