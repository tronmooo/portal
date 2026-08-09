# Portol MCP server

`server/mcp-server.ts` exposes the **entire AI chat tool registry** (all 140
tools in `TOOL_DEFINITIONS`) over the [Model Context Protocol](https://modelcontextprotocol.io),
so any MCP client — Claude Desktop, Claude Code, an Agent SDK app — can drive
Portol with the same commands the in-app chat runs, through the same
`executeTool` dispatcher.

## Run

```bash
npm run mcp        # stdio transport
```

## Storage backend

Chosen at startup from the environment:

| Env | Backend |
| --- | --- |
| `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `PORTOL_USER_ID` | Real per-user Supabase data. The service key bypasses RLS — `PORTOL_USER_ID` decides whose data is exposed, so treat the configured client as fully trusted for that account. |
| (anything else) | In-memory dev sandbox — starts empty, nothing persists. |

## Client config (Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "portol": {
      "command": "npx",
      "args": ["tsx", "server/mcp-server.ts"],
      "cwd": "/path/to/portal",
      "env": {
        "VITE_SUPABASE_URL": "https://…supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "…",
        "PORTOL_USER_ID": "…"
      }
    }
  }
}
```

## Guarantees

- `tools/list` mirrors `TOOL_DEFINITIONS` exactly (names, descriptions, JSON
  schemas), with `readOnlyHint` from the engine's `READ_ONLY_TOOLS` set and
  `destructiveHint` on `delete_*` / `execute_bulk_action`.
- Tool results come back as JSON text; executor-level failures set
  `isError: true` with the executor's structured error message.
- `tests/mcp-server.test.ts` connects a real MCP client over the SDK's linked
  transport and drives **every** registered tool through `tools/call`, sharing
  the scenario list with `tests/ai-executor-sweep.test.ts` — a tool that lists
  but cannot execute fails CI, and a tool added without a scenario fails by
  name.
