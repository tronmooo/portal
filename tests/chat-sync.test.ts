// AI write → UI synchronization.
//
// The bug this pins: an item created through AI chat was not on its page until
// the user hit refresh. The client's only reaction to a chat write used to be
// "invalidate everything and wait for the network", so what the user saw was
// gated on a refetch that could itself be served pre-write data.
//
// applyChatMutations closes that: the row the server already returned is
// written into every cached list that shows it, synchronously, and only the
// affected domains are invalidated afterwards as the reconcile.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { queryClient, getKnownDataVersion, clearDataVersion } from "../client/src/lib/queryClient";
import { applyRowPatches, scopeIdsFromKey, applyChatMutations } from "../client/src/lib/chat-sync";
import { buildChatMutation } from "../server/ai-envelope";
import type { ChatMutation } from "@shared/schema";

const SELF = "self-1";
const MIKE = "mike-1";
const PROFILES = [
  { id: SELF, type: "self", name: "Me" },
  { id: MIKE, type: "person", name: "Mike" },
];

function seedProfiles() {
  queryClient.setQueryData(["/api/profiles"], PROFILES);
}

const createTask = (overrides: Partial<ChatMutation> = {}): ChatMutation => ({
  op: "create",
  entityType: "task",
  domains: ["tasks"],
  id: "task-new",
  endpoint: "/api/tasks",
  row: { id: "task-new", title: "Call the vet", linkedProfiles: [SELF] },
  tool: "create_task",
  ...overrides,
});

beforeEach(() => {
  queryClient.clear();
  clearDataVersion();
  seedProfiles();
});
afterEach(() => {
  queryClient.clear();
  clearDataVersion();
  vi.restoreAllMocks();
});

describe("applyRowPatches — a created row lands in every list that shows it", () => {
  it("inserts into the unscoped list AND every scope-keyed slot at once", () => {
    queryClient.setQueryData(["/api/tasks"], [{ id: "old", title: "Existing" }]);
    queryClient.setQueryData(["/api/tasks", "everyone"], [{ id: "old", title: "Existing" }]);
    queryClient.setQueryData(["/api/tasks", "selected", SELF], [{ id: "old", title: "Existing" }]);

    applyRowPatches([createTask()]);

    for (const key of [["/api/tasks"], ["/api/tasks", "everyone"], ["/api/tasks", "selected", SELF]]) {
      const rows = queryClient.getQueryData<any[]>(key as any);
      expect(rows?.map((r) => r.id), `key ${JSON.stringify(key)}`).toEqual(["task-new", "old"]);
    }
  });

  it("is idempotent — a refetch that already contains the row does not duplicate it", () => {
    // The refetch landed first and already has the row.
    queryClient.setQueryData(["/api/tasks"], [{ id: "task-new", title: "Call the vet" }]);
    applyRowPatches([createTask()]);
    const rows = queryClient.getQueryData<any[]>(["/api/tasks"]);
    expect(rows).toHaveLength(1);
    expect(rows?.[0].id).toBe("task-new");
  });

  it("merges an update over the cached row instead of replacing it", () => {
    queryClient.setQueryData(["/api/tasks"], [
      { id: "task-1", title: "Old title", dueDate: "2026-09-01", notes: "keep me" },
    ]);
    applyRowPatches([
      {
        op: "update",
        entityType: "task",
        domains: ["tasks"],
        id: "task-1",
        endpoint: "/api/tasks",
        row: { id: "task-1", title: "New title" },
      },
    ]);
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.[0]).toEqual({
      id: "task-1",
      title: "New title",
      dueDate: "2026-09-01",
      notes: "keep me",
    });
  });

  it("removes a deleted row without needing the row body", () => {
    queryClient.setQueryData(["/api/tasks"], [{ id: "a" }, { id: "b" }]);
    applyRowPatches([
      { op: "delete", entityType: "task", domains: ["tasks"], id: "a", endpoint: "/api/tasks" },
    ]);
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.map((r) => r.id)).toEqual(["b"]);
  });

  it("does not insert an update for a row the list never had", () => {
    queryClient.setQueryData(["/api/tasks"], [{ id: "b" }]);
    applyRowPatches([
      {
        op: "update", entityType: "task", domains: ["tasks"], id: "a",
        endpoint: "/api/tasks", row: { id: "a", title: "Elsewhere" },
      },
    ]);
    expect(queryClient.getQueryData<any[]>(["/api/tasks"])?.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("applyRowPatches — profile scope guard", () => {
  it("keeps one person's new row out of another person's filtered list", () => {
    queryClient.setQueryData(["/api/tasks", "selected", MIKE], [{ id: "mike-task" }]);
    queryClient.setQueryData(["/api/tasks", "selected", SELF], [{ id: "self-task" }]);

    applyRowPatches([createTask()]); // linkedProfiles: [SELF]

    expect(queryClient.getQueryData<any[]>(["/api/tasks", "selected", MIKE])?.map((r) => r.id))
      .toEqual(["mike-task"]);
    expect(queryClient.getQueryData<any[]>(["/api/tasks", "selected", SELF])?.map((r) => r.id))
      .toEqual(["task-new", "self-task"]);
  });

  it("skips the insert rather than guessing when the profile list isn't cached", () => {
    queryClient.clear(); // no ["/api/profiles"] to resolve `self` against
    queryClient.setQueryData(["/api/tasks", "selected", SELF], []);
    applyRowPatches([createTask()]);
    expect(queryClient.getQueryData<any[]>(["/api/tasks", "selected", SELF])).toEqual([]);
  });

  it("leaves aggregate payloads alone — only row lists are patched", () => {
    queryClient.setQueryData(["/api/tasks", "summary"], { open: 3, done: 1 });
    applyRowPatches([createTask()]);
    expect(queryClient.getQueryData(["/api/tasks", "summary"])).toEqual({ open: 3, done: 1 });
  });
});

describe("scopeIdsFromKey", () => {
  const known = new Set([SELF, MIKE]);

  it("reads the [endpoint, mode, ...ids] convention", () => {
    expect(scopeIdsFromKey(["/api/tasks"], known)).toEqual([]);
    expect(scopeIdsFromKey(["/api/tasks", "everyone"], known)).toEqual([]);
    expect(scopeIdsFromKey(["/api/tasks", "selected", SELF, MIKE], known)).toEqual([SELF, MIKE]);
  });

  it("stops at a trailing sub-slice discriminator", () => {
    expect(scopeIdsFromKey(["/api/incomes", "selected", SELF, "hero"], known)).toEqual([SELF]);
  });

  it("returns null for a key shape it cannot read, so callers skip the insert", () => {
    // Calendar timeline puts dates before the mode — not a scope key we can parse.
    expect(scopeIdsFromKey(["/api/calendar/timeline", "2026-08-01", "2026-09-01"], known)).toBeNull();
  });

  it("returns null when there is no profile list to resolve ids against", () => {
    expect(scopeIdsFromKey(["/api/tasks", "selected", SELF], null)).toBeNull();
  });
});

describe("applyChatMutations", () => {
  it("records the server's data version as the read-your-writes token", async () => {
    await applyChatMutations([createTask()], 42);
    expect(getKnownDataVersion()).toBe(42);
  });

  it("never walks the version backwards", async () => {
    await applyChatMutations([createTask()], 42);
    await applyChatMutations([createTask()], 7);
    expect(getKnownDataVersion()).toBe(42);
  });

  it("falls back to a full invalidation when the turn carried no manifest", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as any);
    await applyChatMutations(undefined);
    expect(spy).toHaveBeenCalled();
    // The fallback must be the blanket /api sweep, i.e. the old behavior.
    const usedPredicate = spy.mock.calls.some(([arg]) => typeof (arg as any)?.predicate === "function");
    expect(usedPredicate).toBe(true);
  });

  // The bus invalidates with ONE combined predicate per call (one refetch per
  // active query — see tests/cache-bus-single-refetch.test.ts), so what it
  // touched is read by asking that predicate about a key.
  const invalidated = (spy: ReturnType<typeof vi.spyOn>, key: unknown[]) =>
    spy.mock.calls.some(([arg]) => {
      const a = arg as any;
      if (typeof a?.predicate === "function") return a.predicate({ queryKey: key });
      return JSON.stringify(a?.queryKey) === JSON.stringify(key);
    });

  it("always refreshes the dashboard aggregates, which no single row can patch", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as any);
    await applyChatMutations([createTask()], 1);
    // The bootstrap payload seeds the next launch's list caches — leaving it
    // stale is how a write "disappears" again after a reload.
    expect(invalidated(spy, ["/api/dashboard-bootstrap"])).toBe(true);
    expect(invalidated(spy, ["/api/stats"])).toBe(true);
  });

  it("invalidates the affected domains, not every domain, for a typed write", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as any);
    await applyChatMutations([createTask()], 1);
    expect(invalidated(spy, ["/api/tasks"])).toBe(true);
    // An expenses key would mean the tasks write was invalidating unrelated data.
    expect(invalidated(spy, ["/api/expenses"])).toBe(false);
  });
});

// A whole family of write tools — every liability tool, the paycheck tools, the
// ownership-link tools — returns `{ result: <row>, actions: [...] }` rather than
// the row itself. The manifest could not see through that wrapper, so those
// writes reached the client with no id and no row and the UI could only
// invalidate and wait: creating a liability left the list showing the old set
// until a refetch landed. Caught by the browser acceptance run, pinned here.
describe("buildChatMutation — the { result: row } tool family", () => {
  it("finds the row and id inside the result wrapper", () => {
    const row = { id: "liab-1", name: "Car loan", type: "liability", currentBalance: 5000 };
    const m = buildChatMutation("create_liability", { success: true, action: "create_liability" }, { result: row, actions: [] });
    expect(m).toBeTruthy();
    expect(m!.id).toBe("liab-1");
    expect(m!.row).toMatchObject({ id: "liab-1", name: "Car loan" });
    expect(m!.endpoint).toBe("/api/profiles");
    expect(m!.domains).toContain("liabilities");
  });

  it("still prefers the envelope's own verified entity id", () => {
    const m = buildChatMutation(
      "create_liability",
      { success: true, entity: { type: "profile", id: "verified-1" } },
      { result: { id: "verified-1", name: "Car loan" } },
    );
    expect(m!.id).toBe("verified-1");
  });

  it("does not invent a row when the wrapper holds a summary rather than a record", () => {
    // refund_expense returns { result: { refunded, expenseId, ... } } — no `id`,
    // so there is nothing safe to insert into a cached list.
    const m = buildChatMutation("refund_expense", { success: true }, { result: { refunded: 20, expenseId: "e1" } });
    expect(m!.row).toBeUndefined();
  });

  it("reports a dedupe as no change at all", () => {
    // A dedupe merged into an existing record; claiming a create would put a
    // phantom row in the list.
    expect(buildChatMutation("create_task", { success: true, deduped: true }, { id: "t1" })).toBeNull();
  });
});

// D121 — the optimistic insert decided list membership with only
// `{ selectedIds, allProfiles }`, so a task created for a co-owned car
// never landed in the co-owner's filtered list until the next refetch.
describe("D121: an optimistic insert honours co-ownership", () => {
  const LINDA = "linda-1";
  const CAR = "car-1";
  const carTask = () => createTask({ row: { id: "task-new", title: "Oil change", linkedProfiles: [CAR] } });
  beforeEach(() => {
    queryClient.setQueryData(["/api/profiles"], [
      ...PROFILES,
      { id: LINDA, type: "person", name: "Linda" },
      { id: CAR, type: "vehicle", name: "Honda", parentProfileId: SELF },
    ]);
    queryClient.setQueryData(["/api/tasks", "selected", LINDA], []);
    queryClient.setQueryData(["/api/tasks", "selected", MIKE], []);
    queryClient.setQueryData(["/api/tasks", "selected", SELF], []);
  });
  it("a car-linked task lands in the co-owner's list and the owner's, not in a stranger's", () => {
    queryClient.setQueryData(["/api/asset-party-links"], [{ id: "apl", assetProfileId: CAR, partyProfileId: LINDA, ownershipPercentage: 50 }]);
    applyRowPatches([carTask()]);
    expect((queryClient.getQueryData(["/api/tasks", "selected", LINDA]) as any[]).map(t => t.title)).toEqual(["Oil change"]);
    expect((queryClient.getQueryData(["/api/tasks", "selected", SELF]) as any[]).map(t => t.title)).toEqual(["Oil change"]);
    expect(queryClient.getQueryData(["/api/tasks", "selected", MIKE])).toEqual([]);
  });
  it("without cached links the co-owner's list is left to the refetch", () => {
    applyRowPatches([carTask()]);
    expect(queryClient.getQueryData(["/api/tasks", "selected", LINDA])).toEqual([]);
    expect((queryClient.getQueryData(["/api/tasks", "selected", SELF]) as any[]).map(t => t.title)).toEqual(["Oil change"]);
  });
});
