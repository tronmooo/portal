import { describe, it, expect } from "vitest";
import {
  resolveActiveCreateProfileId,
  profileScopeParam,
  profileScopeKey,
} from "../client/src/hooks/useProfileScope";

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

describe("profileScopeKey", () => {
  it("uses the shared canonical key shape so caches collapse to one slot", () => {
    expect(profileScopeKey("/api/tasks", { selectedIds: [] })).toEqual(["/api/tasks", "all"]);
    // sorted ascending so [b,a] and [a,b] are the same cache slot
    expect(profileScopeKey("/api/tasks", { selectedIds: ["b", "a"] })).toEqual([
      "/api/tasks",
      "selected",
      "a",
      "b",
    ]);
  });
});
