// A bare greeting or thank-you is answered without the model; anything with
// substance is not (chat timing, 2026-11-25: "hello" waited 2.3 s on the model).
import { describe, expect, it } from "vitest";
import { pleasantryReply } from "../shared/chat-pleasantry";

describe("pleasantryReply", () => {
  it("answers a line that is only a greeting", () => {
    for (const m of ["hello", "Hi!", "hey there", "Good morning", "HELLO 👋", "  hi.  "]) {
      expect(pleasantryReply(m), m).toMatch(/^Hi!/);
    }
  });
  it("answers a line that is only thanks", () => {
    for (const m of ["thanks!", "Thank you", "thank you so much", "thx", "Thanks a lot 🙏"]) {
      expect(pleasantryReply(m), m).toBe("You're welcome!");
    }
  });
  it("leaves anything with substance to the chat", () => {
    for (const m of [
      "hi, add a task to call mom", "thanks, now delete it", "hello world report due friday", "thanks for nothing",
      "hi mom's birthday is March 3", "ok", "yes", "no", "no thanks", "", "hey what's my net worth",
      "good morning, weight 182", "thank you note for grandma",
    ]) expect(pleasantryReply(m), m).toBeNull();
  });
});

// ── The route ships a rule-answered reply at once ──────────────────────────
// Chat timing probe, 2026-11-25 (production): "hello" took 20 ms in the engine
// and ~1.7 s on the wire, because an unrouted turn was held up to 2 s for the
// capture classifier, whose only contribution is a clarifying question.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll } from "vitest";
import { isDirectChatTurn } from "../shared/chat-pleasantry";
import { startHarness, type Harness } from "./helpers/route-harness";

describe("a direct chat turn", () => {
  it("is recognised by its stamp, and nothing else is", () => {
    expect(isDirectChatTurn({ reply: "Hi!", meta: { direct: true } })).toBe(true);
    for (const r of [null, undefined, {}, { meta: {} }, { meta: { direct: "yes" } }, { meta: { timings: {} } }]) {
      expect(isDirectChatTurn(r)).toBe(false);
    }
  });

  it("is not held for the classifier in the chat route", () => {
    const src = readFileSync("server/routes.ts", "utf8");
    const wait = src.match(/const classification = ([^\n]+)\n\s*\? settledClassification/);
    expect(wait, "the classifier wait is still where this test reads it").toBeTruthy();
    expect(wait![1]).toMatch(/\bdirect\b/);
    expect(src).toMatch(/const routed = projections\.length > 0\s*\|\| direct/);
  });

  describe("POST /api/chat", () => {
    let h: Harness;
    beforeAll(async () => { h = await startHarness(); });
    afterAll(async () => { await h.close(); });

    it("answers a greeting by rule, stamped direct, well inside the old 2 s hold", async () => {
      const t0 = Date.now();
      const r = await h.api("POST", "/api/chat", { message: "hello" });
      const ms = Date.now() - t0;
      expect(r.status).toBe(200);
      expect(String(r.data?.reply)).toMatch(/^Hi!/);
      expect(r.data?.meta?.direct).toBe(true);
      expect(Array.isArray(r.data?.actions) ? r.data.actions : []).toHaveLength(0);
      expect(ms).toBeLessThan(1500);
    });
  });
});
