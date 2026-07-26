// A past date is never "due in -29d".
//
// User report 2026-07-26, #16:
//   "AI Executive Brief says: 'Lawn care ($40) due in -29d.' Past dates should
//    say '29 days overdue,' never 'due in -29d'."
//
// The string was built inline in ExecutiveBriefing, and four other screens had
// their own copy of the same three lines. Each interpolated a raw `daysUntil`,
// which goes negative the moment a date passes. `dayLabel` had the correct
// logic all along — the bug was in the places that never called it.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { dayLabel, dueLabel } from "../shared/now-rank";

describe("relative due labels", () => {
  it("never renders a negative day count", () => {
    for (let d = -400; d <= 400; d++) {
      const label = dayLabel(d);
      expect(label, `dayLabel(${d}) = ${label}`).not.toMatch(/-\d/);
      expect(dueLabel(d), `dueLabel(${d})`).not.toMatch(/-\d/);
    }
  });

  it("says overdue for the past", () => {
    expect(dayLabel(-29)).toBe("29d overdue");
    expect(dayLabel(-1)).toBe("1d overdue");
    expect(dueLabel(-29)).toBe("29d overdue"); // not "due 29d overdue"
  });

  it("says today, tomorrow, then a count", () => {
    expect(dayLabel(0)).toBe("today");
    expect(dayLabel(1)).toBe("tomorrow");
    expect(dayLabel(5)).toBe("in 5d");
    expect(dueLabel(0)).toBe("due today");
    expect(dueLabel(5)).toBe("due in 5d");
  });

  it("stays quiet for an unknown date rather than inventing one", () => {
    for (const bad of [null, undefined, NaN, Infinity]) {
      expect(dayLabel(bad as any), String(bad)).toBe("");
      expect(dueLabel(bad as any), String(bad)).toBe("");
    }
  });

  it("truncates a fractional day instead of printing it", () => {
    expect(dayLabel(2.7)).toBe("in 2d");
    expect(dayLabel(-2.7)).toBe("2d overdue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift guard: the reported screens must keep using the shared formatter.
// ─────────────────────────────────────────────────────────────────────────────
const repo = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("the screens that had their own copy now share one", () => {
  const FILES = [
    "client/src/components/dashboard/ExecutiveBriefing.tsx",
    "client/src/pages/dashboard.tsx",
    "client/src/components/finance/MoneyOverview.tsx",
  ];

  it.each(FILES)("%s imports the shared formatter", (f) => {
    expect(repo(f)).toMatch(/from "@shared\/now-rank"/);
  });

  it.each(FILES)("%s no longer interpolates a raw daysUntil into 'in Nd'", (f) => {
    // The exact shape that produced "-29d": `in ${x.daysUntil}d`.
    const src = repo(f).split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    expect(src, `${f} still builds an unguarded relative label`)
      .not.toMatch(/`in \$\{[A-Za-z_.]*daysUntil\}d`/);
  });
});
