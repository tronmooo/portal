// Fill In, end to end over the real routes (owner request 2026-11-23: "Do not
// report a successful fill operation unless the saved document contains the
// expected information"). Each test uploads a real PDF / Word file, and reads
// the SAVED document back out of storage with an independent reader.
//
// The model is a stub here (the live check uses the real one); what is tested
// is everything around it: what it is shown, what it is allowed to put on a
// form, and that a save is proven before it is reported.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { PDFDocument, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { setFillModelForTests } from "../server/fill-service";
import { makeFakeStorage, type FakeDb } from "./helpers/route-harness";
import type { TextPage } from "../shared/fill-fields";

let server: Server | null = null;
let seq = 0;
let modelCalls: Array<{ prompt: string; file?: { mimeType: string } }> = [];

async function boot(seed: { profiles?: any[]; documents?: any[] } = {}) {
  const db: FakeDb = {
    profiles: seed.profiles ?? [{ id: "self-1", type: "self", name: "Jordan A. Lee", fields: { phone: "(555) 010-2299" } }],
    liabilityPayments: [], expenses: [], incomes: [], obligations: [], tasks: [], events: [],
    documents: seed.documents ?? [], trackers: [], getDocumentCalls: 0, bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [],
  };
  const storage: any = makeFakeStorage(db);
  storage.getArtifacts = async () => [];
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  const userId = `fill-user-${++seq}`;
  app.use((req, _res, next) => { (req as any).userId = userId; requestStorageContext.run(storage, () => next()); });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { api, db };
}
beforeEach(() => { modelCalls = []; setFillModelForTests(async (input) => { modelCalls.push(input); return "{}"; }); });
afterEach(async () => { setFillModelForTests(null); if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function pdfjsRead(bytes: Uint8Array) {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
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

async function flatForm(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((s, i) => page.drawText(s, { x: 50, y: 720 - i * 28, size: 11, font }));
  return doc.save();
}
async function jobApplication(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  ["Full Name", "Phone", "Employer", "Job Title", "Previous Employer", "School", "Social Security Number", "Emergency Phone"].forEach((name, i) =>
    form.createTextField(name).addToPage(page, { x: 200, y: 700 - i * 30, width: 300, height: 18 }));
  form.createCheckBox("Forklift Certified").addToPage(page, { x: 200, y: 440, width: 14, height: 14 });
  return doc.save();
}
const savedBytes = (db: FakeDb, id: string) => new Uint8Array(Buffer.from(String((db.documents.find((d: any) => d.id === id) as any).fileData), "base64"));
const fieldBy = (fields: any[], label: RegExp) => fields.find((f) => label.test(f.label));

const LICENCE = {
  id: "d-lic", name: "Driver's License.jpg", type: "drivers_license", mimeType: "image/jpeg", createdAt: "2026-03-01T00:00:00Z", linkedProfiles: [], tags: [],
  extractedData: { fullName: "Jordan A. Lee", address: "123 Main St, Springfield, IL 62704", dateOfBirth: "1990-03-04" },
};

describe("scenario: a driver's licence on file fills the address of a separate form", () => {
  it("finds the form's blanks, fills the address from the licence with its source, saves a real file, and the saved file holds it", async () => {
    const { api, db } = await boot({ documents: [{ ...LICENCE }] });
    const form = await flatForm(["CHANGE OF ADDRESS", "Full name: ______________________________", "Address: ________________________________________________", "City: ______________  State: ____  ZIP: ________", "Date of birth: ____________"]);
    const { pages } = await pdfjsRead(form);
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "change-of-address.pdf", mimeType: "application/pdf", fileData: b64(form), textPages: pages });
    expect(a.status).toBe(200);
    expect(a.data.detection).toBe("text");
    expect(fieldBy(a.data.fields, /^Address$/)).toMatchObject({ value: "123 Main St, Springfield, IL 62704", source: "Driver's License", sourceId: "d-lic", filledBy: "structured" });
    expect(fieldBy(a.data.fields, /^City$/).value).toBe("Springfield");
    expect(fieldBy(a.data.fields, /^ZIP$/).value).toBe("62704");
    expect(fieldBy(a.data.fields, /^Date of birth$/).value).toBe("03/04/1990");
    // Analysing wrote nothing.
    expect(db.documents).toHaveLength(1);

    const s = await api("POST", "/api/smart-fill/save", { fileName: "change-of-address.pdf", mimeType: "application/pdf", fileData: b64(form), fields: a.data.fields });
    expect(s.status).toBe(200);
    expect(s.data.verification).toMatchObject({ ok: true, expected: 6, found: 6 });
    // The original is kept as its own document; the completed copy is a second one.
    expect(db.documents.map((d: any) => d.name).sort()).toEqual(["Driver's License.jpg", "change-of-address (blank form)", "change-of-address — Completed"]);
    const page = (await pdfjsRead(savedBytes(db, s.data.documentId))).text;
    expect(page).toHaveLength(1);
    expect(page[0]).toContain("123 Main St, Springfield, IL 62704");
    expect(page[0]).toContain("Jordan A. Lee");
    // …and the kept original is still blank.
    expect((await pdfjsRead(savedBytes(db, s.data.originalDocumentId))).text[0]).not.toContain("123 Main St");
  });
});

describe("scenario: an older upload that was never read, a résumé, fills a job application", () => {
  const RESUME_JSON = JSON.stringify({
    documentType: "Résumé", facts: { "Full name": "Jordan A. Lee" },
    records: { employment: [{ employer: "Northwind Traders", jobTitle: "Warehouse Lead" }, { employer: "Contoso Freight", jobTitle: "Picker" }], education: [{ school: "Springfield Community College", degree: "A.S. Logistics" }] },
    skills: ["Forklift certified"],
  });
  it("the résumé is read once, then its jobs and school fill the form; an invented value is refused; the SSN never reaches the model", async () => {
    const { api, db } = await boot({
      profiles: [{ id: "self-1", type: "self", name: "Jordan A. Lee", fields: { phone: "(555) 010-2299", ssn: "123-45-6789" } }],
      documents: [{ id: "d-cv", name: "Resume 2024.pdf", type: "saved", mimeType: "application/pdf", fileData: b64(await flatForm(["Jordan A. Lee — Résumé"])), createdAt: "2024-02-01T00:00:00Z", extractedData: {}, linkedProfiles: [], tags: ["saved-only"] }],
    });
    // Nothing on file about work yet.
    const before = await api("GET", "/api/smart-fill/information");
    expect(before.data.unindexed).toBe(1);
    expect(before.data.facts.some((f: any) => f.key === "employer")).toBe(false);

    setFillModelForTests(async (input) => { modelCalls.push(input); return RESUME_JSON; });
    const idx = await api("POST", "/api/smart-fill/index", { max: 2 });
    expect(idx.data).toMatchObject({ indexed: 1, failed: 0, remaining: 0 });
    expect(modelCalls[0].file).toMatchObject({ mimeType: "application/pdf" });
    // Read once: a second pass has nothing to do and asks the model nothing.
    const again = await api("POST", "/api/smart-fill/index", { max: 2 });
    expect(again.data).toMatchObject({ indexed: 0, remaining: 0 });
    expect(modelCalls).toHaveLength(1);
    // The reading is stored as one string: no new extracted fields for other screens to list or alert on.
    const cv: any = db.documents.find((d: any) => d.id === "d-cv");
    expect(Object.keys(cv.extractedData)).toEqual(["fillIndex"]);
    expect(typeof cv.extractedData.fillIndex.data).toBe("string");

    const form = await jobApplication();
    let facts: any[] = [];
    setFillModelForTests(async (input) => {
      modelCalls.push(input);
      const id = (label: string) => /(f\d+) \| [^|]+ \| /.exec(input.prompt.split("\n").find((l) => l.includes(`| ${label} |`)) || "")?.[1];
      facts = [id("Employer (2)"), id("Phone")];
      return JSON.stringify({ documentType: "Job application", answers: [
        { id: "a5", value: `{${id("Employer (2)")}}`, facts: [id("Employer (2)")] },      // previous employer: on file
        { id: "a8", value: "(555) 867-5309", facts: [id("Phone")] },                      // emergency phone: INVENTED
        { id: "a9", value: "yes", facts: [id("Skills")] },                                // forklift box: a fact settles it
      ] });
    });
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "job-application.pdf", mimeType: "application/pdf", fileData: b64(form) });
    expect(a.status).toBe(200);
    expect(a.data).toMatchObject({ detection: "acroform", aiUsed: true });
    const f = a.data.fields;
    expect(fieldBy(f, /^Employer$/)).toMatchObject({ value: "Northwind Traders", source: "Resume 2024", filledBy: "structured" });
    expect(fieldBy(f, /^Job Title$/).value).toBe("Warehouse Lead");
    expect(fieldBy(f, /^School$/).value).toBe("Springfield Community College");
    expect(fieldBy(f, /^Previous Employer$/)).toMatchObject({ value: "Contoso Freight", filledBy: "ai", source: "Resume 2024" });
    expect(fieldBy(f, /^Emergency Phone$/).value).toBe(""); // the model's made-up number was not accepted
    expect(fieldBy(f, /Forklift/).value).toBe("yes");
    expect(facts.every(Boolean)).toBe(true);
    // The SSN is proposed (from the profile) but waits for the user, and the model was never shown it.
    expect(fieldBy(f, /Social Security/)).toMatchObject({ value: "123-45-6789", sensitive: true, confirmed: false });
    const matchPrompt = modelCalls[modelCalls.length - 1].prompt;
    expect(matchPrompt).not.toContain("123-45-6789");
    expect(matchPrompt).toContain("[on file]");

    // Saved without confirming: the SSN is not in the file. Confirmed: it is.
    const s1 = await api("POST", "/api/smart-fill/save", { fileName: "job-application.pdf", mimeType: "application/pdf", fileData: b64(form), fields: f });
    expect(s1.status).toBe(200);
    const read1 = await pdfjsRead(savedBytes(db, s1.data.documentId));
    expect(read1.fields).toMatchObject({ "Full Name": "Jordan A. Lee", Employer: "Northwind Traders", "Previous Employer": "Contoso Freight", School: "Springfield Community College", "Forklift Certified": "Yes" });
    expect(read1.fields["Social Security Number"]).toBeFalsy();
    expect(JSON.stringify((db.documents.find((d: any) => d.id === s1.data.documentId) as any).extractedData)).not.toContain("123-45-6789");
    const confirmed = f.map((x: any) => (x.sensitive ? { ...x, confirmed: true } : x));
    const s2 = await api("POST", "/api/smart-fill/save", { fileName: "job-application.pdf", mimeType: "application/pdf", fileData: b64(form), fields: confirmed, replacesDocumentId: s1.data.documentId });
    expect((await pdfjsRead(savedBytes(db, s2.data.documentId))).fields["Social Security Number"]).toBe("123-45-6789");
    // The edit replaced the first completed copy; the blank original is one document, not two.
    expect(db.documents.filter((d: any) => d.type === "smart_fill")).toHaveLength(1);
    expect(db.documents.filter((d: any) => (d.tags || []).includes("fill-original"))).toHaveLength(1);
  });

  it("with no model at all, the labels that plainly name something on file are still filled, and the answer says AI was not used", async () => {
    const { api } = await boot({ documents: [{ ...LICENCE }] });
    setFillModelForTests(async () => { throw new Error("model down"); });
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "job-application.pdf", mimeType: "application/pdf", fileData: b64(await jobApplication()) });
    expect(a.status).toBe(200);
    expect(a.data.aiUsed).toBe(false);
    expect(a.data.aiNote).toMatch(/AI step did not finish/);
    expect(fieldBy(a.data.fields, /^Full Name$/).value).toBe("Jordan A. Lee");
    expect(fieldBy(a.data.fields, /^Employer$/).value).toBe("");
  });
});

describe("a save is proven or it is an error", () => {
  it("a value that cannot be written is a 422 naming the field, and nothing is saved", async () => {
    const { api, db } = await boot();
    const form = await jobApplication();
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "app.pdf", mimeType: "application/pdf", fileData: b64(form) });
    const fields = [...a.data.fields, { id: "ghost", label: "Ghost field", kind: "text", page: 0, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 }, origin: "acroform", acroName: "no.such.field", value: "boo" }];
    const s = await api("POST", "/api/smart-fill/save", { fileName: "app.pdf", mimeType: "application/pdf", fileData: b64(form), fields });
    expect(s.status).toBe(422);
    expect(s.data.error).toMatch(/was not saved: 1 of \d+ values? did not make it into the file \(Ghost field\)/);
    expect(db.documents).toHaveLength(0);
  });

  it("a stored file that does not read back is an error and is not kept", async () => {
    const { api, db } = await boot();
    const form = await jobApplication();
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "app.pdf", mimeType: "application/pdf", fileData: b64(form) });
    // Storage that silently keeps the BLANK form instead of the completed one.
    const realCreate = (db as any).__create;
    void realCreate;
    const docs = db.documents as any[];
    const push = docs.push.bind(docs);
    docs.push = (...rows: any[]) => push(...rows.map((r) => (r.type === "smart_fill" ? { ...r, fileData: b64(form) } : r)));
    const s = await api("POST", "/api/smart-fill/save", { fileName: "app.pdf", mimeType: "application/pdf", fileData: b64(form), fields: a.data.fields });
    expect(s.status).toBe(500);
    expect(s.data.error).toMatch(/did not read back correctly from storage/);
    expect(db.documents.some((d: any) => d.type === "smart_fill")).toBe(false);
  });

  it("nothing filled in is not a save", async () => {
    const { api } = await boot({ profiles: [{ id: "self-1", type: "self", name: "", fields: {} }] });
    const form = await flatForm(["Favourite colour: ____________", "Shoe size: ________"]);
    const { pages } = await pdfjsRead(form);
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "quiz.pdf", mimeType: "application/pdf", fileData: b64(form), textPages: pages });
    expect(a.data.fields.map((f: any) => f.value)).toEqual(["", ""]); // nothing on file: left blank, never guessed
    const s = await api("POST", "/api/smart-fill/save", { fileName: "quiz.pdf", mimeType: "application/pdf", fileData: b64(form), fields: a.data.fields });
    expect(s.status).toBe(400);
    expect(s.data.error).toMatch(/Nothing has been filled in yet/);
  });

  it("files Fill In cannot fill say so plainly", async () => {
    const { api } = await boot();
    expect((await api("POST", "/api/smart-fill/analyze", { fileName: "old.doc", mimeType: "application/msword", fileData: b64(new Uint8Array([1, 2, 3])) })).data.error).toMatch(/\.doc\) cannot be filled/);
    expect((await api("POST", "/api/smart-fill/analyze", { fileName: "x.pdf", mimeType: "application/pdf", fileData: b64(new Uint8Array([1, 2, 3])) })).status).toBe(422);
    expect((await api("POST", "/api/smart-fill/analyze", { fileName: "x.zip", mimeType: "application/zip", fileData: b64(new Uint8Array([1, 2, 3])) })).status).toBe(415);
  });
});

describe("a completed form can be reopened and edited", () => {
  it("the session comes back with its fields over the ORIGINAL form, and saving the edit holds the new value", async () => {
    const { api, db } = await boot();
    const form = await jobApplication();
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "app.pdf", mimeType: "application/pdf", fileData: b64(form) });
    const s = await api("POST", "/api/smart-fill/save", { fileName: "app.pdf", mimeType: "application/pdf", fileData: b64(form), fields: a.data.fields });
    const forms = await api("GET", "/api/smart-fill/forms");
    expect(forms.data).toMatchObject([{ id: s.data.documentId, name: "app — Completed", editable: true }]);
    const session = await api("GET", `/api/smart-fill/session/${s.data.documentId}`);
    expect(session.status).toBe(200);
    expect(fieldBy(session.data.fields, /^Full Name$/).value).toBe("Jordan A. Lee");
    expect((await pdfjsRead(new Uint8Array(Buffer.from(session.data.originalBase64, "base64")))).fields["Full Name"]).toBeFalsy();
    const edited = session.data.fields.map((f: any) => (/^Employer$/.test(f.label) ? { ...f, value: "Tailspin Toys" } : f));
    const s2 = await api("POST", "/api/smart-fill/save", { fileName: "app.pdf", mimeType: "application/pdf", originalDocumentId: session.data.originalDocumentId, fields: edited, replacesDocumentId: s.data.documentId });
    expect(s2.status).toBe(200);
    expect((await pdfjsRead(savedBytes(db, s2.data.documentId))).fields).toMatchObject({ "Full Name": "Jordan A. Lee", Employer: "Tailspin Toys" });
    expect((await api("GET", "/api/smart-fill/session/nope")).status).toBe(404);
  });
});

describe("a Word form", () => {
  async function docx(): Promise<Uint8Array> {
    const p = (...runs: string[]) => `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")}</w:p>`;
    const cell = (inner: string) => `<w:tc>${inner}</w:tc>`;
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
      + p("Membership form")
      + p("Full name: ", "______", "__________")            // a blank split across two runs
      + p("Address: ____________________   Phone: __________")
      + p("Employer:")
      + `<w:tbl><w:tr>${cell(p("Date of birth"))}${cell("<w:p></w:p>")}</w:tr></w:tbl>`
      + p("☐ I agree to the rules")
      + `</w:body></w:document>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
    zip.file("word/document.xml", xml);
    return zip.generateAsync({ type: "uint8array" });
  }
  const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  it("its blanks are found, filled in place, saved as a Word file, and read back", async () => {
    const { api, db } = await boot({ documents: [{ ...LICENCE }] });
    const file = await docx();
    const a = await api("POST", "/api/smart-fill/analyze", { fileName: "membership.docx", mimeType: MIME, fileData: b64(file) });
    expect(a.status).toBe(200);
    expect(a.data.format).toBe("docx");
    expect(a.data.fields.map((f: any) => `${f.label}|${f.kind}|${f.value}`)).toEqual([
      "Full name|text|Jordan A. Lee", "Address|text|123 Main St, Springfield, IL 62704", "Phone|text|(555) 010-2299", "Employer|text|",
      "Date of birth|date|03/04/1990", "I agree to the rules|checkbox|",
    ]);
    const fields = a.data.fields.map((f: any) => (/agree/.test(f.label) ? { ...f, value: "yes" } : /Employer/.test(f.label) ? { ...f, value: "Northwind & Sons <Ltd>" } : f));
    const s = await api("POST", "/api/smart-fill/save", { fileName: "membership.docx", mimeType: MIME, fileData: b64(file), fields });
    expect(s.status).toBe(200);
    expect(s.data).toMatchObject({ mimeType: MIME, verification: { ok: true, expected: 6, found: 6 } });
    const xml = await (await JSZip.loadAsync(savedBytes(db, s.data.documentId))).file("word/document.xml")!.async("string");
    const text = xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    expect(text).toContain("Full name: Jordan A. Lee\n");
    expect(text).toContain("Address: 123 Main St, Springfield, IL 62704   Phone: (555) 010-2299");
    expect(text).toContain("Employer: Northwind & Sons <Ltd>");
    expect(text).toContain("Date of birth\n03/04/1990");
    expect(text).toContain("☒ I agree to the rules");
    expect(text).not.toContain("___");
  });
});

describe("account boundaries", () => {
  it("one account's information never contains another's, and another account's document cannot be reopened", async () => {
    const a = await boot({ profiles: [{ id: "self-a", type: "self", name: "Alex Rivera", fields: { phone: "(555) 111-0000" } }], documents: [{ ...LICENCE, id: "d-a", extractedData: { address: "1 Alpha Way, Austin, TX 73301" } }] });
    const infoA = await a.api("GET", "/api/smart-fill/information");
    const serverA = server; server = null;
    const b = await boot({ profiles: [{ id: "self-b", type: "self", name: "Blake Moreno", fields: { phone: "(555) 222-0000" } }], documents: [] });
    const infoB = await b.api("GET", "/api/smart-fill/information");
    expect(JSON.stringify(infoA.data.facts)).toContain("1 Alpha Way");
    expect(JSON.stringify(infoB.data.facts)).not.toMatch(/Alpha Way|Alex Rivera|111-0000/);
    expect(JSON.stringify(infoB.data.facts)).toContain("Blake Moreno");
    // B asks for A's document by id: not found, and B's form is filled only from B.
    expect((await b.api("GET", "/api/smart-fill/session/d-a")).status).toBe(404);
    const form = await flatForm(["Full name: ______________________", "Address: ______________________________"]);
    const { pages } = await pdfjsRead(form);
    const filled = await b.api("POST", "/api/smart-fill/analyze", { fileName: "f.pdf", mimeType: "application/pdf", fileData: b64(form), textPages: pages });
    expect(fieldBy(filled.data.fields, /^Full name$/).value).toBe("Blake Moreno");
    expect(fieldBy(filled.data.fields, /^Address$/).value).toBe("");
    await new Promise<void>((r) => serverA!.close(() => r()));
  });
});
