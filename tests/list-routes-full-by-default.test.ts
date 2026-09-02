/**
 * Every list the dashboard bootstrap seeds WHOLE into the client cache must
 * come back whole from its own route too.
 *
 * /api/dashboard-bootstrap hands the client all tasks/events/journal/... and
 * the pages render those lists. Their first refetch after a write went through
 * paginate()'s 100-row default, so with 121 open tasks the Tasks page counted
 * 121, then 100 once a task was added — and the task just created was not in
 * the 100 (probe p04, 2026-09-02). One list, one size: full by default, paged
 * only on an explicit ?limit=/?offset=.
 */
import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const many = (n: number, mk: (i: number) => any) => Array.from({ length: n }, (_, i) => mk(i));

describe("seeded list routes are full by default", () => {
  it("GET /api/tasks returns every task (not 100) and still reports X-Total-Count", async () => {
    h = await startHarness({ tasks: many(130, i => ({ id: `task-${i}`, title: `Task ${i}`, status: "todo", priority: "medium", linkedProfiles: [], tags: [], createdAt: new Date(2026, 0, 1 + (i % 28)).toISOString() })) });
    const r = await h.api("GET", "/api/tasks");
    expect(r.status).toBe(200);
    expect(r.data).toHaveLength(130);
    expect(r.headers["x-total-count"]).toBe("130");
  });

  it("an explicit pager still pages", async () => {
    h = await startHarness({ tasks: many(130, i => ({ id: `task-${i}`, title: `Task ${i}`, status: "todo", priority: "medium", linkedProfiles: [], tags: [], createdAt: "2026-01-01T00:00:00.000Z" })) });
    const r = await h.api("GET", "/api/tasks?limit=50&offset=100");
    expect(r.data).toHaveLength(30);
    expect(r.headers["x-total-count"]).toBe("130");
  });

  it("GET /api/events returns every event", async () => {
    h = await startHarness({ events: many(140, i => ({ id: `ev-${i}`, title: `Event ${i}`, date: `2026-0${1 + (i % 9)}-1${i % 9}`, allDay: true, category: "personal", recurrence: "none", linkedProfiles: [], tags: [], createdAt: "2026-01-01T00:00:00.000Z" })) });
    const r = await h.api("GET", "/api/events");
    expect(r.status).toBe(200);
    expect(r.data.length).toBe(140);
  });
});
