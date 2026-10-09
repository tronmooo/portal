// @vitest-environment jsdom
//
// ASSET NAVIGATION REGRESSION (user report 2026-10-09).
//
//   "I pressed on bubbles and now all my assets are missing."
//
// The account in the report owned five assets. The Assets tab showed one —
// the iPhone 17 Pro Max, the only asset with something nested under it (a
// Refrigerator). One tap on the "Has children" chip did that, and then:
//   · the filter was kept in sessionStorage, so it came back on every visit;
//   · the chip row was rendered only when it had more than one option, and its
//     options were counted AFTER the filter — one asset left, one option, so
//     the row (and its "All Types" reset) vanished with the filter still on.
// Nothing was deleted. Nothing on screen said a filter was hiding four assets.
//
// This renders the REAL Assets tab (client/src/pages/trackers.tsx) against a
// stubbed API and proves, for every chip on it:
//   1. every asset still exists after pressing it and navigating away/back,
//   2. ownership is untouched,
//   3. not one DELETE / PATCH / PUT / POST was sent,
//   4. an active filter is always visible and clearable, and an all-hidden
//      result never reads "No assets yet",
//   5. a temporary filter does not survive navigation between sections.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import TrackersPage from "../client/src/pages/trackers";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";

const SELF = "11111111-1111-4111-8111-111111111111";
const JOE = "22222222-2222-4222-8222-222222222222";
const IPHONE17 = "a0000000-0000-4000-8000-000000000001";
const IPHONE8 = "a0000000-0000-4000-8000-000000000002";
const FRIDGE = "a0000000-0000-4000-8000-000000000003";
const ASUS = "a0000000-0000-4000-8000-000000000004";
const HONDA = "a0000000-0000-4000-8000-000000000005";

function profilesFixture() {
  const base = { tags: [], notes: "", documents: [], createdAt: "2026-04-01T00:00:00Z", updatedAt: "2026-10-09T18:57:00Z" };
  return [
    { ...base, id: SELF, name: "Robert", type: "self", fields: {}, linkedProfiles: [], parentProfileId: null },
    { ...base, id: JOE, name: "Joe", type: "person", fields: {}, linkedProfiles: [], parentProfileId: null },
    { ...base, id: IPHONE17, name: "iPhone 17 Pro Max", type: "asset", fields: { currentValue: 911 }, parentProfileId: SELF, linkedProfiles: [SELF] },
    { ...base, id: IPHONE8, name: "iPhone 8", type: "asset", fields: { currentValue: 85 }, parentProfileId: SELF, linkedProfiles: [SELF] },
    { ...base, id: FRIDGE, name: "Refrigerator", type: "asset", fields: { currentValue: 1200 }, parentProfileId: IPHONE17, linkedProfiles: [SELF] },
    { ...base, id: ASUS, name: "Asus zenbook", type: "asset", fields: { currentValue: 500 }, parentProfileId: SELF, linkedProfiles: [SELF] },
    { ...base, id: HONDA, name: "Honda CR-V 2021", type: "vehicle", fields: { currentValue: 22000 }, parentProfileId: SELF, linkedProfiles: [SELF] },
  ];
}
const ASSET_NAMES = ["iPhone 17 Pro Max", "iPhone 8", "Refrigerator", "Asus zenbook", "Honda CR-V 2021"];

let writes: Array<{ method: string; url: string }> = [];
let profilesServed: any[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  writes = [];
  profilesServed = profilesFixture();
  try { sessionStorage.clear(); localStorage.clear(); } catch { /* ignore */ }
  queryClient.clear();
  setFilterEveryone();
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    if (method !== "GET") { writes.push({ method, url }); return json({ ok: true }); }
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/profiles") return json(profilesServed);
    if (path === "/api/dashboard-enhanced") {
      return json({ financeSnapshot: { assetBreakdown: profilesServed.filter(p => p.type !== "self" && p.type !== "person").map(p => ({ id: p.id })), liabilityBreakdown: [] } });
    }
    if (path === "/api/valuations/status") return json({ rows: [] });
    return json([]);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A router whose location the test can move, mirrored into window.location (the page reads ?tab= from it). */
function renderAt(initial: string) {
  // ONE location store for every useLocation() caller on the page.
  let current = initial;
  const listeners = new Set<() => void>();
  const setLoc = (l: string) => { current = l; window.history.replaceState(null, "", l); listeners.forEach(fn => fn()); };
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  // The app's hash router reports the query too ("/linked?tab=assets"),
  // which is what moves the page between sections.
  function useTestLocation(): [string, (to: string) => void] {
    const loc = React.useSyncExternalStore(subscribe, () => current);
    return [loc, setLoc];
  }
  window.history.replaceState(null, "", initial);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useTestLocation as any}><TrackersPage /></Router>
    </QueryClientProvider>,
  );
  return { ...utils, navigate: (l: string) => act(() => setLoc(l)) };
}

async function expectAllAssetsVisible() {
  for (const name of ASSET_NAMES) {
    await waitFor(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0));
  }
}

function snapshotOwnership() {
  return profilesServed.map(p => `${p.id}:${p.parentProfileId}:${(p.linkedProfiles || []).join(",")}`).join("|");
}

describe("asset navigation regression — pressing chips never loses assets", () => {
  it("every asset is listed on arrival", async () => {
    renderAt("/linked?tab=assets");
    await expectAllAssetsVisible();
    expect(writes).toEqual([]);
  });

  it("'Has children' hides four assets VISIBLY: the notice says so, the chip row stays, Clear restores them", async () => {
    const ownershipBefore = snapshotOwnership();
    renderAt("/linked?tab=assets");
    await expectAllAssetsVisible();

    fireEvent.click(screen.getByTestId("filter-asset-nesting-hasChildren"));

    // Only the iPhone has a child — exactly the screenshot.
    await waitFor(() => expect(screen.queryByText("Asus zenbook")).toBeNull());
    expect(screen.getAllByText("iPhone 17 Pro Max").length).toBeGreaterThan(0);
    // ...but the screen says what happened and how to undo it.
    const notice = screen.getByTestId("assets-active-filter");
    expect(notice.textContent).toContain("Showing 1 of 5 assets");
    expect(notice.textContent).toContain("Has children");
    // The chip row did NOT hide itself with the filter still on (the bug).
    expect(screen.getByTestId("category-filter-chips-assets")).toBeTruthy();

    fireEvent.click(screen.getByTestId("assets-active-filter-clear"));
    await expectAllAssetsVisible();
    expect(screen.queryByTestId("assets-active-filter")).toBeNull();

    expect(writes).toEqual([]);
    expect(snapshotOwnership()).toBe(ownershipBefore);
  });

  it("presses every chip on the tab: no write is ever sent and every asset survives", async () => {
    const ownershipBefore = snapshotOwnership();
    renderAt("/linked?tab=assets");
    await expectAllAssetsVisible();
    const chips = Array.from(screen.getByTestId("category-filter-chips-assets").querySelectorAll("button"));
    expect(chips.length).toBeGreaterThan(2);
    for (const label of chips.map(c => c.textContent || "")) {
      const chip = Array.from(screen.getByTestId("category-filter-chips-assets").querySelectorAll("button")).find(c => c.textContent === label);
      if (chip) fireEvent.click(chip);
      // Whatever the chip does, either rows are on screen or the empty state
      // says they are FILTERED — never "No assets or vehicles yet".
      expect(screen.queryByTestId("assets-empty")).toBeNull();
      // and the way back is always on screen while anything is hidden.
      const notice = screen.queryByTestId("assets-active-filter");
      if (notice) expect(screen.getByTestId("assets-active-filter-clear")).toBeTruthy();
    }
    const clear = screen.queryByTestId("assets-active-filter-clear");
    if (clear) fireEvent.click(clear);
    await expectAllAssetsVisible();
    expect(writes).toEqual([]);
    expect(snapshotOwnership()).toBe(ownershipBefore);
  });

  it("a filter that hides every asset shows a filtered empty state, never 'No assets yet'", async () => {
    // No asset is nested under another one here, so "Nested" hides them all.
    profilesServed = profilesFixture().map(p => (p.id === FRIDGE ? { ...p, parentProfileId: SELF } : p));
    renderAt("/linked?tab=assets");
    await expectAllAssetsVisible();
    fireEvent.click(screen.getByTestId("filter-asset-nesting-nested"));
    const empty = await screen.findByTestId("assets-filtered-empty");
    expect(empty.textContent).toContain("hidden, not deleted");
    expect(screen.queryByTestId("assets-empty")).toBeNull();
    fireEvent.click(screen.getByTestId("assets-filtered-empty-clear"));
    await expectAllAssetsVisible();
  });

  it("leaving the Assets tab and coming back restores the full persistent list (the filter is not carried)", async () => {
    const { navigate } = renderAt("/linked?tab=assets");
    await expectAllAssetsVisible();
    fireEvent.click(screen.getByTestId("filter-asset-nesting-hasChildren"));
    await waitFor(() => expect(screen.queryByText("Asus zenbook")).toBeNull());

    navigate("/linked?tab=documents");
    await waitFor(() => expect(screen.queryByTestId("category-filter-chips-assets")).toBeNull());
    navigate("/linked?tab=assets");

    await expectAllAssetsVisible();
    expect(screen.queryByTestId("assets-active-filter")).toBeNull();
    // Never persisted: a reload cannot bring it back either.
    expect(sessionStorage.getItem("portol_asset_nesting_filter")).toBeNull();
    expect(writes).toEqual([]);
  });

  it("a nesting filter left in sessionStorage by an older build is discarded, not applied", async () => {
    sessionStorage.setItem("portol_asset_nesting_filter", "hasChildren");
    renderAt("/linked?tab=assets");
    await expectAllAssetsVisible();
    expect(sessionStorage.getItem("portol_asset_nesting_filter")).toBeNull();
  });

  it("opening the page writes nothing — not even an ownership 'migration' for unlinked trackers", async () => {
    vi.mocked(fetch as any).mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      if (method !== "GET") { writes.push({ method, url }); return json({ ok: true }); }
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (path === "/api/profiles") return json(profilesServed);
      // An ownerless tracker used to trigger POST /api/trackers/migrate-to-self on mount.
      if (path === "/api/trackers") return json([{ id: "t1", name: "Weight", category: "health", fields: [], entries: [], linkedProfiles: [] }]);
      return json([]);
    });
    renderAt("/trackers");
    // The ownerless tracker is listed (under Self, by the canonical rule)...
    await waitFor(() => expect(screen.getAllByText(/without entries/).length).toBeGreaterThan(0));
    await new Promise(r => setTimeout(r, 50));
    expect(writes).toEqual([]);
  });
});

// ── Every section, not just Assets ────────────────────────────────────────
// The same page renders Liabilities, Documents and Trackers with their own
// chip rows. Each one must obey the same rules: pressing chips writes nothing,
// a filter is always clearable, and leaving the section drops it.
describe("every section of the page: chips are presentation only", () => {
  const LIABS = [
    { id: "l0000000-0000-4000-8000-000000000001", name: "Chase Sapphire", type: "liability", fields: { subtype: "credit_card", currentBalance: 1200 }, parentProfileId: SELF, linkedProfiles: [SELF], tags: [], notes: "", documents: [], createdAt: "2026-04-01T00:00:00Z" },
    { id: "l0000000-0000-4000-8000-000000000002", name: "Honda Auto Loan", type: "liability", fields: { subtype: "auto_loan", currentBalance: 9000 }, parentProfileId: SELF, linkedProfiles: [SELF], tags: [], notes: "", documents: [], createdAt: "2026-04-01T00:00:00Z" },
  ];
  const DOCS = [
    { id: "d1", name: "Passport", type: "passport", linkedProfiles: [SELF], extractedData: {}, tags: [], createdAt: "2026-04-01T00:00:00Z" },
    { id: "d2", name: "Home Depot Receipt", type: "receipt", linkedProfiles: [SELF], extractedData: {}, tags: [], createdAt: "2026-04-01T00:00:00Z" },
  ];
  const TRACKERS = [
    { id: "t1", name: "Weight", category: "health", unit: "lb", fields: [{ name: "value", type: "number", isPrimary: true }], entries: [{ id: "e1", timestamp: "2026-10-08T12:00:00Z", values: { value: 180 } }], linkedProfiles: [SELF] },
    { id: "t2", name: "Running", category: "fitness", unit: "mi", fields: [{ name: "distance", type: "number", isPrimary: true }], entries: [{ id: "e2", timestamp: "2026-10-08T12:00:00Z", values: { distance: 3 } }], linkedProfiles: [SELF] },
  ];

  beforeEach(() => {
    profilesServed = [...profilesFixture(), ...LIABS];
    vi.mocked(fetch as any).mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      if (method !== "GET") { writes.push({ method, url }); return json({ ok: true }); }
      const p = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (p === "/api/profiles") return json(profilesServed);
      if (p === "/api/documents") return json(DOCS);
      if (p === "/api/trackers") return json(TRACKERS);
      if (p === "/api/valuations/status") return json({ rows: [] });
      if (p === "/api/dashboard-enhanced") return json({ financeSnapshot: { assetBreakdown: [], liabilityBreakdown: LIABS.map(l => ({ id: l.id })) } });
      return json([]);
    });
  });

  const SECTIONS = [
    { tab: "liabilities", row: "category-filter-chips-liabilities", names: ["Chase Sapphire", "Honda Auto Loan"] },
    { tab: "documents", row: "category-filter-chips-documents", names: ["Passport", "Home Depot Receipt"] },
    { tab: "trackers", row: "category-filter-chips-trackers", names: ["Weight", "Running"] },
  ] as const;

  for (const sec of SECTIONS) {
    it(`${sec.tab}: every chip, then away and back — nothing written, every record still listed`, async () => {
      const { navigate } = renderAt(`/linked?tab=${sec.tab}`);
      for (const n of sec.names) await waitFor(() => expect(screen.getAllByText(new RegExp(n)).length).toBeGreaterThan(0));
      const labels = Array.from(screen.getByTestId(sec.row).querySelectorAll("button")).map(b => b.textContent || "");
      expect(labels.length).toBeGreaterThan(1);
      for (const label of labels) {
        const chip = Array.from(screen.getByTestId(sec.row).querySelectorAll("button")).find(b => b.textContent === label);
        if (chip) fireEvent.click(chip);
        // While anything is filtered, the row (and its reset) stays on screen.
        expect(screen.getByTestId(sec.row)).toBeTruthy();
      }
      // Leave the section with a filter possibly on, and come back.
      navigate("/linked?tab=assets");
      await waitFor(() => expect(screen.queryByTestId(sec.row)).toBeNull());
      navigate(`/linked?tab=${sec.tab}`);
      for (const n of sec.names) await waitFor(() => expect(screen.getAllByText(new RegExp(n)).length).toBeGreaterThan(0));
      expect(writes).toEqual([]);
    });
  }
});
