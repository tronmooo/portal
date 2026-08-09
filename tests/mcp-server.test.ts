// tests/mcp-server.test.ts
//
// The Portol MCP server (server/mcp-server.ts), proven over the wire.
//
// A real MCP Client is connected to the real server through the SDK's linked
// in-memory transport pair — the same protocol framing a Claude Desktop or
// Claude Code client would use — and then:
//   1. tools/list must expose EXACTLY the chat registry (TOOL_DEFINITIONS),
//      each with a usable object schema and sane read-only/destructive hints;
//   2. every scenario in the shared sweep list (tests/helpers/
//      ai-sweep-scenarios.ts) is executed via tools/call, so each of the 140
//      tools is proven to work through MCP, not just to be listed.
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemStorage, requestStorageContext } from "../server/storage";
import { TOOL_DEFINITIONS, executeTool, READ_ONLY_TOOLS } from "../server/ai-engine";
import { finalizeToolResult, buildTurnVerifyContext, recordActionLog } from "../server/ai-envelope";
import { createPortolMcpServer } from "../server/mcp-server";
import { SCENARIOS, SWEEP_USER, seedLoanSchedule, resolvePlaceholders, captureIds } from "./helpers/ai-sweep-scenarios";

describe("Portol MCP server — every chat tool works over MCP", () => {
  const storage = new MemStorage();
  const ids: Record<string, string> = {};
  let client: Client;

  beforeAll(async () => {
    await requestStorageContext.run(storage, () => seedLoanSchedule(storage));
    const server = createPortolMcpServer({ storage, userId: SWEEP_USER });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "portol-mcp-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("lists exactly the chat tool registry, schemas intact", async () => {
    const { tools } = await client.listTools();
    const listed = new Set(tools.map(t => t.name));
    const registry = TOOL_DEFINITIONS.map(t => t.name);
    expect(tools.length).toBe(registry.length);
    const missing = registry.filter(n => !listed.has(n));
    expect(missing, `Registered tools missing from MCP list: ${missing.join(", ")}`).toEqual([]);
    for (const t of tools) {
      expect((t.inputSchema as any)?.type, `${t.name} has no object inputSchema`).toBe("object");
      expect(t.description, `${t.name} has no description`).toBeTruthy();
    }
  });

  it("annotates read-only and destructive tools honestly", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const ann: any = t.annotations || {};
      expect(!!ann.readOnlyHint, `${t.name} readOnlyHint`).toBe(READ_ONLY_TOOLS.has(t.name));
      if (t.name.startsWith("delete_")) expect(ann.destructiveHint, `${t.name} destructiveHint`).toBe(true);
      if (READ_ONLY_TOOLS.has(t.name)) expect(ann.destructiveHint, `${t.name} is read-only`).not.toBe(true);
    }
  });

  it("rejects an unknown tool with a helpful error instead of crashing", async () => {
    const res: any = await client.callTool({ name: "definitely_not_a_tool", arguments: {} });
    expect(res.isError).toBe(true);
    expect(String(res.content?.[0]?.text || "")).toMatch(/unknown tool/i);
  });

  // ── The full sweep, over the wire ─────────────────────────────────────
  for (const [i, sc] of SCENARIOS.entries()) {
    it(`${String(i + 1).padStart(3, "0")} ${sc.tool}${sc.note ? ` (${sc.note})` : ""}`, async () => {
      const input = resolvePlaceholders(sc.input, ids);

      // undo_last_action needs a ledger row, recorded exactly as a chat turn
      // records one (envelope + action log) — outside the MCP call.
      if (sc.tool === "undo_last_action") {
        await requestStorageContext.run(storage, async () => {
          const seedInput = { title: "MCP undo probe task" };
          const raw = await executeTool("create_task", seedInput, SWEEP_USER);
          expect(raw?.error).toBeUndefined();
          const ctx = buildTurnVerifyContext(storage);
          const envelope = await finalizeToolResult("create_task", "create_task", seedInput, raw, ctx);
          await recordActionLog(ctx, "create_task", "create_task", seedInput, envelope, null);
        });
      }

      const wire: any = await client.callTool({ name: sc.tool, arguments: input });
      expect(Array.isArray(wire.content), `${sc.tool} returned no content`).toBe(true);
      const text = String(wire.content?.[0]?.text ?? "null");
      let res: any = null;
      try { res = JSON.parse(text); } catch { res = { raw: text }; }

      if (sc.expect === "soft") {
        // A structured error is fine (needs an external service); the call
        // itself still had to succeed at the protocol level.
        expect(wire.content.length).toBeGreaterThan(0);
      } else {
        expect(wire.isError, `${sc.tool} errored over MCP: ${text.slice(0, 300)}`).toBeFalsy();
      }

      captureIds(sc.tool, sc.input, res, ids);
      await sc.verify?.(res, { storage, ids });
    });
  }
});
