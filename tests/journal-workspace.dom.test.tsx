// @vitest-environment jsdom
//
// Journal workspace (owner request 2026-11-23). Renders the real page.
//  - Opening writes nothing; the first words create ONE draft entry, later
//    words update that entry (J1).
//  - A mood is sent as picked only when it was picked (J2).
//  - The X saves, titles an untitled entry written in this sitting, then
//    returns to AI Chat; opening an old entry and leaving writes nothing.
//  - A photo is a saved document the entry points at; the entry's own tags
//    are kept beside it.
//  - The AI answers about the journal and changes nothing.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { journalLabels, journalPhotoIds, journalTagsFor } from "../shared/journal-photos";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let entries: any[] = [];
let listFails = false;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}) }));
vi.mock("@/lib/document-preview", () => ({ useDocumentBlobUrl: () => ({ url: "blob:photo", blob: null, loading: false, error: false }) }));
vi.mock("@/pages/journal", () => {
  const Icon = () => null;
  const mk = (label: string) => ({ icon: Icon, label, color: "#888", bg: "bg-muted" });
  return { MOOD_CONFIG: { amazing: mk("Amazing"), great: mk("Great"), good: mk("Good"), okay: mk("Okay"), neutral: mk("Neutral"), bad: mk("Bad"), awful: mk("Awful"), terrible: mk("Terrible") } };
});
let scopeState: any = { mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false };
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => scopeState }));
const showEveryone = vi.fn();
vi.mock("@/lib/profileFilter", () => ({
  scopeLabel: (names: string[]) => names.join(", "),
  setFilterEveryone: () => showEveryone(),
}));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
vi.mock("@/lib/queryClient", () => ({
  BROWSER_TIMEZONE: "America/Los_Angeles",
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    let data: any = {};
    if (method === "GET" && url.startsWith("/api/journal")) { if (listFails) throw new Error("500: boom"); data = entries; }
    else if (method === "POST" && url === "/api/journal") data = { id: "j-new", ...body };
    else if (url === "/api/upload/save-only") data = { documentId: "doc-7" };
    else if (url === "/api/workspace/journal/reflect") data = { answer: "You wrote about a calm walk.", entriesRead: 3 };
    return { ok: true, json: async () => data };
  }),
}));

import JournalWorkspacePage, { JOURNAL_AUTOSAVE_MS, JOURNAL_PROMPTS } from "../client/src/pages/workspace-journal";

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: {
      retry: false,
      queryFn: async ({ queryKey }) => {
        if (queryKey[0] === "/api/profiles") return [{ id: "p1", name: "Tron", type: "self" }, { id: "p2", name: "Bob", type: "person" }];
        return [];
      },
    } },
  });
  return render(<QueryClientProvider client={client}><JournalWorkspacePage /></QueryClientProvider>);
}
const write = (text: string) => fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: text } });
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.includes("/reflect") && !c.url.includes("/upload/"));
const reads = () => calls.filter((c) => c.method === "GET");
const settle = (ms = JOURNAL_AUTOSAVE_MS + 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  calls.length = 0; navigated.length = 0; entries = []; listFails = false; showEveryone.mockClear();
  scopeState = { mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false };
});
afterEach(cleanup);

describe("photo pointers (pure)", () => {
  it("photos and the entry's own tags share the tag list without mixing", () => {
    const tags = journalTagsFor(["family", " family ", ""], ["d1", "d2", "d1"]);
    expect(tags).toEqual(["family", "photo:d1", "photo:d2"]);
    expect(journalPhotoIds(tags)).toEqual(["d1", "d2"]);
    expect(journalLabels(tags)).toEqual(["family"]);
    expect(journalPhotoIds(["photo:", "work"])).toEqual([]);
  });
});

describe("Journal workspace", () => {
  it("opening writes nothing", async () => {
    mount();
    await settle();
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Nothing written yet");
  });

  it("the first words create one draft entry with no picked mood; more words update it with the detected mood", async () => {
    mount();
    write("Long walk by the river, felt calm and happy.");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/journal", body: { content: "Long walk by the river, felt calm and happy.", draft: true, tags: [] } });
    expect("mood" in writes()[0].body).toBe(false);
    expect(writes()[0].body.entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    write("Long walk by the river, felt calm and happy. Slept well.");
    await waitFor(() => expect(writes()).toHaveLength(2), { timeout: 4000 });
    expect(writes()[1]).toMatchObject({ method: "PATCH", url: "/api/journal/j-new" });
    expect(typeof writes()[1].body.mood).toBe("string");
  });

  it("a mood that was picked is sent as the mood", async () => {
    mount();
    fireEvent.click(screen.getByTestId("button-mood-great"));
    expect(screen.getByTestId("journal-mood-source").textContent).toMatch(/You picked Great/);
    write("A day.");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
    expect(writes()[0].body.mood).toBe("great");
  });

  it("a prompt is put on the page for the writer to answer", () => {
    mount();
    fireEvent.click(screen.getByText(JOURNAL_PROMPTS[0]));
    expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe(`${JOURNAL_PROMPTS[0]}\n`);
  });

  it("the X saves at once, titles the untitled entry, then returns to AI Chat", async () => {
    mount();
    write("Remember this evening.");
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => expect(navigated).toEqual(["/chat"]));
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/journal", "PATCH /api/journal/j-new"]);
    expect(writes()[1].body).toEqual({ autoTitle: true });
  });

  it("opening an old untitled entry and leaving writes nothing", async () => {
    entries = [{ id: "j1", date: "2026-11-20", mood: "good", title: "", content: "An older day.", tags: ["family", "photo:d1"], linkedProfiles: ["p1"], createdAt: "2026-11-20T10:00:00Z" }];
    mount();
    fireEvent.click(await screen.findByTestId("journal-row-j1"));
    await waitFor(() => expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("An older day."));
    expect((screen.getByTestId("input-journal-tags") as HTMLInputElement).value).toBe("family");
    expect(screen.getByTestId("journal-photo-d1")).toBeTruthy();
    expect((screen.getByTestId("input-journal-date") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => expect(navigated).toEqual(["/chat"]));
    expect(writes()).toEqual([]);
  });

  it("a photo is saved to Documents and the entry points at it, keeping its tags", async () => {
    mount();
    write("Beach day.");
    fireEvent.change(screen.getByTestId("input-journal-tags"), { target: { value: "family" } });
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
    const file = new File(["jpeg"], "beach.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("input-journal-attach-library"), { target: { files: [file] } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/upload/save-only")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("journal-photo-doc-7")).toBeTruthy());
    await waitFor(() => expect(writes()).toHaveLength(2), { timeout: 4000 });
    expect(writes()[1]).toMatchObject({ method: "PATCH", url: "/api/journal/j-new", body: { tags: ["family", "photo:doc-7"] } });
  });

  it("the AI answers from the journal and changes nothing", async () => {
    mount();
    write("Tired tonight.");
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4000 });
    fireEvent.click(screen.getByText("Summarize today"));
    await waitFor(() => expect(screen.getByTestId("journal-ai-answer").textContent).toContain("You wrote about a calm walk."));
    expect(screen.getByTestId("journal-ai-answer").textContent).toMatch(/your entries are not changed/);
    expect(calls.find((c) => c.url.includes("/reflect"))!.body).toEqual({ instruction: "Summarize today", draft: "Tired tonight." });
    expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("Tired tonight.");
    await settle();
    expect(writes()).toHaveLength(1);
  });

  it("a failed list is an error with a retry, not an empty journal", async () => {
    listFails = true;
    mount();
    await waitFor(() => screen.getByTestId("journal-timeline-error"));
    expect(screen.getByTestId("journal-timeline").textContent).not.toMatch(/line up here/);
  });

  it("the timeline follows the app's profile scope, says so, and offers the way out", async () => {
    scopeState = { mode: "selected", selectedIds: ["p2"], selectedNames: ["Bob"], isFiltered: true };
    mount();
    await waitFor(() => expect(reads().some((c) => c.url === "/api/journal?profileIds=p2")).toBe(true));
    expect(screen.getByTestId("journal-scope-notice").textContent).toMatch(/Showing Bob only — other people's entries are hidden/);
    await waitFor(() => expect(screen.getByTestId("journal-timeline").textContent).toMatch(/No entries for Bob/));
    expect(screen.getByTestId("journal-timeline").textContent).not.toMatch(/line up here/);
    fireEvent.click(screen.getByText("Show everyone"));
    expect(showEveryone).toHaveBeenCalledTimes(1);
  });

  it("another person's entry is marked as theirs in the timeline", async () => {
    entries = [{ id: "j2", date: "2026-11-21", mood: "okay", title: "School", content: "Rough day.", tags: [], linkedProfiles: ["p2"], createdAt: "2026-11-21T10:00:00Z" }];
    mount();
    expect((await screen.findByTestId("journal-row-j2")).textContent).toContain("Bob's journal");
  });
});
