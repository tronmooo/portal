// @vitest-environment jsdom
//
// QA 2026-11-24 — the screen-level findings, each rendered for real.
//
//  · Document editor: a saved document, reopened, said "Unsaved". Loading a
//    document is not an edit: it must not mark the page dirty and must not
//    write (W3).
//  · Artifacts: "0 artifacts" showed while the lists were still loading, and a
//    failed list read "No artifacts yet" (Rule 7).
//  · Fill In: with a workspace open, the app behind it stayed reachable —
//    "Dashboard" / "Artifacts" were found and clicked, and nothing happened.
//    The covered shell is inert while a workspace is open.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let respond: (method: string, url: string) => Promise<any> | any = () => [];

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
      const data = await respond(method, url);
      return { ok: true, json: async () => data };
    }),
  };
});

const DOC = {
  id: "doc-1", type: "doc", title: "Tutorial Letter",
  content: "<p>Dear Sam,</p><p>The four approved values are attached.</p>",
  language: "", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z",
};

function mountAt(path: string, page: React.ReactElement) {
  window.location.hash = `#${path}`;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={() => [path, () => {}] as any}>{page}</Router>
    </QueryClientProvider>,
  );
}
const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  calls.length = 0;
  respond = () => [];
  // ProseMirror measures the caret; jsdom has no layout.
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  (Range.prototype as any).getBoundingClientRect = rect;
  (Range.prototype as any).getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  (Element.prototype as any).scrollIntoView = () => {};
  (document as any).elementFromPoint = () => null;
  if (!(window as any).matchMedia) (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.location.hash = ""; });

describe("Document editor — reopening a saved document", () => {
  it("shows it as saved and writes nothing: loading is not an edit", async () => {
    const { default: EditorPage } = await import("../client/src/pages/editor");
    respond = (method, url) => (url === "/api/artifacts/doc-1" ? DOC : []);
    mountAt("/editor/doc-1", <EditorPage />);
    await waitFor(() => expect(document.body.textContent).toContain("The four approved values are attached."), { timeout: 8000 });
    // Past the autosave delay for a saved document (5s): a document marked
    // dirty by its own load would PATCH itself here.
    await act(async () => { await new Promise((r) => setTimeout(r, 5600)); });
    expect(writes()).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Unsaved/);
    expect(document.body.textContent).not.toMatch(/Saving as you write/);
    expect(document.body.textContent).toMatch(/Saved/);
  }, 20000);

  it("a refetch of the saved copy does not put it back over the page", async () => {
    const src = (await import("node:fs")).readFileSync("client/src/pages/editor.tsx", "utf8");
    // Hydrate once per artifact, and load content without an update event.
    expect(src).toMatch(/hydratedFor\.current === existing\.id\) return;/);
    expect(src).toMatch(/setContent\(existing\.content \|\| "<p><\/p>", \{ emitUpdate: false \}\)/);
    expect(src).not.toMatch(/setContent\(existing\.content \|\| "<p><\/p>"\);/);
  });
});

describe("Artifacts — a count is shown only once there is one", () => {
  it("while the lists load there is no '0 artifacts' and no zero tiles", async () => {
    const { default: ArtifactsPage } = await import("../client/src/pages/artifacts");
    let release: (v: any) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    respond = async (_m, url) => {
      if (url === "/api/documents" || url === "/api/artifacts") await gate;
      if (url === "/api/artifacts") return [{ id: "a1", title: "Tutorial Letter", type: "doc", content: "x", createdAt: DOC.createdAt, linkedProfiles: [], tags: [], pinned: false, items: [] }];
      return [];
    };
    mountAt("/artifacts", <ArtifactsPage />);
    const header = await screen.findByTestId("artifacts-header-count");
    expect(header.textContent).toMatch(/Loading your artifacts/);
    expect(header.textContent).not.toMatch(/\b0 artifacts?\b/);
    expect(screen.getByTestId("artifacts-stat-showing").textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("artifacts-loading")).toBeTruthy();
    expect(screen.queryByTestId("artifacts-empty-none")).toBeNull();
    await act(async () => { release(null); });
    await waitFor(() => expect(screen.getByTestId("artifacts-header-count").textContent).toMatch(/\b1 artifact\b/));
    expect(screen.getByTestId("artifacts-stat-showing").textContent).toMatch(/1/);
  });

  it("a list that failed is an error with a retry, never 'No artifacts yet'", async () => {
    const { default: ArtifactsPage } = await import("../client/src/pages/artifacts");
    let fail = true;
    respond = async (_m, url) => {
      if (fail && url === "/api/artifacts") throw new Error("500: boom");
      if (url === "/api/artifacts") return [{ id: "a1", title: "Tutorial Letter", type: "doc", content: "x", createdAt: DOC.createdAt, linkedProfiles: [], tags: [], pinned: false, items: [] }];
      return [];
    };
    mountAt("/artifacts", <ArtifactsPage />);
    const error = await screen.findByTestId("artifacts-load-error");
    expect(error.textContent).toMatch(/Nothing was deleted/);
    expect(screen.queryByTestId("artifacts-empty-none")).toBeNull();
    expect(screen.getByTestId("artifacts-header-count").textContent).toMatch(/Couldn't load/);
    fail = false;
    await act(async () => { screen.getByTestId("artifacts-load-retry").click(); });
    await waitFor(() => expect(screen.getByTestId("artifacts-header-count").textContent).toMatch(/\b1 artifact\b/));
  });
});

describe("An open workspace covers the app — and the app behind it cannot be reached", () => {
  it("the shell is inert while the workspace is open, and is handed back when it closes", async () => {
    const { WorkspaceShell } = await import("../client/src/components/workspace/WorkspaceShell");
    const shell = document.createElement("div");
    shell.setAttribute("data-app-shell", "");
    shell.innerHTML = `<button>Dashboard</button><button>Artifacts</button>`;
    document.body.appendChild(shell);
    try {
      expect(shell.hasAttribute("inert")).toBe(false);
      const view = mountAt("/workspace/fill", <WorkspaceShell kind="fill" onClose={() => {}}><p>Drop a form here</p></WorkspaceShell>);
      expect(shell.hasAttribute("inert")).toBe(true);
      // The workspace itself is mounted on <body>, outside the inert shell.
      expect(screen.getByTestId("workspace-fill").closest("[inert]")).toBeNull();
      view.unmount();
      expect(shell.hasAttribute("inert")).toBe(false);
    } finally { shell.remove(); }
  });

  it("the app marks its shell, and Smart Fill's last step leads to the saved copy", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("client/src/App.tsx", "utf8")).toMatch(/data-app-shell/);
    const fill = fs.readFileSync("client/src/components/SmartFillDialog.tsx", "utf8");
    expect(fill).toMatch(/data-testid="button-smart-fill-view-artifacts"/);
    expect(fill).toMatch(/hashNavigate\("\/artifacts"\)/);
  });
});
