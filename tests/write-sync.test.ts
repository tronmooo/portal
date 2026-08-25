// REST write → UI synchronization.
//
// The AI chat path got a change manifest, an optimistic cache patch and a
// read-your-writes token. Ordinary writes from the interface — every Add
// button, checkbox and delete, ~600 call sites — got none of it, which is why
// they still felt slow and why a deleted row could linger on other screens.
// write-sync hooks the one function they all share (apiRequest), so these tests
// pin the behaviour every one of those call sites now inherits.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { queryClient } from "../client/src/lib/queryClient";
import {
  applyRestWrite, parseWriteTarget, tombstone, clearTombstone, isTombstoned,
  filterTombstoned, clearAllTombstones,
} from "../client/src/lib/write-sync";

const SELF = "self-1";
const PROFILES = [{ id: SELF, type: "self", name: "Me" }];

beforeEach(() => {
  queryClient.clear();
  clearAllTombstones();
  queryClient.setQueryData(["/api/profiles"], PROFILES);
});
afterEach(() => {
  queryClient.clear();
  clearAllTombstones();
  vi.restoreAllMocks();
});

describe("parseWriteTarget", () => {
  it("reads the collection and id out of a write URL", () => {
    expect(parseWriteTarget("/api/tasks")).toEqual({ collection: "/api/tasks", id: undefined });
    expect(parseWriteTarget("/api/tasks/abc")).toEqual({ collection: "/api/tasks", id: "abc" });
    expect(parseWriteTarget("/api/tasks/abc?x=1")).toEqual({ collection: "/api/tasks", id: "abc" });
  });

  it("ignores anything that is not an /api path", () => {
    expect(parseWriteTarget("/health")).toBeNull();
  });
});

describe("applyRestWrite — a create shows up everywhere at once", () => {
  it("inserts the created row into every cached slot for that collection", () => {
    queryClient.setQueryData(["/api/tasks"], [{ id: "old" }]);
    queryClient.setQueryData(["/api/tasks", "everyone"], [{ id: "old" }]);
    queryClient.setQueryData(["/api/tasks", "selected", SELF], [{ id: "old" }]);

    applyRestWrite("POST", "/api/tasks", { id: "new-1", title: "Buy milk", linkedProfiles: [SELF] });

    for (const key of [["/api/tasks"], ["/api/tasks", "everyone"], ["/api/tasks", "selected", SELF]]) {
      expect(queryClient.getQueryData<any[]>(key as any)?.map((r) => r.id), JSON.stringify(key))
        .toEqual(["new-1", "old"]);
    }
  });

  it("stays out of the way of a call site doing its own optimistic insert", () => {
    // tasks.tsx inserts a temp row then swaps it for the server row. Inserting
    // a second copy here would show the item twice until that swap ran.
    queryClient.setQueryData(["/api/tasks"], [{ id: "temp-1", _optimistic: true }]);
    applyRestWrite("POST", "/api/tasks", { id: "new-1", title: "Buy milk", linkedProfiles: [SELF] });
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.map((r) => r.id)).toEqual(["temp-1"]);
  });

  it("ignores a bare acknowledgement that is not a row", () => {
    queryClient.setQueryData(["/api/tasks"], [{ id: "old" }]);
    applyRestWrite("POST", "/api/tasks", { id: "new-1", ok: true });
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.map((r) => r.id)).toEqual(["old"]);
  });
});

describe("applyRestWrite — an edit propagates immediately", () => {
  it("merges the updated fields over the cached row, keeping the rest", () => {
    queryClient.setQueryData(["/api/tasks"], [
      { id: "t1", title: "Old", dueDate: "2026-09-01", notes: "keep me" },
    ]);
    applyRestWrite("PATCH", "/api/tasks/t1", { id: "t1", title: "New", status: "done" });
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.[0]).toEqual({
      id: "t1", title: "New", status: "done", dueDate: "2026-09-01", notes: "keep me",
    });
  });
});

describe("applyRestWrite — a delete disappears everywhere at once", () => {
  it("removes the row from every cached slot for that collection", () => {
    queryClient.setQueryData(["/api/tasks"], [{ id: "a" }, { id: "b" }]);
    queryClient.setQueryData(["/api/tasks", "selected", SELF], [{ id: "a" }, { id: "b" }]);
    applyRestWrite("DELETE", "/api/tasks/a", null);
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.map((r) => r.id)).toEqual(["b"]);
    expect(queryClient.getQueryData<any[]>(["/api/tasks", "selected", SELF])?.map((r) => r.id)).toEqual(["b"]);
  });

  it("targets the last path segment, so a sub-resource delete removes the right thing", () => {
    queryClient.setQueryData(["/api/habits"], [{ id: "h1" }, { id: "c9" }]);
    applyRestWrite("DELETE", "/api/habits/h1/checkin/c9", null);
    expect(isTombstoned("c9")).toBe(true);
    expect(isTombstoned("h1")).toBe(false);
  });
});

describe("tombstones — a deleted row cannot come back", () => {
  it("filters a deleted row out of a response that still contains it", () => {
    // Exactly the production failure: a request already in flight, or an
    // instance that had not busted its cache, answers with the pre-delete list.
    applyRestWrite("DELETE", "/api/tasks/a", null);
    const stale = [{ id: "a", title: "Deleted" }, { id: "b" }];
    expect(filterTombstoned(stale).map((r: any) => r.id)).toEqual(["b"]);
  });

  it("retires the tombstone once the server agrees the row is gone", () => {
    applyRestWrite("DELETE", "/api/tasks/a", null);
    expect(isTombstoned("a")).toBe(true);
    filterTombstoned([{ id: "b" }]); // a fresh response without the row
    expect(isTombstoned("a")).toBe(false);
  });

  it("expires on its own, so a failed delete cannot hide a row forever", () => {
    tombstone("a");
    expect(isTombstoned("a")).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect(isTombstoned("a")).toBe(false);
  });

  it("is lifted by a write that names the row again, so Undo is instant", () => {
    applyRestWrite("DELETE", "/api/tasks/a", null);
    expect(isTombstoned("a")).toBe(true);
    applyRestWrite("PATCH", "/api/tasks/a/restore", { id: "a", title: "Back", status: "todo" });
    expect(isTombstoned("a")).toBe(false);
  });

  it("leaves payloads it does not understand completely alone", () => {
    tombstone("a");
    const aggregate = { total: 3, byCategory: { food: 1 } };
    expect(filterTombstoned(aggregate)).toBe(aggregate);
    expect(filterTombstoned("not a list" as any)).toBe("not a list");
  });

  it("does nothing at all when nothing has been deleted", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(filterTombstoned(rows)).toBe(rows); // same reference — no copying on the hot path
  });
});

describe("clearTombstone", () => {
  it("releases a specific row", () => {
    tombstone("a");
    clearTombstone("a");
    expect(isTombstoned("a")).toBe(false);
  });
});

// ─── The manifest path ─────────────────────────────────────────────────────
// The URL heuristic above can only ever guess at one collection from one URL.
// A single write commonly changes more than that, and the two most important
// cases in this app — recording a payment, and any write made through a
// sub-resource URL — are exactly the ones it cannot express.
describe("applyWriteManifest — the server says what changed", () => {
  it("moves the liability balance at the same moment as the payment", async () => {
    // The failure this closes: POST /api/liabilities/:id/payments returns the
    // payment. The balance it paid down lives on a profile row, which the
    // response never mentioned, so the card, the profile totals and net worth
    // all kept the pre-payment number until a refetch came back.
    const { applyWriteManifest } = await import("../client/src/lib/write-sync");
    queryClient.setQueryData(["/api/profiles"], [
      ...PROFILES,
      { id: "liab-1", type: "liability", name: "Car loan", fields: { currentBalance: 1000 } },
    ]);
    queryClient.setQueryData(["/api/liabilities/liab-1/payments"], []);

    const handled = await applyWriteManifest({
      domains: ["liabilities", "profiles"],
      changes: [
        { op: "create", endpoint: "/api/liabilities/liab-1/payments", id: "pay-1", row: { id: "pay-1", amount: 200 } },
        { op: "update", endpoint: "/api/profiles", id: "liab-1", row: { id: "liab-1", fields: { currentBalance: 800 } } },
      ],
    });

    expect(handled).toBe(true);
    const payments = queryClient.getQueryData<any[]>(["/api/liabilities/liab-1/payments"])!;
    expect(payments.map((p) => p.id)).toContain("pay-1");
    const liability = queryClient.getQueryData<any[]>(["/api/profiles"])!.find((p) => p.id === "liab-1");
    expect(liability.fields.currentBalance).toBe(800);
  });

  it("reaches every cached slot the row appears in, not just the unscoped one", async () => {
    // The same liability is cached under the bare key and under each profile
    // filter the user has visited. A balance that updates in one of them and
    // not the others is the "it changed here but not there" report.
    const { applyWriteManifest } = await import("../client/src/lib/write-sync");
    const rows = [{ id: "liab-1", type: "liability", fields: { currentBalance: 1000 } }];
    queryClient.setQueryData(["/api/profiles"], rows);
    queryClient.setQueryData(["/api/profiles", "everyone"], rows);
    queryClient.setQueryData(["/api/profiles", "selected", SELF], rows);

    await applyWriteManifest({
      domains: ["liabilities"],
      changes: [{ op: "update", endpoint: "/api/profiles", id: "liab-1", row: { id: "liab-1", fields: { currentBalance: 800 } } }],
    });

    for (const key of [["/api/profiles"], ["/api/profiles", "everyone"], ["/api/profiles", "selected", SELF]]) {
      const row = queryClient.getQueryData<any[]>(key)!.find((p) => p.id === "liab-1");
      expect(row.fields.currentBalance, JSON.stringify(key)).toBe(800);
    }
  });

  it("tombstones a delete so an in-flight response cannot put the row back", async () => {
    const { applyWriteManifest } = await import("../client/src/lib/write-sync");
    await applyWriteManifest({
      domains: ["tasks"],
      changes: [{ op: "delete", endpoint: "/api/tasks", id: "t1" }],
    });
    expect(isTombstoned("t1")).toBe(true);
    expect(filterTombstoned([{ id: "t1" }, { id: "t2" }])).toEqual([{ id: "t2" }]);
  });

  it("still invalidates when a change has no patchable list", async () => {
    // A truncated manifest, or an entity with no list of its own (a tracker
    // entry lives inside its tracker), carries domains and nothing else. That
    // must still refresh — it is the pre-manifest behaviour, not a no-op.
    const { applyWriteManifest } = await import("../client/src/lib/write-sync");
    expect(await applyWriteManifest({ domains: ["trackers"], changes: [], truncated: true })).toBe(true);
  });

  it("declines a manifest it cannot act on, so the fallback path runs", async () => {
    const { applyWriteManifest } = await import("../client/src/lib/write-sync");
    expect(await applyWriteManifest(null)).toBe(false);
    expect(await applyWriteManifest({ domains: [], changes: [] })).toBe(false);
  });
});

describe("parseWriteTarget — sub-resource URLs address nothing in the parent list", () => {
  it("declines a URL whose row belongs to a different collection", () => {
    // "/api/liabilities/l1/payments" used to resolve to the liabilities
    // collection carrying the PAYMENT's id, so the heuristic applied a payment
    // as an update to the liabilities list, matched nothing, and silently did
    // nothing at all. Saying so is better than guessing wrong.
    expect(parseWriteTarget("/api/liabilities/l1/payments")).toBeNull();
    expect(parseWriteTarget("/api/obligations/o1/pay")).toBeNull();
    expect(parseWriteTarget("/api/habits/h1/checkin")).toBeNull();
  });

  it("still tombstones a sub-resource delete", () => {
    const change = applyRestWrite("DELETE", "/api/habits/h1/checkin/c1", null);
    expect(isTombstoned("c1")).toBe(true);
    expect(change?.endpoint).toBeNull();
  });

  it("still lifts a tombstone on restore", () => {
    tombstone("t9");
    applyRestWrite("PATCH", "/api/tasks/t9/restore", { id: "t9", title: "Back", status: "open" });
    expect(isTombstoned("t9")).toBe(false);
  });
});
