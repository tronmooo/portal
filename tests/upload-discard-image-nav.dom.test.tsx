// @vitest-environment jsdom
//
// Where an extract-only review LANDS when it finishes.
//
// Finishing a normal review opens the document, because there is a document to
// look at. An extract-only upload has none — the file was read and dropped — so
// that destination is a dead end: an empty viewer over a missing file, offering
// a download that cannot succeed. Reported from the app on 2026-09-02, after a
// receipt was extracted with "don't keep the photo" ticked.
//
// The fields are saved either way; only the destination differs.
import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigate = vi.fn();
vi.mock("wouter", () => ({
  useRoute: () => [true, { id: "doc-1" }],
  useLocation: () => ["/documents/doc-1/review", navigate],
  Link: ({ children }: any) => <>{children}</>,
}));

const loadPendingReview = vi.fn();
vi.mock("@/lib/pending-review", () => ({
  loadPendingReview: (...a: any[]) => loadPendingReview(...a),
  clearPendingReview: vi.fn(),
  stashPendingReview: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  // Reads answer with a list (the page's profile query), the confirm POST with
  // a success envelope. One shape for both would blow up whichever caller got
  // the wrong one.
  apiRequest: vi.fn(async (method: string) => ({
    json: async () => (method === "GET" ? [] : { success: true, saved: ["field"] }),
  })),
  BROWSER_TIMEZONE: "America/Los_Angeles",
}));

vi.mock("@/lib/document-preview", () => ({
  useDocumentBlobUrl: () => ({ url: null, blob: null, loading: false, error: null }),
  classifyDocument: () => "image",
  prefetchDocumentBlob: vi.fn(),
  wasFileDiscarded: () => false,
  DISCARDED_FILE_TAG: "image-discarded",
}));

vi.mock("@/lib/chat-sync", () => ({ applyChatMutations: vi.fn(async () => {}) }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import DocumentReviewPage from "../client/src/pages/document-review";
import { planExtractionActions } from "../shared/extraction-actions";
import { insuranceDeclarations } from "./document-fixtures";

function buildExtraction(imageDiscarded: boolean) {
  const plan = planExtractionActions({
    semantic: insuranceDeclarations.semantic,
    items: insuranceDeclarations.items,
    index: insuranceDeclarations.index,
    primaryProfileId: insuranceDeclarations.primaryProfileId,
    documentId: "doc-1",
    documentName: "Sunny Day Cafe — Dine-In Receipt",
    today: "2026-09-02",
  });
  return {
    extractionId: "doc-1",
    fileName: "receipt.jpg",
    documentType: "receipt",
    label: "Sunny Day Cafe — Dine-In Receipt",
    extractedFields: insuranceDeclarations.items.map((i: any) => ({
      key: i.key, label: i.label, value: i.value, selected: true, isDate: false,
    })),
    items: plan?.items ?? insuranceDeclarations.items,
    actionPlan: plan,
    trackerEntries: [],
    calendarDates: [],
    documentName: "Sunny Day Cafe — Dine-In Receipt",
    documentPreview: { id: "doc-1", name: "receipt.jpg", mimeType: "image/jpeg", data: "", imageDiscarded },
  } as any;
}

function renderPage(imageDiscarded: boolean) {
  loadPendingReview.mockReturnValue(buildExtraction(imageDiscarded));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DocumentReviewPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => navigate.mockClear());
afterEach(() => cleanup());

describe("finishing an extract-only review", () => {
  it("goes home instead of opening a document that has no file", async () => {
    renderPage(true);
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith("/dashboard");
    expect(navigate).not.toHaveBeenCalledWith("/documents/doc-1");
  });

  it("still opens the document when the file was kept", async () => {
    renderPage(false);
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith("/documents/doc-1");
  });

  it("offers no 'open full screen' shortcut for a file that was not kept", () => {
    renderPage(true);
    expect(screen.queryByTestId("btn-open-document")).toBeNull();
  });
});
