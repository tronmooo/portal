import { describe, it, expect } from "vitest";
import {
  eventDrivingFieldKeys,
  profileEditTouchesEventKey,
} from "../server/supabase-storage";

// PERF regression guard (mileage-save fix): updateProfile only runs the
// auto-event generator (which fetches ALL events to dedup) when the incoming
// patch actually touches an event-driving field for that profile type. A
// mileage/value-only edit must skip it so the write path doesn't do a full
// getEvents() round-trip on every ordinary field change.

describe("profileEditTouchesEventKey — skips event work for non-date edits", () => {
  it("returns false for a vehicle mileage-only edit", () => {
    expect(profileEditTouchesEventKey("vehicle", { mileage: "42000" })).toBe(false);
  });

  it("returns false for an asset value-only edit", () => {
    expect(profileEditTouchesEventKey("asset", { value: "1200", condition: "good" })).toBe(false);
  });

  it("returns true when a vehicle service date is patched", () => {
    expect(profileEditTouchesEventKey("vehicle", { nextService: "2026-09-01" })).toBe(true);
  });

  it("returns true when a person's birthday is patched", () => {
    expect(profileEditTouchesEventKey("person", { birthday: "1990-04-12" })).toBe(true);
  });

  it("returns true for a liability dueDay change (synthesizes nextPayment)", () => {
    expect(profileEditTouchesEventKey("liability", { dueDay: 15 })).toBe(true);
    expect(profileEditTouchesEventKey("loan", { due_day: 3 })).toBe(true);
  });

  it("returns false for empty / missing patch bodies", () => {
    expect(profileEditTouchesEventKey("vehicle", {})).toBe(false);
    expect(profileEditTouchesEventKey("vehicle", undefined)).toBe(false);
    expect(profileEditTouchesEventKey("vehicle", null)).toBe(false);
  });

  it("returns false for a type with no event-driving keys", () => {
    expect(eventDrivingFieldKeys("note")).toEqual([]);
    expect(profileEditTouchesEventKey("note", { anything: 1 })).toBe(false);
  });

  it("treats an explicitly-undefined value as not-touched", () => {
    // A patch object that merely carries the key with `undefined` (e.g. a
    // spread that didn't set it) must not trigger the event fetch.
    expect(profileEditTouchesEventKey("vehicle", { nextService: undefined })).toBe(false);
  });
});
