import { describe, it, expect } from "vitest";
import { searchableText, itemMatches } from "../client/src/lib/search-index";

// PERF-AUDIT: the ⌘K palette narrows a cached broader result set locally so
// common queries resolve instantly instead of hitting /api/search every time.
// The invariant that makes this correct: itemMatches must match on the SAME (or
// a superset of) fields the server matches on, so narrowing never drops a row.

describe("searchableText", () => {
  it("joins all string field values, lowercased", () => {
    const item = { id: 1, name: "Rent", category: "Housing", amount: 1200 };
    expect(searchableText(item)).toBe("rent housing");
  });

  it("includes string entries from array fields (e.g. tags)", () => {
    const item = { title: "Note", tags: ["Budget", "2026"], nested: [{}, 5] };
    expect(searchableText(item)).toBe("note budget 2026");
  });

  it("ignores object keys — only values are searchable", () => {
    // 'description' is a key, not a value; a query for it must not match.
    const item = { description: "coffee" };
    expect(itemMatches(item, "descr")).toBe(false);
    expect(itemMatches(item, "coffee")).toBe(true);
  });

  it("handles null/undefined items without throwing", () => {
    expect(searchableText(null)).toBe("");
    expect(searchableText(undefined)).toBe("");
  });
});

describe("itemMatches — matches on any field the server searches", () => {
  it("matches an expense on description, category, OR vendor", () => {
    // Server matches expenses on has(description) || has(category) || has(vendor).
    const onVendor = { _type: "expense", description: "Monthly", category: "Bills", vendor: "Rentwell" };
    expect(itemMatches(onVendor, "rent")).toBe(true); // matches vendor, not just description
  });

  it("narrowing a superset yields exactly the rows matching the longer query", () => {
    // Simulate the cached result set for the broader query "r"...
    const superset = [
      { _type: "profile", name: "Rent Account" },
      { _type: "expense", description: "Groceries", vendor: "Rentwell Mart" },
      { _type: "task", title: "Refill meds" },        // matches "r" but not "rent"
      { _type: "habit", name: "Run" },                 // matches "r" but not "rent"
    ];
    const narrowed = superset.filter((it) => itemMatches(it, "rent"));
    expect(narrowed).toEqual([
      { _type: "profile", name: "Rent Account" },
      { _type: "expense", description: "Groceries", vendor: "Rentwell Mart" },
    ]);
  });

  it("empty query matches everything (superset is preserved)", () => {
    const rows = [{ name: "a" }, { title: "b" }];
    expect(rows.filter((it) => itemMatches(it, ""))).toHaveLength(2);
  });
});
