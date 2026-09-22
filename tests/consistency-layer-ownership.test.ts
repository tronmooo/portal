// Consistency layer — profile isolation, ownership resolution, scope (req. tests 1, 2, 3).
import { describe, expect, it } from "vitest";
import {
  resolveOwnership, describeOwner, filterVisible, resolveRequestedScope, resolveVisibleRecords,
  type OwnershipContext, type ResolvedScope,
} from "../shared/domain";

const BOB = "11111111-1111-4111-8111-111111111111";
const JANE = "22222222-2222-4222-8222-222222222222";
const RAM = "33333333-3333-4333-8333-333333333333";
const LOAN = "44444444-4444-4444-8444-444444444444";
const DOG = "55555555-5555-4555-8555-555555555555";

const ctx: OwnershipContext = {
  profiles: [
    { id: BOB, name: "Bob", type: "self" },
    { id: JANE, name: "Jane", type: "person" },
    { id: RAM, name: "Dodge Ram", type: "vehicle", parentProfileId: BOB },
    { id: LOAN, name: "Auto Loan", type: "liability", type_key: "auto_loan", parentProfileId: RAM },
    { id: DOG, name: "Rex", type: "pet", parentProfileId: JANE },
  ],
};
const current = (id: string): ResolvedScope => ({ mode: "current", profileIds: [id], label: id === BOB ? "Bob" : "Jane", explicitlyRequested: false });
const everyone: ResolvedScope = { mode: "everyone", profileIds: [], label: "Everyone", explicitlyRequested: true };

const liabilities = [
  { id: "l1", title: "Bob's card", amount: 500, linkedProfiles: [BOB] },
  { id: "l2", title: "Jane's student loan", amount: 12000, linkedProfiles: [JANE] },
];
const tasks = [
  { id: "t1", title: "Mow the lawn", linkedProfiles: [BOB], status: "todo" },
  { id: "t2", title: "Jane dentist", linkedProfiles: [JANE], status: "todo" },
  { id: "t3", title: "Unassigned chore", linkedProfiles: [], status: "todo" },
];

describe("1. Profile A cannot accidentally receive Profile B's data", () => {
  it("Bob's scope never returns Jane's liabilities, tasks, or expenses", () => {
    expect(filterVisible("obligation", liabilities, current(BOB), ctx).map((l) => l.id)).toEqual(["l1"]);
    expect(filterVisible("task", tasks, current(BOB), ctx).map((t) => t.id)).toEqual(["t1", "t3"]); // orphan rows belong to Self
    expect(filterVisible("task", tasks, current(JANE), ctx).map((t) => t.id)).toEqual(["t2"]);
    const expenses = [{ id: "e1", linkedProfiles: [JANE], amount: 40 }];
    expect(filterVisible("expense", expenses, current(BOB), ctx)).toEqual([]);
  });

  it("health data (tracker entries) stays with its profile", () => {
    const entries = [{ id: "h1", profileId: JANE, values: { hr: 58 } }, { id: "h2", profileId: BOB, values: { hr: 70 } }];
    expect(filterVisible("tracker_entry", entries, current(BOB), ctx).map((e) => e.id)).toEqual(["h2"]);
  });
});

describe("2. Everyone scope intentionally includes multiple profiles", () => {
  it("returns both people's records, and labels the scope Everyone", () => {
    const rows = resolveVisibleRecords("obligation", liabilities, everyone, ctx);
    expect(rows.map((r) => r.record.id)).toEqual(["l1", "l2"]);
    expect(rows.map((r) => r.ownership.canonicalOwnerName)).toEqual(["Bob", "Jane"]);
    expect(everyone.label).toBe("Everyone");
  });
});

describe("ownership resolution: record → entity → owner → visibility", () => {
  it("walks nesting to the canonical person owner and never guesses from names", () => {
    const loan = resolveOwnership("profile", ctx.profiles[3], ctx);
    expect(loan.entityType).toBe("liability");
    expect(loan.canonicalOwnerId).toBe(BOB);
    expect(loan.canonicalOwnerName).toBe("Bob");
    expect(loan.unassigned).toBe(false);
    // A thing named "Jane's ..." owned by Bob is Bob's — names are labels.
    const expense = resolveOwnership("expense", { id: "e", description: "Jane's gift", linkedProfiles: [BOB] }, ctx);
    expect(expense.canonicalOwnerId).toBe(BOB);
  });

  it("a thing under a pet belongs to the pet's person", () => {
    const leash = resolveOwnership("profile", { id: "x", name: "Leash", type: "asset", parentProfileId: DOG }, { ...ctx, profiles: [...ctx.profiles, { id: "x", name: "Leash", type: "asset", parentProfileId: DOG }] });
    expect(leash.canonicalOwnerId).toBe(JANE);
  });

  it("an undetermined owner is unassigned — never both unassigned and owned", () => {
    const o = resolveOwnership("task", { id: "t", title: "x", linkedProfiles: [] }, ctx);
    expect(o.unassigned).toBe(true);
    expect(o.canonicalOwnerId).toBeNull();
    expect(describeOwner(o)).toBe("Unassigned");
    const owned = resolveOwnership("task", { id: "t", title: "x", linkedProfiles: [JANE] }, ctx);
    expect(owned.unassigned).toBe(false);
    expect(describeOwner(owned)).toBe("Jane's");
  });
});

describe("3. AI Chat respects profile ownership (requested scope)", () => {
  const base = { profiles: ctx.profiles, currentProfileId: BOB };
  it("defaults to the current profile", () => {
    const s = resolveRequestedScope({ ...base, message: "what do I owe?" });
    expect(s).toMatchObject({ mode: "current", profileIds: [BOB], explicitlyRequested: false });
  });
  it("switches only when the user names another person or asks for Everyone", () => {
    expect(resolveRequestedScope({ ...base, message: "what are Jane's liabilities?" })).toMatchObject({ mode: "explicit", profileIds: [JANE], label: "Jane", explicitlyRequested: true });
    expect(resolveRequestedScope({ ...base, message: "show everyone's tasks" })).toMatchObject({ mode: "everyone", explicitlyRequested: true });
    expect(resolveRequestedScope({ ...base, message: "compare spending between us" }).mode).toBe("everyone");
  });
  it("a vehicle or pet name is not a person scope, and partial names do not match", () => {
    expect(resolveRequestedScope({ ...base, message: "tires for my Dodge Ram" }).profileIds).toEqual([BOB]);
    expect(resolveRequestedScope({ ...base, message: "who is Jan?" }).profileIds).toEqual([BOB]);
  });
  it("naming a person only narrows an existing selection, and 'with Jane' keeps Bob in scope", () => {
    expect(resolveRequestedScope({ profiles: ctx.profiles, message: "Jane and I played soccer" })).toMatchObject({ mode: "everyone" });
    expect(resolveRequestedScope({ ...base, message: "Jane and I played soccer" }).profileIds.sort()).toEqual([BOB, JANE].sort());
    expect(resolveRequestedScope({ ...base, message: "log Jane's weight" }).profileIds).toEqual([JANE]);
  });
  it("Bob asking about liabilities sees only Bob's", () => {
    const scope = resolveRequestedScope({ ...base, message: "list my liabilities" });
    expect(filterVisible("obligation", liabilities, scope, ctx).map((l) => l.id)).toEqual(["l1"]);
  });
});
