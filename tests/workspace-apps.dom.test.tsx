// @vitest-environment jsdom
//
// Notes and Journal as full applications (owner request 2026-11-25): each has
// its own tabs behind the small button in AI Chat. These render the real
// pages and click the real controls.
//
// What is pinned:
//  - The tabs exist, the X is at the upper right, Save is beside it.
//  - Looking around writes nothing (Rule 3); a favourite, a category and a
//    restore are each ONE write to the stored row (Rule 6).
//  - Delete and restore take two taps (Rule 8). A failed list is an error
//    with a retry on every tab (Rule 7). A search or range says what it
//    leaves out (Rule 4).
//  - The AI answers and proposes; nothing is applied until the user does (W5).
//  - What an AI may read is a switch the writer holds, never changed while
//    the stored setting is unread.
//  - The record last open comes back; unsaved writing kept on the device is
//    offered, not applied.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_WORKSPACE_AI_ACCESS, WORKSPACE_AI_ACCESS_PREF, parseWorkspaceAiAccess } from "../shared/workspace-access";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let notes: any[] = [];
let entries: any[] = [];
let listFails = false;
let prefFails = false;
let storedAccess: string | null = null;
let versions: any[] = [];
let answers: Record<string, any> = {};
let failUrl: string | null = null;
/** What the server holds for each assistant's memory; absent = a server without the memory routes. */
let memory: Record<string, any> = {};
let memoryFails = false;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}) }));
vi.mock("@/lib/document-preview", () => ({ useDocumentBlobUrl: () => ({ url: "blob:photo", blob: null, loading: false, error: false }) }));
vi.mock("@/pages/journal", () => {
  const Icon = () => null;
  const mk = (label: string) => ({ icon: Icon, label, color: "#888", bg: "bg-muted" });
  return { MOOD_CONFIG: { amazing: mk("Amazing"), great: mk("Great"), good: mk("Good"), okay: mk("Okay"), neutral: mk("Neutral"), bad: mk("Bad"), awful: mk("Awful"), terrible: mk("Terrible") } };
});
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }) }));
vi.mock("@/lib/profileFilter", () => ({ scopeLabel: (n: string[]) => n.join(", "), setFilterEveryone: () => {} }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
vi.mock("@/lib/queryClient", () => ({
  BROWSER_TIMEZONE: "America/Los_Angeles",
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (failUrl && url.includes(failUrl)) throw new Error('502: {"error":"The request to the AI model failed. Nothing was changed — please try again."}');
    let data: any = {};
    if (method === "GET" && url.startsWith("/api/journal")) { if (listFails) throw new Error("500: boom"); data = entries; }
    else if (url in answers) data = answers[url];
    else if (method === "POST" && url === "/api/notes") data = { id: "n-new", ...body };
    else if (method === "POST" && url === "/api/journal") data = { id: "j-new", ...body };
    else if (url.startsWith("/api/workspace/memory/")) {
      const app = url.split("/")[4];
      const m = memory[app];
      if (method === "DELETE" && url.endsWith("/conversation")) m.turns = [];
      else if (method === "DELETE" && url.includes("/items/")) m.memories = m.memories.filter((x: any) => x.id !== url.split("/").pop());
      else if (method === "DELETE") { m.memories = []; m.turns = []; m.lastTalked = null; }
      else if (method === "POST") m.memories = [...m.memories, { id: `own-${m.memories.length}`, text: body.text, at: new Date().toISOString(), by: "you" }];
      data = { ...m, memories: [...m.memories], turns: [...m.turns] };
    }
    else if (method === "PUT" && url.startsWith("/api/preferences/")) { storedAccess = body.value; data = { success: true }; }
    else if (method === "POST" && url.endsWith("/restore")) data = { record: { id: "n1", content: "the older text" }, restoredFrom: "2026-11-20T10:00:00.000Z" };
    else if (method === "PATCH") data = { id: url.split("/").pop(), ...body };
    return { ok: true, json: async () => data };
  }),
}));

import NotesWorkspacePage, { NOTE_AUTOSAVE_MS } from "../client/src/pages/workspace-notes";
import JournalWorkspacePage, { JOURNAL_AUTOSAVE_MS } from "../client/src/pages/workspace-journal";
import { GUIDED_EXERCISES } from "../client/src/components/workspace/JournalTabs";
import { getUserToday } from "../shared/timezone";

const TODAY = getUserToday("America/Los_Angeles");
const dayBefore = (n: number) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

function mount(page: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: {
      retry: false,
      queryFn: async ({ queryKey }) => {
        const key = String(queryKey[0]);
        if (key === "/api/notes") { if (listFails) throw new Error("500: boom"); return notes; }
        if (key === "/api/profiles") return [{ id: "p1", name: "Tron", type: "self" }];
        if (key === `/api/preferences/${WORKSPACE_AI_ACCESS_PREF}`) { if (prefFails) throw new Error("500: boom"); return { value: storedAccess }; }
        if (key.startsWith("/api/workspace/memory/")) { if (memoryFails) throw new Error("500: boom"); const m = memory[key.split("/").pop()!]; return m ? { ...m } : []; }
        if (/^\/api\/workspace\/versions\/\w+\/[^/]+$/.test(key)) return { versions: versions.map(({ content: _c, ...v }) => v) };
        if (key.startsWith("/api/workspace/versions/")) return versions.find((v) => key.endsWith(`/${v.id}`));
        return [];
      },
    } },
  });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}
const tab = (id: string) => fireEvent.click(screen.getByTestId(`workspace-tab-${id}`));
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.startsWith("/api/workspace/") || c.url.endsWith("/restore"));
const aiCalls = (path: string) => calls.filter((c) => c.url === path);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOTES = () => [
  { id: "n1", type: "note", title: "Trip plan", content: "Fly to Lisbon.\n- [ ] book flights\n- [x] passport\n- [ ] hotel", tags: ["category:Travel"], pinned: true, updatedAt: "2026-11-24T10:00:00Z" },
  { id: "n2", type: "note", title: "Budget", content: "Trip fund 1200 of 3000", tags: [], pinned: false, updatedAt: "2026-11-23T10:00:00Z" },
  { id: "n3", type: "note", title: "Ideas", content: "Learn Portuguese", tags: [], pinned: false, updatedAt: "2026-11-22T10:00:00Z" },
];

beforeEach(() => {
  window.localStorage.clear();
  calls.length = 0; navigated.length = 0; notes = []; entries = []; listFails = false; prefFails = false; storedAccess = null; versions = []; answers = {}; failUrl = null; memory = {}; memoryFails = false;
});
afterEach(cleanup);

describe("Notes: the app's own navigation", () => {
  it("has six tabs, opens on the Editor, and the X is at the upper right beside Save", () => {
    mount(<NotesWorkspacePage />);
    const tabs = within(screen.getByTestId("workspace-tabs")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["All Notes", "Editor", "Categories", "AI Assistant", "AI Insights", "Favorites"]);
    expect(screen.getByTestId("workspace-tab-editor").getAttribute("aria-selected")).toBe("true");
    const buttons = Array.from(screen.getByTestId("workspace-header").querySelectorAll("button"));
    expect(buttons[buttons.length - 1].getAttribute("data-testid")).toBe("button-workspace-close");
    expect(buttons[buttons.length - 2].getAttribute("data-testid")).toBe("button-workspace-save");
  });

  it("walking through every tab writes nothing", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    for (const id of ["all", "categories", "assistant", "insights", "favorites", "editor"]) tab(id);
    await settle(NOTE_AUTOSAVE_MS + 200);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("the Editor keeps what is being written while another tab is looked at", async () => {
    mount(<NotesWorkspacePage />);
    fireEvent.click(screen.getByTestId("button-note-mode"));
    fireEvent.change(screen.getByTestId("input-note-content"), { target: { value: "half a thought" } });
    tab("all");
    expect(screen.getByTestId("notes-all")).toBeTruthy();
    tab("editor");
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("half a thought");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notes", body: { content: "half a thought" } });
  });
});

describe("Notes: All Notes and Favorites", () => {
  it("every note is listed and counted; search says how many of how many", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("all");
    await waitFor(() => expect(screen.getByTestId("all-notes-count").textContent).toBe("3 notes"));
    fireEvent.change(screen.getByTestId("input-all-notes-search"), { target: { value: "lisbon" } });
    expect(screen.getByTestId("all-notes-count").textContent).toBe("1 note of 3");
    expect(screen.queryByTestId("all-note-n2")).toBeNull();
    fireEvent.change(screen.getByTestId("input-all-notes-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("all-notes-empty").textContent).toMatch(/No note matches “zzz”/);
  });

  it("a failed list is an error with a retry on the tab, not an empty notebook", async () => {
    listFails = true;
    mount(<NotesWorkspacePage />);
    tab("all");
    await waitFor(() => expect(screen.getByTestId("all-notes-error").textContent).toMatch(/Couldn't load your notes/));
    expect(screen.queryByTestId("all-notes-empty")).toBeNull();
    tab("categories");
    expect(screen.getByTestId("notes-categories").textContent).toMatch(/Couldn't load your notes/);
  });

  it("the star is one write to the note's own flag", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("all");
    await waitFor(() => screen.getByTestId("button-note-favorite-n2"));
    expect(screen.getByTestId("button-note-favorite-n1").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("button-note-favorite-n2"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PATCH", url: "/api/artifacts/n2", body: { pinned: true } });
  });

  it("Favorites shows the starred notes; with none it says how to add one", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("favorites");
    await waitFor(() => expect(screen.getByTestId("all-notes-count").textContent).toBe("1 note"));
    expect(screen.getByTestId("all-note-n1")).toBeTruthy();
    cleanup();
    notes = NOTES().map((n) => ({ ...n, pinned: false }));
    mount(<NotesWorkspacePage />);
    tab("favorites");
    await waitFor(() => expect(screen.getByTestId("all-notes-empty").textContent).toMatch(/No favorites yet\. Tap the star/));
  });

  it("delete takes two taps", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("all");
    await waitFor(() => screen.getByTestId("button-all-note-delete-n3"));
    fireEvent.click(screen.getByTestId("button-all-note-delete-n3"));
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("button-all-note-delete-n3").textContent).toMatch(/Sure\?/);
    fireEvent.click(screen.getByTestId("button-all-note-delete-n3"));
    await waitFor(() => expect(writes()).toEqual([{ method: "DELETE", url: "/api/notes/n3", body: undefined }]));
  });

  it("opening a note from the list edits that note in the Editor", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("all");
    await waitFor(() => screen.getByTestId("all-note-n2"));
    fireEvent.click(within(screen.getByTestId("all-note-n2")).getByTitle("Open in the editor"));
    await waitFor(() => expect(screen.getByTestId("workspace-tab-editor").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Budget"));
    expect(writes()).toEqual([]);
  });
});

describe("Notes: Categories", () => {
  it("a category opens All Notes filtered to it, and the filter says what it hides", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("categories");
    await waitFor(() => screen.getByTestId("category-card-Travel"));
    expect(screen.getByTestId("category-card-Travel").textContent).toMatch(/Travel1 note/);
    fireEvent.click(screen.getByTestId("category-card-Travel"));
    expect(screen.getByTestId("workspace-tab-all").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("all-notes-filter-notice").textContent).toMatch(/Showing Travel only — 2 other notes are hidden/);
  });

  it("filing by hand sends the category alone: the server applies it to the stored tags", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("categories");
    await waitFor(() => screen.getByTestId("input-category-n2"));
    fireEvent.change(screen.getByTestId("input-category-n2"), { target: { value: "Money" } });
    fireEvent.submit(screen.getByTestId("input-category-n2").closest("form")!);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PATCH", url: "/api/notes/n2", body: { category: "Money" } });
  });

  it("the AI's categories are a proposal: nothing is filed until one is applied", async () => {
    notes = NOTES();
    answers["/api/workspace/notes/categorize"] = { suggestions: [{ id: "n2", title: "Budget", category: "Travel" }, { id: "n3", title: "Ideas", category: "Languages" }], uncategorized: 2 };
    mount(<NotesWorkspacePage />);
    tab("categories");
    await waitFor(() => screen.getByTestId("button-categorize-ai"));
    fireEvent.click(screen.getByTestId("button-categorize-ai"));
    await waitFor(() => expect(screen.getByTestId("categorize-proposal").textContent).toMatch(/suggests a category for 2 notes\. Nothing is filed until you apply it/));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-apply-category-n3"));
    await waitFor(() => expect(writes()).toEqual([{ method: "PATCH", url: "/api/notes/n3", body: { category: "Languages" } }]));
  });
});

describe("Notes: AI Assistant and AI Insights", () => {
  it("a conversation sends the whole exchange and the open note, shows what was read, and changes nothing", async () => {
    notes = NOTES();
    answers["/api/workspace/notes/chat"] = { answer: "You are planning a trip to Lisbon (Trip plan).", notesRead: 3, notesTotal: 3, usedPortol: false };
    mount(<NotesWorkspacePage />);
    tab("assistant");
    fireEvent.change(screen.getByTestId("notes-assistant-input"), { target: { value: "What am I planning?" } });
    fireEvent.click(screen.getByTestId("notes-assistant-send"));
    await waitFor(() => expect(screen.getByTestId("notes-assistant-assistant").textContent).toMatch(/Lisbon \(Trip plan\)\.Read 3 of 3 notes\./));
    fireEvent.change(screen.getByTestId("notes-assistant-input"), { target: { value: "And the budget?" } });
    fireEvent.click(screen.getByTestId("notes-assistant-send"));
    await waitFor(() => expect(aiCalls("/api/workspace/notes/chat")).toHaveLength(2));
    expect(aiCalls("/api/workspace/notes/chat")[1].body.messages).toEqual([
      { role: "user", content: "What am I planning?" },
      { role: "assistant", content: "You are planning a trip to Lisbon (Trip plan)." },
      { role: "user", content: "And the budget?" },
    ]);
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("notes-assistant").textContent).toMatch(/not saved: it ends when you close the workspace/);
  });

  it("a failed answer keeps the question, says why, and offers a retry — never a made-up reply", async () => {
    failUrl = "/api/workspace/notes/chat";
    mount(<NotesWorkspacePage />);
    tab("assistant");
    fireEvent.change(screen.getByTestId("notes-assistant-input"), { target: { value: "Hello?" } });
    fireEvent.click(screen.getByTestId("notes-assistant-send"));
    await waitFor(() => expect(screen.getByTestId("notes-assistant-error").textContent).toMatch(/request to the AI model failed/));
    expect(screen.getByTestId("notes-assistant-user").textContent).toBe("Hello?");
    expect(screen.queryByTestId("notes-assistant-assistant")).toBeNull();
  });

  it("open check-list items are counted from the notes with no AI call", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("insights");
    await waitFor(() => expect(screen.getByTestId("insights-open-items").textContent).toMatch(/Trip plan · 2 open/));
    expect(screen.getByTestId("notes-insights").textContent).toMatch(/Open check-list items · 2/);
    expect(calls.filter((c) => c.url.startsWith("/api/workspace/"))).toEqual([]);
  });

  it("insights are asked for on a tap, and a note they name opens in the Editor", async () => {
    notes = NOTES();
    answers["/api/workspace/notes/insights"] = { notesRead: 3, notesTotal: 3, insights: {
      recurring: [{ text: "Lisbon comes up twice.", notes: [{ id: "n1", title: "Trip plan" }, { id: "n3", title: "Ideas" }] }], related: [], unfinished: [], connections: [],
    } };
    mount(<NotesWorkspacePage />);
    tab("insights");
    await waitFor(() => screen.getByTestId("insights-open-items"));
    expect(aiCalls("/api/workspace/notes/insights")).toHaveLength(0); // not on opening the tab
    fireEvent.click(screen.getByTestId("button-notes-insights"));
    await waitFor(() => expect(screen.getByTestId("notes-insights-recurring").textContent).toMatch(/Lisbon comes up twice\./));
    expect(screen.getByTestId("notes-insights-related").textContent).toMatch(/No notes clearly belong together/);
    fireEvent.click(screen.getByTestId("insight-note-n3"));
    await waitFor(() => expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Ideas"));
    expect(writes()).toEqual([]);
  });
});

describe("what the AI may read", () => {
  it("shows the stored switches; turning one on saves the whole row with only that changed", async () => {
    mount(<NotesWorkspacePage />);
    tab("assistant");
    await waitFor(() => expect(screen.getByTestId("ai-access-line-notes").textContent).toMatch(/Reads: All my notes\./));
    fireEvent.click(screen.getByTestId("button-ai-access-notes"));
    const portol = await screen.findByTestId("ai-access-notes-portol");
    expect(portol.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("ai-access-notes").textContent).toMatch(/Journal entries stay private to the Journal/);
    fireEvent.click(portol);
    await waitFor(() => expect(storedAccess).not.toBeNull());
    expect(parseWorkspaceAiAccess(storedAccess)).toEqual({ ...DEFAULT_WORKSPACE_AI_ACCESS, notes: { allNotes: true, portol: true, memory: true } });
    await waitFor(() => expect(screen.getByTestId("ai-access-notes-portol").getAttribute("aria-checked")).toBe("true"));
  });

  it("a setting that could not be read is an error with a retry, and nothing can be switched over it", async () => {
    prefFails = true;
    mount(<NotesWorkspacePage />);
    tab("assistant");
    await waitFor(() => expect(screen.getByTestId("ai-access-line-notes").textContent).toMatch(/Couldn't load your AI access settings/));
    fireEvent.click(screen.getByTestId("button-ai-access-notes"));
    expect((await screen.findByTestId("ai-access-error")).textContent).toMatch(/Couldn't load your AI access settings/);
    expect(screen.queryByTestId("ai-access-notes-portol")).toBeNull();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("Notes: history, last opened, drafts", () => {
  it("the note last open comes back, and reopening it writes nothing", async () => {
    notes = NOTES();
    mount(<NotesWorkspacePage />);
    tab("all");
    await waitFor(() => screen.getByTestId("all-note-n2"));
    fireEvent.click(within(screen.getByTestId("all-note-n2")).getByTitle("Open in the editor"));
    await waitFor(() => expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Budget"));
    cleanup();
    mount(<NotesWorkspacePage />);
    await waitFor(() => expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Budget"));
    expect(screen.getByTestId("workspace-tab-editor").getAttribute("aria-selected")).toBe("true");
    await settle(NOTE_AUTOSAVE_MS + 200);
    expect(writes()).toEqual([]);
  });

  it("a version is previewed, and restoring it takes two taps and shows the restored text as saved", async () => {
    notes = NOTES();
    versions = [{ id: "v1", savedAt: "2026-11-20T10:00:00.000Z", title: "Trip plan", reason: "edit", preview: "the older text", words: 3, content: "the older text" }];
    window.localStorage.setItem("portol_ws_last:notes", JSON.stringify({ tab: "editor", id: "n1" }));
    mount(<NotesWorkspacePage />);
    await waitFor(() => expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Trip plan"));
    fireEvent.click(screen.getByTestId("button-note-history"));
    const row = await screen.findByTestId("version-v1");
    expect(row.textContent).toMatch(/3 words · the older text/);
    fireEvent.click(within(row).getAllByRole("button")[0]);
    await waitFor(() => expect(screen.getByTestId("version-preview").textContent).toBe("the older text"));
    fireEvent.click(screen.getByTestId("button-version-restore-v1"));
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("button-version-restore-v1").textContent).toMatch(/Tap again to replace the current text/);
    fireEvent.click(screen.getByTestId("button-version-restore-v1"));
    await waitFor(() => expect(writes()).toEqual([{ method: "POST", url: "/api/workspace/versions/note/n1/restore", body: { versionId: "v1" } }]));
    await waitFor(() => expect(screen.getByTestId("workspace-save-status").textContent).toBe("Saved"));
    await settle(NOTE_AUTOSAVE_MS + 200);
    expect(writes()).toHaveLength(1); // showing the restored text is not an edit
  });

  it("no earlier versions is said plainly", async () => {
    notes = NOTES();
    window.localStorage.setItem("portol_ws_last:notes", JSON.stringify({ id: "n1" }));
    mount(<NotesWorkspacePage />);
    await waitFor(() => screen.getByTestId("button-note-history"));
    fireEvent.click(screen.getByTestId("button-note-history"));
    await waitFor(() => expect(screen.getByTestId("versions-empty").textContent).toMatch(/No earlier versions yet/));
  });

  it("writing kept on this device is offered, not applied; Restore puts it back and saves it", async () => {
    window.localStorage.setItem("portol_ws_draft:notes", JSON.stringify({ id: null, title: "", text: "words the server never got", at: Date.now() }));
    mount(<NotesWorkspacePage />);
    fireEvent.click(screen.getByTestId("button-note-mode"));
    expect(screen.getByTestId("workspace-draft-recovery").textContent).toMatch(/Unsaved writing .* was kept on this device: “words the server never got/);
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("");
    await settle(NOTE_AUTOSAVE_MS + 200);
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-draft-restore"));
    await waitFor(() => expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("words the server never got"));
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notes", body: { content: "words the server never got" } });
    await waitFor(() => expect(window.localStorage.getItem("portol_ws_draft:notes")).toBeNull());
    expect(screen.queryByTestId("workspace-draft-recovery")).toBeNull();
  });

  it("a kept draft the server already has is dropped without asking; Discard takes two taps", async () => {
    notes = NOTES();
    window.localStorage.setItem("portol_ws_draft:notes", JSON.stringify({ id: "n2", title: "", text: "Trip fund 1200 of 3000", at: Date.now() }));
    mount(<NotesWorkspacePage />);
    await waitFor(() => expect(screen.queryByTestId("workspace-draft-recovery")).toBeNull());
    expect(window.localStorage.getItem("portol_ws_draft:notes")).toBeNull();
    cleanup();
    window.localStorage.setItem("portol_ws_draft:notes", JSON.stringify({ id: null, title: "", text: "something else entirely", at: Date.now() }));
    mount(<NotesWorkspacePage />);
    fireEvent.click(screen.getByTestId("button-draft-discard"));
    expect(window.localStorage.getItem("portol_ws_draft:notes")).not.toBeNull();
    fireEvent.click(screen.getByTestId("button-draft-discard"));
    expect(window.localStorage.getItem("portol_ws_draft:notes")).toBeNull();
    expect(screen.queryByTestId("workspace-draft-recovery")).toBeNull();
  });

  it("while it is unsaved, what is typed is kept on the device; once saved the copy is dropped", async () => {
    failUrl = "/api/notes";
    mount(<NotesWorkspacePage />);
    fireEvent.click(screen.getByTestId("button-note-mode"));
    fireEvent.change(screen.getByTestId("input-note-content"), { target: { value: "typed while offline" } });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("portol_ws_draft:notes") || "{}").text).toBe("typed while offline"));
    await waitFor(() => expect(screen.getByTestId("workspace-save-status").textContent).toMatch(/Couldn't save/), { timeout: 3000 });
    expect(window.localStorage.getItem("portol_ws_draft:notes")).not.toBeNull(); // the save failed: still kept
    failUrl = null;
    fireEvent.click(screen.getByTestId("button-workspace-save"));
    await waitFor(() => expect(window.localStorage.getItem("portol_ws_draft:notes")).toBeNull(), { timeout: 3000 });
  });
});

const ENTRIES = () => [
  { id: "j1", date: TODAY, mood: "good", title: "A good day", content: "Walked by the river.", tags: ["stress:2", "emotion:calm", "walk"], energy: 4, linkedProfiles: [], createdAt: `${TODAY}T08:00:00Z` },
  { id: "j2", date: dayBefore(1), mood: "bad", title: "Rough", content: "Argued with Sam about money.", tags: ["stress:5", "emotion:anxious"], energy: 2, linkedProfiles: [], createdAt: `${dayBefore(1)}T08:00:00Z` },
  { id: "j3", date: dayBefore(3), mood: "okay", title: "", content: "Quiet day.", tags: [], linkedProfiles: [], createdAt: `${dayBefore(3)}T08:00:00Z` },
  { id: "j4", date: dayBefore(200), mood: "great", title: "Long ago", content: "A trip.", tags: ["emotion:joyful"], energy: 5, linkedProfiles: [], createdAt: `${dayBefore(200)}T08:00:00Z` },
];
const write = (text: string) => fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: text } });

describe("Journal: the app's own navigation", () => {
  it("has seven tabs and opens on New Entry; walking through them writes nothing", async () => {
    entries = ENTRIES();
    mount(<JournalWorkspacePage />);
    const tabs = within(screen.getByTestId("workspace-tabs")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["New Entry", "Past Entries", "Reflection Coach", "AI Insights", "Trends", "Guided Journaling", "Personal Growth"]);
    expect(screen.getByTestId("workspace-tab-new").getAttribute("aria-selected")).toBe("true");
    for (const id of ["past", "coach", "insights", "trends", "guided", "growth", "new"]) tab(id);
    await settle(JOURNAL_AUTOSAVE_MS + 200);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("energy, stress and emotions are saved with the entry: energy as its own figure, the rest beside its tags", async () => {
    mount(<JournalWorkspacePage />);
    write("Slept badly and it showed.");
    fireEvent.change(screen.getByTestId("input-journal-tags"), { target: { value: "work" } });
    fireEvent.click(screen.getByTestId("button-journal-feelings"));
    fireEvent.click(screen.getByTestId("button-energy-2"));
    fireEvent.click(screen.getByTestId("button-stress-4"));
    fireEvent.click(screen.getByTestId("button-emotion-tired"));
    fireEvent.click(screen.getByTestId("button-emotion-anxious"));
    expect(screen.getByTestId("button-journal-feelings").textContent).toMatch(/Energy: Low · Stress: High · tired, anxious/);
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/journal", body: { energy: 2, tags: ["work", "stress:4", "emotion:tired", "emotion:anxious"] } });
    // Taking them off again is saved too: the level is cleared, not left behind.
    fireEvent.click(screen.getByTestId("button-energy-2"));
    fireEvent.click(screen.getByTestId("button-emotion-tired"));
    await waitFor(() => expect(writes()).toHaveLength(2), { timeout: 4000 });
    expect(writes()[1]).toMatchObject({ method: "PATCH", url: "/api/journal/j-new", body: { energy: null, tags: ["work", "stress:4", "emotion:anxious"] } });
  });

  it("opening an entry shows its feelings and keeps them when only the words change", async () => {
    entries = ENTRIES();
    mount(<JournalWorkspacePage />);
    tab("past");
    await waitFor(() => screen.getByTestId("past-entry-j2"));
    fireEvent.click(screen.getByTestId("past-entry-j2"));
    await waitFor(() => expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("Argued with Sam about money."));
    expect(screen.getByTestId("button-journal-feelings").textContent).toMatch(/Energy: Low · Stress: Very high · anxious/);
    expect((screen.getByTestId("input-journal-tags") as HTMLInputElement).value).toBe(""); // the pointers are not shown as labels
    write("Argued with Sam about money. We made up.");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: "/api/journal/j2", body: { energy: 2, tags: ["stress:5", "emotion:anxious"] } });
  });
});

describe("Journal: Past Entries", () => {
  it("lists every entry, newest first, and search says how many of how many", async () => {
    entries = ENTRIES();
    mount(<JournalWorkspacePage />);
    tab("past");
    await waitFor(() => expect(screen.getByTestId("past-count").textContent).toBe("4 entries"));
    const ids = Array.from(screen.getByTestId("journal-past").querySelectorAll('[data-testid^="past-entry-"]')).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["past-entry-j1", "past-entry-j2", "past-entry-j3", "past-entry-j4"]);
    fireEvent.change(screen.getByTestId("input-past-search"), { target: { value: "anxious" } }); // an emotion is searchable
    expect(screen.getByTestId("past-count").textContent).toBe("1 entry of 4");
    fireEvent.change(screen.getByTestId("input-past-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("past-empty").textContent).toMatch(/No entry matches “zzz”/);
  });

  it("the calendar marks the days written on; a day opens its entries", async () => {
    entries = ENTRIES();
    mount(<JournalWorkspacePage />);
    tab("past");
    fireEvent.click(screen.getByTestId("button-past-calendar"));
    const today = await screen.findByTestId(`calendar-day-${TODAY}`);
    expect(today.getAttribute("aria-label")).toMatch(/1 entry/);
    fireEvent.click(today);
    expect(screen.getByTestId("past-entry-j1")).toBeTruthy();
    expect(screen.queryByTestId("past-entry-j4")).toBeNull();
    // A day with nothing written cannot be opened and says so.
    const blank = Array.from(screen.getByTestId("past-calendar").querySelectorAll<HTMLButtonElement>('[data-testid^="calendar-day-"]')).find((b) => b.disabled);
    if (blank) expect(blank.getAttribute("aria-label")).toMatch(/nothing written/);
  });

  it("a failed list is an error with a retry on every tab that reads it", async () => {
    listFails = true;
    mount(<JournalWorkspacePage />);
    for (const id of ["past", "trends", "insights"]) {
      tab(id);
      await waitFor(() => expect(screen.getByTestId("journal-tab-error").textContent).toMatch(/Couldn't load your journal/));
    }
    expect(screen.queryByTestId("trends-empty")).toBeNull();
  });
});

describe("Journal: Trends", () => {
  it("draws mood, energy and stress from the entries, and the range says what it leaves out", async () => {
    entries = ENTRIES();
    mount(<JournalWorkspacePage />);
    tab("trends");
    await waitFor(() => expect(screen.getByTestId("trends-range-note").textContent).toMatch(/3 entries in this range — 1 older entry is outside it/));
    expect(screen.getByTestId("trend-mood-chart")).toBeTruthy();
    expect(screen.getByTestId("trend-mood").textContent).toMatch(/average 3 of 5 over 3 days/);
    // Three days with a mood: one short of a direction, and it says so instead of stating one.
    expect(screen.getByTestId("trend-mood-change").textContent).toBe("1 more day to show a direction");
    // Only two of those days have a stress level: two points, not three with a zero.
    expect(screen.getByTestId("trend-stress-chart").querySelectorAll("circle")).toHaveLength(2);
    expect(screen.getByTestId("trend-emotions").textContent).toMatch(/anxious.*1 entry/);
    fireEvent.click(screen.getByTestId("trend-range-all"));
    expect(screen.getByTestId("trends-range-note").textContent).toMatch(/^4 entries in this range\./);
    expect(screen.getByTestId("trend-mood-change").textContent).toMatch(/^(Up|Down|Steady)/);
    expect(screen.getByTestId("journal-trends").textContent).toMatch(/a day with nothing written is a gap, not a low/);
  });

  it("with no readings a chart says what to set, never a flat line", async () => {
    entries = [{ id: "j9", date: TODAY, mood: "okay", title: "", content: "x", tags: [], linkedProfiles: [], createdAt: `${TODAY}T08:00:00Z` }];
    mount(<JournalWorkspacePage />);
    tab("trends");
    await waitFor(() => expect(screen.getByTestId("trend-energy-empty").textContent).toMatch(/No entry in this range has an energy level/));
    expect(screen.queryByTestId("trend-energy-chart")).toBeNull();
    cleanup();
    entries = [];
    mount(<JournalWorkspacePage />);
    tab("trends");
    await waitFor(() => expect(screen.getByTestId("trends-empty").textContent).toMatch(/Trends appear once you have written a few entries/));
  });
});

describe("Journal: the coach, insights, growth and guided prompts", () => {
  it("the coach says what it is not, sends the conversation with the page being written, and changes nothing", async () => {
    entries = ENTRIES();
    answers["/api/workspace/journal/coach"] = { answer: "Money came up on the day you felt most stressed.", entriesRead: 4, entriesTotal: 4, used: { pastEntries: true, wellness: false, activity: false } };
    mount(<JournalWorkspacePage />);
    write("Today I am thinking about Sam.");
    tab("coach");
    expect(screen.getByTestId("journal-coach-boundary").textContent).toMatch(/not a therapist.*does not diagnose/i);
    // The owner's own example questions are offered.
    expect(screen.getByTestId("journal-coach").textContent).toMatch(/What situations seem to cause me the most stress\?/);
    fireEvent.click(screen.getByText("What patterns do you notice in my journal entries?"));
    await waitFor(() => expect(screen.getByTestId("journal-coach-assistant").textContent).toMatch(/most stressed\.Read 4 of 4 entries\. Your entries are not changed\./));
    expect(aiCalls("/api/workspace/journal/coach")[0].body).toEqual({ messages: [{ role: "user", content: "What patterns do you notice in my journal entries?" }], draft: "Today I am thinking about Sam." });
    expect(aiCalls("/api/workspace/journal/coach")).toHaveLength(1);
  });

  it("the journal's switches are its own: wellness and calendar are off until turned on", async () => {
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => expect(screen.getByTestId("ai-access-line-journal").textContent).toMatch(/Reads: My past entries\./));
    fireEvent.click(screen.getByTestId("button-ai-access-journal"));
    expect((await screen.findByTestId("ai-access-journal-wellness")).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("ai-access-journal-wellness"));
    await waitFor(() => expect(parseWorkspaceAiAccess(storedAccess).journal).toEqual({ pastEntries: true, wellness: true, activity: false, memory: true }));
    expect(parseWorkspaceAiAccess(storedAccess).word.journal).toBe(false); // nothing else moved
  });

  it("insights are asked for on a tap; a day an observation cites opens that entry", async () => {
    entries = ENTRIES();
    answers["/api/workspace/journal/insights"] = { entriesRead: 4, entriesTotal: 4, usedWellness: false, insights: { focus: "insights", sections: [
      { key: "patterns", label: "Emotional patterns", items: [{ title: "Money and stress", detail: "The hardest day was about money.", days: [dayBefore(1)] }] },
      { key: "concerns", label: "Recurring concerns", items: [] }, { key: "changes", label: "What has changed", items: [] }, { key: "progress", label: "Progress", items: [] },
    ] } };
    mount(<JournalWorkspacePage />);
    tab("insights");
    await waitFor(() => expect((screen.getByTestId("button-journal-insights") as HTMLButtonElement).disabled).toBe(false));
    expect(aiCalls("/api/workspace/journal/insights")).toHaveLength(0);
    expect(screen.getByTestId("journal-insights").textContent).toMatch(/not a therapist/i);
    fireEvent.click(screen.getByTestId("button-journal-insights"));
    await waitFor(() => expect(screen.getByTestId("journal-section-patterns").textContent).toMatch(/Money and stress/));
    expect(aiCalls("/api/workspace/journal/insights")[0].body).toEqual({ focus: "insights" });
    expect(screen.getByTestId("journal-section-concerns").textContent).toMatch(/Nothing stood out here/);
    fireEvent.click(screen.getByTestId(`insight-day-${dayBefore(1)}`));
    await waitFor(() => expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("Argued with Sam about money."));
    expect(writes()).toEqual([]);
  });

  it("Personal Growth asks with its own focus; under three entries it says why it waits", async () => {
    entries = ENTRIES();
    answers["/api/workspace/journal/insights"] = { entriesRead: 4, entriesTotal: 4, insights: { focus: "growth", sections: [{ key: "accomplishments", label: "Accomplishments", items: [{ title: "Made up with Sam", detail: "You went back to the conversation.", days: [dayBefore(1)] }] }] } };
    mount(<JournalWorkspacePage />);
    tab("growth");
    await waitFor(() => expect((screen.getByTestId("button-journal-growth") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-journal-growth"));
    await waitFor(() => expect(screen.getByTestId("journal-section-accomplishments").textContent).toMatch(/Made up with Sam/));
    expect(aiCalls("/api/workspace/journal/insights")[0].body).toEqual({ focus: "growth" });
    cleanup();
    entries = ENTRIES().slice(0, 2);
    mount(<JournalWorkspacePage />);
    tab("growth");
    await waitFor(() => expect(screen.getByTestId("journal-growth").textContent).toMatch(/not enough written yet to see a pattern/));
    expect((screen.getByTestId("button-journal-growth") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a guided prompt is put on a new page and nothing is saved until the writer writes", async () => {
    mount(<JournalWorkspacePage />);
    tab("guided");
    expect(screen.getAllByTestId("guided-prompt").length).toBe(GUIDED_EXERCISES.reduce((n, e) => n + e.prompts.length, 0));
    expect((screen.getByTestId("button-personal-prompts") as HTMLButtonElement).disabled).toBe(true); // nothing written yet to personalise from
    fireEvent.click(screen.getByText("Who made today easier, and how?"));
    await waitFor(() => expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("Who made today easier, and how?\n"));
    expect(screen.getByTestId("workspace-tab-new").getAttribute("aria-selected")).toBe("true");
    await settle(JOURNAL_AUTOSAVE_MS + 300);
    expect(writes()).toEqual([]);
    write("Who made today easier, and how?\nMy sister, by calling.");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
  });

  it("personal prompts are written from the journal on a tap", async () => {
    entries = ENTRIES();
    answers["/api/workspace/journal/prompts"] = { prompts: ["What would make the next talk with Sam easier?"], entriesRead: 4 };
    mount(<JournalWorkspacePage />);
    tab("guided");
    await waitFor(() => expect((screen.getByTestId("button-personal-prompts") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("button-personal-prompts"));
    await waitFor(() => expect(screen.getByTestId("personal-prompts").textContent).toMatch(/next talk with Sam/));
  });
});

const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const COACH_MEMORY = () => ({
  remember: true, name: "Tron", lastTalked: daysAgoIso(3),
  memories: [{ id: "m1", text: "Sam is their partner", at: daysAgoIso(3), by: "ai" }, { id: "m2", text: "Works night shifts", at: daysAgoIso(3), by: "ai" }],
  turns: [{ role: "user", content: "Sam and I argued about money.", at: daysAgoIso(3) }, { role: "assistant", content: "That sounds draining. What set it off?", at: daysAgoIso(3) }],
});

describe("the coach remembers, and the person is in charge of what it keeps", () => {
  it("the earlier conversation is there again, and the screen says it is saved and how to stop that", async () => {
    memory.journal = COACH_MEMORY();
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => expect(screen.getByTestId("journal-coach-user").textContent).toBe("Sam and I argued about money."));
    expect(screen.getByTestId("journal-coach-assistant").textContent).toBe("That sounds draining. What set it off?");
    expect(screen.getByTestId("button-memory-journal").textContent).toMatch(/What I remember · 2/);
    expect(screen.getByTestId("journal-coach-saved-note").textContent).toMatch(/saved privately on your account.*turn remembering off in AI access.*Nothing in your notes or journal is changed/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]); // opening it wrote nothing
  });

  it("with nothing said yet it greets them by name and says how long it has been", async () => {
    memory.journal = { ...COACH_MEMORY(), turns: [] };
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => expect(screen.getByTestId("journal-coach-opening").textContent).toBe("Hi Tron. Good to see you again — we last talked 3 days ago. I remember what you've told me, so you don't have to start over. What's on your mind?"));
    cleanup();
    memory.journal = { remember: true, name: "Tron", lastTalked: null, memories: [], turns: [] };
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => expect(screen.getByTestId("journal-coach-opening").textContent).toMatch(/^Hi Tron\. I'm here to listen\./));
  });

  it("what it kept from a reply is shown under it, and the count goes up", async () => {
    memory.journal = { remember: true, name: "Tron", lastTalked: null, memories: [], turns: [] };
    answers["/api/workspace/journal/coach"] = { answer: "Porto sounds lovely. What do you miss most about her?", entriesRead: 0, entriesTotal: 0, used: { pastEntries: true, memory: true }, remembered: ["Their sister Ana lives in Porto"] };
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => screen.getByTestId("journal-coach-opening"));
    fireEvent.change(screen.getByTestId("journal-coach-input"), { target: { value: "I miss my sister Ana, she lives in Porto." } });
    memory.journal.memories = [{ id: "m9", text: "Their sister Ana lives in Porto", at: new Date().toISOString(), by: "ai" }]; // what the server will hold after the reply
    fireEvent.click(screen.getByTestId("journal-coach-send"));
    await waitFor(() => expect(screen.getByTestId("journal-coach-remembered").textContent).toBe("I'll remember: Their sister Ana lives in Porto"));
    await waitFor(() => expect(screen.getByTestId("button-memory-journal").textContent).toMatch(/What I remember · 1/));
  });

  it("every memory is listed; forgetting one takes two taps; they can add their own", async () => {
    memory.journal = COACH_MEMORY();
    mount(<JournalWorkspacePage />);
    tab("coach");
    fireEvent.click(await screen.findByTestId("button-memory-journal"));
    const panel = screen.getByTestId("memory-panel-journal");
    expect(panel.textContent).toMatch(/Only this assistant reads them/);
    expect(within(screen.getByTestId("memory-list")).getAllByRole("listitem").map((li) => li.textContent?.replace(/From our conversation.*$/, ""))).toEqual(["Works night shifts", "Sam is their partner"]);
    fireEvent.click(screen.getByTestId("button-forget-m1"));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    fireEvent.click(screen.getByTestId("button-forget-m1"));
    await waitFor(() => expect(screen.queryByTestId("memory-m1")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/workspace/memory/journal/items/m1"]);
    fireEvent.change(screen.getByTestId("input-memory-journal"), { target: { value: "My mother's birthday is hard for me" } });
    fireEvent.click(screen.getByTestId("button-memory-add-journal"));
    await waitFor(() => expect(screen.getByTestId("memory-list").textContent).toMatch(/My mother's birthday is hard for me.*You added this/));
    expect(calls.find((c) => c.url.endsWith("/remember"))!.body).toEqual({ text: "My mother's birthday is hard for me" });
  });

  it("a new conversation clears the saved one (two taps) and keeps what it remembers; Forget everything clears both", async () => {
    memory.journal = COACH_MEMORY();
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => screen.getByTestId("journal-coach-user"));
    fireEvent.click(screen.getByTestId("journal-coach-new"));
    expect(screen.getByTestId("journal-coach-new").textContent).toMatch(/Tap again to clear this conversation \(what I remember stays\)/);
    expect(screen.getByTestId("journal-coach-user")).toBeTruthy();
    fireEvent.click(screen.getByTestId("journal-coach-new"));
    await waitFor(() => expect(screen.queryByTestId("journal-coach-user")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/workspace/memory/journal/conversation"]);
    expect(screen.getByTestId("button-memory-journal").textContent).toMatch(/What I remember · 2/);
    fireEvent.click(screen.getByTestId("button-memory-journal"));
    fireEvent.click(screen.getByTestId("button-forget-all-journal"));
    expect(memory.journal.memories).toHaveLength(2);
    fireEvent.click(screen.getByTestId("button-forget-all-journal"));
    await waitFor(() => expect(screen.getByTestId("memory-empty")).toBeTruthy());
    expect(memory.journal.memories).toEqual([]);
  });

  it("with remembering off it says so, shows no earlier conversation, and a new conversation is one tap", async () => {
    memory.journal = { ...COACH_MEMORY(), remember: false };
    answers["/api/workspace/journal/coach"] = { answer: "I'm listening.", entriesRead: 0, entriesTotal: 0, used: { pastEntries: true, memory: false }, remembered: [] };
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => expect(screen.getByTestId("button-memory-journal").textContent).toBe(" Remembering is off"));
    expect(screen.queryByTestId("journal-coach-user")).toBeNull();
    expect(screen.getByTestId("journal-coach-saved-note").textContent).toMatch(/Remembering is off: this conversation is not saved/);
    fireEvent.change(screen.getByTestId("journal-coach-input"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("journal-coach-send"));
    await waitFor(() => screen.getByTestId("journal-coach-assistant"));
    fireEvent.click(screen.getByTestId("journal-coach-new"));
    await waitFor(() => expect(screen.queryByTestId("journal-coach-user")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("a memory that could not be loaded is an error with a retry, never 'nothing remembered'", async () => {
    memoryFails = true;
    mount(<JournalWorkspacePage />);
    tab("coach");
    await waitFor(() => expect(screen.getByTestId("journal-coach-memory-error").textContent).toMatch(/Couldn't load what I remember\. Retry/));
    expect(screen.queryByTestId("button-memory-journal")).toBeNull();
  });

  it("the Notes assistant remembers too, in its own memory", async () => {
    memory.notes = { remember: true, name: "Tron", lastTalked: daysAgoIso(1), memories: [{ id: "n1m", text: "Prefers notes grouped by project", at: daysAgoIso(1), by: "ai" }], turns: [{ role: "user", content: "Group by project.", at: daysAgoIso(1) }, { role: "assistant", content: "Will do.", at: daysAgoIso(1) }] };
    mount(<NotesWorkspacePage />);
    tab("assistant");
    await waitFor(() => expect(screen.getByTestId("notes-assistant-assistant").textContent).toBe("Will do."));
    expect(screen.getByTestId("button-memory-notes").textContent).toMatch(/What I remember · 1/);
  });
});

describe("Journal: last opened", () => {
  it("today's entry comes back; an older day's does not (today's words must not land on it)", async () => {
    entries = ENTRIES();
    window.localStorage.setItem("portol_ws_last:journal", JSON.stringify({ id: "j1" }));
    mount(<JournalWorkspacePage />);
    await waitFor(() => expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("Walked by the river."));
    cleanup();
    window.localStorage.setItem("portol_ws_last:journal", JSON.stringify({ id: "j2" }));
    mount(<JournalWorkspacePage />);
    await waitFor(() => expect(screen.getByTestId("journal-week")).toBeTruthy());
    await settle(200);
    expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("");
    await settle(JOURNAL_AUTOSAVE_MS + 200);
    expect(writes()).toEqual([]);
  });
});
