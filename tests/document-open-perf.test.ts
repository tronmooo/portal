// Guards for how fast a document OPENS.
//
// The reported symptom: tapping a document showed its extracted fields
// immediately and then spun on the file preview for seconds — on the dashboard
// and in chat alike. The cause was a chain of avoidable serial work, and each
// link has a test here so it can't come back:
//
//  1. GET /api/documents/:id materialized the whole binary (a Supabase Storage
//     download + base64 encode) purely to strip it back out of the JSON — so
//     merely opening a document paid for a full file transfer BEFORE the
//     preview could start, and the client then fetched the same bytes again.
//  2. GET /api/documents/:id/file sent the whole body every single time, with
//     no validator, so reopening a document re-downloaded megabytes over LTE.
//  3. The client re-fetched and re-decoded a document's bytes on every open,
//     and a prefetch racing the viewer issued two downloads of the same file.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";

// "hello" — small, but the assertions are about which reads happen, not size.
const FILE_B64 = "aGVsbG8=";

const DOC = {
  id: "doc-1",
  name: "CA DMV Park/Toll Citation Disposition.pdf",
  type: "citation",
  mimeType: "application/pdf",
  fileData: FILE_B64,
  extractedData: { totalDue: "1085", licensePlate: "8YP3480" },
  linkedProfiles: [],
  tags: [],
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

let h: Harness;
beforeEach(async () => { h = await startHarness({ documents: [{ ...DOC }] }); });
afterEach(async () => { await h.close(); });

// ─────────────────────────────────────────────────────────────────────────────
// Server: opening a document must not read its bytes
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/documents/:id is metadata-only", () => {
  it("never calls the binary-materializing read", async () => {
    const r = await h.api("GET", "/api/documents/doc-1");
    expect(r.status).toBe(200);
    // The whole point: the detail read costs no file transfer.
    expect(h.db.getDocumentCalls).toBe(0);
  });

  it("still returns the fields the viewer renders, and never the binary", async () => {
    const r = await h.api("GET", "/api/documents/doc-1");
    expect(r.data.extractedData).toEqual(DOC.extractedData);
    expect(r.data.type).toBe("citation");
    expect(r.data.mimeType).toBe("application/pdf");
    expect(r.data.hasFile).toBe(true);
    expect(r.data.fileData).toBeUndefined();
  });

  it("reports hasFile:false for a document stored without a file", async () => {
    h.db.documents.push({ ...DOC, id: "doc-2", fileData: "" });
    const r = await h.api("GET", "/api/documents/doc-2");
    expect(r.status).toBe(200);
    expect(r.data.hasFile).toBe(false);
  });

  it("404s an unknown id", async () => {
    const r = await h.api("GET", "/api/documents/nope");
    expect(r.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server: the binary route revalidates instead of re-sending
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/documents/:id/file", () => {
  it("serves the bytes with a validator the client can revalidate against", async () => {
    const r = await h.api("GET", "/api/documents/doc-1/file");
    expect(r.status).toBe(200);
    expect(r.data).toBe("hello");
    expect(r.headers["etag"]).toBeTruthy();
    expect(r.headers["content-type"]).toContain("application/pdf");
  });

  it("answers 304 with no body when the client already has that version", async () => {
    const first = await h.api("GET", "/api/documents/doc-1/file");
    const etag = first.headers["etag"];
    const second = await h.api("GET", "/api/documents/doc-1/file", undefined, { "If-None-Match": etag });
    expect(second.status).toBe(304);
    expect(second.data).toBeFalsy();
  });

  it("changes the validator when the file is replaced, so a stale copy can't stick", async () => {
    const before = (await h.api("GET", "/api/documents/doc-1/file")).headers["etag"];
    // "goodbye" — different bytes AND a later updated_at, as a re-upload writes.
    h.db.documents[0].fileData = Buffer.from("goodbye").toString("base64");
    h.db.documents[0].updatedAt = "2026-07-30T00:00:00.000Z";
    const after = await h.api("GET", "/api/documents/doc-1/file", undefined, { "If-None-Match": before });
    expect(after.status).toBe(200);
    expect(after.data).toBe("goodbye");
    expect(after.headers["etag"]).not.toBe(before);
  });

  it("keeps the response uncacheable by shared caches", async () => {
    const r = await h.api("GET", "/api/documents/doc-1/file");
    expect(r.headers["cache-control"]).toContain("private");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("404s a document with no file attached", async () => {
    h.db.documents.push({ ...DOC, id: "doc-3", fileData: "" });
    const r = await h.api("GET", "/api/documents/doc-3/file");
    expect(r.status).toBe(404);
  });

  // Storage-backed documents must NOT be proxied through the API function —
  // the double hop (Storage → serverless Buffer → device) was the visible
  // "spinner for seconds" on every photo/PDF open. The route hands the device
  // a redirect to the storage CDN instead.
  it("302s a Storage-backed document straight to the signed CDN URL", async () => {
    h.db.documents.push({ ...DOC, id: "doc-4", fileData: "", storagePath: "user/doc-4.jpg" });
    const r = await h.api("GET", "/api/documents/doc-4/file", undefined, undefined, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toContain("user/doc-4.jpg");
    // Revalidation still works: same version → 304 without a second redirect.
    const etag = r.headers["etag"];
    expect(etag).toBeTruthy();
    const again = await h.api("GET", "/api/documents/doc-4/file", undefined, { "If-None-Match": etag }, { redirect: "manual" });
    expect(again.status).toBe(304);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat: "open my drivers license" must be metadata-only and lazy
//
// The reported symptom (2026-08 mobile report): asking chat to open a document
// took seconds. The chat path still materialized the binary server-side
// (Storage download + base64) and inlined it into the JSON reply — up to three
// copies of a multi-MB base64 string over LTE — while the client was going to
// lazy-fetch the same bytes via /api/documents/:id/file anyway.
// ─────────────────────────────────────────────────────────────────────────────
const LICENSE_DOC = {
  id: "doc-dl",
  name: "Florida Driver License",
  type: "drivers_license",
  mimeType: "image/jpeg",
  fileData: Buffer.from("license-bytes").toString("base64"),
  extractedData: { licenseNumber: "S226-116-24", expirationDate: "03/12/2034" },
  linkedProfiles: [],
  tags: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe('POST /api/chat "open my drivers license"', () => {
  it("returns a lazy preview without ever materializing the binary", async () => {
    h.db.documents.push({ ...LICENSE_DOC });
    const r = await h.api("POST", "/api/chat", { message: "open my drivers license" });
    expect(r.status).toBe(200);
    expect(r.data.reply).toContain("Florida Driver License");
    // The preview points at the document; the client fetches bytes via /file.
    expect(r.data.documentPreview?.id).toBe("doc-dl");
    expect(r.data.documentPreview?.data).toBe("__LAZY_LOAD__");
    // The whole point: opening via chat costs no server-side file transfer…
    expect(h.db.getDocumentCalls).toBe(0);
    // …and no base64 rides in the reply, anywhere in the payload.
    expect(JSON.stringify(r.data)).not.toContain(LICENSE_DOC.fileData);
  });

  it("shows ALL candidates instantly when several match — no AI narrowing wait", async () => {
    h.db.documents.push({ ...LICENSE_DOC });
    h.db.documents.push({
      ...LICENSE_DOC,
      id: "doc-dl-2",
      name: "Georgia Driver License",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const r = await h.api("POST", "/api/chat", { message: "open my drivers license" });
    expect(r.status).toBe(200);
    const ids = (r.data.documentPreviews || []).map((p: any) => p.id).sort();
    expect(ids).toEqual(["doc-dl", "doc-dl-2"]);
    for (const p of r.data.documentPreviews) expect(p.data).toBe("__LAZY_LOAD__");
    expect(h.db.getDocumentCalls).toBe(0);
  });

  it("still disambiguates: an unrelated document does not match", async () => {
    h.db.documents.push({ ...LICENSE_DOC });
    h.db.documents.push({
      ...LICENSE_DOC,
      id: "doc-ins",
      name: "Blue Cross Insurance Card",
      type: "insurance_card",
      extractedData: {},
    });
    const r = await h.api("POST", "/api/chat", { message: "open my drivers license" });
    expect(r.status).toBe(200);
    expect(r.data.documentPreview?.id).toBe("doc-dl");
    expect(h.db.getDocumentCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client: the resolved-blob cache
// ─────────────────────────────────────────────────────────────────────────────
const apiRequest = vi.fn();
vi.mock("../client/src/lib/queryClient", () => ({
  apiRequest: (...args: any[]) => apiRequest(...args),
}));

describe("document blob cache", () => {
  // Imported lazily so the vi.mock above is in place first, and re-imported per
  // test so each one starts with an empty module-level cache.
  async function freshModule() {
    vi.resetModules();
    apiRequest.mockReset();
    apiRequest.mockImplementation(async () => ({
      blob: async () => new Blob(["hello"], { type: "image/png" }),
    }));
    return await import("../client/src/lib/document-preview");
  }

  it("collapses a prefetch and the viewer's own fetch into ONE request", async () => {
    const m = await freshModule();
    // Both start before either resolves — exactly the pointer-down → dialog-open
    // sequence that used to download the same file twice.
    m.prefetchDocumentBlob("doc-1", "image/png");
    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/documents/doc-1/file");
  });

  it("serves a second open from cache without touching the network", async () => {
    const m = await freshModule();
    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledTimes(1);

    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the document's bytes are invalidated", async () => {
    const m = await freshModule();
    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));

    m.invalidateDocumentBlob("doc-1");
    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps documents separate", async () => {
    const m = await freshModule();
    m.prefetchDocumentBlob("doc-1", "image/png");
    m.prefetchDocumentBlob("doc-2", "image/png");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed fetch — the next open retries", async () => {
    const m = await freshModule();
    apiRequest.mockRejectedValue(new Error("404: Not found"));
    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));

    apiRequest.mockImplementation(async () => ({
      blob: async () => new Blob(["hello"], { type: "image/png" }),
    }));
    m.prefetchDocumentBlob("doc-1", "image/png");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });
});
