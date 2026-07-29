// Duplicate dashboard entries (user QA 2026-07-27: "the same test task and
// birthday appeared in multiple dashboard locations").
//
// The birthday case was a real double-write, not a rendering artifact:
//   1. Saving profile.fields.birthday auto-generates a stored calendar event,
//      anchored at the BIRTH year (1990-04-02) with yearly recurrence.
//   2. The prompt separately instructed the model to ALSO create_event for the
//      same birthday, dated in the UPCOMING year (2026-04-02). Same-date dedup
//      never matched, so both rows survived.
//   3. The calendar timeline then generates a VIRTUAL birthday for the viewed
//      year, whose title::date fingerprint matched neither stored row.
//
// Fixed structurally: the prompt no longer asks for both, create_event refuses
// a birthday that already exists on the same recurring day, and the timeline
// fingerprints anniversaries on month-day as well as full date.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const engine = read("server/ai-engine.ts");
const storage = read("server/supabase-storage.ts");

describe("birthdays are written once", () => {
  it("the prompt no longer instructs a create_event alongside the profile field", () => {
    expect(engine).not.toMatch(/"X's birthday is Y" → ALWAYS do BOTH/);
    expect(engine).toMatch(/Do NOT also call create_event/);
  });

  it("create_event refuses a birthday already on the calendar for that day", () => {
    expect(engine).toContain("BIRTHDAY GUARD");
    expect(engine).toContain("isBirthdayEvt");
  });

  it("the guard compares the recurring day, not the anchor year", () => {
    // The auto entry sits on the birth year; a model writes the upcoming year.
    // Matching on full date is exactly what failed.
    const guard = engine.slice(engine.indexOf("BIRTHDAY GUARD"), engine.indexOf("BIRTHDAY GUARD") + 1400);
    expect(guard).toContain("slice(5, 10)");
  });
});

describe("anniversary fingerprints — the virtual/stored overlap", () => {
  // Mirror of the timeline's dedup so the rule itself is testable.
  const buildFPs = (stored: { title: string; date: string; recurrence?: string }[]) => {
    const set = new Set<string>();
    for (const e of stored) {
      const t = e.title.toLowerCase().trim();
      set.add(`${t}::${e.date}`);
      // Month-day key for YEARLY events only — see the note in the timeline.
      if (String(e.recurrence || "").toLowerCase() === "yearly") {
        const md = e.date.slice(5, 10);
        if (md) set.add(`${t}::MMDD:${md}`);
      }
    }
    return set;
  };
  const wouldAdd = (fps: Set<string>, item: { title: string; date: string }) => {
    const t = item.title.toLowerCase().trim();
    const md = item.date.slice(5, 10);
    if (fps.has(`${t}::${item.date}`)) return false;
    if (md && fps.has(`${t}::MMDD:${md}`)) return false;
    return true;
  };

  it("suppresses a virtual birthday when the stored one is anchored years earlier", () => {
    const fps = buildFPs([{ title: "🎂 Craig's Birthday", date: "1990-04-02", recurrence: "yearly" }]);
    expect(wouldAdd(fps, { title: "🎂 Craig's Birthday", date: "2026-04-02" })).toBe(false);
  });

  it("still suppresses the exact-date case it always handled", () => {
    const fps = buildFPs([{ title: "🎂 Craig's Birthday", date: "2026-04-02" }]);
    expect(wouldAdd(fps, { title: "🎂 Craig's Birthday", date: "2026-04-02" })).toBe(false);
  });

  it("does NOT suppress a different person's birthday on the same day", () => {
    const fps = buildFPs([{ title: "🎂 Craig's Birthday", date: "1990-04-02", recurrence: "yearly" }]);
    expect(wouldAdd(fps, { title: "🎂 Rex's Birthday", date: "2026-04-02" })).toBe(true);
  });

  it("does NOT suppress the same title on a different day", () => {
    const fps = buildFPs([{ title: "🎂 Craig's Birthday", date: "1990-04-02", recurrence: "yearly" }]);
    expect(wouldAdd(fps, { title: "🎂 Craig's Birthday", date: "2026-04-03" })).toBe(true);
  });

  it("leaves NON-yearly events alone — a 2027 vet visit is not a duplicate of a 2026 one", () => {
    // Scoping matters: an unscoped month-day key would wrongly hide a genuine
    // next-year appointment that happens to share a month-day.
    const fps = buildFPs([{ title: "🏥 Rex — Visit", date: "2026-04-02", recurrence: "none" }]);
    expect(wouldAdd(fps, { title: "🏥 Rex — Visit", date: "2027-04-02" })).toBe(true);
    expect(wouldAdd(fps, { title: "🏥 Rex — Visit", date: "2026-04-02" })).toBe(false);
  });
});

describe("the briefing model never lists one record twice", () => {
  it("dedups by key across every bucket", () => {
    const model = read("client/src/components/dashboard/useBriefingModel.ts");
    expect(model).toMatch(/if \(seen\.has\(item\.key\)\) return false;/);
  });
});
