// Consistency layer — duplicate detection (req. tests 7, 8, 9).
import { describe, expect, it } from "vitest";
import {
  findDuplicate, dedupRecordFromExpense, dedupRecordFromEvent, dedupRecordFromTask, collapseActivityEntries,
  SIMILAR_RECORD_WARNING,
} from "../shared/domain";

describe("7. Duplicate expenses are detected", () => {
  const existing = [dedupRecordFromExpense({ id: "e1", description: "Dinner at Chili's", amount: 100, date: "2026-08-09", linkedProfiles: ["bob"] })];
  it("'Chilis dinner $100 on August 9' is the same expense", () => {
    const r = findDuplicate(dedupRecordFromExpense({ description: "Chilis dinner $100 on August 9", amount: 100, date: "2026-08-09", linkedProfiles: ["bob"] }), existing);
    expect(r.confidence).toBe("high");
    expect(r.match?.record.id).toBe("e1");
  });
  it("a different owner or amount is not a duplicate; an uncertain match warns", () => {
    expect(findDuplicate(dedupRecordFromExpense({ description: "Dinner at Chili's", amount: 100, date: "2026-08-09", linkedProfiles: ["jane"] }), existing).confidence).toBe("none");
    expect(findDuplicate(dedupRecordFromExpense({ description: "Dinner at Chili's", amount: 60, date: "2026-08-09", linkedProfiles: ["bob"] }), existing).confidence).toBe("none");
    const r = findDuplicate(dedupRecordFromExpense({ description: "Restaurant", amount: 100, date: "2026-08-10", linkedProfiles: ["bob"] }), existing);
    expect(r.confidence).toBe("uncertain");
    expect(r.warning).toBe(SIMILAR_RECORD_WARNING);
  });
});

describe("8. Duplicate events are detected", () => {
  const existing = [dedupRecordFromEvent({ id: "ev1", title: "Soccer practice", date: "2026-09-22", time: "07:00", linkedProfiles: ["bob"] })];
  it("same title, date and time is a duplicate", () => {
    expect(findDuplicate(dedupRecordFromEvent({ title: "soccer practice", date: "2026-09-22", time: "07:00", linkedProfiles: ["bob"] }), existing).confidence).toBe("high");
  });
  it("a different date is a different event", () => {
    expect(findDuplicate(dedupRecordFromEvent({ title: "Soccer practice", date: "2026-09-29", time: "07:00" }), existing).confidence).toBe("none");
  });
  it("tasks: same title and due date collapse", () => {
    const tasks = [dedupRecordFromTask({ id: "t1", title: "Mow the lawn", dueDate: "2026-09-22" })];
    expect(findDuplicate(dedupRecordFromTask({ title: "mow the lawn", dueDate: "2026-09-22" }), tasks).confidence).toBe("high");
  });
});

describe("9. Duplicate activity-feed entries are collapsed", () => {
  it("one action that several systems processed shows once", () => {
    const rows = collapseActivityEntries([
      { activityId: "act-1", entityType: "task", entityId: "t9", action: "complete", description: "Completed task: Kitchen Remodel", timestamp: "2026-09-22T10:00:00Z" },
      { activityId: "act-1", entityType: "profile", entityId: "asset-1", action: "update", description: "Updated asset: Kitchen Remodel", timestamp: "2026-09-22T10:00:01Z" },
      { entityType: "task", entityId: "t9", action: "complete", description: "Kitchen Remodel completed", timestamp: "2026-09-22T10:00:02Z" },
      { entityType: "expense", entityId: "e1", action: "create", description: "Logged expense: Coffee", timestamp: "2026-09-22T11:00:00Z" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toContain("Kitchen Remodel");
    expect(rows[1].description).toContain("Coffee");
  });
});
