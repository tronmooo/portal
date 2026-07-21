// ── Chat streaming transport (P0: chat had NO streaming) ─────────────────────
// POSTs /api/chat with SSE opt-in (`?stream=1` + `Accept: text/event-stream`)
// and incrementally surfaces the server's progress frames:
//
//   ack             → server accepted the request (arrives in <1s)
//   round           → a new model round-trip started (the live text buffer
//                     resets on the NEXT delta — only the last text-bearing
//                     round becomes the final reply, matching the server)
//   assistant_delta → streamed text chunk for the live assistant bubble
//   tool_start      → a tool call began (name + display label)
//   tool_result     → a tool call finished; carries the same ParsedAction the
//                     final payload will contain, so cards render identically
//   final           → the COMPLETE buffered-path JSON body; the promise
//                     resolves with it so the caller's onSuccess is unchanged
//   error           → same status/body the buffered path returns on failure
//
// Graceful degradation, both directions:
//  - Old server (no SSE support): the response comes back as plain JSON — we
//    detect the content type and resolve with it, exactly like the old
//    buffered mutation did (including idempotent replays, which are always
//    JSON).
//  - Broken stream mid-flight: the promise rejects with a "network"-shaped
//    error message so the existing failed/retry affordance in chat.tsx fires.
import { BROWSER_TIMEZONE } from "@/lib/queryClient";

// Same build-time placeholder trick as lib/queryClient.ts — the iOS Capacitor
// build rewrites the literal to the real API origin; web builds get "".
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export interface ToolStartFrame {
  tool: string;
  label?: string;
}

export interface ToolResultFrame {
  tool: string;
  ok: boolean;
  error?: string;
  action?: any;
  operation?: any;
}

export interface ChatStreamCallbacks {
  /** A new model round started — reset the live text on the next delta. */
  onRound?: () => void;
  onAssistantDelta?: (text: string) => void;
  onToolStart?: (frame: ToolStartFrame) => void;
  onToolResult?: (frame: ToolResultFrame) => void;
}

// Hard ceiling just under the platform's 300s maxDuration (vercel.json,
// api/ai.js). The old buffered path aborted at 170s because nothing flowed
// until completion; with SSE the heartbeat proves liveness, so the hard cap
// only guards against a truly wedged stream.
const STREAM_HARD_TIMEOUT_MS = 290_000;
// The server writes a `: keepalive` comment every 15s even while a slow tool
// runs. Three missed heartbeats ⇒ the pipe is dead — abort and let the
// caller's failed/retry affordance take over.
const STREAM_IDLE_TIMEOUT_MS = 50_000;

/** Parse an error body into the same "STATUS: message" Error shape apiRequest throws. */
function toRequestError(status: number, rawBody: string): Error {
  let friendly = rawBody || "Request failed";
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object") {
      const e = (parsed as any).error;
      if (typeof e === "string") friendly = e;
      else if (e && typeof e === "object" && typeof e.message === "string") friendly = e.message;
      else if (typeof (parsed as any).message === "string") friendly = (parsed as any).message;
    }
  } catch {
    // Not JSON — keep raw text
  }
  return new Error(`${status}: ${friendly}`);
}

/**
 * Send a chat message over the streaming endpoint.
 * Resolves with the final response body (identical shape to the buffered
 * POST /api/chat JSON), rejecting on transport/stream/server errors.
 */
export async function streamChat(body: unknown, callbacks: ChatStreamCallbacks = {}): Promise<any> {
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), STREAM_HARD_TIMEOUT_MS);
  let idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  const kickIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    const res = await fetch(`${API_BASE}/api/chat?stream=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Timezone": BROWSER_TIMEZONE,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Pre-stream validation errors (400/409/429/…) are always plain JSON.
      throw toRequestError(res.status, await res.text());
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      // Old server build (no SSE support) or an idempotent replay — both are
      // buffered JSON. Behave exactly like the legacy mutation.
      return await res.json();
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let final: any = null;
    let streamError: { status?: number; error?: string } | null = null;

    const handleFrame = (rawFrame: string) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of rawFrame.split("\n")) {
        if (line.startsWith(":")) continue; // keepalive comment
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) return;
      let data: any;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        return; // malformed frame — skip, the final frame is authoritative
      }
      switch (event) {
        case "round":
          callbacks.onRound?.();
          break;
        case "assistant_delta":
          if (typeof data?.text === "string") callbacks.onAssistantDelta?.(data.text);
          break;
        case "tool_start":
          callbacks.onToolStart?.({ tool: String(data?.tool || ""), label: data?.label });
          break;
        case "tool_result":
          callbacks.onToolResult?.({
            tool: String(data?.tool || ""),
            ok: !!data?.ok,
            error: data?.error,
            action: data?.action,
            operation: data?.operation,
          });
          break;
        case "final":
          final = data;
          break;
        case "error":
          streamError = { status: data?.status, error: data?.error };
          break;
        // "ack" and unknown frames are ignored — forward compatible.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      kickIdle();
      buffered += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffered.indexOf("\n\n")) !== -1) {
        const rawFrame = buffered.slice(0, sep);
        buffered = buffered.slice(sep + 2);
        if (rawFrame.trim()) handleFrame(rawFrame);
      }
      if (final !== null || streamError !== null) break;
    }

    if (streamError !== null) {
      const se = streamError as { status?: number; error?: string };
      throw new Error(`${se.status || 500}: ${se.error || "Failed to process message"}`);
    }
    if (final === null) {
      // The socket closed before a `final`/`error` frame — the server may
      // still be executing tool calls. Match the buffered path's dropped-
      // connection wording triggers ("network") so onError is honest about
      // partially-applied changes.
      throw new Error("Network error: the response stream ended before completion.");
    }
    return final;
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("Request timed out. Please try again.");
    throw err;
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
  }
}
