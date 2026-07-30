// @vitest-environment jsdom
//
// UI-level verification for the QA report of 2026-07-29.
//
// The route tests prove the server does the right thing; these prove the
// screens the tester was actually looking at do too — the amount field that
// accepted $10B, the "Profile" select that filed against the wrong person, the
// calendar tiles that read 0 with items on the day, and the bell whose count
// ran 7 → 8 → 20 → 19 → 7.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Shared mocks ────────────────────────────────────────────────────────────
const { apiRequest, toastFn } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => new Response("{}", { status: 200 })),
  toastFn: vi.fn(),
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient(),
    apiRequest,
    BROWSER_TIMEZONE: "America/Los_Angeles",
    recoverWedgedQueries: vi.fn(),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastFn }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(), invalidateDomains: vi.fn() }));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-001 + PROP-005 — the Add Expense dialog
// ─────────────────────────────────────────────────────────────────────────────
describe("Add Expense dialog (EDGE-001, PROP-005, EDGE-003)", () => {
  const PROFILES = [
    { id: "self-1", type: "self", name: "Test" },
    { id: "mike-1", type: "person", name: "Mike" },
  ];

  // The dialog defers its profile fetch to an idle callback; run it inline so
  // the owner select is present without a timing race in the test.
  beforeEach(() => {
    (window as any).requestIdleCallback = (cb: any) => { cb(); return 1; };
    (window as any).cancelIdleCallback = () => {};
  });

  async function openDialog(scopeIds: string[]) {
    // Reset first: without it the dialog module stays cached from the previous
    // test and keeps that test's scope mock, so a scope assertion would pass or
    // fail for the wrong reason.
    vi.resetModules();
    vi.doMock("@/hooks/useProfileScope", () => ({
      useProfileScope: () => ({
        mode: scopeIds.length ? "selected" : "everyone",
        selectedIds: scopeIds,
        selectedNames: [],
        isFiltered: scopeIds.length > 0,
      }),
      useActiveCreateProfileId: () => scopeIds[0] || "",
      resolveActiveCreateProfileId: () => scopeIds[0] || "",
    }));
    const { QuickAddDialog } = await import("@/components/dashboard/quick-add/QuickAddDialog");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["/api/profiles"], PROFILES);
    return render(
      <QueryClientProvider client={qc}>
        <QuickAddDialog open kind="expense" ownerProfileId="" onClose={() => {}} />
      </QueryClientProvider>,
    );
  }

  it("refuses $10,000,000,000 inline and never calls the API", async () => {
    await openDialog(["self-1"]);
    fireEvent.change(screen.getByTestId("input-quick-add-expense-text"), { target: { value: "QA big" } });
    fireEvent.change(screen.getByTestId("input-quick-add-expense-amount"), { target: { value: "1e10" } });
    fireEvent.click(screen.getByTestId("btn-quick-add-expense-save"));
    expect((await screen.findByTestId("error-quick-add-expense")).textContent).toMatch(/less than/i);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("asks before saving an amount over $1,000,000, then saves on the second press", async () => {
    apiRequest.mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 201 }));
    await openDialog(["self-1"]);
    fireEvent.change(screen.getByTestId("input-quick-add-expense-text"), { target: { value: "House" } });
    fireEvent.change(screen.getByTestId("input-quick-add-expense-amount"), { target: { value: "2500000" } });

    fireEvent.click(screen.getByTestId("btn-quick-add-expense-save"));
    expect(await screen.findByTestId("warn-quick-add-expense-large")).toBeTruthy();
    expect(apiRequest).not.toHaveBeenCalled(); // first press only warns

    fireEvent.click(screen.getByTestId("btn-quick-add-expense-save"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
  });

  it("saves an ordinary amount without asking anything", async () => {
    apiRequest.mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 201 }));
    await openDialog(["self-1"]);
    fireEvent.change(screen.getByTestId("input-quick-add-expense-text"), { target: { value: "Coffee" } });
    fireEvent.change(screen.getByTestId("input-quick-add-expense-amount"), { target: { value: "12.34" } });
    fireEvent.click(screen.getByTestId("btn-quick-add-expense-save"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
    const [, , body] = apiRequest.mock.calls[0] as any[];
    expect(body.amount).toBe(12.34);
  });

  it("posts the row against the profile in scope, not the self profile (PROP-005)", async () => {
    apiRequest.mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 201 }));
    await openDialog(["mike-1"]); // Mike is the active profile
    fireEvent.change(screen.getByTestId("input-quick-add-expense-text"), { target: { value: "Gas" } });
    fireEvent.change(screen.getByTestId("input-quick-add-expense-amount"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("btn-quick-add-expense-save"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
    const [, , body] = apiRequest.mock.calls[0] as any[];
    expect(body.linkedProfiles).toEqual(["mike-1"]);
  });

  it("names the destination, so the owner field cannot be read as the scope control", async () => {
    await openDialog(["mike-1"]);
    expect(screen.getByText(/whose is this/i)).toBeTruthy();
    expect(screen.getByText(/saved to mike's records/i)).toBeTruthy();
  });

  it("surfaces the server's sanitize warning instead of the description (EDGE-003)", async () => {
    apiRequest.mockResolvedValue(new Response(
      JSON.stringify({ id: "e1", warning: "Some unsafe formatting was removed from your text." }),
      { status: 201 },
    ));
    await openDialog(["self-1"]);
    fireEvent.change(screen.getByTestId("input-quick-add-expense-text"), { target: { value: "Coffee <script>x</script>" } });
    fireEvent.change(screen.getByTestId("input-quick-add-expense-amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("btn-quick-add-expense-save"));
    await waitFor(() => expect(toastFn).toHaveBeenCalled());
    expect(toastFn.mock.calls.at(-1)![0].description).toMatch(/removed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UX-001 — Calendar TODAY read 0 while the Day view listed two loan payments
// ─────────────────────────────────────────────────────────────────────────────
describe("Calendar summary tiles (UX-001)", () => {
  const today = new Date().toLocaleDateString("en-CA");

  beforeEach(() => {
    vi.doMock("@/components/CalendarView", () => ({ default: () => <div data-testid="grid" /> }));
    vi.doMock("@/components/recurring/RecurringDatesPage", () => ({ RecurringDatesPage: () => null }));
    vi.doMock("@/components/recurring/RecurringDatesManager", () => ({ SeriesDialogHost: ({ children }: any) => children(() => {}) }));
    vi.doMock("@/components/MultiProfileFilter", () => ({ MultiProfileFilter: () => null }));
    vi.doMock("@/hooks/useProfileScope", () => ({
      useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }),
    }));
    vi.doMock("wouter", () => ({ Link: ({ children }: any) => <a>{children}</a> }));
  });

  it("counts the obligations the Day view shows, not just hand-entered events", async () => {
    // The exact reported shape: nothing in /api/events, two auto-loan
    // obligations on the timeline for today. TODAY read 0.
    apiRequest.mockImplementation(async (_m: string, url: string) => {
      if (url.startsWith("/api/calendar/timeline")) {
        return new Response(JSON.stringify([
          { id: "o1", type: "obligation", title: "Auto loan", date: today },
          { id: "o2", type: "obligation", title: "Auto loan 2", date: today },
        ]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    const CalendarPage = (await import("@/pages/calendar-page")).default;
    wrap(<CalendarPage />);
    const band = await screen.findByTestId("calendar-summary");
    await waitFor(() => expect(band.textContent).toMatch(/2\s*TODAY/i));
  });

  it("reads the timeline endpoint, never /api/events, for the tiles", async () => {
    apiRequest.mockResolvedValue(new Response("[]", { status: 200 }));
    const CalendarPage = (await import("@/pages/calendar-page")).default;
    wrap(<CalendarPage />);
    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
    const urls = apiRequest.mock.calls.map((c: any[]) => String(c[1]));
    expect(urls.some(u => u.startsWith("/api/calendar/timeline"))).toBe(true);
    expect(urls.some(u => u.startsWith("/api/events"))).toBe(false);
  });

  it("separates today from the week and the 30-day horizon", async () => {
    const plus3 = new Date(Date.now() + 3 * 86400000).toLocaleDateString("en-CA");
    const plus20 = new Date(Date.now() + 20 * 86400000).toLocaleDateString("en-CA");
    apiRequest.mockImplementation(async (_m: string, url: string) =>
      new Response(url.startsWith("/api/calendar/timeline") ? JSON.stringify([
        { id: "a", date: today }, { id: "b", date: plus3 }, { id: "c", date: plus20 },
      ]) : "[]", { status: 200 }));
    const CalendarPage = (await import("@/pages/calendar-page")).default;
    wrap(<CalendarPage />);
    const band = await screen.findByTestId("calendar-summary");
    await waitFor(() => {
      expect(band.textContent).toMatch(/1\s*TODAY/i);
      expect(band.textContent).toMatch(/2\s*THIS WEEK/i);
      expect(band.textContent).toMatch(/3\s*NEXT 30 DAYS/i);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T1-004 — the bell badge fluctuated with no matching event
// ─────────────────────────────────────────────────────────────────────────────
describe("Notification bell (CRUD-T1-004)", () => {
  const NOTIFS = [
    { id: "n1", type: "task_overdue", severity: "critical", title: "A", message: "" },
    { id: "n2", type: "bill_due", severity: "warning", title: "B", message: "" },
    { id: "n3", type: "streak_milestone", severity: "info", title: "C", message: "" },
  ];

  beforeEach(() => {
    vi.doMock("wouter", () => ({ useLocation: () => ["/dashboard", vi.fn()] }));
    vi.doMock("@/hooks/useProfileScope", () => ({
      useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }),
    }));
  });

  it("counts everything its own panel lists — the badge used to skip 'info'", async () => {
    apiRequest.mockImplementation(async (_m: string, url: string) =>
      new Response(url.startsWith("/api/notifications") ? JSON.stringify(NOTIFS) : JSON.stringify({ value: "[]" }),
        { status: 200 }));
    const { NotificationBell } = await import("@/components/NotificationBell");
    wrap(<NotificationBell />);
    // 3, not 2: one critical + one warning + one info.
    expect((await screen.findByTestId("badge-notification-count")).textContent).toBe("3");
  });

  it("draws nothing until the dismissal list has loaded", async () => {
    let releaseDismissals: (v: any) => void = () => {};
    const pending = new Promise((res) => { releaseDismissals = res; });
    apiRequest.mockImplementation(async (_m: string, url: string) => {
      if (url.startsWith("/api/preferences")) {
        await pending;
        return new Response(JSON.stringify({ value: JSON.stringify(["n1", "n2"]) }), { status: 200 });
      }
      return new Response(JSON.stringify(NOTIFS), { status: 200 });
    });
    const { NotificationBell } = await import("@/components/NotificationBell");
    wrap(<NotificationBell />);
    // Notifications have landed but dismissals have not. Showing "3" here and
    // dropping to "1" a moment later is the flicker the tester recorded.
    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(screen.queryByTestId("badge-notification-count")).toBeNull();

    releaseDismissals(null);
    await waitFor(() => expect(screen.getByTestId("badge-notification-count").textContent).toBe("1"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UX-002 — "Show test data" was offered to every signed-in user
// ─────────────────────────────────────────────────────────────────────────────
describe("Dev affordances (UX-002)", () => {
  const load = async () => (await import("@/lib/dev-affordances")).devToolsEnabled;

  beforeEach(() => {
    vi.resetModules();
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is off for an ordinary production visitor", async () => {
    vi.stubGlobal("window", { location: { href: "https://portol.me/dashboard" } });
    vi.stubEnv("DEV", false as any);
    // import.meta.env.DEV is false under `vitest run`, so this is the real
    // production path.
    expect((await load())()).toBe(false);
  });

  it("turns on with an explicit ?devtools=1 opt-in, and stays on", async () => {
    vi.stubGlobal("window", { location: { href: "https://portol.me/dashboard?devtools=1" } });
    const enabled = await load();
    expect(enabled()).toBe(true);
    // Durable: the flag survives navigating away from the query string.
    vi.stubGlobal("window", { location: { href: "https://portol.me/dashboard" } });
    expect(enabled()).toBe(true);
  });

  it("turns back off with ?devtools=0", async () => {
    vi.stubGlobal("window", { location: { href: "https://portol.me/?devtools=1" } });
    const enabled = await load();
    expect(enabled()).toBe(true);
    vi.stubGlobal("window", { location: { href: "https://portol.me/?devtools=0" } });
    expect(enabled()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROP-005, wire contract — the scope only reaches the server if it is SENT
// ─────────────────────────────────────────────────────────────────────────────
describe("Active-profile header (PROP-005 wire contract)", () => {
  let fetchMock: any;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/queryClient");
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    });
    vi.stubGlobal("sessionStorage", {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    });
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const headersOf = (call: any) => call[1].headers as Record<string, string>;
  // Pick the call under test by URL rather than trusting position. Changing the
  // scope fires a fire-and-forget bootstrap prefetch (profileFilter.warmScope
  // -> scope-prefetch), so `calls[0]` is only the write when that prefetch
  // happens to lose the race — which under load it does not.
  const callTo = (path: string) => {
    const call = fetchMock.mock.calls.find((c: any) => String(c[0]).includes(path));
    expect(call, `no fetch to ${path}`).toBeTruthy();
    return call;
  };

  it("sends the selected profile on every write", async () => {
    const filter = await import("@/lib/profileFilter");
    const { apiRequest: realApiRequest } = await import("@/lib/queryClient");
    filter.setFilterSelected(["mike-1"], ["Mike"]);
    await realApiRequest("POST", "/api/expenses", { description: "Gas", amount: 40 });
    expect(headersOf(callTo("/api/expenses"))["x-active-profile-ids"]).toBe("mike-1");
  });

  it("sends nothing when the scope is Everyone", async () => {
    const filter = await import("@/lib/profileFilter");
    const { apiRequest: realApiRequest } = await import("@/lib/queryClient");
    filter.setFilterEveryone();
    await realApiRequest("POST", "/api/expenses", { description: "Gas", amount: 40 });
    expect(headersOf(callTo("/api/expenses"))["x-active-profile-ids"]).toBeUndefined();
  });

  it("sends both ids for a multi-selection, so the server can decline to guess", async () => {
    const filter = await import("@/lib/profileFilter");
    const { apiRequest: realApiRequest } = await import("@/lib/queryClient");
    filter.setFilterSelected(["mike-1", "jane-1"], ["Mike", "Jane"]);
    await realApiRequest("POST", "/api/expenses", {});
    expect(headersOf(callTo("/api/expenses"))["x-active-profile-ids"]).toBe("mike-1,jane-1");
  });

  it("keeps the timezone header the reminder fix depends on", async () => {
    const { apiRequest: realApiRequest } = await import("@/lib/queryClient");
    await realApiRequest("POST", "/api/reminders", { title: "x" });
    expect(headersOf(callTo("/api/reminders"))["X-Timezone"]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T1-003 — a "due today" alert survived the task being completed
// ─────────────────────────────────────────────────────────────────────────────
describe("Cache bus (CRUD-T1-003)", () => {
  it("refreshes the notification feed when tasks change", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/cache-bus"); // exercise the real domain→keys map
    const invalidateQueries = vi.fn();
    vi.doMock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries } }));
    const { invalidateDomain } = await vi.importActual<typeof import("@/lib/cache-bus")>("@/lib/cache-bus");
    await invalidateDomain("tasks");
    const keys = invalidateQueries.mock.calls
      .map((c: any[]) => JSON.stringify(c[0]?.queryKey))
      .filter(Boolean);
    // Completing a task changes what is due today; the bell derives straight
    // from open tasks, so it has to be part of the tasks ripple.
    expect(keys).toContain('["/api/notifications"]');
    expect(keys).toContain('["/api/tasks"]');
  });

  it("refreshes the calendar and the feed when bills change", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/cache-bus"); // exercise the real domain→keys map
    const invalidateQueries = vi.fn();
    vi.doMock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries } }));
    const { invalidateDomain } = await vi.importActual<typeof import("@/lib/cache-bus")>("@/lib/cache-bus");
    await invalidateDomain("obligations");
    const keys = invalidateQueries.mock.calls.map((c: any[]) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain('["/api/calendar/timeline"]');
    expect(keys).toContain('["/api/notifications"]');
  });
});
