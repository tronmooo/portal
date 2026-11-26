// Sending an artifact anywhere: the phone's share sheet (any app — Messages,
// Mail, WhatsApp, Notes, AirDrop…), a public read-only link, a file, plain
// text, email, a text message or a download. Pure builders + thin browser
// wrappers; nothing here runs on open — every write (minting a share link) is
// on a tap (Rule 3).
import { apiRequest } from "@/lib/queryClient";
import { copyText } from "@/lib/clipboard";
import { invalidateDomains } from "@/lib/cache-bus";
import { decodeSheetData, sheetCellDisplayValue } from "@shared/sheet-data";

export interface ShareableArtifact {
  id?: string;
  title?: string;
  type?: string;
  content?: string;
  items?: Array<{ text: string; checked?: boolean }>;
  language?: string;
  sheetData?: any;
  chartData?: any[];
  shareToken?: string;
  /** Structured chat artifacts (summary_report, kpi_cards…) carry `data`. */
  data?: any;
}

const CODE_EXT: Record<string, string> = {
  python: "py", javascript: "js", typescript: "ts", sql: "sql", bash: "sh", shell: "sh",
  json: "json", html: "html", css: "css", java: "java", go: "go", rust: "rs", ruby: "rb",
  csharp: "cs", cpp: "cpp", c: "c", swift: "swift", kotlin: "kt", php: "php", yaml: "yml",
};

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A spreadsheet as CSV over its used area. */
export function sheetToCsv(sheetData: any): string {
  const d = decodeSheetData(sheetData);
  let maxR = -1, maxC = -1;
  for (const key of Object.keys(d.cells || {})) {
    const [r, c] = key.split(",").map(Number);
    if (sheetCellDisplayValue(d.cells[key]) !== "") { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  }
  const lines: string[] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = 0; c <= maxC; c++) row.push(csvCell(sheetCellDisplayValue(d.cells[`${r},${c}`])));
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function rowsToTable(rows: any[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const keys = Array.from(new Set(rows.flatMap(r => (r && typeof r === "object" ? Object.keys(r) : []))));
  if (keys.length === 0) return "";
  const out = [`| ${keys.join(" | ")} |`, `| ${keys.map(() => "---").join(" | ")} |`];
  for (const r of rows) out.push(`| ${keys.map(k => (r?.[k] ?? "—")).join(" | ")} |`);
  return out.join("\n");
}

function chartRows(a: ShareableArtifact): { title?: string; rows: any[] } {
  const content = (a.content || "").trim();
  if (content) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return { rows: parsed };
      if (parsed && Array.isArray(parsed.data)) return { title: parsed.title, rows: parsed.data };
    } catch { /* not JSON */ }
  }
  return { rows: Array.isArray(a.chartData) ? a.chartData : [] };
}

/** The artifact as readable text — what lands in a message, a note or an email. */
export function artifactPlainText(a: ShareableArtifact): string {
  const title = a.title || "Artifact";
  const type = a.type || "";
  if (a.data && !a.content) {
    return `${title}\n\n${structuredToText(type, a.data)}`.trim();
  }
  if (type === "checklist") {
    const items = Array.isArray(a.items) && a.items.length > 0
      ? a.items.map(i => `${i.checked ? "☑" : "☐"} ${i.text}`)
      : (a.content || "").split("\n").filter(Boolean).map(l => {
          const done = /\[[xX]\]/.test(l);
          return `${done ? "☑" : "☐"} ${l.replace(/^\s*(?:[-*]\s*)?\[[ xX]\]\s*/, "")}`;
        });
    return `${title}\n\n${items.join("\n")}`;
  }
  if (type === "doc") return `${title}\n\n${htmlToText(a.content || "")}`;
  if (type === "sheet") return `${title}\n\n${sheetToCsv(a.sheetData)}`;
  if (type === "chart") {
    const { title: t, rows } = chartRows(a);
    return `${t || title}\n\n${rowsToTable(rows)}`.trim();
  }
  if (type === "html") return `${title}\n\n${htmlToText(a.content || "")}`;
  return `${title}\n\n${a.content || ""}`.trim();
}

function structuredToText(type: string, data: any): string {
  const lines: string[] = [];
  if (type === "kpi_cards") {
    for (const c of data?.cards || []) lines.push(`${c.label}: ${c.value}`);
  } else if (type === "summary_report") {
    for (const s of data?.sections || []) {
      lines.push(`## ${s.heading}`);
      for (const st of s.stats || []) lines.push(`- ${st.label}: ${st.value}`);
      if (s.narrative) lines.push(s.narrative);
    }
    for (const h of data?.highlights || []) lines.push(`• ${h}`);
  } else if (type === "checklist") {
    for (const i of data?.items || []) lines.push(`☐ ${i.text}`);
  } else if (type === "structured_plan") {
    if (data?.overview) lines.push(data.overview);
    for (const s of data?.sections || []) {
      lines.push(`## ${s.heading}`);
      for (const i of s.items || []) lines.push(`- ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
    }
  } else if (type === "chart") {
    lines.push(rowsToTable(data?.data || []));
  }
  return lines.join("\n") || JSON.stringify(data, null, 2);
}

function safeName(title: string): string {
  return (title || "artifact").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact";
}

/** The artifact as a file in its own format. */
export function artifactFile(a: ShareableArtifact): { name: string; mime: string; body: string } {
  const base = safeName(a.title || "Artifact");
  const type = a.type || "";
  if (a.data && !a.content) return { name: `${base}.txt`, mime: "text/plain", body: artifactPlainText(a) };
  switch (type) {
    case "markdown": case "note": case "ai_report":
      return { name: `${base}.md`, mime: "text/markdown", body: a.content || "" };
    case "code": {
      const ext = CODE_EXT[(a.language || "").toLowerCase()] || "txt";
      return { name: `${base}.${ext}`, mime: "text/plain", body: a.content || "" };
    }
    case "html":
      return { name: `${base}.html`, mime: "text/html", body: a.content || "" };
    case "doc":
      return {
        name: `${base}.html`, mime: "text/html",
        body: `<!doctype html><html><head><meta charset="utf-8"><title>${base}</title></head><body>${a.content || ""}</body></html>`,
      };
    case "svg":
      return { name: `${base}.svg`, mime: "image/svg+xml", body: a.content || "" };
    case "mermaid":
      return { name: `${base}.mmd`, mime: "text/plain", body: a.content || "" };
    case "sheet":
      return { name: `${base}.csv`, mime: "text/csv", body: sheetToCsv(a.sheetData) };
    case "chart": {
      const { rows } = chartRows(a);
      return { name: `${base}.json`, mime: "application/json", body: JSON.stringify(rows, null, 2) };
    }
    case "checklist":
      return { name: `${base}.txt`, mime: "text/plain", body: artifactPlainText(a) };
    default:
      return { name: `${base}.txt`, mime: "text/plain", body: artifactPlainText(a) };
  }
}

export function publicShareUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://portol.me";
  return `${origin}/#/share/${token}`;
}

/** Mint (or reuse) the artifact's public read-only link. A write — call on a tap only. */
export async function ensureShareLink(id: string): Promise<string> {
  const res = await apiRequest("POST", `/api/artifacts/${id}/share`);
  const body = await res.json();
  void invalidateDomains("artifacts");
  if (!body?.token) throw new Error("No share link was returned");
  return publicShareUrl(body.token);
}

export async function revokeShareLink(id: string): Promise<void> {
  await apiRequest("DELETE", `/api/artifacts/${id}/share`);
  void invalidateDomains("artifacts");
}

export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof (navigator as any).share === "function";
}

/** Opens the system share sheet. Resolves "shared" | "cancelled" | "unsupported". */
export async function nativeShare(data: { title?: string; text?: string; url?: string; files?: File[] }): Promise<"shared" | "cancelled" | "unsupported"> {
  if (!canNativeShare()) return "unsupported";
  try {
    if (data.files && typeof (navigator as any).canShare === "function" && !(navigator as any).canShare({ files: data.files })) {
      return "unsupported";
    }
    await (navigator as any).share(data);
    return "shared";
  } catch (e: any) {
    return e?.name === "AbortError" ? "cancelled" : "unsupported";
  }
}

export function downloadArtifact(a: ShareableArtifact): void {
  const f = artifactFile(a);
  const blob = new Blob([f.body], { type: `${f.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = f.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function shareArtifactAsFile(a: ShareableArtifact): Promise<"shared" | "cancelled" | "unsupported"> {
  const f = artifactFile(a);
  if (typeof File === "undefined") return "unsupported";
  const file = new File([f.body], f.name, { type: f.mime });
  return nativeShare({ title: a.title, files: [file] });
}

export function copyArtifactText(a: ShareableArtifact): Promise<boolean> {
  return copyText(artifactPlainText(a));
}

/** mailto: / sms: links carry text; long bodies are cut so the link still opens. */
export function emailHref(a: ShareableArtifact, url?: string): string {
  const body = (url ? `${url}\n\n` : "") + artifactPlainText(a).slice(0, 1800);
  return `mailto:?subject=${encodeURIComponent(a.title || "Artifact")}&body=${encodeURIComponent(body)}`;
}

export function smsHref(a: ShareableArtifact, url?: string): string {
  const body = url ? `${a.title || "Artifact"}: ${url}` : artifactPlainText(a).slice(0, 600);
  return `sms:?&body=${encodeURIComponent(body)}`;
}
