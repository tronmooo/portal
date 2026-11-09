// @vitest-environment jsdom
//
// Owner report 2026-11-09: Guitar Practice (45 + 30 min today) and Garden
// Watering (15 min) both headlined "Today · 2 min"; Calories (350 + 1)
// headlined "40 kcal". The hero counts up with requestAnimationFrame, and the
// browser stopped delivering frames partway (embedded browser pane, occluded
// window, screen recording) — so the count froze. The number must land
// whether or not animation frames arrive.
import React from "react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type { Tracker } from "../shared/schema";
import { buildTrackerModel, periodFor, OverviewTab } from "../client/src/components/tracker-detail";
import { CountUp } from "../client/src/components/dashboard/visuals";

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
});

// A browser that delivers exactly `n` animation frames, then none.
function starveFramesAfter(n: number) {
  let delivered = 0;
  let t = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    if (delivered >= n) return 0;
    delivered++;
    t += 16;
    const at = t;
    setTimeout(() => cb(at), 0);
    return delivered;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const NOW = new Date("2026-11-09T22:30:00Z");
const guitar = {
  id: "g", name: "Guitar Practice", category: "custom", unit: null, linkedProfiles: [], createdAt: "2026-11-01T00:00:00Z",
  fields: [{ name: "duration", type: "number" }],
  entries: [
    { id: "a", values: { duration: 45 }, computed: {}, timestamp: "2026-11-09T22:16:35.007Z" },
    { id: "b", values: { _notes: "evening session", duration: 30 }, computed: {}, timestamp: "2026-11-09T22:17:22.903Z" },
  ],
} as unknown as Tracker;

describe("tracker hero 'Today' headline", () => {
  it("shows the day's real total (75 min) even when animation frames stop", async () => {
    starveFramesAfter(2);
    const model = buildTrackerModel(guitar, [], NOW, "UTC");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OverviewTab model={model} period={periodFor("30d", model)} onNavigate={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("td-hero").textContent).toMatch(/Today/);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByTestId("td-hero-value").textContent).toBe("75");
  });

  it("CountUp lands on 351 with no frames at all", async () => {
    starveFramesAfter(0);
    render(<span data-testid="n"><CountUp value={351} /></span>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByTestId("n").textContent).toBe("351");
  });

  it("still animates when frames do arrive, and ends on the value", async () => {
    starveFramesAfter(1000);
    render(<span data-testid="n"><CountUp value={351} /></span>);
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    const mid = Number(screen.getByTestId("n").textContent!.replace(/,/g, ""));
    expect(mid).toBeLessThan(351);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByTestId("n").textContent).toBe("351");
  });
});
