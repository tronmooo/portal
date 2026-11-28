// @vitest-environment jsdom
//
// The chat home on screen (owner's design, 2026-11-25). The figures are
// decided by shared/chat-home (tests/chat-home.test.ts); this renders the real
// view and checks that everything on it goes somewhere, that a figure which
// did not load never reads as a number, and that the modes are on screen once.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));

import { ChatHomeView, ChatModesDock } from "../client/src/components/chat/ChatHome";
import { ChatComposer } from "../client/src/components/chat/ChatComposer";
import { buildChatHome, type HomeList } from "../shared/chat-home";
import { buildChatSuggestions } from "../shared/chat-suggestions";
import { TODAY, TZ, fixtureMetrics, fixtureTrackers, tracker, entry } from "./helpers/wellness-fixture";

afterEach(() => { cleanup(); navigated.length = 0; });

const NOW = new Date("2026-11-23T08:30:00");
const trackers = fixtureTrackers();
const HOME = buildChatHome({
  todayISO: TODAY, timezone: TZ, trackers, metrics: fixtureMetrics(trackers),
  snapshot: {
    totalMonthlySpend: 562, lastMonthTotal: 493, totalAssetValue: 60350, totalLiabilities: 18000,
    spendByCategory: { food: 210, transport: 95 }, assetBreakdown: [{ name: "Honda CR-V", value: 26800 }],
    upcomingBills: [{ id: "b1", name: "Internet", amount: 92, daysUntil: 2 }],
  },
  tasks: [{ id: "t1", title: "Call the dentist", status: "todo", dueDate: TODAY }] as any,
  eventsToday: [{ title: "Soccer", time: "21:00" }], expiring: [], journal: [{ date: TODAY, mood: "good" }],
});
const SUGGESTIONS = buildChatSuggestions({ now: NOW }, 4);

function Home(props: Partial<React.ComponentProps<typeof ChatHomeView>> = {}) {
  return <ChatHomeView home={HOME} name="Robert" todayISO={TODAY} suggestions={SUGGESTIONS} onPick={() => {}} onSend={() => {}} now={NOW} {...props} />;
}
/** The AI Modes row and the chat box, pinned under the home (owner, 2026-11-28). */
function Dock(props: Partial<React.ComponentProps<typeof ChatModesDock>> = {}) {
  return <ChatModesDock onOpenWorkspace={() => {}} {...props} />;
}

describe("chat home", () => {
  it("greets the account holder and dates the summary", () => {
    render(<Home />);
    expect(screen.getByTestId("home-greeting").textContent).toBe("Good morning, Robert.");
    expect(screen.getByTestId("home-summary").textContent).toContain("Today, Nov 23");
    expect(screen.getByTestId("home-line-tasks").textContent).toContain("1 task open");
  });

  it("shows the tiles the builder picked — only what this person has", () => {
    render(<Home />);
    expect(screen.getByTestId("home-kpi-networth").textContent).toContain("$42,350");
    expect(screen.getByTestId("home-kpi-spending").textContent).toContain("$562");
    expect(screen.getByTestId("home-kpi-spending").textContent).toContain("+14%");
    for (const key of ["activity", "sleep", "weight"]) expect(screen.getByTestId(`home-kpi-${key}`)).toBeTruthy();
    // No resting heart rate in the fixture: no tile, and nothing reads "Not tracked".
    expect(screen.queryByTestId("home-kpi-rhr")).toBeNull();
    expect(screen.getByTestId("home-kpis").textContent).not.toContain("Not tracked");
    expect(screen.getByTestId("home-kpis").children.length).toBe(HOME.kpis.length);
  });

  it("a person's own tracker is a tile that opens that tracker", () => {
    const own = [tracker("t-coffee", "Coffee", "custom", [{ name: "cups", unit: "cups" }], [entry(TODAY, { cups: 2 }), entry("2026-11-22", { cups: 3 })])];
    const home = buildChatHome({ todayISO: TODAY, timezone: TZ, trackers: own, metrics: fixtureMetrics(own), snapshot: {}, tasks: [], eventsToday: [], journal: [] });
    render(<Home home={home} />);
    const tile = screen.getByTestId("home-kpi-tracker:t-coffee:cups");
    expect(tile.textContent).toContain("Coffee Cups");
    expect(tile.textContent).toContain("5");
    fireEvent.click(tile);
    expect(navigated).toEqual(["/trackers?tracker=t-coffee"]);
  });

  it("an account with nothing recorded gets an invitation, not six empty tiles", () => {
    const onPick = vi.fn();
    const home = buildChatHome({ todayISO: TODAY, timezone: TZ, trackers: [], metrics: fixtureMetrics([]), snapshot: {}, tasks: [], eventsToday: [], journal: [] });
    render(<Home home={home} onPick={onPick} />);
    expect(screen.queryByTestId("home-kpis")).toBeNull();
    expect(screen.queryByTestId("home-kpi-caption")).toBeNull();
    fireEvent.click(screen.getByTestId("home-kpis-empty"));
    expect(onPick).toHaveBeenCalledWith("Track my ");
  });

  it("a row with a route goes there; a row that starts something fills the chat box", () => {
    const onPick = vi.fn();
    render(<Home onPick={onPick} />);
    fireEvent.click(screen.getByTestId("home-kpi-networth"));
    fireEvent.click(screen.getByTestId("home-glance-events"));
    fireEvent.click(screen.getByTestId("home-insights-all"));
    expect(navigated).toEqual(["/dashboard/finance", "/calendar", "/insights"]);
    // An insight with nothing behind it starts the entry in the box instead.
    const bare = buildChatHome({ todayISO: TODAY, timezone: TZ, trackers: [], metrics: fixtureMetrics([]), snapshot: {}, tasks: [], eventsToday: [], journal: [] });
    cleanup();
    render(<Home home={bare} onPick={onPick} />);
    expect(screen.getByTestId("home-insight-finance").getAttribute("data-state")).toBe("untracked");
    fireEvent.click(screen.getByTestId("home-insight-finance"));
    expect(onPick).toHaveBeenCalledWith("I spent $");
    expect(navigated.length).toBe(3);
  });

  it("a thing to ask is sent whole; Refresh shows four others", () => {
    const onSend = vi.fn();
    render(<Home onSend={onSend} />);
    fireEvent.click(screen.getByTestId("home-ask-analyze"));
    expect(onSend).toHaveBeenCalledWith("Review my spending and find savings opportunities.");
    fireEvent.click(screen.getByTestId("home-briefing"));
    expect(onSend).toHaveBeenLastCalledWith("Give me my briefing for today.");
    fireEvent.click(screen.getByTestId("home-asks-refresh"));
    expect(screen.queryByTestId("home-ask-analyze")).toBeNull();
    expect(screen.getByTestId("home-ask-money")).toBeTruthy();
  });

  it("a figure that failed to load is not a number, and offers a retry (Rule 7)", () => {
    const retry = vi.fn();
    const failed = buildChatHome({ todayISO: TODAY, timezone: TZ, failed: new Set<HomeList>(["snapshot", "tasks", "trackers", "events", "journal"]) });
    render(<Home home={failed} onRetry={retry} />);
    const nw = screen.getByTestId("home-kpi-money");
    expect(nw.getAttribute("data-state")).toBe("error");
    expect(nw.textContent).toContain("Couldn't load");
    expect(nw.textContent).not.toMatch(/\$|\d/);
    fireEvent.click(screen.getByTestId("home-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("a figure still loading shows a placeholder, never a zero", () => {
    render(<Home home={buildChatHome({ todayISO: TODAY, timezone: TZ })} />);
    for (const key of ["health", "money"]) {
      const el = screen.getByTestId(`home-kpi-${key}`);
      expect(el.getAttribute("data-state")).toBe("loading");
      expect(el.textContent).not.toMatch(/\d/);
    }
    expect(screen.getByTestId("home-summary-empty").textContent).toContain("Reading your records");
    expect(screen.queryByTestId("home-retry")).toBeNull();
  });

  it("the modes are tiles on the home: Chat focuses the box, the rest open their own tool; More opens the rest", async () => {
    const open = vi.fn(); const focus = vi.fn();
    render(<Dock onOpenWorkspace={open} onFocusChat={focus} />);
    fireEvent.click(screen.getByTestId("button-mode-chat"));
    expect(focus).toHaveBeenCalledTimes(1);
    for (const kind of ["notes", "journal", "document", "fill"]) fireEvent.click(screen.getByTestId(`button-workspace-${kind}`));
    expect(open.mock.calls.map((c) => c[0])).toEqual(["notes", "journal", "document", "fill"]);
    // The pages no longer crowd the row: they are in More.
    expect(screen.queryByTestId("button-app-documents")).toBeNull();
    fireEvent.click(screen.getByTestId("button-modes-more"));
    fireEvent.click(await screen.findByTestId("button-app-documents"));
    fireEvent.click(screen.getByTestId("button-modes-more"));
    fireEvent.click(await screen.findByTestId("button-app-plan"));
    expect(navigated).toEqual(["/artifacts", "/calendar"]);
  });

  it("a PINNED custom mode joins the row; the rest are in More, with Create Mode", async () => {
    const mk = (id: string, name: string, pinned: boolean) => ({ id, name, icon: "dumbbell", color: "orange", tagline: "", personality: "", instructions: "", access: [], remember: true,
      tabs: [{ id: "chat", title: "Chat", kind: "chat" }], prompts: [], pinned, createdAt: "2026-11-27T00:00:00Z", updatedAt: "2026-11-27T00:00:00Z" });
    render(<Dock modes={{ modes: [mk("fit", "Fitness Coach", true), mk("money", "Money", false)] as any }} />);
    expect(screen.getByTestId("button-ai-mode-fit").textContent).toContain("Fitness Coach");
    expect(screen.queryByTestId("button-ai-mode-money")).toBeNull();
    fireEvent.click(screen.getByTestId("button-ai-mode-fit"));
    expect(navigated).toEqual(["/workspace/mode/fit"]);
    fireEvent.click(screen.getByTestId("button-modes-more"));
    expect((await screen.findByTestId("modes-sheet-open-money")).textContent).toContain("Money");
    fireEvent.click(screen.getByTestId("modes-sheet-create"));
    expect(navigated[1]).toBe("/workspace/modes?new=1");
  });

  it("a modes list that failed to load says so in More, with a retry — never 'none yet' (Rule 7)", async () => {
    const retry = vi.fn();
    render(<Dock modes={{ failed: true, retry }} />);
    fireEvent.click(screen.getByTestId("button-modes-more"));
    expect((await screen.findByTestId("modes-sheet-error")).textContent).toContain("Couldn't load");
    expect(screen.queryByTestId("modes-sheet-empty")).toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("the modes and the chat box are pinned in one dock, not in the scrolling home (owner, 2026-11-28)", () => {
    render(<><Home /><Dock composer={<ChatComposer onSubmit={() => true} isPending={false} searchOpen={false} onToggleSearch={() => {}} onAttach={() => {}}
      showReset={false} onReset={() => {}} onOpenWorkspace={() => {}} hideModes inline />} /></>);
    const home = screen.getByTestId("chat-home");
    const dock = screen.getByTestId("chat-dock");
    const modes = screen.getByTestId("chat-modes");
    const box = screen.getByTestId("chat-composer-inline");
    expect(home.contains(modes)).toBe(false);
    expect(home.contains(box)).toBe(false);
    expect(dock.contains(modes) && dock.contains(box)).toBe(true);
    expect(modes.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("button-chat-modes")).toBeNull();
  });

  it("rows that scroll sideways keep their own drag (T1)", () => {
    render(<><Home /><Dock /></>);
    for (const id of ["home-glance-tasks", "home-insight-wellness", "button-mode-chat"]) {
      expect(screen.getByTestId(id).closest("[data-swipe-ignore]")).not.toBeNull();
    }
  });
});
