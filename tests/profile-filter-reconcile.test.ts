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

// QA 2026-09-18 (F-01): an id absent from a list is only "dead" once a direct
// GET /api/profiles/:id has 404'd. These cases inject that verdict; the
// "absent but alive / unknown" cases live in tests/qa-2026-09-18-profiles.test.ts.
const DEAD = { verify: async () => "dead" as const };

describe("reconcileProfileFilter", () => {
  it("no-ops when every selected id still resolves", async () => {
    setFilterSelected(["mike-2"], ["Mike"]);
    await reconcileProfileFilter(LIVE, DEAD);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["mike-2"] });
  });

  it("re-maps a dead id to the live profile with the same name, preferring people over other types", async () => {
    setFilterSelected(["mike-OLD-DELETED"], ["Mike"]);
    await reconcileProfileFilter(LIVE, DEAD);
    const f = getProfileFilter();
    expect(f.mode).toBe("selected");
    expect(f.selectedIds).toEqual(["mike-2"]); // not car-1
    expect(f.selectedNames).toEqual(["Mike"]);
  });

  it("keeps live ids and drops unresolvable ones in a multi-select", async () => {
    setFilterSelected(["rex-1", "ghost-1"], ["Rex", "Nobody"]);
    await reconcileProfileFilter(LIVE, DEAD);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["rex-1"] });
  });

  it("falls back to the Self profile when nothing can be re-mapped", async () => {
    setFilterSelected(["ghost-1"], ["Nobody"]);
    await reconcileProfileFilter(LIVE, DEAD);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["self-1"] });
  });

  it("leaves the selection alone when nothing re-maps and there is no Self profile", async () => {
    // 2026-07-29: a background tab flipped itself to Everyone, breaking
    // profile isolation. A list with no Self is more likely a partial/scoped
    // fetch than a mass deletion, so reconcile must NOT silently widen the
    // scope — it keeps the stored selection and waits for a complete list.
    setFilterSelected(["ghost-1"], ["Nobody"]);
    await reconcileProfileFilter(LIVE.filter(p => p.type !== "self"), DEAD);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["ghost-1"] });
  });

  it("ignores transient empty/absent profile lists (never drops a selection on a failed load)", async () => {
    setFilterSelected(["mike-OLD-DELETED"], ["Mike"]);
    await reconcileProfileFilter([], DEAD);
    await reconcileProfileFilter(null, DEAD);
    await reconcileProfileFilter(undefined, DEAD);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["mike-OLD-DELETED"] });
  });

  it("does not touch the Everyone scope", async () => {
    setFilterEveryone();
    await reconcileProfileFilter(LIVE, DEAD);
    expect(getProfileFilter().mode).toBe("everyone");
  });
});
