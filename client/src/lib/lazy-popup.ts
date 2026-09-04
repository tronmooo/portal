// ── lazyPopup — the shared way to load a drill-down panel on demand ──────────
//
// Drill-down popups are the heaviest components in the app (HeroKPIPopups and
// MoneyPopups pull recharts; TaskHabitPopups and BriefingPopups are large forms)
// and the least likely to be used on any given app open. Importing one
// statically puts its whole chunk on the critical path of whatever page renders
// it — the page cannot paint until code for a dialog nobody has opened has been
// downloaded and parsed.
//
// This helper was written for HubKpiStrip (which is in the eager bundle) and is
// now shared: ExecutiveBriefing and the dashboard page use the identical
// pattern, since each of them renders the same popups.
//
// FAIL-SAFE: if the chunk fetch fails (typical cause: a stale cached index.html
// referencing renamed chunk files right after a deploy), navigate to the
// module's own page instead of silently rendering nothing.
import { lazy } from "react";
import type { ComponentType } from "react";
import { hashNavigate } from "@/lib/hashNavigate";

export function lazyPopup<T>(
  load: () => Promise<T>,
  pick: (m: T) => ComponentType<any>,
  fallbackRoute: string,
): ComponentType<any> {
  return lazy(() =>
    load().then(m => ({ default: pick(m) })).catch(() => ({
      default: (() => { hashNavigate(fallbackRoute); return null; }) as ComponentType<any>,
    })),
  );
}
