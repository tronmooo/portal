import { describe, it, expect } from "vitest";
import { isInScope, selfIdsFrom } from "../shared/scope";

// BUG-20260709-reminder-leak — profile isolation for the reminders feed.
//
// `/api/reminders` was the ONE list endpoint that returned every reminder for
// the user with no profile filter, so medication / refill / appointment
// reminders (many created with no profileId) leaked into EVERY profile's
// dashboard REMINDERS card. The fix filters the endpoint with the same
// canonical scope primitive every sibling endpoint uses, under the STRICT
// ("out_of_scope") policy the calendar already applies — unlinked reminders
// never fall through to an individual profile; they only show in the
// unfiltered "Everyone" view.
//
// Reminders carry a SCALAR `profileId` (not a linkedProfiles array), so the
// endpoint maps it to a single-element candidate set. This test pins that
// mapping + policy so the leak can't silently return.

const SELF = { id: "self-1", type: "self" };
const LUNA = { id: "luna-1", type: "person" };
const ALL = [SELF, LUNA];
const selfIds = selfIdsFrom(ALL);

// Mirror of the endpoint's per-reminder decision.
function reminderVisible(profileId: string | null | undefined, selectedIds: string[]): boolean {
  return isInScope(
    profileId ? [profileId] : [],
    { selectedIds, selfIds },
    "out_of_scope",
  );
}

describe("reminder profile isolation", () => {
  it("shows every reminder in the unfiltered (Everyone) view", () => {
    expect(reminderVisible(null, [])).toBe(true);
    expect(reminderVisible("luna-1", [])).toBe(true);
    expect(reminderVisible("self-1", [])).toBe(true);
  });

  it("shows a reminder only under the profile it is linked to", () => {
    expect(reminderVisible("luna-1", ["luna-1"])).toBe(true);
    expect(reminderVisible("luna-1", ["self-1"])).toBe(false);
    expect(reminderVisible("self-1", ["luna-1"])).toBe(false);
  });

  it("does NOT leak an unlinked (orphan) reminder into ANY selected profile", () => {
    // This is the exact bug the screenshots showed: medication reminders with
    // no profileId appearing under Luna. Strict policy keeps them out of every
    // individual profile — including the self profile.
    expect(reminderVisible(null, ["luna-1"])).toBe(false);
    expect(reminderVisible(null, ["self-1"])).toBe(false);
    expect(reminderVisible(undefined, ["luna-1", "self-1"])).toBe(false);
  });

  it("respects a multi-profile selection", () => {
    expect(reminderVisible("luna-1", ["self-1", "luna-1"])).toBe(true);
    expect(reminderVisible("self-1", ["self-1", "luna-1"])).toBe(true);
    expect(reminderVisible("other", ["self-1", "luna-1"])).toBe(false);
  });
});
