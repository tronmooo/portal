// A document's fields are changed key by key on the STORED row (Rule 6).
// The page used to send its whole loaded `extractedData` back: a page opened
// before an extraction finished (or open on another device) wrote its old copy
// over every field it did not touch. Real route, fake storage.
import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";
import { applyExtractedDataChanges, isExtractedDataChanges } from "../shared/extracted-data-changes";
import { readFileSync } from "node:fs";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const doc = (extractedData: Record<string, unknown>) => ({ id: "doc-1", name: "Policy", type: "insurance", extractedData, linkedProfiles: [], tags: [] });

describe("PATCH /api/documents/:id with extractedDataChanges", () => {
  it("an edit from a page loaded before a later field arrived keeps that field", async () => {
    // The page loaded {policyNumber}; the extraction then added the expiration.
    h = await startHarness({ documents: [doc({ policyNumber: "A-1", expirationDate: "2027-05-01" })] });
    const r = await h.api("PATCH", "/api/documents/doc-1", { extractedDataChanges: { set: { policyNumber: "A-2" } } });
    expect(r.status).toBe(200);
    expect(h.db.documents[0].extractedData).toEqual({ policyNumber: "A-2", expirationDate: "2027-05-01" });
  });
  it("removing one field removes only that field", async () => {
    h = await startHarness({ documents: [doc({ a: "1", b: "2", c: "3" })] });
    await h.api("PATCH", "/api/documents/doc-1", { extractedDataChanges: { remove: ["b"] } });
    expect(h.db.documents[0].extractedData).toEqual({ a: "1", c: "3" });
  });
  it("putting a date back on the calendar takes it out of the STORED opt-out list only", async () => {
    h = await startHarness({ documents: [doc({ _calendarOptOut: ["Expiration Date", "renewalDate"] })] });
    await h.api("PATCH", "/api/documents/doc-1", { extractedDataChanges: { unlist: { key: "_calendarOptOut", values: ["expirationDate"] } } });
    expect(h.db.documents[0].extractedData._calendarOptOut).toEqual(["renewalDate"]);
  });
  it("a malformed change or both forms at once is refused and writes nothing", async () => {
    h = await startHarness({ documents: [doc({ a: "1" })] });
    expect((await h.api("PATCH", "/api/documents/doc-1", { extractedDataChanges: { set: [1] } })).status).toBe(400);
    expect((await h.api("PATCH", "/api/documents/doc-1", { extractedData: {}, extractedDataChanges: { remove: ["a"] } })).status).toBe(400);
    expect(h.db.documents[0].extractedData).toEqual({ a: "1" });
  });
});

describe("the document page sends key-level changes", () => {
  const src = readFileSync("client/src/pages/document-detail.tsx", "utf8");
  it("never a rebuilt whole extractedData", () => {
    expect(src).not.toMatch(/onUpdate\(\{\s*extractedData:/);
    expect(src.match(/extractedDataChanges: \{/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("applyExtractedDataChanges", () => {
  it("does not modify the stored object", () => {
    const stored = { a: 1 };
    expect(applyExtractedDataChanges(stored, { set: { b: 2 } })).toEqual({ a: 1, b: 2 });
    expect(stored).toEqual({ a: 1 });
    expect(isExtractedDataChanges({})).toBe(false);
  });
});
