// Deterministic stand-in for the Anthropic Messages API.
//
// The acceptance test is about the write→UI pipeline, not about which words the
// model picks. Scripting the model makes every run reproducible AND lets a test
// name the exact tool it wants executed — while the entire real path downstream
// (tool execution, post-write verification, the change manifest, the cache
// barrier, HTTP, React Query, the browser) runs untouched.
//
// The chat message carries the script inline:
//   "##create_task {\"title\":\"Buy milk\"}"
//   "##create_task {...} ##create_expense {...}"   ← one turn, two tool_use blocks
// Anything without a ## directive gets a plain text reply.
//
// Reached by pointing ANTHROPIC_BASE_URL at this server; the SDK appends /v1/messages.
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

interface ScriptedTool { name: string; input: Record<string, any> }

/** Parse "##tool_name {json} ##other_tool {json}" out of a user message. */
export function parseDirectives(text: string): ScriptedTool[] {
  const out: ScriptedTool[] = [];
  const re = /##([a-z_]+)\s*(\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // Brace-match the JSON payload so nested objects survive.
    let depth = 0, i = m.index + m[0].length - 1, inStr = false, esc = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    const json = text.slice(m.index + m[0].length - 1, i);
    try { out.push({ name: m[1], input: JSON.parse(json) }); } catch { /* skip malformed */ }
    re.lastIndex = i;
  }
  return out;
}

function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      if (text) return text;
    }
  }
  return "";
}

function hasToolResult(messages: any[]): boolean {
  const last = messages[messages.length - 1];
  return Array.isArray(last?.content) && last.content.some((b: any) => b?.type === "tool_result");
}

/** The full non-streaming Message object the SDK resolves to. */
function buildMessage(content: any[], stopReason: string) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-mock",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function planResponse(body: any): { content: any[]; stopReason: string } {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const toolsOffered = Array.isArray(body?.tools) && body.tools.length > 0;

  // Round 2+: the loop fed tool results back — close the turn with a recap.
  if (hasToolResult(messages)) {
    return { content: [{ type: "text", text: "Done." }], stopReason: "end_turn" };
  }

  const directives = toolsOffered ? parseDirectives(lastUserText(messages)) : [];
  if (directives.length > 0) {
    return {
      content: directives.map((d, i) => ({
        type: "tool_use",
        id: `toolu_${Date.now()}_${i}`,
        name: d.name,
        input: d.input,
      })),
      stopReason: "tool_use",
    };
  }

  // Classifier / summarizer calls (no tools offered) want parseable JSON back.
  if (!toolsOffered) {
    return {
      content: [{ type: "text", text: '{"type":"note","confidence":0.5,"title":"note"}' }],
      stopReason: "end_turn",
    };
  }
  return { content: [{ type: "text", text: "Nothing to do." }], stopReason: "end_turn" };
}

/** Anthropic's SSE event sequence for a message. */
function writeStream(res: express.Response, content: any[], stopReason: string) {
  const send = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", {
    type: "message_start",
    message: { ...buildMessage([], null as any), stop_reason: null },
  });
  content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", {
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      send("content_block_delta", {
        type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

export interface MockModel {
  url: string;
  /** Every request the engine made, for diagnostics. */
  calls: Array<{ tools: number; stream: boolean; text: string }>;
  close: () => Promise<void>;
}

export async function startMockAnthropic(): Promise<MockModel> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  const calls: MockModel["calls"] = [];

  app.post("/v1/messages", (req, res) => {
    const body = req.body || {};
    calls.push({
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      stream: !!body.stream,
      text: lastUserText(body.messages || []).slice(0, 120),
    });
    const { content, stopReason } = planResponse(body);
    if (body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      writeStream(res, content, stopReason);
      return;
    }
    res.json(buildMessage(content, stopReason));
  });

  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
