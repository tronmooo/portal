import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { queryClient, recoverWedgedQueries } from "../client/src/lib/queryClient";

// Regression coverage for the mobile-skeleton-storm fix (2026-07-21):
// return-to-app is a SINGLE refresh path — recoverWedgedQueries — and it must
//   1. cancel queries left in-flight since before the freeze ("wedged"),
//   2. refetch active queries that errored / went dataless while frozen,
//   3. NOT touch a fully settled cache (no blanket invalidate storm),
//   4. collapse rapid duplicate resume triggers (visibility + pageshow + auth),
//   5. never throw and never disturb a different profile's settled data.

// Each test advances the clock past the resume-dedupe window so the module-level
// dedupe timestamp from a previous test can't suppress the call under test.
let clock = 10_000_000;

beforeEach(() => {
  clock += 100_000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  queryClient.clear();
});

describe("recoverWedgedQueries — single resume path", () => {
  it("cancels a query left in-flight since before the freeze", async () => {
    // A fetch that never settles simulates a promise orphaned by tab suspension.
    void queryClient.prefetchQuery({
      queryKey: ["/api/stats", "everyone"],
      queryFn: () => new Promise(() => {}),
    });
    // Let the query enter the fetching state.
    await Promise.resolve();
    const wedged = queryClient
      .getQueryCache()
      .find({ queryKey: ["/api/stats", "everyone"] });
    expect(wedged?.state.fetchStatus).toBe("fetching");

    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");
    await recoverWedgedQueries();
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("refetches an actively-observed query that errored while frozen", async () => {
    const observer = new QueryObserver(queryClient, {
      queryKey: ["/api/dashboard-enhanced", "everyone"],
      queryFn: () => Promise.reject(new Error("frozen socket")),
      retry: false,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => {});
    // Drain the rejected fetch so the query lands in error state.
    await vi.waitFor(() => {
      const q = queryClient
        .getQueryCache()
        .find({ queryKey: ["/api/dashboard-enhanced", "everyone"] });
      expect(q?.state.status).toBe("error");
      expect(q?.state.fetchStatus).toBe("idle");
    });

    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await recoverWedgedQueries();
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ refetchType: "active" }),
    );
    unsubscribe();
  });

  it("is a no-op on a fully settled cache (no refetch storm)", async () => {
    queryClient.setQueryData(["/api/stats", "everyone"], { ok: 1 });
    queryClient.setQueryData(["/api/dashboard-enhanced", "everyone"], { ok: 1 });

    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await recoverWedgedQueries();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("collapses rapid duplicate resume triggers into one recovery", async () => {
    void queryClient.prefetchQuery({
      queryKey: ["/api/stats", "everyone"],
      queryFn: () => new Promise(() => {}),
    });
    await Promise.resolve();

    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");
    // visibilitychange + pageshow + auth resume all fire within the dedupe window.
    await recoverWedgedQueries();
    await recoverWedgedQueries();
    await recoverWedgedQueries();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves a different profile's settled data untouched", async () => {
    // Selected-profile scope entries that are settled must not be invalidated
    // just because the user returned to the app on a different scope.
    queryClient.setQueryData(["/api/stats", "p1", "p2"], { net: 100 });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await recoverWedgedQueries();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(["/api/stats", "p1", "p2"]),
    ).toEqual({ net: 100 });
  });

  it("never throws (best-effort lifecycle handler)", async () => {
    await expect(recoverWedgedQueries()).resolves.toBeUndefined();
  });
});
