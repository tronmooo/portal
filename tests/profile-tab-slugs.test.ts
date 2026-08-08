import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import {
  PROFILE_TAB_SLUGS, isProfileTabSlug, tabSlugFromLabel,
  resolveProfileTab, slugForProfileTab,
} from "../client/src/lib/profile-tab-slugs";

// The person/self tab set from profile-detail.tsx ENTITY_TABS — the labels are
// what the URL slugs are derived from, so they must round-trip.
const PERSON_TABS = [
  { value: "info", label: "Overview" },
  { value: "finance", label: "Finance" },
  { value: "person-trackers", label: "Trackers" },
  { value: "person-documents", label: "Documents" },
  { value: "habits", label: "Productivity" },
  { value: "person-history", label: "History" },
];

describe("isProfileTabSlug", () => {
  it("accepts every declared slug, case-insensitively", () => {
    for (const s of PROFILE_TAB_SLUGS) {
      expect(isProfileTabSlug(s), s).toBe(true);
      expect(isProfileTabSlug(s.toUpperCase()), s).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const s of ["list", "b", "settings", "", "info-x"]) {
      expect(isProfileTabSlug(s), s).toBe(false);
    }
  });
});

describe("tabSlugFromLabel", () => {
  it("lowercases and hyphenates", () => {
    expect(tabSlugFromLabel("Productivity")).toBe("productivity");
    expect(tabSlugFromLabel("Health & Vet")).toBe("health-vet");
    expect(tabSlugFromLabel("  Trackers  ")).toBe("trackers");
  });
});

describe("resolveProfileTab", () => {
  it("resolves a label slug to the tab value", () => {
    expect(resolveProfileTab(PERSON_TABS, "overview")).toBe("info");
    expect(resolveProfileTab(PERSON_TABS, "finance")).toBe("finance");
    expect(resolveProfileTab(PERSON_TABS, "trackers")).toBe("person-trackers");
    expect(resolveProfileTab(PERSON_TABS, "productivity")).toBe("habits");
  });

  it("also accepts the internal tab value", () => {
    expect(resolveProfileTab(PERSON_TABS, "person-history")).toBe("person-history");
  });

  it("falls back to the first tab for a missing or unknown slug", () => {
    expect(resolveProfileTab(PERSON_TABS, undefined)).toBe("info");
    expect(resolveProfileTab(PERSON_TABS, "nope")).toBe("info");
    // A type whose tab set lacks the requested tab (a loan has no Trackers).
    expect(resolveProfileTab([{ value: "info", label: "Info" }], "trackers")).toBe("info");
  });
});

describe("slugForProfileTab", () => {
  it("is the inverse of resolveProfileTab for every tab", () => {
    for (const tab of PERSON_TABS) {
      const slug = slugForProfileTab(PERSON_TABS, tab.value);
      expect(resolveProfileTab(PERSON_TABS, slug), tab.value).toBe(tab.value);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA report 2026-08-05 (profile sub-tabs). The detail page derives a tab's URL
// from its LABEL, and isHubRoute() only treats /profiles/:id/<slug> as a profile
// route when <slug> is in PROFILE_TAB_SLUGS. The list held just the seven
// person-tab slugs, so opening Contained, Financials, Money, Maintenance,
// Activity, Notes, Payments, Statements … produced a URL the router did not
// recognise as a profile route and the hub chrome dropped out on those tabs
// only.
//
// The list and the page's tab tables are two files that must agree, so read the
// tab tables straight out of the page and assert every label lands on a known
// slug. A new tab now fails here instead of silently half-working.
// ─────────────────────────────────────────────────────────────────────────────
describe("PROFILE_TAB_SLUGS covers every tab the detail page can open", () => {
  const src = readFileSync(
    resolvePath(__dirname, "../client/src/pages/profile-detail.tsx"), "utf8",
  );
  // Tab rows are the object literals carrying a `testId: "tab-…"`, which is what
  // distinguishes them from the field-definition tables in the same file.
  const tabRows = [...src.matchAll(
    /\{\s*value:\s*"([a-z-]+)",\s*label:\s*"([^"]+)",\s*testId:\s*"tab-[a-z-]+"\s*\}/g,
  )];

  it("finds the page's tab tables", () => {
    expect(tabRows.length).toBeGreaterThan(40);
  });

  it("every tab label slugifies to a recognised profile tab slug", () => {
    const unknown = [...new Set(
      tabRows.map(m => m[2]).filter(label => !isProfileTabSlug(tabSlugFromLabel(label))),
    )];
    expect(unknown, `add these to PROFILE_TAB_SLUGS: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every slug in the list is reachable from some tab label or value", () => {
    const reachable = new Set([
      ...tabRows.map(m => tabSlugFromLabel(m[2])),
      ...tabRows.map(m => m[1]),
    ]);
    const stale = PROFILE_TAB_SLUGS.filter(s => !reachable.has(s));
    expect(stale, `no tab produces these slugs: ${stale.join(", ")}`).toEqual([]);
  });
});
