import { describe, it, expect } from "vitest";
import { passesProfileFilter } from "../shared/profile-filter";

// Regression for the RecurringDatesManager `series` memo missing its `profiles`
// dependency (BUG 2026-07-21): recurring dates disappeared and never came back
// after navigation. Root cause — `passesProfileFilter` resolves "self" profile
// ids from `allProfiles` to decide whether an ORPHAN item (no linkedProfiles)
// shows through the filter. On a high-data account the `/api/profiles` query
// resolves AFTER `/api/events`, so the first `series` render ran with an empty
// profiles list, dropped the orphan events, and — because `profiles` was not a
// memo dependency — never recomputed once profiles arrived.
//
// This pins the exact behavior the memo depends on: the SAME orphan event and
// the SAME self-profile selection produce DIFFERENT results depending solely on
// whether `profiles` has loaded. That difference is why `profiles` must be a
// dependency of the memo.

const SELF_ID = "self-1";
const selection = { selectedIds: [SELF_ID] };

describe("recurring orphan visibility depends on loaded profiles", () => {
  const orphanEvent = { linkedProfiles: undefined as string[] | undefined };

  it("drops an orphan recurring date while profiles is still empty", () => {
    const pass = passesProfileFilter(orphanEvent.linkedProfiles, {
      ...selection,
      allProfiles: [],
    });
    expect(pass).toBe(false);
  });

  it("shows the same orphan once the self profile has loaded", () => {
    const pass = passesProfileFilter(orphanEvent.linkedProfiles, {
      ...selection,
      allProfiles: [{ id: SELF_ID, type: "self" }],
    });
    expect(pass).toBe(true);
  });
});
