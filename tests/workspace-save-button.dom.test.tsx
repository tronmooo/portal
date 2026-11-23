// @vitest-environment jsdom
//
// Every writing workspace has a Save button in its header (owner, 2026-11-23:
// "I'm trying to make a note … there's no save button there needs to be a
// save button. I need to be able to see it"). Renders the real Notes page.
//  - The button is there the moment the workspace opens, and it is never
//    disabled for having nothing to do: a tap always answers.
//  - A tap saves NOW (it does not wait out the typing pause), once.
//  - It says where things stand: Save → Saved; a failure reads Retry save and
//    keeps the text; a duplicate says so and is never reported as saved.
//  - A title with no text yet is still a note when Save is tapped.
//  - Opening still writes nothing (Rule 3) and the workspace still saves
//    itself (W3): the button is the same save, on demand.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
const toasts: { title?: string; description?: string; variant?: string }[] = [];
let postAnswer: (body: any) => any = (body) => ({ id: "n-new", ...body });
let failWrites = false;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (t: any) => { toasts.push(t); } }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}) }));
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: () => undefined }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (failWrites && method !== "GET") throw new Error("500: boom");
    let data: any = {};
    if (method === "POST" && url === "/api/notes") data = postAnswer(body);
    else if (method === "PATCH") data = { id: url.split("/").pop(), ...body };
    return { ok: true, json: async () => data };
  }),
}));

import NotesWorkspacePage, { NOTE_AUTOSAVE_MS } from "../client/src/pages/workspace-notes";
import { WorkspaceSaveButton } from "../client/src/components/workspace/WorkspaceShell";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => [] } } });
  const view = render(<QueryClientProvider client={client}><NotesWorkspacePage /></QueryClientProvider>);
  fireEvent.click(screen.getByTestId("button-note-mode")); // plain editor: a textarea the test can type in
  return view;
}
const type = (text: string) => fireEvent.change(screen.getByTestId("input-note-content"), { target: { value: text } });
const saveButton = () => screen.getByTestId("button-workspace-save") as HTMLButtonElement;
const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => { calls.length = 0; toasts.length = 0; failWrites = false; postAnswer = (body) => ({ id: "n-new", ...body }); });
afterEach(cleanup);

describe("the Save button in a writing workspace", () => {
  it("is on the screen as soon as the workspace opens, named Save, and enabled", () => {
    mount();
    expect(saveButton().textContent).toBe("Save");
    expect(saveButton().disabled).toBe(false);
    expect(writes()).toEqual([]); // opening wrote nothing
  });

  it("a tap with nothing written writes nothing and says so", async () => {
    mount();
    fireEvent.click(saveButton());
    await waitFor(() => expect(toasts.map((t) => t.title)).toEqual(["Nothing to save yet"]));
    expect(writes()).toEqual([]);
  });

  it("a tap saves now, once, and the button reads Saved", async () => {
    mount();
    type("Groceries\nmilk");
    const typedAt = Date.now();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().textContent).toBe("Saved"));
    expect(Date.now() - typedAt).toBeLessThan(NOTE_AUTOSAVE_MS); // did not wait for the autosave
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notes", body: { title: "Groceries", content: "Groceries\nmilk" } });
    // The autosave that was pending does not write it a second time.
    await new Promise((r) => setTimeout(r, NOTE_AUTOSAVE_MS + 300));
    expect(writes()).toHaveLength(1);
    // A tap on "Saved" still answers.
    fireEvent.click(saveButton());
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain("Already saved"));
    expect(writes()).toHaveLength(1);
  });

  it("a title with no text yet is saved as a note when Save is tapped", async () => {
    mount();
    fireEvent.change(screen.getByTestId("input-note-title"), { target: { value: "Car maintenance ideas" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notes", body: { title: "Car maintenance ideas", content: "Car maintenance ideas" } });
    await waitFor(() => expect(saveButton().textContent).toBe("Saved"));
  });

  it("a failed save keeps the text, reads Retry save, and the next tap saves", async () => {
    failWrites = true;
    mount();
    type("Do not lose me");
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().textContent).toBe("Retry save"));
    expect(toasts.some((t) => t.title === "Couldn't save the note" && t.variant === "destructive")).toBe(true);
    expect((screen.getByTestId("input-note-content") as HTMLTextAreaElement).value).toBe("Do not lose me");
    failWrites = false;
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().textContent).toBe("Saved"));
  });

  it("text that already exists as another note is not reported as saved", async () => {
    postAnswer = (body) => ({ id: "n-other", title: "Shopping", ...body, deduped: true });
    mount();
    type("Buy");
    fireEvent.click(saveButton());
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain("You already have this note"));
    expect(saveButton().textContent).toBe("Save");
    expect(writes().some((c) => c.url.includes("n-other"))).toBe(false); // W4: never adopted
  });

  it("the button itself is never disabled for being empty or saved", () => {
    const { rerender } = render(<WorkspaceSaveButton state="empty" onSave={() => undefined} />);
    for (const state of ["empty", "dirty", "saved", "error"] as const) {
      rerender(<WorkspaceSaveButton state={state} onSave={() => undefined} />);
      expect(saveButton().disabled).toBe(false);
    }
    rerender(<WorkspaceSaveButton state="saving" onSave={() => undefined} />);
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe("Saving…");
  });
});
