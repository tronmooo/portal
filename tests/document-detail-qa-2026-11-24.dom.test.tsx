// @vitest-environment jsdom
//
// QA 2026-11-24, document detail:
//
// #16 A driver's licence showed its extracted expiration, but nothing said
//     whether it was on the calendar or offered to put it there. The Date Rule
//     engine already draws a document's expiration on the calendar (Rule 5),
//     so the honest answer is "On your calendar" with a link to that day —
//     never an "Add" that files a duplicate event. Only a date the user kept
//     OFF the calendar (`_calendarOptOut`) offers "Add to calendar", and only
//     the tap writes (Rule 3).
//
// #17 A Smart Fill copy's Overview said "Nothing has been extracted from this
//     document" while Extracted Data held one row summarising "4 filled
//     fields" — with none of the fields. The filled values are listed as
//     label → value, and the Overview no longer denies them.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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

import DocumentDetailPage from "../client/src/pages/document-detail";

const LICENSE = {
  id: "d1",
  name: "Driver's License",
  type: "drivers_license",
  mimeType: "image/jpeg",
  linkedProfiles: [] as string[],
  tags: [] as string[],
  createdAt: "2026-11-20T12:00:00Z",
  extractedData: {
    full_name: "Sample Person",
    license_number: "D1234567",
    expiration_date: "2031-03-14",
  } as Record<string, any>,
};

let doc: any;
const writes = () => apiRequest.mock.calls.filter(([m]) => m !== "GET");

function mount() {
  const loc = memoryLocation({ path: `/documents/${doc.id}` });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Router hook={loc.hook}><DocumentDetailPage /></Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hashNavigate.mockClear();
  apiRequest.mockReset();
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => ({
    json: async () => {
      if (url === `/api/documents/${doc.id}` && method === "PATCH") { doc = { ...doc, ...body }; return doc; }
      return url === `/api/documents/${doc.id}` ? doc : [];
    },
  }));
});
afterEach(() => cleanup());

async function openTab(id: "overview" | "data") {
  fireEvent.click(await screen.findByTestId(`tab-doc-${id}`));
}

describe("#16 a document's expiration and the calendar", () => {
  it("says the expiration is on the calendar and links to that day; nothing is written", async () => {
    doc = { ...LICENSE, extractedData: { ...LICENSE.extractedData } };
    mount();
    await openTab("overview");
    const on = await screen.findByTestId("calendar-on-expiration_date");
    expect(on.textContent).toMatch(/On your calendar/);
    expect(on.textContent).toMatch(/2031/);
    // No "Add" beside a date the calendar already draws: that would be a duplicate.
    expect(screen.queryByTestId("calendar-add-expiration_date")).toBeNull();
    fireEvent.click(on);
    expect(hashNavigate).toHaveBeenCalledWith("/calendar?date=2031-03-14");

    await openTab("data");
    expect(await screen.findByTestId("calendar-on-expiration_date")).toBeTruthy();
    // A field that is not a calendar date offers nothing.
    expect(screen.queryByTestId("calendar-on-license_number")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("a date kept off the calendar offers Add to calendar, and only the tap writes", async () => {
    doc = { ...LICENSE, extractedData: { ...LICENSE.extractedData, _calendarOptOut: ["expiration_date"] } };
    mount();
    await openTab("data");
    const add = await screen.findByTestId("calendar-add-expiration_date");
    expect(add.textContent).toMatch(/Add to calendar/);
    expect(screen.queryByTestId("calendar-on-expiration_date")).toBeNull();
    // The bookkeeping list is not shown as a field of the document.
    expect(screen.queryByTestId("field-row-_calendarOptOut")).toBeNull();
    expect(writes()).toEqual([]);

    fireEvent.click(add);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [method, url, body] = writes()[0];
    expect(method).toBe("PATCH");
    expect(url).toBe("/api/documents/d1");
    // It puts back the derived date (no new event): the opt-out loses the
    // field and every other field is kept.
    expect(body.extractedData._calendarOptOut).toEqual([]);
    expect(body.extractedData.expiration_date).toBe("2031-03-14");
    expect(body.extractedData.license_number).toBe("D1234567");
    expect(writes().some(([, u]) => String(u).startsWith("/api/events"))).toBe(false);
  });
});

describe("#17 a Smart Fill copy shows what was filled", () => {
  const smartFillDoc = (fields: any[] | undefined) => ({
    id: "sf1",
    name: "W-9 — Smart Filled",
    type: "smart_fill",
    mimeType: "application/pdf",
    linkedProfiles: [],
    tags: ["smart-fill"],
    createdAt: "2026-11-24T10:00:00Z",
    extractedData: {
      smartFill: {
        originalName: "fw9.pdf",
        originalMimeType: "application/pdf",
        filledAt: "2026-11-24T10:00:00Z",
        fieldCount: 4,
        sources: [{ id: "p1", kind: "profile", name: "Sample Person" }],
        ...(fields ? { fields } : {}),
      },
    },
  });
  const FIELDS = [
    { pdfLabel: "Name", value: "Sample Person" },
    { pdfLabel: "Business name", value: "Sample LLC" },
    { pdfLabel: "Address", value: "1 Main St" },
    { pdfLabel: "City, state, ZIP", value: "Springfield, IL 62701" },
  ];

  it("lists every filled field as label → value, and the Overview does not deny them", async () => {
    doc = smartFillDoc(FIELDS);
    mount();
    await openTab("overview");
    const overview = await screen.findByTestId("doc-overview");
    expect(overview.textContent).not.toContain("Nothing has been extracted");
    expect(screen.getByTestId("doc-smartfill-insights").textContent).toContain("Sample LLC");
    const preview = screen.getByTestId("doc-smartfill-preview").textContent || "";
    for (const f of FIELDS) { expect(preview).toContain(f.pdfLabel); expect(preview).toContain(f.value); }
    expect(screen.getByTestId("btn-view-all-fields").textContent).toContain("View All (4)");

    await openTab("data");
    const list = await screen.findByTestId("smartfill-fields");
    FIELDS.forEach((f, i) => {
      const row = screen.getByTestId(`smartfill-field-${i}`).textContent || "";
      expect(row).toContain(f.pdfLabel);
      expect(row).toContain(f.value);
    });
    expect(list.textContent).toContain("Filled from fw9.pdf");
    // No single metadata row standing in for the fields.
    expect(screen.queryByTestId("field-row-smartFill")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("a copy saved with only a count says how many were filled, never that nothing was", async () => {
    doc = smartFillDoc(undefined);
    mount();
    await openTab("overview");
    const overview = await screen.findByTestId("doc-overview");
    expect(overview.textContent).not.toContain("Nothing has been extracted");
    expect(screen.getByTestId("doc-smartfill-count-only").textContent).toContain("4 fields were filled");
    await openTab("data");
    expect((await screen.findByTestId("smartfill-count-only")).textContent).toContain("4 fields were filled");
  });
});

describe("the calendar opens on a linked day", () => {
  it("reads ?date= from the hash query", async () => {
    const { readCalendarDateParam } = await import("../client/src/components/CalendarView");
    window.location.hash = "#/calendar?date=2031-03-14";
    expect(readCalendarDateParam()).toBe("2031-03-14");
    window.location.hash = "#/calendar?date=2031-02-30";
    expect(readCalendarDateParam()).toBeNull();
    window.location.hash = "#/calendar";
    expect(readCalendarDateParam()).toBeNull();
  });
});
