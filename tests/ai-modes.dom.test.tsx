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
let trackers: any[] = [];
let tasks: any[] = [];
let library: any[] = [];

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
// The cards read the same lists every screen reads; here they load nothing.
vi.mock("@/components/wellness/WellnessCustomize", () => ({ WellnessWidgetCardBody: ({ widget, range }: any) => <p data-testid={`graph-body-${widget.id}`}>{widget.source?.kind}:{range}</p> }));
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
    else if (url === "/api/trackers" && method === "GET") data = trackers;
    else if (url === "/api/trackers" && method === "POST") { const t = { id: `t${trackers.length + 1}`, ...body, entries: [], linkedProfiles: [] }; trackers = [...trackers, t]; data = t; }
    else if (/^\/api\/trackers\/[^/]+\/entries$/.test(url)) { const t = trackers.find((x) => x.id === url.split("/")[3]); t.entries = [...t.entries, { id: `e${t.entries.length}`, timestamp: new Date().toISOString(), values: body.values }]; data = {}; }
    else if (url === "/api/profiles/lite") data = [{ id: "self-1", name: "Sam", type: "self" }];
    else if (url === "/api/tasks" && method === "GET") data = tasks;
    else if (url === "/api/tasks" && method === "POST") { const t = { id: `task${tasks.length + 1}`, status: "todo", ...body }; tasks = [...tasks, t]; data = t; }
    else if (url.startsWith("/api/tasks/") && method === "DELETE") { tasks = tasks.filter((t) => t.id !== url.split("/").pop()); data = {}; }
    else if (/\/digest$/.test(url)) data = { runs: {} };
    else if (url.startsWith("/api/workspace/modes/library") && method === "GET") data = { items: library };
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
const writes = () => calls.filter((c) => c.method !== "GET" && !["/api/workspace/modes/generate", "/api/workspace/modes/revise", "/api/workspace/modes/insights", "/api/workspace/modes/chat"].includes(c.url) && !c.url.endsWith("/install"));
const fitness = () => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "fitness")!, [], new Date());

beforeEach(() => { calls.length = 0; navigated.length = 0; modes = []; listFails = false; answers = {}; trackers = []; tasks = []; library = []; window.location.hash = ""; try { localStorage.clear(); } catch { /* */ } });
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

describe("graphs, a log form, reminders (second round)", () => {
  it("a Log tab creates its tracker on a tap, then saves an entry to it", async () => {
    const learning = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "learning")!, [], new Date());
    modes = [learning];
    mount(<ModeWorkspacePage params={{ id: "learning-assistant" }} />);
    fireEvent.click(await screen.findByTestId("workspace-tab-practice"));
    fireEvent.click(await screen.findByTestId("mode-log-create"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/trackers" });
    expect(writes()[0].body).toMatchObject({ name: "Study sessions", fields: [{ name: "minutes", type: "number", unit: "min", isPrimary: true }, { name: "subject", type: "text" }] });
    fireEvent.change(await screen.findByTestId("mode-log-field-minutes"), { target: { value: "45" } });
    fireEvent.change(screen.getByTestId("mode-log-field-subject"), { target: { value: "Spanish" } });
    fireEvent.click(screen.getByTestId("mode-log-save"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({ method: "POST", url: "/api/trackers/t1/entries", body: { values: { minutes: 45, subject: "Spanish" } } });
  });

  it("opening a Log tab writes nothing; a tracker already there is used, never created twice", async () => {
    const learning = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "learning")!, [], new Date());
    modes = [learning];
    trackers = [{ id: "t9", name: "Study sessions", fields: [], entries: [], linkedProfiles: [] }];
    mount(<ModeWorkspacePage params={{ id: "learning-assistant" }} />);
    fireEvent.click(await screen.findByTestId("workspace-tab-practice"));
    await screen.findByTestId("mode-log-form");
    expect(screen.queryByTestId("mode-log-create")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("a charts tab draws each graph over the picked range", async () => {
    modes = [fitness()];
    mount(<ModeWorkspacePage params={{ id: "fitness-coach" }} />);
    fireEvent.click(await screen.findByTestId("workspace-tab-workouts"));
    const graphs = await screen.findAllByTestId(/^graph-body-/);
    expect(graphs.map((g) => g.textContent)).toEqual(["workouts:30d", "metric:30d", "metric:30d"]);
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getAllByTestId(/^graph-body-/)[0].textContent).toBe("workouts:90d");
    expect(writes()).toEqual([]);
  });

  it("a reminder turned on is a recurring task; off takes two taps and deletes that task", async () => {
    const coach = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "life-coach")!, [], new Date());
    modes = [coach];
    mount(<ModeWorkspacePage params={{ id: "life-coach" }} />);
    const r = coach.reminders[0];
    fireEvent.click(await screen.findByTestId(`mode-reminder-on-${r.id}`));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ title: r.title, tags: ["recur:weekly", `ai-mode:life-coach:${r.id}`] });
    fireEvent.click(await screen.findByTestId(`mode-reminder-off-${r.id}`));
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByTestId(`mode-reminder-off-${r.id}`));
    await waitFor(() => expect(writes().map((c) => c.method)).toEqual(["POST", "DELETE"]));
  });

  it("tabs and modes carry a drag handle that keeps its own drag (T1)", async () => {
    modes = [fitness()];
    mount(<ModesWorkspacePage />);
    const handle = await screen.findByTestId("mode-drag-fitness-coach");
    expect(handle.closest("[data-swipe-ignore]")).not.toBeNull();
    expect((handle as HTMLElement).style.touchAction).toBe("none");
  });
});

describe("the library", () => {
  it("installing a published mode opens it for review; nothing is saved until Save", async () => {
    const pub = { ...fitness(), id: "x", name: "Marathon Coach" };
    library = [{ id: "11111111-1111-4111-8111-111111111111", name: "Marathon Coach", tagline: "", icon: "dumbbell", color: "orange", tabs: ["Progress", "Chat"], installs: 3, publishedAt: "2026-11-27", mine: false }];
    answers["/api/workspace/modes/library/11111111-1111-4111-8111-111111111111/install"] = { mode: pub };
    mount(<ModesWorkspacePage />);
    fireEvent.click(await screen.findByTestId("workspace-tab-library"));
    fireEvent.click(await screen.findByTestId("library-install-11111111-1111-4111-8111-111111111111"));
    await screen.findByTestId("mode-review");
    expect((screen.getByTestId("mode-name") as HTMLInputElement).value).toBe("Marathon Coach");
    expect(writes()).toEqual([]);
  });

  it("reporting takes two taps", async () => {
    library = [{ id: "11111111-1111-4111-8111-111111111111", name: "Odd", tagline: "", icon: "sparkles", color: "violet", tabs: ["Chat"], installs: 0, publishedAt: "2026-11-27", mine: false }];
    mount(<ModesWorkspacePage />);
    fireEvent.click(await screen.findByTestId("workspace-tab-library"));
    const btn = await screen.findByTestId("library-report-11111111-1111-4111-8111-111111111111");
    fireEvent.click(btn);
    expect(writes()).toEqual([]);
    fireEvent.click(btn);
    await waitFor(() => expect(writes()).toEqual([{ method: "POST", url: "/api/workspace/modes/library/11111111-1111-4111-8111-111111111111/report", body: undefined }]));
  });
});

describe("connected to the rest of the app", () => {
  it("a mode's reply can hand the question to Portol's main chat, which does the saving", async () => {
    const coach = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "life-coach")!, [], new Date());
    modes = [coach];
    answers["/api/workspace/modes/chat"] = { answer: "Sounds good — tap below to add it.", note: "", remembered: [] };
    mount(<ModeWorkspacePage params={{ id: "life-coach" }} />);
    fireEvent.click(await screen.findByTestId("workspace-tab-chat"));
    fireEvent.change(await screen.findByTestId("mode-chat-input"), { target: { value: "Add a task to call the dentist tomorrow" } });
    fireEvent.click(screen.getByTestId("mode-chat-send"));
    fireEvent.click(await screen.findByTestId("mode-chat-handoff"));
    expect(sessionStorage.getItem("portol_chat_prefill")).toBe("Add a task to call the dentist tomorrow");
    expect(navigated).toEqual(["/chat"]);
    expect(writes()).toEqual([]); // the mode itself wrote nothing
  });

  it("words handed over from the main chat are built into a proposal at once — still nothing saved", async () => {
    const reflection = modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "reflection")!, [], new Date());
    answers["/api/workspace/modes/generate"] = { mode: reflection, suggestJournal: true, by: "ai" };
    window.location.hash = `#/workspace/modes?new=1&describe=${encodeURIComponent("An AI that helps me with my moods")}`;
    mount(<ModesWorkspacePage />);
    await screen.findByTestId("mode-review");
    expect(calls.find((c) => c.url === "/api/workspace/modes/generate")!.body).toEqual({ description: "An AI that helps me with my moods" });
    expect(writes()).toEqual([]);
  });
});
