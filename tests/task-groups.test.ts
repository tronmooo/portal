// The Tasks page groups every task as mine / an asset's / a liability's from
// its linked profiles (shared/task-groups). These are the rules that decide
// which section a task is listed in.
import { describe, it, expect } from "vitest";
import { taskGroupOf, taskGroupItemKind } from "../shared/task-groups";
import { countOpenDueWithin } from "../shared/task-counts";

const P = [
  { id: "me", type: "self", name: "Me", fields: {} },
  { id: "kid", type: "person", name: "Jordan", fields: {} },
  { id: "car", type: "vehicle", name: "Honda CR-V 2021", fields: {} },
  { id: "sub", type: "subscription", name: "ChatGPT Pro", fields: {} },
  { id: "loan", type: "liability", type_key: "auto_loan", name: "Car loan", fields: {} },
  { id: "card", type: "account", name: "Visa", fields: { accountKind: "credit_card" } },
  { id: "chk", type: "account", name: "Checking", fields: { accountKind: "checking" } },
];
const byId = new Map(P.map(p => [p.id, p]));
const g = (...ids: string[]) => taskGroupOf({ linkedProfiles: ids }, byId);

describe("taskGroupOf", () => {
  it("a task with no link, or linked only to people, is personal", () => {
    expect(g()).toEqual({ kind: "mine", profileId: null });
    expect(g("me")).toEqual({ kind: "mine", profileId: null });
    expect(g("kid")).toEqual({ kind: "mine", profileId: null });
    expect(taskGroupOf({ linkedProfiles: null }, byId)).toEqual({ kind: "mine", profileId: null });
  });
  it("a task linked to something owned is that asset's", () => {
    expect(g("car")).toEqual({ kind: "asset", profileId: "car" });
    expect(g("me", "car")).toEqual({ kind: "asset", profileId: "car" });
  });
  it("a bill reminder is the bill's, a loan task the loan's", () => {
    expect(g("sub")).toEqual({ kind: "liability", profileId: "sub" });
    expect(g("loan")).toEqual({ kind: "liability", profileId: "loan" });
  });
  it("a debt wins over the asset it pays for, whatever the link order", () => {
    expect(g("car", "loan")).toEqual({ kind: "liability", profileId: "loan" });
    expect(g("loan", "car")).toEqual({ kind: "liability", profileId: "loan" });
  });
  it("an account goes by its side: a card is owed, checking is owned", () => {
    expect(g("card").kind).toBe("liability");
    expect(g("chk").kind).toBe("asset");
  });
  it("a link to a deleted profile leaves the task listed as personal", () => {
    expect(g("gone")).toEqual({ kind: "mine", profileId: null });
    expect(g("gone", "car")).toEqual({ kind: "asset", profileId: "car" });
  });
});

describe("taskGroupItemKind", () => {
  it("names the kind beside the item", () => {
    expect(taskGroupItemKind(byId.get("car"))).toBe("Vehicle");
    expect(taskGroupItemKind(byId.get("sub"))).toBe("Subscription");
    expect(taskGroupItemKind(byId.get("loan"))).toBe("Auto Loan");
    expect(taskGroupItemKind(null)).toBe("");
  });
});

describe("countOpenDueWithin", () => {
  it("counts open tasks due today through the last day, nothing else", () => {
    const tasks = [
      { status: "todo", dueDate: "2026-11-20" }, // overdue
      { status: "todo", dueDate: "2026-11-21" }, // today
      { status: "todo", dueDate: "2026-11-27" }, // last day
      { status: "todo", dueDate: "2026-11-28" }, // after
      { status: "done", dueDate: "2026-11-22" }, // done
      { status: "todo" },                        // undated
    ];
    expect(countOpenDueWithin(tasks, "2026-11-21", "2026-11-27")).toBe(2);
    expect(countOpenDueWithin(null, "2026-11-21", "2026-11-27")).toBe(0);
  });
});
