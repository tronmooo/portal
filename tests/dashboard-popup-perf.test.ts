// ── Dashboard popup performance invariants ──────────────────────────────────
// Source-level guards for the four regressions that made popups feel slow.
// They are asserted against the source text because each one is a *structural*
// property — "this component is not in the tree while closed", "this module is
// not on the dashboard's static import graph" — that a render test cannot see.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const dashboard = readFileSync("client/src/pages/dashboard.tsx", "utf8");
const taskHabit = readFileSync("client/src/components/dashboard/TaskHabitPopups.tsx", "utf8");
const briefing = readFileSync("client/src/components/dashboard/ExecutiveBriefing.tsx", "utf8");
const briefingPopups = readFileSync("client/src/components/dashboard/BriefingPopups.tsx", "utf8");
const popupHost = readFileSync("client/src/components/dashboard/popups/PopupHost.tsx", "utf8");

describe("panels are lazily loaded, never statically imported by the dashboard", () => {
  it("dashboard.tsx imports no popup module directly", () => {
    // A single static import puts the whole popup module back on the critical
    // path: it is then fetched and parsed before the dashboard's first paint.
    for (const mod of ["TaskHabitPopups", "BriefingPopups", "HeroKPIPopups"]) {
      expect(dashboard, `${mod} must not be statically imported by dashboard.tsx`)
        .not.toMatch(new RegExp(`^import .*from ["'].*${mod}["']`, "m"));
    }
  });

  it("ExecutiveBriefing imports no popup module directly", () => {
    for (const mod of ["TaskHabitPopups", "BriefingPopups", "HeroKPIPopups"]) {
      expect(briefing, `${mod} must not be statically imported by ExecutiveBriefing`)
        .not.toMatch(new RegExp(`^import .*from ["'].*${mod}["']`, "m"));
    }
  });

  it("PopupHost reaches every panel through a dynamic import()", () => {
    for (const mod of ["TaskHabitPopups", "BriefingPopups", "HeroKPIPopups"]) {
      expect(popupHost).toContain(`import("@/components/dashboard/${mod}")`);
    }
    expect(popupHost).not.toMatch(/^import \{[^}]*Popup[^}]*\} from/m);
  });
});

describe("panels mount only while open", () => {
  it("no panel is rendered with an open={...} prop instead of being unmounted", () => {
    // The old shape — `<TasksPopup open={popup === "tasks"} .../>` — kept the
    // component (and its hooks, queries and mutations) in the tree permanently,
    // re-rendering on every dashboard render while invisible.
    const offenders = [...dashboard.matchAll(/<(\w*Popup|\w*Panel)\s+open=\{[^}]+\}/g)].map(m => m[0]);
    expect(offenders).toEqual([]);
  });

  it("PopupHost returns null before any panel is requested", () => {
    expect(popupHost).toMatch(/if \(!request\) return null;/);
  });
});

describe("opening a panel does not throw away warm cache", () => {
  it("TaskHabitPopups no longer invalidates its list on open", () => {
    // `useEffect(() => { if (open) invalidateQueries(["/api/tasks"]) }, [open])`
    // forced a network round-trip — and therefore a spinner — on EVERY open,
    // discarding the identical rows the briefing had just fetched.
    expect(taskHabit).not.toMatch(/if \(open\)[^\n]*invalidateQueries/);
    expect(taskHabit).toContain("useSeededScopedList");
  });

  it("seeded reads carry initialDataUpdatedAt so staleness stays correct", () => {
    const seeded = readFileSync("client/src/components/dashboard/popups/useSeededList.ts", "utf8");
    expect(seeded).toContain("initialData");
    // Without this, seeded rows look brand new and would never refetch.
    expect(seeded).toContain("initialDataUpdatedAt");
  });
});

describe("panel queries are gated on open", () => {
  it("useOwnerNames takes an enabled flag and every call site passes `open`", () => {
    expect(briefingPopups).toMatch(/function useOwnerNames\(enabled = true\)/);
    expect(briefingPopups).toContain("staleTime: 60_000, enabled });");
    // The ungated form fetched /api/profiles for every popup in the tree.
    expect(briefingPopups).not.toContain("useOwnerNames();");
  });

  it("every list query inside the popups is gated on open", () => {
    const ungated = [...briefingPopups.matchAll(/useQuery<[^>]*>\(\{[^}]*queryKey: \["\/api\/[^"]+"\][^}]*\}\)/g)]
      .map(m => m[0])
      .filter(q => !q.includes("enabled"));
    expect(ungated).toEqual([]);
  });
});

describe("intent prefetch is wired", () => {
  it("the registry warms both the chunk and the queries", () => {
    const registry = readFileSync("client/src/components/dashboard/popups/registry.ts", "utf8");
    expect(registry).toContain("def.load()");
    expect(registry).toContain("def.prefetch?.(qc, scope)");
    expect(registry).toContain("requestIdleCallback");
  });

  it("panel triggers fire prefetch on pointerdown, before the click resolves", () => {
    expect(popupHost).toContain("onPointerDown");
    expect(popupHost).toContain("onTouchStart");
  });
});
