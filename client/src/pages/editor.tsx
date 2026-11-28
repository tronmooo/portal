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
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { TableKit } from "@tiptap/extension-table";
import TiptapImage from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import { cleanDocHtml, imageFileToDataUrl } from "@/lib/doc-html";
import { markersToPictures, picturesToMarkers } from "@shared/workspace-document";
import {
  DEFAULT_PAGE_SETUP, PAGE_MARGINS, PAGE_SIZES, pageBox, parsePageSetup, serializePageSetup,
  type PageSetup,
} from "@shared/page-setup";
import { FileCog, ImagePlus, Table as TableIcon } from "lucide-react";
import { AllSelection } from "prosemirror-state";
import Spreadsheet, { createFormulaParser as defaultCreateFormulaParser } from "react-spreadsheet";
import { useSheetSnapshot, buildSheetFunctions } from "@/lib/sheet-functions";
import { SLASH_ITEMS, filterSlashItems, type SlashItem } from "@/lib/editor-slash-commands";
import DOMPurify from "dompurify";
import { apiRequest } from "@/lib/queryClient";
import {
  AttachMenu, WorkspaceAiBar, WorkspaceCloseButton, WorkspaceKeyboardProvider, WorkspacePortal, WorkspaceSaveButton, UnsavedLeaveBar,
  aiErrorText, readFileAsDataUrl, useFullScreenWorkspace, useVisualViewportBox, viewportBoxStyle, type WorkspaceSaveState,
} from "@/components/workspace/WorkspaceShell";
import { getProfileFilter } from "@/lib/profileFilter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  Heading1, Heading2, LinkIcon, Code, Save, Download, Trash2, Copy, Loader2, Plus, Minus,
  Share2, Printer, Check, BarChart3, LineChart as LineChartIcon, AreaChart as AreaChartIcon, PieChart as PieChartIcon,
  Link2, User as UserIcon, Activity, FileText, ListChecks, CheckCircle2, BookOpen, Receipt, ExternalLink, PanelRightOpen, PanelRightClose,
  DollarSign, Percent, Hash, AlignLeft, AlignCenter, AlignRight,
  Calendar as CalendarIcon, Eraser, ChevronDown, Pencil as PencilIcon, MoreHorizontal,
  Undo2, Redo2, AtSign, Strikethrough, Type, Highlighter, PaintBucket, LogOut,
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Artifact, SheetData, SheetCell, SheetCellFormat } from "@shared/schema";
import { decodeSheetData, sheetCellDisplayValue } from "@shared/sheet-data";
import { getTemplatesByType, type EditorTemplate } from "@/lib/editor-templates";
import { hashNavigate } from "@/lib/hashNavigate";
import { DictateButton, WorkspaceTabs, rememberLastOpened } from "@/components/workspace/WorkspaceApp";
import { WORD_TABS, takeWordSeed, wordTabRoute, type WordTab } from "@/components/workspace/WordTabs";
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
  const decoded = decodeSheetData(s);
  const m: { value: string }[][] = [];
  for (let r = 0; r < decoded.rows; r++) {
    const row: { value: string }[] = [];
    for (let c = 0; c < decoded.cols; c++) {
      row.push({ value: sheetCellDisplayValue(decoded.cells[`${r},${c}`]) });
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
  // The editor is the Document workspace: it takes the whole screen.
  useFullScreenWorkspace();
  // Pinned to the visual viewport: the header stays on screen and the
  // formatting bar sits above the phone's keyboard.
  const viewportBox = useVisualViewportBox();

  // Determine mode from URL: ?source=chat lets us post a chat card on save.
  const search = typeof window !== "undefined" ? window.location.hash.split("?")[1] || "" : "";
  const params = new URLSearchParams(search);
  const fromChat = params.get("source") === "chat";
  // Opened from Word (the chat box's Word button): the editor is Word's
  // Editor tab — it shows Word's tab strip and the X returns to AI Chat.
  const fromWord = params.get("source") === "word";
  const initialTemplateId = params.get("template");

  // Defensive routing: wouter's useRoute("/editor/new/:type") sometimes doesn't
  // hydrate paramsNew on the first render under hash routing, which caused
  // /editor/new/sheet to silently fall back to doc mode. Read the hash directly
  // as a backstop so the editor always opens in the requested mode.
  // ALSO: handle plain `/editor/new` (no /:type) — wouter's useRoute("/editor/:id")
  // captures "new" as an id, which then makes save attempt PATCH /api/artifacts/new → 404.
  const rawHash = typeof window !== "undefined" ? (window.location.hash || "") : "";
  const hashPath = rawHash.replace(/^#/, "").split("?")[0]; // e.g. "/editor/new/sheet" or "/editor/new"
  const hashSheetMatch = /^\/editor\/new\/(sheet|doc)\b/.exec(hashPath);
  const hashIsBareNew = /^\/editor\/new\/?$/.test(hashPath); // bare /editor/new with no type
  const hashIsNew = !!hashSheetMatch || hashIsBareNew;
  const hashType = (hashSheetMatch?.[1] === "sheet" ? "sheet" : hashSheetMatch?.[1] === "doc" ? "doc" : null) as "doc" | "sheet" | null;

  // wouter route /editor/:id matches /editor/new and binds id="new" — explicitly
  // ignore that case so we don't fetch a non-existent artifact and lock the
  // editor into PATCH-update mode.
  const existingIdRaw = (matchExisting && !hashIsNew) ? paramsExisting?.id : undefined;
  const existingId = existingIdRaw === "new" ? undefined : existingIdRaw;

  const isNew = !!matchNew || hashIsNew || !existingId;
  const newType = ((paramsNew?.type === "sheet" || hashType === "sheet") ? "sheet" : "doc") as "doc" | "sheet";

  const { data: cachedExisting, isLoading: loadingExisting, isStale: existingStale, isFetching: fetchingExisting } = useQuery<Artifact>({
    queryKey: ["/api/artifacts", existingId],
    queryFn: () => apiRequest("GET", `/api/artifacts/${existingId}`).then(r => r.json()),
    enabled: !!existingId && !isNew,
  });
  // The page is filled from the document ONCE (below), so it must be filled
  // from the saved copy, not from a stale one the cache still holds while it
  // is being read again. A version restored in Word (or a change made in chat)
  // marks the cached copy stale; hydrating from it put the replaced text on
  // the page, and the next autosave would have written it back over the
  // restore (integrity run ui-records.artifact, 2026-11-28). A copy that is
  // stale and NOT being read (offline, a failed read) is still the last good
  // data and is used (Rule 7).
  // Only the FIRST fill waits: once this document is on the page, the refetch
  // after each save must not swap the editor for a spinner.
  const firstFresh = useRef<string | null>(null);
  const existing = cachedExisting && (firstFresh.current === cachedExisting.id || !(existingStale && fetchingExisting)) ? cachedExisting : undefined;
  if (existing) firstFresh.current = existing.id;

  const type: "doc" | "sheet" = isNew ? newType : (existing?.type === "sheet" ? "sheet" : "doc");
  const [title, setTitle] = useState<string>("");
  const [savedId, setSavedId] = useState<string | undefined>(existingId);
  const [dirty, setDirty] = useState(false);
  // Paper size, orientation and margins (shared/page-setup.ts).
  const [pageSetup, setPageSetup] = useState<PageSetup>({ ...DEFAULT_PAGE_SETUP });
  const page = pageBox(pageSetup);
  const changePageSetup = (patch: Partial<PageSetup>) => { setPageSetup((p) => ({ ...p, ...patch })); setDirty(true); };
  const imageInputRef = useRef<HTMLInputElement>(null);
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
  // On mobile we default to closed so the editor isn't squeezed into 50% of
  // the viewport. Users can still open it via the chip in the bottom toolbar.
  const [linksOpen, setLinksOpen] = useState<boolean>(() => {
    try {
      const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
      if (isMobile) return false;
      const v = localStorage.getItem("portol_editor_links_sidebar");
      return v === null ? true : v === "1";
    } catch { return true; }
  });
  const [mentionEntities, setMentionEntities] = useState<MentionEntity[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);

  // Hydrate state from the loaded artifact — ONCE per artifact. `existing` is
  // refetched after every save (the save invalidates ["/api/artifacts"]), and
  // re-hydrating from that refetch put the saved copy back over whatever was
  // typed since, moved the caret, and re-marked the document unsaved.
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (existing) {
      setShareToken(existing.shareToken);
      if (hydratedFor.current === existing.id) return;
      hydratedFor.current = existing.id;
      setTitle(existing.title || "");
      if (existing.type === "doc") {
        setDocHtml(existing.content || "<p></p>");
        setPageSetup(parsePageSetup(existing.language));
      } else if (existing.type === "sheet") {
        const sd = existing.sheetData;
        setSheet(sd && sd.rows > 0 && sd.cols > 0 ? sd : emptySheet());
      }
      setSavedId(existing.id);
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
  // Mobile-only: track whether the doc editor is focused. When true, we swap
  // the top bar to the Google-Docs-style ✓ / undo / redo / + / ⋯ chrome from
  // IMG_0420. Reset on blur so the normal back-button bar returns.
  const [docFocused, setDocFocused] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "text-primary underline" },
        // An attached file is a link to a saved document inside the app.
        isAllowedUri: (url, ctx) => String(url || "").startsWith("#/documents/") || !!ctx.defaultValidate(url),
      }),
      TableKit.configure({ table: { resizable: false } }),
      TiptapImage.configure({ allowBase64: true, inline: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
    ],
    content: docHtml || "<p></p>",
    onFocus: () => setDocFocused(true),
    onBlur: () => setDocFocused(false),
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
      handleKeyDown: (view, event) => {
        // BUG-RTE01: Cmd+A / Ctrl+A inside the editor must select the document
        // body, not the entire app shell. Browsers were bubbling the keydown up
        // to the window when the editor's contenteditable was focused but the
        // selection wasn't yet inside its content, so the default browser
        // "select everything" action ran and highlighted the toolbar/sidebar
        // too. Intercept it here, run ProseMirror's selectAll, and stop
        // propagation so the browser never sees the shortcut.
        if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A")) {
          event.preventDefault();
          event.stopPropagation();
          view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
          view.focus();
          return true;
        }
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

  // Put the loaded document into the editor: once per artifact (and per
  // editor instance), and WITHOUT an update event. Loading is not an edit:
  // TipTap 3's setContent emits `update` by default, which marked a document
  // that had just been opened "Unsaved" and then autosaved it (a write on
  // open, W3). (2026-11-24: saved, reopened, the header said "Unsaved".)
  const syncedFor = useRef<{ editor: unknown; id: string } | null>(null);
  useEffect(() => {
    if (!editor || existing?.type !== "doc") return;
    if (syncedFor.current?.editor === editor && syncedFor.current.id === existing.id) return;
    syncedFor.current = { editor, id: existing.id };
    if (existing.content && editor.getHTML() !== existing.content) {
      editor.commands.setContent(existing.content || "<p></p>", { emitUpdate: false });
    }
  }, [editor, existing]);

  // Content the Word workspace handed over (a template, or an AI draft the
  // user chose to open): put on the page ONCE. It marks the document unsaved,
  // so the editor saves it the way it saves anything typed — the workspace
  // itself wrote nothing. A revision of a saved document (`forId`) waits for
  // that document to load, and replaces its text; the server keeps the text
  // it replaces as a version.
  useEffect(() => {
    if (!editor || type !== "doc") return;
    const seed = takeWordSeed((sd) => (sd.forId ? existing?.id === sd.forId : isNew));
    if (!seed) return;
    if (seed.title && !seed.forId) setTitle(seed.title);
    editor.commands.setContent(cleanDocHtml(seed.html));
    setDirty(true);
  }, [editor, type, isNew, existing?.id]);

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
  // When creating a brand-new artifact, link it to whichever profile(s) the
  // user currently has selected in the global profile filter. This keeps the
  // newly-saved doc visible after save instead of getting hidden behind the
  // active filter (e.g. user filtering by "Bob" saves a doc → server auto-links
  // it to "self" → doc disappears from view). Existing artifacts keep their
  // original linkedProfiles — we only add profiles on first save.
  const buildPayload = () => {
    const t = (title || "").trim() || (type === "doc" ? "Untitled doc" : "Untitled sheet");
    const filter = getProfileFilter();
    const linkedProfiles = (!savedId && filter.mode === "selected" && filter.selectedIds.length > 0)
      ? [...filter.selectedIds]
      : undefined;
    if (type === "doc") {
      const cleanHtml = cleanDocHtml(docHtml || "");
      return { type: "doc" as const, title: t, content: cleanHtml, language: serializePageSetup(pageSetup), source: fromChat ? "chat" : "manual", ...(linkedProfiles ? { linkedProfiles } : {}) };
    }
    // Sheet: cap dimensions so the zod max ceilings hold.
    const safe: SheetData = {
      rows: Math.max(1, Math.min(10000, sheet.rows)),
      cols: Math.max(1, Math.min(200, sheet.cols)),
      cells: sheet.cells,
    };
    return { type: "sheet" as const, title: t, content: "", sheetData: safe, source: fromChat ? "chat" : "manual", ...(linkedProfiles ? { linkedProfiles } : {}) };
  };

  // An autosave, or the save the X does on its way out, must not move the URL
  // (the route change remounts the editor and drops the caret mid-sentence).
  const quietSaveRef = useRef(false);
  // A save outlives the editor: Save pressed, then Calendar before the answer
  // came back — the answer moved the URL to /editor/<id> and the document
  // opened again over the Calendar (QA 2026-11-24, second pass). Only an
  // editor that is still on screen, at the address it opened on, follows its
  // first save to the saved document's address.
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const stillOnNewEditor = () => mountedRef.current && typeof window !== "undefined"
    && /^#\/editor\/new\//.test(window.location.hash || "");
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
      // Bug #22: artifact saves auto-create a backing document row server-side
      // (PDF/Word/etc. preview surface). The Documents page reads from
      // /api/documents — without invalidating it the new doc doesn’t appear
      // until next mount. Also refresh dashboard counters that read both.
      qc.invalidateQueries({ queryKey: ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      // Update URL so refresh re-opens the right artifact.
      if (isNew && !quietSaveRef.current && stillOnNewEditor()) {
        const qs = fromChat ? "?source=chat" : fromWord ? "?source=word" : "";
        // Through hashNavigate, not the router's setLocation: the router moves
        // a "?…" out of the hash, and the editor reads where it was opened
        // from (`source`) out of the hash — after the first Save the X then
        // forgot it had come from Chat or Word and left for Artifacts.
        if (qs) hashNavigate(`/editor/${saved.id}${qs}`); else setLocation(`/editor/${saved.id}`);
      }
      quietSaveRef.current = false;
    },
    onError: (err: any) => {
      quietSaveRef.current = false;
      toast({ title: "Save failed", description: err?.message || String(err), variant: "destructive" });
    },
  });

  /** Is there anything worth keeping in a document that was never saved? */
  const hasUnsavedWork = () => type === "doc"
    ? !!(title.trim() || (editor?.getText() || "").trim())
    : dirty;

  // The X (and Back): save what is pending, then leave. Never asks, never discards.
  const leaveEditor = () => { if (fromChat || fromWord) setLocation("/chat"); else setLocation("/artifacts"); };
  // Word remembers the document last open, to bring it back next time.
  useEffect(() => { if (fromWord && type === "doc") rememberLastOpened("word", { tab: "editor", ...(savedId ? { id: savedId } : {}) }); }, [fromWord, type, savedId]);
  /** Another Word tab: save what is pending (quietly), then go there. A failed save stays. */
  const goWordTab = async (next: WordTab) => {
    if (next === "editor") return;
    let id = savedId;
    if (dirty && (savedId || hasUnsavedWork())) {
      quietSaveRef.current = true;
      try { id = (await saveMut.mutateAsync())?.id ?? id; } catch { setLeaveWarn(true); return; }
    }
    rememberLastOpened("word", { tab: next, ...(id ? { id } : {}) });
    hashNavigate(wordTabRoute(next, id));
  };
  const closeWorkspace = async (): Promise<boolean | void> => {
    if (dirty && (savedId || hasUnsavedWork())) {
      quietSaveRef.current = true;
      // The toast says why; stay so nothing is lost, and the header offers
      // "Keep editing" / "Leave without saving".
      try { await saveMut.mutateAsync(); } catch { return false; }
    }
    leaveEditor();
  };
  const [leaveWarn, setLeaveWarn] = useState(false);

  // The header's Save: always shown; disabled only while there is nothing to keep.
  const saveState: WorkspaceSaveState = saveMut.isPending ? "saving"
    : saveMut.isError && dirty ? "error"
    : dirty ? "dirty"
    : savedId ? "saved" : "empty";
  const saveButton = (
    <WorkspaceSaveButton
      state={saveState}
      disabled={!savedId && !hasUnsavedWork() && !(type === "sheet" && dirty)}
      onSave={async () => {
        if (!dirty && savedId) return true;
        try { await saveMut.mutateAsync(); return true; } catch { return false; }
      }}
    />
  );

  // Attachments: a picture goes into the page; any other file is saved to
  // Documents and linked from the page, where it is listed under the text.
  const [attaching, setAttaching] = useState(false);
  const attachFiles = async (files: File[]) => {
    if (!editor) return;
    setAttaching(true);
    try {
      for (const file of files) {
        if (file.type.startsWith("image/")) { await insertImageFile(file); continue; }
        if (file.size > 10 * 1024 * 1024) { toast({ title: `${file.name} is too large`, description: "Attachments can be up to 10 MB.", variant: "destructive" }); continue; }
        try {
          const data = await readFileAsDataUrl(file);
          const r = await apiRequest("POST", "/api/upload/save-only", { fileName: file.name, mimeType: file.type || "application/octet-stream", fileData: data });
          const j = await r.json();
          if (!j?.documentId) throw new Error("The file was not saved.");
          const safeName = file.name.replace(/[<>&"]/g, "");
          editor.chain().focus("end").insertContent(`<p><a href="#/documents/${String(j.documentId)}">📎 ${safeName}</a></p>`).run();
          setDocHtml(editor.getHTML());
          setDirty(true);
          qc.invalidateQueries({ queryKey: ["/api/documents"] });
        } catch (err) {
          toast({ title: `Couldn't attach ${file.name}`, description: aiErrorText(err), variant: "destructive" });
        }
      }
    } finally {
      setAttaching(false);
    }
  };
  /** The files linked from the page, once each, in order. */
  const docAttachments = useMemo(() => {
    const out: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    for (const m of String(docHtml || "").matchAll(/<a[^>]*href="#\/documents\/([^"#?/]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], name: m[2].replace(/<[^>]+>/g, "").replace(/^📎\s*/, "").trim() || "Attached file" });
    }
    return out;
  }, [docHtml]);
  const [armedAttachment, setArmedAttachment] = useState<string | null>(null);
  useEffect(() => {
    if (!armedAttachment) return;
    const t = setTimeout(() => setArmedAttachment(null), 3000);
    return () => clearTimeout(t);
  }, [armedAttachment]);
  /** Take a file's link out of the page (the file stays in Documents). */
  const detachFile = (id: string) => {
    if (!editor) return;
    const href = `#/documents/${id}`;
    const ranges: Array<{ from: number; to: number }> = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.marks.some((mk) => mk.type.name === "link" && mk.attrs.href === href)) ranges.push({ from: pos, to: pos + node.nodeSize });
    });
    if (ranges.length === 0) return;
    let tr = editor.state.tr;
    for (const r of ranges.reverse()) tr = tr.delete(r.from, r.to);
    editor.view.dispatch(tr);
    setDocHtml(editor.getHTML());
    setDirty(true);
  };

  // ── AI Assist (documents) ──────────────────────────────────────────────────
  // The AI returns a PROPOSAL. Nothing changes in the document until the user
  // picks "Use this document" or "Add to the end"; Discard drops it.
  const [assistBusy, setAssistBusy] = useState(false);
  const [aiProposal, setAiProposal] = useState<{ html: string; title: string | null; blanks: string[]; sources: string[]; revised: boolean } | null>(null);
  const [openBlanks, setOpenBlanks] = useState<string[]>([]);
  const askDocumentAi = async (instruction: string) => {
    setAssistBusy(true);
    try {
      // Pictures do not go to the model: each is a marker there and back.
      const sent = picturesToMarkers(cleanDocHtml(docHtml || ""));
      const r = await apiRequest("POST", "/api/workspace/document/assist", { instruction, html: sent.html, title });
      const j = await r.json();
      if (typeof j?.html !== "string" || !j.html.trim()) throw new Error("The AI returned nothing.");
      setAiProposal({
        html: j.revised ? markersToPictures(j.html, sent.pictures) : j.html, title: typeof j.title === "string" ? j.title : null,
        blanks: Array.isArray(j.blanks) ? j.blanks.map(String) : [],
        sources: Array.isArray(j.sources) ? j.sources.map(String) : [],
        revised: !!j.revised,
      });
    } catch (err) {
      toast({ title: "AI couldn't do that", description: aiErrorText(err), variant: "destructive" });
    } finally {
      setAssistBusy(false);
    }
  };
  const insertImageFile = async (file: File | undefined | null) => {
    if (!file || !editor) return;
    try {
      const src = await imageFileToDataUrl(file);
      editor.chain().focus().setImage({ src, alt: file.name.replace(/\.[^.]+$/, "") }).run();
    } catch (err: any) {
      toast({ title: "Couldn't add that picture", description: err?.message || String(err), variant: "destructive" });
    }
  };
  const applyAiProposal = (how: "replace" | "append") => {
    if (!aiProposal || !editor) return;
    if (how === "replace") editor.commands.setContent(aiProposal.html);
    else editor.chain().focus("end").insertContent(aiProposal.html).run();
    setDocHtml(editor.getHTML());
    if (!title.trim() && aiProposal.title) setTitle(aiProposal.title);
    setDirty(true);
    setOpenBlanks(aiProposal.blanks);
    setAiProposal(null);
  };

  // Autosave debounce — only after the user has saved at least once OR is editing
  // an existing artifact. Avoids creating empty drafts.
  useEffect(() => {
    if (!dirty) return;
    // A new document saves itself once there is something in it (an empty
    // one creates no row); a new sheet still waits for its first Save.
    if (!savedId && !(type === "doc" && hasUnsavedWork())) return;
    // Every autosave is quiet: only the Save button may move the URL.
    const t = setTimeout(() => { quietSaveRef.current = true; saveMut.mutate(); }, savedId ? 5000 : 2500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, docHtml, sheet, title, savedId, pageSetup]);

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
  // Controlled AlertDialog state replaces window.confirm() so two rapid clicks
  // of "Delete" cannot race past the modal and fire the mutation twice. The
  // dialog action button is disabled while the mutation is pending.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!savedId) return;
      await apiRequest("DELETE", `/api/artifacts/${savedId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      // Bug #22: keep documents list in sync — backing doc is removed too.
      qc.invalidateQueries({ queryKey: ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      setDeleteOpen(false);
      toast({ title: "Deleted" });
      // Not if the user has already gone elsewhere (same race as the save).
      if (mountedRef.current) setLocation("/artifacts");
    },
    onError: (err: any) => {
      setDeleteOpen(false);
      toast({ title: "Delete failed", description: err?.message, variant: "destructive" });
    },
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
      // Bug #22: duplicate also creates a new backing document row.
      qc.invalidateQueries({ queryKey: ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Copy created" });
      if (mountedRef.current) setLocation(`/editor/${copy.id}`);
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
    const { Document, Packer } = await import("docx");
    const { htmlToDocxBlocks } = await import("@/lib/doc-docx");
    const children = await htmlToDocxBlocks(cleanDocHtml(docHtml || ""), page.widthPx - 2 * page.paddingPx);
    // 1 CSS px = 15 twips (1440 twips per inch at 96 dpi).
    const doc = new Document({
      sections: [{
        properties: { page: {
          size: { width: Math.round(PAGE_SIZES[pageSetup.size].widthPx * 15), height: Math.round(PAGE_SIZES[pageSetup.size].heightPx * 15), orientation: pageSetup.orientation as any },
          margin: { top: page.paddingPx * 15, bottom: page.paddingPx * 15, left: page.paddingPx * 15, right: page.paddingPx * 15 },
        } },
        children,
      }],
    });
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
    wrap.style.width = `${page.widthPx}px`;
    wrap.style.padding = `${page.paddingPx}px`;
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
    body.innerHTML = cleanDocHtml(docHtml || "");
    body.querySelectorAll("table").forEach((t) => { (t as HTMLElement).style.borderCollapse = "collapse"; (t as HTMLElement).style.width = "100%"; });
    body.querySelectorAll("td,th").forEach((c) => { (c as HTMLElement).style.border = "1px solid #999"; (c as HTMLElement).style.padding = "6px 8px"; });
    body.querySelectorAll("img").forEach((im) => { (im as HTMLElement).style.maxWidth = "100%"; });
    wrap.appendChild(body);
    document.body.appendChild(wrap);
    try {
      const canvas = await html2canvas(wrap, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
      });
      const pdf = new jsPDF({ unit: "pt", format: [page.widthPt, page.heightPt], orientation: pageSetup.orientation });
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
  const decodedSheet = useMemo(() => decodeSheetData(sheet), [sheet]);

  // Parse a 1-based A1 range like "A1:C10" or "A:C" into [startRow, startCol, endRow, endCol] (0-based).
  // Returns null on bad input. Empty range or unbounded means full sheet bounds.
  const parseRange = useCallback((s: string): [number, number, number, number] | null => {
    const trimmed = (s || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!trimmed) return [0, 0, decodedSheet.rows - 1, decodedSheet.cols - 1];
    const m = trimmed.match(/^([A-Z]+)(\d*):([A-Z]+)(\d*)$/);
    if (!m) return null;
    const c1 = colLetterToIndex(m[1]);
    const c2 = colLetterToIndex(m[3]);
    const r1 = m[2] ? parseInt(m[2], 10) - 1 : 0;
    const r2 = m[4] ? parseInt(m[4], 10) - 1 : decodedSheet.rows - 1;
    if (c1 < 0 || c2 < 0 || r1 < 0 || r2 < 0) return null;
    return [Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)];
  }, [decodedSheet.rows, decodedSheet.cols]);

  // Resolve a cell to its displayed value. Formulas: pull the parser-evaluated
  // result from the rendered <Spreadsheet> if available; otherwise fall back to raw.
  const resolveCellValue = useCallback((r: number, c: number): any => {
    const cell = decodedSheet.cells[`${r},${c}`];
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
  }, [decodedSheet.cells]);

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
    for (const [key, cell] of Object.entries(decodedSheet.cells)) {
      const match = /^(\d+),(\d+)$/.exec(key);
      if (!match) continue;
      const ref = ws.getCell(Number(match[1]) + 1, Number(match[2]) + 1);
      if (cell.f) ref.value = { formula: cell.f.startsWith("=") ? cell.f.slice(1) : cell.f } as any;
      else if (cell.v !== undefined && cell.v !== null) ref.value = cell.v as any;
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
  const isUniverSheet = type === "sheet" && decodedSheet.format === "univer";
  const initialUniverSnapshot = decodedSheet.univerSnapshot;

  // Live data snapshot — only fetched when in sheet mode. Powers =NETWORTH(),
  // =BUDGET("Groceries"), =TRACKER("Weight"), =DAYSUNTIL("2026-12-31"), etc.
  const sheetSnapshot = useSheetSnapshot(type === "sheet");
  const sheetCreateFormulaParser = useMemo(() => {
    const customFns = buildSheetFunctions(sheetSnapshot);
    return (data: any) => defaultCreateFormulaParser(data, { functions: customFns } as any);
  }, [sheetSnapshot]);

  const docStats = useMemo(() => {
    if (type !== "doc") return "";
    if (typeof DOMParser === "undefined") return "";
    // Inert parse — see downloadDoc. Same text extraction, no side effects.
    const tmp = new DOMParser().parseFromString(docHtml || "", "text/html").body;
    const text = (tmp.textContent || "").trim();
    // Split on any whitespace AND filter out empty tokens. Without the .filter,
    // a stray leading/trailing whitespace (e.g. from a trailing <br>) or a
    // zero-width character would inflate the count by one.
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
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
  if ((loadingExisting || (!!cachedExisting && !existing)) && !isNew) {
    return <WorkspacePortal><div className="fixed inset-0 z-40 bg-background flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div></WorkspacePortal>;
  }

  return (
    <WorkspacePortal>
    <WorkspaceKeyboardProvider value={viewportBox.keyboardOpen}>
    <div className="workspace-surface fixed inset-0 z-40 flex flex-col bg-background overflow-hidden" style={viewportBoxStyle(viewportBox)}
      data-keyboard={viewportBox.keyboardOpen ? "1" : undefined} data-testid="workspace-document" aria-label="Document workspace">
      {/* ───────────────────── Phone header ─────────────────────
          The editors' one header (owner, 2026-11-23): X at the left, the
          title and its save status, undo/redo for a document, the ⋯ menu,
          and Save at the right. It sits outside the scroll area, so it stays
          put however long the document is. */}
      <div
        className="md:hidden flex items-center gap-1 pl-1.5 pr-2 shrink-0 bg-card border-b min-w-0"
        style={{ minHeight: 48, paddingTop: "env(safe-area-inset-top, 0px)" }}
        data-testid="mobile-editor-top-bar"
      >
        <div className="flex-1 min-w-0 flex flex-col justify-center leading-tight">
          <input
            value={title}
            onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
            placeholder={type === "doc" ? "Untitled doc" : "Untitled sheet"}
            className="ws-title w-full min-w-0 bg-transparent text-sm font-semibold outline-none truncate"
            data-testid="input-editor-title"
            aria-label="Document title"
          />
          <span className="text-[11px] text-muted-foreground truncate" role="status" data-testid="text-editor-status-mobile">
            {saveMut.isPending ? "Saving…" : saveState === "error" ? "Couldn't save — tap Retry" : dirty ? "Saving as you write" : (lastSavedAt || savedId ? "Saved" : "Not saved yet")}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => {
            if (type === "doc") editor?.chain().focus().undo().run();
          }}
          disabled={type === "sheet"}
          aria-label={type === "sheet" ? "Undo unavailable in mobile sheet view" : "Undo"}
          title={type === "sheet" ? "Undo is available from the spreadsheet engine on desktop" : undefined}
          data-testid="button-mobile-undo"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => {
            if (type === "doc") editor?.chain().focus().redo().run();
          }}
          disabled={type === "sheet"}
          aria-label={type === "sheet" ? "Redo unavailable in mobile sheet view" : "Redo"}
          title={type === "sheet" ? "Redo is available from the spreadsheet engine on desktop" : undefined}
          data-testid="button-mobile-redo"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="More" data-testid="button-mobile-more">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {type === "doc" && (
              <>
                <DropdownMenuLabel>Templates</DropdownMenuLabel>
                {getTemplatesByType(type).slice(0, 4).map((tpl) => (
                  <DropdownMenuItem key={tpl.id} onClick={() => applyTemplate(tpl)}>
                    <LayoutTemplate className="h-4 w-4 mr-2" /> {tpl.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {type === "sheet" && (
              <DropdownMenuItem onClick={downloadSheet}>
                <Download className="h-4 w-4 mr-2" /> Download CSV
              </DropdownMenuItem>
            )}
            {type === "doc" && (
              <>
                <DropdownMenuItem onClick={downloadDocPdf}><Download className="h-4 w-4 mr-2" /> Download PDF</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadDoc}><Download className="h-4 w-4 mr-2" /> Download Word</DropdownMenuItem>
              </>
            )}
            {savedId && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setShareOpen(true)}><Share2 className="h-4 w-4 mr-2" /> Share</DropdownMenuItem>
                <DropdownMenuItem onClick={() => duplicateMut.mutate()}><Copy className="h-4 w-4 mr-2" /> Duplicate</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => setDeleteOpen(true)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {saveButton}
        <WorkspaceCloseButton onClose={closeWorkspace} onSaveFailed={() => setLeaveWarn(true)} />
      </div>
      {leaveWarn && <UnsavedLeaveBar onStay={() => setLeaveWarn(false)} onLeave={() => { setLeaveWarn(false); setDirty(false); leaveEditor(); }} />}
      {fromWord && type === "doc" && <WorkspaceTabs label="Word sections" tabs={WORD_TABS} active="editor" onPick={(t) => void goWordTab(t)} />}

      {/* Desktop header */}
      <div className="hidden md:flex border-b bg-card items-center gap-2 px-3 py-2 shrink-0">
        {/* BUG-RTE03: make the title obviously editable. The previous default
            Input looked like a static label until hovered; users didn't realise
            they could click into it and rename their doc. Give it a hover/focus
            outline and a pencil hint so the affordance is unambiguous. */}
        <div className="relative group flex-1 md:flex-none md:max-w-md min-w-0">
          <Input
            value={title}
            onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
            placeholder={type === "doc" ? "Untitled doc — click to rename" : "Untitled sheet — click to rename"}
            className="h-9 font-semibold text-base border border-transparent hover:border-border focus:border-primary/60 focus:bg-background bg-transparent pr-7 transition-colors w-full"
            data-testid="input-editor-title"
            aria-label="Document title (click to edit)"
            title="Click to rename"
          />
          <PencilIcon className="h-3.5 w-3.5 text-muted-foreground/40 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none group-hover:text-muted-foreground transition-colors" />
        </div>
        {/* Status line: on mobile we hide the verbose "Doc · N words" and only
            keep a tiny save indicator to maximise space for the title. */}
        <span className="hidden md:inline text-xs text-muted-foreground ml-2" data-testid="text-editor-status">
          {type === "doc" ? "Doc" : "Sheet"}
          {saveMut.isPending ? " · Saving…" : (dirty ? " · Unsaved" : (lastSavedAt ? ` · Saved ${formatRelative(lastSavedAt, nowTick)}` : ""))}
          {type === "doc" && docStats ? ` · ${docStats}` : ""}
          {type === "sheet" ? ` · ${sheetStats} filled` : ""}
        </span>
        <div className="flex-1" />
        {/* Desktop: full action row. Hidden on mobile (<md) — mobile uses the
            single overflow menu below to keep the header clean. */}
        <div className="hidden md:flex items-center gap-1">
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
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)} data-testid="button-editor-delete">
              <Trash2 className="h-4 w-4 mr-1" /> Delete
            </Button>
          )}
        </div>
        {saveButton}
        <WorkspaceCloseButton onClose={closeWorkspace} onSaveFailed={() => setLeaveWarn(true)} />
      </div>

      {/* Body */}
      {/* Wave 16: New sheets (and any sheet previously saved with Univer payload)
          render in the Univer engine — Google-Sheets-equivalent UX.
          Pre-Univer artifacts keep rendering in the legacy view. */}
      {type === "sheet" && (isNew || isUniverSheet) ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Desktop: keep the auto-save status banner. On mobile we hide it
              to match the reference screenshot where the sheet fills the entire
              area between the top bar and the Sheet1 tab. */}
          <div className="hidden md:flex border-b bg-muted/30 px-3 py-1.5 items-center gap-2 shrink-0 text-xs text-muted-foreground">
            <Save className="h-3.5 w-3.5" />
            <span>{isNew ? "New sheet — changes auto-save while you type." : "Sheets engine — changes auto-save."}</span>
          </div>
          {/* Sheet body — wrapped in `gsheet-mobile-skin` on mobile only so the
              Univer canvas gets the black-cell / gray-gridline / gray-header
              treatment from IMG_0418/0419 without touching desktop. */}
          <div className="flex-1 min-h-0 gsheet-mobile-skin md:[&]:bg-transparent">
            {/* Univer is a large third-party canvas engine — isolate its
                crashes so the editor chrome (back button, save) survives. */}
            <SectionErrorBoundary name="editor-sheet" inline>
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
            </SectionErrorBoundary>
          </div>
          {/* Univer's multi-sheet controls are not wired through our snapshot
              adapter on mobile. Show the current sheet as status, not as a
              menu/add-sheet affordance that cannot do anything. */}
          <div
            className="md:hidden bg-card border-t flex items-center shrink-0 px-3 gap-2"
            style={{ height: 48, paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            data-testid="mobile-sheet-tab-bar"
            role="status"
            aria-label={`Current sheet: ${title?.trim() || "Sheet1"}. Additional sheet controls are available on desktop.`}
          >
            <span className="h-8 px-3 rounded-md bg-muted/50 flex items-center text-sm font-medium text-emerald-500" data-testid="mobile-sheet-current">
              {title?.trim() || "Sheet1"}
            </span>
            <span className="text-[11px] text-muted-foreground">Single-sheet mobile view</span>
          </div>
        </div>
      ) : type === "doc" ? (
        <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Toolbar — desktop: top sticky strip, wraps when narrow. Mobile:
              hidden here; we render a clean single-row sticky bottom toolbar
              below the editor content so it sits above the iOS keyboard like
              the reference design. */}
          <div className="hidden md:flex border-b bg-muted/30 px-3 py-1.5 items-center gap-1 flex-wrap shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleBold().run()} aria-pressed={editor?.isActive("bold")} aria-label="Bold" data-testid="button-doc-bold"><Bold className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleItalic().run()} aria-pressed={editor?.isActive("italic")} aria-label="Italic" data-testid="button-doc-italic"><Italic className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleUnderline().run()} aria-pressed={editor?.isActive("underline")} aria-label="Underline" data-testid="button-doc-underline"><UnderlineIcon className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} aria-label="Heading 1" data-testid="button-doc-h1"><Heading1 className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} aria-label="Heading 2" data-testid="button-doc-h2"><Heading2 className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleBulletList().run()} aria-label="Bulleted list" data-testid="button-doc-ul"><List className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleOrderedList().run()} aria-label="Numbered list" data-testid="button-doc-ol"><ListOrdered className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => {
              const url = window.prompt("URL");
              if (url) editor?.chain().focus().setLink({ href: url }).run();
            }} aria-label="Insert link" data-testid="button-doc-link"><LinkIcon className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().toggleCodeBlock().run()} aria-label="Code block" data-testid="button-doc-code"><Code className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().setTextAlign("left").run()} aria-label="Align left" data-testid="button-doc-align-left"><AlignLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().setTextAlign("center").run()} aria-label="Align center" data-testid="button-doc-align-center"><AlignCenter className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => editor?.chain().focus().setTextAlign("right").run()} aria-label="Align right" data-testid="button-doc-align-right"><AlignRight className="h-4 w-4" /></Button>
            <div className="w-px h-5 bg-border mx-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 px-2 gap-1" data-testid="button-doc-table"><TableIcon className="h-4 w-4" /> Table</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} data-testid="menu-table-insert">Insert 3 × 3 table</DropdownMenuItem>
                {editor?.isActive("table") && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => editor.chain().focus().addRowAfter().run()} data-testid="menu-table-add-row">Add row below</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => editor.chain().focus().addColumnAfter().run()} data-testid="menu-table-add-col">Add column to the right</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeaderRow().run()}>Header row on / off</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => editor.chain().focus().deleteRow().run()}>Delete this row</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => editor.chain().focus().deleteColumn().run()}>Delete this column</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => editor.chain().focus().deleteTable().run()} data-testid="menu-table-delete">Delete the table</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm" className="h-8 px-2 gap-1" onClick={() => { const el = imageInputRef.current; if (el) { el.value = ""; el.click(); } }} data-testid="button-doc-image"><ImagePlus className="h-4 w-4" /> Picture</Button>
            <DictateButton testId="button-doc-dictate" className="h-8" onText={(spoken) => editor?.chain().focus().insertContent(`${spoken} `).run()} />
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void insertImageFile(e.target.files?.[0])} data-testid="input-doc-image" />
            <AttachMenu onFiles={(f) => void attachFiles(f)} busy={attaching} testId="doc-attach" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 px-2 gap-1" data-testid="button-doc-page-setup"><FileCog className="h-4 w-4" /> Page</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <p className="micro-label text-muted-foreground px-2 pt-1.5 pb-1">Paper</p>
                {(Object.keys(PAGE_SIZES) as Array<keyof typeof PAGE_SIZES>).map((k) => (
                  <DropdownMenuItem key={k} onClick={() => changePageSetup({ size: k })} data-testid={`menu-page-size-${k}`}>{pageSetup.size === k ? "✓ " : ""}{PAGE_SIZES[k].label}</DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <p className="micro-label text-muted-foreground px-2 pt-1.5 pb-1">Orientation</p>
                <DropdownMenuItem onClick={() => changePageSetup({ orientation: "portrait" })} data-testid="menu-page-portrait">{pageSetup.orientation === "portrait" ? "✓ " : ""}Portrait</DropdownMenuItem>
                <DropdownMenuItem onClick={() => changePageSetup({ orientation: "landscape" })} data-testid="menu-page-landscape">{pageSetup.orientation === "landscape" ? "✓ " : ""}Landscape</DropdownMenuItem>
                <DropdownMenuSeparator />
                <p className="micro-label text-muted-foreground px-2 pt-1.5 pb-1">Margins</p>
                {(Object.keys(PAGE_MARGINS) as Array<keyof typeof PAGE_MARGINS>).map((k) => (
                  <DropdownMenuItem key={k} onClick={() => changePageSetup({ margins: k })} data-testid={`menu-page-margins-${k}`}>{pageSetup.margins === k ? "✓ " : ""}{PAGE_MARGINS[k].label}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* Tiptap content — on mobile we apply doc-mobile-black so the canvas
              renders as pure black like IMG_0420. Desktop keeps the standard
              white/themed background. */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden md:overflow-x-auto overscroll-contain doc-page-desk" data-workspace-scroll>
            <div
              className="doc-page relative px-3 pt-3 pb-8 doc-mobile-black md:!text-foreground min-h-full"
              style={{ "--page-w": `${page.widthPx}px`, "--page-h": `${page.heightPx}px`, "--page-pad": `${page.paddingPx}px` } as CSSProperties}
              data-page-setup={serializePageSetup(pageSetup)}
              onDragOver={(e) => { if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault(); }}
              onDrop={(e) => {
                const img = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith("image/"));
                if (!img) return;
                e.preventDefault();
                void insertImageFile(img);
              }}
              data-testid="doc-editor-canvas"
            >
              {!(editor?.getText() || "").trim() && !docFocused && (
                <p className="absolute right-3 md:right-auto pointer-events-none text-muted-foreground/60 text-sm" data-testid="doc-empty-hint">
                  Start typing, choose a template, or ask AI to create something…
                </p>
              )}
              <SectionErrorBoundary name="editor-doc" inline>
                <EditorContent editor={editor} className="workspace-writing prose prose-sm max-w-none focus:outline-none [&_.ProseMirror]:min-h-[60vh] [&_.ProseMirror]:outline-none" />
              </SectionErrorBoundary>
              {docAttachments.length > 0 && (
                <div className="mt-4 pt-2 border-t border-border/60 space-y-1.5 not-prose" data-testid="doc-attachments">
                  <p className="micro-label text-muted-foreground">Attached files</p>
                  {docAttachments.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 h-9 pl-2 pr-1 rounded-lg border border-border bg-muted/30 min-w-0" data-testid={`doc-attachment-${a.id}`}>
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <button type="button" className="flex-1 min-w-0 text-left text-xs truncate hover:underline" title="Open in Documents"
                        onClick={async () => { if (dirty) { quietSaveRef.current = true; try { await saveMut.mutateAsync(); } catch { return; } } setLocation(`/documents/${a.id}`); }}>
                        {a.name}
                      </button>
                      <button type="button"
                        onClick={() => { if (armedAttachment === a.id) { setArmedAttachment(null); detachFile(a.id); } else setArmedAttachment(a.id); }}
                        aria-label={armedAttachment === a.id ? "Tap again to remove this file from the document" : "Remove file"}
                        className={`h-7 rounded-full text-[11px] px-2 shrink-0 ${armedAttachment === a.id ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                        {armedAttachment === a.id ? "Remove?" : "✕"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* AI Assist: the proposal, then the box that asks for one. */}
          {aiProposal && (
            <div className="border-t bg-card px-4 py-3 shrink-0 max-h-[45vh] overflow-y-auto" data-testid="doc-ai-proposal">
              <p className="text-xs font-semibold mb-1">
                AI {aiProposal.revised ? "revision" : "draft"}{aiProposal.title ? ` · ${aiProposal.title}` : ""} — your document is unchanged until you choose
              </p>
              <p className="text-[11px] text-muted-foreground mb-2">
                {aiProposal.sources.length > 0 ? `Written from ${aiProposal.sources.join(", ")}.` : "No saved information was used."}
                {aiProposal.blanks.length > 0 && ` Not on file, left as marked blanks (nothing was guessed): ${aiProposal.blanks.join(", ")}.`}
              </p>
              <div
                className="prose prose-sm max-w-none rounded-md border bg-background p-3"
                dangerouslySetInnerHTML={{ __html: cleanDocHtml(aiProposal.html) }}
              />
              <div className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" onClick={() => applyAiProposal("replace")} data-testid="button-doc-ai-replace">
                  {aiProposal.revised ? "Replace my document with this" : "Use this document"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => applyAiProposal("append")} data-testid="button-doc-ai-append">Add to the end</Button>
                <Button size="sm" variant="ghost" onClick={() => setAiProposal(null)} data-testid="button-doc-ai-discard">Discard</Button>
              </div>
            </div>
          )}
          {openBlanks.length > 0 && !aiProposal && (
            <div className="border-t bg-amber-500/10 px-4 py-2 text-xs flex items-center gap-2 shrink-0" data-testid="doc-open-blanks">
              <span className="flex-1">Still to fill in — look for [Missing: …]: {openBlanks.join(", ")}</span>
              <button type="button" className="underline" onClick={() => setOpenBlanks([])}>Hide</button>
            </div>
          )}
          <WorkspaceAiBar
            placeholder="Ask AI to help with this document…"
            busy={assistBusy}
            onAsk={(i) => void askDocumentAi(i)}
            testId="doc-ai"
          />
          {/* Phone formatting bar: one row under the page that scrolls
              sideways, so no control falls off a small screen; the frame
              follows the visual viewport, so it rides above the keyboard. */}
          <div
            className="md:hidden border-t bg-card flex items-center gap-0.5 px-1 shrink-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
            style={{ height: 44, paddingBottom: viewportBox.keyboardOpen ? 0 : "env(safe-area-inset-bottom, 0px)", boxSizing: "content-box" }}
            data-swipe-ignore
            data-testid="toolbar-doc-mobile"
          >
            <AttachMenu onFiles={(f) => void attachFiles(f)} busy={attaching} testId="doc-attach-mobile" label="" />
            <DictateButton testId="button-doc-dictate-mobile" className="h-8" onText={(spoken) => editor?.chain().focus().insertContent(`${spoken} `).run()} />
            <div className="w-px h-6 bg-border mx-0.5 shrink-0" />
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleBold().run()} aria-pressed={editor?.isActive("bold")} aria-label="Bold"><Bold className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleItalic().run()} aria-pressed={editor?.isActive("italic")} aria-label="Italic"><Italic className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleUnderline().run()} aria-pressed={editor?.isActive("underline")} aria-label="Underline"><UnderlineIcon className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleStrike().run()} aria-pressed={editor?.isActive("strike")} aria-label="Strikethrough"><Strikethrough className="h-4 w-4" /></Button>
            <div className="w-px h-6 bg-border mx-0.5 shrink-0" />
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} aria-pressed={editor?.isActive("heading", { level: 1 })} aria-label="Heading" data-testid="button-doc-heading"><Heading1 className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} aria-pressed={editor?.isActive("heading", { level: 2 })} aria-label="Subheading"><Heading2 className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleBulletList().run()} aria-pressed={editor?.isActive("bulletList")} aria-label="Bulleted list" data-testid="button-doc-list"><List className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().toggleOrderedList().run()} aria-pressed={editor?.isActive("orderedList")} aria-label="Numbered list"><ListOrdered className="h-4 w-4" /></Button>
            <div className="w-px h-6 bg-border mx-0.5 shrink-0" />
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().setTextAlign("left").run()} aria-label="Align left"><AlignLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().setTextAlign("center").run()} aria-label="Align center"><AlignCenter className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => {
              const url = window.prompt("Link address");
              if (url) editor?.chain().focus().setLink({ href: url }).run();
            }} aria-label="Insert link"><LinkIcon className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => editor?.chain().focus().insertContent("@").run()} aria-label="Mention" data-testid="button-doc-mention"><AtSign className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 relative" onClick={() => setLinksOpen(true)} aria-label="Linked entities" title="Show linked entities" data-testid="button-doc-links">
              <Link2 className="h-4 w-4" />
              {mentionTokens.length > 0 && (
                <span className="absolute text-[11px] font-semibold bg-primary text-primary-foreground rounded-full" style={{ minWidth: 14, height: 14, lineHeight: "14px", textAlign: "center", top: 2, right: 2, paddingLeft: 3, paddingRight: 3 }}>
                  {mentionTokens.length}
                </span>
              )}
            </Button>
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
                        <div className="micro-label px-2 pt-2 pb-1 text-muted-foreground">
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
                <DropdownMenuLabel className="micro-label text-muted-foreground">Number</DropdownMenuLabel>
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
              aria-label="Add sheet"
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

      {/* Delete confirmation — controlled dialog replaces window.confirm() so
          double-clicking Delete can’t race the modal and fire two deletes. */}
      <AlertDialog open={deleteOpen} onOpenChange={(o) => { if (!deleteMut.isPending) setDeleteOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this artifact?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the {type === "doc" ? "document" : "sheet"} and its history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMut.isPending}
              onClick={(e) => { e.preventDefault(); deleteMut.mutate(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-editor-delete-confirm"
            >
              {deleteMut.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

    </div>
    </WorkspaceKeyboardProvider>
    </WorkspacePortal>
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
    // Collapsed rail is desktop-only — on mobile we hide it entirely because the
    // bottom toolbar already provides a Linked button.
    return (
      <div className="hidden md:flex border-l bg-muted/20 flex-col items-center w-9 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 mt-2"
          onClick={onToggle}
          title="Show linked entities"
          aria-label="Show linked entities"
          data-testid="button-toggle-links-sidebar"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Mobile backdrop — tap to close. Hidden on desktop. */}
      {/* Decorative scrim: hidden from assistive tech (the panel has its own
          labelled close button); keyboard users close via that button. */}
      <div
        className="md:hidden fixed inset-0 z-40 bg-black/40"
        onClick={onToggle}
        aria-hidden="true"
        data-testid="backdrop-links-sidebar"
      />
    <div
      className="fixed md:static top-0 right-0 bottom-0 z-50 md:z-auto w-[85vw] max-w-[320px] md:w-72 border-l bg-card md:bg-muted/20 flex flex-col shrink-0 overflow-hidden shadow-xl md:shadow-none"
    >
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
          aria-label="Hide linked entities sidebar"
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
                <div className="micro-label px-2 pb-1 text-muted-foreground">
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
    </>
  );
}
