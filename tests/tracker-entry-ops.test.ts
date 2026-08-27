// Tracker entry writes: one value gate for every path, and edits that edit.
//
// There were three validation regimes (route: bounds; smart-entry: normalize;
// AI quick-log lanes: nothing), and the AI's "update" was delete + re-log —
// new id, timestamp reset to NOW, enrichment/mood/tags dropped. These tests
// pin the shared guard and the real update.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { sanitizeTrackerEntryValues } from "../server/tracker-entry-guard";

const FIELDS = [
  { name: "weight", type: "number" },
  { name: "hours", type: "number" },
  { name: "notes", type: "text" },
];

describe("sanitizeTrackerEntryValues — the one gate", () => {
  it("coerces numeric strings and strips units", () => {
    const out = sanitizeTrackerEntryValues(FIELDS, { weight: "183.5 lbs" });
    expect(out.error).toBeUndefined();
    expect(out.values.weight).toBe(183.5);
  });

  it("rejects non-numeric strings in numeric fields", () => {
    const out = sanitizeTrackerEntryValues(FIELDS, { weight: "Chicken Sandwich" });
    expect(out.error).toContain("expects a number");
  });

  it("rejects impossible values — the AI quick-log lanes now hit this too", () => {
    expect(sanitizeTrackerEntryValues(FIELDS, { hours: 8000 }).error).toContain("impossible");
    expect(sanitizeTrackerEntryValues(FIELDS, { weight: 5000 }).error).toContain("unrealistic");
    expect(sanitizeTrackerEntryValues([], { systolic: 400 }).error).toContain("unrealistic");
    expect(sanitizeTrackerEntryValues([], { anything: 250000 }).error).toContain("exceeds maximum");
  });

  it("rejects negatives only where negative is impossible", () => {
    expect(sanitizeTrackerEntryValues([], { weight: -5 }).error).toContain("cannot be negative");
    expect(sanitizeTrackerEntryValues([], { temperature: -5 }).error).toBeUndefined();
  });

  it("rejects an all-empty entry, passes a clean one untouched", () => {
    expect(sanitizeTrackerEntryValues(FIELDS, { weight: null, hours: "" }).error).toContain("At least one value");
    const clean = sanitizeTrackerEntryValues(FIELDS, { weight: 183.5, _habitId: "h1" });
    expect(clean.error).toBeUndefined();
    expect(clean.values).toEqual({ weight: 183.5, _habitId: "h1" });
  });

  it("is idempotent — a validated value re-validates unchanged", () => {
    const once = sanitizeTrackerEntryValues(FIELDS, { weight: "180 lbs" });
    const twice = sanitizeTrackerEntryValues(FIELDS, once.values);
    expect(twice.error).toBeUndefined();
    expect(twice.values).toEqual(once.values);
  });
});

describe("every write path runs the gate (source guards)", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("both storages' logEntry call the guard", () => {
    for (const f of ["server/supabase-storage.ts", "server/storage.ts"]) {
      const src = read(f);
      const fn = src.slice(src.indexOf("async logEntry("));
      const body = fn.slice(0, 4000);
      expect(body, `${f} logEntry skips the value gate`).toContain("sanitizeTrackerEntryValues");
    }
  });

  it("the AI edit is a real update, not delete + re-log", () => {
    const src = read("server/ai-engine.ts");
    const tool = src.slice(src.indexOf('case "update_tracker_entry"'));
    const body = tool.slice(0, tool.indexOf("case \"delete_tracker\""));
    expect(body).toContain("storage.updateTrackerEntry");
    expect(body).not.toContain("storage.deleteTrackerEntry");
    expect(body).not.toContain("storage.logEntry");
  });

  it("entry deletes go through removeTrackerEntry at every entry point", () => {
    // A bare deleteTrackerEntry leaves the paired habit check-in behind, so
    // the habit stays "done" off a record the user just removed. The one
    // legitimate raw call site is the admin garbage-entry sweep in routes.ts
    // (malformed rows are not mirrors).
    for (const [f, budget] of [["server/routes.ts", 1], ["server/ai-engine.ts", 0]] as const) {
      const count = (read(f).match(/storage\.deleteTrackerEntry\(/g) || []).length;
      expect(count, `${f}: bare deleteTrackerEntry call`).toBeLessThanOrEqual(budget);
    }
  });
});
