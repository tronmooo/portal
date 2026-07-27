// ── System-prompt cache-split guard ──────────────────────────────────────────
// The chat loop marks the STATIC system block with cache_control so the
// ~60K-token tools+instructions prefix is reused across rounds and turns.
// That only works if the static block is byte-stable: no data snapshot, no
// clock. These tests pin the invariants that keep the cache hitting:
//   1. staticText is identical across calls with different contexts.
//   2. staticText contains no volatile content (no "Current date/time").
//   3. dynamicText carries the context and the date lines.
//   4. The combined prompt still contains every load-bearing section header,
//      so no instruction was lost in the split.
// Key-free, deterministic, no API calls.
import { describe, it, expect } from "vitest";
import { buildSystemPromptParts, buildSystemPrompt } from "../server/ai-engine";

const CTX_A = "Profile Name Index (2, complete list — every profile owned by user):\n- Alice (self, id:aaaaaaaa)\n- Rex (pet, id:bbbbbbbb)";
const CTX_B = "Profile Name Index (1, complete list — every profile owned by user):\n- Bob (self, id:cccccccc)";

describe("buildSystemPromptParts cache split", () => {
  it("static block is byte-identical across different contexts", () => {
    const a = buildSystemPromptParts(CTX_A, "self-a", "America/New_York");
    const b = buildSystemPromptParts(CTX_B, "self-a", "America/New_York");
    expect(a.staticText).toBe(b.staticText);
  });

  it("static block contains no volatile content", () => {
    const { staticText } = buildSystemPromptParts(CTX_A, "self-a", "America/New_York");
    expect(staticText).not.toContain("Current date/time:");
    expect(staticText).not.toContain(CTX_A);
    // The data snapshot must not leak in — only the pointer to the final block.
    expect(staticText).toContain('FINAL system block below, under "EXISTING DATA"');
  });

  it("dynamic block carries the context and the clock", () => {
    const { dynamicText } = buildSystemPromptParts(CTX_A, "self-a", "America/New_York");
    expect(dynamicText).toContain("EXISTING DATA");
    expect(dynamicText).toContain(CTX_A);
    expect(dynamicText).toContain("Current date/time:");
    expect(dynamicText).toContain("Reference: ");
  });

  it("no load-bearing section was lost in the split", () => {
    const combined = buildSystemPrompt(CTX_A, "self-a", "America/New_York");
    for (const section of [
      "*** RESPONSE STYLE — BE CONCISE ***",
      "*** PROFILE EXISTENCE — READ THE NAME INDEX FIRST ***",
      "*** TOP-PRIORITY ROUTING RULE — LIABILITIES ***",
      "DIAGNOSTICS & INSIGHTS MODE",
      "CRITICAL DATE RULES",
      "## ARTIFACT SYSTEM",
      "EXISTING DATA",
      "Current date/time:",
    ]) {
      expect(combined).toContain(section);
    }
    expect(combined).toContain(CTX_A);
  });

  it("self profile id still reaches the artifact rules (static, per-user stable)", () => {
    const { staticText } = buildSystemPromptParts(CTX_A, "self-123", "America/New_York");
    expect(staticText).toContain('"profile_id": "self-123"');
  });
});
