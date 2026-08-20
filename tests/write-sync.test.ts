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
