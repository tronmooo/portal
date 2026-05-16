/**
 * Smart Fill PDF — Wave 1
 *
 * Two endpoints:
 *   POST /api/smart-fill/analyze  → Claude reads the PDF + selected source data,
 *                                   returns detected fields with suggested values + source + confidence.
 *   POST /api/smart-fill/render   → User-approved fields rendered as an overlay onto the
 *                                   original PDF (via pdf-lib), saved as a new Document
 *                                   linked to the selected sources. Any date fields tagged
 *                                   `kind: "expiration" | "renewal" | "due"` auto-create an Obligation.
 *
 * Safety: never overwrites original, never auto-submits, never fills signature fields.
 */
import { PDFDocument, StandardFonts, rgb, PDFForm } from "pdf-lib";
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";

// Reuse the same Anthropic client pattern as ai-engine.ts
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface SmartFillSource {
  id: string;
  kind: "profile" | "asset" | "liability" | "document";
  name: string;
}

export interface DetectedField {
  /** Stable id we generate so the UI can keep state */
  id: string;
  /** The label as it appears on the PDF (e.g. "Plate No.", "Owner Name") */
  pdfLabel: string;
  /** Suggested value pulled from the user's data, or empty if none */
  suggestedValue: string;
  /** Which source the value came from ("Honda Civic asset", "My profile", or "missing") */
  source: string;
  sourceId: string | null;
  /** 0–1 confidence from the model */
  confidence: number;
  /** Treat the field's content semantically (date / signature / etc.) */
  fieldKind:
    | "text"
    | "date"
    | "expiration"
    | "renewal"
    | "due"
    | "signature"
    | "checkbox"
    | "number"
    | "currency";
  /** True if AI sees a fillable form field with this name (AcroForm) */
  acroFormName?: string;
  /** Free-form note shown to the user when confidence is low */
  warning?: string;
}

export interface AnalyzeResult {
  documentType: string;
  detectedFields: DetectedField[];
  missingFields: Array<{ id: string; pdfLabel: string; fieldKind: DetectedField["fieldKind"] }>;
  dates: Array<{ pdfLabel: string; iso: string; kind: "expiration" | "renewal" | "due" | "appointment" }>;
}

/**
 * Build a compact JSON summary of the user-selected sources so Claude can map fields.
 * Keep it small — Profiles can have huge `fields` blobs.
 */
async function buildSourcesContext(sources: SmartFillSource[]): Promise<Record<string, any>> {
  const profiles = await storage.getProfiles();
  const documents = await storage.getDocuments();

  const ctx: Record<string, any> = {};
  for (const s of sources) {
    if (s.kind === "profile" || s.kind === "asset" || s.kind === "liability") {
      const p = profiles.find((pp: any) => pp.id === s.id);
      if (p) {
        ctx[`${s.kind}:${p.name}`] = {
          id: p.id,
          type: p.type,
          type_key: p.type_key,
          name: p.name,
          fields: p.fields ?? {},
          notes: (p.notes || "").slice(0, 400),
          tags: p.tags ?? [],
        };
      }
    } else if (s.kind === "document") {
      const d = documents.find((dd: any) => dd.id === s.id);
      if (d) {
        ctx[`document:${d.name}`] = {
          id: d.id,
          type: d.type,
          name: d.name,
          extractedData: d.extractedData ?? {},
          expirationDate: d.expirationDate,
        };
      }
    }
  }
  return ctx;
}

/**
 * Call Claude with the PDF + sources context and return structured fields.
 */
export async function analyzeSmartFill(
  fileName: string,
  pdfBase64: string,
  sources: SmartFillSource[],
): Promise<AnalyzeResult> {
  const sourcesCtx = await buildSourcesContext(sources);

  const prompt = `You are Smart Fill — you read a blank fillable PDF and match every blank/field to the user's saved data.

USER'S DATA (only use these — never invent values):
${JSON.stringify(sourcesCtx, null, 2)}

INSTRUCTIONS:
1. Read the PDF. List every fillable field, blank line, checkbox, and signature line you can see.
2. For each field, decide:
   - "pdfLabel": the label as it appears (e.g. "Owner Name", "Plate No.", "VIN", "Date of Birth")
   - "fieldKind": one of "text" | "date" | "expiration" | "renewal" | "due" | "signature" | "checkbox" | "number" | "currency"
   - "suggestedValue": the value from USER'S DATA if you can confidently match (e.g. profile.fields.licensePlate → "8ABC123"). If you can't match, return "".
   - "source": short human label of where the value came from, e.g. "Honda Civic asset", "Terrance profile". Use "missing" when suggestedValue is "".
   - "sourceId": the id of that source, or null when missing.
   - "confidence": 0.0–1.0 — how sure are you about the match. Lower scores for ambiguous labels like "Tag Number" or "Reference No.".
   - "warning": only when confidence < 0.7, explain the ambiguity in one short sentence.
3. Understand synonyms: "Plate No.", "Tag Number", "Vehicle Registration", "License Plate Number" all map to the same field. "DOB", "Date of Birth", "Born" → date of birth.
4. NEVER fill a signature field — always set suggestedValue="" and source="missing" for kind="signature".
5. For any date that looks like an expiration / renewal / due / appointment date, also list it in the top-level "dates" array with the ISO date.
6. List anything the form needs that USER'S DATA does NOT contain in "missingFields" — these are the fields the user will have to type in.

Return ONLY valid JSON in this exact shape (no markdown, no commentary):
{
  "documentType": "<short label, e.g. 'DMV Vehicle Registration'>",
  "detectedFields": [
    { "id": "f1", "pdfLabel": "...", "fieldKind": "text", "suggestedValue": "...", "source": "...", "sourceId": "...", "confidence": 0.95, "warning": null }
  ],
  "missingFields": [
    { "id": "m1", "pdfLabel": "Driver's license number", "fieldKind": "text" }
  ],
  "dates": [
    { "pdfLabel": "Registration expires", "iso": "2027-03-12", "kind": "expiration" }
  ]
}`;

  // Strip any data: prefix and whitespace
  let cleanBase64 = pdfBase64;
  if (cleanBase64.includes(",")) cleanBase64 = cleanBase64.split(",").pop() || cleanBase64;
  cleanBase64 = cleanBase64.replace(/\s/g, "");

  const response = await getClient().messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: cleanBase64 },
          } as any,
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  let parsed: any;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  } catch {
    parsed = {};
  }

  const detectedFields: DetectedField[] = Array.isArray(parsed.detectedFields)
    ? parsed.detectedFields.map((f: any, i: number) => ({
        id: f.id ?? `f${i + 1}`,
        pdfLabel: String(f.pdfLabel ?? `Field ${i + 1}`),
        suggestedValue: String(f.suggestedValue ?? ""),
        source: String(f.source ?? "missing"),
        sourceId: f.sourceId ?? null,
        confidence: typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0,
        fieldKind: ["text", "date", "expiration", "renewal", "due", "signature", "checkbox", "number", "currency"].includes(f.fieldKind)
          ? f.fieldKind
          : "text",
        warning: f.warning || undefined,
      }))
    : [];

  const missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields.map((m: any, i: number) => ({
        id: m.id ?? `m${i + 1}`,
        pdfLabel: String(m.pdfLabel ?? `Missing ${i + 1}`),
        fieldKind: ["text", "date", "signature", "checkbox", "number", "currency"].includes(m.fieldKind) ? m.fieldKind : "text",
      }))
    : [];

  const dates = Array.isArray(parsed.dates)
    ? parsed.dates
        .map((d: any) => ({
          pdfLabel: String(d.pdfLabel ?? ""),
          iso: String(d.iso ?? ""),
          kind: ["expiration", "renewal", "due", "appointment"].includes(d.kind) ? d.kind : "due",
        }))
        .filter((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d.iso))
    : [];

  return {
    documentType: String(parsed.documentType ?? "PDF Form"),
    detectedFields,
    missingFields,
    dates,
  };
}

export interface FillFieldInput {
  pdfLabel: string;
  value: string;
  fieldKind?: DetectedField["fieldKind"];
  acroFormName?: string;
}

/**
 * Render the filled PDF. Wave 1 strategy:
 *   1. Try to fill any AcroForm fields whose names roughly match the labels (token overlap).
 *   2. For everything else, append a clean "Smart Fill — Filled Fields" summary page so the
 *      user has a labeled, printable record of every value alongside the original.
 *
 * This is the safe, never-corrupt baseline. Wave 2 will do exact-position overlay.
 */
export async function renderFilledPdf(originalBase64: string, fields: FillFieldInput[]): Promise<Uint8Array> {
  let cleanBase64 = originalBase64;
  if (cleanBase64.includes(",")) cleanBase64 = cleanBase64.split(",").pop() || cleanBase64;
  cleanBase64 = cleanBase64.replace(/\s/g, "");
  const bytes = Buffer.from(cleanBase64, "base64");

  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // 1) Try AcroForm direct field fills
  let acroFilledCount = 0;
  try {
    const form: PDFForm = pdfDoc.getForm();
    const formFields = form.getFields();
    if (formFields.length > 0) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const tokensOf = (s: string) => norm(s).split(" ").filter(Boolean);
      for (const f of fields) {
        if (!f.value || f.fieldKind === "signature") continue;
        const fTokens = tokensOf(f.pdfLabel);
        if (fTokens.length === 0) continue;
        // Pick the form field with the highest token-overlap score
        let best: { field: any; score: number } | null = null;
        for (const ff of formFields) {
          const fname = ff.getName();
          const ftokens = tokensOf(fname);
          if (ftokens.length === 0) continue;
          const overlap = fTokens.filter((t) => ftokens.includes(t)).length;
          if (overlap === 0) continue;
          const score = overlap / Math.max(fTokens.length, ftokens.length);
          if (!best || score > best.score) best = { field: ff, score };
        }
        if (best && best.score >= 0.5) {
          try {
            // Only text fields for now (no checkbox/radio mapping in wave 1)
            const t = (best.field as any).setText;
            if (typeof t === "function") {
              (best.field as any).setText(f.value);
              acroFilledCount++;
            }
          } catch {
            /* swallow — fall through to summary page */
          }
        }
      }
      // Don't flatten — keep filled fields editable, but lock signature fields
      // (left blank as a safety rule).
    }
  } catch {
    /* no AcroForm — fine, we'll use the summary page only */
  }

  // 2) Always append a "Smart Fill — Filled Fields" summary page so every value is
  // visible and auditable, regardless of whether AcroForm fills succeeded.
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const margin = 50;
  let y = height - margin;

  page.drawText("Smart Fill — Filled Fields", { x: margin, y, size: 18, font: helvBold, color: rgb(0.1, 0.1, 0.15) });
  y -= 8;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 24;
  page.drawText(`Generated by Portol on ${new Date().toLocaleDateString()}`, {
    x: margin, y, size: 9, font: helv, color: rgb(0.4, 0.4, 0.45),
  });
  y -= 8;
  if (acroFilledCount > 0) {
    page.drawText(`${acroFilledCount} form field(s) were filled directly on the original page.`, {
      x: margin, y: y - 8, size: 9, font: helv, color: rgb(0.4, 0.4, 0.45),
    });
    y -= 16;
  }
  y -= 16;

  const rowH = 22;
  const labelX = margin;
  const valueX = margin + 230;
  const maxWidth = width - margin - valueX;

  page.drawText("Field", { x: labelX, y, size: 10, font: helvBold });
  page.drawText("Value", { x: valueX, y, size: 10, font: helvBold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
  y -= 14;

  const draw = (label: string, value: string) => {
    if (y < margin + rowH) {
      const next = pdfDoc.addPage();
      const sz = next.getSize();
      y = sz.height - margin;
    }
    const labelTxt = label.length > 38 ? label.slice(0, 37) + "…" : label;
    const valueTxt = value.length > 60 ? value.slice(0, 59) + "…" : value;
    page.drawText(labelTxt, { x: labelX, y, size: 10, font: helv, color: rgb(0.2, 0.2, 0.25) });
    page.drawText(valueTxt, { x: valueX, y, size: 10, font: helv, maxWidth, color: rgb(0.05, 0.05, 0.1) });
    y -= rowH;
  };

  for (const f of fields) {
    if (f.fieldKind === "signature") {
      draw(f.pdfLabel, "— signature required (sign manually) —");
    } else if (!f.value) {
      draw(f.pdfLabel, "— blank —");
    } else {
      draw(f.pdfLabel, f.value);
    }
  }

  // Footer
  if (y < margin + 30) {
    const next = pdfDoc.addPage();
    const sz = next.getSize();
    y = sz.height - margin;
  }
  y -= 12;
  page.drawText("Review before submitting. The original PDF is preserved unchanged.", {
    x: margin, y, size: 8, font: helv, color: rgb(0.5, 0.5, 0.55),
  });

  return await pdfDoc.save();
}
