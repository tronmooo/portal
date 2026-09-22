// Rule 1 — the storage PROXY (server/storage.ts) is where every write in the
// app passes, so it is where a read-only turn is made physically incapable
// of writing. This pins the proxy itself, not the engine: a MemStorage
// instance is bound through requestStorageContext exactly as the auth
// middleware binds a per-request instance, then a write is attempted from
// inside a READ scope.
import { describe, it, expect } from "vitest";
import { storage, requestStorageContext, MemStorage } from "../server/storage";
import { runWithMutationScope, isReadOnlyTurnError } from "../server/mutation-scope";

describe("storage proxy under a read-only mutation scope", () => {
  it("refuses createTask during a READ turn and allows it otherwise", async () => {
    const mem = new MemStorage();
    await requestStorageContext.run(mem, async () => {
      // Reads still work inside the read-only scope.
      await runWithMutationScope({ intent: "READ", allowedMutations: "none" }, async () => {
        const tasks = await storage.getTasks();
        expect(Array.isArray(tasks)).toBe(true);
        let err: unknown;
        try { await storage.createTask({ title: "should not exist", linkedProfiles: [] } as any); } catch (e) { err = e; }
        expect(isReadOnlyTurnError(err)).toBe(true);
      });
      expect((await mem.getTasks()).some((t: any) => t.title === "should not exist")).toBe(false);

      // The same call outside the read scope writes.
      await runWithMutationScope({ intent: "CREATE", allowedMutations: "all" }, async () => {
        const t = await storage.createTask({ title: "exists", linkedProfiles: [] } as any);
        expect(t?.title).toBe("exists");
      });
      expect((await mem.getTasks()).some((t: any) => t.title === "exists")).toBe(true);
    });
  });

  it("MemStorage keeps one ledger row per operation id and stores chat runs", async () => {
    const mem = new MemStorage();
    const a = await mem.createAiActionLog({ tool: "create_task", actionType: "create_task", operationId: "op_x", requestId: "req_x", turnId: "t" });
    const b = await mem.createAiActionLog({ tool: "create_task", actionType: "create_task", operationId: "op_x", requestId: "req_x", turnId: "t" });
    expect(a?.id).toBe(b?.id);
    expect((await mem.findAiActionByOperationId("op_x"))?.id).toBe(a?.id);
    expect(await mem.findAiActionByOperationId("nope")).toBeUndefined();

    const run = await mem.upsertAiChatRun({ requestId: "req_x", status: "running", message: "add a task" });
    expect(run?.status).toBe("running");
    const done = await mem.upsertAiChatRun({ requestId: "req_x", status: "completed", result: { reply: "ok" } });
    expect(done?.id).toBe(run?.id);
    expect(done?.result).toEqual({ reply: "ok" });
    expect(done?.message).toBe("add a task");
    expect((await mem.getAiChatRun("req_x"))?.status).toBe("completed");
  });
});
