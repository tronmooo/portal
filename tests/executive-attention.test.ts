import { describe, it, expect } from "vitest";
import { selectAttentionRows, belongsInAttention, attentionBand, groupAttentionRows, attentionHeading, isExpiryItem } from "../shared/executive-attention";
import type { AttentionItem } from "../shared/attention";

const item = (o: Partial<AttentionItem> & Pick<AttentionItem, "key" | "kind">): AttentionItem => ({
  sourceKey: o.key, title: o.key, reason: "", tier: "upcoming", daysUntil: 5, score: 0, href: "/", ...o,
});

describe("Needs Attention: documents, renewals and deadlines — not bills or tasks", () => {
  it("drops bills, tasks and alerts derived from them; keeps documents, goals, health and other alerts", () => {
    const rows = selectAttentionRows({
      immediate: [
        item({ key: "bill:b1", kind: "bill", sourceKey: "obligation:b1", daysUntil: -2, tier: "immediate" }),
        item({ key: "task:t1", kind: "task", daysUntil: -1, tier: "immediate" }),
        item({ key: "alert:n1", kind: "alert", sourceKey: "obligation:b9", daysUntil: null, tier: "immediate" }),
        item({ key: "alert:n2", kind: "alert", sourceKey: "task:t9", daysUntil: null, tier: "immediate" }),
        item({ key: "alert:n3", kind: "alert", sourceKey: "profile:p1", daysUntil: 3, tier: "soon" }),
        item({ key: "goal:g1", kind: "goal", daysUntil: -4, tier: "immediate" }),
        item({ key: "doc:r0", kind: "document", daysUntil: -10, tier: "immediate" }),
      ],
      health: [
        // A dose is an obligation row too — and it belongs here.
        item({ key: "med:o1", kind: "reminder", sourceKey: "obligation:o1", daysUntil: 0, tier: "immediate" }),
        item({ key: "appt:o2", kind: "event", sourceKey: "obligation:o2", daysUntil: 6, tier: "soon" }),
      ],
      documents: [item({ key: "doc:r1", kind: "document", daysUntil: 12 })],
    });
    // Expirations and renewals (documents, and the profile renewal alert)
    // lead; then health and goals — each group soonest first.
    expect(rows.map((r) => r.key)).toEqual(["doc:r0", "alert:n3", "doc:r1", "goal:g1", "med:o1"]);
  });

  it("puts an expiration above a sooner non-expiry item (2026-10-21)", () => {
    const rows = selectAttentionRows({
      immediate: [item({ key: "goal:late", kind: "goal", daysUntil: -9, tier: "immediate" })],
      health: [item({ key: "med:now", kind: "reminder", sourceKey: "obligation:m", daysUntil: 0, tier: "immediate" })],
      documents: [item({ key: "doc:passport", kind: "document", sourceKey: "rule:p", daysUntil: 40 })],
    });
    expect(rows.map((r) => r.key)).toEqual(["doc:passport", "goal:late", "med:now"]);
    expect(rows.map((r) => attentionHeading(r))).toEqual(["later", "other", "other"]);
    expect(isExpiryItem(item({ key: "a", kind: "alert", sourceKey: "rule:x" }))).toBe(true);
    expect(isExpiryItem(item({ key: "a", kind: "alert", sourceKey: "notification:x" }))).toBe(false);
  });

  it("applies the urgency setting to documents too", () => {
    const docs = [
      item({ key: "doc:a", kind: "document", daysUntil: 0, tier: "immediate" }),
      item({ key: "doc:b", kind: "document", daysUntil: 5, tier: "soon" }),
      item({ key: "doc:c", kind: "document", daysUntil: 30, tier: "upcoming" }),
    ];
    const keys = (t: any) => selectAttentionRows({ immediate: [], health: [], documents: docs }, t).map((r) => r.key);
    expect(keys("immediate")).toEqual(["doc:a"]);
    expect(keys("soon")).toEqual(["doc:a", "doc:b"]);
    expect(keys("upcoming")).toEqual(["doc:a", "doc:b", "doc:c"]);
  });

  it("lists a record once even if two sections carry it", () => {
    const d = item({ key: "doc:x", kind: "document", daysUntil: -1, tier: "immediate" });
    expect(selectAttentionRows({ immediate: [d], health: [], documents: [d] })).toHaveLength(1);
  });

  it("bands rows by urgency, undated alerts first", () => {
    expect(attentionBand({ daysUntil: null })).toBe("overdue");
    expect(attentionBand({ daysUntil: -3 })).toBe("overdue");
    expect(attentionBand({ daysUntil: 0 })).toBe("week");
    expect(attentionBand({ daysUntil: 7 })).toBe("week");
    expect(attentionBand({ daysUntil: 8 })).toBe("month");
    expect(attentionBand({ daysUntil: 40 })).toBe("later");
    const groups = groupAttentionRows([{ daysUntil: 40 }, { daysUntil: -1 }, { daysUntil: 3 }]);
    expect(groups.map((g) => g.band.id)).toEqual(["overdue", "week", "later"]);
  });

  it("belongsInAttention reads the kind, and the source only for alerts", () => {
    expect(belongsInAttention(item({ key: "x", kind: "bill" }))).toBe(false);
    expect(belongsInAttention(item({ key: "x", kind: "habit" }))).toBe(false);
    expect(belongsInAttention(item({ key: "x", kind: "reminder", sourceKey: "obligation:1" }))).toBe(true);
    expect(belongsInAttention(item({ key: "x", kind: "alert", sourceKey: "habit:1" }))).toBe(false);
    expect(belongsInAttention(item({ key: "x", kind: "alert", sourceKey: "document:1" }))).toBe(true);
  });
});
