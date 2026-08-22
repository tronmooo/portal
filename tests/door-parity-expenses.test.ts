// ─── Door parity: expenses ──────────────────────────────────────────────────
//
// Expense creation was the most fragmented write in the app — three full
// implementations (chat tool, REST route, document auto-expense) plus the
// extraction confirm and the chat fast path, each with its own validation,
// dedup, category inference and attribution. server/actions/expense-service.ts
// is now the single pipeline; these tests pin the door-parity invariant and
// the canonical behaviors that used to exist in only SOME doors.
import { describe, it, expect } from "vitest";
import { executeTool } from "../server/ai-engine";
import { createExpenseRecord } from "../server/actions/expense-service";
import { inferExpenseCategory } from "@shared/expense-canon";
import {
  MemStorage,
  driveDoor,
  withStorage,
  normalizeRow,
  normalizeManifest,
  ledgerRows,
} from "./door-parity/harness";

let seq = 0;
const nextUser = () => `door-parity-exp-${++seq}`;

const BASE = { description: "Team pizza night", amount: 42.5, vendor: "Little Caesars" };

describe("door parity — expense create", () => {
  it("chat, REST and extraction doors produce the same row, manifest, and ledger contract", async () => {
    const doors = [
      {
        door: "chat" as const,
        run: (store: MemStorage) =>
          driveDoor(store, "chat", "create_expense", BASE, () =>
            executeTool("create_expense", { ...BASE }, nextUser())),
      },
      {
        door: "rest" as const,
        run: (store: MemStorage) =>
          driveDoor(store, "rest", "create_expense", BASE, () =>
            createExpenseRecord(store, { ...BASE }, { lockUser: nextUser(), dedupWindowMs: 15_000 })),
      },
      {
        door: "extraction" as const,
        run: (store: MemStorage) =>
          driveDoor(store, "extraction", "create_expense", BASE, () =>
            createExpenseRecord(store, { ...BASE }, { lockUser: nextUser(), dedupByDateAmount: true, dedupWindowMs: 0 })),
      },
    ];

    const rows: any[] = [];
    for (const d of doors) {
      const store = new MemStorage();
      const outcome = await d.run(store);
      expect(outcome.ok, `${d.door}: ok`).toBe(true);
      expect(outcome.envelope?.verification?.database_record_exists, `${d.door}: verified`).toBe(true);

      const stored = await withStorage(store, () => store.getExpenses());
      expect(stored, `${d.door}: one row`).toHaveLength(1);
      rows.push(normalizeRow(stored[0]));

      expect(normalizeManifest(outcome.mutations), `${d.door}: manifest`).toEqual([
        { op: "create", entityType: "expense", endpoint: "/api/expenses", domains: ["expenses"] },
      ]);
      expect(await ledgerRows(store), `${d.door}: ledger`).toEqual([
        { tool: "create_expense", source: d.door, entityType: "expense", reversible: true },
      ]);
    }
    // Identical end state across all three doors — including the category,
    // which every door now infers through the same shared canon.
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[1]).toEqual(rows[2]);
    expect(rows[0]?.category).toBe("food");
  });
});

describe("canonical behaviors (previously door-specific)", () => {
  it("category inference is shared: text, docType and profile-type hints", () => {
    expect(inferExpenseCategory({ description: "uber to airport" })).toBe("transport");
    expect(inferExpenseCategory({ description: "flight to denver" })).toBe("travel");
    expect(inferExpenseCategory({ description: "vet visit for Rex" })).toBe("pet");
    expect(inferExpenseCategory({ description: "netflix" })).toBe("subscription");
    expect(inferExpenseCategory({ description: "mystery charge" })).toBeNull();
    expect(inferExpenseCategory({ description: "payment", docType: "vehicle-registration" })).toBe("vehicle");
    expect(inferExpenseCategory({ description: "misc", profileType: "pet" })).toBe("pet");
  });

  it("the duplicate window now guards every door (the receipt-double-log class)", async () => {
    const store = new MemStorage();
    const user = nextUser();
    const first = await createExpenseRecord(store, { ...BASE }, { lockUser: user });
    expect(first.error).toBeUndefined();
    // Different lock scope, same DB — the second door still sees the row.
    const second = await createExpenseRecord(store, { ...BASE }, { lockUser: nextUser() });
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await store.getExpenses()).toHaveLength(1);
  });

  it("extraction's date+amount dedupe folds in as a service option", async () => {
    const store = new MemStorage();
    const created = await createExpenseRecord(store,
      { description: "Oil change", amount: 118.14, date: "2026-08-01" },
      { lockUser: nextUser(), dedupWindowMs: 0 });
    expect(created.error).toBeUndefined();
    // Same date, same amount, different description — one document must
    // never yield two expenses.
    const replay = await createExpenseRecord(store,
      { description: "Jiffy Lube service", amount: 118.14, date: "2026-08-01" },
      { lockUser: nextUser(), dedupByDateAmount: true, dedupWindowMs: 0 });
    expect(replay.deduped).toBe(true);
    expect(await store.getExpenses()).toHaveLength(1);
  });

  it("recurrence bounces to create_obligation only where the option asks for it", async () => {
    const store = new MemStorage();
    const chatLike = await createExpenseRecord(store,
      { description: "$20/mo parking pass", amount: 20 },
      { lockUser: nextUser(), rejectRecurring: true });
    expect(chatLike.error).toMatch(/create_obligation/);
    const restLike = await createExpenseRecord(store,
      { description: "monthly parking pass", amount: 20 },
      { lockUser: nextUser() });
    expect(restLike.error).toBeUndefined();
  });

  it("rejects invalid and out-of-bounds amounts identically", async () => {
    const store = new MemStorage();
    expect((await createExpenseRecord(store, { description: "x", amount: 0 }, { lockUser: nextUser() })).error).toBeTruthy();
    expect((await createExpenseRecord(store, { description: "x", amount: "abc" }, { lockUser: nextUser() })).error).toBeTruthy();
    expect((await createExpenseRecord(store, { description: "x", amount: 1e10 }, { lockUser: nextUser() })).error).toBeTruthy();
  });

  it("attributes by exact-then-word-boundary name — 'Roy' never matches 'Royale'", async () => {
    const store = new MemStorage();
    const royale = await store.createProfile({ name: "Royale", type: "person" } as any);
    const roySmith = await store.createProfile({ name: "Roy Smith", type: "person" } as any);
    const created = await createExpenseRecord(store,
      { description: "gift", amount: 25, forProfile: "Roy" },
      { lockUser: nextUser() });
    expect(created.error).toBeUndefined();
    expect(created.linkedProfiles).toEqual([roySmith.id]);
    expect(created.linkedProfiles).not.toContain(royale.id);
  });

  it("the 'for <Name>' safety net recovers attribution from the raw message, existing non-self profiles only", async () => {
    const store = new MemStorage();
    const robert = await store.createProfile({ name: "Robert", type: "person" } as any);
    await store.createProfile({ name: "Me", type: "self" } as any);
    const created = await createExpenseRecord(store,
      { description: "groceries", amount: 40, userMessage: "log a grocery run, $40 for Robert please" },
      { lockUser: nextUser() });
    expect(created.error).toBeUndefined();
    expect(created.linkedProfiles).toEqual([robert.id]);

    // An unknown name must never invent an owner.
    const orphan = await createExpenseRecord(store,
      { description: "lunch", amount: 13, userMessage: "$13 for Zebulon" },
      { lockUser: nextUser() });
    expect(orphan.error).toBeUndefined();
    expect(orphan.linkedProfiles).toEqual([]);
  });
});
