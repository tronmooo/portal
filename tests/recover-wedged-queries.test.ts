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

  // Fix (2026-08-17): StuckLoadingGuard's deadline used to run the RESUME
  // recovery, which cancels every in-flight /api fetch. A legitimately slow
  // request (cold Finance tab, honest 13-25s) was aborted at the deadline and
  // restarted from zero, cold — an unbounded "Retrying automatically…" loop.
  // Deadline-mode recovery must never cancel an in-flight fetch.
  it("deadline mode leaves in-flight fetches alone", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date().getTime() + 60_000);
    // A query that is mid-flight (never resolves) — i.e. "slow, not orphaned".
    void queryClient.fetchQuery({
      queryKey: ["/api/expenses", "everyone"],
      queryFn: () => new Promise(() => { /* still running */ }),
    }).catch(() => {});
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");

    await recoverWedgedQueries("deadline");

    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("resume mode still cancels orphaned in-flight fetches (post-freeze fix)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date().getTime() + 120_000);
    void queryClient.fetchQuery({
      queryKey: ["/api/trackers", "everyone"],
      queryFn: () => new Promise(() => { /* orphaned */ }),
    }).catch(() => {});
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");

    await recoverWedgedQueries("resume");

    expect(cancelSpy).toHaveBeenCalled();
  });
});
