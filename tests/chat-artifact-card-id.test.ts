// An artifact the chat makes carries its SAVED id on the action card, through
// the REAL chat loop (live, 2026-11-26: the card held only title/type/content,
// so the full-screen viewer opened an unsaved copy — no star, no view-only
// link, checklist taps not stored). Only the model and the store are fakes.
import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Robert", type: "self", fields: {} };
const db: any = { artifacts: [], script: [] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF],
    getSelfProfile: async () => SELF,
    getPreference: async () => null,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
    createArtifact: async (data: any) => {
      const row = { id: `a${db.artifacts.length + 1}`.padEnd(8, "0") + "-0000-4000-8000-000000000000", ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.artifacts.push(row);
      return row;
    },
    getArtifact: async (id: string) => db.artifacts.find((a: any) => a.id === id),
    getArtifacts: async () => db.artifacts,
  };
  const storage = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (/^(create|update|delete|log|checkin|complete|set|save)/.test(prop)) return async () => undefined;
      return async () => [];
    },
  });
  return { storage };
});

const msg = (stop_reason: string, content: any[]) => ({
  id: "m", type: "message", role: "assistant", model: "x", stop_reason, usage: { input_tokens: 1, output_tokens: 1 }, content,
});
const RESPONSES: Record<string, () => any> = {
  make: () => msg("tool_use", [
    { type: "tool_use", id: "t1", name: "create_artifact", input: { title: "Sleep & Wellness Plan", type: "markdown", content: "# Plan\n\n| Habit | Status |\n| --- | --- |\n| Run | ok |" } },
  ]),
  summary: () => msg("end_turn", [{ type: "text", text: "Made your plan." }]),
};

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (req: any) => {
        if (!req?.tools) throw new Error("side model call unavailable in this test");
        const next = db.script.shift();
        if (!next) throw new Error("model script exhausted");
        return RESPONSES[next]();
      },
      stream: () => { throw new Error("streaming not used in this test"); },
    };
  },
}));

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  db.artifacts = [];
  db.script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("chat-made artifact card", () => {
  it("names the saved row, so the viewer opens the live artifact", async () => {
    db.script = ["make", "summary"];
    const res = await processMessage("Make me a sleep and wellness plan as an artifact", [], "u1");
    expect(db.artifacts).toHaveLength(1);
    const card = (res.actions as any[]).find((a) => a.type === "create_artifact");
    expect(card, JSON.stringify(res.actions)).toBeTruthy();
    expect(card.data._entityId).toBe(db.artifacts[0].id);
    expect(card.data.title).toBe("Sleep & Wellness Plan");
  });
});
