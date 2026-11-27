// "Remember that …" stores a fact under its subject, so two different facts
// about one thing never overwrite each other (chat-variations check,
// production, 2026-11-27: the key was the first three words).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { memoryKeyFor } from "../shared/memory-key";

describe("the key of a remembered fact", () => {
  it("is the subject of the statement", () => {
    expect(memoryKeyFor("my library card number is 20418")).toBe("my_library_card_number");
    expect(memoryKeyFor("my locker combination is 14-32-8")).toBe("my_locker_combination");
    expect(memoryKeyFor("the garage code = 4471")).toBe("the_garage_code");
    expect(memoryKeyFor("Mom's birthday is March 3")).toBe("moms_birthday");
    expect(memoryKeyFor("wifi password: Lighthouse-5G")).toBe("wifi_password");
  });

  it("two facts about one thing are two memories (they used to share the first three words)", () => {
    const number = memoryKeyFor("my library card number is 20418");
    const pin = memoryKeyFor("my library card PIN is 7731");
    expect(number).not.toBe(pin);
    expect("my library card number is 20418".split(" ").slice(0, 3).join("_")).toBe("my library card PIN is 7731".split(" ").slice(0, 3).join("_")); // the old key: identical
  });

  it("the same subject again is the same memory (it updates)", () => {
    expect(memoryKeyFor("my library card number is 99999")).toBe(memoryKeyFor("My  Library card number   is 20418"));
  });

  it("a statement with no 'is' is keyed by what it says; nothing is ever keyless", () => {
    expect(memoryKeyFor("Sam prefers window seats on long flights home")).toBe("sam_prefers_window_seats_on_long");
    expect(memoryKeyFor("   ")).toBe("note");
    expect(memoryKeyFor("is it?")).toBe("is_it");
    expect(memoryKeyFor("x".repeat(300)).length).toBeLessThanOrEqual(60);
  });

  it("the chat's remember fast path uses it", () => {
    const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
    expect(src).toMatch(/const key = memoryKeyFor\(value\);/);
    expect(src).not.toMatch(/value\.split\(\/\\s\+\/\)\.slice\(0, 3\)\.join\("_"\)/);
  });
});
