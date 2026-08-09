// tests/ai-executor-sweep.test.ts
//
// EVERY registered AI chat tool, actually executed.
//
// tests/ai-tool-registry.test.ts proves each tool is *wired* (definition ↔
// executor case). This suite proves each tool *runs*: all tools in
// TOOL_DEFINITIONS are driven through the real executeTool against MemStorage,
// in lifecycle order (create → read → link → pay → update → complete →
// delete/restore → bulk), on one shared storage so entities persist between
// scenarios the way they do across a real chat session.
//
// The scenario list lives in tests/helpers/ai-sweep-scenarios.ts and is shared
// with tests/mcp-server.test.ts, which runs the same scenarios through the
// MCP transport (server/mcp-server.ts).
//
// What the first run of this sweep found (2026-08-09) — all fixed alongside it:
//   • MemStorage threw "not implemented" for every liability link, asset
//     ownership link, and liability payment — 10+ chat commands dead on the
//     dev backend.
//   • MemStorage.createPaycheck returned a row without storing it, so
//     confirm/delete paycheck could never find anything.
//   • deleteTask/deleteHabit hard-deleted, so restore_task / restore_habit
//     always reported "nothing to restore".
//   • undo_last_payment failed after a successful pay_obligation (obligation
//     payments were embedded; deleteLiabilityPayment didn't know about them).
//   • findOrphans read a `result.issues` field getOwnershipConsistency never
//     returns, reporting "everything healthy" no matter how much drift existed.
//   • create_artifact rejected checklists whose items were plain strings —
//     a shape the model regularly emits.
//   • update_budget / confirm_paycheck_received demanded row ids the model
//     doesn't have; they now resolve category / source names too.
//
// Exhaustiveness is enforced below: a tool added to TOOL_DEFINITIONS without a
// scenario fails the suite by name.
import { describe, it, expect, beforeAll } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { TOOL_DEFINITIONS, executeTool } from "../server/ai-engine";
import { finalizeToolResult, buildTurnVerifyContext, recordActionLog } from "../server/ai-envelope";
import { SCENARIOS, SWEEP_USER, seedLoanSchedule, resolvePlaceholders, captureIds } from "./helpers/ai-sweep-scenarios";

describe("AI executor sweep — every registered tool actually runs", () => {
  const storage = new MemStorage();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await requestStorageContext.run(storage, () => seedLoanSchedule(storage));
  });

  it("covers every tool in TOOL_DEFINITIONS (add a scenario when you add a tool)", () => {
    const covered = new Set(SCENARIOS.map(s => s.tool));
    const uncovered = TOOL_DEFINITIONS.map(t => t.name).filter(n => !covered.has(n));
    expect(uncovered, `Tools registered but never exercised: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("has no scenario for a tool that doesn't exist", () => {
    const registered = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const stale = SCENARIOS.map(s => s.tool).filter(n => !registered.has(n));
    expect(stale, `Scenarios for unregistered tools: ${stale.join(", ")}`).toEqual([]);
  });

  for (const [i, sc] of SCENARIOS.entries()) {
    it(`${String(i + 1).padStart(3, "0")} ${sc.tool}${sc.note ? ` (${sc.note})` : ""}`, async () => {
      await requestStorageContext.run(storage, async () => {
        const input = resolvePlaceholders(sc.input, ids);

        // undo_last_action needs a ledger row; record one through the real
        // envelope, the same way processMessage does after every write.
        if (sc.tool === "undo_last_action") {
          const seedInput = { title: "Sweep undo probe task" };
          const raw = await executeTool("create_task", seedInput, SWEEP_USER);
          expect(raw?.error).toBeUndefined();
          const ctx = buildTurnVerifyContext(storage);
          const envelope = await finalizeToolResult("create_task", "create_task", seedInput, raw, ctx);
          await recordActionLog(ctx, "create_task", "create_task", seedInput, envelope, null);
        }

        const res = await executeTool(sc.tool, input, SWEEP_USER);

        if (sc.expect === "soft") {
          // Allowed to report a structured error (external dependency), but a
          // throw would still have failed above.
          expect(res).toBeTruthy();
        } else if (res && typeof res === "object") {
          expect(res.error, `${sc.tool} returned error: ${res.error}`).toBeUndefined();
        }

        captureIds(sc.tool, sc.input, res, ids);
        await sc.verify?.(res, { storage, ids });
      });
    });
  }
});
