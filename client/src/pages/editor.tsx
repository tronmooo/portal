// Full-screen editor for Doc (rich-text) and Sheet (spreadsheet) artifacts.
// Routes:
//   /editor/new/doc           → blank doc
//   /editor/new/sheet         → blank sheet
//   /editor/:id               → open existing artifact (id resolves type)
//
// Saves to /api/artifacts. Autosaves every 5s after the first manual save.
// Posts a chat preview card when launched from chat (via ?source=chat).

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type CSSProperties } from "react";
// Wave 16: Univer-powered Sheets-equivalent editor for newly-created sheets.
// Lazy-loaded so doc-mode users don't pay the bundle cost.
const UniverSheet = lazy(() => import("@/components/UniverSheet"));
import { useTheme } from "@/components/theme-provider";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Spreadsheet, { createFormulaParser as defaultCreateFormulaParser } from "react-spreadsheet";
import { useSheetSnapshot, buildSheetFunctions } from "@/lib/sheet-functions";
import { SLASH_ITEMS, filterSlashItems, type SlashItem } from "@/lib/editor-slash-commands";
import DOMPurify from "dompurify";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  Heading1, Heading2, LinkIcon, Code, Save, Download, Trash2, Copy, Loader2, Plus, Minus,
  Share2, Printer, Check, BarChart3, LineChart as LineChartIcon, AreaChart as AreaChartIcon, PieChart as PieChartIcon,
  Link2, User as UserIcon, Activity, FileText, ListChecks, CheckCircle2, BookOpen, Receipt, ExternalLink, PanelRightOpen, PanelRightClose,
  DollarSign, Percent, Hash, AlignLeft, AlignCenter, AlignRight,
  Calendar as CalendarIcon, Eraser, ChevronDown,
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import type { Artifact, SheetData, SheetCell, SheetCellFormat } from "@shared/schema";
import { getTemplatesByType, type EditorTemplate } from "@/lib/editor-templates";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { LayoutTemplate } from "lucide-react";
import {
  extractMentionTokens, htmlToPlainText, searchRowToEntity, rankAndDedupe,
  type MentionEntity,
} from "@/lib/editor-mentions";

// ── Misc helpers ──

const CHART_PALETTE = ["hsl(188 55% 50%)","#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16"];

function formatRelative(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 12;

function emptySheet(rows = DEFAULT_ROWS, cols = DEFAULT_COLS): SheetData {
  return { rows, cols, cells: {} };
}

// react-spreadsheet auto-evaluates formulas via fast-formula-parser when the
// cell value starts with "=" (full Excel grammar: SUM, AVERAGE, IF, VLOOKUP,
// arithmetic, etc.). We just hand it the raw string and let it do the work.
// Our SheetData persists the raw text (formula or literal) in `f` for formulas
// and `v` for literals so reload round-trips perfectly.
function sheetToMatrix(s: SheetData): { value: string }[][] {
  const m: { value: string }[][] = [];
  for (let r = 0; r < s.rows; r++) {
    const row: { value: string }[] = [];
    for (let c = 0; c < s.cols; c++) {
      const cell = s.cells[`${r},${c}`];
      let v = "";
      if (cell?.f) v = cell.f;                                 // formula text wins
      else if (cell?.v !== undefined && cell.v !== null) v = String(cell.v);
      row.push({ value: v });
    }
    m.push(row);
  }
  return m;
}

function matrixToSheet(m: any[][], rows: number, cols: number, prev?: SheetData): SheetData {
  const cells: Record<string, SheetCell> = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const raw = m[r]?.[c]?.value;
      if (raw === undefined || raw === null || raw === "") continue;
      const s = String(raw);
      const key = `${r},${c}`;
      if (s.startsWith("=")) {
        cells[key] = { f: s };
      } else {
        const n = Number(s);
        cells[key] = { v: isFinite(n) && s.trim() !== "" ? n : s };
      }
    }
  }
  // Wave 14: preserve format metadata + sheet name across edits.
  return {
    rows,
    cols,
    cells,
    formats: prev?.formats,
    colWidths: prev?.colWidths,
    rowHeights: prev?.rowHeights,
    sheetName: prev?.sheetName,
  };
}

function colLetterToIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colIndexToLetter(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Wave 14: Sheet number formatting ──────────────────────────────────────────
/**
 * Format a raw cell value using a per-cell display format. Returns a string
 * suitable for display (formula evaluation already happens in react-spreadsheet,
 * so this just polishes the look — currency, percent, fixed decimals, etc.).
 */
function formatCellDisplay(raw: unknown, fmt?: SheetCellFormat): string {
  if (raw == null || raw === "") return "";
  if (!fmt || !fmt.numberFormat || fmt.numberFormat === "plain") return String(raw);
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,%\s]/g, ""));
  if (!isFinite(n)) return String(raw);
  const decimals = typeof fmt.decimals === "number" ? fmt.decimals : 2;
  switch (fmt.numberFormat) {
    case "currency":
      return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    case "percent":
      return (n * 100).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + "%";
    case "number":
      return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    case "date":
      try {
        const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
        if (isNaN(d.getTime())) return String(raw);
        return d.toLocaleDateString();
      } catch { return String(raw); }
    default:
      return String(raw);
  }
}

// ── Editor component ──────────────────────────────────────────────────────────

export default function EditorPage() {
  const [matchNew, paramsNew] = useRoute("/editor/new/:type");
  const [matchExisting, paramsExisting] = useRoute("/editor/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { resolvedMode } = useTheme();

  // Determine mode from URL: ?source=chat lets us post a chat card on save.
  const search = typeof window !== "undefined" ? window.location.hash.split("?")[1] || "" : "";
  const params = new URLSearchParams(search);
  const fromChat = params.get("source") === "chat";
  const initialTemplateId = params.get("template");

  // Defensive routing: wouter's useRoute("/editor/new/:type") sometimes doesn't
  // hydrate paramsNew on the first render under hash routing, which caused
  // /editor/new/sheet to silently fall back to doc mode. Read the hash directly
  // as a backstop so the editor always opens in the requested mode.
  const rawHash = typeof window !== "undefined" ? (window.location.hash || "") : "";
  const hashPath = rawHash.replace(/^#/, "").split("?")[0]; // e.g. "/editor/new/sheet"
  const hashSheetMatch = /^\/editor\/new\/(sheet|doc)\b/.exec(hashPath);
  const hashIsNew = !!hashSheetMatch;
  const hashType = (hashSheetMatch?.[1] === "sheet" ? "sheet" : hashSheetMatch?.[1] === "doc" ? "doc" : null) as "doc" | "sheet" | null;

  const isNew = !!matchNew || hashIsNew;
  const newType = ((paramsNew?.type === "sheet" || hashType === "sheet") ? "sheet" : "doc") as "doc" | "sheet";
  const existingId = (matchExisting && !hashIsNew) ? paramsExisting?.id : undefined;

  const { data: existing, isLoading: loadingExisting } = useQuery<Artifact>({
    queryKey: ["/api/artifacts", existingId],
    queryFn: () => apiRequest("GET", `/api/artifacts/${existingId}`).then(r => r.json()),
    enabled: !!existingId && !isNew,
  });

  const type: "doc" | "sheet" = isNew ? newType : (existing?.type === "sheet" ? "sheet" : "doc");
  const [title, setTitle] = useState<string>("");
  const [savedId, setSavedId] = useState<string | undefined>(existingId);
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Sheet active cell + formula bar state.
  const [activeCell, setActiveCell] = useState<{ row: number; column: number } | null>(null);
  const [formulaBarValue, setFormulaBarValue] = useState<string>("");
  const [docHtml, setDocHtml] = useState<string>("");
  const [sheet, setSheet] = useState<SheetData>(emptySheet());
  const inflightAbort = useRef<AbortController | null>(null);

  // Slash command menu state (doc mode only).
  const [slashMenu, setSlashMenu] = useState<{
    open: boolean;
    top: number;
    left: number;
    query: string;
    selectedIndex: number;
  }>({ open: false, top: 0, left: 0, query: "", selectedIndex: 0 });
  const [aiBusy, setAiBusy] = useState(false);
  // Share dialog state (Wave 5).
  const [shareOpen, setShareOpen] = useState(false);
  const [shareToken, setShareToken] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // Insert-Chart dialog state (Wave 6).
  const [chartOpen, setChartOpen] = useState(false);
  const [chartRange, setChartRange] = useState("");
  const [chartHasHeader, setChartHasHeader] = useState(true);
  const [chartType, setChartType] = useState<"bar" | "line" | "area" | "pie">("bar");
  const [chartTitle, setChartTitle] = useState("");
  // Cross-link sidebar state (Wave 7) — doc mode only.
  const [linksOpen, setLinksOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("portol_editor_links_sidebar");
      return v === null ? true : v === "1";
    } catch { return true; }
  });
  const [mentionEntities, setMentionEntities] = useState<MentionEntity[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);

  // Hydrate state from loaded artifact.
  useEffect(() => {
    if (existing) {
      setTitle(existing.title || "");
      if (existing.type === "doc") {
        setDocHtml(existing.content || "<p></p>");
      } else if (existing.type === "sheet") {
        const sd = existing.sheetData;
        setSheet(sd && sd.rows > 0 && sd.cols > 0 ? sd : emptySheet());
      }
      setSavedId(existing.id);
      setShareToken(existing.shareToken);
      setDirty(false);
    }
  }, [existing]);

  // Apply a template to the current editor state. Marks dirty so autosave kicks in.
  const applyTemplate = (tpl: EditorTemplate) => {
    setTitle(tpl.title);
    if (tpl.type === "doc") {
      setDocHtml(tpl.html);
    } else {
      setSheet({ rows: tpl.rows, cols: tpl.cols, cells: tpl.cells });
    }
    setDirty(true);
    toast({ title: `Template applied: ${tpl.label}` });
  };

  // Initialize blank doc/sheet for new artifacts — or apply template if requested.
  useEffect(() => {
    if (isNew && !title) {
      const templates = getTemplatesByType(newType);
      const tpl = initialTemplateId ? templates.find(t => t.id === initialTemplateId) : null;
      if (tpl) {
        applyTemplate(tpl);
        return;
      }
      setTitle(newType === "doc" ? "Untitled doc" : "Untitled sheet");
      if (newType === "doc") setDocHtml("<p></p>");
      else setSheet(emptySheet());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, newType, title, initialTemplateId]);

  // ── Tiptap editor (doc mode only) ───────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false, HTMLAttributes: { class: "text-primary underline" } }),
    ],
    content: docHtml || "<p></p>",
    onUpdate: ({ editor }) => {
      setDocHtml(editor.getHTML());
      setDirty(true);
      // If the slash menu is open, refresh its query from the text between the
      // trigger and the caret. Close it if the trigger is gone.
      setSlashMenu(prev => {
        if (!prev.open) return prev;
        const { from } = editor.state.selection;
        const $from = editor.state.doc.resolve(from);
        const lineText = $from.parent.textContent;
        const offset = $from.parentOffset;
        let triggerOffset = -1;
        for (let i = offset - 1; i >= 0; i--) {
          const ch = lineText[i];
          if (ch === "/") { triggerOffset = i; break; }
          if (ch === " " || ch === "\t" || ch === "\n") break;
        }
        if (triggerOffset === -1) return { ...prev, open: false };
        const query = lineText.slice(triggerOffset + 1, offset);
        return { ...prev, query, selectedIndex: 0 };
      });
    },
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          // Defer to next tick so the "/" character is inserted before we measure caret.
          setTimeout(() => {
            try {
              const sel = window.getSelection();
              if (!sel || sel.rangeCount === 0) return;
              const rect = sel.getRangeAt(0).cloneRange().getBoundingClientRect();
              setSlashMenu({
                open: true,
                top: rect.bottom + window.scrollY + 4,
                left: rect.left + window.scrollX,
                query: "",
                selectedIndex: 0,
              });
            } catch { /* ignore */ }
          }, 0);
          return false;
        }
        return false;
      },
    },
  }, [type === "doc"]);

  // Sync editor when artifact loads.
  useEffect(() => {
    if (editor && existing?.type === "doc" && existing.content && editor.getHTML() !== existing.content) {
      editor.commands.setContent(existing.content || "<p></p>");
    }
  }, [editor, existing]);

  // Filtered slash items, recomputed on each query change.
  const slashFiltered: SlashItem[] = useMemo(
    () => slashMenu.open ? filterSlashItems(slashMenu.query) : [],
    [slashMenu.open, slashMenu.query],
  );

  // ── Wave 7: cross-link mentions ────────────────────────────────────────────
  // Watch the doc body for `@mention` tokens, resolve each to entities via
  // /api/search, and surface them in the right sidebar. Debounced 600ms so we
  // don't hammer the API while the user is typing.
  const mentionTokens = useMemo(() => {
    if (type !== "doc") return [] as ReturnType<typeof extractMentionTokens>;
    const plain = htmlToPlainText(docHtml);
    return extractMentionTokens(plain);
  }, [type, docHtml]);
  const mentionTokensKey = useMemo(
    () => mentionTokens.map(t => t.query).sort().join("\u0001"),
    [mentionTokens],
  );

  useEffect(() => {
    if (type !== "doc") { setMentionEntities([]); return; }
    if (!mentionTokens.length) { setMentionEntities([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setMentionLoading(true);
      try {
        // Issue one /api/search call per unique token (capped at 8 to stay polite).
        const tokens = mentionTokens.slice(0, 8);
        const results = await Promise.all(tokens.map(async tok => {
          try {
            const res = await apiRequest("GET", `/api/search?q=${encodeURIComponent(tok.query)}`);
            const rows = await res.json();
            return Array.isArray(rows) ? rows : [];
          } catch {
            return [];
          }
        }));
        if (cancelled) return;
        const allRows = results.flat();
        const entities: MentionEntity[] = [];
        for (const row of allRows) {
          const e = searchRowToEntity(row);
          if (e) entities.push(e);
        }
        const ranked = rankAndDedupe(entities, tokens.map(t => t.query)).slice(0, 24);
        setMentionEntities(ranked);
      } finally {
        if (!cancelled) setMentionLoading(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  // mentionTokensKey is the dedup’d signal; explicit dep ensures stable runs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, mentionTokensKey]);

  // Persist sidebar open/closed preference.
  useEffect(() => {
    try { localStorage.setItem("portol_editor_links_sidebar", linksOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [linksOpen]);

  // Keyboard navigation for the slash menu (ArrowUp/Down/Enter/Escape).
  useEffect(() => {
    if (!slashMenu.open || !editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenu(p => ({ ...p, open: false }));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenu(p => ({ ...p, selectedIndex: Math.min(slashFiltered.length - 1, p.selectedIndex + 1) }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenu(p => ({ ...p, selectedIndex: Math.max(0, p.selectedIndex - 1) }));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = slashFiltered[slashMenu.selectedIndex];
        if (item) item.run(editor);
        setSlashMenu(p => ({ ...p, open: false }));
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [slashMenu.open, slashMenu.selectedIndex, slashFiltered, editor]);

  // AI command listener — dispatched by slash items "/ai improve", etc.
  // Calls /api/ai-transform and replaces the selection (or current paragraph)
  // with the transformed text.
  useEffect(() => {
    if (!editor) return;
    const handler = async (ev: Event) => {
      const e = ev as CustomEvent<{ command: string; selection: string; from: number; to: number }>;
      const { command, selection, from, to } = e.detail;
      if (!command || !selection) return;
      setAiBusy(true);
      try {
        const r = await apiRequest("POST", "/api/ai-transform", { command, text: selection });
        const json = await r.json();
        const newText: string = json?.text || "";
        if (!newText) {
          toast({ title: "AI returned empty result", variant: "destructive" });
          return;
        }
        if (command === "continue") {
          // Append a new paragraph after the current cursor position.
          editor.chain().focus().insertContent(`<p>${newText.replace(/</g, "&lt;").replace(/\n/g, "</p><p>")}</p>`).run();
        } else if (command === "summarize") {
          // Replace selection with a bulleted list.
          const lines = newText.split("\n").map(l => l.replace(/^[\u2022\-\*]\s*/, "").trim()).filter(Boolean);
          const html = `<ul>${lines.map(l => `<li>${l.replace(/</g, "&lt;")}</li>`).join("")}</ul>`;
          if (to > from) {
            editor.chain().focus().setTextSelection({ from, to }).deleteSelection().insertContent(html).run();
          } else {
            editor.chain().focus().insertContent(html).run();
          }
        } else {
          // Replace selection (or paragraph) with the transformed text.
          const escaped = newText.replace(/</g, "&lt;").replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br/>");
          const html = `<p>${escaped}</p>`;
          if (to > from) {
            editor.chain().focus().setTextSelection({ from, to }).deleteSelection().insertContent(html).run();
          } else {
            // No selection — replace current paragraph.
            const $from = editor.state.doc.resolve(from);
            const start = from - $from.parentOffset;
            const end = start + $from.parent.content.size;
            editor.chain().focus().setTextSelection({ from: start, to: end }).deleteSelection().insertContent(html).run();
          }
        }
      } catch (err: any) {
        toast({ title: "AI request failed", description: err?.message || String(err), variant: "destructive" });
      } finally {
        setAiBusy(false);
      }
    };
    window.addEventListener("portol:ai-command", handler);
    return () => window.removeEventListener("portol:ai-command", handler);
  }, [editor, toast]);

  // ── Save logic ──────────────────────────────────────────────────────────────
  const buildPayload = () => {
    const t = (title || "").trim() || (type === "doc" ? "Untitled doc" : "Untitled sheet");
    if (type === "doc") {
      const cleanHtml = DOMPurify.sanitize(docHtml || "", {
        ALLOWED_TAGS: ["p", "br", "strong", "em", "u", "s", "code", "pre", "h1", "h2", "h3", "h4", "ul", "ol", "li", "a", "blockquote", "hr"],
        ALLOWED_ATTR: ["href", "target", "rel"],
      });
      return { type: "doc" as const, title: t, content: cleanHtml, source: fromChat ? "chat" : "manual" };
    }
    // Sheet: cap dimensions so the zod max ceilings hold.
    const safe: SheetData = {
      rows: Math.max(1, Math.min(10000, sheet.rows)),
      cols: Math.max(1, Math.min(200, sheet.cols)),
      cells: sheet.cells,
    };
    return { type: "sheet" as const, title: t, content: "", sheetData: safe, source: fromChat ? "chat" : "manual" };
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      // Cancel any in-flight save so the latest payload wins.
      inflightAbort.current?.abort();
      const ac = new AbortController();
      inflightAbort.current = ac;
      const payload = buildPayload();
      if (savedId) {
        const r = await apiRequest("PATCH", `/api/artifacts/${savedId}`, payload);
        return r.json();
      } else {
        const r = await apiRequest("POST", "/api/artifacts", payload);
        return r.json();
      }
    },
    onSuccess: (saved: Artifact) => {
      setSavedId(saved.id);
      setDirty(false);
      setLastSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      // Update URL so refresh re-opens the right artifact.
      if (isNew) {
        const qs = fromChat ? "?source=chat" : "";
        setLocation(`/editor/${saved.id}${qs}`);
      }
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err?.message || String(err), variant: "destructive" });
    },
  });

  // Autosave debounce — only after the user has saved at least once OR is editing
  // an existing artifact. Avoids creating empty drafts.
  useEffect(() => {
    if (!dirty) return;
    if (!savedId) return; // require explicit first save
    const t = setTimeout(() => { saveMut.mutate(); }, 5000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, docHtml, sheet, title, savedId]);

  // Warn on close if dirty.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ⌘S / Ctrl+S manual save shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty || !savedId) saveMut.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, savedId]);

  // ── Delete & duplicate ──────────────────────────────────────────────────────
  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!savedId) return;
      await apiRequest("DELETE", `/api/artifacts/${savedId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Deleted" });
      setLocation("/artifacts");
    },
    onError: (err: any) => toast({ title: "Delete failed", description: err?.message, variant: "destructive" }),
  });

  const duplicateMut = useMutation({
    mutationFn: async () => {
      if (!savedId) {
        // First save the unsaved doc, then copy.
        await saveMut.mutateAsync();
      }
      const id = savedId || (await apiRequest("GET", "/api/artifacts").then(r => r.json()).then((rs: Artifact[]) => rs[0]?.id));
      const r = await apiRequest("POST", `/api/artifacts/${id}/duplicate`, { title: `${(title || "Untitled").trim()} (copy)` });
      return r.json();
    },
    onSuccess: (copy: Artifact) => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Copy created" });
      setLocation(`/editor/${copy.id}`);
    },
    onError: (err: any) => toast({ title: "Copy failed", description: err?.message, variant: "destructive" }),
  });

  // ── Public share link (Wave 5) ──────────────────────────────────────────────
  const enableShareMut = useMutation({
    mutationFn: async () => {
      // Save first if needed so the artifact has an id.
      let id = savedId;
      if (!id) {
        const saved = await saveMut.mutateAsync();
        id = saved?.id || savedId;
      }
      if (!id) throw new Error("Save first to enable sharing");
      const r = await apiRequest("POST", `/api/artifacts/${id}/share`);
      return r.json() as Promise<{ token: string; path: string }>;
    },
    onSuccess: (data) => {
      setShareToken(data.token);
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
    },
    onError: (err: any) => toast({ title: "Share failed", description: err?.message, variant: "destructive" }),
  });
  const revokeShareMut = useMutation({
    mutationFn: async () => {
      if (!savedId) return;
      await apiRequest("DELETE", `/api/artifacts/${savedId}/share`);
    },
    onSuccess: () => {
      setShareToken(undefined);
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Share link revoked" });
    },
    onError: (err: any) => toast({ title: "Revoke failed", description: err?.message, variant: "destructive" }),
  });
  const shareUrl = shareToken
    ? `${window.location.origin}/#/share/${shareToken}`
    : "";
  const copyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: "Copy failed", description: "Select the URL manually", variant: "destructive" });
    }
  };

  // ── Download (.docx / .xlsx) ────────────────────────────────────────────────
  const downloadDoc = async () => {
    const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
    // Convert HTML → Paragraph[]. Lightweight: split on block tags and strip remaining tags.
    const tmp = document.createElement("div");
    tmp.innerHTML = docHtml;
    const paragraphs: any[] = [];
    tmp.querySelectorAll("h1,h2,h3,p,li,pre,blockquote").forEach((el) => {
      const text = el.textContent || "";
      let level: any = undefined;
      if (el.tagName === "H1") level = HeadingLevel.HEADING_1;
      else if (el.tagName === "H2") level = HeadingLevel.HEADING_2;
      else if (el.tagName === "H3") level = HeadingLevel.HEADING_3;
      paragraphs.push(new Paragraph({ heading: level, children: [new TextRun(text)] }));
    });
    if (paragraphs.length === 0) paragraphs.push(new Paragraph({ children: [new TextRun(tmp.textContent || "")] }));
    const doc = new Document({ sections: [{ children: paragraphs }] });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(title || "doc").replace(/[^\w\-]+/g, "_")}.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // PDF export for docs — uses jsPDF + html2canvas. Renders the EditorContent in an
  // off-screen, fixed-width A4 wrapper so layout is independent of the live viewport,
  // then slices the resulting canvas into A4-sized pages.
  const downloadDocPdf = async () => {
    const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
      import("jspdf"),
      import("html2canvas"),
    ]);
    // Build an off-screen render target. Match Tiptap's prose styling so output looks
    // like the editor surface. 794px ≈ A4 width @ 96dpi (210mm).
    const wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.left = "-10000px";
    wrap.style.top = "0";
    wrap.style.width = "794px";
    wrap.style.padding = "48px 56px";
    wrap.style.background = "#ffffff";
    wrap.style.color = "#111111";
    wrap.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    const heading = document.createElement("h1");
    heading.textContent = title || "Untitled doc";
    heading.style.fontSize = "24px";
    heading.style.fontWeight = "700";
    heading.style.marginBottom = "16px";
    wrap.appendChild(heading);
    const body = document.createElement("div");
    body.className = "prose prose-sm max-w-none";
    // Sanitize the HTML again before injecting into the DOM tree we'll rasterize.
    body.innerHTML = DOMPurify.sanitize(docHtml || "", { ADD_ATTR: ["target", "rel"] });
    wrap.appendChild(body);
    document.body.appendChild(wrap);
    try {
      const canvas = await html2canvas(wrap, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
      });
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      // If single-page fits, drop it in. Otherwise slice the source canvas across pages.
      if (imgH <= pageH) {
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, imgW, imgH);
      } else {
        const scale = imgW / canvas.width;        // px → pt
        const pageHeightInSrcPx = pageH / scale;   // how many source pixels fit per page
        let yOffset = 0;
        let first = true;
        while (yOffset < canvas.height) {
          const sliceH = Math.min(pageHeightInSrcPx, canvas.height - yOffset);
          const slice = document.createElement("canvas");
          slice.width = canvas.width;
          slice.height = Math.ceil(sliceH);
          const ctx = slice.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, slice.width, slice.height);
            ctx.drawImage(canvas, 0, -yOffset);
          }
          if (!first) pdf.addPage();
          first = false;
          pdf.addImage(
            slice.toDataURL("image/jpeg", 0.92),
            "JPEG",
            0,
            0,
            imgW,
            sliceH * scale,
          );
          yOffset += sliceH;
        }
      }
      pdf.save(`${(title || "doc").replace(/[^\w\-]+/g, "_")}.pdf`);
    } finally {
      wrap.remove();
    }
  };

  // ── Insert chart from sheet range (Wave 6) ─────────────────────────────────
  // Parse a 1-based A1 range like "A1:C10" or "A:C" into [startRow, startCol, endRow, endCol] (0-based).
  // Returns null on bad input. Empty range or unbounded means full sheet bounds.
  const parseRange = useCallback((s: string): [number, number, number, number] | null => {
    const trimmed = (s || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!trimmed) return [0, 0, sheet.rows - 1, sheet.cols - 1];
    const m = trimmed.match(/^([A-Z]+)(\d*):([A-Z]+)(\d*)$/);
    if (!m) return null;
    const c1 = colLetterToIndex(m[1]);
    const c2 = colLetterToIndex(m[3]);
    const r1 = m[2] ? parseInt(m[2], 10) - 1 : 0;
    const r2 = m[4] ? parseInt(m[4], 10) - 1 : sheet.rows - 1;
    if (c1 < 0 || c2 < 0 || r1 < 0 || r2 < 0) return null;
    return [Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)];
  }, [sheet.rows, sheet.cols]);

  // Resolve a cell to its displayed value. Formulas: pull the parser-evaluated
  // result from the rendered <Spreadsheet> if available; otherwise fall back to raw.
  const resolveCellValue = useCallback((r: number, c: number): any => {
    const cell = sheet.cells[`${r},${c}`];
    if (!cell) return "";
    if (cell.v !== undefined && cell.v !== null) return cell.v;
    if (cell.f) {
      // Formulas haven't been pre-evaluated server-side. Try a best-effort numeric parse if
      // the formula is a literal like "=42". For complex formulas, the user should chart the
      // computed values directly. We do NOT execute arbitrary formula text here — unsafe.
      const stripped = cell.f.replace(/^=/, "").trim();
      const n = Number(stripped);
      return isFinite(n) ? n : stripped;
    }
    return "";
  }, [sheet.cells]);

  // Build chart-friendly rows: { name, <series>: number, ... } from the selected range.
  const buildChartRows = useCallback((range: [number, number, number, number], hasHeader: boolean) => {
    const [r1, c1, r2, c2] = range;
    const headerKeys: string[] = [];
    const cols = c2 - c1 + 1;
    if (hasHeader) {
      for (let cc = c1; cc <= c2; cc++) {
        const v = resolveCellValue(r1, cc);
        headerKeys.push(String(v || `col${cc - c1 + 1}`));
      }
    } else {
      for (let i = 0; i < cols; i++) headerKeys.push(i === 0 ? "name" : `series${i}`);
    }
    // Force first column header to "name" for Recharts' XAxis dataKey.
    const nameKey = headerKeys[0] || "name";
    const seriesKeys = headerKeys.slice(1);
    const dataStartRow = hasHeader ? r1 + 1 : r1;
    const rows: Array<Record<string, any>> = [];
    for (let r = dataStartRow; r <= r2; r++) {
      const row: Record<string, any> = {};
      const nameVal = resolveCellValue(r, c1);
      if (nameVal === "" || nameVal === null || nameVal === undefined) continue; // skip blank x-values
      row.name = String(nameVal);
      for (let i = 0; i < seriesKeys.length; i++) {
        const raw = resolveCellValue(r, c1 + 1 + i);
        const num = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
        row[seriesKeys[i]] = isFinite(num) ? num : 0;
      }
      rows.push(row);
    }
    return { rows, seriesKeys, nameKey };
  }, [resolveCellValue]);

  // Live preview rows for the dialog (only valid when range parses).
  const chartPreview = useMemo(() => {
    if (!chartOpen) return null;
    const range = parseRange(chartRange);
    if (!range) return null;
    const { rows, seriesKeys } = buildChartRows(range, chartHasHeader);
    return { rows: rows.slice(0, 50), seriesKeys, total: rows.length };
  }, [chartOpen, chartRange, chartHasHeader, parseRange, buildChartRows]);

  const insertChartMut = useMutation({
    mutationFn: async () => {
      const range = parseRange(chartRange);
      if (!range) throw new Error("Invalid range. Use A1 notation like A1:C10");
      const { rows, seriesKeys } = buildChartRows(range, chartHasHeader);
      if (rows.length === 0) throw new Error("Selected range has no usable rows.");
      if (chartType === "pie" && seriesKeys.length === 0) throw new Error("Pie charts need a value column.");
      const payload: any = {
        type: "chart",
        title: chartTitle.trim() || `${title || "Sheet"} chart`,
        content: JSON.stringify(rows),     // legacy fallback path uses content as JSON
        chartData: rows,
        chartType,
        tags: ["sheet-chart"],
        linkedProfiles: existing?.linkedProfiles || [],
      };
      const r = await apiRequest("POST", "/api/artifacts", payload);
      return r.json() as Promise<Artifact>;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Chart created", description: `Saved as "${created.title}".` });
      setChartOpen(false);
      setChartRange("");
      setChartTitle("");
    },
    onError: (err: any) => toast({ title: "Couldn't create chart", description: err?.message, variant: "destructive" }),
  });

  const downloadSheet = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title || "Sheet1");
    for (let r = 0; r < sheet.rows; r++) {
      for (let c = 0; c < sheet.cols; c++) {
        const cell = sheet.cells[`${r},${c}`];
        if (!cell) continue;
        const ref = ws.getCell(r + 1, c + 1);
        if (cell.f) ref.value = { formula: cell.f.startsWith("=") ? cell.f.slice(1) : cell.f } as any;
        else if (cell.v !== undefined && cell.v !== null) ref.value = cell.v as any;
      }
    }
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(title || "sheet").replace(/[^\w\-]+/g, "_")}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Derived state (BEFORE any conditional return — hook order) ─────────────
  const matrix = useMemo(() => sheetToMatrix(sheet), [sheet]);

  // Wave 16: detect a Univer-encoded payload inside SheetData.cells.
  // We stash the full workbook snapshot under cells.__univer__.v as a JSON string
  // so the existing artifact storage path keeps working without a schema change.
  const univerPayload = (sheet.cells as any)?.__univer__?.v;
  const isUniverSheet = type === "sheet" && typeof univerPayload === "string" && univerPayload.length > 0;
  const initialUniverSnapshot = useMemo(() => {
    if (!univerPayload || typeof univerPayload !== "string") return undefined;
    try { return JSON.parse(univerPayload); } catch { return undefined; }
  }, [univerPayload]);

  // Live data snapshot — only fetched when in sheet mode. Powers =NETWORTH(),
  // =BUDGET("Groceries"), =TRACKER("Weight"), =DAYSUNTIL("2026-12-31"), etc.
  const sheetSnapshot = useSheetSnapshot(type === "sheet");
  const sheetCreateFormulaParser = useMemo(() => {
    const customFns = buildSheetFunctions(sheetSnapshot);
    return (data: any) => defaultCreateFormulaParser(data, { functions: customFns } as any);
  }, [sheetSnapshot]);

  const docStats = useMemo(() => {
    if (type !== "doc") return "";
    const tmp = typeof document !== "undefined" ? document.createElement("div") : null;
    if (!tmp) return "";
    tmp.innerHTML = docHtml || "";
    const text = (tmp.textContent || "").trim();
    const words = text ? text.split(/\s+/).length : 0;
    return `${words} word${words === 1 ? "" : "s"}`;
  }, [docHtml, type]);
  const sheetStats = useMemo(() => Object.keys(sheet.cells).length, [sheet]);

  // ── Wave 14: Sheet formatting helpers ────────────────────────────────────
  /** Mutate the format for the active cell (or all of `cells` if a range pased in). */
  const applyFormatToActive = useCallback((mut: (curr: SheetCellFormat) => SheetCellFormat) => {
    if (!activeCell) return;
    const key = `${activeCell.row},${activeCell.column}`;
    setSheet(prev => {
      const formats = { ...(prev.formats || {}) };
      formats[key] = mut(formats[key] || {});
      return { ...prev, formats };
    });
    setDirty(true);
  }, [activeCell]);

  /** Set or unset a number format for the active cell. */
  const toggleNumberFormat = useCallback((nf: SheetCellFormat["numberFormat"]) => {
    applyFormatToActive(curr => ({
      ...curr,
      numberFormat: curr.numberFormat === nf ? "plain" : nf,
      decimals: curr.decimals ?? (nf === "currency" || nf === "percent" || nf === "number" ? 2 : undefined),
    }));
  }, [applyFormatToActive]);

  /** Bump the decimal places for the active cell (±). Caps 0–6. */
  const bumpDecimals = useCallback((delta: number) => {
    applyFormatToActive(curr => ({
      ...curr,
      numberFormat: curr.numberFormat || "number",
      decimals: Math.max(0, Math.min(6, (curr.decimals ?? 2) + delta)),
    }));
  }, [applyFormatToActive]);

  /** Toggle a bold/italic/underline flag on the active cell. */
  const toggleStyleFlag = useCallback((k: "bold" | "italic" | "underline") => {
    applyFormatToActive(curr => ({ ...curr, [k]: !curr[k] }));
  }, [applyFormatToActive]);

  /** Set alignment for the active cell. */
  const setAlign = useCallback((align: "left" | "center" | "right") => {
    applyFormatToActive(curr => ({ ...curr, align }));
  }, [applyFormatToActive]);

  /** Clear all formatting from the active cell. */
  const clearActiveFormat = useCallback(() => {
    if (!activeCell) return;
    const key = `${activeCell.row},${activeCell.column}`;
    setSheet(prev => {
      const formats = { ...(prev.formats || {}) };
      delete formats[key];
      return { ...prev, formats };
    });
    setDirty(true);
  }, [activeCell]);

  /** Resolve the current format for the active cell (read-only). */
  const activeFormat: SheetCellFormat | undefined = useMemo(() => {
    if (!activeCell) return undefined;
    return sheet.formats?.[`${activeCell.row},${activeCell.column}`];
  }, [activeCell, sheet.formats]);

  /** Custom DataViewer that respects per-cell formats. */
  const SheetDataViewer = useMemo(() => {
    function Viewer(props: { row: number; column: number; cell: any; evaluatedCell?: any }) {
      const { row, column, cell, evaluatedCell } = props;
      const fmt = sheet.formats?.[`${row},${column}`];
      const display = formatCellDisplay(
        evaluatedCell?.value ?? cell?.value ?? "",
        fmt,
      );
      const style: CSSProperties = {
        width: "100%",
        padding: "0 6px",
        fontWeight: fmt?.bold ? 700 : undefined,
        fontStyle: fmt?.italic ? "italic" : undefined,
        textDecoration: fmt?.underline ? "underline" : undefined,
        textAlign: fmt?.align,
        background: fmt?.bg,
        color: fmt?.fg,
      };
      return <span style={style}>{display}</span>;
    }
    return Viewer;
  }, [sheet.formats]);

  // Commit formula-bar edits back into the sheet at activeCell.
  const commitFormulaBar = useCallback(() => {
    if (!activeCell) return;
    const key = `${activeCell.row},${activeCell.column}`;
    const raw = formulaBarValue;
    setSheet(prev => {
      const cells = { ...prev.cells };
      if (raw === "") {
        delete cells[key];
      } else if (raw.startsWith("=")) {
        cells[key] = { f: raw };
      } else {
        const n = Number(raw);
        cells[key] = { v: isFinite(n) && raw.trim() !== "" ? n : raw };
      }
      return { ...prev, cells };
    });
    setDirty(true);
  }, [activeCell, formulaBarValue]);

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loadingExisting && !isNew) {
    return <div className="h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="border-b bg-card flex items-center gap-2 px-3 py-2 shrink-0">
        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => {
          if (dirty && !confirm("Unsaved changes. Leave anyway?")) return;
          // If launched from chat, hop straight back to chat for continuity.
          if (fromChat) setLocation("/"); else setLocation("/artifacts");
        }} aria-label="Back" data-testid="button-editor-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          value={title}
          onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
          placeholder={type === "doc" ? "Untitled doc" : "Untitled sheet"}
          className="h-9 max-w-md font-medium"
          data-testid="input-editor-title"
        />
        <span className="text-xs text-muted-foreground ml-2" data-testid="text-editor-status">
          {type === "doc" ? "Doc" : "Sheet"}
          {saveMut.isPending ? " · Saving…" : (dirty ? " · Unsaved" : (lastSavedAt ? ` · Saved ${formatRelative(lastSavedAt, nowTick)}` : ""))}
          {type === "doc" && docStats ? ` · ${docStats}` : ""}
          {type === "sheet" ? ` · ${sheetStats} filled` : ""}
        </span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="button-editor-template">
              <LayoutTemplate className="h-4 w-4 mr-1" /> Template
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Insert {type === "doc" ? "document" : "spreadsheet"} template</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {getTemplatesByType(type).map((tpl) => (
              <DropdownMenuItem
                key={tpl.id}
                onClick={() => applyTemplate(tpl)}
                className="flex flex-col items-start gap-0.5 py-2"
                data-testid={`menu-template-${tpl.id}`}
              >
                <span className="font-medium">{tpl.label}</span>
                <span className="text-xs text-muted-foreground">{tpl.description}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {type === "doc" ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" data-testid="button-editor-download">
                <Download className="h-4 w-4 mr-1" /> Download
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={downloadDocPdf} data-testid="menu-download-pdf">
                <span className="font-medium">Download as PDF</span>
                <span className="ml-2 text-xs text-muted-foreground">.pdf</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={downloadDoc} data-testid="menu-download-docx">
                <span className="font-medium">Download as Word</span>
                <span className="ml-2 text-xs text-muted-foreground">.docx</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" size="sm" onClick={downloadSheet} data-testid="button-editor-download">
            <Download className="h-4 w-4 mr-1" /> Download
          </Button>
        )}
        {type === "doc" && (
          <Button variant="ghost" size="sm" onClick={() => window.print()} data-testid="button-editor-print">
            <Printer className="h-4 w-4 mr-1" /> Print
          </Button>
        )}
        {savedId && (
          <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)} data-testid="button-editor-share">
            <Share2 className="h-4 w-4 mr-1" /> Share
          </Button>
        )}
        {savedId && (
          <Button variant="ghost" size="sm" onClick={() => duplicateMut.mutate()} data-testid="button-editor-duplicate">
            <Copy className="h-4 w-4 mr-1" /> Copy
          </Button>
        )}
        {savedId && (
          <Button variant="ghost" size="sm" onClick={() => { if (confirm("Delete this artifact?")) deleteMut.mutate(); }} data-testid="button-editor-delete">
            <Trash2 className="h-4 w-4 mr-1" /> Delete
          </Button>
        )}
        <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-editor-save">
          {saveMut.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          Save
        </Button>
      </div>

      {/* Body */}
      {/* Wave 16: New sheets (and any sheet previously saved with Univer payload)
          render in the Univer engine — Google-Sheets-equivalent UX.
          Pre-Univer artifacts keep rendering in the legacy view. */}
      {type === "sheet" && (isNew || isUniverSheet) ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b bg-muted/30 px-3 py-1.5 flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
            <Save className="h-3.5 w-3.5" />
            <span>{isNew ? "New sheet — changes auto-save while you type." : "Sheets engine — changes auto-save."}</span>
          </div>
          <div className="flex-1 min-h-0">
            <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading spreadsheet engine…</div>}>
              <UniverSheet
                key={savedId || "new"}
                initialSnapshot={initialUniverSnapshot}
                sheetName={title || "Sheet1"}
                darkMode={resolvedMode === "dark"}
                onChange={(snap) => {
                  // Persist Univer snapshot inside SheetData.cells under a special key
                  // so existing artifact storage works without schema changes.
                  setSheet(s => ({ ...s, cells: { __univer__: { v: JSON.stringify(snap) } as any } }));
                  setDirty(true);
                }}
              />
            </Suspense>
          </div>
        </div>
      ) : type === "doc" ? (
        <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Toolbar */}
          <div className="border-b bg-muted/30 px-3 py-1.5 flex items-center gap-1 flex-wrap shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleBold().run()} aria-pressed={editor?.isActive("bold")} data-testid="button-doc-bold"><Bold className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleItalic().run()} aria-pressed={editor?.isActive("italic")} data-testid="button-doc-italic"><Italic className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleUnderline().run()} aria-pressed={editor?.isActive("underline")} data-testid="button-doc-underline"><UnderlineIcon className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} data-testid="button-doc-h1"><Heading1 className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} data-testid="button-doc-h2"><Heading2 className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleBulletList().run()} data-testid="button-doc-ul"><List className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleOrderedList().run()} data-testid="button-doc-ol"><ListOrdered className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => {
              const url = window.prompt("URL");
              if (url) editor?.chain().focus().setLink({ href: url }).run();
            }} data-testid="button-doc-link"><LinkIcon className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleCodeBlock().run()} data-testid="button-doc-code"><Code className="h-4 w-4" /></Button>
          </div>
          {/* Tiptap content */}
          <div className="flex-1 overflow-auto">
            <div className="max-w-3xl mx-auto px-6 py-8">
              <EditorContent editor={editor} className="prose prose-sm max-w-none focus:outline-none [&_.ProseMirror]:min-h-[60vh] [&_.ProseMirror]:outline-none" />
            </div>
          </div>
          {/* Slash command menu */}
          {slashMenu.open && slashFiltered.length > 0 && (
            <div
              className="fixed z-50 w-72 max-h-80 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg p-1"
              style={{ top: slashMenu.top, left: slashMenu.left }}
              data-testid="slash-menu"
              onMouseDown={(e) => e.preventDefault()}
            >
              {(() => {
                let lastGroup: string | null = null;
                return slashFiltered.map((item, i) => {
                  const showHeader = item.group !== lastGroup;
                  lastGroup = item.group;
                  return (
                    <div key={item.id}>
                      {showHeader && (
                        <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {item.group === "basic" ? "Basic blocks" : "AI commands"}
                        </div>
                      )}
                      <button
                        type="button"
                        className={`w-full text-left px-2 py-1.5 rounded text-sm ${i === slashMenu.selectedIndex ? "bg-accent" : "hover:bg-accent/50"}`}
                        onClick={() => {
                          if (editor) item.run(editor);
                          setSlashMenu(p => ({ ...p, open: false }));
                        }}
                        onMouseEnter={() => setSlashMenu(p => ({ ...p, selectedIndex: i }))}
                      >
                        <div className="font-medium">{item.label}</div>
                        {item.hint && <div className="text-xs text-muted-foreground">{item.hint}</div>}
                      </button>
                    </div>
                  );
                });
              })()}
            </div>
          )}
          {/* AI busy indicator */}
          {aiBusy && (
            <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border bg-popover text-popover-foreground shadow-lg px-3 py-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> AI thinking…
            </div>
          )}
        </div>
        {/* Wave 7: Cross-link sidebar */}
        <CrossLinkSidebar
          open={linksOpen}
          onToggle={() => setLinksOpen(v => !v)}
          tokenCount={mentionTokens.length}
          loading={mentionLoading}
          entities={mentionEntities}
          currentArtifactId={savedId}
        />
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Wave 14: Google-Sheets style menu bar */}
          <div className="border-b bg-background px-2 py-0.5 flex items-center gap-0 shrink-0 text-xs">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal" data-testid="menu-file">File</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => { setSheet({ cells: {}, rows: 50, cols: 26, formats: {}, sheetName: "Sheet1" }); setDirty(true); }} data-testid="menu-file-new">
                  <Plus className="h-3.5 w-3.5 mr-2" /> New sheet
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => saveMut.mutate()} data-testid="menu-file-save">
                  <Save className="h-3.5 w-3.5 mr-2" /> Save
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => {
                  // Download current sheet as CSV
                  const lines: string[] = [];
                  for (let r = 0; r < sheet.rows; r++) {
                    const row: string[] = [];
                    for (let c = 0; c < sheet.cols; c++) {
                      const cell = sheet.cells[`${r},${c}`];
                      const fmt = sheet.formats?.[`${r},${c}`];
                      const display = formatCellDisplay(cell?.v ?? "", fmt);
                      const escaped = /[",\n]/.test(display) ? `"${display.replace(/"/g, '""')}"` : display;
                      row.push(escaped);
                    }
                    lines.push(row.join(","));
                  }
                  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = `${title || sheet.sheetName || "sheet"}.csv`; a.click();
                  URL.revokeObjectURL(url);
                }} data-testid="menu-file-csv">
                  <Download className="h-3.5 w-3.5 mr-2" /> Download CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.print()} data-testid="menu-file-print">
                  Print
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal" data-testid="menu-edit">Edit</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={clearActiveFormat} data-testid="menu-edit-clear-format">
                  <Eraser className="h-3.5 w-3.5 mr-2" /> Clear formatting
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal" data-testid="menu-insert">Insert</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => { setSheet(s => ({ ...s, rows: Math.min(10000, s.rows + 5) })); setDirty(true); }} data-testid="menu-insert-rows">
                  <Plus className="h-3.5 w-3.5 mr-2" /> Insert 5 rows below
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setSheet(s => ({ ...s, cols: Math.min(200, s.cols + 2) })); setDirty(true); }} data-testid="menu-insert-cols">
                  <Plus className="h-3.5 w-3.5 mr-2" /> Insert 2 columns right
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => {
                  if (activeCell && !chartRange) {
                    const a = `${colIndexToLetter(activeCell.column)}${activeCell.row + 1}`;
                    setChartRange(`${a}:${colIndexToLetter(Math.min(sheet.cols - 1, activeCell.column + 2))}${Math.min(sheet.rows, activeCell.row + 10)}`);
                  }
                  setChartOpen(true);
                }} data-testid="menu-insert-chart">
                  <BarChart3 className="h-3.5 w-3.5 mr-2" /> Chart
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal" data-testid="menu-format">Format</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Number</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => toggleNumberFormat("plain")} data-testid="menu-format-plain">Automatic / Plain</DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleNumberFormat("number")} data-testid="menu-format-number"><Hash className="h-3.5 w-3.5 mr-2" /> Number</DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleNumberFormat("currency")} data-testid="menu-format-currency"><DollarSign className="h-3.5 w-3.5 mr-2" /> Currency</DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleNumberFormat("percent")} data-testid="menu-format-percent"><Percent className="h-3.5 w-3.5 mr-2" /> Percent</DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleNumberFormat("date")} data-testid="menu-format-date"><CalendarIcon className="h-3.5 w-3.5 mr-2" /> Date</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => bumpDecimals(1)}>Increase decimal places</DropdownMenuItem>
                <DropdownMenuItem onClick={() => bumpDecimals(-1)}>Decrease decimal places</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={clearActiveFormat}><Eraser className="h-3.5 w-3.5 mr-2" /> Clear formatting</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal" data-testid="menu-data">Data</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => setChartOpen(true)} data-testid="menu-data-chart">
                  <BarChart3 className="h-3.5 w-3.5 mr-2" /> Range as chart
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal" data-testid="menu-view">View</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => { setSheet(s => ({ ...s, rows: Math.max(1, s.rows - 5) })); setDirty(true); }}>
                  <Minus className="h-3.5 w-3.5 mr-2" /> Remove 5 rows
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setSheet(s => ({ ...s, cols: Math.max(1, s.cols - 2) })); setDirty(true); }}>
                  <Minus className="h-3.5 w-3.5 mr-2" /> Remove 2 columns
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="text-[11px] text-muted-foreground ml-auto pr-2">{sheet.rows} × {sheet.cols}</span>
          </div>

          {/* Wave 14: Formatting toolbar (B/I/U, $ % decimals, align, eraser, chart) */}
          <div className="border-b bg-muted/30 px-2 py-1 flex items-center gap-0.5 shrink-0">
            <Button
              variant={activeFormat?.bold ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => toggleStyleFlag("bold")}
              disabled={!activeCell}
              title="Bold (Ctrl+B)"
              data-testid="fmt-bold"
            ><Bold className="h-3.5 w-3.5" /></Button>
            <Button
              variant={activeFormat?.italic ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => toggleStyleFlag("italic")}
              disabled={!activeCell}
              title="Italic (Ctrl+I)"
              data-testid="fmt-italic"
            ><Italic className="h-3.5 w-3.5" /></Button>
            <Button
              variant={activeFormat?.underline ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => toggleStyleFlag("underline")}
              disabled={!activeCell}
              title="Underline (Ctrl+U)"
              data-testid="fmt-underline"
            ><UnderlineIcon className="h-3.5 w-3.5" /></Button>

            <div className="w-px h-5 bg-border mx-1" />

            <Button
              variant={activeFormat?.numberFormat === "currency" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => toggleNumberFormat("currency")}
              disabled={!activeCell}
              title="Format as currency"
              data-testid="fmt-currency"
            ><DollarSign className="h-3.5 w-3.5" /></Button>
            <Button
              variant={activeFormat?.numberFormat === "percent" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => toggleNumberFormat("percent")}
              disabled={!activeCell}
              title="Format as percent"
              data-testid="fmt-percent"
            ><Percent className="h-3.5 w-3.5" /></Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-[11px] font-mono"
              onClick={() => bumpDecimals(-1)}
              disabled={!activeCell}
              title="Decrease decimal places"
              data-testid="fmt-dec-decimal"
            >.0←</Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-[11px] font-mono"
              onClick={() => bumpDecimals(1)}
              disabled={!activeCell}
              title="Increase decimal places"
              data-testid="fmt-inc-decimal"
            >.0→</Button>

            <div className="w-px h-5 bg-border mx-1" />

            <Button
              variant={activeFormat?.align === "left" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setAlign("left")}
              disabled={!activeCell}
              title="Align left"
              data-testid="fmt-align-left"
            ><AlignLeft className="h-3.5 w-3.5" /></Button>
            <Button
              variant={activeFormat?.align === "center" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setAlign("center")}
              disabled={!activeCell}
              title="Align center"
              data-testid="fmt-align-center"
            ><AlignCenter className="h-3.5 w-3.5" /></Button>
            <Button
              variant={activeFormat?.align === "right" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setAlign("right")}
              disabled={!activeCell}
              title="Align right"
              data-testid="fmt-align-right"
            ><AlignRight className="h-3.5 w-3.5" /></Button>

            <div className="w-px h-5 bg-border mx-1" />

            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={clearActiveFormat}
              disabled={!activeCell}
              title="Clear formatting"
              data-testid="fmt-clear"
            ><Eraser className="h-3.5 w-3.5" /></Button>

            <div className="w-px h-5 bg-border mx-1" />

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                if (activeCell && !chartRange) {
                  const a = `${colIndexToLetter(activeCell.column)}${activeCell.row + 1}`;
                  setChartRange(`${a}:${colIndexToLetter(Math.min(sheet.cols - 1, activeCell.column + 2))}${Math.min(sheet.rows, activeCell.row + 10)}`);
                }
                setChartOpen(true);
              }}
              data-testid="button-sheet-insert-chart"
            ><BarChart3 className="h-3.5 w-3.5 mr-1" /> Chart</Button>
          </div>
          {/* Formula bar (Excel-style: shows raw formula/value of active cell, lets you edit) */}
          <div className="border-b bg-muted/10 px-3 py-1 flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono text-muted-foreground w-12 shrink-0">
              {activeCell ? `${colIndexToLetter(activeCell.column)}${activeCell.row + 1}` : "—"}
            </span>
            <span className="text-xs text-muted-foreground">fx</span>
            <Input
              value={formulaBarValue}
              onChange={(e) => setFormulaBarValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitFormulaBar();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  // revert to current cell value
                  if (activeCell) {
                    const cell = sheet.cells[`${activeCell.row},${activeCell.column}`];
                    setFormulaBarValue(cell?.f || (cell?.v !== undefined && cell.v !== null ? String(cell.v) : ""));
                  }
                }
              }}
              onBlur={commitFormulaBar}
              placeholder="Type a value or =FORMULA(…)"
              className="h-7 text-sm font-mono"
              data-testid="input-formula-bar"
              disabled={!activeCell}
            />
          </div>
          {/* Sheet grid */}
          <div className="flex-1 overflow-auto p-3">
            <div className="portol-sheet" data-darkmode={resolvedMode === "dark" ? "true" : "false"}>
              <Spreadsheet
                data={matrix}
                darkMode={resolvedMode === "dark"}
                createFormulaParser={sheetCreateFormulaParser}
                DataViewer={SheetDataViewer as any}
                onChange={(m: any) => {
                  setSheet(matrixToSheet(m, sheet.rows, sheet.cols, sheet));
                  setDirty(true);
                }}
                onActivate={(point: { row: number; column: number }) => {
                  setActiveCell(point);
                  const cell = sheet.cells[`${point.row},${point.column}`];
                  setFormulaBarValue(cell?.f || (cell?.v !== undefined && cell.v !== null ? String(cell.v) : ""));
                }}
              />
            </div>
          </div>
          {/* Wave 14: Bottom sheet tab bar (Google-Sheets style) */}
          <div className="border-t bg-muted/30 px-2 py-1 flex items-center gap-1 shrink-0 text-xs">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => {
                const next = prompt("Add a new sheet tab — coming soon. For now, rename the current tab.", sheet.sheetName || "Sheet1");
                if (next && next.trim()) {
                  setSheet(s => ({ ...s, sheetName: next.trim() }));
                  setDirty(true);
                }
              }}
              title="Add sheet"
              data-testid="sheet-tab-add"
            ><Plus className="h-3.5 w-3.5" /></Button>
            <button
              type="button"
              onDoubleClick={() => {
                const next = prompt("Rename sheet", sheet.sheetName || "Sheet1");
                if (next && next.trim()) {
                  setSheet(s => ({ ...s, sheetName: next.trim() }));
                  setDirty(true);
                }
              }}
              className="px-3 py-1 rounded-t border-t border-l border-r border-border bg-background text-foreground font-medium text-xs hover:bg-muted/50"
              data-testid="sheet-tab-active"
              title="Double-click to rename"
            >{sheet.sheetName || "Sheet1"}</button>
          </div>
        </div>
      )}

      {/* Share dialog (Wave 5) */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share this {type === "doc" ? "document" : "sheet"}</DialogTitle>
            <DialogDescription>
              Anyone with the link can view a read-only copy. Revoke any time to disable access.
            </DialogDescription>
          </DialogHeader>
          {!shareToken ? (
            <div className="py-2 text-sm text-muted-foreground">
              Sharing is off. Generate a public link to let others view this artifact without signing in.
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Public link</label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                  data-testid="input-share-url"
                />
                <Button variant="secondary" size="sm" onClick={copyShareUrl} data-testid="button-share-copy">
                  {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary underline"
              >
                Open in new tab
              </a>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            {!shareToken ? (
              <Button
                onClick={() => enableShareMut.mutate()}
                disabled={enableShareMut.isPending}
                data-testid="button-share-enable"
              >
                {enableShareMut.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Share2 className="h-4 w-4 mr-1" />
                )}
                Generate link
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => revokeShareMut.mutate()}
                disabled={revokeShareMut.isPending}
                data-testid="button-share-revoke"
              >
                {revokeShareMut.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Revoke link
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Insert-chart dialog (Wave 6) — turns a sheet range into a saved chart artifact. */}
      <Dialog open={chartOpen} onOpenChange={setChartOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Insert chart from range</DialogTitle>
            <DialogDescription>
              Pick a range like <span className="font-mono">A1:C10</span>. The first column becomes the X axis. Each
              additional column is a series.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={chartRange}
                onChange={(e) => setChartRange(e.target.value)}
                placeholder="A1:C10 (leave empty for full sheet)"
                className="font-mono text-sm"
                data-testid="input-chart-range"
              />
              <Input
                value={chartTitle}
                onChange={(e) => setChartTitle(e.target.value)}
                placeholder="Chart title"
                className="text-sm"
                data-testid="input-chart-title"
              />
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={chartHasHeader} onChange={(e) => setChartHasHeader(e.target.checked)} />
                <span>First row is headers</span>
              </label>
              <div className="flex gap-1">
                {([
                  { id: "bar" as const, label: "Bar", icon: BarChart3 },
                  { id: "line" as const, label: "Line", icon: LineChartIcon },
                  { id: "area" as const, label: "Area", icon: AreaChartIcon },
                  { id: "pie" as const, label: "Pie", icon: PieChartIcon },
                ]).map(t => {
                  const Icon = t.icon;
                  return (
                    <Button
                      key={t.id}
                      type="button"
                      variant={chartType === t.id ? "default" : "ghost"}
                      size="sm"
                      onClick={() => setChartType(t.id)}
                      data-testid={`button-chart-type-${t.id}`}
                    >
                      <Icon className="h-3 w-3 mr-1" /> {t.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            {/* Live preview */}
            <div className="rounded-md border bg-muted/30 p-3">
              {!chartRange.trim() && (
                <div className="text-xs text-muted-foreground">Type a range to see a preview.</div>
              )}
              {chartRange.trim() && !chartPreview && (
                <div className="text-xs text-destructive">Invalid range. Use A1 notation like A1:C10.</div>
              )}
              {chartPreview && chartPreview.rows.length === 0 && (
                <div className="text-xs text-muted-foreground">Selected range has no data rows.</div>
              )}
              {chartPreview && chartPreview.rows.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-2">
                    Preview · {chartPreview.total} row{chartPreview.total === 1 ? "" : "s"} · {chartPreview.seriesKeys.length || 1} series
                  </div>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      {chartType === "line" ? (
                        <LineChart data={chartPreview.rows}>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <RTooltip />
                          {(chartPreview.seriesKeys.length > 0 ? chartPreview.seriesKeys : ["value"]).map((k, i) => (
                            <Line key={k} type="monotone" dataKey={k} stroke={["#6366f1","#22c55e","#f59e0b","#ef4444"][i % 4]} strokeWidth={2} dot={{ r: 2 }} />
                          ))}
                        </LineChart>
                      ) : chartType === "area" ? (
                        <AreaChart data={chartPreview.rows}>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <RTooltip />
                          {(chartPreview.seriesKeys.length > 0 ? chartPreview.seriesKeys : ["value"]).map((k, i) => (
                            <Area key={k} type="monotone" dataKey={k} stroke={["#6366f1","#22c55e","#f59e0b","#ef4444"][i % 4]} fill={["#6366f1","#22c55e","#f59e0b","#ef4444"][i % 4]} fillOpacity={0.3} />
                          ))}
                        </AreaChart>
                      ) : chartType === "pie" ? (
                        <PieChart>
                          <RTooltip />
                          <Pie data={chartPreview.rows} dataKey={chartPreview.seriesKeys[0] || "value"} nameKey="name" cx="50%" cy="50%" outerRadius={70} label={{ fontSize: 10 }}>
                            {chartPreview.rows.map((_, i) => <Cell key={i} fill={["#6366f1","#22c55e","#f59e0b","#ef4444","#a855f7","#06b6d4"][i % 6]} />)}
                          </Pie>
                        </PieChart>
                      ) : (
                        <BarChart data={chartPreview.rows}>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <RTooltip />
                          {(chartPreview.seriesKeys.length > 0 ? chartPreview.seriesKeys : ["value"]).map((k, i) => (
                            <Bar key={k} dataKey={k} fill={["#6366f1","#22c55e","#f59e0b","#ef4444"][i % 4]} radius={[3, 3, 0, 0]} />
                          ))}
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setChartOpen(false)}>Cancel</Button>
            <Button
              onClick={() => insertChartMut.mutate()}
              disabled={insertChartMut.isPending || !chartPreview || chartPreview.rows.length === 0}
              data-testid="button-chart-create"
            >
              {insertChartMut.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <BarChart3 className="h-4 w-4 mr-1" />}
              Save chart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Insert-Chart dialog (Wave 6) — sheet-only, builds a chart artifact from a range. */}
      <Dialog open={chartOpen} onOpenChange={setChartOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Insert chart from range</DialogTitle>
            <DialogDescription>
              Pick a chart type and an A1 range. The chart is saved as a new artifact you can pin or share.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {/* Chart type buttons */}
            <div className="flex items-center gap-2">
              {([
                { v: "bar", label: "Bar", Icon: BarChart3 },
                { v: "line", label: "Line", Icon: LineChartIcon },
                { v: "area", label: "Area", Icon: AreaChartIcon },
                { v: "pie", label: "Pie", Icon: PieChartIcon },
              ] as const).map(({ v, label, Icon }) => (
                <Button
                  key={v}
                  type="button"
                  variant={chartType === v ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChartType(v)}
                  data-testid={`button-chart-type-${v}`}
                >
                  <Icon className="h-4 w-4 mr-1" /> {label}
                </Button>
              ))}
            </div>
            {/* Range + header toggle + title */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Range</label>
                <Input
                  value={chartRange}
                  onChange={(e) => setChartRange(e.target.value)}
                  placeholder="e.g. A1:C10"
                  className="font-mono"
                  data-testid="input-chart-range"
                />
                <button
                  type="button"
                  className="text-[11px] text-primary underline"
                  onClick={() => setChartRange(`A1:${colIndexToLetter(Math.min(sheet.cols - 1, 4))}${Math.min(sheet.rows, 10)}`)}
                >
                  Use first {Math.min(10, sheet.rows)} rows
                </button>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Chart title</label>
                <Input
                  value={chartTitle}
                  onChange={(e) => setChartTitle(e.target.value)}
                  placeholder={`${title || "Sheet"} chart`}
                  data-testid="input-chart-title"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chartHasHeader}
                onChange={(e) => setChartHasHeader(e.target.checked)}
                className="rounded"
                data-testid="checkbox-chart-header"
              />
              First row is the header (column names)
            </label>
            {/* Live preview */}
            <div className="rounded border bg-muted/20 p-3">
              <div className="text-xs font-medium text-muted-foreground mb-2">Preview</div>
              {!chartPreview ? (
                <div className="text-xs text-muted-foreground italic h-[180px] flex items-center justify-center">
                  Enter a valid A1 range to preview.
                </div>
              ) : chartPreview.rows.length === 0 ? (
                <div className="text-xs text-muted-foreground italic h-[180px] flex items-center justify-center">
                  Range has no usable rows.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  {chartType === "line" ? (
                    <LineChart data={chartPreview.rows}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <RTooltip />
                      {chartPreview.seriesKeys.length > 1 && <Legend />}
                      {chartPreview.seriesKeys.map((k, i) => (
                        <Line key={k} type="monotone" dataKey={k} stroke={CHART_PALETTE[i % CHART_PALETTE.length]} strokeWidth={2} dot={{ r: 3 }} />
                      ))}
                    </LineChart>
                  ) : chartType === "area" ? (
                    <AreaChart data={chartPreview.rows}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <RTooltip />
                      {chartPreview.seriesKeys.length > 1 && <Legend />}
                      {chartPreview.seriesKeys.map((k, i) => (
                        <Area key={k} type="monotone" dataKey={k} stroke={CHART_PALETTE[i % CHART_PALETTE.length]} fill={CHART_PALETTE[i % CHART_PALETTE.length]} fillOpacity={0.18} />
                      ))}
                    </AreaChart>
                  ) : chartType === "pie" ? (
                    <PieChart>
                      <Pie
                        data={chartPreview.rows}
                        dataKey={chartPreview.seriesKeys[0] || "value"}
                        nameKey="name"
                        cx="50%" cy="50%" outerRadius={80}
                        label
                      >
                        {chartPreview.rows.map((_, i) => (
                          <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                        ))}
                      </Pie>
                      <RTooltip />
                    </PieChart>
                  ) : (
                    <BarChart data={chartPreview.rows}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <RTooltip />
                      {chartPreview.seriesKeys.length > 1 && <Legend />}
                      {chartPreview.seriesKeys.map((k, i) => (
                        <Bar key={k} dataKey={k} fill={CHART_PALETTE[i % CHART_PALETTE.length]} radius={[4, 4, 0, 0]} />
                      ))}
                    </BarChart>
                  )}
                </ResponsiveContainer>
              )}
              {chartPreview && chartPreview.total > chartPreview.rows.length && (
                <div className="text-[11px] text-muted-foreground mt-1">
                  Showing first {chartPreview.rows.length} of {chartPreview.total} rows in preview.
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setChartOpen(false)}>Cancel</Button>
            <Button
              onClick={() => insertChartMut.mutate()}
              disabled={insertChartMut.isPending || !chartPreview || chartPreview.rows.length === 0}
              data-testid="button-chart-save"
            >
              {insertChartMut.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <BarChart3 className="h-4 w-4 mr-1" />}
              Save chart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Wave 7: Cross-link sidebar ────────────────────────────────────────────────
// Right rail in the doc editor that surfaces entities the doc references via
// `@mentions`. Click to open in a new tab. Collapsible (preference persisted).

function entityIcon(t: MentionEntity["type"]) {
  switch (t) {
    case "profile":    return <UserIcon className="h-4 w-4" />;
    case "tracker":    return <Activity className="h-4 w-4" />;
    case "artifact":   return <FileText className="h-4 w-4" />;
    case "task":       return <ListChecks className="h-4 w-4" />;
    case "habit":      return <CheckCircle2 className="h-4 w-4" />;
    case "obligation": return <Receipt className="h-4 w-4" />;
    case "journal":    return <BookOpen className="h-4 w-4" />;
    default:           return <Link2 className="h-4 w-4" />;
  }
}

function CrossLinkSidebar({
  open, onToggle, tokenCount, loading, entities, currentArtifactId,
}: {
  open: boolean;
  onToggle: () => void;
  tokenCount: number;
  loading: boolean;
  entities: MentionEntity[];
  currentArtifactId?: string;
}) {
  // Don't surface the doc currently being edited.
  const filtered = entities.filter(e => !(e.type === "artifact" && e.id === currentArtifactId));
  // Group by type for readability.
  const groups: Record<string, MentionEntity[]> = {};
  for (const e of filtered) {
    if (!groups[e.type]) groups[e.type] = [];
    groups[e.type].push(e);
  }
  const groupOrder: MentionEntity["type"][] = [
    "profile", "tracker", "artifact", "task", "habit", "obligation", "journal", "expense",
  ];
  const groupLabel = (t: MentionEntity["type"]) => ({
    profile: "Profiles", tracker: "Trackers", artifact: "Artifacts", task: "Tasks",
    habit: "Habits", obligation: "Bills", journal: "Journal", expense: "Expenses",
  }[t]);

  if (!open) {
    return (
      <div className="border-l bg-muted/20 flex flex-col items-center w-9 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 mt-2"
          onClick={onToggle}
          title="Show linked entities"
          data-testid="button-toggle-links-sidebar"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="border-l bg-muted/20 flex flex-col w-72 shrink-0 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Link2 className="h-4 w-4" /> Linked
          {tokenCount > 0 && (
            <span className="text-xs text-muted-foreground">({tokenCount})</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onToggle}
          title="Hide sidebar"
          data-testid="button-toggle-links-sidebar"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {tokenCount === 0 ? (
          <div className="text-xs text-muted-foreground p-3 leading-snug">
            Type <span className="font-mono bg-muted px-1 rounded">@name</span> to reference a
            profile, tracker, artifact, task, habit, bill, or journal entry. Matches show up here
            as clickable links.
          </div>
        ) : loading && filtered.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground p-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Resolving mentions…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground p-3 leading-snug">
            No matches found for the {tokenCount} mention{tokenCount === 1 ? "" : "s"} in this doc.
          </div>
        ) : (
          groupOrder.map(t => {
            const list = groups[t];
            if (!list || list.length === 0) return null;
            return (
              <div key={t} className="mb-3">
                <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {groupLabel(t)}
                </div>
                <div className="space-y-0.5">
                  {list.map(e => (
                    <a
                      key={e.id}
                      href={e.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-accent/60 text-sm group"
                      data-testid={`link-entity-${e.type}-${e.id}`}
                    >
                      <span className="mt-0.5 text-muted-foreground shrink-0">{entityIcon(e.type)}</span>
                      <span className="flex-1 min-w-0">
                        <div className="font-medium truncate">{e.label}</div>
                        {e.hint && <div className="text-[11px] text-muted-foreground truncate">{e.hint}</div>}
                      </span>
                      <ExternalLink className="h-3 w-3 mt-1 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
