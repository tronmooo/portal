/**
 * Rule 6 at the storage layer: the ACTIVE profile (server/active-scope-context)
 * is the owner a new record defaults to; an ambiguous scope or an unknown
 * named owner stops with OwnerRequiredError instead of guessing self.
 *
 * MemStorage mirrors SupabaseStorage.resolveOwnersAndValidate line for line,
 * so this pins the shared decision table at the one place every write
 * funnels through.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { runWithActiveScope, getActiveProfileIds, getActiveProfileId } from "../server/active-scope-context";
import { OwnerRequiredError } from "../shared/owner-resolution";
import { WriteValidationError } from "../shared/write-validation";

let s: MemStorage;
let self: { id: string };
let avery: { id: string };
let morgan: { id: string };

beforeEach(async () => {
  s = new MemStorage();
  self = await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
  avery = await s.createProfile({ name: "Avery", type: "person", fields: {} } as any);
  morgan = await s.createProfile({ name: "Morgan", type: "person", fields: {} } as any);
});

const inScope = <T,>(ids: string[], fn: () => Promise<T>) => runWithActiveScope(ids, fn);

describe("active-scope context", () => {
  it("is empty outside a request and exact inside one", async () => {
    expect(getActiveProfileIds()).toEqual([]);
    expect(getActiveProfileId()).toBeNull();
    await inScope([" a ", "b", "a"], async () => {
      expect(getActiveProfileIds()).toEqual(["a", "b"]);
      expect(getActiveProfileId()).toBeNull();
    });
    await inScope(["a"], async () => expect(getActiveProfileId()).toBe("a"));
  });
});

describe("createX with the active scope set to Avery", () => {
  it("an expense with no owner lands on Avery, not self", async () => {
    const e = await inScope([avery.id], () => s.createExpense({ amount: 12, category: "food", description: "Lunch", date: "2026-09-22" } as any));
    expect(e.linkedProfiles).toEqual([avery.id]);
  });

  it("every create surface defaults to Avery: task, event, income, habit, tracker, document, goal, journal, artifact, obligation", async () => {
    await inScope([avery.id], async () => {
      expect((await s.createTask({ title: "Call the vet" } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createEvent({ title: "Dentist", date: "2026-09-30" } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createIncome({ description: "Paycheck", amount: 1000, frequency: "monthly" } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createHabit({ name: "Stretch" } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createTracker({ name: "Weight", category: "health", fields: [{ name: "weight", type: "number" }] } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createDocument({ name: "Passport", type: "identification", fileData: "" } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createGoal({ title: "Run 5k", type: "custom", target: 5, unit: "km" } as any)).linkedProfiles).toEqual([avery.id]);
      expect(((await s.createJournalEntry({ date: "2026-09-22", mood: "good", content: "x" } as any)) as any).linkedProfiles).toEqual([avery.id]);
      expect((await s.createArtifact({ type: "note", title: "n", content: "" } as any)).linkedProfiles).toEqual([avery.id]);
      expect((await s.createObligation({ name: "Phone", amount: 40, frequency: "monthly", nextDueDate: "2026-10-01" } as any)).linkedProfiles).toEqual([avery.id]);
    });
  });

  it("a child-type profile (an asset) nests under Avery — the wrong-person regression", async () => {
    const tv = await inScope([avery.id], () => s.createProfile({ name: "Samsung TV", type: "asset", fields: {} } as any));
    expect(tv.parentProfileId).toBe(avery.id);
    const car = await s.createProfile({ name: "Civic", type: "vehicle", fields: {} } as any); // Everyone scope
    expect(car.parentProfileId).toBe(self.id);
  });

  it("an explicit owner always wins over the active profile", async () => {
    const e = await inScope([avery.id], () => s.createExpense({ amount: 5, category: "food", description: "Coffee", linkedProfiles: [morgan.id] } as any));
    expect(e.linkedProfiles).toEqual([morgan.id]);
  });
});

describe("Everyone scope (nothing selected)", () => {
  it("defaults to self — the speaker is the user", async () => {
    const e = await s.createExpense({ amount: 5, category: "food", description: "Coffee" } as any);
    expect(e.linkedProfiles).toEqual([self.id]);
  });
});

describe("stop and ask — never guess", () => {
  it("two active profiles and no owner → OwnerRequiredError (409 OWNER_REQUIRED)", async () => {
    await expect(inScope([avery.id, morgan.id], () => s.createExpense({ amount: 5, category: "food", description: "Coffee" } as any)))
      .rejects.toBeInstanceOf(OwnerRequiredError);
    try {
      await inScope([avery.id, morgan.id], () => s.createTask({ title: "x" } as any));
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe("OWNER_REQUIRED");
      expect(e.message).toMatch(/which profile/i);
    }
    expect(await s.getExpenses()).toHaveLength(0);
    expect(await s.getTasks()).toHaveLength(0);
  });

  it("two active profiles WITH an explicit owner is fine", async () => {
    const e = await inScope([avery.id, morgan.id], () => s.createExpense({ amount: 5, category: "food", description: "Coffee", linkedProfiles: [morgan.id] } as any));
    expect(e.linkedProfiles).toEqual([morgan.id]);
  });

  it("an explicit owner that does not exist → error, not self", async () => {
    await expect(s.createExpense({ amount: 5, category: "food", description: "Coffee", linkedProfiles: ["no-such-profile"] } as any))
      .rejects.toBeInstanceOf(OwnerRequiredError);
    await expect(inScope([avery.id], () => s.createEvent({ title: "x", date: "2026-09-22", linkedProfiles: ["ghost"] } as any)))
      .rejects.toBeInstanceOf(OwnerRequiredError);
    expect(await s.getExpenses()).toHaveLength(0);
  });

  it("a parent that does not exist is refused (Rule 34), and a real one is kept", async () => {
    await expect(s.createProfile({ name: "Stereo", type: "asset", fields: {}, parentProfileId: "ghost" } as any)).rejects.toBeInstanceOf(WriteValidationError);
    const stereo = await s.createProfile({ name: "Stereo", type: "asset", fields: {}, parentProfileId: morgan.id } as any);
    expect(stereo.parentProfileId).toBe(morgan.id);
  });

  it("invalid dates and money are refused before the row exists (Rule 34)", async () => {
    await expect(s.createExpense({ amount: 5, category: "food", description: "x", date: "2026-02-30" } as any)).rejects.toBeInstanceOf(WriteValidationError);
    await expect(s.createIncome({ description: "x", amount: -1 } as any)).rejects.toBeInstanceOf(WriteValidationError);
    expect(await s.getExpenses()).toHaveLength(0);
  });
});

describe("Rule 35 at the write path (duplicate guard)", () => {
  it("the same expense written again moments later is the same row; __allowDuplicate makes a second one", async () => {
    const a = await s.createExpense({ amount: 12, category: "food", description: "Lunch", date: "2026-09-22" } as any);
    const b = await s.createExpense({ amount: 12, category: "food", description: "Lunch!", date: "2026-09-22" } as any);
    expect(b.id).toBe(a.id);
    expect(await s.getExpenses()).toHaveLength(1);
    const c = await s.createExpense({ amount: 12, category: "food", description: "Lunch", date: "2026-09-22", __allowDuplicate: true } as any);
    expect(c.id).not.toBe(a.id);
    expect((c as any).__allowDuplicate).toBeUndefined();
    expect(await s.getExpenses()).toHaveLength(2);
  });

  it("a different person's identical lunch is a second row", async () => {
    await inScope([avery.id], () => s.createExpense({ amount: 12, category: "food", description: "Lunch", date: "2026-09-22" } as any));
    await inScope([morgan.id], () => s.createExpense({ amount: 12, category: "food", description: "Lunch", date: "2026-09-22" } as any));
    expect(await s.getExpenses()).toHaveLength(2);
  });

  it("a request stamp makes a retry idempotent for incomes, tasks and events", async () => {
    const i1 = await s.createIncome({ description: "Paycheck", amount: 1000, frequency: "once", date: "2026-09-22", __requestId: "r1" } as any);
    const i2 = await s.createIncome({ description: "Paycheck", amount: 1000, frequency: "once", date: "2026-09-22", __requestId: "r1" } as any);
    expect(i2.id).toBe(i1.id);
    const t1 = await s.createTask({ title: "Buy milk", dueDate: "2026-09-23" } as any);
    const t2 = await s.createTask({ title: "buy milk", dueDate: "2026-09-23" } as any);
    expect(t2.id).toBe(t1.id);
    const e1 = await s.createEvent({ title: "Dentist", date: "2026-09-30", time: "09:00" } as any);
    const e2 = await s.createEvent({ title: "Dentist", date: "2026-09-30", time: "15:00" } as any);
    expect(e2.id).not.toBe(e1.id); // a different clock time is a question, not a certainty
  });
});
