// @vitest-environment jsdom
//
// QA 2026-11-24 (second pass) — the screen-level findings, rendered for real.
//
//  · Document editor: Save pressed on a new document, then Calendar before
//    the save came back — the answer moved the URL to /editor/<id> and the
//    document opened again over the Calendar. A save that outlives the
//    editor never navigates.
//  · Artifacts → a saved note opened read-only with only a Close button; the
//    road to its editor was Chat → Notes. The viewer has Edit, which opens
//    THAT note in the Notes workspace.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let respond: (method: string, url: string, body?: any) => Promise<any> | any = () => [];

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedMode: "light" }) }));
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    BROWSER_TIMEZONE: "America/Los_Angeles",
    queryClient: new QueryClient(),
    apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
      calls.push({ method, url, body });
      const data = await respond(method, url, body);
      return { ok: true, json: async () => data };
    }),
  };
});

const NOTE = {
  id: "note-1", type: "note", title: "Tripod checklist", content: "- [ ] Check tripod screws\n- [ ] Pack the plate",
  tags: [], linkedProfiles: [], pinned: false, items: [], source: "manual",
  createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z",
};

function mountAt(path: string, page: React.ReactElement, navigate: (to: string) => void = () => {}) {
  window.location.hash = `#${path}`;
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const r = await (await import("@/lib/queryClient")).apiRequest("GET", String(queryKey[0]));
          return (r as any).json();
        },
      },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={() => [path.split("?")[0], navigate] as any}>{page}</Router>
    </QueryClientProvider>,
  );
}
const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  calls.length = 0;
  respond = () => [];
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  (Range.prototype as any).getBoundingClientRect = rect;
  (Range.prototype as any).getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  (Element.prototype as any).scrollIntoView = () => {};
  (document as any).elementFromPoint = () => null;
  if (!(window as any).matchMedia) (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.location.hash = ""; });

describe("Document editor — a save that outlives the editor", () => {
  it("does not reopen the document after the user went to the Calendar", async () => {
    const { default: EditorPage } = await import("../client/src/pages/editor");
    let release: (v: any) => void = () => {};
    respond = (method, url) => (method === "POST" && url === "/api/artifacts"
      ? new Promise((r) => { release = r; })
      : []);
    const navigate = vi.fn();
    const view = mountAt("/editor/new/doc", <EditorPage />, navigate);
    const title = await screen.findAllByTestId("input-editor-title");
    fireEvent.change(title[0], { target: { value: "Packing list" } });
    const save = (await screen.findAllByTestId("button-workspace-save")).find((b) => !(b as HTMLButtonElement).disabled)!;
    expect(save).toBeTruthy();
    await act(async () => { fireEvent.click(save); });
    await waitFor(() => expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/artifacts"]));
    // The user goes to the Calendar while the save is on its way.
    window.location.hash = "#/calendar";
    view.unmount();
    await act(async () => { release({ id: "art-9", type: "doc", title: "Packing list", content: "" }); await new Promise((r) => setTimeout(r, 20)); });
    expect(navigate.mock.calls.map((c) => c[0])).not.toContain("/editor/art-9");
  }, 20000);

  it("still follows its first save to the document's address while it is open", async () => {
    const { default: EditorPage } = await import("../client/src/pages/editor");
    respond = (method, url) => (method === "POST" && url === "/api/artifacts" ? { id: "art-10", type: "doc", title: "Packing list", content: "" } : []);
    const navigate = vi.fn();
    mountAt("/editor/new/doc", <EditorPage />, navigate);
    const title = await screen.findAllByTestId("input-editor-title");
    fireEvent.change(title[0], { target: { value: "Packing list" } });
    const save = (await screen.findAllByTestId("button-workspace-save")).find((b) => !(b as HTMLButtonElement).disabled)!;
    await act(async () => { fireEvent.click(save); });
    await waitFor(() => expect(navigate.mock.calls.map((c) => c[0])).toContain("/editor/art-10"));
  }, 20000);
});

describe("Artifacts — a saved note can be edited", () => {
  it("the note viewer has Edit, which opens that note in the Notes workspace", async () => {
    const { default: ArtifactsPage } = await import("../client/src/pages/artifacts");
    respond = (_m, url) => (url === "/api/artifacts" ? [NOTE] : []);
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, href: original.href, hash: "#/artifacts", assign } });
    try {
      mountAt("/artifacts", <ArtifactsPage />);
      fireEvent.click(await screen.findByTestId(`artifact-card-${NOTE.id}`));
      const edit = await screen.findByTestId("button-edit-note");
      fireEvent.click(edit);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(String(assign.mock.calls[0][0])).toContain("#/workspace/notes?note=note-1&from=artifacts");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
    expect(writes()).toEqual([]);
  });

  it("the Notes workspace opens the note it was asked for, and writes nothing on open", async () => {
    const { default: NotesWorkspacePage } = await import("../client/src/pages/workspace-notes");
    respond = (_m, url) => (url === "/api/notes" ? [NOTE] : []);
    mountAt("/workspace/notes?note=note-1&from=artifacts", <NotesWorkspacePage />);
    await waitFor(() => expect((screen.getByTestId("input-note-title") as HTMLInputElement).value).toBe("Tripod checklist"), { timeout: 8000 });
    await waitFor(() => expect(document.body.textContent).toContain("Check tripod screws"));
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(writes()).toEqual([]);
  }, 20000);
});
