// Manual vs chat: the same intent stores the same row through both doors.
// Each case is a difference the equivalence scenarios found on the preview
// (tests/integrity/scenarios/equivalence.ts, 2026-11-28), quoting both rows.
import { describe, it, expect } from "vitest";
import { chatProfileTypeKey } from "../shared/chat-profile-type-key";
import { annualLabelEvent } from "../shared/birthday-event";
import { isPlaceholderBirthYear, nextAnnualDate, dropPlaceholderBirthDates } from "../shared/placeholder-birth-year";
import { isBirthDateField } from "../shared/date-precision";
import { upsertJournalEntry } from "../server/content-service";
import { EXPENSE_CATEGORIES } from "../shared/category-canon";
import { readFileSync } from "node:fs";

describe("asset type_key: the chat files a car under the registry type the screen sends", () => {
  it("a vehicle is type_key vehicle (screen: vehicle, chat was null)", () => {
    expect(chatProfileTypeKey("vehicle", {})).toBe("vehicle");
  });
  it("a stated subtype on the registry list is used when it agrees with the type", () => {
    expect(chatProfileTypeKey("asset", { subtype: "Musical instrument" })).toBe("musical_instrument");
    expect(chatProfileTypeKey("property", { subtype: "rental property" })).toBe("rental_property");
    expect(chatProfileTypeKey("property", { subtype: "electronics" })).toBeNull();
  });
  it("an ambiguous type is not guessed", () => {
    expect(chatProfileTypeKey("property", {})).toBeNull();
    expect(chatProfileTypeKey("asset", {})).toBeNull();
  });
  it("chat create_profile passes it to storage", () => {
    const src = readFileSync("server/ai-engine.ts", "utf8");
    expect(src).toMatch(/chatProfileTypeKey\(resolvedProfileType, finalFields\)/);
    expect(src).toMatch(/type_key: chatTypeKey/);
  });
});

describe("birthday: the chat's yearly event is the Birthday form's row", () => {
  it("all day, category family (screen: all_day true / family; chat was false / personal)", () => {
    const a = annualLabelEvent("🎂 Robin's Birthday")!;
    expect(a.allDay).toBe(true);
    expect(a.category).toBe("family");
    expect(a.recurrence).toBe("yearly");
  });
  it("create_event applies them", () => {
    const src = readFileSync("server/ai-engine.ts", "utf8");
    expect(src).toMatch(/evtCategory = annual\.category/);
    expect(src).toMatch(/allDay: evtAllDay/);
  });
});

describe("a 1900 birth year is a placeholder, never a date of birth", () => {
  it("1900 and earlier are placeholders; a real year is not", () => {
    expect(isPlaceholderBirthYear(1900)).toBe(true);
    expect(isPlaceholderBirthYear(1901)).toBe(false);
    expect(isPlaceholderBirthYear(1990)).toBe(false);
  });
  it("the birthday moves to its next date", () => {
    expect(nextAnnualDate("1900-12-28", "2026-11-28")).toBe("2026-12-28");
    expect(nextAnnualDate("1900-03-04", "2026-11-28")).toBe("2027-03-04");
    expect(nextAnnualDate("1900-11-28", "2026-11-28")).toBe("2026-11-28");
    expect(nextAnnualDate("1900-02-29", "2026-11-28")).toBe("2028-02-29");
  });
  it("update_profile's fields lose a placeholder birth date and keep the rest", () => {
    const f: Record<string, unknown> = { birthday: "1900-12-28", nickname: "Rob" };
    expect(dropPlaceholderBirthDates(f, isBirthDateField)).toEqual(["birthday"]);
    expect(f).toEqual({ nickname: "Rob" });
    const real: Record<string, unknown> = { dateOfBirth: "1988-12-28" };
    expect(dropPlaceholderBirthDates(real, isBirthDateField)).toEqual([]);
    expect(real.dateOfBirth).toBe("1988-12-28");
  });
});

describe("journal mood: the same words make the same mood through both doors (J2)", () => {
  function fakeStorage() {
    const rows: any[] = [];
    return {
      rows,
      getJournalEntries: async () => rows,
      createJournalEntry: async (r: any) => { const row = { id: `j${rows.length}`, createdAt: new Date().toISOString(), ...r }; rows.push(row); return row; },
      updateJournalEntry: async (id: string, p: any) => Object.assign(rows.find((r) => r.id === id), p),
      linkProfileTo: async () => undefined,
    } as any;
  }
  const words = "Walked along the river after work and felt calm and grateful for the quiet.";
  it("the chat's unpicked guess gives way to what the text says (composer: great, chat was good)", async () => {
    const s = fakeStorage();
    const { entry } = await upsertJournalEntry(s, { content: words, entryDate: "2026-11-28", mood: "good" } as any);
    expect(entry.mood).toBe("great");
  });
  it("a mood the writer picked is kept", async () => {
    const s = fakeStorage();
    const { entry } = await upsertJournalEntry(s, { content: words, entryDate: "2026-11-28", mood: "okay", moodPicked: true } as any);
    expect(entry.mood).toBe("okay");
  });
  it("a guess stands where the text says nothing", async () => {
    const s = fakeStorage();
    const { entry } = await upsertJournalEntry(s, { content: "Went to the store.", entryDate: "2026-11-28", mood: "good" } as any);
    expect(entry.mood).toBe("good");
  });
});

describe("categories: the chat is offered the screens' lists", () => {
  const src = readFileSync("server/ai-engine.ts", "utf8");
  it("budgets and expenses list EXPENSE_CATEGORIES, which has travel (chat stored transport)", () => {
    expect(EXPENSE_CATEGORIES).toContain("travel");
    const m = src.match(/Budget category\. MUST be one of: \$\{EXPENSE_CATEGORIES\.join/g) || [];
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/MUST be one of: food, transport/);
  });
  it("income offers rental and business, as the Finance form does (chat stored other)", () => {
    const finance = readFileSync("client/src/pages/finance.tsx", "utf8");
    for (const v of ["salary", "freelance", "business", "rental", "investment", "gift", "other"]) {
      expect(finance).toContain(`value="${v}"`);
    }
    expect(src).toMatch(/enum: \["salary", "freelance", "business", "rental", "investment", "gift", "refund", "other"\]/);
  });
});
