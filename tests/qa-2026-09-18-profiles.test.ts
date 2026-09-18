// @vitest-environment jsdom
//
// QA pass 2026-09-18 — profiles & navigation.
//
//   F-01 (critical) The active profile silently switched to another person:
//        "My dashboard" (Poop) became Bob Robertson after "View all tasks",
//        "tires for my Dodge ram" after the Documents tab, once after a plain
//        refresh. Root cause: reconcileProfileFilter treated "absent from
//        whatever list I was handed" as "deleted" and fell back to the first
//        `self` row — and the account has more than one. A selected id that is
//        missing from a list is now verified with GET /api/profiles/:id and
//        only a confirmed 404 may change the selection.
//   F-02 A document or date linked to another PERSON leaked into Poop's scope
//        because ownership walked the parent chain through people: Sarah is
//        nested under Poop, so Sarah's citation and birthday read as Poop's.
//        A person is nobody's possession — the walk stops at person-like nodes.
//   F-03 The calendar's person filter wrote the GLOBAL scope; it now keeps a
//        local selection (pure toggle helper pinned here).
//   F-04 Assets typed as people: "tires for my Dodge ram" / "my MacBook Pro
//        m4" were filed as `person`, so they appeared in the profile switcher
//        and the owner pickers. The AI create path now classifies obviously
//        asset-shaped names, and every people picker filters defensively.
//   F-05 "View all tasks" opened a popup with a clipped tab strip; it now
//        navigates to the Tasks page, and the popup's tabs wrap.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  getProfileFilter,
  setFilterEveryone,
  setFilterSelected,
  reconcileProfileFilter,
  refreshFilterNames,
  initDefaultProfileFilter,
  pickSelfProfile,
  clearProfileFilterForUser,
} from "../client/src/lib/profileFilter";
import { passesProfileFilter, pushdownSelection } from "../shared/profile-filter";
import { withAncestorOwnerIds, ownerChainForProfile, profileAndOwnerIds } from "../shared/scope";
import { rulesFromAll } from "../shared/date-rules";
import { seriesFromAll, filterSeriesByProfiles } from "../shared/calendar-adapters";
import { selfIdsFrom } from "../shared/scope";
import { toggleScopeSelection } from "../shared/profile-selection";
import { looksLikeAssetName, coerceProfileType, isOfferablePerson } from "../shared/entity-classify";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// F-01 — the scope store never switches people on its own
// ─────────────────────────────────────────────────────────────────────────────
const POOP = { id: "poop-1", type: "self", name: "Poop", createdAt: "2025-01-01T00:00:00Z" };
const SMOKE_SELF = { id: "smoke-self", type: "self", name: "Smoke Self", createdAt: "2026-06-01T00:00:00Z" };
const BOB = { id: "bob-1", type: "person", name: "Bob Robertson" };
const TIRES = { id: "tires-1", type: "person", name: "tires for my Dodge ram" };
const FULL = [POOP, SMOKE_SELF, BOB, TIRES];
// The lists reconcile actually receives: a scoped bootstrap seed, a stale
// snapshot, a list another tab wrote — all missing Poop.
const PARTIAL_WITHOUT_POOP = [SMOKE_SELF, BOB, TIRES];

const alive = { verify: async () => "alive" as const };
const unknown = { verify: async () => "unknown" as const };
const dead = { verify: async () => "dead" as const };
const throwing = { verify: async () => { throw new Error("network"); } };

describe("F-01: a selected id missing from a partial list does not switch the profile", () => {
  beforeEach(() => { setFilterEveryone(); });

  it("keeps Poop when the list lacks him and the server says he is alive", async () => {
    setFilterSelected([POOP.id], [POOP.name]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, alive);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: [POOP.id], selectedNames: [POOP.name] });
  });

  it("keeps Poop when the verification is inconclusive (network error, 5xx, timeout)", async () => {
    setFilterSelected([POOP.id], [POOP.name]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, unknown);
    expect(getProfileFilter().selectedIds).toEqual([POOP.id]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, throwing);
    expect(getProfileFilter().selectedIds).toEqual([POOP.id]);
  });

  it("never implicitly lands on a second `self` (Smoke Self) or on an asset typed person", async () => {
    setFilterSelected([POOP.id], [POOP.name]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, alive);
    const f = getProfileFilter();
    expect(f.selectedIds).not.toContain(SMOKE_SELF.id);
    expect(f.selectedIds).not.toContain(BOB.id);
    expect(f.selectedIds).not.toContain(TIRES.id);
  });

  it("keeps an id whose stored name is empty instead of dropping it", async () => {
    setFilterSelected([POOP.id], [""]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, alive);
    expect(getProfileFilter().selectedIds).toEqual([POOP.id]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, unknown);
    expect(getProfileFilter().selectedIds).toEqual([POOP.id]);
  });

  it("verifies only the missing ids, never the ones that resolve", async () => {
    const asked: string[] = [];
    setFilterSelected([BOB.id, POOP.id], [BOB.name, POOP.name]);
    await reconcileProfileFilter(PARTIAL_WITHOUT_POOP, { verify: async (id) => { asked.push(id); return "alive"; } });
    expect(asked).toEqual([POOP.id]);
    expect(getProfileFilter().selectedIds).toEqual([BOB.id, POOP.id]);
  });

  it("a confirmed-dead id with no live namesake falls back to the Self whose name matches, not the first self row", async () => {
    // Poop was hard-deleted and recreated under a new id: the by-name re-map
    // wins. The list deliberately puts Smoke Self FIRST.
    const recreated = { id: "poop-2", type: "self", name: "Poop", createdAt: "2026-09-18T00:00:00Z" };
    setFilterSelected(["poop-OLD"], ["Poop"]);
    await reconcileProfileFilter([SMOKE_SELF, BOB, recreated], dead);
    expect(getProfileFilter()).toMatchObject({ selectedIds: ["poop-2"], selectedNames: ["Poop"] });
  });

  it("with several selfs and no name match, the fallback is the account's original (oldest) self", async () => {
    setFilterSelected(["ghost-1"], ["Nobody"]);
    await reconcileProfileFilter([SMOKE_SELF, BOB, POOP], dead);
    expect(getProfileFilter().selectedIds).toEqual([POOP.id]);
  });

  it("with several undated selfs and no name match, the selection is left alone", async () => {
    setFilterSelected(["ghost-1"], ["Nobody"]);
    await reconcileProfileFilter([
      { id: "s1", type: "self", name: "A" }, { id: "s2", type: "self", name: "B" }, BOB,
    ], dead);
    expect(getProfileFilter().selectedIds).toEqual(["ghost-1"]);
  });

  it("a user action during verification wins over the stale verdict", async () => {
    setFilterSelected(["ghost-1"], ["Nobody"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const pending = reconcileProfileFilter([POOP, BOB], { verify: async () => { await gate; return "dead"; } });
    setFilterSelected([BOB.id], [BOB.name]); // the user picks Bob meanwhile
    release();
    await pending;
    expect(getProfileFilter().selectedIds).toEqual([BOB.id]);
  });

  it("pickSelfProfile: one self → it; several → name match, else oldest, else null", () => {
    expect(pickSelfProfile([BOB, POOP])?.id).toBe(POOP.id);
    expect(pickSelfProfile([SMOKE_SELF, POOP], ["smoke self"])?.id).toBe(SMOKE_SELF.id);
    expect(pickSelfProfile([SMOKE_SELF, POOP])?.id).toBe(POOP.id);
    expect(pickSelfProfile([{ id: "a", type: "self" }, { id: "b", type: "self" }])).toBeNull();
    expect(pickSelfProfile([BOB])).toBeNull();
  });

  it("initDefaultProfileFilter seeds the original self, not the first self row", () => {
    // A fresh account with NO choice yet. (setFilterEveryone() would be a
    // user's choice, which the seed must never override — QA 2026-09-18
    // BUG-01, tests/qa-2026-09-18-profile-scope.test.ts.)
    clearProfileFilterForUser();
    try { localStorage.clear(); } catch {}
    initDefaultProfileFilter([SMOKE_SELF, BOB, POOP]);
    expect(getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: [POOP.id] });
  });
});

describe("F-01: refreshing display names never rewrites ids or stores an empty name", () => {
  beforeEach(() => { setFilterEveryone(); });

  it("updates a renamed profile's chip text and nothing else", () => {
    setFilterSelected([POOP.id], ["Poop"]);
    refreshFilterNames([{ ...POOP, name: "Poop II" }, BOB]);
    expect(getProfileFilter()).toMatchObject({ selectedIds: [POOP.id], selectedNames: ["Poop II"] });
  });

  it("leaves the stored name alone when the list lacks the profile (no empty-name write)", () => {
    setFilterSelected([POOP.id], ["Poop"]);
    refreshFilterNames(PARTIAL_WITHOUT_POOP);
    expect(getProfileFilter().selectedNames).toEqual(["Poop"]);
    expect(getProfileFilter().selectedIds).toEqual([POOP.id]);
  });

  it("the dashboard no longer echoes the selection back through setFilterSelected", () => {
    const src = read("client/src/pages/dashboard.tsx");
    expect(src).not.toMatch(/setFilterSelected\(\[resolvedFilterId\]/);
    expect(src).toMatch(/refreshFilterNames\(allProfiles\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-02 — a person is nobody's possession: ownership stops at people
// ─────────────────────────────────────────────────────────────────────────────
describe("F-02: things linked to another person do not enter Poop's scope through the parent chain", () => {
  const SARAH = { id: "sarah-1", type: "person", name: "Sarah Miller", parentProfileId: POOP.id };
  const SARAH_CAR = { id: "scar-1", type: "vehicle", name: "Civic", parentProfileId: SARAH.id };
  const POOP_CAR = { id: "pcar-1", type: "vehicle", name: "Ram", parentProfileId: POOP.id };
  const REX = { id: "rex-1", type: "pet", name: "Rex", parentProfileId: SARAH.id };
  const ALL = [POOP, SARAH, SARAH_CAR, POOP_CAR, REX];
  const scope = (ids: string[]) => ({ selectedIds: ids, allProfiles: ALL });

  it("Sarah's citation (linked to Sarah) is not Poop's document", () => {
    expect(passesProfileFilter([SARAH.id], scope([POOP.id]))).toBe(false);
    expect(passesProfileFilter([SARAH.id], scope([SARAH.id]))).toBe(true);
  });

  it("Sarah's car's registration is Sarah's, not Poop's; Poop's own car is still Poop's", () => {
    expect(passesProfileFilter([SARAH_CAR.id], scope([POOP.id]))).toBe(false);
    expect(passesProfileFilter([SARAH_CAR.id], scope([SARAH.id]))).toBe(true);
    expect(passesProfileFilter([POOP_CAR.id], scope([POOP.id]))).toBe(true);
    // a pet nested under a person is not the person's parent's either
    expect(passesProfileFilter([REX.id], scope([POOP.id]))).toBe(false);
  });

  it("the ancestor walk adds owners up to and including the first person-like node", () => {
    expect(withAncestorOwnerIds([SARAH_CAR.id], ALL)).toEqual([SARAH_CAR.id, SARAH.id]);
    expect(withAncestorOwnerIds([SARAH.id], ALL)).toEqual([SARAH.id]);
    expect(withAncestorOwnerIds([POOP_CAR.id], ALL)).toEqual([POOP_CAR.id, POOP.id]);
    // no type column at all (a lite projection) keeps the old unconditional walk
    expect(withAncestorOwnerIds(["c"], [{ id: "c", parentProfileId: "b" }, { id: "b", parentProfileId: "a" }])).toEqual(["c", "b", "a"]);
  });

  it("the server pushdown closure of Poop does not descend into Sarah or her things", () => {
    expect(pushdownSelection(scope([POOP.id]))).toEqual([POOP.id, POOP_CAR.id]);
    expect(pushdownSelection(scope([SARAH.id]))).toEqual(expect.arrayContaining([SARAH.id, SARAH_CAR.id, REX.id]));
  });

  it("a person's own owner chain is empty even when nested; an asset's stops at its person", () => {
    expect(ownerChainForProfile(SARAH, ALL)).toEqual([]);
    expect(ownerChainForProfile(SARAH_CAR, ALL)).toEqual([SARAH.id]);
  });

  it("the profile-and-parent candidate list the server scopes profiles by excludes a person's parent", () => {
    expect(profileAndOwnerIds(SARAH)).toEqual([SARAH.id]);
    expect(profileAndOwnerIds(SARAH_CAR)).toEqual([SARAH_CAR.id, SARAH.id]);
    expect(profileAndOwnerIds({ id: "x", parentProfileId: "y" })).toEqual(["x", "y"]);
  });

  it("Sarah's birthday rule is owned by Sarah only, so the Recurring page under Poop drops it", () => {
    const profiles = [
      { ...POOP, fields: { birthday: "1980-02-02" } },
      { ...SARAH, fields: { birthday: "1990-05-05" } },
    ];
    const rules = rulesFromAll({ profiles, documents: [] });
    const sarahBirthday = rules.find((r) => r.ruleType === "birthday" && r.profileId === SARAH.id);
    expect(sarahBirthday).toBeTruthy();
    expect(sarahBirthday!.ownerIds).not.toContain(POOP.id);

    const series = seriesFromAll({ profiles, documents: [] } as any);
    const personIds = new Set(profiles.map((p) => p.id));
    const underPoop = filterSeriesByProfiles(series, [POOP.id], { selfIds: selfIdsFrom(profiles), personIds });
    expect(underPoop.map((s) => s.source.profileId)).not.toContain(SARAH.id);
    expect(underPoop.some((s) => s.kind === "birthday" && s.source.profileId === POOP.id)).toBe(true);
  });

  it("an UNPARENTED person's birthday is not an orphan handed to Self either", () => {
    const bob = { id: BOB.id, type: "person", name: BOB.name, fields: { birthday: "1975-03-03" } };
    const profiles = [{ ...POOP, fields: {} }, bob];
    const series = seriesFromAll({ profiles, documents: [] } as any);
    const personIds = new Set(profiles.map((p) => p.id));
    const underPoop = filterSeriesByProfiles(series, [POOP.id], { selfIds: selfIdsFrom(profiles), personIds });
    expect(underPoop.some((s) => s.kind === "birthday" && s.source.profileId === BOB.id)).toBe(false);
    const underBob = filterSeriesByProfiles(series, [BOB.id], { selfIds: selfIdsFrom(profiles), personIds });
    expect(underBob.some((s) => s.kind === "birthday" && s.source.profileId === BOB.id)).toBe(true);
    // the hook wires personIds in
    expect(read("client/src/hooks/useCalendarOccurrences.ts")).toMatch(/personIds \}\)/);
  });

  it("a document linked to Sarah is dropped from the Recurring page under Poop", () => {
    const profiles = [POOP, SARAH];
    const documents = [{ id: "cite-1", name: "Parking Violation Citation", type: "other", linkedProfiles: [SARAH.id],
      extractedData: { dueDate: "2026-10-19" } }];
    const series = seriesFromAll({ profiles, documents } as any);
    const underPoop = filterSeriesByProfiles(series, [POOP.id], { selfIds: selfIdsFrom(profiles) });
    expect(underPoop.map((s) => s.source.id)).not.toContain("cite-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-03 — the calendar's person filter is local
// ─────────────────────────────────────────────────────────────────────────────
describe("F-03: toggling a person in a local selection never touches the global store", () => {
  beforeEach(() => { setFilterEveryone(); setFilterSelected([POOP.id], [POOP.name]); });

  it("toggleScopeSelection is pure: adds, removes, never empties, everyone → single", () => {
    const base = { mode: "selected" as const, selectedIds: [POOP.id], selectedNames: [POOP.name] };
    const withDana = toggleScopeSelection(base, "dana-1", "Dana");
    expect(withDana).toEqual({ mode: "selected", selectedIds: [POOP.id, "dana-1"], selectedNames: [POOP.name, "Dana"] });
    expect(toggleScopeSelection(withDana, "dana-1", "Dana")).toEqual(base);
    expect(toggleScopeSelection(base, POOP.id, POOP.name)).toEqual(base); // last one stays
    expect(toggleScopeSelection({ mode: "everyone", selectedIds: [], selectedNames: [] }, "dana-1", "Dana"))
      .toEqual({ mode: "selected", selectedIds: ["dana-1"], selectedNames: ["Dana"] });
    // the global store did not move
    expect(getProfileFilter()).toMatchObject({ selectedIds: [POOP.id] });
  });

  it("the calendar page binds MultiProfileFilter to a local value, not the store", () => {
    const src = read("client/src/pages/calendar-page.tsx");
    expect(src).toMatch(/<MultiProfileFilter[\s\S]*?value=\{/);
    expect(src).toMatch(/setLocalScope/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-04 — assets are not people
// ─────────────────────────────────────────────────────────────────────────────
describe("F-04: obviously asset-shaped names never become people", () => {
  it("looksLikeAssetName recognises possessive and product names, not people", () => {
    for (const n of ["tires for my Dodge ram", "my MacBook Pro m4", "My iPhone 15", "the Honda Civic", "Ford F-150 2022", "new tires"]) {
      expect(looksLikeAssetName(n), n).toBe(true);
    }
    for (const n of ["Bob Robertson", "Sarah Miller", "Dana", "John Hancock", "Rex", "Poop", "Mike O'Brien", "Dr. Ram Patel"]) {
      expect(looksLikeAssetName(n), n).toBe(false);
    }
  });

  it("coerceProfileType files an asset-shaped 'person' as a thing, and leaves real people and explicit things alone", () => {
    expect(coerceProfileType("tires for my Dodge ram", "person")).toBe("vehicle");
    expect(coerceProfileType("my MacBook Pro m4", "person")).toBe("asset");
    expect(coerceProfileType("my MacBook Pro m4", "self")).toBe("asset");
    expect(coerceProfileType("Bob Robertson", "person")).toBe("person");
    expect(coerceProfileType("Rex", "pet")).toBe("pet");
    expect(coerceProfileType("Honda Civic", "vehicle")).toBe("vehicle");
    // an explicit non-person type is kept; an absent one is a thing, never a person
    expect(coerceProfileType("Whatever", "gadget")).toBe("gadget");
    expect(coerceProfileType("Whatever", undefined)).toBe("asset");
  });

  it("isOfferablePerson keeps real people/pets and rejects mistyped assets and non-people", () => {
    expect(isOfferablePerson(BOB)).toBe(true);
    expect(isOfferablePerson(POOP)).toBe(true);
    expect(isOfferablePerson({ id: "r", type: "pet", name: "Rex" })).toBe(true);
    expect(isOfferablePerson(TIRES)).toBe(false);
    expect(isOfferablePerson({ id: "m", type: "person", name: "my MacBook Pro m4" })).toBe(false);
    expect(isOfferablePerson({ id: "c", type: "vehicle", name: "Bob" })).toBe(false);
  });

  it("the AI create path never defaults a non-standard type to person, and every people picker filters", () => {
    const ai = read("server/ai-engine.ts");
    expect(ai).not.toMatch(/defaulting to "person"/);
    expect(ai).toMatch(/coerceProfileType\(/);
    for (const f of [
      "client/src/components/hub/HubProfileSwitcher.tsx",
      "client/src/components/MultiProfileFilter.tsx",
      "client/src/components/OwnershipEditor.tsx",
      "client/src/components/CalendarView.tsx",
    ]) expect(read(f), f).toMatch(/isOfferablePerson/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-05 — "View all tasks" goes to the Tasks page; the popup's tabs all fit
// ─────────────────────────────────────────────────────────────────────────────
describe("F-05: View all tasks navigates; the tab strip wraps instead of clipping", () => {
  it("the Executive card's View all tasks link navigates to /dashboard/tasks", () => {
    const src = read("client/src/components/dashboard/ExecutiveBriefing.tsx");
    expect(src).toMatch(/label="View all tasks"[^\n]*go\("\/dashboard\/tasks"\)/);
  });

  it("the Tasks popup tab strip wraps (no hidden horizontal scroll that clips 'Upcoming')", () => {
    const src = read("client/src/components/dashboard/TaskHabitPopups.tsx");
    const strip = src.slice(src.indexOf("Tabs — Today / One-time / Recurring / Upcoming"), src.indexOf('data-testid="task-sort"'));
    expect(strip).toMatch(/flex-wrap/);
    expect(strip).not.toMatch(/overflow-x-auto/);
    expect(strip).not.toMatch(/scrollbar-hide/);
  });
});
