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
