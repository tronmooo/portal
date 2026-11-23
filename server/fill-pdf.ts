// Fill In — the part that writes the file (owner request 2026-11-23: "the
// feature appears to run but does not actually populate the uploaded file").
//
// The old renderer appended a "Smart Fill — Filled Fields" summary page and
// left the form itself blank. This one writes the FORM:
//  - an interactive PDF's fields by their exact names (text, checkbox, radio,
//    dropdown), left editable, with appearances generated so every standard
//    viewer shows the values;
//  - a flat PDF's or a photo's blanks by drawing each value at its box;
//  - a photo becomes a one-page PDF with the picture as the page.
// and then `verifyFilledPdf` REOPENS the bytes and reads the values back out
// of the file. A save is reported only when that reading finds them.
//
// No model, no storage: bytes in, bytes out. Pinned by tests/fill-pdf.test.ts.
import {
  PDFDocument, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFSignature, PDFTextField, PDFButton,
  PDFFont, PDFPage, PDFRawStream, PDFArray, PDFName, PDFRef, StandardFonts, decodePDFRawStream, rgb,
} from "pdf-lib";
import { clampBox, isWritable, kindForLabel, type FillField, type FillPageSize } from "@shared/fill-fields";
import { formatFormDate } from "@shared/fill-info";

export class FillError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function bytesFromBase64(data: string): Uint8Array {
  let clean = String(data || "");
  if (clean.startsWith("data:")) clean = clean.slice(clean.indexOf(",") + 1);
  return new Uint8Array(Buffer.from(clean.replace(/\s/g, ""), "base64"));
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new FillError(422, "This file could not be read as a PDF. Nothing was filled.");
  }
  if (doc.isEncrypted) throw new FillError(422, "This PDF is password-protected, so it cannot be filled. Save an unlocked copy and try again.");
  if (doc.getPageCount() === 0) throw new FillError(422, "This PDF has no pages.");
  return doc;
}

const pageSizes = (doc: PDFDocument): FillPageSize[] => doc.getPages().map((p) => { const s = p.getSize(); return { width: s.width, height: s.height }; });

function widgetPageIndex(doc: PDFDocument, widget: any): number {
  const pages = doc.getPages();
  const p = widget.P?.();
  if (p instanceof PDFRef) {
    const i = pages.findIndex((pg) => pg.ref === p);
    if (i >= 0) return i;
  }
  const ref = doc.context.getObjectRef(widget.dict);
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (annots instanceof PDFArray && ref && annots.asArray().some((a) => a === ref)) return i;
  }
  return 0;
}

export interface PdfFormReading {
  pages: FillPageSize[];
  /** The PDF's own form fields; empty for a flat PDF. */
  fields: FillField[];
}

/** An interactive PDF's fields: name, kind, where each sits, and what it already holds. */
export async function readPdfForm(bytes: Uint8Array): Promise<PdfFormReading> {
  const doc = await load(bytes);
  const pages = pageSizes(doc);
  const fields: FillField[] = [];
  let form;
  try { form = doc.getForm(); } catch { return { pages, fields }; }
  let n = 0;
  for (const f of form.getFields()) {
    if (f instanceof PDFButton) continue;
    let widgets: any[] = [];
    try { widgets = f.acroField.getWidgets(); } catch { widgets = []; }
    if (widgets.length === 0) continue;
    const w = widgets[0];
    const page = widgetPageIndex(doc, w);
    const size = pages[page] || pages[0];
    let rect = { x: 0, y: 0, width: 100, height: 14 };
    try { rect = w.getRectangle(); } catch { /* keep the default */ }
    const box = clampBox({ x: rect.x / size.width, y: 1 - (rect.y + rect.height) / size.height, w: rect.width / size.width, h: rect.height / size.height });
    const name = f.getName();
    // The label a person reads: the field's tooltip (TU) when the form has one, else its name.
    let label = name.split(".").pop() || name;
    try {
      const tu = (f.acroField.dict as any).lookup?.(PDFName.of("TU"));
      const text = tu?.decodeText?.();
      if (typeof text === "string" && text.trim()) label = text.trim();
    } catch { /* the name is the label */ }
    label = label.replace(/[_\[\]0-9]+$/g, (m) => (/[a-z]/i.test(m) ? m : "")).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || name;
    const base = { id: `a${++n}`, label, page, box, origin: "acroform" as const, acroName: name };
    try {
      if (f instanceof PDFTextField) {
        fields.push({ ...base, kind: f.isMultiline() ? "multiline" : kindForLabel(label), value: f.getText() || "" });
      } else if (f instanceof PDFCheckBox) {
        fields.push({ ...base, kind: "checkbox", value: f.isChecked() ? "yes" : "" });
      } else if (f instanceof PDFRadioGroup) {
        fields.push({ ...base, kind: "radio", options: f.getOptions(), value: f.getSelected() || "" });
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        fields.push({ ...base, kind: "choice", options: f.getOptions(), value: (f.getSelected() || [])[0] || "" });
      } else if (f instanceof PDFSignature) {
        fields.push({ ...base, kind: "signature", value: "" });
      }
    } catch { /* a field pdf-lib cannot read is left out rather than guessed */ }
  }
  return { pages, fields };
}

/** Only what Helvetica can draw; anything else becomes its plain form, or "?". */
function drawable(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of String(text || "").replace(/\r\n?/g, "\n").replace(/\t/g, " ")) {
    if (ch === "\n") { out += ch; continue; }
    const cp = ch.codePointAt(0)!;
    if (set.has(cp)) { out += ch; continue; }
    const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += plain && [...plain].every((c) => set.has(c.codePointAt(0)!)) ? plain : "?";
  }
  return out;
}

const isYes = (v: string) => /^(yes|y|true|x|on|checked|1)$/i.test(String(v || "").trim());

/** The text a field is written with (a date in the form's usual shape). */
export function writtenValue(f: FillField): string {
  const v = String(f.value || "").trim();
  if (f.kind === "date") return formatFormDate(v);
  return v;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

function drawOverlay(page: PDFPage, font: PDFFont, bold: PDFFont, f: FillField): void {
  const { width: W, height: H } = page.getSize();
  let ox = 0, oy = 0;
  try { const mb = page.getMediaBox(); ox = mb.x; oy = mb.y; } catch { /* origin 0,0 */ }
  const x = ox + f.box.x * W, top = f.box.y * H, w = Math.max(8, f.box.w * W), h = Math.max(6, f.box.h * H);
  const ink = rgb(0.05, 0.05, 0.12);
  if (f.kind === "checkbox") {
    if (!isYes(f.value)) return;
    const size = Math.max(7, Math.min(h, w) * 0.9);
    const tw = bold.widthOfTextAtSize("X", size);
    page.drawText("X", { x: x + (w - tw) / 2, y: oy + H - top - h + (h - size * 0.72) / 2, size, font: bold, color: ink });
    return;
  }
  const text = drawable(font, writtenValue(f));
  if (!text) return;
  const multi = f.kind === "multiline" || text.includes("\n");
  let size = f.fontSize && f.fontSize > 0 ? f.fontSize : Math.max(7, Math.min(11, multi ? 10 : h * 0.72));
  if (!multi) {
    // One line: shrink to fit the blank, down to a size still readable; past that it runs on rather than being cut.
    while (size > 6 && font.widthOfTextAtSize(text, size) > w) size -= 0.5;
    page.drawText(text, { x: x + 1.5, y: oy + H - top - h + Math.max(1.5, (h - size) / 2 + size * 0.18), size, font, color: ink });
    return;
  }
  let lines = wrap(font, text, size, w - 3);
  while (size > 6 && lines.length * size * 1.2 > h) { size -= 0.5; lines = wrap(font, text, size, w - 3); }
  let y = oy + H - top - size;
  for (const line of lines) {
    if (line) page.drawText(line, { x: x + 1.5, y, size, font, color: ink });
    y -= size * 1.2;
  }
}

export interface RenderResult { bytes: Uint8Array; written: number; notes: string[] }

/**
 * Write the fields into the PDF. The original bytes are never changed: this
 * returns a new file. Signature fields are never written.
 */
export async function renderFilledPdf(original: Uint8Array, fields: FillField[]): Promise<RenderResult> {
  const doc = await load(original);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const notes: string[] = [];
  let written = 0;
  let form: ReturnType<PDFDocument["getForm"]> | null = null;
  try { form = doc.getForm(); } catch { form = null; }
  if (form && form.getFields().length > 0) {
    // An XFA layer hides the AcroForm values in some viewers.
    try { form.deleteXFA(); } catch { /* none */ }
  }
  for (const f of fields) {
    if (f.kind === "signature") continue;
    if (f.origin === "acroform" && f.acroName && form) {
      const filled = isWritable(f);
      let field;
      try { field = form.getField(f.acroName); } catch { notes.push(`"${f.label}" is not a field of this PDF any more.`); continue; }
      try {
        if (field instanceof PDFTextField) {
          const text = filled ? drawable(font, writtenValue(f)) : "";
          const max = field.getMaxLength();
          if (max !== undefined && text.length > max) field.setMaxLength(undefined);
          field.setText(text || undefined);
        } else if (field instanceof PDFCheckBox) {
          if (filled && isYes(f.value)) field.check(); else field.uncheck();
        } else if (field instanceof PDFRadioGroup) {
          if (filled) field.select(matchOption(field.getOptions(), f.value));
          else field.clear();
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          if (filled) {
            const options = field.getOptions();
            const want = matchOption(options, f.value);
            if (!options.includes(want) && field instanceof PDFDropdown) field.addOptions([want]);
            field.select(want);
          } else field.clear();
        }
        if (filled) written++;
      } catch (err) {
        notes.push(`"${f.label}" could not be written: ${(err as Error)?.message || "unknown reason"}`);
      }
      continue;
    }
    if (!isWritable(f)) continue;
    const page = pages[f.page];
    if (!page) { notes.push(`"${f.label}" is on a page this PDF does not have.`); continue; }
    try { drawOverlay(page, font, bold, f); written++; }
    catch (err) { notes.push(`"${f.label}" could not be drawn: ${(err as Error)?.message || "unknown reason"}`); }
  }
  if (form) {
    try { form.updateFieldAppearances(font); } catch { /* save() regenerates what it can */ }
  }
  const bytes = await doc.save({ updateFieldAppearances: true });
  return { bytes, written, notes };
}

/** A form's option that means what was asked for ("yes" → "Yes"). */
function matchOption(options: string[], value: string): string {
  const v = String(value || "").trim();
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return options.find((o) => o === v) || options.find((o) => n(o) === n(v)) || options.find((o) => n(o).startsWith(n(v)) && n(v).length > 0) || v;
}

// ── reading the saved file back ──────────────────────────────────────────────

/** Every byte string a page SHOWS (`<hex> Tj` / `[(…)] TJ`), with spaces removed, per page. */
function shownBytes(doc: PDFDocument): string[] {
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: PDFRawStream[] = [];
    const take = (obj: unknown) => {
      const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
      if (o instanceof PDFRawStream) streams.push(o);
      else if (o instanceof PDFArray) o.asArray().forEach(take);
    };
    take(contents);
    let hex = "";
    for (const s of streams) {
      let text = "";
      try { text = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1"); } catch { continue; }
      for (const m of text.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
        const h = m[1].replace(/\s/g, "").toUpperCase();
        for (let i = 0; i + 1 < h.length; i += 2) { const b = h.slice(i, i + 2); if (b !== "20") hex += b; }
      }
    }
    return hex;
  });
}

function hexOf(font: PDFFont, text: string): string {
  const h = font.encodeText(text).toString().replace(/[<>\s]/g, "").toUpperCase();
  let out = "";
  for (let i = 0; i + 1 < h.length; i += 2) { const b = h.slice(i, i + 2); if (b !== "20") out += b; }
  return out;
}

export interface FillVerification {
  /** Fields that were meant to be in the file. */
  expected: number;
  /** Of those, how many the reopened file really holds. */
  found: number;
  ok: boolean;
  missing: Array<{ id: string; label: string; reason: string }>;
}

/**
 * Reopen a filled PDF and read each expected value back out of it: a form
 * field by its name, a drawn value from the page's own content. This is the
 * only thing allowed to say a fill succeeded.
 */
export async function verifyFilledPdf(bytes: Uint8Array, fields: FillField[]): Promise<FillVerification> {
  const expectedFields = fields.filter(isWritable).filter((f) => f.kind !== "checkbox" || isYes(f.value) || f.origin === "acroform");
  const missing: FillVerification["missing"] = [];
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true }); }
  catch { return { expected: expectedFields.length, found: 0, ok: false, missing: expectedFields.map((f) => ({ id: f.id, label: f.label, reason: "the saved file could not be reopened" })) }; }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let form: ReturnType<PDFDocument["getForm"]> | null = null;
  try { form = doc.getForm(); } catch { form = null; }
  let shown: string[] | null = null;
  const norm = (s: string) => String(s || "").replace(/\r\n?/g, "\n").trim();
  for (const f of expectedFields) {
    const fail = (reason: string) => missing.push({ id: f.id, label: f.label, reason });
    if (f.origin === "acroform" && f.acroName) {
      if (!form) { fail("the saved file has no form fields"); continue; }
      try {
        const field = form.getField(f.acroName);
        if (field instanceof PDFTextField) {
          const want = norm(drawable(font, writtenValue(f)));
          if (norm(field.getText() || "") !== want) fail(`the field holds "${(field.getText() || "").slice(0, 40)}"`);
        } else if (field instanceof PDFCheckBox) {
          if (field.isChecked() !== isYes(f.value)) fail("the box is not in the state that was set");
        } else if (field instanceof PDFRadioGroup) {
          if ((field.getSelected() || "") !== matchOption(field.getOptions(), f.value)) fail("the choice was not kept");
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          if (((field.getSelected() || [])[0] || "") !== matchOption(field.getOptions(), f.value)) fail("the choice was not kept");
        } else fail("the field is not one that holds a value");
      } catch { fail("the field is missing from the saved file"); }
      continue;
    }
    if (!shown) shown = shownBytes(doc);
    const pageHex = shown[f.page] ?? "";
    const want = f.kind === "checkbox" ? "X" : drawable(font, writtenValue(f)).replace(/\n/g, " ");
    const hex = hexOf(font, want);
    if (!hex || !pageHex.includes(hex)) fail("the value is not on the page of the saved file");
  }
  return { expected: expectedFields.length, found: expectedFields.length - missing.length, ok: missing.length === 0, missing };
}

// ── a photo or a scan as a page ──────────────────────────────────────────────

let _sharp: any = null;
async function loadSharp(): Promise<any> {
  if (!_sharp) _sharp = (await import("sharp")).default;
  return _sharp;
}

/** A picture of a form as a one-page PDF, so values can be drawn on it and saved. */
export async function imageToPdf(image: Uint8Array): Promise<{ bytes: Uint8Array; page: FillPageSize; jpeg: Uint8Array }> {
  let jpeg: Buffer; let width = 0; let height = 0;
  try {
    const sharp = await loadSharp();
    const out = await sharp(Buffer.from(image)).rotate().resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
    jpeg = out.data; width = out.info.width; height = out.info.height;
  } catch {
    throw new FillError(422, "This picture could not be read. Try a JPEG or PNG photo of the form, or a PDF.");
  }
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpeg);
  const W = 612, H = Math.round((height / Math.max(1, width)) * W);
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: 0, y: 0, width: W, height: H });
  return { bytes: await doc.save(), page: { width: W, height: H }, jpeg: new Uint8Array(jpeg) };
}

export async function pdfPageSizes(bytes: Uint8Array): Promise<FillPageSize[]> {
  return pageSizes(await load(bytes));
}
