// Fill In — the operations behind the workspace (owner request 2026-11-23:
// "the entire workflow must actually work from start to finish").
//
//   getFillInformation   every fact the user has on file, with its source
//   indexNextDocuments   read uploads Fill In has never read (old ones too)
//   analyzeForm          find the form's fields and propose a value for each
//   saveFilledForm       write the file, REOPEN it, and only then report it
//   loadFillSession      reopen a completed form for more editing
//
// What the model may and may not do here:
//  - It matches a field to FACTS by id. A value it returns is kept only if
//    `groundValue` finds every word of it in the facts it cites; anything else
//    is dropped and the field stays blank. It cannot supply a phone number.
//  - It never sees a sensitive value (it gets "[on file]" and cites the id),
//    and a field filled from one is not written until the user confirms.
//  - With no model, or when a call fails, the structured match still fills
//    what a label plainly asks for; the answer says the AI was not used.
// Everything is read through the request's own storage, so one account never
// sees another's records.
import { createHash } from "crypto";
import { storage } from "./storage";
import { getAnthropicClient } from "./anthropic-client";
import { listNotes } from "./content-service";
import {
  FILL_ORIGINAL_TAG, buildFillFacts, formatFormDate, groundValue, isFillIndexed, matchLabelToFacts, maskValue,
  type FillFact,
} from "@shared/fill-info";
import {
  clampBox, detectTextFields, isWritable, kindForLabel, sanitizeFields, serializeFields,
  type FillField, type FillFieldKind, type FillPageSize, type TextPage,
} from "@shared/fill-fields";
import { documentHasFile } from "@shared/document-file";
import {
  FillError, bytesFromBase64, imageToPdf, pdfPageSizes, readPdfForm, renderFilledPdf, verifyFilledPdf, type FillVerification,
} from "./fill-pdf";
import { DOCX_MIME, readDocxForm, renderFilledDocx, verifyFilledDocx } from "./fill-docx";

export { FillError };

const MODEL = () => process.env.ANTHROPIC_FILL_MODEL || process.env.ANTHROPIC_DOCUMENT_MODEL || "claude-sonnet-4-6";
const hasModel = () => !!process.env.ANTHROPIC_API_KEY;
export const FILL_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;

/** Tests swap the model for a stub: (system-less) prompt + optional file → the model's text. */
export type FillModel = (input: { prompt: string; file?: { mimeType: string; base64: string }; maxTokens: number }) => Promise<string>;
let modelOverride: FillModel | null = null;
export function setFillModelForTests(fn: FillModel | null): void { modelOverride = fn; }

async function askModel(input: { prompt: string; file?: { mimeType: string; base64: string }; maxTokens: number }): Promise<string> {
  if (modelOverride) return modelOverride(input);
  if (!hasModel()) throw new Error("no model configured");
  const content: any[] = [];
  if (input.file) {
    const mime = input.file.mimeType === "image/jpg" ? "image/jpeg" : input.file.mimeType;
    content.push(mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file.base64 } }
      : { type: "image", source: { type: "base64", media_type: mime, data: input.file.base64 } });
  }
  content.push({ type: "text", text: input.prompt });
  const response: any = await getAnthropicClient("extended").messages.create({ model: MODEL(), max_tokens: input.maxTokens, messages: [{ role: "user", content }] });
  return (response?.content || []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
}
const modelReady = () => !!modelOverride || hasModel();

function parseJson(text: string): any {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── My Information ───────────────────────────────────────────────────────────

interface Loaded { profiles: any[]; documents: any[]; notes: any[] }
async function loadRecords(): Promise<Loaded> {
  const [profiles, documents, notes] = await Promise.all([
    storage.getProfiles(),
    storage.getDocuments(),
    listNotes(storage as any, {}).catch(() => [] as any[]),
  ]);
  return { profiles: profiles as any[], documents: documents as any[], notes: notes as any[] };
}

const indexable = (d: any) =>
  !d.deletedAt && d.type !== "smart_fill" && !(d.tags || []).includes("smart-fill") && !(d.tags || []).includes(FILL_ORIGINAL_TAG)
  && documentHasFile(d) && (d.mimeType === "application/pdf" || IMAGE.test(d.mimeType || "") || d.mimeType === DOCX_MIME || d.mimeType === "text/plain");

/** Uploads Fill In has not read yet: the ones with nothing extracted first, then identity papers and résumés, then newest. */
function pendingIndex(documents: any[]): any[] {
  const score = (d: any) => {
    const empty = Object.keys(d.extractedData || {}).filter((k) => k !== "note").length === 0 ? 2 : 0;
    const key = /licen[sc]e|passport|r[ée]sum[ée]|\bcv\b|\bid\b|identification|certificate|insurance|registration|w-?2|tax/i.test(`${d.name} ${d.type}`) ? 1 : 0;
    return empty + key;
  };
  return documents.filter((d) => indexable(d) && !isFillIndexed(d.extractedData))
    .sort((a, b) => score(b) - score(a) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export interface FillInformation {
  facts: FillFact[];
  /** Whose form: the account holder unless another person was chosen. */
  subject: { id: string | null; name: string };
  people: Array<{ id: string; name: string; self: boolean }>;
  /** Uploads not read yet (they are read when a fill starts). */
  unindexed: number;
  counts: { profiles: number; documents: number; notes: number };
}

export async function getFillInformation(forProfileId?: string | null): Promise<FillInformation> {
  const { profiles, documents, notes } = await loadRecords();
  const people = profiles.filter((p) => p.type === "self" || p.type === "person");
  const self = people.find((p) => p.type === "self") || null;
  const subject = (forProfileId && people.find((p) => p.id === forProfileId)) || self;
  const facts = buildFillFacts({ profiles, documents, notes, forProfileId: subject?.id ?? null });
  return {
    facts,
    subject: { id: subject?.id ?? null, name: subject?.name ?? "Me" },
    people: people.map((p) => ({ id: p.id, name: p.name, self: p.type === "self" })),
    unindexed: pendingIndex(documents).length,
    counts: { profiles: profiles.length, documents: documents.filter((d) => !d.deletedAt).length, notes: notes.length },
  };
}

// ── reading uploads that were never read ─────────────────────────────────────

const INDEX_PROMPT = `You are reading a document a person saved, so that its details can later be used to fill in forms for them.
Extract ONLY what is printed or written in the document. Never guess, never complete a partial value, never add a detail that is not there.

Return ONLY JSON in this shape (omit any key that has nothing):
{
  "documentType": "<short label: Driver's License, Résumé, Passport, Insurance Card, Utility Bill, …>",
  "facts": { "<label as a person would say it>": "<value exactly as written>" },
  "records": {
    "employment": [ { "employer": "", "jobTitle": "", "startDate": "", "endDate": "", "location": "", "supervisor": "", "phone": "", "description": "" } ],
    "education": [ { "school": "", "degree": "", "fieldOfStudy": "", "graduationDate": "", "location": "" } ],
    "references": [ { "name": "", "relationship": "", "phone": "", "email": "" } ]
  },
  "skills": [ "" ]
}

Rules:
- "facts" holds single details: full name, date of birth, address (one line, as written), city, state, ZIP, phone, email, licence / passport / policy / account numbers, issue and expiration dates, sex, height, eye colour, class, VIN, plate, make, model, year, and any other labelled value.
- Most recent job and school first. Keep dates as written.
- A blank form with nothing filled in has no facts: return {"documentType": "<its name>", "facts": {}}.
- Never include passwords, PINs or card security codes.`;

export interface IndexResult { indexed: number; failed: number; remaining: number; names: string[] }

/**
 * Read up to `max` uploads Fill In has not read. Each is read once: the
 * reading (or the fact that it could not be read) is stored on the document,
 * so an old upload is never asked for again and never read twice.
 */
export async function indexNextDocuments(max = 2): Promise<IndexResult> {
  const documents = (await storage.getDocuments()) as any[];
  const pending = pendingIndex(documents);
  if (pending.length === 0 || !modelReady()) return { indexed: 0, failed: 0, remaining: modelReady() ? 0 : pending.length, names: [] };
  const batch = pending.slice(0, Math.max(1, Math.min(4, max)));
  const results = await Promise.all(batch.map(async (d) => {
    let payload: Record<string, any> = { failed: true };
    try {
      const file = await (storage as any).getDocumentFile(d.id);
      if (!file?.buffer || file.buffer.length === 0) throw new Error("no file");
      if (file.buffer.length > FILL_MAX_BYTES) throw new Error("too large");
      const mime = file.mimeType || d.mimeType;
      let text = "";
      if (mime === "text/plain") text = await askModel({ prompt: `${INDEX_PROMPT}\n\nDOCUMENT "${d.name}":\n${file.buffer.toString("utf8").slice(0, 60_000)}`, maxTokens: 3000 });
      else if (mime === DOCX_MIME) {
        const { paragraphs } = await readDocxForm(new Uint8Array(file.buffer));
        text = await askModel({ prompt: `${INDEX_PROMPT}\n\nDOCUMENT "${d.name}":\n${paragraphs.join("\n").slice(0, 60_000)}`, maxTokens: 3000 });
      } else {
        let fileMime = mime; let base64 = file.buffer.toString("base64");
        if (IMAGE.test(mime) && !/png|jpe?g|webp|gif/i.test(mime)) { const pdf = await imageToPdf(new Uint8Array(file.buffer)); fileMime = "image/jpeg"; base64 = Buffer.from(pdf.jpeg).toString("base64"); }
        text = await askModel({ prompt: `${INDEX_PROMPT}\n\nThe document's name: "${d.name}"`, file: { mimeType: fileMime, base64 }, maxTokens: 3000 });
      }
      const parsed = parseJson(text);
      if (!parsed) throw new Error("unreadable answer");
      payload = { data: JSON.stringify({ documentType: String(parsed.documentType || "").slice(0, 80), facts: parsed.facts && typeof parsed.facts === "object" ? parsed.facts : {}, records: parsed.records && typeof parsed.records === "object" ? parsed.records : {}, skills: Array.isArray(parsed.skills) ? parsed.skills.slice(0, 60) : [] }).slice(0, 60_000) };
    } catch (err) {
      console.warn("[fill] could not read", d.id, (err as Error)?.message);
    }
    // Re-read the row: another write may have landed since the list was read (Rule 6).
    const fresh = await storage.getDocumentMeta(d.id).catch(() => undefined) as any;
    const extractedData = { ...((fresh || d).extractedData || {}), fillIndex: { indexedAt: new Date().toISOString(), ...payload } };
    await storage.updateDocument(d.id, { extractedData } as any);
    return { ok: !payload.failed, name: d.name as string };
  }));
  return {
    indexed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    remaining: Math.max(0, pending.length - batch.length),
    names: results.filter((r) => r.ok).map((r) => r.name),
  };
}

// ── analysing a form ─────────────────────────────────────────────────────────

export interface AnalyzeInput {
  fileName: string;
  mimeType: string;
  /** base64 (a data: prefix is fine). */
  fileData: string;
  /** The PDF's text layer, read by the browser's PDF reader (flat PDFs). */
  textPages?: TextPage[];
  forProfileId?: string | null;
}

export interface AnalyzeResult {
  format: "pdf" | "docx";
  documentType: string;
  pages: FillPageSize[];
  fields: FillField[];
  /** How the fields were found. */
  detection: "acroform" | "text" | "vision" | "docx" | "none";
  /** A photo is turned into a PDF page; the workspace draws and saves THIS file. */
  workingFile?: { mimeType: string; base64: string; name: string };
  aiUsed: boolean;
  aiNote?: string;
  information: FillInformation;
  /** Paragraphs of a Word form, for its list editor. */
  paragraphs?: string[];
}

function proposeStructured(fields: FillField[], facts: FillFact[], subjectId: string | null): void {
  for (const f of fields) {
    if (f.value || f.kind === "signature" || f.kind === "checkbox" || f.kind === "radio") continue;
    const match = matchLabelToFacts(f.label, facts, subjectId);
    if (!match) continue;
    if (f.kind === "choice" && f.options && !f.options.some((o) => o.toLowerCase() === match.fact.value.toLowerCase())) continue;
    applyFact(f, match.fact, f.kind === "date" ? formatFormDate(match.fact.value) : match.fact.value, "structured");
    f.alternatives = match.alternatives.map((a) => ({ value: a.sensitive ? maskValue(a.value) : a.value, source: a.source.name, ...(a.sensitive ? { sensitive: true } : {}) }))
      .filter((a) => !a.sensitive);
    if (f.alternatives.length === 0) delete f.alternatives;
  }
}

function applyFact(f: FillField, fact: FillFact, value: string, by: "structured" | "ai"): void {
  f.value = value;
  f.factId = fact.id;
  f.source = fact.source.name;
  f.sourceId = fact.source.id;
  f.filledBy = by;
  if (fact.sensitive) { f.sensitive = true; f.confirmed = false; }
}

const MATCH_RULES = `RULES
- Use ONLY the FACTS. Never invent, guess or complete a value. A field with no matching fact is left out of "answers".
- "value" is the text to write. To use a fact whole, write its id in braces: "{f12}". You may join facts with spaces or punctuation ("{f3} {f5}", "{f7}, {f8}, {f9} {f10}") or write part of a fact's value (the city out of an address). Facts shown as "[on file]" are private: use them ONLY as "{id}".
- "facts": the ids of every fact the value was taken from.
- Understand what a label means, not just its words: "Tag number" is a licence plate, "Surname" a last name, "Present employer" the most recent job.
- A checkbox answer is "yes" or "no", and only when a fact settles it. A choice field's value must be one of its options.
- Never answer a signature field.
- Facts about a named thing or person ("Honda CR-V — VIN", "Jane Lee (spouse) — phone") answer a field only when the field asks about that thing or person.
- Rows that share a group ("employment:1") describe one job or one school: keep a row's fields together and in the order the form lists them (first = most recent).`;

function factsForModel(facts: FillFact[]): string {
  return facts.slice(0, 500).map((f) =>
    `${f.id} | ${f.category} | ${f.label}${f.group ? ` | group ${f.group.split(":").slice(-2).join(":")}` : ""} | ${f.sensitive ? "[on file]" : f.value.replace(/\s+/g, " ").slice(0, 200)} | from ${f.source.name}`).join("\n");
}

/** Turn the model's answers into field values — keeping only what the facts support. */
function applyAnswers(fields: FillField[], answers: any[], facts: FillFact[]): number {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  let applied = 0;
  for (const a of Array.isArray(answers) ? answers : []) {
    const f = fieldById.get(String(a?.id ?? ""));
    if (!f || f.value || f.kind === "signature") continue;
    let value = String(a?.value ?? "").trim();
    if (!value) continue;
    const cited: FillFact[] = [];
    const cite = (id: string) => { const fact = byId.get(id); if (fact && !cited.includes(fact)) cited.push(fact); return fact; };
    for (const id of Array.isArray(a?.facts) ? a.facts : []) cite(String(id));
    let bad = false;
    value = value.replace(/\{(f\d+)\}/g, (_m, id) => { const fact = cite(id); if (!fact) { bad = true; return ""; } return fact.value; });
    if (bad || !value.trim() || cited.length === 0) continue;
    if (/\[on file\]/i.test(value)) continue;
    if (f.kind === "checkbox") {
      if (!/^(yes|no|true|false|x)$/i.test(value)) continue;
      value = /^(yes|true|x)$/i.test(value) ? "yes" : "";
      if (!value) continue;
    } else if (!groundValue(value, cited)) continue; // not something the facts say
    if ((f.kind === "choice" || f.kind === "radio") && f.options && !f.options.some((o) => o.toLowerCase().replace(/[^a-z0-9]/g, "") === value.toLowerCase().replace(/[^a-z0-9]/g, ""))) continue;
    applyFact(f, cited[0], f.kind === "date" ? formatFormDate(value) : value, "ai");
    if (cited.some((c) => c.sensitive)) { f.sensitive = true; f.confirmed = false; }
    if (cited.length > 1) f.source = [...new Set(cited.map((c) => c.source.name))].slice(0, 2).join(" + ");
    applied++;
  }
  return applied;
}

async function matchWithModel(fileName: string, fields: FillField[], facts: FillFact[]): Promise<number> {
  const open = fields.filter((f) => !f.value && f.kind !== "signature");
  if (open.length === 0 || facts.length === 0) return 0;
  const list = open.slice(0, 250).map((f) => `${f.id} | ${f.kind}${f.options?.length ? ` (options: ${f.options.slice(0, 20).join(" / ")})` : ""} | ${f.label}`).join("\n");
  const prompt = `You are filling in the form "${fileName}" for a person, using only what they have on file.

FIELDS STILL EMPTY (id | kind | label):
${list}

FACTS (id | category | label | value | source):
${factsForModel(facts)}

${MATCH_RULES}

Return ONLY JSON: { "documentType": "<what this form is>", "answers": [ { "id": "<field id>", "value": "<text or {id} template>", "facts": ["<fact id>"] } ] }`;
  const parsed = parseJson(await askModel({ prompt, maxTokens: 6000 }));
  return applyAnswers(fields, parsed?.answers, facts);
}

const KINDS: FillFieldKind[] = ["text", "multiline", "date", "number", "checkbox", "signature"];

/** A scan or a photo: the model finds the blanks (with where they are) and answers them from the facts. */
async function detectWithVision(fileName: string, file: { mimeType: string; base64: string }, pages: FillPageSize[], facts: FillFact[]): Promise<{ fields: FillField[]; documentType: string }> {
  const prompt = `This is a form ("${fileName}", ${pages.length} page${pages.length === 1 ? "" : "s"}). Find every place a person is meant to write or tick, and answer it from the FACTS when they have it.

For each one give:
- "label": the printed label it belongs to
- "kind": text | multiline | date | number | checkbox | signature
- "page": 1-based page number
- "box": [left, top, right, bottom] of the EMPTY AREA to write in, as thousandths of the page width and height (0-1000, top-left origin). The box is the blank itself (the line or empty cell), not the label.
- "value" and "facts" as described below (leave both out when nothing on file answers it)

FACTS (id | category | label | value | source):
${factsForModel(facts)}

${MATCH_RULES}

Return ONLY JSON: { "documentType": "<what this form is>", "fields": [ { "label": "", "kind": "text", "page": 1, "box": [0,0,0,0], "value": "", "facts": [] } ] }`;
  const parsed = parseJson(await askModel({ prompt, file, maxTokens: 8000 }));
  const raw: any[] = Array.isArray(parsed?.fields) ? parsed.fields.slice(0, 250) : [];
  const fields: FillField[] = [];
  const answers: any[] = [];
  raw.forEach((r, i) => {
    const b = Array.isArray(r?.box) ? r.box.map(Number) : [];
    if (b.length !== 4 || b.some((n: number) => !Number.isFinite(n))) return;
    const page = Math.max(0, Math.min(pages.length - 1, (Number(r.page) || 1) - 1));
    const label = String(r.label || "").trim().slice(0, 200);
    const kind: FillFieldKind = KINDS.includes(r.kind) ? r.kind : kindForLabel(label);
    const id = `v${i + 1}`;
    fields.push({
      id, label: label || "Field", kind, page, origin: "vision", value: "",
      box: clampBox({ x: Math.min(b[0], b[2]) / 1000, y: Math.min(b[1], b[3]) / 1000, w: Math.abs(b[2] - b[0]) / 1000, h: Math.max(Math.abs(b[3] - b[1]) / 1000, 0.012) }),
    });
    if (r.value) answers.push({ id, value: r.value, facts: r.facts });
  });
  applyAnswers(fields, answers, facts);
  return { fields, documentType: String(parsed?.documentType || "").slice(0, 80) };
}

function checkSize(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new FillError(400, "The file is empty.");
  if (bytes.length > FILL_MAX_BYTES) throw new FillError(413, "This file is larger than 10 MB. Fill In takes files up to 10 MB.");
}

export async function analyzeForm(input: AnalyzeInput): Promise<AnalyzeResult> {
  const fileName = String(input.fileName || "form").slice(0, 200);
  const mime = String(input.mimeType || "").toLowerCase();
  let bytes = bytesFromBase64(input.fileData);
  checkSize(bytes);
  const information = await getFillInformation(input.forProfileId);
  const { facts } = information;
  const subjectId = information.subject.id;
  let aiUsed = false;
  let aiNote: string | undefined;
  const useModel = async (run: () => Promise<unknown>) => {
    if (!modelReady()) { aiNote = "AI is not available right now, so only fields whose label plainly names something on file were filled."; return; }
    try { await run(); aiUsed = true; }
    catch (err) {
      console.warn("[fill] model step failed:", (err as Error)?.message);
      aiNote = "The AI step did not finish, so only fields whose label plainly names something on file were filled. Use Auto-fill to try again.";
    }
  };

  // ── Word ──
  if (mime === DOCX_MIME || /\.docx$/i.test(fileName)) {
    const { fields, paragraphs } = await readDocxForm(bytes);
    proposeStructured(fields, facts, subjectId);
    await useModel(() => matchWithModel(fileName, fields, facts));
    return { format: "docx", documentType: "Word form", pages: [], fields, detection: fields.length ? "docx" : "none", aiUsed, aiNote, information, paragraphs };
  }
  if (mime === "application/msword" || /\.doc$/i.test(fileName)) throw new FillError(415, "Older Word files (.doc) cannot be filled. Save the form as .docx or PDF and try again.");

  // ── a photo becomes a page ──
  let workingFile: AnalyzeResult["workingFile"];
  let visionFile: { mimeType: string; base64: string } | null = null;
  if (IMAGE.test(mime) || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(fileName)) {
    const converted = await imageToPdf(bytes);
    bytes = converted.bytes;
    workingFile = { mimeType: "application/pdf", base64: Buffer.from(bytes).toString("base64"), name: `${fileName.replace(/\.[^.]+$/, "")}.pdf` };
    visionFile = { mimeType: "image/jpeg", base64: Buffer.from(converted.jpeg).toString("base64") };
  } else if (mime !== "application/pdf" && !/\.pdf$/i.test(fileName)) {
    throw new FillError(415, "Fill In takes PDF forms, Word (.docx) forms, and photos or screenshots of a form.");
  }

  // ── PDF ──
  const form = await readPdfForm(bytes);
  let fields = form.fields;
  let detection: AnalyzeResult["detection"] = fields.length ? "acroform" : "none";
  let documentType = "";
  if (fields.length === 0 && !visionFile && Array.isArray(input.textPages)) {
    fields = detectTextFields(sanitizeTextPages(input.textPages, form.pages));
    if (fields.length >= 2) detection = "text"; else fields = [];
  }
  if (fields.length > 0) {
    proposeStructured(fields, facts, subjectId);
    await useModel(() => matchWithModel(fileName, fields, facts));
  } else {
    // Nothing found from the file itself: a scan, a photo, or a form with no text layer.
    await useModel(async () => {
      const found = await detectWithVision(fileName, visionFile || { mimeType: "application/pdf", base64: Buffer.from(bytes).toString("base64") }, form.pages, facts);
      fields = found.fields;
      documentType = found.documentType;
      if (fields.length) detection = "vision";
    });
    proposeStructured(fields, facts, subjectId);
  }
  return { format: "pdf", documentType: documentType || "PDF form", pages: form.pages, fields, detection, workingFile, aiUsed, aiNote, information };
}

function sanitizeTextPages(raw: TextPage[], sizes: FillPageSize[]): TextPage[] {
  return raw.slice(0, sizes.length || 60).map((p, i) => ({
    width: Number(p?.width) > 0 ? Number(p.width) : sizes[i]?.width || 612,
    height: Number(p?.height) > 0 ? Number(p.height) : sizes[i]?.height || 792,
    items: (Array.isArray(p?.items) ? p.items : []).slice(0, 6000)
      .map((it: any) => ({ str: String(it?.str ?? "").slice(0, 400), x: Number(it?.x) || 0, y: Number(it?.y) || 0, w: Number(it?.w) || 0, h: Number(it?.h) || 0 }))
      .filter((it) => it.str.trim() !== ""),
  }));
}

/** Fill the empty fields again from what is on file (the workspace's "Auto-fill"). */
export async function refillFields(input: { fileName: string; fields: unknown; forProfileId?: string | null }): Promise<{ fields: FillField[]; aiUsed: boolean; aiNote?: string }> {
  const fields = sanitizeFields(input.fields);
  const information = await getFillInformation(input.forProfileId);
  proposeStructured(fields, information.facts, information.subject.id);
  let aiUsed = false; let aiNote: string | undefined;
  if (modelReady()) {
    try { await matchWithModel(String(input.fileName || "form"), fields, information.facts); aiUsed = true; }
    catch { aiNote = "The AI step did not finish. Fields whose label plainly names something on file were filled."; }
  } else aiNote = "AI is not available right now. Fields whose label plainly names something on file were filled.";
  return { fields, aiUsed, aiNote };
}

// ── saving, and proving it ───────────────────────────────────────────────────

export interface SaveInput {
  fileName: string;
  mimeType: string;
  /** The form being filled (for a photo: the working PDF the analysis returned). */
  fileData?: string;
  /** Or: the stored original of a session being edited again. */
  originalDocumentId?: string;
  fields: unknown;
  forProfileId?: string | null;
  /** The completed document this save replaces (editing a saved form). */
  replacesDocumentId?: string;
}

export interface SaveResult {
  documentId: string;
  name: string;
  mimeType: string;
  originalDocumentId: string;
  verification: FillVerification;
  notes: string[];
}

const hashTag = (base64: string) => `sha256:${createHash("sha256").update(base64).digest("hex").slice(0, 32)}`;

async function render(format: "pdf" | "docx", original: Uint8Array, fields: FillField[]) {
  return format === "docx" ? renderFilledDocx(original, fields) : renderFilledPdf(original, fields);
}
async function verify(format: "pdf" | "docx", bytes: Uint8Array, fields: FillField[]) {
  return format === "docx" ? verifyFilledDocx(bytes, fields) : verifyFilledPdf(bytes, fields);
}

/**
 * Write the completed file and save it as a NEW document beside the original.
 * Order matters: render → reopen and check the bytes → store → read the stored
 * file back and check THAT. Any check that fails is an error with the fields
 * named, and nothing is left saved.
 */
export async function saveFilledForm(input: SaveInput): Promise<SaveResult> {
  const fields = sanitizeFields(input.fields);
  if (fields.length === 0) throw new FillError(400, "There are no fields to save.");
  const fileName = String(input.fileName || "form").slice(0, 200);
  let originalBytes: Uint8Array;
  let originalId = "";
  let mime = String(input.mimeType || "").toLowerCase();
  if (input.originalDocumentId) {
    const file = await (storage as any).getDocumentFile(String(input.originalDocumentId));
    if (!file?.buffer?.length) throw new FillError(404, "The original form could not be found. Upload it again to fill it.");
    originalBytes = new Uint8Array(file.buffer);
    originalId = String(input.originalDocumentId);
    mime = String(file.mimeType || mime).toLowerCase();
  } else {
    if (!input.fileData) throw new FillError(400, "The form file is missing.");
    originalBytes = bytesFromBase64(input.fileData);
  }
  checkSize(originalBytes);
  const format: "pdf" | "docx" = mime === DOCX_MIME || /\.docx$/i.test(fileName) ? "docx" : "pdf";
  const wanted = fields.filter(isWritable).length;
  if (wanted === 0) throw new FillError(400, "Nothing has been filled in yet. Add a value to at least one field, then save.");

  // 1. Write, then reopen what was written.
  const out = await render(format, originalBytes, fields);
  const check = await verify(format, out.bytes, fields);
  if (!check.ok) {
    throw new FillError(422, `The completed file was not saved: ${check.missing.length} of ${check.expected} value${check.expected === 1 ? "" : "s"} did not make it into the file (${check.missing.slice(0, 4).map((m) => m.label).join(", ")}${check.missing.length > 4 ? ", …" : ""}).`, );
  }

  // 2. Keep the original (once — the same bytes are one document).
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const outMime = format === "docx" ? DOCX_MIME : "application/pdf";
  const linked = input.forProfileId ? [String(input.forProfileId)] : [];
  if (!originalId) {
    const base64 = Buffer.from(originalBytes).toString("base64");
    const tag = hashTag(base64);
    const existing = ((await storage.getDocuments()) as any[]).find((d) => !d.deletedAt && Array.isArray(d.tags) && d.tags.includes(tag));
    if (existing) originalId = existing.id;
    else {
      const created = await storage.createDocument({ name: `${baseName} (blank form)`, type: "saved", mimeType: outMime, fileData: base64, linkedProfiles: [], tags: ["saved-only", FILL_ORIGINAL_TAG, tag] } as any);
      originalId = created.id;
    }
  }

  // 3. Store the completed copy, then read the STORED file back and check it.
  const completedBase64 = Buffer.from(out.bytes).toString("base64");
  const doc = await storage.createDocument({
    name: `${baseName} — Completed`,
    type: "smart_fill",
    mimeType: outMime,
    fileData: completedBase64,
    extractedData: {
      smartFill: {
        version: 2, format, originalDocumentId: originalId, originalName: fileName, savedAt: new Date().toISOString(),
        forProfileId: input.forProfileId || null, filled: check.found, session: serializeFields(fields),
      },
    },
    linkedProfiles: linked,
    tags: ["smart-fill"],
  } as any);
  let stored: FillVerification;
  try {
    const back = await (storage as any).getDocumentFile(doc.id);
    stored = back?.buffer?.length ? await verify(format, new Uint8Array(back.buffer), fields)
      : { expected: check.expected, found: 0, ok: false, missing: [{ id: "", label: "the file", reason: "the saved file came back empty" }] };
  } catch {
    stored = { expected: check.expected, found: 0, ok: false, missing: [{ id: "", label: "the file", reason: "the saved file could not be read back" }] };
  }
  if (!stored.ok) {
    await storage.deleteDocument(doc.id).catch(() => undefined);
    throw new FillError(500, "The completed file was written but did not read back correctly from storage, so it was not kept. Nothing was saved. Try Save again.");
  }
  // 4. An edit of a saved form replaces that copy (it goes to Trash) only now that the new one is proven.
  if (input.replacesDocumentId && input.replacesDocumentId !== doc.id) {
    const old = await storage.getDocumentMeta(String(input.replacesDocumentId)).catch(() => undefined) as any;
    if (old && (old.type === "smart_fill" || (old.tags || []).includes("smart-fill"))) await storage.deleteDocument(old.id).catch(() => undefined);
  }
  return { documentId: doc.id, name: doc.name, mimeType: outMime, originalDocumentId: originalId, verification: stored, notes: out.notes };
}

// ── reopening a completed form ───────────────────────────────────────────────

export interface FillSession {
  completedDocumentId: string;
  originalDocumentId: string;
  name: string;
  format: "pdf" | "docx";
  mimeType: string;
  /** The ORIGINAL (blank) form: fields are written onto it again on the next save. */
  originalBase64: string;
  pages: FillPageSize[];
  fields: FillField[];
  forProfileId: string | null;
  paragraphs?: string[];
}

export async function loadFillSession(documentId: string): Promise<FillSession> {
  const doc = await storage.getDocumentMeta(documentId) as any;
  const sf = doc?.extractedData?.smartFill;
  if (!doc || !sf || sf.version !== 2 || !sf.originalDocumentId) throw new FillError(404, "This document was not filled with Fill In, or was filled by an older version that cannot be edited. Upload the form again to fill it.");
  const original = await (storage as any).getDocumentFile(String(sf.originalDocumentId));
  if (!original?.buffer?.length) throw new FillError(404, "The original form this was filled from is no longer in Documents, so it cannot be edited. The completed file itself is unchanged.");
  const bytes = new Uint8Array(original.buffer);
  const format: "pdf" | "docx" = sf.format === "docx" ? "docx" : "pdf";
  const fields = sanitizeFields(sf.session);
  return {
    completedDocumentId: doc.id, originalDocumentId: String(sf.originalDocumentId),
    name: String(sf.originalName || doc.name), format,
    mimeType: format === "docx" ? DOCX_MIME : "application/pdf",
    originalBase64: Buffer.from(bytes).toString("base64"),
    pages: format === "pdf" ? await pdfPageSizes(bytes) : [],
    fields, forProfileId: sf.forProfileId || null,
    ...(format === "docx" ? { paragraphs: (await readDocxForm(bytes)).paragraphs } : {}),
  };
}

/** Completed forms, newest first (the workspace's "Continue a form"). */
export async function listFilledForms(): Promise<Array<{ id: string; name: string; savedAt: string; filled: number; editable: boolean }>> {
  const documents = (await storage.getDocuments()) as any[];
  return documents
    .filter((d) => !d.deletedAt && (d.type === "smart_fill" || (d.tags || []).includes("smart-fill")))
    .map((d) => ({ id: d.id, name: d.name, savedAt: String(d.extractedData?.smartFill?.savedAt || d.extractedData?.smartFill?.filledAt || d.createdAt || ""), filled: Number(d.extractedData?.smartFill?.filled) || 0, editable: d.extractedData?.smartFill?.version === 2 }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    .slice(0, 30);
}
