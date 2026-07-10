import { describe, it, expect } from "vitest";
import { passesProfileFilter } from "../shared/profile-filter";

// BUG-20260709-reminder-leak — profile isolation for the reminders feed.
//
// `/api/reminders` was the ONE list endpoint that returned every reminder for
// the user with no profile filter, so medication / refill / appointment
// reminders (many created with no profileId) leaked into EVERY profile's
// dashboard REMINDERS card. The fix filters the endpoint with the same
// canonical rule (`passesProfileFilter` / "belongs_to_self") every sibling
// endpoint uses: an unassigned reminder defaults to the primary (self) person
// — it shows on the primary person's dashboard, never on a different
// person/pet/asset profile.
//
// Reminders carry a SCALAR `profileId` (not a linkedProfiles array), so the
// endpoint maps it to a single-element candidate set. This test pins that
// mapping + rule so the leak can't silently return.

const SELF = { id: "self-1", type: "self" };
const LUNA = { id: "luna-1", type: "person" };
const ALL = [SELF, LUNA];

// Mirror of the endpoint's per-reminder decision.
function reminderVisible(profileId: string | null | undefined, selectedIds: string[]): boolean {
  return passesProfileFilter(
    profileId ? [profileId] : [],
    { selectedIds, allProfiles: ALL },
  );
}

describe("reminder profile isolation", () => {
  it("shows every reminder in the unfiltered (Everyone) view", () => {
    expect(reminderVisible(null, [])).toBe(true);
    expect(reminderVisible("luna-1", [])).toBe(true);
    expect(reminderVisible("self-1", [])).toBe(true);
  });

  it("shows a linked reminder only under the profile it is linked to", () => {
    expect(reminderVisible("luna-1", ["luna-1"])).toBe(true);
    expect(reminderVisible("luna-1", ["self-1"])).toBe(false);
    expect(reminderVisible("self-1", ["luna-1"])).toBe(false);
  });

  it("defaults an unassigned (orphan) reminder to the primary/self profile", () => {
    // Unassigned reminders go to the default person — shown under self...
    expect(reminderVisible(null, ["self-1"])).toBe(true);
    // ...but NOT under a different (non-self) profile. This is the fix for the
    // screenshots: medication reminders with no profileId no longer appear
    // under Luna (a person profile) or any other non-primary profile.
    expect(reminderVisible(null, ["luna-1"])).toBe(false);
    expect(reminderVisible(undefined, ["luna-1"])).toBe(false);
  });

  it("respects a multi-profile selection", () => {
    expect(reminderVisible("luna-1", ["self-1", "luna-1"])).toBe(true);
    expect(reminderVisible("self-1", ["self-1", "luna-1"])).toBe(true);
    expect(reminderVisible("other", ["self-1", "luna-1"])).toBe(false);
    // orphan + a selection that includes self ⇒ falls through to self.
    expect(reminderVisible(null, ["self-1", "luna-1"])).toBe(true);
  });
});
