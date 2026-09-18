// @vitest-environment jsdom
//
// QA 2026-09-18 BUG-01 — "Active profile silently changes and new data lands
// on the wrong person". The scope store (lib/profileFilter.ts) had four ways
// to change the selection without a user gesture:
//   1. its arrays were mutated in place and shared by reference with React
//      state, so subscribers compared an array with itself and skipped updates;
//   2. a same-user auth blip wiped the persisted key and the next dashboard
//      mount re-seeded the default from an UNORDERED list — a different
//      self-typed profile each time when the account had several;
//   3. reconcileProfileFilter re-mapped ids by name from a partial list;
//   4. dashboard.tsx mirrored its own (possibly stale) copy back into the
//      store on every /api/profiles refetch (removed; covered by grep below).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getProfileFilter,
  getProfileFilterSnapshot,
  setFilterEveryone,
  setFilterSelected,
  toggleFilterProfile,
  initDefaultProfileFilter,
  reconcileProfileFilter,
  refreshFilterNames,
  setActiveUserForFilter,
  clearProfileFilterForUser,
  pickPrimarySelf,
  subscribeProfileFilter,
} from "../client/src/lib/profileFilter";

const PROFILES = [
  { id: "bob-1", type: "self", name: "Bob Robertson", createdAt: "2026-09-10T00:00:00Z" },
  { id: "poop-1", type: "self", name: "Poop", createdAt: "2026-01-01T00:00:00Z" },
  { id: "dana-1", type: "person", name: "Dana" },
];

beforeEach(() => {
  clearProfileFilterForUser();
  localStorage.clear();
  setActiveUserForFilter("uid-1");
});

describe("store immutability (aliasing)", () => {
  it("toggleFilterProfile never mutates arrays a caller already holds", () => {
    setFilterSelected(["poop-1"], ["Poop"]);
    const held = getProfileFilter().selectedIds;
    const snap = getProfileFilterSnapshot();
    toggleFilterProfile("dana-1", "Dana");
    expect(held).toEqual(["poop-1"]);
    expect(snap.selectedIds).toEqual(["poop-1"]);
    expect(getProfileFilter().selectedIds).toEqual(["poop-1", "dana-1"]);
    expect(getProfileFilterSnapshot()).not.toBe(snap);
  });

  it("subscribers receive a copy, not the live state", () => {
    let seen: string[] | null = null;
    const unsub = subscribeProfileFilter((s) => { seen = s.selectedIds; });
    setFilterSelected(["poop-1"], ["Poop"]);
    toggleFilterProfile("dana-1", "Dana");
    expect(seen).toEqual(["poop-1", "dana-1"]);
    toggleFilterProfile("dana-1", "Dana");
    // the array delivered on the previous event is untouched by the next mutation
    expect(getProfileFilter().selectedIds).toEqual(["poop-1"]);
    unsub();
  });

  it("setFilterSelected with the same scope is a no-op (no broadcast)", () => {
    setFilterSelected(["poop-1"], ["Poop"]);
    let fired = 0;
    const unsub = subscribeProfileFilter(() => { fired++; });
    setFilterSelected(["poop-1"], ["Poop"]);
    expect(fired).toBe(0);
    unsub();
  });
});

describe("default seeding is deterministic and never overrides a choice", () => {
  it("pickPrimarySelf returns the same profile whatever the list order", () => {
    const a = pickPrimarySelf(PROFILES)!.id;
    const b = pickPrimarySelf([...PROFILES].reverse())!.id;
    expect(a).toBe("poop-1"); // oldest self wins
    expect(b).toBe("poop-1");
  });

  it("initDefaultProfileFilter does not re-seed after the user chose Everyone, even if storage vanished", () => {
    setFilterEveryone();
    localStorage.clear(); // the auth-blip / quota case
    setActiveUserForFilter("uid-1"); // same user re-auth
    initDefaultProfileFilter(PROFILES);
    expect(getProfileFilter().mode).toBe("everyone");
    // and the choice was re-persisted, not lost
    expect(localStorage.getItem("portol_profile_filter_v5:uid-1")).toContain('"everyone"');
  });

  it("a same-user re-auth keeps the live selection; a different user reloads", () => {
    setFilterSelected(["poop-1"], ["Poop"]);
    setActiveUserForFilter("uid-1");
    expect(getProfileFilter().selectedIds).toEqual(["poop-1"]);
    setActiveUserForFilter("uid-2");
    expect(getProfileFilter().mode).toBe("everyone");
  });
});

describe("reconcile / name refresh cannot re-point the scope from a partial list", () => {
  it("does not re-map a live selection when the list lacks the self profile", () => {
    setFilterSelected(["poop-1"], ["Poop"]);
    reconcileProfileFilter([{ id: "dana-1", type: "person", name: "Dana" }, { id: "x", type: "person", name: "Poop" }]);
    expect(getProfileFilter().selectedIds).toEqual(["poop-1"]);
  });

  it("refreshFilterNames changes labels only", () => {
    setFilterSelected(["dana-1"], ["Dan"]);
    refreshFilterNames(PROFILES);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["dana-1"], selectedNames: ["Dana"] });
  });

  it("a malformed persisted value is not loaded as live state", () => {
    localStorage.setItem("portol_profile_filter_v5:uid-1", JSON.stringify({ mode: "selected", selectedIds: [null, 7], selectedNames: "x" }));
    setActiveUserForFilter("uid-3");
    setActiveUserForFilter("uid-1");
    expect(getProfileFilter().mode).toBe("everyone");
  });
});

describe("no page mirrors its React copy of the scope back into the store", () => {
  it("dashboard.tsx has no resolvedFilterId → setFilterSelected effect", () => {
    const src = readFileSync(path.resolve(__dirname, "../client/src/pages/dashboard.tsx"), "utf8");
    expect(src).not.toMatch(/setFilterSelected\(\[resolvedFilterId\]/);
  });
  it("auth.tsx does not wipe the saved scope on a transient null user", () => {
    const src = readFileSync(path.resolve(__dirname, "../client/src/lib/auth.tsx"), "utf8");
    expect(src).not.toMatch(/clearProfileFilterForUser\(\)/);
  });
});
