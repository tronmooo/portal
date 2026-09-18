// tests/qa-2026-09-18-copy-layout.test.ts
//
// QA 2026-09-18, copy & labels / layout & visual (F-55, F-57 … F-64, F-66).
// Pure logic is pinned directly; the layout fixes that only exist as class
// names or props are pinned as source guards in the style of
// tests/design-system-drift.test.ts, so the next edit cannot quietly undo them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  humanizeEnumValue, enumOptionsForField, isDateFieldKey, toDateInputValue,
  describeCount, singularNoun, humanizeDocumentFieldKey, humanizeFieldName,
} from "@shared/field-label";
import { formatLoggedValues } from "@shared/tracker-units";
import { isSystemTag, userVisibleTags } from "@shared/system-tags";
import { summarizeDocumentUrgency } from "@shared/document-dates";
import { humanRecurrenceLabel } from "@shared/recurring-dates";
import { humanSummary, parseRecurrence } from "@shared/recurrence";
import { formatTimeAgo, metricValueSize } from "../client/src/lib/format";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

// ── F-55: internal values never reach the screen as tokens ──────────────────
describe("F-55 enum fields, dates and document keys are humanised", () => {
  it("labels the asset subtype and value-source tokens", () => {
    expect(humanizeEnumValue("high_value_item")).toBe("High-value item");
    expect(humanizeEnumValue("bank_account")).toBe("Bank account");
    expect(humanizeEnumValue("estimate")).toBe("Estimated by Portol");
    expect(humanizeEnumValue("user")).toBe("Entered by you");
    // Unknown tokens still read as words, never as snake_case.
    expect(humanizeEnumValue("some_new_thing")).toBe("Some new thing");
    expect(humanizeEnumValue("")).toBe("");
  });

  it("offers a Select for enum keys and keeps a legacy value selectable", () => {
    const sub = enumOptionsForField("assetSubtype", "high_value_item")!;
    expect(sub.map(o => o.value)).toContain("high_value_item");
    expect(sub.find(o => o.value === "high_value_item")!.label).toBe("High-value item");
    expect(sub.some(o => /_/.test(o.label))).toBe(false);
    // The stored value stays in the list even when it is not a known option.
    const legacy = enumOptionsForField("currentValueSource", "lookup")!;
    expect(legacy.map(o => o.value)).toContain("lookup");
    // Free-text keys get no Select.
    expect(enumOptionsForField("brand", "Apple")).toBeNull();
    // snake_case spelling of an enum key resolves too.
    expect(enumOptionsForField("current_value_source", "estimate")).not.toBeNull();
  });

  it("renders the valuation instant as a day in a date input", () => {
    expect(isDateFieldKey("valuationDate")).toBe(true);
    expect(isDateFieldKey("currentValueAsOf")).toBe(true);
    expect(isDateFieldKey("purchasePrice")).toBe(false);
    expect(toDateInputValue("2026-09-16T14:55:48.412Z")).toBe("2026-09-16");
    expect(toDateInputValue("2026-09-16")).toBe("2026-09-16");
    expect(toDateInputValue("")).toBe("");
  });

  it("spells out extractor keys like LAST4", () => {
    expect(humanizeDocumentFieldKey("LAST4")).toBe("Last 4 digits");
    expect(humanizeDocumentFieldKey("last4")).toBe("Last 4 digits");
    expect(humanizeDocumentFieldKey("dob")).toBe("Date of birth");
    expect(humanizeDocumentFieldKey("policyNumber")).toBe("Policy Number");
    expect(humanizeDocumentFieldKey("POLICY_NUMBER")).toBe("Policy Number");
    // Tracker-field behaviour is untouched.
    expect(humanizeFieldName("spo2")).toBe("SPO2");
  });

  it("hides system tags from every tag strip", () => {
    expect(isSystemTag("sha256:9c8249b8a1")).toBe(true);
    expect(isSystemTag("#sha256:9c8249b8a1")).toBe(true);
    expect(isSystemTag("image-discarded")).toBe(true);
    expect(isSystemTag("recur:weekly")).toBe(true);
    expect(isSystemTag("drivers_license")).toBe(false);
    expect(isSystemTag("Tax 2025")).toBe(false);
    expect(userVisibleTags(["sha256:abc", "receipt", "image-discarded", "tax"])).toEqual(["receipt", "tax"]);
    expect(userVisibleTags(null)).toEqual([]);
  });

  it("the edit dialog and the viewers use the shared helpers", () => {
    const detail = read("client/src/pages/profile-detail.tsx");
    expect(detail).toContain("enumOptionsForField(key, fields[key])");
    expect(detail).toContain("toDateInputValue(fields[key])");
    expect(detail).toContain("Valued: {formatFullDate(f.valuationDate)}");
    expect(read("client/src/components/DocumentViewer.tsx")).toContain("humanizeDocumentFieldKey");
    for (const f of ["client/src/pages/artifacts.tsx", "client/src/pages/document-detail.tsx", "client/src/components/DocumentViewer.tsx"]) {
      expect(read(f), f).toContain("userVisibleTags(");
      expect(read(f), f).not.toContain('startsWith("sha256:")');
    }
  });
});

// ── F-57: expired and expiring soon are different numbers ───────────────────
describe("F-57 document urgency split", () => {
  const rows = [
    { name: "Homeowners Insurance", daysUntil: -109 },
    { name: "Parking Violation", daysUntil: 7 },
  ];
  it("says 1 expired · 1 expiring soon, never 2 expiring soon", () => {
    const u = summarizeDocumentUrgency(rows);
    expect(u.expired).toBe(1);
    expect(u.expiringSoon).toBe(1);
    expect(u.later).toBe(0);
    expect(u.total).toBe(2);
    expect(u.label).toBe("1 expired · 1 expiring soon");
  });
  it("counts beyond the window as upcoming and tolerates missing days", () => {
    const u = summarizeDocumentUrgency([{ daysUntil: 45 }, { daysUntil: 0 }, {}]);
    expect(u).toMatchObject({ expired: 0, expiringSoon: 1, later: 2, total: 3 });
    expect(u.label).toBe("1 expiring soon · 2 upcoming");
    expect(summarizeDocumentUrgency([]).label).toBe("");
    expect(summarizeDocumentUrgency(undefined).total).toBe(0);
  });
  it("every document caption reads the one split", () => {
    expect(read("client/src/pages/dashboard.tsx")).toContain("summarizeDocumentUrgency(docs).label");
    expect(read("client/src/pages/dashboard.tsx")).not.toContain("{count} expiring soon");
    expect(read("client/src/components/dashboard/ExecutiveBriefing.tsx")).toContain("summarizeDocumentUrgency(visibleDocs)");
    expect(read("client/src/components/hub/HubKpiStrip.tsx")).toContain("summarizeDocumentUrgency(expDocs)");
  });
});

// ── F-58: plurals, relative time, one weekday format ────────────────────────
describe("F-58 copy agreement", () => {
  it("the activity line's noun agrees with its count", () => {
    expect(describeCount(1, "completions")).toBe("1 completion");
    expect(describeCount(2, "completions")).toBe("2 completions");
    expect(describeCount(1, "steps")).toBe("1 step");
    expect(describeCount(1, "glasses")).toBe("1 glass");
    expect(describeCount(1, "calories")).toBe("1 calorie");
    expect(describeCount(1, "oz")).toBe("1 oz");
    expect(describeCount(64, "oz")).toBe("64 oz");
    expect(singularNoun("entries")).toBe("entry");
    expect(singularNoun("glass")).toBe("glass");
    // Both storages build the Recent Activity line through formatLoggedValues,
    // whose unitless fallback agrees in number via describeCount.
    expect(formatLoggedValues({ completions: 1 }, "Brush Teeth")).toEqual(["1 completion"]);
    expect(formatLoggedValues({ completions: 2 }, "Brush Teeth")).toEqual(["2 completions"]);
    expect(read("server/storage.ts")).toContain("formatLoggedValues(Object.fromEntries(nums.slice(0, 2))");
    expect(read("server/supabase-storage.ts")).toContain("formatLoggedValues(Object.fromEntries(nums.slice(0, 2))");
  });

  it("relative time glues the unit to the number, like the rest of the app", () => {
    const now = new Date("2026-09-18T12:00:00Z");
    expect(formatTimeAgo("2026-09-16T12:00:00Z", now)).toBe("2d ago");
    expect(formatTimeAgo("2026-09-18T09:00:00Z", now)).toBe("3h ago");
    expect(formatTimeAgo("2026-09-18T11:55:00Z", now)).toBe("5m ago");
    expect(formatTimeAgo("2026-09-18T11:59:50Z", now)).toBe("just now");
    expect(formatTimeAgo("2026-05-01T12:00:00Z", now)).toBe("May 1, 2026");
    expect(formatTimeAgo("not a date", now)).toBe("");
    expect(read("client/src/components/asset/CurrentValueCard.tsx")).not.toMatch(/\$\{\w+\} d ago/);
  });

  it("recurrence labels use full weekday names in both grammars", () => {
    expect(humanRecurrenceLabel("weekly:1,3,5")).toBe("Weekly on Monday, Wednesday, Friday");
    expect(humanRecurrenceLabel("weekly:2")).toBe("Weekly on Tuesday");
    expect(humanRecurrenceLabel("weekly", "2026-09-22")).toBe("Weekly on Tuesday");
    expect(humanSummary(parseRecurrence(["recur:weekly"]), "2026-09-22")).toBe("Repeats weekly on Tuesday");
  });
});

// ── F-59: the page's own word is not one tile of three ──────────────────────
describe("F-59 artifacts summary band", () => {
  it("does not label a partial count with the page title", () => {
    const src = read("client/src/pages/artifacts.tsx");
    expect(src).not.toMatch(/label: "Artifacts"/);
    expect(src).toContain('label: "Notes & reports"');
    expect(src).toMatch(/\{profileFiltered\.length\} artifact\{/);
  });
});

// ── F-60: a KPI number shrinks to fit ───────────────────────────────────────
describe("F-60 metric value sizing", () => {
  it("steps the size down with the string length, never below the floor", () => {
    expect(metricValueSize("$1,608")).toBe(26);
    expect(metricValueSize("$16,083")).toBe(26);
    expect(metricValueSize("$160,830")).toBe(22);
    expect(metricValueSize("$1,608,307")).toBe(19);
    expect(metricValueSize("-$1,608,307")).toBe(19);
    expect(metricValueSize("$16,083,070.55")).toBe(15);
    expect(metricValueSize("$1,608,307", 17, 12)).toBe(12);
    expect(metricValueSize(null)).toBe(26);
  });
  it("the money tiles shrink instead of overflowing or truncating", () => {
    const mo = read("client/src/components/finance/MoneyOverview.tsx");
    expect(mo).toContain("fontSize: `${metricValueSize(value)}px`");
    expect(mo).toMatch(/min-w-0 overflow-hidden/);
    const mc = read("client/src/components/ui/metric-card.tsx");
    expect(mc).toContain("metricValueSize(");
    expect(mc).not.toContain('"metric-value leading-none truncate"');
  });
});

// ── F-61: the hub strip wraps instead of slicing a chip ─────────────────────
describe("F-61 hub KPI strip", () => {
  it("wraps from sm up and snaps on a phone, every chip min-w-fit", () => {
    const src = read("client/src/components/hub/HubKpiStrip.tsx");
    expect(src).toMatch(/sm:flex-wrap/);
    expect(src).toMatch(/snap-x/);
    expect(src).toMatch(/min-w-fit snap-start/);
  });
});

// ── F-62: a toast never leaves the screen ───────────────────────────────────
describe("F-62 toast viewport", () => {
  it("is pinned inside the viewport and its text column can shrink", () => {
    const toast = read("client/src/components/ui/toast.tsx");
    expect(toast).toMatch(/fixed top-0 left-0 right-0/);
    expect(toast).toContain("max-w-[calc(100vw-2rem)]");
    expect(toast).toContain("sm:left-auto sm:right-0");
    expect(read("client/src/components/ui/toaster.tsx")).toContain('className="grid gap-1 min-w-0 flex-1"');
  });
});

// ── F-63: loading states are placeholders, not blank space ──────────────────
describe("F-63 skeletons", () => {
  it("the briefing holds its skeleton grid until the snapshot lands", () => {
    expect(read("client/src/components/dashboard/ExecutiveBriefing.tsx"))
      .toContain("(sections.length === 0 || (enhanced === undefined && !briefStuck))");
  });
  it("the loan History tab shows a skeleton while in flight", () => {
    expect(read("client/src/components/ProfileSharedTabs.tsx")).toContain('data-testid="history-tab-loading"');
  });
  it("the shimmer is visible on the light theme", () => {
    const css = read("client/src/index.css");
    const block = css.slice(css.indexOf(".skeleton-shimmer {"), css.indexOf("@keyframes shimmer-anim"));
    expect(block).toContain("--muted-foreground) / 0.12");
  });
});

// ── F-64: charts do not replay their entrance on every render ───────────────
describe("F-64 chart animation", () => {
  it("every finance series opts out of the entrance animation", () => {
    for (const f of [
      "client/src/components/finance/MoneyOverview.tsx",
      "client/src/components/finance/MoneyPopups.tsx",
      "client/src/pages/finance.tsx",
      "client/src/components/dashboard/HeroKPIPopups.tsx",
    ]) {
      const src = read(f);
      const series = src.match(/<(Bar|Line|Area|Pie)\b[^>]*>/gs) || [];
      expect(series.length, `${f} has recharts series`).toBeGreaterThan(0);
      for (const s of series) expect(s, `${f}: ${s.slice(0, 60)}`).toContain("isAnimationActive={false}");
    }
  });
  it("the trend data reference is stable across renders", () => {
    const mo = read("client/src/components/finance/MoneyOverview.tsx");
    expect(mo).toContain("useMemo(() => cashTrend, [trendKey])");
    expect(mo).toContain("<ComposedChart data={trendData}");
  });
});

// ── F-66: no zoom toolbar over a file that was never kept ───────────────────
describe("F-66 discarded-file viewer", () => {
  it("document-detail hides the zoom toolbar when the file was discarded", () => {
    const src = read("client/src/pages/document-detail.tsx");
    const toolbarAt = src.indexOf('data-testid="doc-zoom-toolbar"');
    expect(toolbarAt).toBeGreaterThan(0);
    expect(src.slice(toolbarAt - 200, toolbarAt)).toContain("{!fileDiscarded && (");
  });
});
