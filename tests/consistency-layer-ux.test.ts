// Consistency layer — documents vs artifacts, routes/titles, asset grouping, tracker metadata (req. tests 24, 25).
import { describe, expect, it } from "vitest";
import {
  libraryPurposeOf, splitLibrary, LIBRARY_PURPOSE, pageTitleFor, routeMetaFor, canonicalPathFor, ROUTE_METADATA,
  groupAndSortAssets, assetGroupOf, resolveTrackerIcon, resolveTrackerMetadata, formatTrackerValue, FALLBACK_TRACKER_ICON,
} from "../shared/domain";

describe("24. Documents and Artifacts follow their defined purposes", () => {
  it("uploaded files are documents; AI-created outputs are artifacts; the link between them is explicit", () => {
    const items = [
      { id: "d1", name: "Policy.pdf", mimeType: "application/pdf", storagePath: "docs/policy.pdf" },
      { id: "a1", type: "markdown", title: "Policy summary", content: "# Summary", source: "ai", sourceDocumentId: "d1" },
      { id: "a2", type: "sheet", title: "Budget", content: "" },
    ];
    expect(libraryPurposeOf(items[0])).toBe("document");
    expect(libraryPurposeOf(items[1])).toBe("artifact");
    const split = splitLibrary(items);
    expect(split.documents.map((d) => d.id)).toEqual(["d1"]);
    expect(split.artifacts.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(split.links).toEqual([{ artifactId: "a1", documentId: "d1" }]);
    expect(LIBRARY_PURPOSE.document.description).toMatch(/Uploaded/);
    expect(LIBRARY_PURPOSE.artifact.description).toMatch(/AI-created/);
  });
});

describe("25. Every major route has the correct browser title", () => {
  it("Assets and Documents are never 'Linked — Portol'", () => {
    expect(pageTitleFor("/linked?tab=assets")).toBe("Assets — Portol");
    expect(pageTitleFor("/linked?tab=documents")).toBe("Documents — Portol");
    expect(pageTitleFor("/finance")).toBe("Finance — Portol");
    expect(pageTitleFor("/dashboard/finance")).toBe("Finance — Portol");
    expect(pageTitleFor("/trackers")).toBe("Trackers — Portol");
    expect(pageTitleFor("/liabilities")).toBe("Liabilities — Portol");
    expect(pageTitleFor("/calendar")).toBe("Calendar — Portol");
    expect(pageTitleFor("/settings")).toBe("Settings — Portol");
    expect(pageTitleFor("/profiles/abc")).toBe("Profile — Portol");
    expect(pageTitleFor("/profiles/abc", "Jane")).toBe("Jane · Profile — Portol");
    expect(pageTitleFor("/nope")).toBe("Page not found — Portol");
  });
  it("every route carries the full metadata set and a canonical path", () => {
    for (const r of ROUTE_METADATA) {
      expect(r.pageTitle).toBeTruthy();
      expect(r.navigationLabel).toBeTruthy();
      expect(r.breadcrumb.length).toBeGreaterThan(0);
      expect(r.canonicalPath.startsWith("/")).toBe(true);
    }
    expect(canonicalPathFor("/dashboard/finance")).toBe("/finance");
    expect(routeMetaFor("/linked?tab=documents").section).toBe("documents");
  });
});

describe("27. Assets are grouped by category and sorted by value", () => {
  it("a house is never buried under a wallet", () => {
    const blocks = groupAndSortAssets([
      { id: "1", name: "Leather wallet", type: "asset", fields: { currentValue: 20 } },
      { id: "2", name: "Home", type: "property", fields: { currentValue: 650000 } },
      { id: "3", name: "Dodge Ram", type: "vehicle", fields: { currentValue: 45500 } },
      { id: "4", name: "MacBook Pro", type: "asset", fields: { currentValue: 2400 } },
      { id: "5", name: "Checking", type: "account", fields: { balance: 5000, accountKind: "checking" } },
    ]);
    expect(blocks.map((b) => b.group)).toEqual(["Real Estate", "Vehicles", "Financial Accounts", "Electronics", "Personal Property"]);
    expect(blocks[0].total).toBe(650000);
    expect(assetGroupOf({ id: "x", name: "iPhone 15", type: "asset" })).toBe("Electronics");
    const byName = groupAndSortAssets([{ id: "a", name: "Zed", type: "asset", fields: { currentValue: 1 } }, { id: "b", name: "Amy", type: "asset", fields: { currentValue: 9 } }], "name");
    expect(byName[0].items.map((i) => i.asset.name)).toEqual(["Amy", "Zed"]);
  });
});

describe("14/15. Tracker icons are category-driven and labels come from the record", () => {
  it("strength → dumbbell, running → activity, coffee → beverage, shower → hygiene, heart rate → heart, fallback is never a heart", () => {
    expect(resolveTrackerIcon({ name: "Strength training", category: "fitness" }).icon).toBe("Dumbbell");
    expect(resolveTrackerIcon({ name: "Running", category: "fitness" }).icon).toBe("Footprints");
    expect(resolveTrackerIcon({ name: "Coffee", category: "nutrition" }).icon).toBe("Coffee");
    expect(resolveTrackerIcon({ name: "Shower", category: "lifestyle" }).icon).toBe("ShowerHead");
    expect(resolveTrackerIcon({ name: "Heart rate", category: "health" }).icon).toBe("Heart");
    expect(resolveTrackerIcon({ name: "Stretching", category: "fitness" }).icon).toBe("StretchHorizontal");
    expect(resolveTrackerIcon({ name: "Widgets", category: "custom" }).icon).toBe(FALLBACK_TRACKER_ICON);
    expect(FALLBACK_TRACKER_ICON).not.toMatch(/heart/i);
  });
  it("Mood and Energy are a 1–10 scale, never 'Scale 100%'; Stretching is not meditation", () => {
    const mood = resolveTrackerMetadata({ name: "Mood", category: "mental", fields: [{ name: "scale", type: "number" }] });
    expect(mood.isScale).toBe(true);
    expect(formatTrackerValue(7, mood)).toBe("7/10");
    expect(formatTrackerValue(10, mood)).not.toContain("%");
    const stretch = resolveTrackerMetadata({ name: "Stretching", category: "fitness" });
    expect(stretch.displayLabel).toBe("Stretching");
    expect(stretch.category).toBe("flexibility");
    const hr = resolveTrackerMetadata({ name: "Heart rate", category: "health", fields: [{ name: "bpm", type: "number", isPrimary: true }] });
    expect(hr).toMatchObject({ unit: "bpm", source: "canonical", aggregation: "last" });
  });
});
