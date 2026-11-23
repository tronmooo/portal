// Document HTML → Word (docx) blocks: headings, paragraphs with bold /
// italic / underline and alignment, lists, tables and embedded pictures.
// Loaded only when "Download as Word" is used.
import {
  AlignmentType, BorderStyle, HeadingLevel, ImageRun, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";

type Fmt = { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean };

function runsOf(node: Node, fmt: Fmt = {}): TextRun[] {
  const out: TextRun[] = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = child.textContent || "";
      if (text) out.push(new TextRun({ text, bold: fmt.bold, italics: fmt.italics, strike: fmt.strike, underline: fmt.underline ? {} : undefined }));
      return;
    }
    if (child.nodeType !== 1) return;
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") { out.push(new TextRun({ text: "", break: 1 })); return; }
    if (tag === "IMG" || tag === "TABLE" || tag === "UL" || tag === "OL") return; // block content, handled by the caller
    out.push(...runsOf(el, {
      bold: fmt.bold || tag === "STRONG" || tag === "B",
      italics: fmt.italics || tag === "EM" || tag === "I",
      underline: fmt.underline || tag === "U" || tag === "A",
      strike: fmt.strike || tag === "S",
    }));
  });
  return out;
}

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT,
};
const alignOf = (el: HTMLElement) => ALIGN[(/text-align\s*:\s*(\w+)/i.exec(el.getAttribute("style") || "")?.[1] || "").toLowerCase()];

async function imageParagraph(img: HTMLImageElement, maxWidthPx: number): Promise<Paragraph | null> {
  const src = img.getAttribute("src") || "";
  const m = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(src);
  if (!m) return null; // only embedded pictures travel with the file
  const bytes = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const size = await new Promise<{ w: number; h: number }>((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth || 400, h: probe.naturalHeight || 300 });
    probe.onerror = () => resolve({ w: 400, h: 300 });
    probe.src = src;
  });
  const scale = Math.min(1, maxWidthPx / size.w);
  const type = (m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase()) as "jpg" | "png" | "gif";
  return new Paragraph({ children: [new ImageRun({ data: bytes, type, transformation: { width: Math.round(size.w * scale), height: Math.round(size.h * scale) } })] });
}

async function blocksOf(parent: Element, maxWidthPx: number, list?: { ordered: boolean; level: number }): Promise<Array<Paragraph | Table>> {
  const out: Array<Paragraph | Table> = [];
  let n = 0;
  for (const el of Array.from(parent.children) as HTMLElement[]) {
    const tag = el.tagName;
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4") {
      const heading = tag === "H1" ? HeadingLevel.HEADING_1 : tag === "H2" ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      out.push(new Paragraph({ heading, alignment: alignOf(el), children: runsOf(el) }));
    } else if (tag === "UL" || tag === "OL") {
      out.push(...await blocksOf(el, maxWidthPx, { ordered: tag === "OL", level: (list?.level ?? -1) + 1 }));
    } else if (tag === "LI") {
      n += 1;
      const lead = list?.ordered ? `${n}. ` : "• ";
      out.push(new Paragraph({ indent: { left: 360 * ((list?.level ?? 0) + 1), hanging: 260 }, children: [new TextRun(lead), ...runsOf(el)] }));
      out.push(...await blocksOf(el, maxWidthPx, list)); // nested lists
    } else if (tag === "TABLE") {
      const rows = Array.from(el.querySelectorAll("tr")).map((tr) => new TableRow({
        children: (Array.from(tr.children) as HTMLElement[]).map((cell) => new TableCell({
          columnSpan: Number(cell.getAttribute("colspan")) || undefined,
          rowSpan: Number(cell.getAttribute("rowspan")) || undefined,
          children: [new Paragraph({ children: runsOf(cell, { bold: cell.tagName === "TH" }) })],
        })),
      })).filter((r) => (r as any).root?.length !== 0);
      if (rows.length > 0) {
        const line = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
        out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line } }));
        out.push(new Paragraph({ children: [] }));
      }
    } else if (tag === "IMG") {
      const p = await imageParagraph(el as HTMLImageElement, maxWidthPx);
      if (p) out.push(p);
    } else if (tag === "HR") {
      out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }));
    } else if (tag === "BLOCKQUOTE") {
      for (const p of Array.from(el.children) as HTMLElement[]) out.push(new Paragraph({ indent: { left: 480 }, children: runsOf(p, { italics: true }) }));
      if (el.children.length === 0) out.push(new Paragraph({ indent: { left: 480 }, children: runsOf(el, { italics: true }) }));
    } else {
      // p, pre and anything else that holds text; a picture inside it follows it.
      const runs = runsOf(el);
      if (runs.length > 0) out.push(new Paragraph({ alignment: alignOf(el), children: runs }));
      for (const img of Array.from(el.querySelectorAll("img"))) {
        const p = await imageParagraph(img as HTMLImageElement, maxWidthPx);
        if (p) out.push(p);
      }
      if (runs.length === 0 && el.querySelectorAll("img").length === 0) out.push(new Paragraph({ children: [] }));
    }
  }
  return out;
}

export async function htmlToDocxBlocks(html: string, maxWidthPx: number): Promise<Array<Paragraph | Table>> {
  // An inert document: nothing in it loads or runs.
  const body = new DOMParser().parseFromString(html || "", "text/html").body;
  const blocks = await blocksOf(body, maxWidthPx);
  return blocks.length > 0 ? blocks : [new Paragraph({ children: [new TextRun(body.textContent || "")] })];
}
