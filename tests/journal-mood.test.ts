import { describe, it, expect } from "vitest";
import { moodScore, moodForScore, moodSeries, moodSummary } from "../shared/journal-mood";

describe("journal mood over time", () => {
  it("scores moods in MoodLevel order", () => {
    expect(moodScore("terrible")).toBe(1);
    expect(moodScore("amazing")).toBe(8);
    expect(moodScore(undefined)).toBeNull();
    expect(moodForScore(6.4)).toBe("good");
  });

  it("one point per day — the day's last entry — and no point for a day without a mood", () => {
    const pts = moodSeries([
      { id: "a", date: "2026-10-01", mood: "bad", createdAt: "2026-10-01T08:00:00Z" },
      { id: "b", date: "2026-10-01", mood: "great", createdAt: "2026-10-01T21:00:00Z" },
      { id: "c", date: "2026-10-02", mood: undefined },
      { id: "d", date: "2026-10-03", mood: "okay" },
    ]);
    expect(pts.map((p) => [p.day, p.value, p.entries])).toEqual([["2026-10-01", 7, 2], ["2026-10-03", 5, 1]]);
  });

  it("filters to a window and summarises it", () => {
    const entries = ["good", "good", "bad", "amazing"].map((m, i) => ({ date: `2026-10-0${i + 1}`, mood: m as any }));
    const pts = moodSeries(entries, "2026-10-02", null);
    expect(pts).toHaveLength(3);
    const s = moodSummary(pts);
    expect(s.days).toBe(3);
    expect(s.distribution[0]).toEqual({ mood: "amazing", days: 1, share: 33 });
    expect(s.goodShare).toBe(67);
    expect(moodSummary([]).average).toBeNull();
  });
});
