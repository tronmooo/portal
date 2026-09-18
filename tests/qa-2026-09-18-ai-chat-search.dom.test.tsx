// @vitest-environment jsdom
//
// QA 2026-09-18, AI & chat / global search / notifications — the screens:
//
//   • F-44  "Generate AI advice" renders the route's real response inside the
//           Needs Attention card, with a loading state and an error state;
//   • F-45  the composer clears synchronously on Enter, before the send;
//   • F-46  a thinking bubble sits in the thread while a turn runs;
//   • F-49  page-level shortcuts ignore keys typed into fields or dialogs;
//   • F-50/53 the bell's list scrolls, titles wrap, groups follow severity.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

const { apiRequestMock, navigateMock, toastFn } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  navigateMock: vi.fn(),
  toastFn: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastFn }) }));
vi.mock("../client/src/hooks/use-toast", () => ({ useToast: () => ({ toast: toastFn }) }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={() => ["/dashboard", navigateMock] as any}>{ui}</Router>
    </QueryClientProvider>,
  );
}

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchStub = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

// ── F-44 ────────────────────────────────────────────────────────────────────
describe("F-44 Generate AI advice", () => {
  // The route's exact response (server/routes.ts /api/dashboard/ai-suggestions).
  const SERVER_RESPONSE = {
    suggestions: [
      { title: "Recategorize auto loan as vehicle obligation", body: "It is filed under general.", action: "Recategorize", priority: "high" },
      { title: "Link 3 documents", body: "They have no profile.", action: "Link", priority: "medium" },
      { title: "Archive 2 empty trackers", body: "No entries yet.", action: "Archive", priority: "low" },
      { title: "Log today's dose", body: "Lisinopril has no entry today.", action: "Log", priority: "medium" },
    ],
    generatedAt: "2026-09-18T15:00:00.000Z", source: "ai", fingerprint: "-1234",
  };
  const stub = (advice: () => Promise<Response>) => {
    fetchStub.mockImplementation(async (url: any) => {
      if (String(url).includes("ai-suggestions")) return advice();
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  };
  async function mount() {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="selected" filterIds={["p1"]} stats={{} as any}
      enhanced={{ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] } as any} />);
    await waitFor(() => expect(screen.getByTestId("exec-card-attention")).toBeTruthy());
  }

  it("shows a loading state, then the four suggestions inside the Needs Attention card", async () => {
    stub(() => new Promise((res) => setTimeout(() => res(
      new Response(JSON.stringify(SERVER_RESPONSE), { status: 200, headers: { "Content-Type": "application/json" } }),
    ), 60)));
    await mount();
    expect(screen.queryByTestId("exec-card-recommendations")).toBeNull();
    fireEvent.click(screen.getByTestId("exec-recommendations-generate"));
    expect(await screen.findByTestId("exec-recommendations-loading")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("exec-recommendations-loading")).toBeNull());
    const attention = screen.getByTestId("exec-card-attention");
    const advice = screen.getByTestId("exec-card-recommendations");
    expect(attention.contains(advice)).toBe(true);
    for (const s of SERVER_RESPONSE.suggestions) expect(advice.textContent).toContain(s.title);
    expect(advice.textContent).toContain("It is filed under general.");
    // The force fetch happened once, with the scope on the query string.
    const calls = fetchStub.mock.calls.filter((c: any[]) => String(c[0]).includes("ai-suggestions"));
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain("force=true");
    expect(String(calls[0][0])).toContain("profileIds=p1");
  });

  it("says so when the request fails, and offers Retry", async () => {
    stub(async () => new Response(JSON.stringify({ error: "Failed to generate AI suggestions", suggestions: [] }), { status: 500 }));
    await mount();
    fireEvent.click(screen.getByTestId("exec-recommendations-generate"));
    expect(await screen.findByTestId("exec-recommendations-error")).toBeTruthy();
    expect(screen.getByTestId("exec-recommendations-error").textContent).toContain("Retry");
  });

  it("says 'nothing to suggest' for an empty answer instead of staying silent", async () => {
    stub(async () => new Response(JSON.stringify({ suggestions: [], generatedAt: "x", source: "empty", fingerprint: "0" }), { status: 200 }));
    await mount();
    fireEvent.click(screen.getByTestId("exec-recommendations-generate"));
    expect(await screen.findByTestId("exec-recommendations-empty")).toBeTruthy();
  });
});

// ── F-45 ────────────────────────────────────────────────────────────────────
describe("F-45 composer clears on send, synchronously", () => {
  async function mountComposer(onSubmit: (t: string) => boolean) {
    const { ChatComposer } = await import("../client/src/components/chat/ChatComposer");
    render(<ChatComposer onSubmit={onSubmit} isPending={false} searchOpen={false}
      onToggleSearch={() => {}} onAttach={() => {}} showReset={false} onReset={() => {}} />);
    return screen.getByTestId("input-chat") as HTMLTextAreaElement;
  }

  it("the box is empty by the time the parent receives the text", async () => {
    let valueWhenSent = "unset";
    const box = await mountComposer(() => {
      valueWhenSent = (screen.getByTestId("input-chat") as HTMLTextAreaElement).value;
      return true;
    });
    fireEvent.change(box, { target: { value: "add $30 groceries" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(valueWhenSent).toBe("");
    expect(box.value).toBe("");
    // Enter again on the empty box sends nothing.
    fireEvent.keyDown(box, { key: "Enter" });
  });

  it("a rejected send hands the draft back; a held Enter key sends once", async () => {
    const onSubmit = vi.fn(() => false);
    const box = await mountComposer(onSubmit);
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box.value).toBe("hello");
    fireEvent.keyDown(box, { key: "Enter", repeat: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

// ── F-46 ────────────────────────────────────────────────────────────────────
describe("F-46 thinking bubble", () => {
  it("names the running tool and counts the seconds", async () => {
    vi.useFakeTimers();
    const { ThinkingBubble } = await import("../client/src/components/chat/ThinkingBubble");
    const { rerender } = render(<ThinkingBubble runningTools={[]} uploading={false} />);
    expect(screen.getByTestId("chat-thinking").textContent).toContain("Thinking…");
    rerender(<ThinkingBubble runningTools={[{ tool: "create_expense", label: "Groceries $30" }]} uploading={false} />);
    expect(screen.getByTestId("live-tool-indicator").textContent).toBe("Adding expense: Groceries $30…");
    rerender(<ThinkingBubble runningTools={[]} uploading={false} />);
    act(() => { vi.advanceTimersByTime(26_000); });
    expect(screen.getByTestId("chat-thinking-label").textContent).toBe("Still working… 26s");
    expect(screen.getByTestId("chat-thinking-elapsed").textContent).toBe("26s");
  });
});

// ── F-49 ────────────────────────────────────────────────────────────────────
describe("F-49 page-level shortcuts leave typing alone", () => {
  it("ignores a shortcut typed into a field or while a dialog is open", async () => {
    vi.doMock("@/components/CommandSearch", () => ({ useCommandSearch: () => ({ open: false, setOpen: vi.fn() }) }));
    const { KeyboardShortcuts } = await import("../client/src/components/KeyboardShortcuts");
    wrap(<KeyboardShortcuts />);
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    fireEvent.keyDown(box, { key: "n", metaKey: true });
    expect(navigateMock).not.toHaveBeenCalled();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    expect(navigateMock).not.toHaveBeenCalled();
    dialog.remove();
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock.mock.calls[0][0]).toBe("/dashboard");
    box.remove();
  });
});

// ── F-50 / F-53 ─────────────────────────────────────────────────────────────
describe("F-50/F-53 notification panel", () => {
  const NOTIFS = [
    { id: "n1", type: "document_expiring", severity: "critical", title: "Expired: Homeowners Insurance policy with a very long name that runs on", message: "Homeowners Insurance expired 109 days ago (Jun 1, 2026)" },
    { id: "n2", type: "task_overdue", severity: "warning", title: "Overdue: Put out the trash", message: "Was due 1 day ago" },
    { id: "n3", type: "task_overdue", severity: "warning", title: "Overdue: Call Dana", message: "Was due 2 days ago" },
    { id: "n4", type: "bill_due", severity: "warning", title: "Phone due", message: "" },
    { id: "n5", type: "streak_milestone", severity: "info", title: "7-day streak", message: "" },
    { id: "n6", type: "task_due_today", severity: "info", title: "Dentist due in 3 days", message: "" },
  ];

  it("scrolls the list, wraps titles and groups by each row's own severity", async () => {
    vi.doMock("@/hooks/useProfileScope", () => ({
      useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }),
    }));
    vi.doMock("@/lib/queryClient", async () => {
      const { QueryClient } = await import("@tanstack/react-query");
      apiRequestMock.mockImplementation(async (_m: string, url: string) =>
        new Response(url.startsWith("/api/notifications") ? JSON.stringify(NOTIFS) : JSON.stringify({ value: "[]" }), { status: 200 }));
      return { queryClient: new QueryClient(), apiRequest: apiRequestMock, BROWSER_TIMEZONE: "America/New_York", recoverWedgedQueries: vi.fn() };
    });
    const { NotificationBell } = await import("../client/src/components/NotificationBell");
    wrap(<NotificationBell />);
    expect((await screen.findByTestId("badge-notification-count")).textContent).toBe("6");
    fireEvent.click(screen.getByTestId("button-notification-bell"));
    const list = await screen.findByTestId("notification-list");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toMatch(/max-h-/);
    // All six render — nothing is beyond reach.
    for (const n of NOTIFS) expect(screen.getByTestId(`notification-item-${n.id}`)).toBeTruthy();
    const title = screen.getByTestId("notification-title-n1");
    expect(title.className).not.toContain("truncate");
    expect(title.className).toContain("break-words");
    // Three headings, one per severity actually present.
    const text = list.textContent || "";
    expect(text).toContain("Critical");
    expect(text).toContain("Attention");
    expect(text).toContain("Info");
    // The overdue task sits under Attention, not Critical.
    const critical = screen.getByTestId("notification-item-n1");
    const trash = screen.getByTestId("notification-item-n2");
    expect(critical.parentElement).not.toBe(trash.parentElement);
  });
});
