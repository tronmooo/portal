import { describe, it, expect } from "vitest";
import { collectOwnedAssetExpenses, ownedAssetExpenseTotal } from "../shared/cost-of-ownership";

const asset = (id: string, name: string, extra: any = {}) => ({ id, name, type: "vehicle", ...extra });
const exp = (id: string, amount: number, owner?: string, extra: any = {}) => ({
  id, amount, linkedProfiles: owner ? [owner] : [], ...extra,
});

describe("collectOwnedAssetExpenses", () => {
  it("surfaces expenses linked to an owned asset, attributed to that asset", () => {
    const rows = collectOwnedAssetExpenses(
      [asset("car", "Honda CRV")],
      [exp("e1", 50, "car"), exp("e2", 30, "someone-else"), exp("e3", 20, "car")],
    );
    expect(rows.map((r) => r.expense.id).sort()).toEqual(["e1", "e3"]);
    expect(rows.every((r) => r.viaAsset.id === "car" && r.viaAsset.name === "Honda CRV")).toBe(true);
  });

  it("counts each expense at most once (no duplication)", () => {
    const rows = collectOwnedAssetExpenses(
      [asset("car", "Honda"), asset("boat", "Boat")],
      [exp("e1", 50, "car"), exp("e1", 50, "car")], // duplicate row id
    );
    expect(rows.length).toBe(1);
  });

  it("excludes expenses already shown as the person's direct expenses", () => {
    const rows = collectOwnedAssetExpenses(
      [asset("car", "Honda")],
      [exp("e1", 50, "car"), exp("e2", 25, "car")],
      new Set(["e1"]),
    );
    expect(rows.map((r) => r.expense.id)).toEqual(["e2"]);
  });

  it("attributes by the FIRST linked profile (the asset it was created under)", () => {
    // Expense created under the asset but also co-linked to a person → still the asset's.
    const rows = collectOwnedAssetExpenses(
      [asset("car", "Honda")],
      [exp("e1", 50, "car", { linkedProfiles: ["car", "person"] })],
    );
    expect(rows.length).toBe(1);
    // A cost whose FIRST link is the person (not the asset) is NOT pulled in here.
    const none = collectOwnedAssetExpenses(
      [asset("car", "Honda")],
      [exp("e2", 50, "person", { linkedProfiles: ["person", "car"] })],
    );
    expect(none.length).toBe(0);
  });

  it("ignores orphan expenses with no owner link", () => {
    const rows = collectOwnedAssetExpenses([asset("car", "Honda")], [exp("e1", 50, undefined)]);
    expect(rows.length).toBe(0);
  });

  it("returns nothing when the person owns no assets", () => {
    expect(collectOwnedAssetExpenses([], [exp("e1", 50, "car")])).toEqual([]);
  });
});

describe("ownedAssetExpenseTotal", () => {
  it("sums full amounts when ownership is 100% / unknown", () => {
    const rows = collectOwnedAssetExpenses([asset("car", "Honda")], [exp("e1", 50, "car"), exp("e2", 30, "car")]);
    expect(ownedAssetExpenseTotal(rows)).toBe(80);
  });

  it("applies the owner's share for a co-owned asset", () => {
    const rows = collectOwnedAssetExpenses(
      [asset("car", "Honda", { _ownershipPercentage: 50 })],
      [exp("e1", 100, "car")],
    );
    expect(ownedAssetExpenseTotal(rows)).toBe(50);
  });
});
