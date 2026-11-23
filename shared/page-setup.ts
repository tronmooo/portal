// A document's page setup: paper size, orientation, margins (owner request
// 2026-11-23: "page layouts"). Stored on the doc artifact as ONE scalar, in
// the `language` metadata field, which a doc does not otherwise use:
// "page:a4;landscape;narrow". Anything else reads as the default.
//
// Pure. Pinned by tests/doc-rich-content.test.ts.

export type PageSize = "letter" | "a4" | "legal";
export type PageOrientation = "portrait" | "landscape";
export type PageMargins = "normal" | "narrow" | "wide";
export interface PageSetup { size: PageSize; orientation: PageOrientation; margins: PageMargins }

export const DEFAULT_PAGE_SETUP: PageSetup = { size: "letter", orientation: "portrait", margins: "normal" };

/** Paper in CSS pixels at 96 dpi (portrait) and in points for PDF. */
export const PAGE_SIZES: Record<PageSize, { label: string; widthPx: number; heightPx: number; widthPt: number; heightPt: number }> = {
  letter: { label: "Letter (8.5 × 11 in)", widthPx: 816, heightPx: 1056, widthPt: 612, heightPt: 792 },
  a4: { label: "A4 (210 × 297 mm)", widthPx: 794, heightPx: 1123, widthPt: 595.28, heightPt: 841.89 },
  legal: { label: "Legal (8.5 × 14 in)", widthPx: 816, heightPx: 1344, widthPt: 612, heightPt: 1008 },
};
export const PAGE_MARGINS: Record<PageMargins, { label: string; px: number }> = {
  normal: { label: "Normal (1 in)", px: 96 },
  narrow: { label: "Narrow (0.5 in)", px: 48 },
  wide: { label: "Wide (1.5 in)", px: 144 },
};

export function parsePageSetup(raw: unknown): PageSetup {
  const m = /^page:([a-z0-9]+);([a-z]+);([a-z]+)$/.exec(String(raw ?? "").trim());
  if (!m) return { ...DEFAULT_PAGE_SETUP };
  return {
    size: (m[1] in PAGE_SIZES ? m[1] : DEFAULT_PAGE_SETUP.size) as PageSize,
    orientation: m[2] === "landscape" ? "landscape" : "portrait",
    margins: (m[3] in PAGE_MARGINS ? m[3] : DEFAULT_PAGE_SETUP.margins) as PageMargins,
  };
}

export function serializePageSetup(s: PageSetup): string {
  return `page:${s.size};${s.orientation};${s.margins}`;
}

/** The page as drawn: width, height and padding in CSS pixels. */
export function pageBox(s: PageSetup): { widthPx: number; heightPx: number; paddingPx: number; widthPt: number; heightPt: number } {
  const p = PAGE_SIZES[s.size];
  const land = s.orientation === "landscape";
  return {
    widthPx: land ? p.heightPx : p.widthPx,
    heightPx: land ? p.widthPx : p.heightPx,
    paddingPx: PAGE_MARGINS[s.margins].px,
    widthPt: land ? p.heightPt : p.widthPt,
    heightPt: land ? p.widthPt : p.heightPt,
  };
}

// ── What a saved document may contain ───────────────────────────────────────
export const DOC_ALLOWED_TAGS = [
  "p", "br", "strong", "b", "em", "i", "u", "s", "code", "pre", "h1", "h2", "h3", "h4",
  "ul", "ol", "li", "a", "blockquote", "hr",
  "table", "thead", "tbody", "tr", "th", "td", "colgroup", "col", "img",
];
export const DOC_ALLOWED_ATTR = ["href", "target", "rel", "colspan", "rowspan", "colwidth", "src", "alt", "title", "style"];

/**
 * After the tag/attribute allow-list: a `style` keeps only its text alignment
 * (the one style the editor writes), and an image keeps its `src` only when
 * it is an embedded picture or an https address.
 */
export function tightenDocHtml(html: string): string {
  return String(html ?? "")
    .replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_m, a, b) => {
      const align = /text-align\s*:\s*(left|center|right|justify)/i.exec(a ?? b ?? "");
      return align ? ` style="text-align: ${align[1].toLowerCase()}"` : "";
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const value = (src?.[1] ?? src?.[2] ?? "").trim();
      return /^(data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+|https:\/\/[^\s"']+)$/i.test(value) ? tag : "";
    });
}
