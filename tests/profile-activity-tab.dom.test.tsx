// @vitest-environment jsdom
//
// The Activity tab appears whenever a profile has activity.
//
// 2026-11-19 (live walk-through): an asset whose only activity was an expense
// had no Activity tab at all. The tab lists expenses, but its "has data" rule
// only counted events and tasks.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest: vi.fn(), BROWSER_TIMEZONE: "UTC", getQueryFn: () => async () => null };
});

import { getTabsForType } from "@/pages/profile-detail";

const base = { relatedEvents: [], relatedTasks: [], relatedExpenses: [], relatedDocuments: [], relatedTrackers: [], relatedHabits: [], relatedObligations: [], timeline: [], fields: {} };
const tabsOf = (profile: any) => getTabsForType("asset", profile).map((t) => t.value);

describe("an asset's Activity tab", () => {
  it("is shown when the only activity is an expense", () => {
    const expense = { id: "e1", description: "Ear pads", amount: 39.99, date: "2026-11-18", linkedProfiles: ["a1"] };
    expect(tabsOf({ ...base, relatedExpenses: [expense], timeline: [{ id: "e1", type: "expense", title: "Ear pads", timestamp: "2026-11-18" }] })).toContain("timeline");
  });
  it("is shown for a task or an event, as before", () => {
    expect(tabsOf({ ...base, relatedTasks: [{ id: "t1" }] })).toContain("timeline");
    expect(tabsOf({ ...base, relatedEvents: [{ id: "v1" }] })).toContain("timeline");
  });
  it("is hidden when nothing has happened", () => {
    expect(tabsOf(base)).not.toContain("timeline");
    // …and the test can see the tab list at all.
    expect(tabsOf(base)).toContain("info");
  });
});
