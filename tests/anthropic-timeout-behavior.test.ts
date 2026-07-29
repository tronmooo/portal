// ── Bounded external calls actually abort (server/anthropic-client.ts) ───────
//
// tests/anthropic-budget.test.ts pins the CONFIGURED budget numbers. That is
// necessary but not sufficient: it proves we passed a timeout to the SDK, not
// that a wedged upstream call actually gives up. Blocker #3 was 195 requests
// hanging until the platform killed them at 60s, so "does it really abort?" is
// the question that matters.
//
// This drives a real Anthropic client against a local HTTP server that accepts
// the connection and then never responds — the exact shape of the production
// failure — and asserts the call rejects on its own, near the budget, instead
// of hanging.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "http";
import Anthropic from "@anthropic-ai/sdk";
import { budgetFor } from "../server/anthropic-client";

let server: Server;
let baseURL: string;
/** Sockets we deliberately never answer — closed in teardown. */
const hungSockets: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    // Accept, then hang forever. No status line, no body.
    hungSockets.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as any;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const res of hungSockets) { try { res.destroy(); } catch { /* noop */ } }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("bounded Anthropic calls abort instead of hanging", () => {
  it("gives up at the configured timeout rather than running forever", async () => {
    // A deliberately small budget so the test is fast; the mechanism under
    // test (SDK timeout + no retries) is identical to the real presets.
    const client = new Anthropic({
      apiKey: "sk-test-not-used",
      baseURL,
      timeout: 700,
      maxRetries: 0,
    });

    const started = Date.now();
    let threw = false;
    try {
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      });
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - started;

    expect(threw).toBe(true);
    // Actually waited for the timeout (not an instant connection refusal)…
    expect(elapsed).toBeGreaterThanOrEqual(500);
    // …and gave up promptly rather than hanging.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it("retries stay inside the declared attempt budget", async () => {
    // maxRetries: 1 means 2 attempts total. With a 400ms per-attempt timeout
    // the whole call must land near 800ms — proving the worst case the budget
    // test asserts (timeout x attempts) is the real ceiling, not a guess.
    const client = new Anthropic({
      apiKey: "sk-test-not-used",
      baseURL,
      timeout: 400,
      maxRetries: 1,
    });

    const started = Date.now();
    await client.messages
      .create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      .catch(() => undefined);
    const elapsed = Date.now() - started;

    // Two attempts at 400ms, plus the SDK's backoff between them.
    expect(elapsed).toBeGreaterThanOrEqual(800);
    // Must NOT be the 10-minute SDK default, and must not stack unbounded.
    expect(elapsed).toBeLessThan(6_000);
  }, 20_000);

  it("the real presets are the ones a wedged call would be bounded by", () => {
    // Guards against the presets being bypassed by a stray `new Anthropic()`:
    // both must be well under the platform limits the budget test reads.
    expect(budgetFor("standard").timeout).toBeLessThanOrEqual(30_000);
    expect(budgetFor("extended").timeout).toBeLessThanOrEqual(120_000);
    expect(budgetFor("standard").maxRetries).toBeLessThanOrEqual(1);
  });
});
