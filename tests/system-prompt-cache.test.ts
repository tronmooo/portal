// Pins the two-block system prompt that makes prompt caching actually work
// across chat turns (latency, 2026-09-01).
//
// The instructions are ~130 KB. As one block with the data snapshot near the
// top and a minute-precision clock at the bottom, the cached prefix broke on
// every message, so every turn re-processed the whole prompt. The STABLE
// block must therefore be byte-identical from one call to the next for the
// same user, and everything that changes per turn must live in the DYNAMIC
// block.
import { describe, it, expect, vi } from "vitest";

vi.mock("../server/storage", () => ({
  storage: new Proxy({ _timezone: "America/Los_Angeles" } as Record<string, any>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => [];
    },
  }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

describe("buildSystemPromptBlocks", () => {
  it("keeps the stable block identical across turns and moves the clock + data into the dynamic block", async () => {
    const { buildSystemPromptBlocks } = await import("../server/ai-engine");
    const a = buildSystemPromptBlocks("Trackers (1): Running (fitness, owner:Me, 3 entries)", "p-self", "America/Los_Angeles");
    await new Promise((r) => setTimeout(r, 5));
    const b = buildSystemPromptBlocks("Trackers (2): Running; Sleep", "p-self", "America/Los_Angeles");

    // Same user → same cached prefix, regardless of data or time.
    expect(a.stable).toBe(b.stable);
    expect(a.stable.length).toBeGreaterThan(50_000);

    // Nothing per-turn leaks into the stable block.
    expect(a.stable).not.toContain("Current date/time:");
    expect(a.stable).not.toContain("Trackers (1)");
    expect(a.stable).not.toMatch(/Today's date is \d{2}\/\d{2}\/\d{4}/);

    // The dynamic block carries exactly that.
    expect(a.dynamic).toContain("Current date/time:");
    expect(a.dynamic).toMatch(/Today's date is \d{2}\/\d{2}\/\d{4}/);
    expect(a.dynamic).toContain("Reference: ");
    expect(a.dynamic).toContain("EXISTING DATA");
    expect(a.dynamic).toContain("Trackers (1): Running");
    expect(b.dynamic).toContain("Sleep");
  });

  it("the instructions still tell the model where the data lives, and the self profile id stays in the stable block", async () => {
    const { buildSystemPromptBlocks } = await import("../server/ai-engine");
    const { stable } = buildSystemPromptBlocks("none", "p-self", "America/New_York");
    expect(stable).toContain("SECOND system block");
    expect(stable).toContain('"profile_id": "p-self"');
    expect(stable).toContain("Eastern Time");
  });
});
