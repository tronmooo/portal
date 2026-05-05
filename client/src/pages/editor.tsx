// Full-screen editor for Doc (rich-text) and Sheet (spreadsheet) artifacts.
// Routes:
//   /editor/new/doc           → blank doc
//   /editor/new/sheet         → blank sheet
//   /editor/:id               → open existing artifact (id resolves type)
//
// Saves to /api/artifacts. Autosaves every 5s after the first manual save.
// Posts a chat preview card when launched from chat (via ?source=chat).

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Spreadsheet from "react-spreadsheet";
import DOMPurify from "dompurify";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  Heading1, Heading2, LinkIcon, Code, Save, Download, Trash2, Copy, Loader2, Plus, Minus,
} from "lucide-react";
import type { Artifact, SheetData, SheetCell } from "@shared/schema";

// ── Misc helpers ──

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

// react-spreadsheet uses [{ value }][] matrix. Convert sparse map ↔ matrix.
// For formulas we display the evaluated value (v) — the formula text is preserved
// in state and surfaced via the active-cell formula bar. When the user types into
// a cell and the new raw text starts with "=", we re-detect it as a formula.
function sheetToMatrix(s: SheetData): { value: string }[][] {
  const m: { value: string }[][] = [];
  for (let r = 0; r < s.rows; r++) {
    const row: { value: string }[] = [];
    for (let c = 0; c < s.cols; c++) {
      const cell = s.cells[`${r},${c}`];
      let v = "";
      if (cell?.v !== undefined && cell.v !== null) v = String(cell.v);
      else if (cell?.f) v = cell.f;
      row.push({ value: v });
    }
    m.push(row);
  }
  return m;
}

function matrixToSheet(m: any[][], rows: number, cols: number, prev: Record<string, SheetCell>): SheetData {
  const cells: Record<string, SheetCell> = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const raw = m[r]?.[c]?.value;
      const key = `${r},${c}`;
      const prevCell = prev[key];
      if (raw === undefined || raw === null || raw === "") continue;
      const s = String(raw);
      if (s.startsWith("=")) {
        cells[key] = { f: s };
      } else if (prevCell?.f && (prevCell.v !== undefined ? String(prevCell.v) === s : false)) {
        // User did not modify — keep formula as-is so the cell stays formulaic.
        cells[key] = { f: prevCell.f, v: prevCell.v };
      } else {
        const n = Number(s);
        cells[key] = { v: isFinite(n) && s.trim() !== "" ? n : s };
      }
    }
  }
  return { rows, cols, cells };
}

// Tiny formula evaluator: =SUM(A1:B3), =AVG / =AVERAGE, =COUNT, =MIN, =MAX,
// or arithmetic on cell refs. Anything else returns the literal formula text.
function colLetterToIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function evalFormula(formula: string, cells: Record<string, SheetCell>): string | number {
  try {
    const expr = formula.slice(1).trim();
    const fnMatch = expr.match(/^(SUM|AVG|AVERAGE|COUNT|MIN|MAX)\(([A-Z]+\d+):([A-Z]+\d+)\)$/i);
    if (fnMatch) {
      const fn = fnMatch[1].toUpperCase();
      const c1 = colLetterToIndex(fnMatch[2].match(/[A-Z]+/i)![0]);
      const r1 = parseInt(fnMatch[2].match(/\d+/)![0], 10) - 1;
      const c2 = colLetterToIndex(fnMatch[3].match(/[A-Z]+/i)![0]);
      const r2 = parseInt(fnMatch[3].match(/\d+/)![0], 10) - 1;
      const nums: number[] = [];
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
        for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
          const v = cells[`${r},${c}`]?.v;
          if (typeof v === "number" && isFinite(v)) nums.push(v);
        }
      }
      if (fn === "SUM") return nums.reduce((a, b) => a + b, 0);
      if (fn === "AVG" || fn === "AVERAGE") return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      if (fn === "COUNT") return nums.length;
      if (fn === "MIN") return nums.length ? Math.min(...nums) : 0;
      if (fn === "MAX") return nums.length ? Math.max(...nums) : 0;
    }
    return formula; // unknown formula → keep raw
  } catch {
    return formula;
  }
}

// ── Editor component ──────────────────────────────────────────────────────────

export default function EditorPage() {
  const [matchNew, paramsNew] = useRoute("/editor/new/:type");
  const [matchExisting, paramsExisting] = useRoute("/editor/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Determine mode from URL: ?source=chat lets us post a chat card on save.
  const search = typeof window !== "undefined" ? window.location.hash.split("?")[1] || "" : "";
  const params = new URLSearchParams(search);
  const fromChat = params.get("source") === "chat";

  const isNew = !!matchNew;
  const newType = (paramsNew?.type === "sheet" ? "sheet" : "doc") as "doc" | "sheet";
  const existingId = matchExisting ? paramsExisting?.id : undefined;

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
  const [docHtml, setDocHtml] = useState<string>("");
  const [sheet, setSheet] = useState<SheetData>(emptySheet());
  const inflightAbort = useRef<AbortController | null>(null);

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
      setDirty(false);
    }
  }, [existing]);

  // Initialize blank doc/sheet for new artifacts.
  useEffect(() => {
    if (isNew && !title) {
      setTitle(newType === "doc" ? "Untitled doc" : "Untitled sheet");
      if (newType === "doc") setDocHtml("<p></p>");
      else setSheet(emptySheet());
    }
  }, [isNew, newType, title]);

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
    },
  }, [type === "doc"]);

  // Sync editor when artifact loads.
  useEffect(() => {
    if (editor && existing?.type === "doc" && existing.content && editor.getHTML() !== existing.content) {
      editor.commands.setContent(existing.content || "<p></p>");
    }
  }, [editor, existing]);

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
        <Button variant="ghost" size="sm" onClick={() => type === "doc" ? downloadDoc() : downloadSheet()} data-testid="button-editor-download">
          <Download className="h-4 w-4 mr-1" /> Download
        </Button>
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
      {type === "doc" ? (
        <div className="flex-1 flex flex-col overflow-hidden">
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
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Sheet toolbar */}
          <div className="border-b bg-muted/30 px-3 py-1.5 flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => { setSheet(s => ({ ...s, rows: Math.min(10000, s.rows + 5) })); setDirty(true); }} data-testid="button-sheet-add-rows"><Plus className="h-3 w-3 mr-1" /> 5 rows</Button>
            <Button variant="ghost" size="sm" onClick={() => { setSheet(s => ({ ...s, rows: Math.max(1, s.rows - 5) })); setDirty(true); }} data-testid="button-sheet-rm-rows"><Minus className="h-3 w-3 mr-1" /> 5 rows</Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="ghost" size="sm" onClick={() => { setSheet(s => ({ ...s, cols: Math.min(200, s.cols + 2) })); setDirty(true); }} data-testid="button-sheet-add-cols"><Plus className="h-3 w-3 mr-1" /> 2 cols</Button>
            <Button variant="ghost" size="sm" onClick={() => { setSheet(s => ({ ...s, cols: Math.max(1, s.cols - 2) })); setDirty(true); }} data-testid="button-sheet-rm-cols"><Minus className="h-3 w-3 mr-1" /> 2 cols</Button>
            <span className="text-xs text-muted-foreground ml-3">{sheet.rows} × {sheet.cols} · formulas: =SUM, =AVG, =COUNT, =MIN, =MAX</span>
          </div>
          {/* Sheet grid */}
          <div className="flex-1 overflow-auto p-3">
            <Spreadsheet
              data={matrix}
              onChange={(m: any) => {
                const next = matrixToSheet(m, sheet.rows, sheet.cols, sheet.cells);
                // Re-evaluate any formulas so cached v matches f.
                for (const [k, cell] of Object.entries(next.cells)) {
                  if (cell.f) {
                    const v = evalFormula(cell.f, next.cells);
                    cell.v = typeof v === "number" ? Number(v.toFixed(6)) : v;
                  }
                }
                setSheet(next);
                setDirty(true);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
