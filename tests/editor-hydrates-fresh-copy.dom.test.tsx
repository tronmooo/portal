// @vitest-environment jsdom
//
// The document editor fills the page from the document ONCE (W3). It must be
// filled from the saved copy, not from a stale copy the query cache still
// holds while it reads the document again: a version restored in Word marks
// the cached copy stale, and the editor opened the text the restore had
// replaced — the next autosave would have written it back over the restore
// (integrity run ui-records.artifact, 2026-11-28).
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
afterEach(() => { cleanup(); window.location.hash = ""; });

const writes = () => calls.filter((c) => c.method !== "GET");
const DOC = (content: string) => ({ id: "doc-1", type: "doc", title: "Cover letter", content, tags: [], linkedProfiles: [], pinned: false, items: [], source: "manual", language: "", createdAt: "2026-11-27T10:00:00.000Z", updatedAt: "2026-11-27T10:05:00.000Z" });

describe("Document editor opened over a stale cached copy", () => {
  it("shows the saved (restored) text, never the replaced one, and writes nothing", async () => {
    const { default: EditorPage } = await import("../client/src/pages/editor");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    respond = async (method, url) => {
      if (method === "GET" && url === "/api/artifacts/doc-1") { await gate; return DOC("<p>Restored first draft.</p>"); }
      return [];
    };
    window.location.hash = "#/editor/doc-1?source=word";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => [] } } });
    // the copy from before the restore, now invalidated by the restore
    client.setQueryData(["/api/artifacts", "doc-1"], DOC("<p>Restored first draft. A sentence the restore removed.</p>"));
    void client.invalidateQueries({ queryKey: ["/api/artifacts"], refetchType: "none" });
    render(
      <QueryClientProvider client={client}>
        <Router hook={() => ["/editor/doc-1", () => {}] as any}><EditorPage /></Router>
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 300));
    // while the saved copy is being read the stale text is not on the page
    expect(document.body.textContent || "").not.toContain("A sentence the restore removed");
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId("doc-editor-canvas").textContent).toContain("Restored first draft."), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId("doc-editor-canvas").textContent).not.toContain("A sentence the restore removed");
    expect(writes()).toEqual([]);
  }, 20000);
});
