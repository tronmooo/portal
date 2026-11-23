// Fill In for Word forms (.docx) (owner request 2026-11-23: "Support editing
// and exporting compatible Word documents").
//
// A .docx is a zip of XML. The blanks a Word form uses are found in its main
// document part and written IN PLACE, so the completed file is still a Word
// document the user can open and keep editing:
//  - a run of underscores ("Name: ________") → the value replaces the run;
//  - a paragraph that ends with a label and a colon ("Employer:") → the value
//    is added after it;
//  - a table row whose label cell is followed by an empty cell → the value is
//    written into the empty cell;
//  - a ☐ → ☒ when the answer is yes.
// A field is addressed by its paragraph's position and the blank's position in
// it, so the same file always yields the same fields and a re-fill of a filled
// file is not attempted (the original is always the one filled).
//
// `verifyFilledDocx` reopens the saved zip and reads each value back out of
// its paragraph. Pinned by tests/fill-routes.test.ts ("a Word form").
import JSZip from "jszip";
import { isWritable, kindForLabel, type FillField } from "@shared/fill-fields";
import { formatFormDate } from "@shared/fill-info";
import { FillError, type FillVerification } from "./fill-pdf";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAIN = "word/document.xml";

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Para { start: number; end: number; xml: string; text: string }

function paragraphs(xml: string): Para[] {
  const out: Para[] = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ start: m.index, end: m.index + m[0].length, xml: m[0], text: paraText(m[0]) });
  return out;
}
function paraText(pxml: string): string {
  let t = "";
  for (const m of pxml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)) t += m[1] !== undefined ? unescapeXml(m[1]) : " ";
  return t;
}

const BLANK = /_{3,}/g;
const cleanLabel = (s: string) => s.replace(/_{2,}/g, " ").replace(/\s+/g, " ").replace(/^[\s:;,\-–]+|[\s:;,\-–]+$/g, "").trim();

type Target = { kind: "blank" | "check"; para: number; index: number } | { kind: "append"; para: number };
const idOf = (t: Target) => (t.kind === "append" ? `d${t.para}_a` : `d${t.para}_${t.kind === "check" ? "c" : "b"}${t.index}`);
function targetOf(id: string): Target | null {
  const m = /^d(\d+)_(a|b(\d+)|c(\d+))$/.exec(id);
  if (!m) return null;
  if (m[2] === "a") return { kind: "append", para: +m[1] };
  return m[3] !== undefined ? { kind: "blank", para: +m[1], index: +m[3] } : { kind: "check", para: +m[1], index: +m[4]! };
}

async function open(bytes: Uint8Array): Promise<{ zip: JSZip; xml: string }> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new FillError(422, "This file could not be read as a Word document (.docx). Older .doc files are not supported: save it as .docx or PDF."); }
  const file = zip.file(MAIN);
  if (!file) throw new FillError(422, "This Word file has no document part. Save it again as .docx or as a PDF.");
  return { zip, xml: await file.async("string") };
}

/** The blanks of a Word form. */
export async function readDocxForm(bytes: Uint8Array): Promise<{ fields: FillField[]; paragraphs: string[] }> {
  const { xml } = await open(bytes);
  const paras = paragraphs(xml);
  const fields: FillField[] = [];
  const taken = new Set<number>();
  const make = (t: Target, label: string, kind: FillField["kind"] = "text") => {
    const l = cleanLabel(label);
    if (!l && kind !== "checkbox") return;
    fields.push({ id: idOf(t), label: l || "Checkbox", kind: kind === "checkbox" ? "checkbox" : kindForLabel(l, kind), page: 0, box: { x: 0, y: 0, w: 0.5, h: 0.02 }, origin: "docx", value: "" });
  };
  paras.forEach((p, pi) => {
    let cursor = 0, k = 0, m: RegExpExecArray | null;
    const re = new RegExp(BLANK.source, "g");
    while ((m = re.exec(p.text))) {
      make({ kind: "blank", para: pi, index: k++ }, p.text.slice(cursor, m.index) || (pi > 0 ? paras[pi - 1].text : ""));
      cursor = m.index + m[0].length;
      taken.add(pi);
    }
    let c = 0;
    for (const cm of p.text.matchAll(/☐/g)) {
      const after = p.text.slice(cm.index! + 1).split("☐")[0];
      make({ kind: "check", para: pi, index: c++ }, after, "checkbox");
      taken.add(pi);
    }
    if (!taken.has(pi) && /[A-Za-z)][^:]{0,60}:\s*$/.test(p.text) && p.text.trim().length <= 80) {
      make({ kind: "append", para: pi }, p.text);
      taken.add(pi);
    }
  });
  // Table rows: a label cell followed by an empty cell.
  for (const row of xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
    const base = row.index!;
    const cells = [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>|<w:tc [\s\S]*?<\/w:tc>/g)].map((c) => ({ start: base + c.index!, end: base + c.index! + c[0].length }));
    for (let i = 0; i + 1 < cells.length; i++) {
      const inCell = (cell: { start: number; end: number }) => paras.map((p, idx) => ({ p, idx })).filter(({ p }) => p.start >= cell.start && p.end <= cell.end);
      const label = inCell(cells[i]);
      const blank = inCell(cells[i + 1]);
      const labelText = label.map(({ p }) => p.text).join(" ").trim();
      if (!labelText || labelText.length > 80 || BLANK.test(labelText) || blank.length === 0) { BLANK.lastIndex = 0; continue; }
      BLANK.lastIndex = 0;
      if (blank.some(({ p }) => p.text.trim() !== "")) continue;
      if (label.some(({ idx }) => taken.has(idx)) || taken.has(blank[0].idx)) continue;
      make({ kind: "append", para: blank[0].idx }, labelText);
      taken.add(blank[0].idx);
      label.forEach(({ idx }) => taken.add(idx));
      i++;
    }
  }
  fields.sort((a, b) => (targetOf(a.id)!.para - targetOf(b.id)!.para) || a.id.localeCompare(b.id));
  return { fields, paragraphs: paras.map((p) => p.text) };
}

const written = (f: FillField) => { const v = String(f.value || "").trim(); return f.kind === "date" ? formatFormDate(v) : v; };
const isYes = (v: string) => /^(yes|y|true|x|on|checked|1)$/i.test(String(v || "").trim());

/** Rewrite the text nodes of one paragraph so that `edit` is applied to its text. */
function editParagraph(pxml: string, edits: Array<{ from: number; to: number; text: string }>): string {
  const nodes: Array<{ start: number; end: number; open: string; text: string; at: number }> = [];
  let offset = 0;
  const re = /(<w:t(?:\s[^>]*)?>)([^<]*)<\/w:t>|<w:tab\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pxml))) {
    if (m[1] === undefined) { offset += 1; continue; }
    const text = unescapeXml(m[2]);
    nodes.push({ start: m.index, end: m.index + m[0].length, open: m[1], text, at: offset });
    offset += text.length;
  }
  // Apply from the last edit to the first so earlier offsets stay true.
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    let placed = false;
    for (const n of nodes) {
      const s = Math.max(e.from, n.at), t = Math.min(e.to, n.at + n.text.length);
      if (s >= t) continue;
      const a = s - n.at, b = t - n.at;
      n.text = n.text.slice(0, a) + (placed ? "" : e.text) + n.text.slice(b);
      // Later nodes of this edit only lose their part of the range; offsets of
      // EARLIER edits are unaffected because edits run last-to-first.
      placed = true;
    }
  }
  let out = pxml;
  for (const n of [...nodes].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, n.start)}<w:t xml:space="preserve">${escapeXml(n.text)}</w:t>${out.slice(n.end)}`;
  }
  return out;
}

function appendRun(pxml: string, text: string): string {
  // Reuse the paragraph's last run properties so the answer matches the form's type.
  const rpr = [...pxml.matchAll(/<w:rPr>[\s\S]*?<\/w:rPr>/g)].pop()?.[0] || "";
  return pxml.replace(/<\/w:p>$/, `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`);
}

/** Write the fields into the Word file. Returns a new file; the original is unchanged. */
export async function renderFilledDocx(original: Uint8Array, fields: FillField[]): Promise<{ bytes: Uint8Array; written: number; notes: string[] }> {
  const { zip, xml } = await open(original);
  const paras = paragraphs(xml);
  const notes: string[] = [];
  const byPara = new Map<number, Array<{ f: FillField; t: Target }>>();
  for (const f of fields) {
    if (f.origin !== "docx" || !isWritable(f)) continue;
    const t = targetOf(f.id);
    if (!t || !paras[t.para]) { notes.push(`"${f.label}" is not a blank of this document.`); continue; }
    if (!byPara.has(t.para)) byPara.set(t.para, []);
    byPara.get(t.para)!.push({ f, t });
  }
  let count = 0;
  let out = xml;
  for (const pi of [...byPara.keys()].sort((a, b) => b - a)) {
    const p = paras[pi];
    let pxml = p.xml;
    const edits: Array<{ from: number; to: number; text: string }> = [];
    const blanks = [...p.text.matchAll(new RegExp(BLANK.source, "g"))];
    const checks = [...p.text.matchAll(/☐/g)];
    let append = "";
    for (const { f, t } of byPara.get(pi)!) {
      if (t.kind === "blank") {
        const b = blanks[t.index];
        if (!b) { notes.push(`"${f.label}" could not be found in the document.`); continue; }
        edits.push({ from: b.index!, to: b.index! + b[0].length, text: written(f) });
        count++;
      } else if (t.kind === "check") {
        const c = checks[t.index];
        if (!c) { notes.push(`"${f.label}" could not be found in the document.`); continue; }
        if (isYes(f.value)) { edits.push({ from: c.index!, to: c.index! + 1, text: "☒" }); count++; }
      } else { append = `${/\s$/.test(p.text) || p.text === "" ? "" : " "}${written(f)}`; count++; }
    }
    if (edits.length) pxml = editParagraph(pxml, edits);
    if (append) pxml = appendRun(pxml, append);
    out = out.slice(0, p.start) + pxml + out.slice(p.end);
  }
  zip.file(MAIN, out);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, written: count, notes };
}

/** Reopen a filled Word file and read each expected value back out of its paragraph. */
export async function verifyFilledDocx(bytes: Uint8Array, fields: FillField[]): Promise<FillVerification> {
  const expected = fields.filter((f) => f.origin === "docx" && isWritable(f)).filter((f) => f.kind !== "checkbox" || isYes(f.value));
  const missing: FillVerification["missing"] = [];
  let texts: string[] = [];
  try { texts = paragraphs((await open(bytes)).xml).map((p) => p.text); }
  catch { return { expected: expected.length, found: 0, ok: false, missing: expected.map((f) => ({ id: f.id, label: f.label, reason: "the saved file could not be reopened" })) }; }
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const f of expected) {
    const t = targetOf(f.id);
    const text = t ? texts[t.para] ?? "" : "";
    const want = f.kind === "checkbox" ? "☒" : squash(written(f));
    if (!squash(text).includes(want)) missing.push({ id: f.id, label: f.label, reason: "the value is not in the saved document" });
  }
  return { expected: expected.length, found: expected.length - missing.length, ok: missing.length === 0, missing };
}
