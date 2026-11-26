// What an artifact IS, for the eye: its label, icon and colour. One table so
// the card, the chip, the viewer header and the chat card name a kind the same.
import {
  BarChart3, FileText, StickyNote, Brain, ListChecks, Code2, AppWindow, Shapes,
  Workflow, Table2, Camera, LayoutGrid, ClipboardList, Calculator, Zap, File,
} from "lucide-react";
import { tryParseChartSpec } from "./ArtifactContent";

export interface ArtifactKind {
  key: string;
  label: string;
  icon: React.ElementType;
  /** "H S% L%" — used as hsl(var) for tints, borders and glows. */
  hsl: string;
}

const K = (key: string, label: string, icon: React.ElementType, hsl: string): ArtifactKind => ({ key, label, icon, hsl });

export const ARTIFACT_KINDS: Record<string, ArtifactKind> = {
  chart:            K("chart", "Chart", BarChart3, "152 65% 48%"),
  doc:              K("doc", "Document", FileText, "205 90% 60%"),
  document:         K("document", "Document", FileText, "205 90% 60%"),
  note:             K("note", "Note", StickyNote, "42 92% 56%"),
  markdown:         K("markdown", "Note", StickyNote, "42 92% 56%"),
  ai_report:        K("ai_report", "Report", Brain, "268 75% 66%"),
  summary_report:   K("summary_report", "Report", Brain, "268 75% 66%"),
  checklist:        K("checklist", "Checklist", ListChecks, "48 90% 55%"),
  code:             K("code", "Code", Code2, "190 80% 55%"),
  html:             K("html", "Interactive", AppWindow, "320 75% 62%"),
  react:            K("react", "Interactive", AppWindow, "320 75% 62%"),
  svg:              K("svg", "Graphic", Shapes, "15 85% 60%"),
  mermaid:          K("mermaid", "Diagram", Workflow, "230 80% 66%"),
  sheet:            K("sheet", "Spreadsheet", Table2, "140 60% 45%"),
  scan:             K("scan", "Scan", Camera, "165 70% 45%"),
  kpi_cards:        K("kpi_cards", "Metrics", LayoutGrid, "190 80% 55%"),
  structured_plan:  K("structured_plan", "Plan", ClipboardList, "280 70% 66%"),
  calculator:       K("calculator", "Calculator", Calculator, "35 90% 56%"),
  quick_entry_form: K("quick_entry_form", "Form", Zap, "55 90% 52%"),
};

/** What a saved artifact SHOWS as: a note whose content is a chart spec is a chart. */
export function displayTypeOf(artifact: any): string {
  const t = artifact?.type;
  if ((t === "note" || t === "markdown") && tryParseChartSpec(artifact?.content || "")) return "chart";
  return t || "note";
}

const FALLBACK = K("other", "Artifact", File, "220 15% 60%");

export function artifactKind(type: string | undefined | null): ArtifactKind {
  return (type && ARTIFACT_KINDS[type]) || FALLBACK;
}

export function KindIcon({ type, className = "h-4 w-4" }: { type?: string | null; className?: string }) {
  const k = artifactKind(type);
  const Icon = k.icon;
  return <Icon className={className} style={{ color: `hsl(${k.hsl})` }} />;
}

export function KindBadge({ type, label }: { type?: string | null; label?: string }) {
  const k = artifactKind(type);
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border"
      style={{ color: `hsl(${k.hsl})`, background: `hsl(${k.hsl} / 0.12)`, borderColor: `hsl(${k.hsl} / 0.35)` }}
    >
      {label || k.label}
    </span>
  );
}
