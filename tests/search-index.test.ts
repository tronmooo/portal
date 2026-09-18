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

// ── QA 2026-09-18 BUG-24: ranking and match reasons ──────────────────────────
import { scoreMatch, rankResults, matchNote, isWordPrefixMatch } from "../client/src/lib/search-index";

describe("isWordPrefixMatch", () => {
  it("matches the start of any word, not a buried substring", () => {
    expect(isWordPrefixMatch("Dana's Birthday", "birthday")).toBe(true);
    expect(isWordPrefixMatch("Dana's Birthday", "dana")).toBe(true);
    expect(isWordPrefixMatch("Dana's Birthday", "na")).toBe(false);   // inside "Dana"
    expect(isWordPrefixMatch("personal", "na")).toBe(false);          // inside "personal"
    expect(isWordPrefixMatch("Mom's Birthday", "om")).toBe(false);
  });
});

describe("scoreMatch — name/title first, secondary fields lower and named", () => {
  it("ranks a title word-prefix hit above a category substring hit", () => {
    const event = { _type: "event", title: "Dana's Birthday", category: "family" };
    const expense = { _type: "expense", description: "Haircut", category: "personal" };
    const onTitle = scoreMatch(event, "dana");
    const onCategory = scoreMatch(expense, "na");
    expect(onTitle.onTitle).toBe(true);
    expect(onTitle.field).toBe("title");
    expect(onCategory.onTitle).toBe(false);
    expect(onCategory.field).toBe("category");
    expect(onTitle.score).toBeGreaterThan(onCategory.score);
  });

  it("exact > leading prefix > word prefix > substring on the title", () => {
    const q = "run";
    const exact = scoreMatch({ name: "Run" }, q).score;
    const prefix = scoreMatch({ name: "Running" }, q).score;
    const word = scoreMatch({ name: "Morning Run" }, q).score;
    const sub = scoreMatch({ name: "Overrun" }, q).score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(0);
  });

  it("returns 0 for a row that matches nothing, but keeps link-related rows at the bottom", () => {
    expect(scoreMatch({ _type: "event", title: "Car" }, "na").score).toBe(0);
    const related = scoreMatch({ _type: "event", title: "Car", _related: true }, "na");
    expect(related.score).toBeGreaterThan(0);
    expect(related.field).toBe("_related");
    expect(related.score).toBeLessThan(scoreMatch({ description: "x", category: "personal" }, "na").score);
  });

  it("halves the score of an out-of-scope row so in-scope rows come first", () => {
    const inScope = scoreMatch({ title: "Mom's Birthday" }, "birthday").score;
    const outOfScope = scoreMatch({ title: "Dana's Birthday", _outOfScope: true }, "birthday").score;
    expect(outOfScope).toBe(inScope / 2);
    expect(outOfScope).toBeGreaterThan(0);
  });

  it("never matches on ids, dates or internal keys", () => {
    expect(scoreMatch({ id: "na-123", createdAt: "2026-na", _type: "task", title: "Plan" }, "na").score).toBe(0);
  });
});

describe("rankResults", () => {
  it("drops non-matching rows, orders best first, and stamps the match field", () => {
    const raw = [
      { _type: "expense", description: "Haircut", category: "personal" },
      { _type: "event", title: "Car" },                        // no match at all
      { _type: "profile", name: "Dana", type: "person" },
      { _type: "event", title: "Dana's Birthday", _outOfScope: true },
      { _type: "event", title: "Car wash", _related: true },   // related only
    ];
    const ranked = rankResults(raw, "na");
    expect(ranked.map((r) => r.name ?? r.title ?? r.description)).toEqual([
      "Dana",             // title prefix
      "Dana's Birthday",  // title prefix, halved for scope
      "Haircut",          // category substring
      "Car wash",         // related only
    ]);
    expect(ranked[2]._matchField).toBe("category");
    expect(ranked.find((r) => r.title === "Car")).toBeUndefined();
  });

  it("finds Dana's Birthday for 'birthday' alongside Mom's, in-scope first", () => {
    const raw = [
      { _type: "event", title: "Dana's Birthday", _outOfScope: true },
      { _type: "event", title: "Mom's Birthday" },
    ];
    expect(rankResults(raw, "birthday").map((r) => r.title)).toEqual(["Mom's Birthday", "Dana's Birthday"]);
  });

  it("an empty query keeps every row (the superset is preserved)", () => {
    expect(rankResults([{ name: "a" }, { title: "b" }], "")).toHaveLength(2);
  });
});

describe("matchNote — the reason a row is listed", () => {
  it("says nothing for a name/title hit", () => {
    expect(matchNote(rankResults([{ title: "Dana's Birthday" }], "dana")[0])).toBe("");
  });
  it("names the secondary field", () => {
    expect(matchNote(rankResults([{ description: "Haircut", category: "personal" }], "na")[0])).toBe("matched on category");
  });
  it("explains related and out-of-scope rows", () => {
    expect(matchNote(rankResults([{ title: "Car", _related: true }], "na")[0])).toBe("linked to a match");
    expect(matchNote(rankResults([{ title: "Dana's Birthday", _outOfScope: true }], "dana")[0])).toBe("outside current scope");
  });
});
