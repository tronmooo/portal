import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  needsAgent,
  frontDoorEnabled,
  shouldUseFrontDoor,
  runFrontDoorReply,
} from "../server/chat-frontdoor";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_ROUTER_DISABLE", "AI_CHAT_FRONTDOOR", "AI_FRONTDOOR_TIER"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("needsAgent — CRUD / data messages stay on the tool-agent", () => {
  const agentMessages = [
    "log $12 lunch",
    "add a reminder to call the dentist tomorrow",
    "delete my gym membership",
    "update the rent obligation to $2200",
    "show me my expenses this month",
    "what's my net worth?",
    "how much did I spend on groceries",
    "mark the electric bill as paid",
    "list my upcoming tasks",
    "schedule a meeting friday at 3pm",
    "track my weight at 180",
  ];
  for (const m of agentMessages) {
    it(`routes to agent: "${m}"`, () => {
      expect(needsAgent(m)).toBe(true);
    });
  }

  it("treats empty input as agent-bound", () => {
    expect(needsAgent("")).toBe(true);
    expect(needsAgent("   ")).toBe(true);
  });
});

describe("needsAgent — self-contained conversational messages are eligible", () => {
  const convoMessages = [
    "explain how compound interest works",
    "give me tips for staying focused while working from home",
    "what questions should I ask a financial advisor?",
    "brainstorm healthy dinner ideas for the week",
    "how does dollar cost averaging work?",
    "write a short motivational quote about consistency",
  ];
  for (const m of convoMessages) {
    it(`eligible for front door: "${m}"`, () => {
      expect(needsAgent(m)).toBe(false);
    });
  }
});

describe("needsAgent — conservative bias: borderline messages stay on the agent", () => {
  // The classifier deliberately errs toward the Claude tool-agent. These read as
  // advisory but contain a mutation verb ("pay") or a personal-data reference
  // ("my"), so they route to the agent (which still answers them fine) rather
  // than risk sending a real data operation to a tool-less model.
  const borderline = [
    "what's a good strategy to pay down credit card debt?",
    "draft a polite email asking my landlord for a repair",
  ];
  for (const m of borderline) {
    it(`stays on agent (conservative): "${m}"`, () => {
      expect(needsAgent(m)).toBe(true);
    });
  }
});

describe("frontDoorEnabled / shouldUseFrontDoor gating", () => {
  it("is off when only Anthropic is configured", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    expect(frontDoorEnabled()).toBe(false);
    expect(shouldUseFrontDoor("explain compound interest")).toBe(false);
  });

  it("turns on when OpenAI is configured", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    expect(frontDoorEnabled()).toBe(true);
    expect(shouldUseFrontDoor("explain compound interest")).toBe(true);
  });

  it("turns on when Gemini is configured", () => {
    process.env.GEMINI_API_KEY = "AIza-x";
    expect(frontDoorEnabled()).toBe(true);
  });

  it("kill switch AI_CHAT_FRONTDOOR=0 forces it off", () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.AI_CHAT_FRONTDOOR = "0";
    expect(frontDoorEnabled()).toBe(false);
  });

  it("never front-doors a data/mutation message even when enabled", () => {
    process.env.OPENAI_API_KEY = "x";
    expect(shouldUseFrontDoor("log $12 lunch")).toBe(false);
    expect(shouldUseFrontDoor("show my tasks")).toBe(false);
  });

  it("AI_ROUTER_DISABLE keeps the front door off (only Claude left, so no second path)", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.AI_ROUTER_DISABLE = "1";
    expect(frontDoorEnabled()).toBe(false);
  });
});

describe("runFrontDoorReply", () => {
  it("returns a reply from the routed provider", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Pay the highest-APR card first." } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await runFrontDoorReply({ userMessage: "how do I pay down debt?" });
    expect(res).not.toBeNull();
    expect(res!.reply).toBe("Pay the highest-APR card first.");
    expect(res!.modelLabel).toContain("openai:");
    // history should be folded into the user turn
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.messages[1].content).toContain("how do I pay down debt?");
  });

  it("folds recent history into the prompt", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runFrontDoorReply({
      userMessage: "what about the second one?",
      history: [
        { role: "user", content: "compare index funds vs ETFs" },
        { role: "assistant", content: "Both are baskets of securities..." },
      ],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.messages[1].content).toContain("compare index funds vs ETFs");
    expect(body.messages[1].content).toContain("what about the second one?");
  });

  it("defaults to the fast tier — prefers Gemini for speed when available", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GEMINI_API_KEY = "AIza-test";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "quick answer" }] } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await runFrontDoorReply({ userMessage: "explain compound interest" });
    expect(res!.modelLabel).toContain("gemini:");
    expect(fetchMock.mock.calls[0][0]).toContain("generativelanguage.googleapis.com");
  });

  it("AI_FRONTDOOR_TIER=reasoning prefers Claude", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GEMINI_API_KEY = "AIza-test";
    process.env.AI_FRONTDOOR_TIER = "reasoning";
    const client: any = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "thoughtful" }] })) } };
    const res = await runFrontDoorReply({ userMessage: "explain compound interest", anthropicClient: client });
    expect(res!.modelLabel).toContain("claude:");
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it("returns null (falls through to agent) when no provider is configured", async () => {
    const res = await runFrontDoorReply({ userMessage: "hello" });
    expect(res).toBeNull();
  });

  it("returns null when the provider call fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    const res = await runFrontDoorReply({ userMessage: "hello" });
    expect(res).toBeNull();
  });
});
