// Creating an asset in chat: no tags nobody asked for, no machine tokens shown.
//
// 2026-11-19 (owner report): "I bought Sony WH-1000XM5 headphones for $599"
// created the asset with tags added on the model's own initiative, and the
// subtype was shown as the raw token `high_value_item`.

import { describe, it, expect, vi } from "vitest";
import { receiptDisplayValue } from "../shared/field-receipt";

vi.mock("../server/storage", () => ({
  storage: new Proxy({}, { get: (_t, k: string) => (k === "then" ? undefined : async () => []) }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

describe("tags on a chat-created record are the user's, not the model's", () => {
  it("drops tags when the user's message never asks for one", async () => {
    const { tagsTheUserAskedFor } = await import("../server/ai-engine");
    expect(tagsTheUserAskedFor(["electronics", "audio"], "I bought Sony WH-1000XM5 headphones for $599")).toEqual([]);
  });
  it("keeps them when the user asks to tag it", async () => {
    const { tagsTheUserAskedFor } = await import("../server/ai-engine");
    expect(tagsTheUserAskedFor(["audio"], "Add my Sony headphones and tag them audio")).toEqual(["audio"]);
    expect(tagsTheUserAskedFor(["audio"], "Add my Sony headphones #audio")).toEqual(["audio"]);
    expect(tagsTheUserAskedFor(["work"], "add a laptop, label it work")).toEqual(["work"]);
  });
  it("a caller with no user message keeps its own tags; junk is dropped", async () => {
    const { tagsTheUserAskedFor } = await import("../server/ai-engine");
    expect(tagsTheUserAskedFor(["imported"], undefined)).toEqual(["imported"]);
    expect(tagsTheUserAskedFor(["", 3, null, "ok"] as any, undefined)).toEqual(["ok"]);
    expect(tagsTheUserAskedFor(undefined, "tag it audio")).toEqual([]);
  });
});

describe("the save receipt never prints a machine token", () => {
  it("an enum key shows its human label", () => {
    expect(receiptDisplayValue("assetSubtype", "high_value_item")).toBe("High-value item");
  });
  it("any snake_case token is humanized", () => {
    expect(receiptDisplayValue("category", "auto_loan")).not.toMatch(/_/);
  });
  it("real values are untouched", () => {
    expect(receiptDisplayValue("model", "WH-1000XM5")).toBe("WH-1000XM5");
    expect(receiptDisplayValue("purchasePrice", 599)).toBe("$599");
    expect(receiptDisplayValue("color", "black")).toBe("Black");
  });
});
