/**
 * QA 2026-11-24 #17: a Smart Fill PDF saved only the COUNT of the fields it
 * filled (`smartFill.fieldCount`), so the saved copy's Extracted Data read
 * "4 fields" with none of them, and its Overview said nothing had been
 * extracted. The route keeps the filled values (label → value) for a PDF as it
 * already did for an image, and the shared reader the page uses lists them.
 */
import { describe, it, expect, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { startHarness, type Harness } from "./helpers/route-harness";
import { readSmartFill } from "../shared/smart-fill-fields";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function blankPdfBase64(): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save()).toString("base64");
}

const FIELDS = [
  { pdfLabel: "Name", value: "Sample Person" },
  { pdfLabel: "Business name", value: "Sample LLC" },
  { pdfLabel: "Address", value: "1 Main St" },
  { pdfLabel: "City, state, ZIP", value: "Springfield, IL 62701" },
];

describe("POST /api/smart-fill/render keeps what it filled", () => {
  it("a filled PDF's document carries every filled field as label → value", async () => {
    h = await startHarness();
    const r = await h.api("POST", "/api/smart-fill/render", {
      fileName: "fw9.pdf",
      fileData: await blankPdfBase64(),
      mimeType: "application/pdf",
      fields: [...FIELDS, { pdfLabel: "Exempt payee code", value: "" }],
    });
    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(1);
    const saved = h.db.documents[0];
    expect(saved.mimeType).toBe("application/pdf");
    const sf = readSmartFill(saved.extractedData);
    expect(sf).not.toBeNull();
    expect(sf!.rows).toEqual(FIELDS.map((f) => ({ label: f.pdfLabel, value: f.value })));
    expect(sf!.originalName).toBe("fw9.pdf");
  });
});

describe("readSmartFill", () => {
  it("a copy saved with only a count reports the count and no rows", () => {
    const sf = readSmartFill({ smartFill: { originalName: "a.pdf", fieldCount: 4 } });
    expect(sf).toEqual(expect.objectContaining({ fieldCount: 4, rows: [] }));
  });
  it("is null for a document that is not a Smart Fill copy", () => {
    expect(readSmartFill({ expiration_date: "2031-01-01" })).toBeNull();
    expect(readSmartFill(null)).toBeNull();
  });
});
