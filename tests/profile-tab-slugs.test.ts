import { describe, it, expect } from "vitest";
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
