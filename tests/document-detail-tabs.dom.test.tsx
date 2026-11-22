// @vitest-environment jsdom
//
// The document view: Overview / Extracted Data / file tabs.
//
// There is ONE document view (DocumentWorkspace). The /documents/:id page, the
// dialog a profile's Documents tab opens and the copy inside a chat message
// all render it, and it opens on the FILE: "open my driver's license" shows
// the licence, with the summary one tap away. The Overview is derived from the
// document's own fields (no stored summary), so what it prints must be what
// the Extracted Data tab holds; the file tab hands the whole view to the file,
// and the zoom controls never appear over a file that was not kept.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const { apiRequest, blobState, hashNavigate } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  hashNavigate: vi.fn(),
  blobState: { url: "blob:doc" as string | null, blob: null as Blob | null, loading: false, error: false },
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/PdfCanvas", () => ({ default: () => <div data-testid="pdf-canvas" /> }));
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate }));
vi.mock("@/lib/document-preview", async () => {
  const actual = await vi.importActual<typeof import("../client/src/lib/document-preview")>("../client/src/lib/document-preview");
  return { ...actual, useDocumentBlobUrl: () => blobState, prefetchDocumentBlob: () => {}, prefetchDocument: () => {} };
});

import DocumentDetailPage, { DocumentWorkspace } from "../client/src/pages/document-detail";
import { DocumentViewerDialog } from "../client/src/components/DocumentViewer";
import { DISCARDED_FILE_TAG } from "@shared/document-file";

const DOC = {
  id: "d1",
  name: "Homeowners Insurance Policy Declarations",
  type: "home_insurance_declarations",
  mimeType: "application/pdf",
  linkedProfiles: [],
  tags: [] as string[],
  createdAt: "2026-08-25T12:00:00Z",
  extractedData: {
    dwelling_limit: "520000",
    effective_date: "2025-06-01",
    expiration_date: "2020-06-01",
    annual_premium: "1872",
    carrier: "Pine Ridge Insurance Company",
    policy_number: "PRP-2048573",
  },
};

let doc: typeof DOC & { hasFile?: boolean };

function wrap(ui: React.ReactElement) {
  const loc = memoryLocation({ path: "/documents/d1" });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Router hook={loc.hook}>{ui}</Router>
    </QueryClientProvider>,
  );
}
const mount = () => wrap(<DocumentDetailPage />);
const selected = (id: string) => screen.getByTestId(`tab-doc-${id}`).getAttribute("aria-selected");

beforeEach(() => {
  doc = { ...DOC };
  hashNavigate.mockClear();
  apiRequest.mockImplementation(async (_method: string, url: string) => ({
    json: async () => (url === "/api/documents/d1" ? doc : []),
  }));
});
afterEach(() => cleanup());

describe("the document view opens on the file", () => {
  it("lands on the PDF tab with the whole view given to the file", async () => {
    mount();
    await screen.findByTestId("doc-file-view");
    expect(screen.getByTestId("tab-doc-file").textContent).toBe("PDF");
    expect(selected("file")).toBe("true");
    expect(selected("overview")).toBe("false");

    // The title header is folded away; the name stays as one slim line, and
    // Back and Download are reachable from the tab row.
    const header = screen.getByTestId("doc-header");
    expect(header.className).toContain("hidden");
    expect(screen.getByTestId("text-doc-name").textContent).toBe(DOC.name);
    expect(screen.getByTestId("btn-back-from-file").getAttribute("aria-label")).toBe("Back");
    expect(screen.getByTestId("btn-download-from-file")).toBeTruthy();

    expect(screen.getByTestId("text-zoom-level").textContent).toBe("100%");
    fireEvent.click(screen.getByTestId("btn-doc-zoom-in"));
    expect(screen.getByTestId("text-zoom-level").textContent).toBe("125%");

    // Leaving the file tab brings the header back.
    fireEvent.click(screen.getByTestId("tab-doc-overview"));
    expect(header.className).not.toContain("hidden");
    expect(screen.queryByTestId("doc-file-view")).toBeNull();
  });

  it("Send hands the file itself to the phone's share sheet", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    Object.assign(navigator, { share, canShare: (d: ShareData) => !!d.files?.length });
    blobState.blob = new Blob(["%PDF"], { type: "application/pdf" });
    try {
      mount();
      fireEvent.click(await screen.findByTestId("btn-send-from-file"));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      const sent = share.mock.calls[0][0].files![0];
      expect(sent.name).toBe(`${DOC.name}.pdf`);
      expect(sent.type).toBe("application/pdf");
      // The same Send sits in the header on the other tabs.
      fireEvent.click(screen.getByTestId("tab-doc-overview"));
      expect(screen.getByTestId("btn-send-doc")).toBeTruthy();
    } finally {
      blobState.blob = null;
      delete (navigator as any).share;
      delete (navigator as any).canShare;
    }
  });

  it("the Overview is built from the document's own fields", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("tab-doc-overview"));
    const overview = screen.getByTestId("doc-overview");

    // Stored values are printed as a person reads them.
    expect(within(screen.getByTestId("tile-dwelling_limit")).getByText("$520,000")).toBeTruthy();
    expect(within(screen.getByTestId("tile-effective_date")).getByText("Jun 1, 2025")).toBeTruthy();
    expect(within(screen.getByTestId("tile-annual_premium")).getByText("$1,872.00")).toBeTruthy();

    // The alert is the date-rule engine's, about the stored expiration date.
    const insight = within(overview).getByTestId("insight-expiration_date");
    expect(insight.textContent).toMatch(/^Expired .* ago · Jun 1, 2020$/);
    // A plain effective date is not an alert.
    expect(within(overview).queryByTestId("insight-effective_date")).toBeNull();

    expect(screen.getByTestId("btn-view-all-fields").textContent).toContain("View All (6)");

    // The thumbnail goes back to the file.
    fireEvent.click(screen.getByTestId("doc-thumbnail"));
    expect(selected("file")).toBe("true");
  });

  it("View All opens the editable fields; a value shown formatted still edits the stored value", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("tab-doc-overview"));
    fireEvent.click(screen.getByTestId("btn-view-all-fields"));
    expect(selected("data")).toBe("true");
    const value = screen.getByTestId("value-field-dwelling_limit");
    expect(value.textContent).toBe("$520,000");
    fireEvent.click(value);
    expect((screen.getByTestId("input-field-dwelling_limit") as HTMLInputElement).value).toBe("520000");
  });

  it("a file that was not kept opens on the Overview, with no thumbnail, zoom or download", async () => {
    doc = { ...DOC, tags: [DISCARDED_FILE_TAG] };
    mount();
    await screen.findByTestId("doc-thumbnail-none");
    expect(selected("overview")).toBe("true");
    expect(screen.queryByTestId("doc-thumbnail")).toBeNull();
    expect(screen.queryByTestId("btn-download-doc")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-doc-file"));
    await waitFor(() => expect(screen.getByTestId("preview-discarded")).toBeTruthy());
    expect(screen.queryByTestId("doc-zoom-toolbar")).toBeNull();
    expect(screen.queryByTestId("btn-download-from-file")).toBeNull();
    expect(screen.queryByTestId("btn-send-from-file")).toBeNull();
  });

  it("a document added without a file opens on the Overview and offers to attach one", async () => {
    doc = { ...DOC, hasFile: false };
    mount();
    await screen.findByTestId("doc-thumbnail-none");
    expect(selected("overview")).toBe("true");
    expect(screen.queryByTestId("btn-download-doc")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-doc-file"));
    expect(within(screen.getByTestId("preview-no-file")).getByTestId("input-attach-file")).toBeTruthy();
    expect(screen.queryByTestId("btn-download-from-file")).toBeNull();
  });
});

describe("one document view, wherever it is opened", () => {
  it("the dialog a profile's Documents tab opens is the same view, on the file, and its way out closes it", async () => {
    const onOpenChange = vi.fn();
    wrap(<DocumentViewerDialog open onOpenChange={onOpenChange} id="d1" name={DOC.name} mimeType={DOC.mimeType} data="" />);
    const view = await screen.findByTestId("page-document-detail");
    expect(view.getAttribute("data-variant")).toBe("dialog");
    expect(screen.getByTestId("dialog-doc-viewer-d1").contains(view)).toBe(true);
    expect(selected("file")).toBe("true");
    for (const id of ["overview", "data", "file"]) expect(screen.getByTestId(`tab-doc-${id}`)).toBeTruthy();

    const close = screen.getByTestId("btn-back-from-file");
    expect(close.getAttribute("aria-label")).toBe("Close");
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the copy inside a chat message is the same view, on the file, and opens the full page", async () => {
    wrap(<DocumentWorkspace id="d1" variant="embedded" onBack={() => {}} />);
    const view = await screen.findByTestId("page-document-detail");
    expect(view.getAttribute("data-variant")).toBe("embedded");
    expect(selected("file")).toBe("true");
    const open = screen.getByTestId("btn-back-from-file");
    expect(open.getAttribute("aria-label")).toBe("Open full page");
    fireEvent.click(open);
    expect(hashNavigate).toHaveBeenCalledWith("/documents/d1");
  });

  it("every door opens that one view: chat, the profile dialogs and the liability documents list", () => {
    const fs = require("fs");
    const read = (f: string) => fs.readFileSync(f, "utf8") as string;
    const chat = read("client/src/pages/chat.tsx");
    expect(chat).toContain('<DocumentWorkspace id={id} variant="embedded"');
    expect(chat).not.toMatch(/<DocumentViewer\s/);
    const viewer = read("client/src/components/DocumentViewer.tsx");
    const dialog = viewer.slice(viewer.indexOf("export function DocumentViewerDialog"), viewer.indexOf("// ─── Editable Extracted Data Panel"));
    expect(dialog).toContain('variant="dialog"');
    const liability = read("client/src/pages/liability-detail.tsx");
    expect(liability).toContain("<DocumentViewerDialog");
    // A bare link to the file endpoint cannot load in a new tab (no sign-in).
    expect(liability).not.toContain("href={`/api/documents/${doc.id}/file`}");
  });
});
