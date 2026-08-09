// ── Portol MCP server ────────────────────────────────────────────────────────
// Exposes the ENTIRE AI chat tool registry (TOOL_DEFINITIONS — 140 tools) over
// the Model Context Protocol, so any MCP client (Claude Desktop, Claude Code,
// an agent SDK) can drive Portol with the same commands the in-app chat runs.
//
// The registry's Anthropic tool definitions are already JSON Schema, so they
// pass straight through as MCP inputSchemas; execution goes through the same
// executeTool dispatcher the chat uses, inside a requestStorageContext scope.
// tests/mcp-server.test.ts drives every registered tool through a real MCP
// client/server pair, so a tool that lists but cannot execute fails CI.
//
// Run (stdio):
//   npm run mcp
//
// Storage backend, chosen at startup:
//   • VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + PORTOL_USER_ID set
//       → real per-user Supabase storage (production data — the service key
//         bypasses RLS, so PORTOL_USER_ID decides whose data is exposed).
//   • otherwise → in-memory dev storage (empty sandbox, nothing persists).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, executeTool, READ_ONLY_TOOLS } from "./ai-engine";
import { MemStorage, createScopedStorage, isSupabaseStorage, requestStorageContext, type IStorage } from "./storage";

/** Tools whose primary effect is removing data (drives destructiveHint). */
const DESTRUCTIVE_TOOLS = new Set(
  TOOL_DEFINITIONS.map(t => t.name).filter(n => n.startsWith("delete_")).concat(["execute_bulk_action"]),
);

export interface PortolMcpOptions {
  storage: IStorage;
  userId: string;
}

/**
 * Build the MCP server around an already-chosen storage backend. Exported
 * separately from stdio startup so tests can wire it to an in-memory
 * transport and drive every tool without a child process.
 */
export function createPortolMcpServer(opts: PortolMcpOptions): Server {
  const { storage, userId } = opts;
  const server = new Server(
    { name: "portol", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.input_schema as any,
      annotations: {
        readOnlyHint: READ_ONLY_TOOLS.has(t.name),
        destructiveHint: DESTRUCTIVE_TOOLS.has(t.name),
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    if (!TOOL_DEFINITIONS.some(t => t.name === name)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool "${name}". Call tools/list for the registry.` }],
        isError: true,
      };
    }
    try {
      const result = await requestStorageContext.run(storage, async () => {
        try { (storage as any).enableRequestMemo?.(); } catch { /* MemStorage */ }
        return executeTool(name, args, userId);
      });
      const isError = !!(result && typeof result === "object" && (result as any).error);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result ?? null, null, 2) }],
        isError,
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `${name} failed: ${e?.message || String(e)}` }],
        isError: true,
      };
    }
  });

  return server;
}

/** Resolve the storage/user pair from the environment (see file header). */
export function resolveMcpContext(): PortolMcpOptions & { backend: "supabase" | "memory" } {
  if (isSupabaseStorage()) {
    const userId = process.env.PORTOL_USER_ID;
    if (!userId) {
      throw new Error(
        "Supabase env vars are set but PORTOL_USER_ID is not. The MCP server scopes " +
        "all 140 tools to one user's data — set PORTOL_USER_ID to that user's id.",
      );
    }
    return { storage: createScopedStorage(userId), userId, backend: "supabase" };
  }
  return { storage: new MemStorage(), userId: process.env.PORTOL_USER_ID || "mcp-local-user", backend: "memory" };
}

async function main() {
  const ctx = resolveMcpContext();
  // stdout carries the protocol — status goes to stderr only.
  console.error(`[portol-mcp] ${TOOL_DEFINITIONS.length} tools, ${ctx.backend} storage, user ${ctx.userId}`);
  const server = createPortolMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

// Start only when executed directly (tsx server/mcp-server.ts / npm run mcp),
// not when imported by tests.
if (process.argv[1] && /mcp-server\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("[portol-mcp] fatal:", e?.message || e);
    process.exit(1);
  });
}
