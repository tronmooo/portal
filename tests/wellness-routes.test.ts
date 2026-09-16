// Route-level verification for the Wellness rebuild: the pure modules are
// tested elsewhere, this proves the HANDLERS use them.
//
// Drives the real Express app (tests/helpers/route-harness) over HTTP:
//   * an impossible lab value is refused by the write route and nothing is
//     stored — the HbA1c 179 % that the old bounds let through;
//   * an edit cannot smuggle one past either;
//   * the weekly-brief endpoint reads ONE subject and describes only data that
//     exists, never a missing log.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";

const SELF = { id: "self-1", type: "self", name: "Test" };
const LINDA = { id: "linda-1", type: "person", name: "Linda" };
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const tracker = (over: any) => ({
  id: over.id, name: over.name, category: over.category || "health", unit: over.unit || "",
  fields: over.fields || [{ name: "value", type: "number" }],
  entries: over.entries || [], linkedProfiles: over.linkedProfiles || [SELF.id],
});

let h: Harness;
afterEach(async () => { await h?.close(); });

describe("the tracker-entry route refuses an impossible lab value", () => {
  beforeEach(async () => {
    h = await startHarness({
      profiles: [SELF],
      trackers: [
        tracker({ id: "tr-a1c", name: "HbA1c", category: "labs", entries: [{ id: "e0", values: { value: 5.4 }, timestamp: iso(30) }] }),
        tracker({ id: "tr-games", name: "Video games", category: "gaming", fields: [{ name: "hours", type: "number" }] }),
      ],
    });
  });

  it("400s on HbA1c 179 and stores nothing", async () => {
    const r = await h.api("POST", "/api/trackers/tr-a1c/entries", { values: { value: 179 } });
    expect(r.status).toBe(400);
    expect(String(r.data?.error)).toMatch(/HbA1c/);
    expect(h.db.trackers![0].entries).toHaveLength(1); // only the seeded 5.4
  });

  it("still accepts a real one", async () => {
    const r = await h.api("POST", "/api/trackers/tr-a1c/entries", { values: { value: 5.6 } });
    expect(r.status).toBe(201);
    expect(h.db.trackers![0].entries).toHaveLength(2);
  });

  it("refuses the same value on an edit", async () => {
    const r = await h.api("PATCH", "/api/trackers/tr-a1c/entries/e0", { values: { value: 179 } });
    expect(r.status).toBe(400);
    expect(h.db.trackers![0].entries[0].values.value).toBe(5.4); // unchanged
  });

  it("leaves a tracker that is not a health metric alone", async () => {
    const r = await h.api("POST", "/api/trackers/tr-games/entries", { values: { hours: 3 } });
    expect(r.status).toBe(201);
  });
});

describe("the weekly-brief endpoint", () => {
  const sleepEntries = [
    { id: "s1", values: { value: 8 }, timestamp: iso(25) },
    { id: "s2", values: { value: 8 }, timestamp: iso(18) },
    { id: "s3", values: { value: 8 }, timestamp: iso(11) },
    { id: "s4", values: { value: 7 }, timestamp: iso(4) },
    { id: "s5", values: { value: 7 }, timestamp: iso(2) },
  ];

  it("describes trends in data that exists and never mentions missing logs", async () => {
    h = await startHarness({
      profiles: [SELF],
      trackers: [
        tracker({ id: "tr-sleep", name: "Sleep", unit: "h", entries: sleepEntries }),
        // A tracker with nothing logged for a month: the OLD engine turned this
        // into "Hydration hasn't been logged in 24 days".
        tracker({ id: "tr-hyd", name: "Hydration", category: "hydration", unit: "oz", entries: [{ id: "w1", values: { value: 20 }, timestamp: iso(24) }] }),
      ],
    });
    const r = await h.api("POST", "/api/wellness/insights", {});
    expect(r.status).toBe(200);
    expect(r.data.narrative).toMatch(/Sleep is \d+ min down/);
    expect(r.data.narrative).not.toMatch(/log|streak|goal|missed|hydration/i);
  });

  it("reads one subject — another person's readings never reach the brief", async () => {
    h = await startHarness({
      profiles: [SELF, LINDA],
      trackers: [
        tracker({ id: "tr-lw", name: "Weight", unit: "lbs", linkedProfiles: [LINDA.id], entries: [
          { id: "lw1", values: { value: 300 }, timestamp: iso(20) },
          { id: "lw2", values: { value: 290 }, timestamp: iso(1) },
        ] }),
      ],
    });
    const mine = await h.api("POST", "/api/wellness/insights", {});
    expect(mine.data.narrative).toMatch(/No health data is flowing in yet/);
    const hers = await h.api("POST", "/api/wellness/insights", { profileIds: [LINDA.id] });
    expect(hers.data.narrative).toMatch(/Weight is/);
  });

  it("says what would make the page work when nothing is connected", async () => {
    h = await startHarness({ profiles: [SELF], trackers: [] });
    const r = await h.api("POST", "/api/wellness/insights", {});
    expect(r.data.narrative).toMatch(/Connect Apple Health or Health Connect/);
    expect(r.data.findingsCount).toBe(0);
  });
});
