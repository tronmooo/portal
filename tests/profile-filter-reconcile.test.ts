// @vitest-environment jsdom
//
// reconcileProfileFilter — self-healing for a persisted dashboard scope whose
// profile ids no longer exist (hard-deleted/recreated profiles). The reported
// failure mode: the header still says "Mike" (persisted name) but every
// widget queries `?profileIds=<dead-id>` and renders 0 even though Mike's
// data exists under a new id.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getProfileFilter,
  setFilterEveryone,
  setFilterSelected,
  reconcileProfileFilter,
} from "../client/src/lib/profileFilter";

const LIVE = [
  { id: "self-1", type: "self", name: "Me" },
  { id: "mike-2", type: "person", name: "Mike" },
  { id: "rex-1", type: "pet", name: "Rex" },
  { id: "car-1", type: "vehicle", name: "Mike" }, // name collision, non-person
];

beforeEach(() => {
  setFilterEveryone();
});

describe("reconcileProfileFilter", () => {
  it("no-ops when every selected id still resolves", () => {
    setFilterSelected(["mike-2"], ["Mike"]);
    reconcileProfileFilter(LIVE);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["mike-2"] });
  });

  it("re-maps a dead id to the live profile with the same name, preferring people over other types", () => {
    setFilterSelected(["mike-OLD-DELETED"], ["Mike"]);
    reconcileProfileFilter(LIVE);
    const f = getProfileFilter();
    expect(f.mode).toBe("selected");
    expect(f.selectedIds).toEqual(["mike-2"]); // not car-1
    expect(f.selectedNames).toEqual(["Mike"]);
  });

  it("keeps live ids and drops unresolvable ones in a multi-select", () => {
    setFilterSelected(["rex-1", "ghost-1"], ["Rex", "Nobody"]);
    reconcileProfileFilter(LIVE);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["rex-1"] });
  });

  it("falls back to the Self profile when nothing can be re-mapped", () => {
    setFilterSelected(["ghost-1"], ["Nobody"]);
    reconcileProfileFilter(LIVE);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["self-1"] });
  });

  it("falls back to Everyone when nothing re-maps and there is no Self profile", () => {
    setFilterSelected(["ghost-1"], ["Nobody"]);
    reconcileProfileFilter(LIVE.filter(p => p.type !== "self"));
    expect(getProfileFilter().mode).toBe("everyone");
  });

  it("ignores transient empty/absent profile lists (never drops a selection on a failed load)", () => {
    setFilterSelected(["mike-OLD-DELETED"], ["Mike"]);
    reconcileProfileFilter([]);
    reconcileProfileFilter(null);
    reconcileProfileFilter(undefined);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["mike-OLD-DELETED"] });
  });

  it("does not touch the Everyone scope", () => {
    setFilterEveryone();
    reconcileProfileFilter(LIVE);
    expect(getProfileFilter().mode).toBe("everyone");
  });
});
