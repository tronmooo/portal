import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  needsAgent,
  frontDoorEnabled,
  shouldUseFrontDoor,
  runFrontDoorReply,
  runFrontDoorDiag,
} from "../server/chat-frontdoor";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_ROUTER_ENABLE", "AI_ROUTER_DISABLE", "AI_CHAT_FRONTDOOR", "AI_FRONTDOOR_TIER"];

// Enable the (opt-in) router + front door for the behavioural tests below.
// Production keeps them OFF by default; these flags exercise the on path.
function enableRouting() {
  process.env.AI_ROUTER_ENABLE = "1";
  process.env.AI_CHAT_FRONTDOOR = "1";
}
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
    // Natural first-person logging — the core use case that regressed. These
    // MUST reach the agent so they actually get logged, not chatted about.
    "I ate a chicken sandwich and ran 2 miles",
    "had a coffee this morning",
    "weighed 180 this morning",
    "drank a protein shake after my workout",
    "went for a 3 mile run",
    "took my meds",
    "slept 7 hours last night",
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
  // Genuinely self-contained: no pronoun, no meal/activity/data noun, no verb
  // that could imply a log. The classifier is intentionally aggressive, so the
  // eligible set is deliberately narrow.
  const convoMessages = [
    "explain how compound interest works",
    "how does dollar cost averaging work?",
    "write a short motivational quote about consistency",
    "what is a Roth IRA",
    "describe the difference between stocks and bonds",
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
  it("is OFF by default even with OpenAI/Gemini keys set (root-cause fix)", () => {
    // The key regression guard: keys alone must NOT enable the front door.
    // Production keeps the chat 100% on the Claude agent unless explicitly told.
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.GEMINI_API_KEY = "AIza-x";
    expect(frontDoorEnabled()).toBe(false);
    expect(shouldUseFrontDoor("explain compound interest")).toBe(false);
  });

  it("requires BOTH the front-door opt-in and an enabled provider", () => {
    process.env.OPENAI_API_KEY = "x";
    // front door opt-in alone, but router not enabled → still off
    process.env.AI_CHAT_FRONTDOOR = "1";
    expect(frontDoorEnabled()).toBe(false);
    // router enabled too → on
    process.env.AI_ROUTER_ENABLE = "1";
    expect(frontDoorEnabled()).toBe(true);
    expect(shouldUseFrontDoor("explain compound interest")).toBe(true);
  });

  it("never front-doors a data/mutation/logging message even when fully enabled", () => {
    enableRouting();
    process.env.OPENAI_API_KEY = "x";
    expect(shouldUseFrontDoor("log $12 lunch")).toBe(false);
    expect(shouldUseFrontDoor("show my tasks")).toBe(false);
    expect(shouldUseFrontDoor("I ate a chicken sandwich and ran 2 miles")).toBe(false);
    expect(shouldUseFrontDoor("had a coffee this morning")).toBe(false);
  });

  it("AI_ROUTER_DISABLE keeps the front door off", () => {
    enableRouting();
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.AI_ROUTER_DISABLE = "1";
    expect(frontDoorEnabled()).toBe(false);
  });
});

describe("runFrontDoorReply", () => {
  beforeEach(() => { process.env.AI_ROUTER_ENABLE = "1"; });

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

describe("runFrontDoorDiag — failover across providers", () => {
  beforeEach(() => { process.env.AI_ROUTER_ENABLE = "1"; });

  it("fails over from a bad Gemini key to OpenAI", async () => {
    // Reproduces the real bug: an invalid Gemini key must not disable the front
    // door — OpenAI should answer and the diag should record the Gemini failure.
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GEMINI_API_KEY = "AQ.not-a-real-gemini-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("generativelanguage")) {
        return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "openai to the rescue" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const diag = await runFrontDoorDiag({ userMessage: "explain compound interest" });
    expect(diag.ok).toBe(true);
    expect(diag.modelLabel).toContain("openai:");
    expect(diag.reply).toBe("openai to the rescue");
    // Gemini was tried first and recorded with its error, then OpenAI succeeded.
    expect(diag.attempts[0].model).toContain("gemini:");
    expect(diag.attempts[0].error).toBeTruthy();
    expect(diag.attempts[1].model).toContain("openai:");
    expect(diag.attempts[1].error).toBeUndefined();
  });

  it("reports ok:false with all errors when every provider fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GEMINI_API_KEY = "AIza-bad";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })) as any);
    const diag = await runFrontDoorDiag({ userMessage: "explain compound interest" });
    expect(diag.ok).toBe(false);
    expect(diag.attempts.length).toBeGreaterThanOrEqual(2);
    expect(diag.attempts.every(a => a.error)).toBe(true);
  });
});
