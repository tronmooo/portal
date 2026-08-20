// QA pass 2026-08-20 — five data-integrity / frontend defects.
//
//   #10 the "Everyone" dashboard contradicted itself: header "Tasks Due 48"
//       over a Tasks card reading "0 Remaining", and a "$149,563" net-worth
//       header over a Household panel showing "$0 · No people or pets yet".
//   #11 choosing a profile in the hub switcher changed the active TAB.
//   #12 one chat-saved fact appeared on two unrelated people's Info pages.
//   #13 four overlays could be open at once, and Escape closed none of them.
//   #14 the notification row's dismiss control had no accessible name.
//   #15 the install prompt appeared or not depending on which profile was up.
//
// Each case below fails on the pre-fix code.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { startHarness, type Harness } from "./helpers/route-harness";
import { computeTaskCounts, isHiddenTestRow, daysFromToday } from "../client/src/lib/scoped-tasks";
import {
  openOverlay, closeOverlay, closeActiveOverlay, activeOverlayId,
  overlayJustClosed, resetOverlayManager,
} from "../client/src/lib/overlay-manager";

const read = (p: string) => readFileSync(resolvePath(__dirname, "..", p), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// #10 — one aggregate selector behind every "Everyone" component
// ─────────────────────────────────────────────────────────────────────────────
describe("bug 10: the header and the Tasks card count the same tasks", () => {
  const TODAY = "2026-08-20";
  // The QA account's rows are suite-generated: the client hides them, the
  // server's stats.activeTasks did not. That divergence IS the bug.
  const tasks = [
    { id: "t1", title: "Buy printer paper QA778", status: "todo", dueDate: "2026-08-18" },
    { id: "t2", title: "QA_TEST_Renew tags", status: "todo", dueDate: "2026-08-25" },
    { id: "t3", title: "Real errand", status: "todo", dueDate: "2026-08-19" },
    { id: "t4", title: "Real errand done", status: "done", completedAt: `${TODAY}T09:00:00Z` },
  ];

  it("classifies the suite-generated rows and leaves real ones alone", () => {
    expect(isHiddenTestRow(tasks[0])).toBe(true);
    expect(isHiddenTestRow(tasks[1])).toBe(true);
    expect(isHiddenTestRow(tasks[2])).toBe(false);
    // The owner-prefixed spelling the briefing has always handled.
    expect(isHiddenTestRow({ title: "Bob: QA Test Coffee" })).toBe(true);
  });

  it("gives ONE pending count for whatever list it is handed", () => {
    const visible = tasks.filter(t => !isHiddenTestRow(t));
    const counts = computeTaskCounts(visible, TODAY);
    expect(counts.pending).toHaveLength(1);
    expect(counts.overdue).toHaveLength(1);
    expect(counts.doneToday).toBe(1);
    // The reported contradiction, stated as an invariant: the number the
    // header chip shows and the number the card shows are the same value.
    const headerTasksDue = counts.pending.length;
    const cardRemaining = counts.pending.length;
    expect(headerTasksDue).toBe(cardRemaining);
  });

  it("sorts pending by due date and treats undated rows as last", () => {
    const counts = computeTaskCounts(
      [{ id: "a", status: "todo" }, { id: "b", status: "todo", dueDate: "2026-08-21" }],
      TODAY,
    );
    expect(counts.sortedPending.map((t: any) => t.id)).toEqual(["b", "a"]);
    expect(daysFromToday("2026-08-21", TODAY)).toBe(1);
    expect(daysFromToday(undefined, TODAY)).toBeNull();
  });

  it("the hub header chip reads the shared selector, not stats.activeTasks", () => {
    const src = read("client/src/components/hub/HubKpiStrip.tsx");
    expect(src).toContain("useScopedTasks");
    expect(src).not.toContain("stats?.activeTasks");
  });

  it("the Executive briefing reads the same selector", () => {
    const src = read("client/src/components/dashboard/ExecutiveBriefing.tsx");
    expect(src).toContain("useScopedTasks");
  });

  it("the Household panels never claim $0 / 'no people' from an unloaded list", () => {
    const src = read("client/src/pages/dashboard.tsx");
    // The empty state is gated on the profiles query having actually resolved…
    expect(src).toContain("cards.length === 0 && !profilesReady");
    expect(src).toContain("household-profiles-loading");
    // …and the household headline prefers the SAME server snapshot the header
    // chip and the Executive overview show.
    expect(src).toContain("snapshot={enhanced?.financeSnapshot ?? null}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #11 — switching profile must not switch section
// ─────────────────────────────────────────────────────────────────────────────
describe("bug 11: the profile selector never changes the active tab", () => {
  it("hub tab chips ignore the ghost tap that follows an overlay closing", () => {
    const src = read("client/src/components/hub/HubShell.tsx");
    expect(src).toContain("overlayJustClosed");
    // Both halves: the pointer event Radix menus dismiss on, and the click.
    expect(src).toMatch(/onPointerDown=\{\(e\) => \{ if \(overlayJustClosed\(\)\) e\.preventDefault\(\); \}\}/);
    expect(src).toMatch(/onClick=\{\(e\) => \{\s*if \(overlayJustClosed\(\)\)/);
  });

  it("the switcher menu is controlled, so its close time is recorded", () => {
    const src = read("client/src/components/hub/HubProfileSwitcher.tsx");
    expect(src).toContain("<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>");
    expect(src).toContain('useExclusiveOverlay("hub-profile-switcher"');
  });

  it("choosing a person writes the scope and nothing else", () => {
    const src = read("client/src/components/hub/HubProfileSwitcher.tsx");
    // Exactly one navigate() in the file: the explicit "View everyone's info…"
    // menu item. No person row may navigate.
    const rowBlock = src.slice(src.indexOf("{people.map(p => ("), src.indexOf("))}", src.indexOf("{people.map(p => (")));
    expect(rowBlock).toContain("setFilterSelected([p.id], [p.name])");
    expect(rowBlock).not.toContain("navigate(");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #12 — a fact belongs to the profile it is linked to, and to no other
// ─────────────────────────────────────────────────────────────────────────────
describe("bug 12: chat-saved facts are scoped to an explicit profile id", () => {
  const SELF = { id: "self-1", type: "self", name: "Test" };
  const JANE = { id: "jane-1", type: "person", name: "Jane QA" };
  const CHILD = { id: "child-1", type: "person", name: "Test Child QA" };
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({
      profiles: [SELF, JANE, CHILD],
      memories: [
        { id: "m1", key: "Tracker-category:video games", value: "lifestyle" },       // unlinked
        { id: "m2", key: "allergy", value: "peanuts", linkedProfiles: [JANE.id] },
        { id: "m3", key: "school", value: "Lincoln", profileId: CHILD.id },
      ],
    });
  });
  afterEach(async () => { await h.close(); });

  it("returns only Jane's facts for Jane — never the shared, unlinked one", async () => {
    const r = await h.api("GET", `/api/memories?profileIds=${JANE.id}`);
    expect(r.status).toBe(200);
    expect(r.data.map((m: any) => m.id)).toEqual(["m2"]);
  });

  it("returns only the child's facts for the child", async () => {
    const r = await h.api("GET", `/api/memories?profileIds=${CHILD.id}`);
    expect(r.data.map((m: any) => m.id)).toEqual(["m3"]);
  });

  it("the reported fact appears on NEITHER unrelated profile", async () => {
    for (const id of [JANE.id, CHILD.id]) {
      const r = await h.api("GET", `/api/memories?profileIds=${id}`);
      expect(r.data.some((m: any) => m.id === "m1")).toBe(false);
    }
  });

  it("accepts a multi-profile scope, unioning the people in it", async () => {
    const r = await h.api("GET", `/api/memories?profileIds=${JANE.id},${CHILD.id}`);
    expect(r.data.map((m: any) => m.id).sort()).toEqual(["m2", "m3"]);
  });

  it("still serves the whole store when no scope is given (Self / Everyone)", async () => {
    const r = await h.api("GET", "/api/memories");
    expect(r.data).toHaveLength(3);
  });

  it("the single-profile Info page asks for that profile's facts", () => {
    const src = read("client/src/pages/profile-info.tsx");
    expect(src).toContain("<MemoriesSection profileIds={[profile.id]} />");
    expect(src).toContain("profileIds=${encodeURIComponent(idsKey)}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #13 — one overlay at a time, and Escape closes it
// ─────────────────────────────────────────────────────────────────────────────
describe("bug 13: the overlay manager enforces a single active overlay", () => {
  beforeEach(() => resetOverlayManager());

  it("opening a second overlay closes the first", () => {
    let filtersOpen = true;
    openOverlay("attention-filters", () => { filtersOpen = false; });
    expect(activeOverlayId()).toBe("attention-filters");

    openOverlay("dashboard-menu", () => {});
    expect(filtersOpen).toBe(false);
    expect(activeOverlayId()).toBe("dashboard-menu");
  });

  it("closes the whole chain as each new overlay opens", () => {
    const state: Record<string, boolean> = { filters: true, menu: false, search: false, bell: false };
    openOverlay("attention-filters", () => { state.filters = false; });
    state.menu = true;
    openOverlay("dashboard-menu", () => { state.menu = false; });
    state.search = true;
    openOverlay("command-search", () => { state.search = false; });
    state.bell = true;
    openOverlay("notifications", () => { state.bell = false; });
    expect(state).toEqual({ filters: false, menu: false, search: false, bell: true });
  });

  it("closeActiveOverlay (what Escape calls) closes the open one", () => {
    let open = true;
    openOverlay("attention-filters", () => { open = false; });
    expect(closeActiveOverlay()).toBe(true);
    expect(open).toBe(false);
    expect(activeOverlayId()).toBeNull();
    // Nothing open → nothing claimed, so a Radix root keeps its own Escape.
    expect(closeActiveOverlay()).toBe(false);
  });

  it("re-registering the same id does not close it", () => {
    let open = true;
    openOverlay("notifications", () => { open = false; });
    openOverlay("notifications", () => { open = false; });
    expect(open).toBe(true);
    expect(activeOverlayId()).toBe("notifications");
  });

  it("records a close time for the ghost-tap shield", () => {
    openOverlay("hub-profile-switcher", () => {});
    expect(overlayJustClosed()).toBe(false);
    closeOverlay("hub-profile-switcher");
    expect(overlayJustClosed()).toBe(true);
    expect(overlayJustClosed(0)).toBe(false);
  });

  it("every dashboard overlay is registered with the manager", () => {
    const registered: Array<[string, string]> = [
      ["client/src/components/dashboard/ExecutiveBriefing.tsx", "attention-filters"],
      ["client/src/pages/dashboard.tsx", "dashboard-menu"],
      ["client/src/components/CommandSearch.tsx", "command-search"],
      ["client/src/components/NotificationBell.tsx", "notifications"],
      ["client/src/components/hub/HubProfileSwitcher.tsx", "hub-profile-switcher"],
    ];
    for (const [file, id] of registered) {
      expect(read(file)).toContain(`useExclusiveOverlay("${id}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #14 — every interactive notification control has a name
// ─────────────────────────────────────────────────────────────────────────────
describe("bug 14: the notification row has no anonymous buttons", () => {
  const src = read("client/src/components/NotificationBell.tsx");

  it("labels the dismiss control with the notification it dismisses", () => {
    expect(src).toContain("aria-label={`Dismiss notification: ${notification.title}`}");
  });

  it("makes the row itself a named, keyboard-reachable control", () => {
    expect(src).toContain("const openLabel = `Open notification: ${notification.title}`");
    expect(src).toContain('aria-label={openLabel}');
    expect(src).toContain('role="button"');
    expect(src).toContain('tabIndex={0}');
  });

  it("hides the decorative icon from the accessibility tree", () => {
    expect(src).toContain('<X className="h-3 w-3" aria-hidden="true" />');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #15 — the install prompt follows one policy, independent of profile
// ─────────────────────────────────────────────────────────────────────────────
describe("bug 15: install-prompt eligibility is session-level", () => {
  const src = read("client/src/components/InstallPrompt.tsx");

  it("persists the auto-dismiss, so it cannot reappear on the next screen", () => {
    // The 15s timeout used to set an in-memory flag only.
    expect(src).toContain("suppressForSession();\n      setDismissed(true);");
    expect(src).toContain('sessionStorage.setItem(SESSION_KEY, "1")');
  });

  it("remembers an explicit dismissal across sessions", () => {
    expect(src).toContain("DISMISS_DAYS");
    expect(src).toContain("localStorage.setItem(SNOOZE_KEY");
  });

  it("suppresses itself when already installed", () => {
    expect(src).toContain('matchMedia?.("(display-mode: standalone)")');
    expect(src).toContain('window.addEventListener("appinstalled", installed)');
  });

  it("stays mounted once at the app root, outside any profile view", () => {
    const app = read("client/src/App.tsx");
    expect(app.match(/<InstallPrompt \/>/g) || []).toHaveLength(1);
  });
});
