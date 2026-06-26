import { describe, it, expect } from "vitest";
import { computeNowItems } from "../shared/now-rank";

const NOW = new Date("2026-06-26T12:00:00");
const dayOffset = (n: number) => {
  const d = new Date(NOW); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("computeNowItems", () => {
  it("returns empty for no inputs", () => {
    expect(computeNowItems({ now: NOW })).toEqual([]);
  });

  it("ranks overdue items above future ones", () => {
    const items = computeNowItems({
      now: NOW,
      overdueTasks: [{ id: "t1", title: "Overdue task", dueDate: dayOffset(-3) }],
      bills: [{ id: "b1", name: "Future bill", amount: 50, dueDate: dayOffset(20), daysUntil: 20 }],
    });
    expect(items[0].sourceId).toBe("t1");
    expect(items[0].daysUntil).toBeLessThan(0);
  });

  it("maps task → complete, manual bill → pay, autopay bill → open", () => {
    const items = computeNowItems({
      now: NOW,
      overdueTasks: [{ id: "t1", title: "Task", dueDate: dayOffset(0) }],
      bills: [
        { id: "b1", name: "Manual", amount: 100, dueDate: dayOffset(1), daysUntil: 1, autopay: false },
        { id: "b2", name: "Autopay", amount: 100, dueDate: dayOffset(1), daysUntil: 1, autopay: true },
      ],
    });
    const byId = Object.fromEntries(items.map(i => [i.sourceId, i]));
    expect(byId.t1.action).toBe("complete");
    expect(byId.b1.action).toBe("pay");
    expect(byId.b2.action).toBe("open");
  });

  it("includes overdue goals but excludes on-track ones", () => {
    const items = computeNowItems({
      now: NOW,
      goals: [
        { id: "g1", title: "Overdue goal", deadline: dayOffset(-10), target: 100, current: 20, status: "active" },
        { id: "g2", title: "On track", deadline: dayOffset(90), target: 100, current: 80, status: "active" },
        { id: "g3", title: "Completed", deadline: dayOffset(-10), target: 100, current: 100, status: "completed" },
      ],
    });
    const ids = items.map(i => i.sourceId);
    expect(ids).toContain("g1");
    expect(ids).not.toContain("g2");
    expect(ids).not.toContain("g3");
  });

  it("drops bills beyond the 30-day window and events beyond 7 days", () => {
    const items = computeNowItems({
      now: NOW,
      bills: [{ id: "b1", name: "Far bill", amount: 10, dueDate: dayOffset(45), daysUntil: 45 }],
      events: [{ id: "e1", title: "Far event", date: dayOffset(10) }],
    });
    expect(items).toHaveLength(0);
  });

  it("deduplicates a task that appears in both overdue and due-soon lists", () => {
    const items = computeNowItems({
      now: NOW,
      overdueTasks: [{ id: "t1", title: "Task", dueDate: dayOffset(-1) }],
      dueSoonTasks: [{ id: "t1", title: "Task", dueDate: dayOffset(-1) }],
    });
    expect(items.filter(i => i.sourceId === "t1")).toHaveLength(1);
  });
});
