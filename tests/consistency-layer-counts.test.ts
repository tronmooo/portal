// Consistency layer — scoped counts (req. test 17).
import { describe, expect, it } from "vitest";
import { getTaskCount, getTrackerCount, type OwnershipContext, type ResolvedScope } from "../shared/domain";

const BOB = "11111111-1111-4111-8111-111111111111", JANE = "22222222-2222-4222-8222-222222222222";
const ctx: OwnershipContext = { profiles: [{ id: BOB, name: "Bob", type: "self" }, { id: JANE, name: "Jane", type: "person" }] };
const bob: ResolvedScope = { mode: "current", profileIds: [BOB], label: "Bob", explicitlyRequested: false };
const everyone: ResolvedScope = { mode: "everyone", profileIds: [], label: "Everyone", explicitlyRequested: true };
const tasks = [
  { id: "1", title: "A", status: "todo", dueDate: "2026-09-20", linkedProfiles: [BOB] },
  { id: "2", title: "B", status: "todo", dueDate: "2026-09-22", linkedProfiles: [BOB] },
  { id: "3", title: "C", status: "done", dueDate: "2026-09-22", linkedProfiles: [BOB] },
  { id: "4", title: "D", status: "todo", dueDate: "2026-09-30", linkedProfiles: [JANE] },
  { id: "5", title: "QA Test Task", status: "todo", linkedProfiles: [BOB] },
];

describe("17. Dashboard and Settings counts agree when given the same scope", () => {
  it("the same scope yields the same number on every surface, and the label says which scope", () => {
    const dashboard = getTaskCount(tasks, { scope: bob, status: "open", todayISO: "2026-09-22" }, ctx);
    const settings = getTaskCount(tasks, { scope: bob, status: "open", todayISO: "2026-09-22" }, ctx);
    expect(dashboard.count).toBe(settings.count);
    expect(dashboard.count).toBe(2);
    expect(dashboard.scopeLabel).toBe("Open tasks · Bob");
    const all = getTaskCount(tasks, { scope: everyone, status: "open", todayISO: "2026-09-22" }, ctx);
    expect(all.count).toBe(3);
    expect(all.scopeLabel).toBe("Open tasks · Everyone");
  });
  it("status and date scopes are explicit", () => {
    expect(getTaskCount(tasks, { scope: bob, status: "overdue", todayISO: "2026-09-22" }, ctx).count).toBe(1);
    expect(getTaskCount(tasks, { scope: bob, status: "due_today", todayISO: "2026-09-22" }, ctx).count).toBe(1);
    expect(getTaskCount(tasks, { scope: bob, status: "all", todayISO: "2026-09-22", includeTestData: true }, ctx).count).toBe(4);
    expect(getTaskCount(tasks, { scope: everyone, status: "open", todayISO: "2026-09-22", dateRange: { start: "2026-09-22", end: "2026-09-30" } }, ctx).count).toBe(2);
  });
  it("tracker counts carry the same scope discipline", () => {
    const trackers = [{ id: "a", name: "Water", linkedProfiles: [BOB], entries: [{}] }, { id: "b", name: "Steps", linkedProfiles: [JANE], entries: [] }, { id: "c", name: "Sleep", linkedProfiles: [BOB], entries: [] }];
    expect(getTrackerCount(trackers, { scope: bob }, ctx).count).toBe(2);
    expect(getTrackerCount(trackers, { scope: bob, activeOnly: true }, ctx)).toMatchObject({ count: 1, scopeLabel: "Active trackers · Bob" });
    expect(getTrackerCount(trackers, { scope: everyone }, ctx).count).toBe(3);
  });
});
