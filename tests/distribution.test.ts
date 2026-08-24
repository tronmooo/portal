// tests/distribution.test.ts — how a shared quantity is assigned across
// several subjects. Pins shared/distribution.ts: each / both / all resolve to
// a per-person value, together / total to a shared amount that must not be
// multiplied, and respectively to an ordered pairing. Questions, negations,
// and ambiguous sentences produce NO reading — a half-understood hint is
// worse than none.

import { describe, it, expect } from "vitest";
import { readDistribution, buildDistributionDirective } from "@shared/distribution";

describe("readDistribution — per-person shapes", () => {
  it('"each" applies the value to every subject', () => {
    const r = readDistribution("Sarah and I each ran 3 miles");
    expect(r).toHaveLength(1);
    expect(r[0].shape).toBe("each");
    expect(r[0].subjects).toEqual(["Sarah", "the user"]);
    expect(r[0].value).toBe("3 miles");
  });

  it('"both" with one value behaves like "each"', () => {
    const r = readDistribution("Sarah and I both ran two miles yesterday");
    expect(r).toHaveLength(1);
    expect(r[0].shape).toBe("each");
    expect(r[0].subjects).toEqual(["Sarah", "the user"]);
    expect(r[0].value).toBe("two miles");
  });

  it("handles three coordinated subjects", () => {
    const r = readDistribution("Bob, Jane and Max all walked 2 miles");
    expect(r[0].shape).toBe("each");
    expect(r[0].subjects).toEqual(["Bob", "Jane", "Max"]);
    expect(r[0].value).toBe("2 miles");
  });

  it('"we each" keeps the group opaque but resolves the shape', () => {
    const r = readDistribution("We each drank 32 oz of water");
    expect(r).toHaveLength(1);
    expect(r[0].shape).toBe("each");
    expect(r[0].subjects).toEqual(["we"]);
    expect(r[0].value).toBe("32 oz");
  });
});

describe("readDistribution — shared totals", () => {
  it('"together" marks the value as a shared total, not per person', () => {
    const r = readDistribution("Together Sarah and I drove 400 miles");
    expect(r).toHaveLength(1);
    expect(r[0].shape).toBe("shared_total");
    expect(r[0].subjects).toEqual(["Sarah", "the user"]);
    expect(r[0].value).toBe("400 miles");
  });

  it('"in total" is a shared total', () => {
    const r = readDistribution("Bob and Jane spent $60 in total on groceries");
    expect(r[0].shape).toBe("shared_total");
    expect(r[0].value).toBe("$60");
  });
});

describe("readDistribution — respectively", () => {
  it("pairs values to subjects in order", () => {
    const r = readDistribution("Bob and Jane ran 2 and 3 miles respectively");
    expect(r).toHaveLength(1);
    expect(r[0].shape).toBe("respective");
    expect(r[0].subjects).toEqual(["Bob", "Jane"]);
    expect(r[0].values).toEqual(["2", "3 miles"]);
  });

  it("pairs three subjects to three values", () => {
    const r = readDistribution("Bob, Jane and Max weigh 180, 135 and 42 pounds respectively");
    expect(r[0].shape).toBe("respective");
    expect(r[0].subjects).toEqual(["Bob", "Jane", "Max"]);
    expect(r[0].values).toEqual(["180", "135", "42 pounds"]);
  });

  it("emits nothing when the value count does not match the subject count", () => {
    expect(readDistribution("Bob and Jane ran 2 miles respectively")).toHaveLength(0);
  });
});

describe("readDistribution — refusals", () => {
  it("questions never produce a reading", () => {
    expect(readDistribution("Did Sarah and I both run 2 miles?")).toHaveLength(0);
  });

  it("negations never produce a reading", () => {
    expect(readDistribution("Sarah and I didn't run our 2 miles today")).toHaveLength(0);
  });

  it("bare coordination without a distribution word is left to the model", () => {
    expect(readDistribution("Sarah and I went to the store")).toHaveLength(0);
  });

  it("lowercase noun pairs are not subjects", () => {
    expect(readDistribution("I had mac and cheese, both bowls were 300 calories each")).toHaveLength(0);
  });

  it("two values with a plain 'each' is too ambiguous to hint", () => {
    expect(readDistribution("Sarah and I each ran 2 miles and drank 20 oz")).toHaveLength(0);
  });

  it("empty input", () => {
    expect(readDistribution("")).toHaveLength(0);
  });
});

describe("readDistribution — multi-sentence messages", () => {
  it("reads each sentence independently", () => {
    const r = readDistribution(
      "Sarah and I both ran two miles. Together we spent $30 on lunch.",
    );
    expect(r).toHaveLength(2);
    expect(r[0].shape).toBe("each");
    expect(r[1].shape).toBe("shared_total");
    expect(r[1].value).toBe("$30");
  });
});

describe("buildDistributionDirective", () => {
  it("returns null with no readings", () => {
    expect(buildDistributionDirective([])).toBeNull();
  });

  it("per-person directive demands one write per subject and forbids dedup", () => {
    const d = buildDistributionDirective(readDistribution("Sarah and I both ran 2 miles"))!;
    expect(d).toContain("[DISTRIBUTION]");
    expect(d).toContain("PER SUBJECT");
    expect(d).toContain("Sarah, the user");
    expect(d).toContain("2 tool calls");
    expect(d).toMatch(/do not skip one as a duplicate/i);
  });

  it("shared-total directive forbids multiplying the amount", () => {
    const d = buildDistributionDirective(readDistribution("Together Sarah and I drove 400 miles"))!;
    expect(d).toContain("SHARED TOTAL");
    expect(d).toMatch(/do not log the full 400 miles once per subject/i);
  });

  it("respectively directive states the pairing in order", () => {
    const d = buildDistributionDirective(
      readDistribution("Bob and Jane ran 2 and 3 miles respectively"),
    )!;
    expect(d).toContain("Bob = 2");
    expect(d).toContain("Jane = 3 miles");
  });
});
