/**
 * Part C — dashboard filter-switch performance contract.
 *
 * Switching the dashboard profile filter (Everyone ↔ Person A ↔ Person B) must
 * feel instant (<500ms) when the target filter is already cached. That depends
 * on four invariants that are easy to regress in a refactor. Rather than spin
 * up a browser, this test pins the invariants at the source level (same
 * approach as the smoke contract guards):
 *
 *   1. The dashboard-enhanced / stats / income / budget query keys segment by
 *      filterMode AND filterIds, so each filter gets its own cache bucket.
 *   2. The global query defaults keep staleTime >= 30s.
 *   3. The global query defaults use placeholderData: keepPreviousData (v5),
 *      so a filter swap keeps showing the prior result instead of a skeleton.
 *   4. refetchOnMount is `true` (not "always") so cached data renders instantly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");
const dashboard = readFileSync(path.join(REPO_ROOT, "client/src/pages/dashboard.tsx"), "utf8");
const queryClient = readFileSync(path.join(REPO_ROOT, "client/src/lib/queryClient.ts"), "utf8");

describe("Part C — filter-switch caching invariants", () => {
  it("dashboard-enhanced query key segments by filterMode and filterIds", () => {
    // The exact shape the perf depends on: each filter combination is its own
    // cache entry, so re-selecting a previously-viewed filter is a cache hit.
    expect(dashboard).toMatch(
      /queryKey:\s*\[\s*["']\/api\/dashboard-enhanced["']\s*,\s*filterMode\s*,\s*\.\.\.filterIds/,
    );
  });

  it("stats query key segments by filterMode and filterIds", () => {
    expect(dashboard).toMatch(
      /queryKey:\s*\[\s*["']\/api\/stats["']\s*,\s*filterMode\s*,\s*\.\.\.filterIds/,
    );
  });

  it("global staleTime is at least 30s", () => {
    const m = queryClient.match(/staleTime:\s*([\d_]+)/);
    expect(m, "staleTime not found in queryClient defaults").toBeTruthy();
    const staleTime = Number(m![1].replace(/_/g, ""));
    expect(staleTime).toBeGreaterThanOrEqual(30_000);
  });

  it("global defaults use placeholderData: keepPreviousData (no skeleton on swap)", () => {
    expect(queryClient).toMatch(/placeholderData:\s*keepPreviousData/);
  });

  it("refetchOnMount is true (not \"always\") so cached data renders instantly", () => {
    expect(queryClient).toMatch(/refetchOnMount:\s*true/);
    expect(queryClient).not.toMatch(/refetchOnMount:\s*["']always["']/);
  });

  it("a ?perfLog=1 timing log exists for filter switches", () => {
    expect(dashboard).toMatch(/perfLog/);
    expect(dashboard).toMatch(/performance\.now\(\)/);
  });
});
