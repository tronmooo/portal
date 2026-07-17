import { describe, it, expect, vi, afterEach } from "vitest";
import { queryClient, recoverWedgedQueries } from "../client/src/lib/queryClient";

// Fix (2026-07-17): return-to-app refresh is now a SINGLE strategy. When no
// query is genuinely wedged (in-flight), recoverWedgedQueries must be a complete
// no-op — the old blanket invalidate of every /api query fired a redundant
// refetch wave on every tab return, on top of React Query's own focus refetch.

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe("recoverWedgedQueries", () => {
  it("does NOT cancel or invalidate anything when no query is fetching", async () => {
    // Seed some settled cache entries — none are in-flight.
    queryClient.setQueryData(["/api/stats", "everyone"], { ok: 1 });
    queryClient.setQueryData(["/api/dashboard-enhanced", "everyone"], { ok: 1 });

    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await recoverWedgedQueries();

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("never throws (best-effort lifecycle handler)", async () => {
    await expect(recoverWedgedQueries()).resolves.toBeUndefined();
  });
});
