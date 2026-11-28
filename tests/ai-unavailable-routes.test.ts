// With no AI provider configured, an AI route answers 503 AI_UNAVAILABLE, not
// 500 (integrity run on the isolated stack, 2026-11-28: every dashboard visit
// logged a 500 from POST /api/ai/summary). Driven through the real routes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { startHarness, type Harness } from "./helpers/route-harness";
import { isAiUnavailableError } from "../server/ai-unavailable";

let h: Harness;
const saved = process.env.ANTHROPIC_API_KEY;
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  h = await startHarness({ profiles: [{ id: "self", type: "self", name: "Me", fields: {}, tags: [], documents: [] }] as any });
});
afterAll(async () => { await h.close(); if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });

describe("AI routes with no AI provider", () => {
  it("the dashboard briefing answers 503 AI_UNAVAILABLE, marked", async () => {
    const r = await h.api("POST", "/api/ai/summary", { tasks: [], events: [], bills: [] });
    expect(r.status, JSON.stringify(r.data)).toBe(503);
    expect(r.data?.code).toBe("AI_UNAVAILABLE");
    expect(r.headers?.get?.("x-ai-unavailable") ?? (r as any).headers?.["x-ai-unavailable"]).toBe("1");
  });

  it("recognises only the missing-key error, not every failure", () => {
    expect(isAiUnavailableError(new Error("ANTHROPIC_API_KEY environment variable is not set"))).toBe(true);
    expect(isAiUnavailableError(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isAiUnavailableError(undefined)).toBe(false);
  });

  it("every route error handler that answers 500 first asks whether the AI is simply absent", () => {
    for (const f of ["server/routes.ts", "server/workspace-routes.ts", "server/record-details-routes.ts"]) {
      const s = fs.readFileSync(`${process.cwd()}/${f}`, "utf8");
      const blocks = [...s.matchAll(/\} catch \((\w+)(?:: any)?\) \{\n([\s\S]{0,700}?)\n    \}/g)];
      const bare = blocks.filter((b) => b[2].includes("res.status(500)") && !b[2].includes("answeredAiUnavailable(") && !b[2].includes("AI_UNAVAILABLE"));
      expect(bare.map((b) => b[2].split("\n")[0]), f).toEqual([]);
    }
  });
});
