// A form's fields, as Fill In holds them (owner request 2026-11-23: "populate
// the actual document, not just an AI chat response or preview").
//
// One shape for every kind of form:
//  - an interactive PDF's own fields ("acroform": written by exact name);
//  - a flat PDF's blanks, found from its text layer ("text": `Label: ____`,
//    a label followed by a gap, a ☐ box) — value drawn at that spot;
//  - a scanned page's or a photo's blanks, found by the vision model
//    ("vision") — value drawn at that spot;
//  - a box the user added by hand ("manual").
// A box is a FRACTION of its page, measured from the top-left corner, so the
// screen and the PDF writer place a value at the same spot whatever the zoom.
//
// Pure. Pinned by tests/fill-fields.test.ts.

export type FillFieldKind = "text" | "multiline" | "date" | "number" | "checkbox" | "radio" | "choice" | "signature";
export type FillFieldOrigin = "acroform" | "text" | "vision" | "manual" | "docx";

export interface FillBox { x: number; y: number; w: number; h: number }

export interface FillField {
  id: string;
  label: string;
  kind: FillFieldKind;
  /** 0-based page. */
  page: number;
  box: FillBox;
  origin: FillFieldOrigin;
  /** The PDF form field's own name (acroform). */
  acroName?: string;
  /** Radio / dropdown choices; for a radio, the option this widget stands for is `option`. */
  options?: string[];
  option?: string;
  /** Text, or "yes" / "" for a checkbox, or the chosen option. */
  value: string;
  /** Points; overlay fields only. 0 = fit the box. */
  fontSize?: number;
  // ── where the value came from (shown beside the field) ──
  factId?: string;
  source?: string;
  sourceId?: string;
  /** From an identity or account number: not written until the user confirms. */
  sensitive?: boolean;
  confirmed?: boolean;
  /** Other different values on file for the same thing. */
  alternatives?: Array<{ value: string; source: string; sensitive?: boolean }>;
  /** "structured" = matched by meaning of the label; "ai" = matched by the model; "user" = typed or placed. */
  filledBy?: "structured" | "ai" | "user";
  note?: string;
}

export interface FillPageSize { width: number; height: number }

export const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
export function clampBox(b: FillBox): FillBox {
  const w = Math.max(0.01, Math.min(1, b.w));
  const h = Math.max(0.006, Math.min(1, b.h));
  return { x: Math.max(0, Math.min(1 - w, b.x)), y: Math.max(0, Math.min(1 - h, b.y)), w, h };
}

/** What kind of answer a label asks for. */
export function kindForLabel(label: string, fallback: FillFieldKind = "text"): FillFieldKind {
  const n = String(label || "").toLowerCase();
  if (/signature|sign here|signed/.test(n)) return "signature";
  if (/\bdate\b|d\.?o\.?b|birth ?date|date of|expir|\(mm\/dd/.test(n)) return "date";
  if (/describe|explain|comments?|notes?|details|reason|history|summary|duties|responsibilit/.test(n)) return "multiline";
  return fallback;
}

/** Is this field's value one the saved file must carry? */
export function isWritable(f: FillField): boolean {
  if (f.kind === "signature") return false;
  if (f.sensitive && !f.confirmed) return false;
  return String(f.value || "").trim() !== "";
}

// ── finding blanks in a flat PDF's text ──────────────────────────────────────

/** One run of text on a page, top-left origin, page units. */
export interface TextItem { str: string; x: number; y: number; w: number; h: number }
export interface TextPage { width: number; height: number; items: TextItem[] }

interface Line { y: number; h: number; items: TextItem[] }

function linesOf(page: TextPage): Line[] {
  const items = page.items.filter((i) => i.str && i.str.trim() !== "" && i.w >= 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    const tol = Math.max(2, Math.min(it.h, last?.h ?? it.h) * 0.6);
    if (last && Math.abs(it.y - last.y) <= tol) { last.items.push(it); last.h = Math.max(last.h, it.h); }
    else lines.push({ y: it.y, h: it.h || 10, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

const CHECK_GLYPH = /[☐□▢◻❏❑⬜]|\[\s?\]|\(\s?\)/;
const cleanLabel = (s: string) => s.replace(/_{2,}/g, " ").replace(/[.]{4,}/g, " ").replace(/\s+/g, " ").replace(/^[\s:;,\-–]+|[\s:;,\-–]+$/g, "").trim();

/**
 * The blanks of a flat (non-interactive) PDF, from its text layer:
 *  - a run of underscores or dots is a blank; its label is the text before it;
 *  - a label ending in ":" with nothing after it on the line is a blank that
 *    runs to the next text or the right margin (forms that DRAW their lines);
 *  - a ☐ / [ ] / ( ) is a checkbox labelled by the text after it.
 * Deterministic: the same PDF always yields the same fields.
 */
export function detectTextFields(pages: TextPage[]): FillField[] {
  const out: FillField[] = [];
  let n = 0;
  pages.forEach((page, pageIndex) => {
    const W = page.width || 612, H = page.height || 792;
    const lines = linesOf(page);
    const rightMargin = Math.max(...page.items.map((i) => i.x + i.w), W * 0.5);
    const push = (label: string, kind: FillFieldKind, x: number, y: number, w: number, h: number) => {
      const l = cleanLabel(label);
      if (!l && kind !== "checkbox") return;
      if (w < 6) return;
      out.push({
        id: `t${++n}`, label: l || "Checkbox", kind: kind === "checkbox" ? "checkbox" : kindForLabel(l, kind),
        page: pageIndex, origin: "text", value: "",
        box: clampBox({ x: x / W, y: y / H, w: w / W, h: h / H }),
      });
    };
    lines.forEach((line, li) => {
      let pendingLabel = "";
      let foundOnLine = false;
      line.items.forEach((it, idx) => {
        const str = it.str;
        const charW = str.length > 0 ? it.w / str.length : 0;
        // Checkboxes inside this run.
        const boxRe = new RegExp(CHECK_GLYPH.source, "g");
        let bm: RegExpExecArray | null;
        let hadBox = false;
        while ((bm = boxRe.exec(str))) {
          hadBox = true;
          const after = str.slice(bm.index + bm[0].length).split(new RegExp(CHECK_GLYPH.source))[0];
          const next = line.items[idx + 1];
          const label = cleanLabel(after) || (next && !CHECK_GLYPH.test(next.str) ? cleanLabel(next.str) : "");
          const size = Math.min(Math.max(it.h, 8), 14);
          push(label, "checkbox", it.x + bm.index * charW, it.y, size, size);
          foundOnLine = true;
        }
        if (hadBox) { pendingLabel = ""; return; }
        // Blanks drawn with underscores or leader dots.
        const blankRe = /_{3,}|\.{6,}/g;
        let m: RegExpExecArray | null;
        let cursor = 0;
        let any = false;
        while ((m = blankRe.exec(str))) {
          any = true;
          const before = str.slice(cursor, m.index);
          const label = cleanLabel(before) || pendingLabel;
          push(label || labelAbove(lines, li, it.x + m.index * charW), "text", it.x + m.index * charW, it.y - it.h * 0.15, m[0].length * charW, it.h * 1.25);
          pendingLabel = "";
          cursor = m.index + m[0].length;
          foundOnLine = true;
        }
        if (any) { pendingLabel = cleanLabel(str.slice(cursor)); return; }
        pendingLabel = pendingLabel ? `${pendingLabel} ${str}` : str;
        // "Label:" then a gap: the form draws its own line there.
        if (/:\s*$/.test(str)) {
          const next = line.items[idx + 1];
          const start = it.x + it.w + 4;
          const end = next ? next.x - 6 : Math.min(W - 24, Math.max(rightMargin, start + W * 0.25));
          if (end - start >= Math.max(40, W * 0.08)) {
            push(pendingLabel, "text", start, it.y - it.h * 0.15, Math.min(end - start, W * 0.6), it.h * 1.25);
            foundOnLine = true;
          }
          pendingLabel = "";
        }
      });
      void foundOnLine;
    });
  });
  return dedupeFields(out);
}

function labelAbove(lines: Line[], li: number, x: number): string {
  for (let i = li - 1; i >= Math.max(0, li - 2); i--) {
    const near = lines[i].items.filter((it) => it.x <= x + 40 && it.x + it.w >= x - 40 && !/_{3,}/.test(it.str));
    if (near.length) return near.map((it) => it.str).join(" ");
  }
  return "";
}

/** Two blanks with the same label on a page are numbered, so each can be told apart. */
function dedupeFields(fields: FillField[]): FillField[] {
  const seen = new Map<string, number>();
  for (const f of fields) {
    const k = `${f.page}|${f.label.toLowerCase()}`;
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c > 1) f.label = `${f.label} (${c})`;
  }
  return fields;
}

/** A session's fields, cut down to what is stored with the completed file. */
export function serializeFields(fields: FillField[]): string {
  return JSON.stringify(fields.slice(0, 600).map((f) => ({
    id: f.id, label: f.label.slice(0, 200), kind: f.kind, page: f.page, box: f.box, origin: f.origin,
    ...(f.acroName ? { acroName: f.acroName } : {}),
    ...(f.options ? { options: f.options.slice(0, 60) } : {}),
    ...(f.option ? { option: f.option } : {}),
    // A sensitive value the user did not confirm is not written anywhere.
    value: f.sensitive && !f.confirmed ? "" : String(f.value || "").slice(0, 4000),
    ...(f.fontSize ? { fontSize: f.fontSize } : {}),
    ...(f.source ? { source: f.source.slice(0, 120) } : {}),
    ...(f.sourceId ? { sourceId: f.sourceId } : {}),
    ...(f.sensitive ? { sensitive: true, confirmed: !!f.confirmed } : {}),
    ...(f.filledBy ? { filledBy: f.filledBy } : {}),
  })));
}

const KINDS: FillFieldKind[] = ["text", "multiline", "date", "number", "checkbox", "radio", "choice", "signature"];
const ORIGINS: FillFieldOrigin[] = ["acroform", "text", "vision", "manual", "docx"];

/** Fields from a request or a stored session: only well-formed ones, within bounds. */
export function sanitizeFields(raw: unknown): FillField[] {
  let list: unknown = raw;
  if (typeof raw === "string") { try { list = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const out: FillField[] = [];
  const ids = new Set<string>();
  for (const r of list.slice(0, 600) as any[]) {
    if (!r || typeof r !== "object") continue;
    let id = String(r.id || "").slice(0, 60) || `x${out.length + 1}`;
    while (ids.has(id)) id = `${id}_`;
    ids.add(id);
    const kind: FillFieldKind = KINDS.includes(r.kind) ? r.kind : "text";
    const origin: FillFieldOrigin = ORIGINS.includes(r.origin) ? r.origin : "manual";
    const b = r.box && typeof r.box === "object" ? r.box : {};
    out.push({
      id, kind, origin,
      label: String(r.label ?? "").slice(0, 200) || "Field",
      page: Math.max(0, Math.min(500, Math.floor(Number(r.page) || 0))),
      box: clampBox({ x: Number(b.x) || 0, y: Number(b.y) || 0, w: Number(b.w) || 0.2, h: Number(b.h) || 0.02 }),
      value: String(r.value ?? "").slice(0, 4000),
      ...(typeof r.acroName === "string" && r.acroName ? { acroName: r.acroName.slice(0, 300) } : {}),
      ...(Array.isArray(r.options) ? { options: r.options.map(String).slice(0, 60) } : {}),
      ...(typeof r.option === "string" ? { option: r.option.slice(0, 200) } : {}),
      ...(Number(r.fontSize) > 0 ? { fontSize: Math.max(4, Math.min(48, Number(r.fontSize))) } : {}),
      ...(typeof r.factId === "string" ? { factId: r.factId.slice(0, 40) } : {}),
      ...(typeof r.source === "string" ? { source: r.source.slice(0, 120) } : {}),
      ...(typeof r.sourceId === "string" ? { sourceId: r.sourceId.slice(0, 80) } : {}),
      ...(r.sensitive ? { sensitive: true, confirmed: !!r.confirmed } : {}),
      ...(["structured", "ai", "user"].includes(r.filledBy) ? { filledBy: r.filledBy } : {}),
      ...(Array.isArray(r.alternatives) ? { alternatives: r.alternatives.slice(0, 4).map((a: any) => ({ value: String(a?.value ?? "").slice(0, 400), source: String(a?.source ?? "").slice(0, 120), ...(a?.sensitive ? { sensitive: true } : {}) })) } : {}),
      ...(typeof r.note === "string" ? { note: r.note.slice(0, 300) } : {}),
    });
  }
  return out;
}
