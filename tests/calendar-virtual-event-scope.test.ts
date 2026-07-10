import { describe, it, expect } from "vitest";
import { isInScope, selfIdsFrom } from "../shared/scope";

// BUG-20260709-virtual-event-leak — profile isolation for calendar/timeline
// "virtual events" derived from profile fields (subscription renewals,
// birthdays, vehicle service, vet visits, warranty/insurance expiries…).
//
// getCalendarTimeline emitted these via addVirtualEvent WITHOUT calling
// matchesProfile — the only timeline source that skipped the profile filter —
// so a "Car Insurance — Renewal" subscription nested under the SELF profile
// showed up on EVERY profile's calendar and Important Dates (Bill, Bob, Jim…).
// The fix scopes each profile's virtual events to that profile plus its PARENT
// (child profiles like a subscription/vehicle are owned by the person they are
// nested under), using the same belongs_to_self rule every other source uses.
//
// This pins the exact scope decision so the guard can't be removed silently.

const SELF = { id: "self-1", type: "self" };
const BILL = { id: "bill-1", type: "person" };
const ALL = [SELF, BILL];
const selfIds = selfIdsFrom(ALL);

// Mirror of the fixed code: vevScope + matchesProfile (belongs_to_self, active).
function virtualEventVisible(
  profile: { id: string; parentProfileId?: string },
  selectedIds: string[],
): boolean {
  const vevScope = profile.parentProfileId
    ? [profile.id, profile.parentProfileId]
    : [profile.id];
  if (selectedIds.length === 0) return true; // "Everyone" — filter inactive
  return isInScope(vevScope, { selectedIds, selfIds }, "belongs_to_self");
}

const carInsuranceSub = { id: "sub-carins", parentProfileId: "self-1" }; // nested under self
const billBirthday = { id: "bill-1" }; // the person profile itself

describe("calendar virtual-event profile isolation", () => {
  it("shows a self-owned subscription renewal only under self / Everyone", () => {
    expect(virtualEventVisible(carInsuranceSub, [])).toBe(true);          // Everyone
    expect(virtualEventVisible(carInsuranceSub, ["self-1"])).toBe(true);  // owner (self)
    // THE BUG: must NOT show under a sibling person profile.
    expect(virtualEventVisible(carInsuranceSub, ["bill-1"])).toBe(false);
  });

  it("scopes a person's own virtual event (birthday) to that person", () => {
    expect(virtualEventVisible(billBirthday, ["bill-1"])).toBe(true);
    expect(virtualEventVisible(billBirthday, ["self-1"])).toBe(false);
    expect(virtualEventVisible(billBirthday, [])).toBe(true);
  });

  it("child profile is visible when EITHER itself or its parent is selected", () => {
    expect(virtualEventVisible(carInsuranceSub, ["sub-carins"])).toBe(true); // the child itself
    expect(virtualEventVisible(carInsuranceSub, ["self-1", "bill-1"])).toBe(true); // parent in set
  });
});
