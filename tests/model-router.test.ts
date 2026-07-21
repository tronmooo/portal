import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  providerAvailable,
  selectModel,
  anthropicSpec,
  callModel,
} from "../server/model-router";

// Snapshot + restore the env keys the router reads so tests don't leak state.
const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "AI_ROUTER_DISABLE",
  "OPENAI_MODEL",
  "OPENAI_MODEL_FAST",
  "GEMINI_MODEL",
  "GEMINI_MODEL_FAST",
];
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

describe("providerAvailable", () => {
  it("keys off env presence", () => {
    expect(providerAvailable("anthropic")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.GEMINI_API_KEY = "x";
    expect(providerAvailable("anthropic")).toBe(true);
    expect(providerAvailable("openai")).toBe(true);
    expect(providerAvailable("gemini")).toBe(true);
  });

  it("AI_ROUTER_DISABLE forces Claude-only", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.GEMINI_API_KEY = "x";
    process.env.AI_ROUTER_DISABLE = "1";
    expect(providerAvailable("anthropic")).toBe(true);
    expect(providerAvailable("openai")).toBe(false);
    expect(providerAvailable("gemini")).toBe(false);
  });
});

describe("selectModel", () => {
  it("falls back to Claude when only Anthropic is configured", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    expect(selectModel("fast").provider).toBe("anthropic");
    expect(selectModel("reasoning").provider).toBe("anthropic");
    // reasoning vs fast pick different Claude models
    expect(selectModel("reasoning").model).not.toBe(selectModel("fast").model);
  });

  it("prefers Gemini for fast/extract when available", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.GEMINI_API_KEY = "x";
    expect(selectModel("fast").provider).toBe("gemini");
    expect(selectModel("extract").provider).toBe("gemini");
  });

  it("prefers Claude for reasoning even when all providers available", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.GEMINI_API_KEY = "x";
    expect(selectModel("reasoning").provider).toBe("anthropic");
  });

  it("routes fast to OpenAI when Gemini absent but OpenAI present", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    expect(selectModel("fast").provider).toBe("openai");
  });

  it("honours model-id env overrides", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.OPENAI_MODEL_FAST = "gpt-custom-mini";
    expect(selectModel("fast").model).toBe("gpt-custom-mini");
  });

  it("AI_ROUTER_DISABLE keeps everything on Claude", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.GEMINI_API_KEY = "x";
    process.env.AI_ROUTER_DISABLE = "1";
    expect(selectModel("fast").provider).toBe("anthropic");
  });

  it("throws only when no provider is configured", () => {
    expect(() => selectModel("fast")).toThrow(/No AI provider/);
  });
});

describe("callModel — OpenAI adapter", () => {
  it("builds a chat-completions request and parses the reply", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: " hi from gpt " } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await callModel({
      spec: { provider: "openai", model: "gpt-4o-mini", label: "openai:gpt-4o-mini" },
      system: "sys",
      user: "usr",
      maxTokens: 50,
    });

    expect(text).toBe("hi from gpt");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("api.openai.com/v1/chat/completions");
    expect((init as any).headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse((init as any).body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("throws on a non-OK response", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    await expect(
      callModel({
        spec: { provider: "openai", model: "gpt-4o-mini", label: "l" },
        system: "s",
        user: "u",
        maxTokens: 10,
      }),
    ).rejects.toThrow(/OpenAI 429/);
  });
});

describe("callModel — Gemini adapter", () => {
  it("builds a generateContent request and parses the reply", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi from " }, { text: "gemini" }] } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await callModel({
      spec: { provider: "gemini", model: "gemini-1.5-flash", label: "gemini:gemini-1.5-flash" },
      system: "sys",
      user: "usr",
      maxTokens: 50,
    });

    expect(text).toBe("hi from gemini");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("gemini-1.5-flash:generateContent");
    expect((init as any).headers["x-goog-api-key"]).toBe("AIza-test");
    const body = JSON.parse((init as any).body);
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents[0].parts[0].text).toBe("usr");
  });
});

describe("callModel — Anthropic adapter", () => {
  it("uses the injected SDK client and extracts the text block", async () => {
    const client: any = {
      messages: {
        create: vi.fn(async () => ({ content: [{ type: "text", text: " claude says hi " }] })),
      },
    };
    const text = await callModel({
      spec: anthropicSpec("claude-haiku-4-5-20251001"),
      system: "sys",
      user: "usr",
      maxTokens: 50,
      anthropicClient: client,
    });
    expect(text).toBe("claude says hi");
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it("throws if no client is injected", async () => {
    await expect(
      callModel({ spec: anthropicSpec("claude-haiku-4-5-20251001"), system: "s", user: "u", maxTokens: 10 }),
    ).rejects.toThrow(/anthropicClient not provided/);
  });
});
