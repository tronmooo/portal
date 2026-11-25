// @vitest-environment jsdom
//
// Word (owner request 2026-11-25): the document app behind the chat box's
// small Word button — My Documents, Editor, Templates, AI Writer, AI Review,
// Version History. This renders the real workspace page.
//
// What is pinned:
//  - Opening, browsing and "Use template" write nothing: a template or an AI
//    draft is HANDED to the editor, which saves it like anything typed.
//  - The AI Writer shows a proposal with its sources and its blanks (counted
//    from the text); nothing is saved until the user opens it.
//  - The review reports and changes nothing. Delete and restore take two taps.
//  - A failed list is an error with a retry on every tab that reads it.
//  - The document last open in the Editor comes back.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WORKSPACE_AI_ACCESS_PREF } from "../shared/workspace-access";
import { WORD_TEMPLATES, wordTemplate } from "../shared/doc-templates";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let artifacts: any[] = [];
let listFails = false;
let versions: any[] = [];
let answers: Record<string, any> = {};

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    let data: any = {};
    if (url in answers) data = answers[url];
    else if (url.endsWith("/restore")) data = { record: { id: "d1", content: "<p>older</p>" }, restoredFrom: "2026-11-20T10:00:00.000Z" };
    return { ok: true, json: async () => data };
  }),
}));

import WordWorkspacePage from "../client/src/pages/workspace-word";
import { WORD_TABS, clearWordSeed, setWordSeed, takeWordSeed, wordTabRoute } from "../client/src/components/workspace/WordTabs";
import { WORKSPACES } from "../client/src/components/workspace/WorkspaceShell";

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: {
      retry: false,
      queryFn: async ({ queryKey }) => {
        const key = String(queryKey[0]);
        if (key === "/api/artifacts") { if (listFails) throw new Error("500: boom"); return artifacts; }
        if (key === `/api/preferences/${WORKSPACE_AI_ACCESS_PREF}`) return { value: null };
        if (/^\/api\/workspace\/versions\/\w+\/[^/]+$/.test(key)) return { versions: versions.map(({ content: _c, ...v }) => v) };
        if (key.startsWith("/api/workspace/versions/")) return versions.find((v) => key.endsWith(`/${v.id}`));
        return [];
      },
    } },
  });
  return render(<QueryClientProvider client={client}><WordWorkspacePage /></QueryClientProvider>);
}
const tab = (id: string) => fireEvent.click(screen.getByTestId(`workspace-tab-${id}`));
const writes = () => calls.filter((c) => c.method !== "GET" && !/\/(assist|review)$/.test(c.url));

const DOCS = () => [
  { id: "d1", type: "doc", title: "Cover letter", content: "<p>Dear Sam, I am writting to apply. Call [Missing: phone number].</p>", updatedAt: "2026-11-24T10:00:00Z" },
  { id: "d2", type: "doc", title: "Lease notes", content: "<p>The lease ends in June.</p>", updatedAt: "2026-11-20T10:00:00Z" },
  { id: "n1", type: "note", title: "A note", content: "not a document", updatedAt: "2026-11-25T10:00:00Z" },
  { id: "s1", type: "sheet", title: "A sheet", content: "", updatedAt: "2026-11-25T10:00:00Z" },
];

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "#/workspace/word";
  calls.length = 0; navigated.length = 0; artifacts = []; listFails = false; versions = []; answers = {};
  clearWordSeed();
});
afterEach(cleanup);

describe("Word behind the small button", () => {
  it("the chat box's Word button opens the Word workspace; the Editor tab is the document editor", () => {
    expect(WORKSPACES.document).toMatchObject({ label: "Word", route: "/workspace/word" });
    expect(WORD_TABS.map((t) => t.label)).toEqual(["My Documents", "Editor", "Templates", "AI Writer", "AI Review", "Version History"]);
    expect(wordTabRoute("editor")).toBe("/editor/new/doc?source=word");
    expect(wordTabRoute("editor", "d1")).toBe("/editor/d1?source=word");
    expect(wordTabRoute("review", "d1")).toBe("/workspace/word?tab=review&doc=d1");
  });

  it("opens on My Documents with the X at the upper right, and walking the tabs writes nothing", async () => {
    artifacts = DOCS();
    mount();
    expect(within(screen.getByTestId("workspace-tabs")).getAllByRole("tab")).toHaveLength(6);
    const buttons = Array.from(screen.getByTestId("workspace-header").querySelectorAll("button"));
    expect(buttons[buttons.length - 1].getAttribute("data-testid")).toBe("button-workspace-close");
    await waitFor(() => expect(screen.getByTestId("word-count").textContent).toBe("2 documents"));
    for (const id of ["templates", "writer", "review", "history", "documents"]) tab(id);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(navigated).toEqual([]);
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => expect(navigated).toEqual(["/chat"]));
  });
});

describe("My Documents", () => {
  it("lists documents only (not notes or sheets), newest first, with what is left to fill", async () => {
    artifacts = DOCS();
    mount();
    await waitFor(() => screen.getByTestId("word-doc-d1"));
    expect(screen.queryByTestId("word-doc-n1")).toBeNull();
    expect(screen.queryByTestId("word-doc-s1")).toBeNull();
    expect(screen.getByTestId("word-doc-d1").textContent).toMatch(/Cover letter.*1 blank to fill/);
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("2 documents");
  });

  it("search is a view that says how many of how many, and offers the way back", async () => {
    artifacts = DOCS();
    mount();
    await waitFor(() => screen.getByTestId("word-doc-d1"));
    fireEvent.change(screen.getByTestId("input-word-search"), { target: { value: "lease" } });
    expect(screen.getByTestId("word-count").textContent).toBe("1 document of 2");
    fireEvent.change(screen.getByTestId("input-word-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("word-search-empty").textContent).toMatch(/No document matches “zzz”\. Show all 2/);
    expect(screen.queryByTestId("word-no-documents")).toBeNull(); // hidden by the search, not missing
  });

  it("a failed list is an error with a retry on every tab; never 'No documents yet'", async () => {
    listFails = true;
    mount();
    await waitFor(() => expect(screen.getByTestId("word-list-error").textContent).toMatch(/Couldn't load your documents/));
    expect(screen.queryByTestId("word-no-documents")).toBeNull();
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Couldn't load your documents");
    for (const id of ["review", "history"]) { tab(id); expect(screen.getByTestId("word-list-error")).toBeTruthy(); }
  });

  it("opening a document goes to the editor as Word's Editor tab; New opens a blank page", async () => {
    artifacts = DOCS();
    mount();
    await waitFor(() => screen.getByTestId("word-doc-d2"));
    fireEvent.click(within(screen.getByTestId("word-doc-d2")).getByTitle("Open in the editor"));
    fireEvent.click(screen.getByTestId("button-word-new"));
    expect(navigated).toEqual(["/editor/d2?source=word", "/editor/new/doc?source=word"]);
    expect(writes()).toEqual([]);
  });

  it("delete takes two taps", async () => {
    artifacts = DOCS();
    mount();
    await waitFor(() => screen.getByTestId("button-word-delete-d2"));
    fireEvent.click(screen.getByTestId("button-word-delete-d2"));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-word-delete-d2"));
    await waitFor(() => expect(writes()).toEqual([{ method: "DELETE", url: "/api/artifacts/d2", body: undefined }]));
  });

  it("the document last open in the Editor comes back when Word is opened again", async () => {
    artifacts = DOCS();
    window.localStorage.setItem("portol_ws_last:word", JSON.stringify({ tab: "editor", id: "d2" }));
    mount();
    await waitFor(() => expect(navigated).toEqual(["/editor/d2?source=word"]));
    cleanup(); navigated.length = 0;
    // A document that is gone is not chased; Word opens on the list.
    window.localStorage.setItem("portol_ws_last:word", JSON.stringify({ tab: "editor", id: "deleted" }));
    mount();
    await waitFor(() => screen.getByTestId("word-doc-d1"));
    expect(navigated).toEqual([]);
  });
});

describe("Templates", () => {
  it("every group is offered, each template says how many blanks it has, and a contract carries its caution", () => {
    mount();
    tab("templates");
    for (const g of ["resume", "letter", "report", "business", "contract", "personal"]) expect(screen.getByTestId(`template-group-${g}`)).toBeTruthy();
    expect(screen.getAllByText("Use template")).toHaveLength(WORD_TEMPLATES.length);
    expect(screen.getByTestId("template-resume-chronological").textContent).toMatch(/\d+ blanks to fill/);
    expect(screen.getByTestId("template-contract-services").textContent).toMatch(/not legal advice/);
  });

  it("Use template hands it to the editor and writes nothing itself", () => {
    mount();
    tab("templates");
    fireEvent.click(screen.getByTestId("button-template-use-letter-cover"));
    expect(navigated).toEqual(["/editor/new/doc?source=word"]);
    expect(calls).toEqual([]);
    // The editor takes it once, for a new document only.
    expect(takeWordSeed((s) => !!s.forId)).toBeNull();
    const seed = takeWordSeed((s) => !s.forId);
    expect(seed).toEqual({ title: "Cover Letter", html: wordTemplate("letter-cover")!.html, forId: undefined });
    expect(takeWordSeed(() => true)).toBeNull();
  });

  it("Fill in with AI sends the template and shows a proposal; nothing is saved until it is opened", async () => {
    answers["/api/workspace/document/assist"] = { title: "Cover Letter", html: "<p>Tron Moore · [Missing: phone number]</p><p>Dear [Missing: hiring manager],</p>", blanks: ["ignored: the page counts its own"], sources: ["your profile"], revised: true };
    mount();
    tab("templates");
    fireEvent.click(screen.getByTestId("button-template-fill-letter-cover"));
    await waitFor(() => screen.getByTestId("word-proposal"));
    const sent = calls.find((c) => c.url === "/api/workspace/document/assist")!;
    expect(sent.body.html).toBe(wordTemplate("letter-cover")!.html);
    expect(sent.body.instruction).toMatch(/Leave a \[Missing: …\] blank wherever the facts on file do not say/);
    expect(screen.getByTestId("word-proposal-sources").textContent).toBe("Drew on your profile. 2 blanks to fill in: phone number; hiring manager.");
    expect(screen.getByTestId("word-proposal").textContent).toMatch(/nothing is saved until you open it in the editor/);
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-word-proposal-discard"));
    expect(screen.queryByTestId("word-proposal")).toBeNull();
    expect(takeWordSeed(() => true)).toBeNull();
    expect(navigated).toEqual([]);
  });
});

describe("AI Writer", () => {
  it("writes from a description, shows the draft safely, and opens it in the editor on request", async () => {
    answers["/api/workspace/document/assist"] = { title: "Dispute Letter", html: '<h1>Dispute</h1><p onclick="x()">I dispute the charge.</p><script>steal()</script>', sources: [], revised: false };
    mount();
    tab("writer");
    expect((screen.getByTestId("button-word-write") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-word-instruction"), { target: { value: "A letter disputing a charge" } });
    fireEvent.click(screen.getByTestId("button-word-write"));
    await waitFor(() => screen.getByTestId("word-proposal"));
    expect(calls.find((c) => c.url.endsWith("/assist"))!.body).toEqual({ instruction: "A letter disputing a charge" });
    expect(screen.getByTestId("word-proposal-sources").textContent).toBe("Drew on nothing from your records. No blanks left to fill.");
    const preview = screen.getByTestId("word-proposal-preview");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("[onclick]")).toBeNull();
    expect(screen.getByTestId("word-writer").textContent).toMatch(/never invented: it is left as a marked blank/);
    fireEvent.click(screen.getByTestId("button-word-proposal-open"));
    expect(navigated).toEqual(["/editor/new/doc?source=word"]);
    expect(takeWordSeed((s) => !s.forId)?.title).toBe("Dispute Letter");
    expect(writes()).toEqual([]);
  });

  it("improving a saved document sends that document and opens the change IN that document", async () => {
    artifacts = DOCS();
    answers["/api/workspace/document/assist"] = { title: "Cover letter", html: "<p>Dear Sam, I am writing to apply.</p>", sources: [], revised: true };
    mount();
    tab("writer");
    await waitFor(() => screen.getByTestId("select-word-document"));
    expect((screen.getByTestId("button-word-revise-improve") as HTMLButtonElement).disabled).toBe(true); // no document chosen yet
    fireEvent.change(screen.getByTestId("select-word-document"), { target: { value: "d1" } });
    fireEvent.click(screen.getByTestId("button-word-revise-improve"));
    await waitFor(() => screen.getByTestId("word-proposal"));
    const sent = calls.find((c) => c.url.endsWith("/assist"))!;
    expect(sent.body).toMatchObject({ html: DOCS()[0].content, title: "Cover letter" });
    expect(sent.body.instruction).toMatch(/Keep every fact/);
    fireEvent.click(screen.getByTestId("button-word-proposal-open"));
    expect(navigated).toEqual(["/editor/d1?source=word"]);
    // It waits for THAT document: a new page does not take it.
    expect(takeWordSeed((s) => !s.forId)).toBeNull();
    expect(takeWordSeed((s) => s.forId === "d1")?.html).toBe("<p>Dear Sam, I am writing to apply.</p>");
    expect(writes()).toEqual([]); // the editor saves it; the workspace wrote nothing
  });

  it("the Word AI's access switches are shown, with the journal off", async () => {
    mount();
    tab("writer");
    await waitFor(() => expect(screen.getByTestId("ai-access-line-word").textContent).toMatch(/Reads: My profile · My uploaded files\./));
    fireEvent.click(screen.getByTestId("button-ai-access-word"));
    expect((await screen.findByTestId("ai-access-word-journal")).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("ai-access-word").textContent).toMatch(/Private by default/);
  });
});

describe("AI Review and Version History", () => {
  it("the review reads the saved copy, groups what it found, and changes nothing", async () => {
    artifacts = DOCS();
    answers["/api/workspace/document/review"] = { words: 11, findings: [
      { category: "missing", quote: "[Missing: phone number]", issue: "This blank is still to be filled in: phone number.", suggestion: "Type it in." },
      { category: "grammar", quote: "I am writting to apply", issue: "Spelling.", suggestion: "writing" },
    ] };
    mount();
    await waitFor(() => screen.getByTestId("button-word-review-d1"));
    fireEvent.click(screen.getByTestId("button-word-review-d1"));
    expect(screen.getByTestId("workspace-tab-review").getAttribute("aria-selected")).toBe("true");
    expect(calls.filter((c) => c.url.endsWith("/review"))).toEqual([]); // choosing is not reviewing
    fireEvent.click(screen.getByTestId("button-word-run-review"));
    await waitFor(() => expect(screen.getByTestId("word-review-summary").textContent).toBe("2 things to look at · 11 words read"));
    expect(calls.find((c) => c.url.endsWith("/review"))!.body).toEqual({ html: DOCS()[0].content, title: "Cover letter" });
    expect(screen.getByTestId("review-grammar").textContent).toMatch(/Grammar and spelling · 1.*“I am writting to apply”.*Suggestion: writing/);
    expect(screen.getByTestId("review-missing").textContent).toMatch(/Missing information · 1/);
    expect(screen.queryByTestId("review-clarity")).toBeNull();
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-review-open-editor"));
    expect(navigated).toEqual(["/editor/d1?source=word"]);
  });

  it("a clean review says so", async () => {
    artifacts = DOCS();
    answers["/api/workspace/document/review"] = { words: 6, findings: [] };
    window.location.hash = "#/workspace/word?tab=review&doc=d2";
    mount();
    await waitFor(() => expect((screen.getByTestId("select-word-document") as HTMLSelectElement).value).toBe("d2"));
    fireEvent.click(screen.getByTestId("button-word-run-review"));
    await waitFor(() => expect(screen.getByTestId("word-review-summary").textContent).toBe("Nothing to fix was found. · 6 words read"));
  });

  it("a document's versions are listed, previewed safely, and restored with two taps", async () => {
    artifacts = DOCS();
    versions = [{ id: "v1", savedAt: "2026-11-20T10:00:00.000Z", title: "Cover letter", reason: "edit", preview: "older", words: 1, content: '<p>older</p><img src=x onerror="steal()">' }];
    window.location.hash = "#/workspace/word?tab=history&doc=d1";
    mount();
    const row = await screen.findByTestId("version-v1");
    fireEvent.click(within(row).getAllByRole("button")[0]);
    await waitFor(() => expect(screen.getByTestId("version-preview").textContent).toBe("older"));
    expect(screen.getByTestId("version-preview").querySelector("[onerror]")).toBeNull();
    fireEvent.click(screen.getByTestId("button-version-restore-v1"));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-version-restore-v1"));
    await waitFor(() => expect(writes()).toEqual([{ method: "POST", url: "/api/workspace/versions/document/d1/restore", body: { versionId: "v1" } }]));
  });

  it("with no document chosen, History asks for one instead of showing an empty history", async () => {
    artifacts = DOCS();
    mount();
    tab("history");
    await waitFor(() => expect(screen.getByTestId("word-history").textContent).toMatch(/Choose a document to see its earlier versions/));
    expect(screen.queryByTestId("versions-empty")).toBeNull();
  });
});

describe("the hand-off to the editor", () => {
  it("is taken once, by the screen it was meant for", () => {
    setWordSeed({ title: "T", html: "<p>x</p>" });
    expect(takeWordSeed(() => false)).toBeNull();
    expect(takeWordSeed(() => true)).toEqual({ title: "T", html: "<p>x</p>" });
    expect(takeWordSeed(() => true)).toBeNull();
  });
});
