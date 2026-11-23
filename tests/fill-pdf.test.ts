// Fill In writes the FORM and proves it (owner request 2026-11-23: "the
// completed file must contain the information, save correctly, reopen
// correctly"). The old renderer appended a summary page and left the form
// blank; these drive the real writer over real PDFs and then read the saved
// bytes back with a SECOND, independent reader (PDF.js — what a browser's
// viewer uses), not with the code that wrote them.
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { imageToPdf, readPdfForm, renderFilledPdf, verifyFilledPdf, FillError } from "../server/fill-pdf";
import { detectTextFields, type FillField, type TextPage } from "../shared/fill-fields";

/** What a standard viewer reads: each page's text, and the form's field values. */
async function readWithPdfjs(bytes: Uint8Array): Promise<{ text: string[]; fields: Record<string, any>; pages: TextPage[] }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false }).promise;
  const text: string[] = []; const fields: Record<string, any> = {}; const pages: TextPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    text.push(content.items.map((it: any) => it.str).join(" "));
    pages.push({ width: vp.width, height: vp.height, items: content.items.map((it: any) => ({ str: it.str, x: it.transform[4], y: vp.height - it.transform[5] - it.height, w: it.width, h: it.height })) });
    for (const a of await page.getAnnotations()) if (a.fieldName) fields[a.fieldName] = a.fieldValue;
  }
  return { text, fields, pages };
}

async function interactiveForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  page.drawText("Rental application", { x: 50, y: 740, size: 16, font });
  const text = (name: string, y: number, multiline = false) => {
    const f = form.createTextField(name);
    if (multiline) f.enableMultiline();
    f.addToPage(page, { x: 200, y, width: 300, height: multiline ? 60 : 18 });
  };
  text("applicant.fullName", 700); text("applicant.address", 670); text("applicant.moveInDate", 640); text("applicant.notes", 560, true);
  form.createCheckBox("applicant.hasPets").addToPage(page, { x: 200, y: 530, width: 14, height: 14 });
  form.createCheckBox("applicant.smoker").addToPage(page, { x: 200, y: 505, width: 14, height: 14 });
  const radio = form.createRadioGroup("applicant.term");
  radio.addOptionToPage("12 months", page, { x: 200, y: 480, width: 14, height: 14 });
  radio.addOptionToPage("6 months", page, { x: 300, y: 480, width: 14, height: 14 });
  const dd = form.createDropdown("applicant.state");
  dd.addOptions(["CA", "IL", "NY"]);
  dd.addToPage(page, { x: 200, y: 450, width: 80, height: 18 });
  return doc.save();
}

async function flatForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const line = (s: string, y: number) => page.drawText(s, { x: 50, y, size: 11, font });
  line("EMPLOYMENT APPLICATION", 740);
  line("Full name: ______________________________", 700);
  line("Address: ________________________________________", 675);
  line("Date of birth: ____________   Phone: ________________", 650);
  line("Most recent employer:", 620);
  line("[ ] I am authorized to work", 590);
  line("Describe your experience: ______________________________________", 560);
  return doc.save();
}

const set = (fields: FillField[], label: RegExp, value: string): FillField[] =>
  fields.map((f) => (label.test(f.acroName || f.label) ? { ...f, value } : f));

describe("an interactive PDF", () => {
  it("reads its fields: names, kinds, choices and where each sits", async () => {
    const { fields, pages } = await readPdfForm(await interactiveForm());
    expect(pages).toEqual([{ width: 612, height: 792 }]);
    const byName = Object.fromEntries(fields.map((f) => [f.acroName, f]));
    expect(byName["applicant.fullName"].kind).toBe("text");
    expect(byName["applicant.moveInDate"].kind).toBe("date");
    expect(byName["applicant.notes"].kind).toBe("multiline");
    expect(byName["applicant.hasPets"].kind).toBe("checkbox");
    expect(byName["applicant.term"]).toMatchObject({ kind: "radio", options: ["12 months", "6 months"] });
    expect(byName["applicant.state"]).toMatchObject({ kind: "choice", options: ["CA", "IL", "NY"] });
    // The name box: 200pt from the left, top edge 792-700-18 = 74pt down.
    expect(byName["applicant.fullName"].box.x).toBeCloseTo(200 / 612, 2);
    expect(byName["applicant.fullName"].box.y).toBeCloseTo(74 / 792, 2);
  });

  it("writes text, a date, a multi-line answer, checkboxes, a radio choice and a dropdown into the FORM, and a second reader finds them", async () => {
    const original = await interactiveForm();
    let { fields } = await readPdfForm(original);
    fields = set(fields, /fullName/, "Jordan A. Lee");
    fields = set(fields, /address/, "123 Main St, Springfield, IL 62704");
    fields = set(fields, /moveInDate/, "2027-01-15");
    fields = set(fields, /notes/, "Two adults.\nNo smoking.\nQuiet hours are fine.");
    fields = set(fields, /hasPets/, "yes");
    fields = set(fields, /term/, "6 months");
    fields = set(fields, /state/, "IL");
    const out = await renderFilledPdf(original, fields);
    expect(out.notes).toEqual([]);
    expect(out.written).toBe(7);
    expect(await verifyFilledPdf(out.bytes, fields)).toMatchObject({ ok: true, expected: 7, found: 7, missing: [] });

    const seen = await readWithPdfjs(out.bytes);
    expect(seen.fields["applicant.fullName"]).toBe("Jordan A. Lee");
    expect(seen.fields["applicant.address"]).toBe("123 Main St, Springfield, IL 62704");
    expect(seen.fields["applicant.moveInDate"]).toBe("01/15/2027");
    expect(String(seen.fields["applicant.notes"]).replace(/\r/g, "")).toBe("Two adults.\nNo smoking.\nQuiet hours are fine.");
    expect(seen.fields["applicant.hasPets"]).toBe("Yes");
    expect(seen.fields["applicant.smoker"]).toBe("Off");
    expect(seen.fields["applicant.term"]).not.toBe("Off");
    expect(seen.fields["applicant.state"]).toEqual(["IL"]);
    // No summary page was bolted on: the form is still one page, and still editable.
    const reopened = await PDFDocument.load(out.bytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getForm().getTextField("applicant.fullName").isReadOnly()).toBe(false);
    // The original is untouched.
    expect((await readWithPdfjs(original)).fields["applicant.fullName"]).toBeFalsy();
  });

  it("a filled file can be reopened and changed: the second save holds the new value", async () => {
    const original = await interactiveForm();
    const { fields } = await readPdfForm(original);
    const first = await renderFilledPdf(original, set(fields, /fullName/, "Jordan Lee"));
    const again = await readPdfForm(first.bytes);
    expect(again.fields.find((f) => f.acroName === "applicant.fullName")!.value).toBe("Jordan Lee");
    const second = await renderFilledPdf(first.bytes, set(again.fields, /fullName/, "Jordan A. Lee"));
    expect((await readWithPdfjs(second.bytes)).fields["applicant.fullName"]).toBe("Jordan A. Lee");
  });

  it("verification FAILS when the file does not hold what was asked — it never takes the writer's word", async () => {
    const original = await interactiveForm();
    const { fields } = await readPdfForm(original);
    const wanted = set(fields, /fullName/, "Jordan A. Lee");
    // The untouched original stands in for a save that silently wrote nothing.
    const check = await verifyFilledPdf(original, wanted);
    expect(check.ok).toBe(false);
    expect(check.missing.map((m) => m.label)).toEqual([wanted.find((f) => /fullName/.test(f.acroName!))!.label]);
  });

  it("a signature field is never written, and an unconfirmed sensitive value stays out of the file", async () => {
    const original = await interactiveForm();
    let { fields } = await readPdfForm(original);
    fields = fields.map((f) => (/fullName/.test(f.acroName!) ? { ...f, value: "123-45-6789", sensitive: true, confirmed: false } : f));
    const out = await renderFilledPdf(original, fields);
    expect((await readWithPdfjs(out.bytes)).fields["applicant.fullName"]).toBeFalsy();
    const confirmed = fields.map((f) => ({ ...f, confirmed: true }));
    expect((await readWithPdfjs((await renderFilledPdf(original, confirmed)).bytes)).fields["applicant.fullName"]).toBe("123-45-6789");
  });
});

describe("a flat (non-interactive) PDF", () => {
  it("its blanks are found from its text: underscore runs, a label with a gap, and a checkbox", async () => {
    const { pages } = await readWithPdfjs(await flatForm());
    const fields = detectTextFields(pages);
    expect(fields.map((f) => `${f.label}|${f.kind}`)).toEqual([
      "Full name|text", "Address|text", "Date of birth|date", "Phone|text", "Most recent employer|text",
      "I am authorized to work|checkbox", "Describe your experience|multiline",
    ]);
    // The name blank starts after its label, on the label's line.
    const name = fields[0];
    expect(name.box.x).toBeGreaterThan(0.15);
    expect(name.box.y).toBeGreaterThan(0.1);
    expect(name.box.y).toBeLessThan(0.14);
  });

  it("values are drawn ON the page at their blanks, and the saved page's text carries them", async () => {
    const original = await flatForm();
    const { pages } = await readWithPdfjs(original);
    let fields = detectTextFields(pages);
    const put = (label: RegExp, value: string) => { fields = fields.map((f) => (label.test(f.label) ? { ...f, value } : f)); };
    put(/^Full name/, "Jordan A. Lee"); put(/^Address/, "123 Main St, Springfield, IL 62704"); put(/^Date of birth/, "March 4, 1990");
    put(/^Phone/, "(555) 010-2299"); put(/employer/, "Northwind Traders"); put(/authorized/, "yes");
    put(/experience/, "Eight years leading warehouse teams of up to twenty people, including scheduling, safety training and inventory audits across two sites.");
    const out = await renderFilledPdf(original, fields);
    expect(out.notes).toEqual([]);
    const check = await verifyFilledPdf(out.bytes, fields);
    expect(check).toMatchObject({ ok: true, expected: 7, found: 7 });

    const seen = await readWithPdfjs(out.bytes);
    const page = seen.text[0].replace(/\s+/g, " ");
    for (const v of ["Jordan A. Lee", "123 Main St, Springfield, IL 62704", "03/04/1990", "(555) 010-2299", "Northwind Traders"]) expect(page).toContain(v);
    expect(page.replace(/\s/g, "")).toContain("Eightyearsleadingwarehouseteams");
    expect(page.replace(/\s/g, "")).toContain("inventoryauditsacrosstwosites."); // the long answer is whole, not cut
    // …and each value sits on its own blank's line: same height as its label.
    const nameItem = seen.pages[0].items.find((i) => i.str.includes("Jordan A. Lee"))!;
    const labelItem = seen.pages[0].items.find((i) => i.str.startsWith("Full name"))!;
    expect(Math.abs(nameItem.y - labelItem.y)).toBeLessThan(6);
    expect(nameItem.x).toBeGreaterThan(labelItem.x + 40);
    expect(seen.text.length).toBe(1); // no extra page
  });

  it("a value that was not drawn is reported missing by name", async () => {
    const original = await flatForm();
    const { pages } = await readWithPdfjs(original);
    const fields = detectTextFields(pages).map((f) => (/^Full name/.test(f.label) ? { ...f, value: "Jordan A. Lee" } : f));
    const check = await verifyFilledPdf(original, fields);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([{ id: fields[0].id, label: "Full name", reason: "the value is not on the page of the saved file" }]);
  });

  it("a letter Helvetica cannot draw is written in its plain form rather than failing the save", async () => {
    const original = await flatForm();
    const { pages } = await readWithPdfjs(original);
    const fields = detectTextFields(pages).map((f) => (/^Full name/.test(f.label) ? { ...f, value: "Zoë Nováková – Łódź" } : f));
    const out = await renderFilledPdf(original, fields);
    expect((await verifyFilledPdf(out.bytes, fields)).ok).toBe(true);
    expect((await readWithPdfjs(out.bytes)).text[0]).toContain("Zoë Nováková");
  });
});

describe("a photo of a form", () => {
  it("becomes a one-page PDF that values can be drawn on", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 850, height: 1100, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const { bytes, page } = await imageToPdf(new Uint8Array(png));
    expect(page).toEqual({ width: 612, height: 792 });
    const field: FillField = { id: "v1", label: "Name", kind: "text", page: 0, origin: "vision", value: "Jordan A. Lee", box: { x: 0.3, y: 0.2, w: 0.4, h: 0.025 } };
    const out = await renderFilledPdf(bytes, [field]);
    expect((await verifyFilledPdf(out.bytes, [field])).ok).toBe(true);
    expect((await readWithPdfjs(out.bytes)).text[0]).toContain("Jordan A. Lee");
  });

  it("a file that is not a picture or a PDF is a clear error, not a blank save", async () => {
    await expect(imageToPdf(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(FillError);
    await expect(readPdfForm(new Uint8Array([1, 2, 3]))).rejects.toThrow(/could not be read as a PDF/);
  });
});
