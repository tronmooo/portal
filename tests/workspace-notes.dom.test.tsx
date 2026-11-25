// @vitest-environment jsdom
//
// Notes workspace (owner request 2026-11-22). Renders the real page.
//  - Opening writes nothing; the first text typed creates the note, later
//    text updates THAT note.
//  - A note whose text already exists as another note is not adopted, so the
//    other note is never overwritten (J1).
//  - The AI's suggestion changes nothing until "Use this".
//  - A failed list is an error with a retry, never "no notes" (Rule 7).
//  - The X saves what is pending, then goes back to AI Chat.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let notes: any[] = [];
let listFails = false;
let postAnswer: (body: any) => any = (body) => ({ id: "n-new", ...body });
let aiAnswer: any = { content: "- [ ] milk\n- [ ] eggs" };

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}) }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    let data: any = {};
    if (method === "POST" && url === "/api/notes") data = postAnswer(body);
    else if (url === "/api/workspace/notes/assist") data = aiAnswer;
    else if (url === "/api/upload/save-only") data = { documentId: "doc-9", documentName: body.fileName };
    else if (method === "PATCH") data = { id: url.split("/").pop(), ...body };
    return { ok: true, json: async () => data };
  }),
}));

import NotesWorkspacePage, { NOTE_AUTOSAVE_MS, noteTitleFromText } from "../client/src/pages/workspace-notes";

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: {
      retry: false,
      queryFn: async ({ queryKey }) => {
        if (queryKey[0] === "/api/notes") { if (listFails) throw new Error("500: boom"); return notes; }
        if (queryKey[0] === "/api/profiles") return [{ id: "p1", name: "Tron", type: "self" }, { id: "p2", name: "Honda", type: "vehicle" }];
        return [];
      },
    } },
  });
  const view = render(<QueryClientProvider client={client}><NotesWorkspacePage /></QueryClientProvider>);
  // These tests type into the plain-markdown editor (a textarea); the choice
  // sticks for the notes opened after it. The rich editor is the same note
  // through shared/note-markdown.ts, pinned by tests/note-markdown.test.ts.
  fireEvent.click(screen.getByTestId("button-note-mode"));
  return view;
}
const type = (text: string) => fireEvent.change(screen.getByTestId("input-note-content"), { target: { value: text } });
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.includes("/assist") && !c.url.includes("/upload/"));
const settle = (ms = NOTE_AUTOSAVE_MS + 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  window.localStorage.clear();
  calls.length = 0; navigated.length = 0; notes = []; listFails = false;
  postAnswer = (body) => ({ id: "n-new", ...body });
  aiAnswer = { content: "- [ ] milk\n- [ ] eggs" };
});
afterEach(cleanup);

describe("Notes workspace", () => {
  it("a note with no typed title is named by its first line", () => {
    expect(noteTitleFromText("## Groceries\n- milk")).toBe("Groceries");
    expect(noteTitleFromText("- [ ] call the dentist")).toBe("call the dentist");
    expect(noteTitleFromText("")).toBe("");
  });

  it("opening writes nothing", async () => {
    mount();
    await settle();
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Not saved yet");
  });

  it("the first text creates the note once; more text updates that same note", async () => {
    mount();
    type("Groceries\nmilk");
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Unsaved changes");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notes", body: { title: "Groceries", content: "Groceries\nmilk" } });
    await waitFor(() => expect(screen.getByTestId("workspace-save-status").textContent).toBe("Saved"));

    type("Groceries\nmilk\neggs");
    await waitFor(() => expect(writes()).toHaveLength(2), { timeout: 3000 });
    expect(writes()[1]).toMatchObject({ method: "PATCH", url: "/api/notes/n-new", body: { content: "Groceries\nmilk\neggs" } });
  });

  it("text that already exists as another note does not adopt that note", async () => {
    postAnswer = (body) => (body.content === "Buy" ? { id: "n-other", ...body, deduped: true } : { id: "n-mine", ...body });
    mount();
    type("Buy");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    type("Buy tires for the Honda");
    await waitFor(() => expect(writes()).toHaveLength(2), { timeout: 3000 });
    // Never a PATCH to the other note: a second create, of this note.
    expect(writes()[1]).toMatchObject({ method: "POST", url: "/api/notes", body: { content: "Buy tires for the Honda" } });
    expect(writes().some((c) => c.url.includes("n-other"))).toBe(false);
  });

  it("the AI's suggestion changes nothing until Use this", async () => {
    mount();
    type("milk, eggs");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    fireEvent.click(screen.getByText("Turn this into a checklist"));
    // The suggestion is shown formatted: two check items.
    await waitFor(() => expect(screen.getByTestId("note-ai-proposal").querySelectorAll('li[data-type="taskItem"]')).toHaveLength(2));
    expect(screen.getByTestId("note-ai-proposal").textContent).toContain("milk");
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("milk, eggs");
    await settle();
    expect(writes()).toHaveLength(1); // still only the create

    fireEvent.click(screen.getByTestId("button-note-ai-use"));
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("- [ ] milk\n- [ ] eggs");
    await waitFor(() => expect(writes()).toHaveLength(2), { timeout: 3000 });
    expect(writes()[1]).toMatchObject({ method: "PATCH", body: { content: "- [ ] milk\n- [ ] eggs" } });
  });

  it("Discard drops the suggestion and writes nothing", async () => {
    mount();
    type("milk, eggs");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    fireEvent.click(screen.getByText("Organize this note"));
    await waitFor(() => screen.getByTestId("note-ai-proposal"));
    fireEvent.click(screen.getByTestId("button-note-ai-discard"));
    expect(screen.queryByTestId("note-ai-proposal")).toBeNull();
    await settle();
    expect(writes()).toHaveLength(1);
  });

  it("a failed list is an error with a retry, not an empty notebook", async () => {
    listFails = true;
    mount();
    await waitFor(() => screen.getByTestId("notes-list-error"));
    expect(screen.getByTestId("notes-list").textContent).not.toMatch(/No notes yet/);
    expect(screen.getByTestId("notes-list").textContent).toMatch(/Retry/);
  });

  it("saved notes are listed, and opening one edits that note", async () => {
    notes = [{ id: "n1", title: "Tires", content: "Buy tires", tags: ["car"], updatedAt: "2026-11-20T10:00:00Z" }];
    mount();
    fireEvent.click(await screen.findByTestId("note-row-n1"));
    await waitFor(() => expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("Buy tires"));
    expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Tires");
    await settle();
    expect(writes()).toEqual([]); // opening a note is not an edit
    type("Buy tires by Friday");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: "/api/notes/n1", body: { title: "Tires", content: "Buy tires by Friday", tags: ["car"] } });
  });

  it("a category is saved as the note's one category tag, beside its other tags", async () => {
    notes = [{ id: "n1", title: "Tires", content: "Buy tires", tags: ["car", "category:Garage"], updatedAt: "2026-11-20T10:00:00Z" }];
    mount();
    fireEvent.click(await screen.findByTestId("note-row-n1"));
    await waitFor(() => expect((screen.getByTestId("input-note-category") as HTMLInputElement).value).toBe("Garage"));
    expect((screen.getByTestId("input-note-tags") as HTMLInputElement).value).toBe("car");
    fireEvent.change(screen.getByTestId("input-note-category"), { target: { value: "Home" } });
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    expect(writes()[0].body.tags).toEqual(["car", "category:Home"]);
  });

  it("the category filter says what it hides, and is not a reason to say there are no notes", async () => {
    notes = [
      { id: "n1", title: "Tires", content: "Buy tires", tags: ["category:Garage"], updatedAt: "2026-11-20T10:00:00Z" },
      { id: "n2", title: "Soup", content: "Lentils", tags: ["category:Recipes"], updatedAt: "2026-11-21T10:00:00Z" },
      { id: "n3", title: "Loose", content: "No category", tags: [], updatedAt: "2026-11-22T10:00:00Z" },
    ];
    mount();
    fireEvent.click(await screen.findByTestId("notes-category-Garage"));
    expect(screen.queryByTestId("note-row-n2")).toBeNull();
    expect(screen.getByTestId("note-row-n1")).toBeTruthy();
    expect(screen.getByTestId("notes-filter-notice").textContent).toMatch(/Showing Garage only — 2 other notes are hidden/);
    fireEvent.change(screen.getByTestId("input-notes-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("notes-list").textContent).toMatch(/No note matches "zzz" in Garage/);
    fireEvent.change(screen.getByTestId("input-notes-search"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Show all"));
    expect(screen.getByTestId("note-row-n2")).toBeTruthy();
    expect(screen.queryByTestId("notes-filter-notice")).toBeNull();
  });

  it("an attached file is saved to Documents and linked from the note", async () => {
    mount();
    type("Lease notes");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    const file = new File(["%PDF-1.4"], "lease.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("input-note-attach-file"), { target: { files: [file] } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/upload/save-only")).toBe(true));
    expect(calls.find((c) => c.url === "/api/upload/save-only")!.body).toMatchObject({ fileName: "lease.pdf", mimeType: "application/pdf" });
    await waitFor(() => expect(screen.getByTestId("note-attachment-doc-9").textContent).toContain("lease.pdf"));
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("Lease notes\n\n[lease.pdf](#/documents/doc-9)");
  });

  it("the X saves what is pending, then returns to AI Chat", async () => {
    mount();
    type("Remember the passport");
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => expect(navigated).toEqual(["/chat"]));
    // Saved before leaving, without waiting out the typing pause.
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", body: { content: "Remember the passport" } });
  });

  it("Make a task turns the note into a task", async () => {
    mount();
    type("Call the dentist\nask about the crown");
    fireEvent.click(screen.getByTestId("button-note-to-task"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/tasks")).toBe(true));
    expect(calls.find((c) => c.url === "/api/tasks")).toMatchObject({ method: "POST", body: { title: "Call the dentist" } });
  });
});
