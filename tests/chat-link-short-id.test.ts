// "Link the task 'Call plumber' to Kin": the model passed Kin's SHORT id
// ("a3eab29f", the 8 characters a search result shows). link_entities stored a
// link to that non-id and the task was filed under nobody; the reply said the
// system could not do it (chat-tools.task-linked-to-person, preview 933548e,
// 2026-11-28; entity_links.target_id = "a3eab29f"). Drives the REAL dispatcher.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveIdRef } from "../shared/id-ref";

const SELF = { id: "p-self-0000-0000", name: "Tester", type: "self", fields: {} };
const KIN = { id: "a3eab29f-1111-2222-3333-444455556666", name: "Kin Example", type: "person", fields: {} };
const KIM = { id: "a3eab3aa-1111-2222-3333-444455556666", name: "Kim Example", type: "person", fields: {} };
const db = { tasks: [] as any[], links: [] as any[] };

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => [SELF, KIN, KIM],
    getTasks: async () => db.tasks,
    getExpenses: async () => [], getEvents: async () => [],
    createEntityLink: async (l: any) => { db.links.push(l); return { id: `link-${db.links.length}`, ...l }; },
    updateTask: async (id: string, patch: any) => { const t = db.tasks.find((x) => x.id === id); Object.assign(t, patch); return t; },
    linkProfileTo: async () => undefined,
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  db.links = [];
  db.tasks = [{ id: "226389b5-4783-4f36-a267-4e8b9b35a8f8", title: "Call plumber", linkedProfiles: [SELF.id], status: "todo" }];
  ({ executeTool } = await import("../server/ai-engine"));
});

describe("link_entities resolves the ids it is given before writing", () => {
  it("a short person id and a short task id file the task under that person", async () => {
    const res = await executeTool("link_entities", { source_type: "task", source_id: "226389b5", target_type: "profile", target_id: "a3eab29f", relationship: "belongs_to" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.links).toHaveLength(1);
    expect(db.links[0].targetId).toBe(KIN.id);
    expect(db.links[0].sourceId).toBe(db.tasks[0].id);
    expect(db.tasks[0].linkedProfiles).toEqual([KIN.id]);
  });
  it("a person named instead of an id is resolved too", async () => {
    const res = await executeTool("link_entities", { source_type: "task", source_id: db.tasks[0].id, target_type: "profile", target_id: "Kin Example", relationship: "belongs_to" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.tasks[0].linkedProfiles).toEqual([KIN.id]);
  });
  it("an id prefix two people share writes nothing and asks", async () => {
    const res = await executeTool("link_entities", { source_type: "task", source_id: db.tasks[0].id, target_type: "profile", target_id: "a3eab", relationship: "belongs_to" }, "u1");
    expect(res.error).toBeTruthy();
    const res2 = await executeTool("link_entities", { source_type: "task", source_id: db.tasks[0].id, target_type: "profile", target_id: "a3eab2", relationship: "belongs_to" }, "u1");
    expect(res2.error).toBeUndefined();
    expect(db.tasks[0].linkedProfiles).toEqual([KIN.id]);
  });
  it("an id that names nothing writes no link", async () => {
    const res = await executeTool("link_entities", { source_type: "task", source_id: db.tasks[0].id, target_type: "profile", target_id: "deadbeef", relationship: "belongs_to" }, "u1");
    expect(res.error).toMatch(/Nothing was linked/);
    expect(db.links).toHaveLength(0);
    expect(db.tasks[0].linkedProfiles).toEqual([SELF.id]);
  });
});

describe("resolveIdRef", () => {
  const rows = [{ id: "abc12345-x", n: "One" }, { id: "abc12399-y", n: "Two" }, { id: "fff00000-z", n: "Two" }];
  it("exact, unique prefix, unique name; never a guess", () => {
    expect(resolveIdRef("abc12345-x", rows, (r) => r.n, "row")).toEqual({ id: "abc12345-x" });
    expect(resolveIdRef("abc123", rows, (r) => r.n, "row")).toHaveProperty("error");
    expect(resolveIdRef("abc1234", rows, (r) => r.n, "row")).toEqual({ id: "abc12345-x" });
    expect(resolveIdRef("one", rows, (r) => r.n, "row")).toEqual({ id: "abc12345-x" });
    expect(resolveIdRef("Two", rows, (r) => r.n, "row")).toHaveProperty("error");
    expect(resolveIdRef("", rows, (r) => r.n, "row")).toHaveProperty("error");
  });
});
