/**
 * Removing a task's due date removes it (2026-11-12).
 *
 *  - The Tasks page's inline date field sent `dueDate: null`; the route's
 *    schema only knows "" as the clear, so the request answered 400 and the
 *    date came back.
 *  - The dashboard popup sent `dueDate: undefined`, which is not in the JSON
 *    at all: 200, nothing changed.
 * Driven through the real route.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarness, type Harness } from "./helpers/route-harness";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const seed = () => ({ tasks: [{ id: "t1", title: "File taxes", status: "todo", priority: "medium", dueDate: "2026-11-20", linkedProfiles: [], tags: [] }] }) as any;

describe("PATCH /api/tasks/:id clears the due date", () => {
  it.each([[null], [""]])("dueDate: %j", async (value) => {
    h = await startHarness(seed());
    const r = await h.api("PATCH", "/api/tasks/t1", { dueDate: value });
    expect(r.status).toBe(200);
    expect(h.db.tasks[0].dueDate || null).toBeNull();
    expect(h.db.tasks[0].title).toBe("File taxes");
  });
  it("still refuses a date that is not a date", async () => {
    h = await startHarness(seed());
    const r = await h.api("PATCH", "/api/tasks/t1", { dueDate: "next week" });
    expect(r.status).toBe(400);
    expect(h.db.tasks[0].dueDate).toBe("2026-11-20");
  });
});

describe("no task date field sends a clear the server drops", () => {
  it.each(["client/src/pages/tasks.tsx", "client/src/components/dashboard/TaskHabitPopups.tsx"])("%s", (file) => {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    expect(src).toMatch(/dueDate/);
    // `x || undefined` in a mutate() argument: the key vanishes from the JSON.
    expect(src).not.toMatch(/mutate\(\{[^\n]*dueDate: [^,}\n]*\|\| undefined/);
  });
});
