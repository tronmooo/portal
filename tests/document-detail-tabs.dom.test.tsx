// @vitest-environment jsdom
//
// The document page: Overview / Extracted Data / file tabs.
//
// The Overview is derived from the document's own fields (no stored summary),
// so what it prints must be what the Extracted Data tab holds; and the file
// tab hands the whole page to the file — the title header folds away and the
// zoom controls never appear over a file that was not kept.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const { apiRequest, blobState } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  blobState: { url: "blob:doc" as string | null, blob: null as Blob | null, loading: false, error: false },
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/PdfCanvas", () => ({ default: () => <div data-testid="pdf-canvas" /> }));
vi.mock("@/lib/document-preview", async () => {
  const file = await vi.importActual<typeof import("@shared/document-file")>("@shared/document-file");
  return {
    useDocumentBlobUrl: () => blobState,
    prefetchDocumentBlob: () => {},
    classifyDocument: (mime: string) => (mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : "other"),
    wasFileDiscarded: file.wasFileDiscarded,
  };
});

import DocumentDetailPage from "../client/src/pages/document-detail";
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

let doc: typeof DOC;

function mount() {
  const loc = memoryLocation({ path: "/documents/d1" });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Router hook={loc.hook}>
        <DocumentDetailPage />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  doc = { ...DOC };
  apiRequest.mockImplementation(async (_method: string, url: string) => ({
    json: async () => (url === "/api/documents/d1" ? doc : []),
  }));
});
afterEach(() => cleanup());

describe("document page tabs", () => {
  it("opens on the Overview, built from the document's own fields", async () => {
    mount();
    const overview = await screen.findByTestId("doc-overview");
    expect(screen.getByTestId("tab-doc-overview").getAttribute("aria-selected")).toBe("true");

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
  });

  it("View All opens the editable fields; a value shown formatted still edits the stored value", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("btn-view-all-fields"));
    expect(screen.getByTestId("tab-doc-data").getAttribute("aria-selected")).toBe("true");
    const value = screen.getByTestId("value-field-dwelling_limit");
    expect(value.textContent).toBe("$520,000");
    fireEvent.click(value);
    expect((screen.getByTestId("input-field-dwelling_limit") as HTMLInputElement).value).toBe("520000");
  });

  it("the PDF tab takes the whole page: the title header folds away and the controls float over the file", async () => {
    mount();
    const heading = await screen.findByTestId("heading-doc-name");
    const header = heading.closest("div.flex.items-start") as HTMLElement;
    expect(header.className).not.toContain("hidden");

    const tab = screen.getByTestId("tab-doc-file");
    expect(tab.textContent).toBe("PDF");
    fireEvent.click(tab);

    expect(header.className).toContain("hidden");
    expect(screen.getByTestId("doc-file-view")).toBeTruthy();
    expect(screen.queryByTestId("doc-overview")).toBeNull();
    // Back and Download stay reachable from the tab row.
    expect(screen.getByTestId("btn-back-from-file")).toBeTruthy();
    expect(screen.getByTestId("btn-download-from-file")).toBeTruthy();

    expect(screen.getByTestId("text-zoom-level").textContent).toBe("100%");
    fireEvent.click(screen.getByTestId("btn-doc-zoom-in"));
    expect(screen.getByTestId("text-zoom-level").textContent).toBe("125%");
  });

  it("the thumbnail opens the file tab", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("doc-thumbnail"));
    expect(screen.getByTestId("tab-doc-file").getAttribute("aria-selected")).toBe("true");
  });

  it("a file that was not kept offers no thumbnail, zoom or download", async () => {
    doc = { ...DOC, tags: [DISCARDED_FILE_TAG] };
    mount();
    await screen.findByTestId("doc-thumbnail-none");
    expect(screen.queryByTestId("doc-thumbnail")).toBeNull();
    expect(screen.queryByTestId("btn-download-doc")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-doc-file"));
    await waitFor(() => expect(screen.getByTestId("preview-discarded")).toBeTruthy());
    expect(screen.queryByTestId("doc-zoom-toolbar")).toBeNull();
    expect(screen.queryByTestId("btn-download-from-file")).toBeNull();
  });
});
