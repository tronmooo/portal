import { describe, it, expect } from "vitest";
import {
  resolveActiveCreateProfileId,
  profileScopeParam,
} from "../client/src/hooks/useProfileScope";
import { scopedKey, goalsQueryKey } from "../shared/query-keys";

// These pin the create-target and scope-plumbing rules that keep every feature
// locked to the active profile. The reactive read itself (useProfileScope) is a
// thin useSyncExternalStore wrapper exercised by the app; the decision logic
// below is pure and is where the "created under the wrong profile" / "query hit
// the wrong scope" bugs actually live.

const SELF = { id: "self-1", type: "self" } as const;
const JANE = { id: "jane-1", type: "person" } as const;
const PET = { id: "pet-1", type: "pet" } as const;
const ALL = [SELF, JANE, PET];

describe("resolveActiveCreateProfileId", () => {
  it("targets the single selected profile (the unambiguous case)", () => {
    expect(
      resolveActiveCreateProfileId(ALL, { mode: "selected", selectedIds: ["jane-1"] }),
    ).toBe("jane-1");
  });

  it("does NOT fall back to self when a non-self profile is the active scope", () => {
    // The core bug: creating while Jane is selected used to link to self.
    const target = resolveActiveCreateProfileId(ALL, { mode: "selected", selectedIds: ["jane-1"] });
    expect(target).not.toBe("self-1");
  });

  it("prefers self when several profiles are selected and self is among them", () => {
    expect(
      resolveActiveCreateProfileId(ALL, { mode: "selected", selectedIds: ["jane-1", "self-1"] }),
    ).toBe("self-1");
  });

  it("uses the first selected when several are selected and none is self", () => {
    expect(
      resolveActiveCreateProfileId(ALL, { mode: "selected", selectedIds: ["jane-1", "pet-1"] }),
    ).toBe("jane-1");
  });

  it("defaults to self in unfiltered (everyone) mode", () => {
    expect(resolveActiveCreateProfileId(ALL, { mode: "everyone", selectedIds: [] })).toBe("self-1");
  });

  it("returns empty string when profiles have not loaded yet", () => {
    expect(resolveActiveCreateProfileId([], { mode: "everyone", selectedIds: [] })).toBe("");
    expect(resolveActiveCreateProfileId(null, { mode: "everyone", selectedIds: [] })).toBe("");
  });

  it("ignores empty/falsy ids in the selection", () => {
    expect(
      resolveActiveCreateProfileId(ALL, { mode: "selected", selectedIds: ["", "jane-1"] }),
    ).toBe("jane-1");
  });
});

describe("profileScopeParam", () => {
  it("is empty when unfiltered", () => {
    expect(profileScopeParam({ mode: "everyone", selectedIds: [] })).toBe("");
    expect(profileScopeParam({ mode: "selected", selectedIds: [] })).toBe("");
  });

  it("builds ?profileIds= for an active selection", () => {
    expect(profileScopeParam({ mode: "selected", selectedIds: ["a", "b"] })).toBe("?profileIds=a,b");
  });
});

describe("scopedKey (canonical profile-scope key builder)", () => {
  it("uses the live everyone/selected convention, not the old all/selected one", () => {
    // Unfiltered scope is "everyone" (matches the dashboard bootstrap seed and
    // every tab reader), NOT the retired "all" segment.
    expect(scopedKey("/api/tasks", "everyone", [])).toEqual(["/api/tasks", "everyone"]);
    expect(scopedKey("/api/tasks", "selected", ["b", "a"])).toEqual([
      "/api/tasks",
      "selected",
      "b",
      "a",
    ]);
  });

  it("appends trailing sub-slice discriminators verbatim after the scope", () => {
    expect(scopedKey("/api/incomes", "everyone", [], "hero")).toEqual([
      "/api/incomes",
      "everyone",
      "hero",
    ]);
    expect(scopedKey("/api/budgets/summary", "selected", ["p1"], "2026-07", "hero")).toEqual([
      "/api/budgets/summary",
      "selected",
      "p1",
      "2026-07",
      "hero",
    ]);
  });

  it("drops falsy ids so a stale empty id can't fork the cache slot", () => {
    expect(scopedKey("/api/expenses", "selected", ["", "p1"])).toEqual([
      "/api/expenses",
      "selected",
      "p1",
    ]);
  });
});

describe("goalsQueryKey", () => {
  it("collapses to the same everyone/selected slot the dashboard seeds", () => {
    // Empty selection -> everyone (previously this returned the divergent
    // ["/api/goals","all"], which never matched the live seed).
    expect(goalsQueryKey([])).toEqual(["/api/goals", "everyone"]);
    expect(goalsQueryKey([])).toEqual(scopedKey("/api/goals", "everyone", []));
    // A selection matches scopedKey("/api/goals","selected",ids) exactly so the
    // goals/trackers pages and the dashboard read one cache slot (no double-seed).
    expect(goalsQueryKey(["p1", "p2"])).toEqual(scopedKey("/api/goals", "selected", ["p1", "p2"]));
  });
});
