// @vitest-environment jsdom
//
// The Fill In workspace (owner request 2026-11-23). Renders the real page;
// only the PDF canvas is stood in for (jsdom has no canvas), with the same
// field layer on top.
//  - Opening writes nothing; choosing a form reads unread uploads, then fills.
//  - The fields are ON the form, with where each value came from; a field can
//    be tapped and changed; My Information lists every detail with its source
//    and a detail can be tapped into a field or placed on the page.
//  - A private value waits for the user's tap.
//  - Undo / redo; Clear all takes two taps.
//  - "Saved" is only the server's verification; a failed save shows the
//    server's reason and is not reported as saved.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
let saveFails: string | null = null;
let infoFails = false;
let unindexed = 0;

const FACTS = [
  { id: "f1", category: "Personal", label: "Full name", value: "Jordan A. Lee", key: "fullName", source: { kind: "profile", id: "p1", name: "My profile" }, ownerProfileId: "p1", sensitive: false, reliability: 3 },
  { id: "f2", category: "Contact", label: "Address", value: "123 Main St, Springfield, IL 62704", key: "address", source: { kind: "document", id: "d1", name: "Driver's License" }, ownerProfileId: "p1", sensitive: false, reliability: 3 },
  { id: "f3", category: "Identification", label: "License number", value: "L600-4412-9087", key: "driversLicenseNumber", source: { kind: "document", id: "d1", name: "Driver's License" }, ownerProfileId: "p1", sensitive: true, reliability: 3 },
  { id: "f4", category: "Employment", label: "Employer (1)", value: "Northwind Traders", key: "employer", source: { kind: "document", id: "d2", name: "Résumé" }, ownerProfileId: "p1", sensitive: false, reliability: 2 },
  { id: "f5", category: "Personal", label: "Date of birth", value: "1990-03-04", key: "dateOfBirth", source: { kind: "document", id: "d1", name: "Driver's License" }, ownerProfileId: "p1", sensitive: false, reliability: 3 },
];
const box = (y: number) => ({ x: 0.3, y, w: 0.4, h: 0.03 });
const FIELDS = [
  { id: "t1", label: "Full name", kind: "text", page: 0, box: box(0.1), origin: "text", value: "Jordan A. Lee", source: "My profile", filledBy: "structured" },
  { id: "t2", label: "Address", kind: "text", page: 0, box: box(0.15), origin: "text", value: "123 Main St, Springfield, IL 62704", source: "Driver's License", filledBy: "structured", alternatives: [{ value: "77 Old Lane, Shelbyville, IL 62565", source: "Utility bill" }] },
  { id: "t3", label: "License number", kind: "text", page: 0, box: box(0.2), origin: "text", value: "L600-4412-9087", source: "Driver's License", sensitive: true, confirmed: false },
  { id: "t4", label: "Employer", kind: "text", page: 0, box: box(0.25), origin: "text", value: "" },
  { id: "t5", label: "I agree", kind: "checkbox", page: 0, box: { x: 0.1, y: 0.3, w: 0.02, h: 0.02 }, origin: "text", value: "" },
  { id: "t6", label: "Signature", kind: "signature", page: 0, box: box(0.35), origin: "text", value: "" },
  { id: "t7", label: "Birth date", kind: "date", page: 0, box: box(0.4), origin: "text", value: "" },
];

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}) }));
vi.mock("@/lib/document-preview", () => ({ useDocumentBlobUrl: () => ({ url: "blob:saved", blob: null, loading: false, error: false }) }));
vi.mock("@/components/PdfCanvas", () => ({ default: () => <div data-testid="pdf-canvas" />, loadPdfjs: async () => ({}) }));
vi.mock("@/components/fill/FillPdfPages", () => ({
  extractTextPages: async () => [{ width: 612, height: 792, items: [] }],
  FillPdfPages: ({ overlay }: any) => <div data-fill-page={0} data-testid="fill-page-0" style={{ width: 600, height: 776 }}>{overlay(0, { widthPx: 600, heightPx: 776 })}</div>,
}));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    let data: any = {};
    if (url.startsWith("/api/smart-fill/information")) {
      if (infoFails) throw new Error("500: boom");
      data = { facts: FACTS, subject: { id: "p1", name: "Jordan" }, people: [{ id: "p1", name: "Jordan", self: true }], unindexed, counts: { profiles: 2, documents: 3, notes: 1 } };
    } else if (url === "/api/smart-fill/forms") data = [];
    else if (url === "/api/smart-fill/index") { unindexed = Math.max(0, unindexed - 2); data = { indexed: 2, failed: 0, remaining: unindexed, names: [] }; }
    else if (url === "/api/smart-fill/analyze") data = { format: "pdf", documentType: "Form", pages: [{ width: 612, height: 792 }], fields: FIELDS, detection: "text", aiUsed: true };
    else if (url === "/api/smart-fill/refill") data = { fields: body.fields.map((f: any) => (f.id === "t4" && !f.value ? { ...f, value: "Northwind Traders", source: "Résumé", filledBy: "ai" } : f)), aiUsed: true };
    else if (url === "/api/smart-fill/save") {
      if (saveFails) throw new Error(`422: {"error":"${saveFails}"}`);
      const n = body.fields.filter((f: any) => f.value && f.kind !== "signature" && !(f.sensitive && !f.confirmed)).length;
      data = { documentId: "doc-done", name: "form — Completed", mimeType: "application/pdf", originalDocumentId: "doc-blank", verification: { expected: n, found: n, ok: true, missing: [] }, notes: [] };
    }
    return { ok: true, json: async () => data };
  }),
}));

import FillWorkspacePage from "../client/src/pages/workspace-fill";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => { const { apiRequest } = await import("@/lib/queryClient"); return (await (apiRequest as any)("GET", String(queryKey[0]))).json(); } } } });
  return render(<QueryClientProvider client={client}><FillWorkspacePage /></QueryClientProvider>);
}
const writes = () => calls.filter((c) => c.method !== "GET");
async function chooseForm() {
  mount();
  await waitFor(() => expect(screen.getByTestId("fill-info-summary").textContent).toMatch(/5 details/));
  const file = new File(["%PDF-1.4"], "form.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByTestId("input-fill-file"), { target: { files: [file] } });
  await waitFor(() => screen.getByTestId("fill-field-t1"), { timeout: 4000 });
}
const field = (id: string) => screen.getByTestId(`fill-field-${id}`);
const saveButton = () => screen.getByTestId("button-workspace-save") as HTMLButtonElement;

beforeEach(() => { calls.length = 0; navigated.length = 0; saveFails = null; infoFails = false; unindexed = 0; });
afterEach(cleanup);

describe("Fill In workspace", () => {
  it("opening writes nothing and says what it will draw on", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("fill-info-summary").textContent).toMatch(/5 details from 2 profiles, 3 documents and 1 note/));
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("fill-info-summary").textContent).toMatch(/what isn't on file is left blank/);
    expect(screen.queryByTestId("button-workspace-save")).toBeNull(); // nothing to save before a form is open
  });

  it("a failed information request is an error with a retry, never 'nothing on file'", async () => {
    infoFails = true;
    mount();
    await waitFor(() => expect(screen.getByTestId("fill-info-summary").textContent).toMatch(/Couldn't load your information/));
    expect(screen.getByTestId("fill-info-summary").textContent).not.toMatch(/0 details/);
  });

  it("choosing a form first reads uploads that were never read, then fills the form's fields on the page with their sources", async () => {
    unindexed = 3;
    await chooseForm();
    expect(writes().map((c) => c.url)).toEqual(["/api/smart-fill/index", "/api/smart-fill/index", "/api/smart-fill/analyze"]);
    expect(field("t1").textContent).toBe("Jordan A. Lee");
    expect(field("t2").textContent).toBe("123 Main St, Springfield, IL 62704");
    expect(field("t2").getAttribute("title")).toBe("Address — from Driver's License");
    // The field sits where its box says.
    expect((field("t2").parentElement as HTMLElement).style.top).toBe("15%");
    expect(field("t6").textContent).toBe("sign by hand");
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("2 of 6 filled · 1 to confirm");
  });

  it("a private value is shown masked and is not included until the user taps to include it", async () => {
    await chooseForm();
    expect(field("t3").textContent).toBe("••••••••9087");
    fireEvent.click(field("t3"));
    fireEvent.click(screen.getByTestId("fill-editor-confirm"));
    expect(field("t3").textContent).toBe("L600-4412-9087");
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("3 of 6 filled");
  });

  it("a field is edited by tapping it; another value on file can be chosen; Clear empties it", async () => {
    await chooseForm();
    fireEvent.click(field("t2"));
    expect(screen.getByTestId("fill-editor-source").textContent).toBe("from Driver's License");
    fireEvent.click(screen.getByTestId("fill-editor-alternative"));
    expect(field("t2").textContent).toBe("77 Old Lane, Shelbyville, IL 62565");
    fireEvent.change(screen.getByTestId("fill-editor-input"), { target: { value: "500 New St" } });
    expect(field("t2").textContent).toBe("500 New St");
    fireEvent.click(screen.getByTestId("fill-editor-clear"));
    expect(field("t2").textContent).toBe("");
    // A tick box toggles on a tap.
    fireEvent.click(field("t5"));
    expect(field("t5").textContent).toBe("✕");
    // A signature is never filled.
    fireEvent.click(field("t6"));
    expect(screen.getByTestId("fill-editor").textContent).toMatch(/Signatures are never filled in/);
  });

  it("My Information lists every detail with its source, searches, filters by category (and says what the filter hides), and never shows a private value until asked", async () => {
    await chooseForm();
    const panel = screen.getByTestId("fill-panel");
    expect(within(panel).getByTestId("fill-fact-f2").textContent).toContain("Address · Driver's License");
    expect(within(panel).getByTestId("fill-fact-f3").textContent).toContain("••••••••9087");
    fireEvent.click(within(panel).getByLabelText("Show this value"));
    expect(within(panel).getByTestId("fill-fact-f3").textContent).toContain("L600-4412-9087");
    fireEvent.change(screen.getByTestId("input-fill-search"), { target: { value: "résumé" } });
    expect(within(panel).queryByTestId("fill-fact-f2")).toBeNull();
    expect(within(panel).getByTestId("fill-fact-f4")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-fill-search"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("fill-category-Employment"));
    expect(screen.getByTestId("fill-category-notice").textContent).toMatch(/Showing Employment only — 4 other details are hidden/);
    fireEvent.click(within(screen.getByTestId("fill-category-notice")).getByText("Show all"));
    expect(within(panel).getByTestId("fill-fact-f1")).toBeTruthy();
  });

  it("a detail goes into the selected field with one tap; with no field selected it is placed by tapping a field or an empty spot on the page", async () => {
    await chooseForm();
    // Selected field + tap a detail.
    fireEvent.click(field("t4"));
    fireEvent.click(within(screen.getByTestId("fill-fact-f4")).getByTitle(/Put this in/));
    expect(field("t4").textContent).toBe("Northwind Traders");
    expect(field("t4").getAttribute("title")).toBe("Employer — from Résumé");
    // A date detail into a date field is written the way forms want it.
    fireEvent.click(field("t7"));
    fireEvent.click(within(screen.getByTestId("fill-fact-f5")).getByTitle(/Put this in/));
    expect(field("t7").textContent).toBe("03/04/1990");
    // No field selected: tap a detail, then the page — a new box holds it at that spot.
    fireEvent.click(screen.getByLabelText("Done with this field"));
    fireEvent.click(within(screen.getByTestId("fill-fact-f1")).getByTitle("Place this on the form"));
    expect(screen.getByTestId("fill-placing").textContent).toMatch(/Tap a field — or an empty spot on the page — to place “Jordan A. Lee”/);
    // Fields that can take it are highlighted; the tick box and the signature are not.
    expect(field("t4").className).toMatch(/outline-emerald-500/);
    expect(field("t5").className).not.toMatch(/outline-emerald-500/);
    const layer = screen.getByTestId("fill-layer-0");
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 776, right: 600, bottom: 776, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(layer, { clientX: 300, clientY: 388 });
    const added = screen.getAllByTestId(/^fill-field-m/);
    expect(added).toHaveLength(1);
    expect(added[0].textContent).toBe("Jordan A. Lee");
    expect((added[0].parentElement as HTMLElement).style.left).toBe("50%");
    // A box the user added can be moved, resized and removed (two taps).
    expect(screen.getByTestId("fill-handle-move")).toBeTruthy();
    expect(screen.getByTestId("fill-handle-resize")).toBeTruthy();
    fireEvent.click(screen.getByTestId("fill-editor-remove"));
    expect(screen.getAllByTestId(/^fill-field-m/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId("fill-editor-remove"));
    expect(screen.queryAllByTestId(/^fill-field-m/)).toHaveLength(0);
  });

  it("dragging a detail onto a field fills it; dropping it on the page places it there", async () => {
    await chooseForm();
    const dt = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(screen.getByTestId("fill-fact-f4"), { dataTransfer: dt });
    expect(field("t4").className).toMatch(/outline-emerald-500/); // compatible fields light up while dragging
    fireEvent.drop(field("t4"), { dataTransfer: dt });
    expect(field("t4").textContent).toBe("Northwind Traders");
    expect(field("t4").className).not.toMatch(/outline-emerald-500/);
  });

  it("undo and redo step through edits; Auto-fill fills what is still empty; Clear all takes two taps", async () => {
    await chooseForm();
    expect((screen.getByTestId("button-fill-undo") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("button-fill-auto"));
    await waitFor(() => expect(field("t4").textContent).toBe("Northwind Traders"));
    expect(calls[calls.length - 1].url).toBe("/api/smart-fill/refill");
    fireEvent.click(screen.getByTestId("button-fill-undo"));
    expect(field("t4").textContent).toBe("");
    fireEvent.click(screen.getByTestId("button-fill-redo"));
    expect(field("t4").textContent).toBe("Northwind Traders");
    fireEvent.click(screen.getByTestId("button-fill-clear-all"));
    expect(field("t1").textContent).toBe("Jordan A. Lee"); // one tap arms it
    fireEvent.click(screen.getByTestId("button-fill-clear-all"));
    expect(field("t1").textContent).toBe("");
    expect(saveButton().disabled).toBe(true); // nothing to save now — Save is still shown
    fireEvent.click(screen.getByTestId("button-fill-undo"));
    expect(field("t1").textContent).toBe("Jordan A. Lee");
  });

  it("the same fields are a list too (every field reachable on a small screen)", async () => {
    await chooseForm();
    fireEvent.click(screen.getByTestId("button-fill-view"));
    expect(screen.getByTestId("fill-row-t2").textContent).toContain("123 Main St, Springfield, IL 62704");
    expect(screen.getByTestId("fill-row-t3").textContent).toMatch(/tap to confirm/);
    fireEvent.click(screen.getByTestId("fill-row-t4"));
    fireEvent.change(screen.getByTestId("fill-editor-input"), { target: { value: "Tailspin Toys" } });
    expect(screen.getByTestId("fill-row-t4").textContent).toContain("Tailspin Toys");
  });

  it("Save sends the form and its fields; 'Saved' is the server's check of the saved file, shown with a download and the saved file itself", async () => {
    await chooseForm();
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByTestId("fill-saved"));
    const sent = calls.find((c) => c.url === "/api/smart-fill/save")!.body;
    expect(sent).toMatchObject({ fileName: "form.pdf", mimeType: "application/pdf" });
    expect(typeof sent.fileData).toBe("string");
    expect(sent.fields).toHaveLength(7);
    expect(screen.getByTestId("fill-saved").textContent).toMatch(/The saved file was reopened and holds 2 of 2 values\. The original form is kept unchanged/);
    expect(screen.getByTestId("button-fill-download").getAttribute("download")).toBe("form — Completed.pdf");
    expect(screen.getByTestId("fill-saved-preview")).toBeTruthy();
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Saved and verified");
    // Editing again and saving replaces that completed copy, from the kept original.
    fireEvent.click(screen.getByTestId("button-fill-keep-editing"));
    fireEvent.click(field("t5"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/smart-fill/save")).toHaveLength(2));
    const second = calls.filter((c) => c.url === "/api/smart-fill/save")[1].body;
    expect(second).toMatchObject({ originalDocumentId: "doc-blank", replacesDocumentId: "doc-done" });
    expect(second.fileData).toBeUndefined();
  });

  it("a save the server could not prove is an error with its reason — never 'Saved'", async () => {
    saveFails = "The completed file was not saved: 1 of 2 values did not make it into the file (Address).";
    await chooseForm();
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByTestId("fill-save-error"));
    expect(screen.getByTestId("fill-save-error").textContent).toContain("1 of 2 values did not make it into the file (Address)");
    expect(screen.queryByTestId("fill-saved")).toBeNull();
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Not saved");
    expect(saveButton().getAttribute("data-state")).toBe("error");
  });
});
