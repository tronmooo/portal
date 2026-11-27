// @vitest-environment jsdom
//
// Custom AI Modes, rendered (owner request 2026-11-27). The real builder page
// and the real mode page, clicked.
//
// What is pinned:
//  - Describe → Generate is a PROPOSAL: nothing is saved until Save; the
//    journal is offered ("Suggested"), never switched on for the person.
//  - A mode opens as its own app with its own tabs plus Settings. Walking
//    through every tab writes nothing (Rule 3); an analysis runs on a TAP
//    (WA3); a suggested conversation goes to the Chat tab and is sent.
//  - Changing it by talking shows what would change; only Apply writes.
//  - Delete takes two taps (Rule 8). A failed list is an error with a retry,
//    never "no modes" (Rule 7).
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MODE_TEMPLATES, modeFromTemplate, type AiMode } from "../shared/ai-modes";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let modes: AiMode[] = [];
let listFails = false;
let answers: Record<string, any> = {};

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
// The cards read the same lists every screen reads; here they load nothing.
vi.mock("@/components/dashboard/ExecWidgetBody", () => ({ ExecWidgetBody: ({ widget }: any) => <p data-testid={`card-body-${widget.id}`}>{widget.source}</p> }));
vi.mock("@/lib/queryClient", () => ({
  BROWSER_TIMEZONE: "America/Los_Angeles",
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    let data: any = {};
    if (url === "/api/workspace/modes" && method === "GET") { if (listFails) throw new Error("500: boom"); data = { modes }; }
    else if (url in answers) data = typeof answers[url] === "function" ? answers[url](body) : answers[url];
    else if (url === "/api/workspace/modes" && method === "POST") { const m = { ...body.mode, id: "saved-mode" }; modes = [...modes, m]; data = { mode: m, modes }; }
    else if (method === "PATCH" && url.startsWith("/api/workspace/modes/")) {
      const id = url.split("/").pop();
      modes = modes.map((m) => (m.id === id ? { ...m, ...body.patch } : m));
      data = { mode: modes.find((m) => m.id === id), modes };
    } else if (method === "DELETE" && url.startsWith("/api/workspace/modes/")) { const id = url.split("/").pop(); modes = modes.filter((m) => m.id !== id); data = { modes }; }
    else if (url.startsWith("/api/workspace/memory/")) data = { memories: [], turns: [], lastTalked: null, remember: true, name: "Sam" };
    return { ok: true, json: async () => data };
  }),
}));

import ModesWorkspacePage from "../client/src/pages/workspace-modes";
import ModeWorkspacePage from "../client/src/pages/workspace-mode";

function mount(page: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => {
    const key = String(queryKey[0]);
    if (key.startsWith("/api/workspace/memory/")) return { memories: [], turns: [], lastTalked: null, remember: true, name: "Sam" };
    return [];
  } } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}
const writes = () => calls.filter((c) => c.method !== "GET" && !["/api/workspace/modes/generate", "/api/workspace/modes/revise", "/api/workspace/modes/insights", "/api/workspace/modes/chat"].includes(c.url));
const fitness = () => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "fitness")!, [], new Date());

beforeEach(() => { calls.length = 0; navigated.length = 0; modes = []; listFails = false; answers = {}; window.location.hash = ""; try { localStorage.clear(); } catch { /* */ } });
afterEach(() => cleanup());

describe("the builder", () => {
  it("describe → a proposal to review; nothing is saved until Save; the journal is only suggested", async () => {
    const reflection = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "reflection")!, [], new Date());
    answers["/api/workspace/modes/generate"] = { mode: reflection, suggestJournal: true, by: "ai" };
    mount(<ModesWorkspacePage />);
    fireEvent.click(await screen.findByTestId("workspace-tab-create"));
    fireEvent.click(screen.getAllByTestId("mode-idea")[0]);
    await screen.findByTestId("mode-review");
    expect(calls.find((c) => c.url === "/api/workspace/modes/generate")!.body).toEqual({ description: "An AI that helps me understand myself emotionally" });
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("mode-journal-suggested")).toBeTruthy();
    expect(screen.getByTestId("mode-access-journal").getAttribute("aria-checked")).toBe("false");
    // Every part is editable before saving.
    fireEvent.change(screen.getByTestId("mode-name"), { target: { value: "My Mirror" } });
    fireEvent.click(screen.getByTestId("mode-access-journal"));
    fireEvent.click(screen.getByTestId("mode-review-save"));
    await waitFor(() => expect(navigated).toEqual(["/workspace/mode/saved-mode"]));
    const saved = writes();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ method: "POST", url: "/api/workspace/modes" });
    expect(saved[0].body.mode).toMatchObject({ name: "My Mirror" });
    expect(saved[0].body.mode.access).toContain("journal");
  });

  it("a list that failed to load is an error with a retry, never 'no modes'", async () => {
    listFails = true;
    mount(<ModesWorkspacePage />);
    expect((await screen.findByTestId("modes-error")).textContent).toContain("Couldn't load");
    expect(screen.queryByTestId("modes-empty")).toBeNull();
  });

  it("pin and delete: pin is one write; delete takes two taps", async () => {
    modes = [fitness()];
    mount(<ModesWorkspacePage />);
    fireEvent.click(await screen.findByTestId("mode-pin-fitness-coach"));
    await waitFor(() => expect(writes()).toEqual([{ method: "PATCH", url: "/api/workspace/modes/fitness-coach", body: { patch: { pinned: true } } }]));
    fireEvent.click(screen.getByTestId("mode-delete-fitness-coach"));
    expect(writes()).toHaveLength(1);
    expect(screen.getByTestId("mode-delete-fitness-coach").textContent).toMatch(/Tap again/);
    fireEvent.click(screen.getByTestId("mode-delete-fitness-coach"));
    await waitFor(() => expect(writes().map((c) => c.method)).toEqual(["PATCH", "DELETE"]));
  });
});

describe("a mode is its own app", () => {
  it("its own tabs plus Settings; walking through them writes nothing; analysis runs on a tap", async () => {
    modes = [fitness()];
    answers["/api/workspace/modes/insights"] = { items: [{ title: "Consistent", detail: "Four runs a week.", sources: ["health"] }], read: ["health"] };
    mount(<ModeWorkspacePage params={{ id: "fitness-coach" }} />);
    await screen.findByTestId("workspace-tab-progress");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.trim());
    expect(tabs).toEqual(["Progress", "Workouts", "Recovery", "Plans", "Chat", "Settings"]);
    for (const id of ["workouts", "recovery", "plans", "chat", "__settings", "progress"]) fireEvent.click(screen.getByTestId(`workspace-tab-${id}`));
    await screen.findByTestId("mode-insights-progress");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    fireEvent.click(screen.getByTestId("mode-insights-run-progress"));
    expect((await screen.findByTestId("mode-insights-items-progress")).textContent).toContain("Four runs a week.");
    expect(writes()).toEqual([]);
  });

  it("a suggested conversation on the Overview goes to Chat and is sent", async () => {
    const coach = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "life-coach")!, [], new Date());
    modes = [coach];
    answers["/api/workspace/modes/chat"] = { answer: "Let's look at it together.", note: "Read: Tasks.", remembered: [] };
    mount(<ModeWorkspacePage params={{ id: "life-coach" }} />);
    fireEvent.click((await screen.findAllByTestId("mode-prompt"))[0]);
    expect(await screen.findByText("Let's look at it together.")).toBeTruthy();
    const chat = calls.find((c) => c.url === "/api/workspace/modes/chat")!;
    expect(chat.body).toEqual({ modeId: "life-coach", messages: [{ role: "user", content: coach.prompts[0] }] });
    // What it may read is not something the screen sends.
    expect(chat.body.access).toBeUndefined();
  });

  it("changing it by talking shows the change; only Apply writes", async () => {
    const m = fitness();
    modes = [m];
    const revised = { ...m, tabs: [...m.tabs.slice(0, 4), { id: "sleep", title: "Sleep", kind: "insights", focus: "Compare my sleep against my workout performance" }, m.tabs[4]] };
    answers["/api/workspace/modes/revise"] = { mode: revised, by: "ai" };
    mount(<ModeWorkspacePage params={{ id: "fitness-coach" }} />);
    fireEvent.click(await screen.findByTestId("workspace-tab-__settings"));
    fireEvent.change(screen.getByTestId("mode-revise-input"), { target: { value: "Add a sleep analysis tab and compare my sleep against my workout performance" } });
    fireEvent.click(screen.getByTestId("mode-revise-run"));
    expect((await screen.findByTestId("mode-revise-proposal")).textContent).toContain("New tab: Sleep");
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("mode-revise-apply"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: "/api/workspace/modes/fitness-coach" });
    expect(writes()[0].body.patch.tabs.map((t: any) => t.title)).toContain("Sleep");
    await waitFor(() => expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toContain("Sleep"));
  });

  it("a mode that no longer exists says so", async () => {
    modes = [];
    mount(<ModeWorkspacePage params={{ id: "gone" }} />);
    expect((await screen.findByTestId("mode-missing")).textContent).toContain("no longer exists");
  });
});
