// @vitest-environment jsdom
//
// The editors' shared phone layout (owner request 2026-11-23: "compact,
// mobile-friendly, unlimited length, Save always reachable"). Renders the real
// shell and the real Journal / Notes workspaces.
//  - One header: X at the LEFT, the title, Save at the RIGHT. Save is never
//    hidden; it is disabled only while there is nothing to save.
//  - Save shows "Saved" once the save lands; tapping it straight after typing
//    does not make a second entry when the autosave fires (J1).
//  - The X saves, then leaves (W2). When that save FAILS the header warns and
//    offers Keep editing / Leave without saving — nothing is dropped silently.
//  - The writing area has no length limit: a long entry is saved whole.
//  - Attach offers the library, the camera and files; a non-photo file on a
//    journal entry is a `file:` pointer listed as a row; a note's attachment
//    can be removed (its link leaves the text; the file stays in Documents).
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { journalFileIds, journalLabels, journalPhotoIds, journalTagsFor } from "../shared/journal-photos";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let failWrites = false;

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
    if (failWrites && method !== "GET" && !url.includes("/upload/")) throw new Error("500: offline");
    let data: any = [];
    if (method === "POST" && url === "/api/journal") data = { id: "j-new", ...body };
    else if (method === "POST" && url === "/api/notes") data = { id: "n-new", ...body };
    else if (url === "/api/upload/save-only") data = { documentId: body.mimeType.startsWith("image/") ? "img-1" : "pdf-1" };
    else if (method !== "GET") data = { ok: true };
    return { ok: true, json: async () => data };
  }),
}));

import { WorkspaceShell } from "../client/src/components/workspace/WorkspaceShell";
import JournalWorkspacePage, { JOURNAL_AUTOSAVE_MS } from "../client/src/pages/workspace-journal";
import NotesWorkspacePage, { removeAttachmentLink } from "../client/src/pages/workspace-notes";

function mount(page: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => (String(queryKey[0]).startsWith("/api/documents/") ? { id: "pdf-1", name: "lease.pdf" } : []) } },
  });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.includes("/upload/"));
const settle = (ms = JOURNAL_AUTOSAVE_MS + 300) => new Promise((r) => setTimeout(r, ms));
const save = () => screen.getByTestId("button-workspace-save") as HTMLButtonElement;

beforeEach(() => { window.localStorage.clear(); calls.length = 0; navigated.length = 0; failWrites = false; });
afterEach(cleanup);

describe("the editors' header", () => {
  // The X was at the left until 2026-11-25, when the owner asked for it "in the upper-right corner".
  it("is the title, then Save and the X at the upper right", () => {
    mount(
      <WorkspaceShell kind="notes" title={<span>Groceries</span>} status="Saved" onClose={() => {}} save={{ state: "saved", onSave: () => true }}>
        <p>body</p>
      </WorkspaceShell>,
    );
    const header = screen.getByTestId("workspace-header");
    const buttons = Array.from(header.querySelectorAll("button"));
    expect(buttons[buttons.length - 1].getAttribute("data-testid")).toBe("button-workspace-close");
    expect(buttons[buttons.length - 2].getAttribute("data-testid")).toBe("button-workspace-save");
    expect(header.textContent).toContain("Groceries");
  });

  it("while open, the phone does not zoom into a small field; leaving puts the viewport back", () => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1.0, viewport-fit=cover";
    document.head.appendChild(meta);
    const { unmount } = mount(<WorkspaceShell kind="notes" onClose={() => {}}><p>body</p></WorkspaceShell>);
    expect(meta.content).toBe("width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1");
    unmount();
    expect(meta.content).toBe("width=device-width, initial-scale=1.0, viewport-fit=cover");
    meta.remove();
  });

  it("a failed save on the way out warns instead of leaving, and leaving is the user's choice", async () => {
    const left: string[] = [];
    mount(
      <WorkspaceShell kind="journal" onClose={async () => false} onLeave={() => left.push("left")} save={{ state: "error", onSave: () => false }}>
        <p>body</p>
      </WorkspaceShell>,
    );
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => screen.getByTestId("workspace-unsaved-warning"));
    expect(left).toEqual([]);
    fireEvent.click(screen.getByTestId("button-unsaved-stay"));
    expect(screen.queryByTestId("workspace-unsaved-warning")).toBeNull();
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => screen.getByTestId("workspace-unsaved-warning"));
    fireEvent.click(screen.getByTestId("button-unsaved-leave"));
    expect(left).toEqual(["left"]);
  });
});

describe("Journal: Save, length, attachments", () => {
  it("Save is shown but disabled on an empty page, then saves once and says Saved", async () => {
    mount(<JournalWorkspacePage />);
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: "Quiet morning." } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(save().getAttribute("data-state")).toBe("saved"));
    await settle();
    // The tap and the autosave are one entry, not two.
    expect(writes().filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a long entry is saved whole — no length limit", async () => {
    mount(<JournalWorkspacePage />);
    const long = Array.from({ length: 4000 }, (_, i) => `Word${i}`).join(" ") + "\n\nParagraph two.\n- a list line";
    fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: long } });
    fireEvent.click(save());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.content).toBe(long);
    expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).maxLength).toBe(-1);
  });

  it("the X with a failing save stays and warns; nothing is lost", async () => {
    failWrites = true;
    mount(<JournalWorkspacePage />);
    fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: "Do not lose me." } });
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    await waitFor(() => screen.getByTestId("workspace-unsaved-warning"));
    expect(navigated).toEqual([]);
    expect((screen.getByTestId("input-journal-free-text") as HTMLTextAreaElement).value).toBe("Do not lose me.");
  });

  it("attach offers the library, the camera and files; a PDF is a file row the entry points at", async () => {
    mount(<JournalWorkspacePage />);
    fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: "Signed the lease." } });
    expect(screen.getByTestId("input-journal-attach-camera").getAttribute("capture")).toBe("environment");
    expect(screen.getByTestId("input-journal-attach-library").hasAttribute("multiple")).toBe(true);
    const pdf = new File(["%PDF"], "lease.pdf", { type: "application/pdf" });
    const photo = new File(["jpg"], "keys.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("input-journal-attach-file"), { target: { files: [pdf, photo] } });
    await waitFor(() => screen.getByTestId("journal-file-pdf-1"));
    await waitFor(() => screen.getByTestId("journal-photo-img-1"));
    await waitFor(() => expect(writes().some((c) => Array.isArray(c.body?.tags) && c.body.tags.includes("file:pdf-1") && c.body.tags.includes("photo:img-1"))).toBe(true), { timeout: 4000 });
  });
});

describe("attachment pointers (pure)", () => {
  it("files ride beside photos and labels without mixing", () => {
    const tags = journalTagsFor(["work"], ["p1"], ["f1", "f1"]);
    expect(tags).toEqual(["work", "photo:p1", "file:f1"]);
    expect(journalFileIds(tags)).toEqual(["f1"]);
    expect(journalPhotoIds(tags)).toEqual(["p1"]);
    expect(journalLabels(tags)).toEqual(["work"]);
  });

  it("removing a note's attachment takes only its link out", () => {
    const md = "Lease notes\n\n[lease.pdf](#/documents/pdf-1)\n\n[keys.jpg](#/documents/img-1)";
    expect(removeAttachmentLink(md, "pdf-1")).toBe("Lease notes\n\n[keys.jpg](#/documents/img-1)");
    expect(removeAttachmentLink("See [a](#/documents/x1) here", "x1")).toBe("See  here");
  });
});

describe("Notes: Save and attachments", () => {
  it("Save is never hidden, and a removed attachment leaves the note's text (two taps)", async () => {
    mount(<NotesWorkspacePage />);
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("button-note-mode")); // plain markdown, to read the text back
    fireEvent.change(screen.getByTestId("input-note-content"), { target: { value: "Lease notes" } });
    const pdf = new File(["%PDF"], "lease.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("input-note-attach-file"), { target: { files: [pdf] } });
    await waitFor(() => screen.getByTestId("note-attachment-pdf-1"));
    const remove = screen.getByLabelText("Remove attachment");
    fireEvent.click(remove);
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toContain("#/documents/pdf-1");
    fireEvent.click(screen.getByLabelText("Tap again to remove this attachment"));
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("Lease notes");
    expect(screen.queryByTestId("note-attachment-pdf-1")).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(save().getAttribute("data-state")).toBe("saved"));
  });
});
