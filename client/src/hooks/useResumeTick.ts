// STALE-CLOCK FIX (2026-07-21, BUG resume-after-overnight): now()-derived UI
// (the hub/dashboard header date, "today" computations) is evaluated at render
// time and never again. When the PWA resumes from an overnight freeze the tab
// re-renders nothing on its own, so the header kept showing YESTERDAY's date
// ("Monday, July 20" on Tuesday). This hook bumps a counter once per "real"
// resume — visibilitychange after >=15s hidden (same absence threshold as
// recoverWedgedQueries in lib/queryClient.ts) and bfcache pageshow(persisted)
// — so date-dependent components recompute exactly once per resume instead of
// polling with an interval or re-rendering on every quick tab flip.
import { useEffect, useState } from "react";

// Mirror of the recovery threshold in lib/queryClient.ts — a quick tab flip
// can't change "today" in any meaningful way and shouldn't cause re-renders.
const LONG_ABSENCE_MS = 15_000;

export function useResumeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else {
        if (hiddenAt && Date.now() - hiddenAt >= LONG_ABSENCE_MS) {
          setTick((t) => t + 1);
        }
        hiddenAt = 0;
      }
    };
    // bfcache restore (iOS back/forward, app switcher): the page resumes with
    // whatever render it was frozen with — same stale-date problem applies.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
  return tick;
}
