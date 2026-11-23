// Fill In workspace (owner request 2026-11-23: "Completely repair the Fill-In
// process … the completed file must contain the information, save correctly,
// reopen correctly").
//
// One screen, three stages:
//   start  — drop or pick a form (PDF, Word .docx, a photo or screenshot), or
//            continue one that was completed before.
//   edit   — the FORM, with its fields on it, beside "My Information": every
//            fact the user has on file with its source. Fields are filled
//            automatically; any of them can be tapped and changed, a fact can
//            be dragged (or tapped, on a phone) onto a field, a drawn value can
//            be moved and resized, and there is undo / redo.
//   saved  — the SAVED file itself, opened from Documents, after the server
//            reopened it and found every value in it.
//
// Rules it keeps:
//  - Opening writes nothing (Rule 3). Reading older uploads, analysing and
//    saving all start from the user's own action (choosing a file, Save).
//  - Nothing is invented: a value is a fact on file, or typed by the user.
//  - A sensitive value (an ID or account number) is proposed but is only
//    written once the user confirms it.
//  - Success is the server's verification of the saved file, never the
//    preview: a failed save says which values are missing and saves nothing.
//  - Destructive actions take two taps (Rule 8); a failed list is an error
//    with a retry, never "nothing on file" (Rule 7).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle, CheckCircle2, Download, Eye, EyeOff, FileUp, List as ListIcon, Loader2, Move, PanelRightOpen, Plus, Redo2,
  Search, ShieldAlert, Sparkles, Trash2, Undo2, X, FileText, Maximize2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useDocumentBlobUrl } from "@/lib/document-preview";
import { takePendingFillFile } from "@/lib/fill-handoff";
import PdfCanvas from "@/components/PdfCanvas";
import { WorkspaceShell, aiErrorText, leaveWorkspace, readFileAsDataUrl } from "@/components/workspace/WorkspaceShell";
import { FillPdfPages, extractTextPages, type PageBox } from "@/components/fill/FillPdfPages";
import { FILL_CATEGORIES, factFitsKind, formatFormDate, maskValue, searchFacts, type FillCategory, type FillFact } from "@shared/fill-info";
import { clampBox, isWritable, type FillField } from "@shared/fill-fields";

export const FILL_MAX_BYTES = 10 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** What Fill In can fill: a PDF, a Word .docx, or a photo / screenshot of a form. */
export function isFillableFile(file: { type: string; name: string }): boolean {
  return file.type === "application/pdf" || file.type.startsWith("image/") || file.type === DOCX_MIME || /\.(pdf|docx|png|jpe?g|webp|gif|heic)$/i.test(file.name);
}

interface Information {
  facts: FillFact[];
  subject: { id: string | null; name: string };
  people: Array<{ id: string; name: string; self: boolean }>;
  unindexed: number;
  counts: { profiles: number; documents: number; notes: number };
}
interface Working { name: string; mimeType: string; base64: string; format: "pdf" | "docx"; paragraphs?: string[]; originalDocumentId?: string }
interface Saved { documentId: string; name: string; mimeType: string; originalDocumentId: string; verification: { expected: number; found: number; ok: boolean }; notes: string[] }
interface History { past: FillField[][]; present: FillField[]; future: FillField[][] }

const stripDataUrl = (s: string) => (s.includes(",") ? s.slice(s.indexOf(",") + 1) : s);
const isYes = (v: string) => /^(yes|y|true|x|on|checked|1)$/i.test(String(v || "").trim());
const movable = (f: FillField) => f.origin === "text" || f.origin === "vision" || f.origin === "manual";

export default function FillWorkspacePage() {
  useEffect(() => { document.title = "Fill In — Portol"; }, []);
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();

  const [forId, setForId] = useState<string>("");
  const infoQuery = useQuery<Information>({
    queryKey: ["/api/smart-fill/information", forId],
    queryFn: () => apiRequest("GET", `/api/smart-fill/information${forId ? `?for=${encodeURIComponent(forId)}` : ""}`).then((r) => r.json()),
  });
  const formsQuery = useQuery<Array<{ id: string; name: string; savedAt: string; filled: number; editable: boolean }>>({ queryKey: ["/api/smart-fill/forms"] });
  const info = infoQuery.data;
  const facts = Array.isArray(info?.facts) ? info!.facts : [];

  const [working, setWorking] = useState<Working | null>(null);
  const [hist, setHist] = useState<History>({ past: [], present: [], future: [] });
  const fields = hist.present;
  const [busy, setBusy] = useState<{ text: string; skippable?: boolean } | null>(null);
  const skipIndex = useRef(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState<FillFact | null>(null);
  const [dragFact, setDragFact] = useState<FillFact | null>(null);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<"page" | "list">("page");
  const [panelOpen, setPanelOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [replaces, setReplaces] = useState<string | undefined>(undefined);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── history ──
  const lastTag = useRef<{ tag: string; at: number } | null>(null);
  /** Change the fields. Edits with the same `tag` made within a moment are one undo step. */
  const commit = useCallback((next: FillField[] | ((cur: FillField[]) => FillField[]), tag?: string) => {
    setHist((h) => {
      const value = typeof next === "function" ? next(h.present) : next;
      const same = !!tag && lastTag.current?.tag === tag && Date.now() - lastTag.current.at < 1500;
      lastTag.current = tag ? { tag, at: Date.now() } : null;
      return { past: same ? h.past : [...h.past.slice(-80), h.present], present: value, future: [] };
    });
    setDirty(true);
    setShowSaved(false);
  }, []);
  const undo = () => { lastTag.current = null; setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)); setDirty(true); };
  const redo = () => { lastTag.current = null; setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)); setDirty(true); };
  const patchField = (id: string, patch: Partial<FillField>, tag?: string) => commit((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)), tag);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const filledCount = fields.filter(isWritable).length;
  const waiting = fields.filter((f) => f.sensitive && !f.confirmed && f.value).length;
  const fillable = fields.filter((f) => f.kind !== "signature").length;

  // ── opening a form ──
  const openFile = async (file: { name: string; mimeType: string; base64: string }) => {
    skipIndex.current = false;
    setSaved(null); setShowSaved(false); setSaveError(null); setAiNote(null); setReplaces(undefined); setSelectedId(null);
    try {
      // 1. Read uploads Fill In has never read (old ones too), so they can be used.
      let remaining = info?.unindexed ?? 0;
      while (remaining > 0 && !skipIndex.current) {
        setBusy({ text: `Reading your saved files so they can be used — ${remaining} left`, skippable: true });
        const r = await apiRequest("POST", "/api/smart-fill/index", { max: 2 });
        const j = await r.json();
        if (!(Number(j?.indexed) + Number(j?.failed) > 0)) break;
        remaining = Number(j?.remaining) || 0;
      }
      // 2. Find the form's fields and fill them.
      setBusy({ text: "Finding the fields and filling them from your information…" });
      const isPdf = file.mimeType === "application/pdf" || /\.pdf$/i.test(file.name);
      let textPages: unknown;
      if (isPdf) { try { textPages = await extractTextPages(file.base64); } catch { textPages = undefined; } }
      const r = await apiRequest("POST", "/api/smart-fill/analyze", { fileName: file.name, mimeType: file.mimeType, fileData: file.base64, textPages, forProfileId: forId || undefined });
      const j = await r.json();
      if (!Array.isArray(j?.fields)) throw new Error("The form could not be read.");
      const w = j.workingFile && typeof j.workingFile.base64 === "string" ? j.workingFile : null;
      setWorking({ name: file.name, mimeType: w ? w.mimeType : j.format === "docx" ? DOCX_MIME : "application/pdf", base64: w ? w.base64 : file.base64, format: j.format === "docx" ? "docx" : "pdf", paragraphs: j.paragraphs });
      setHist({ past: [], present: j.fields, future: [] });
      setView(j.format === "docx" ? "list" : "page");
      setAiNote(j.fields.length === 0
        ? "No fields were found on this form. Use “Add text” to place values on the page yourself."
        : typeof j.aiNote === "string" ? j.aiNote : null);
      setDirty(j.fields.some((f: FillField) => isWritable(f)));
      void infoQuery.refetch();
    } catch (err) {
      toast({ title: "Fill In couldn't open that form", description: aiErrorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const take = async (f: File | undefined | null) => {
    if (!f) return;
    if (!isFillableFile(f)) {
      toast({ title: "That file can't be filled in", description: "Fill In takes PDF forms, Word (.docx) forms, and photos or screenshots of a form.", variant: "destructive" });
      return;
    }
    if (f.size > FILL_MAX_BYTES) { toast({ title: "File too large", description: "Fill In takes files up to 10 MB.", variant: "destructive" }); return; }
    setBusy({ text: "Reading the file…" });
    try {
      const base64 = stripDataUrl(await readFileAsDataUrl(f));
      await openFile({ name: f.name, mimeType: f.type || (/\.docx$/i.test(f.name) ? DOCX_MIME : /\.pdf$/i.test(f.name) ? "application/pdf" : "image/jpeg"), base64 });
    } catch (err) {
      setBusy(null);
      toast({ title: "Couldn't read that file", description: aiErrorText(err), variant: "destructive" });
    }
  };

  // A file handed over from chat or a profile's "Fill a form" button: the user already chose it there.
  const handedOver = useRef(false);
  useEffect(() => {
    if (handedOver.current || !infoQuery.isFetched) return;
    handedOver.current = true;
    const pending = takePendingFillFile();
    if (pending) void openFile(pending);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoQuery.isFetched]);

  const reopen = async (id: string) => {
    setBusy({ text: "Opening the completed form…" });
    try {
      const r = await apiRequest("GET", `/api/smart-fill/session/${id}`);
      const j = await r.json();
      if (!Array.isArray(j?.fields) || typeof j.originalBase64 !== "string") throw new Error("That form could not be reopened.");
      setWorking({ name: j.name, mimeType: j.mimeType, base64: j.originalBase64, format: j.format === "docx" ? "docx" : "pdf", paragraphs: j.paragraphs, originalDocumentId: j.originalDocumentId });
      setHist({ past: [], present: j.fields, future: [] });
      setView(j.format === "docx" ? "list" : "page");
      setReplaces(j.completedDocumentId);
      setForId(j.forProfileId || "");
      setSaved(null); setShowSaved(false); setSaveError(null); setAiNote(null); setDirty(false); setSelectedId(null);
    } catch (err) {
      toast({ title: "Couldn't reopen that form", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(null); }
  };

  // ── filling ──
  const putFact = (fieldId: string, fact: FillFact) => {
    const f = fields.find((x) => x.id === fieldId);
    if (!f || f.kind === "signature") return;
    if (!factFitsKind(fact, f.kind) && (f.kind === "checkbox" || f.kind === "radio")) { toast({ title: "That can't go in a tick box" }); return; }
    patchField(fieldId, {
      value: f.kind === "date" ? formatFormDate(fact.value) : fact.value,
      factId: fact.id, source: fact.source.name, sourceId: fact.source.id, filledBy: "user",
      // Placed by hand: that IS the confirmation.
      sensitive: fact.sensitive || undefined, confirmed: fact.sensitive ? true : undefined, alternatives: undefined,
    });
    setSelectedId(fieldId);
    setPlacing(null); setDragFact(null);
  };
  const addBox = (page: number, x: number, y: number, fact?: FillFact | null) => {
    const id = `m${Date.now().toString(36)}`;
    const box = clampBox({ x, y: y - 0.011, w: 0.32, h: 0.022 });
    commit((cur) => [...cur, {
      id, label: fact ? fact.label : "Text", kind: "text", page, box, origin: "manual", value: fact ? fact.value : "", filledBy: "user",
      ...(fact ? { factId: fact.id, source: fact.source.name, sourceId: fact.source.id, ...(fact.sensitive ? { sensitive: true, confirmed: true } : {}) } : {}),
    } as FillField]);
    setSelectedId(id); setAdding(false); setPlacing(null); setDragFact(null);
  };
  const pagePoint = (el: HTMLElement, clientX: number, clientY: number) => { const r = el.getBoundingClientRect(); return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }; };

  const autoFill = async () => {
    if (!working) return;
    setBusy({ text: "Filling the empty fields from your information…" });
    try {
      const r = await apiRequest("POST", "/api/smart-fill/refill", { fileName: working.name, fields, forProfileId: forId || undefined });
      const j = await r.json();
      if (!Array.isArray(j?.fields)) throw new Error("Auto-fill returned nothing.");
      const before = fields.filter((f) => f.value).length;
      commit(j.fields);
      const added = j.fields.filter((f: FillField) => f.value).length - before;
      setAiNote(typeof j.aiNote === "string" ? j.aiNote : null);
      toast({ title: added > 0 ? `Filled ${added} more field${added === 1 ? "" : "s"}` : "Nothing more on file for the empty fields" });
    } catch (err) {
      toast({ title: "Auto-fill didn't finish", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(null); }
  };
  const clearAll = () => commit((cur) => cur.map((f) => ({ ...f, value: "", factId: undefined, source: undefined, sourceId: undefined, sensitive: undefined, confirmed: undefined, alternatives: undefined, filledBy: undefined })));
  const clearField = (id: string) => patchField(id, { value: "", factId: undefined, source: undefined, sourceId: undefined, sensitive: undefined, confirmed: undefined, alternatives: undefined, filledBy: undefined });

  // ── move / resize a drawn value ──
  const drag = useRef<{ id: string; mode: "move" | "resize"; x: number; y: number; box: FillField["box"]; w: number; h: number; before: FillField[] } | null>(null);
  const startDrag = (e: React.PointerEvent, f: FillField, mode: "move" | "resize") => {
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-fill-page]") as HTMLElement | null;
    if (!pageEl) return;
    e.preventDefault(); e.stopPropagation();
    const r = pageEl.getBoundingClientRect();
    drag.current = { id: f.id, mode, x: e.clientX, y: e.clientY, box: f.box, w: r.width, h: r.height, before: fields };
    const move = (ev: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const dx = (ev.clientX - d.x) / d.w, dy = (ev.clientY - d.y) / d.h;
      const box = d.mode === "move" ? clampBox({ ...d.box, x: d.box.x + dx, y: d.box.y + dy }) : clampBox({ ...d.box, w: Math.max(0.03, d.box.w + dx), h: Math.max(0.012, d.box.h + dy) });
      setHist((h) => ({ ...h, present: h.present.map((x) => (x.id === d.id ? { ...x, box } : x)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      const d = drag.current; drag.current = null;
      if (d) { setHist((h) => ({ past: [...h.past.slice(-80), d.before], present: h.present, future: [] })); setDirty(true); setShowSaved(false); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  // ── saving ──
  const save = async (): Promise<boolean> => {
    if (!working) return false;
    setSaveState("saving"); setSaveError(null);
    try {
      const r = await apiRequest("POST", "/api/smart-fill/save", {
        fileName: working.name, mimeType: working.mimeType,
        ...(working.originalDocumentId ? { originalDocumentId: working.originalDocumentId } : { fileData: working.base64 }),
        fields, forProfileId: forId || undefined, replacesDocumentId: replaces,
      });
      const j = await r.json();
      if (!j?.documentId || !j?.verification?.ok) throw new Error("The save was not confirmed.");
      setSaved(j); setShowSaved(true); setDirty(false); setSaveState("idle");
      setReplaces(j.documentId);
      setWorking((w) => (w ? { ...w, originalDocumentId: j.originalDocumentId } : w));
      void invalidateDomain("documents");
      return true;
    } catch (err) {
      setSaveState("error");
      setSaveError(aiErrorText(err));
      return false;
    }
  };

  const startOver = () => { setWorking(null); setHist({ past: [], present: [], future: [] }); setSaved(null); setShowSaved(false); setSaveError(null); setAiNote(null); setSelectedId(null); setReplaces(undefined); setDirty(false); };

  // ── the fields on a page ──
  const highlightFact = dragFact || placing;
  const renderField = (f: FillField, box: PageBox) => {
    const isSel = f.id === selectedId;
    const hpx = f.box.h * box.heightPx;
    const fontSize = Math.max(6, Math.min(15, hpx * 0.68));
    const needs = !!f.sensitive && !f.confirmed && !!f.value;
    const fits = highlightFact ? factFitsKind(highlightFact, f.kind) : false;
    const shown = f.kind === "checkbox" ? (isYes(f.value) ? "✕" : "") : f.kind === "signature" ? "sign by hand" : needs ? maskValue(f.value) : f.value;
    return (
      <div key={f.id} className="absolute" style={{ left: `${f.box.x * 100}%`, top: `${f.box.y * 100}%`, width: `${f.box.w * 100}%`, height: `${f.box.h * 100}%`, minHeight: 10, zIndex: isSel ? 3 : 1 }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (placing) { putFact(f.id, placing); return; } if (f.kind === "checkbox") { patchField(f.id, { value: isYes(f.value) ? "" : "yes", filledBy: "user" }); } setSelectedId(f.id); }}
          onDragOver={(e) => { if (dragFact && fits) e.preventDefault(); }}
          onDrop={(e) => { if (dragFact) { e.preventDefault(); e.stopPropagation(); putFact(f.id, dragFact); } }}
          title={`${f.label}${f.source ? ` — from ${f.source}` : ""}`}
          aria-label={`${f.label}: ${f.kind === "checkbox" ? (isYes(f.value) ? "ticked" : "not ticked") : f.value ? (needs ? "private value, tap to confirm" : f.value) : "empty"}`}
          className={`absolute inset-0 w-full text-left overflow-hidden whitespace-nowrap rounded-[2px] leading-none px-[2px] text-slate-900 ${
            f.kind === "signature" ? "bg-slate-300/30 text-slate-500 italic"
              : needs ? "bg-amber-300/60"
              : f.value ? "bg-sky-200/45" : "bg-yellow-200/45"
          } ${isSel ? "outline outline-2 outline-sky-600" : highlightFact && fits ? "outline outline-2 outline-emerald-500 bg-emerald-200/60" : "outline outline-1 outline-slate-400/50"} ${f.kind === "multiline" ? "whitespace-pre-wrap leading-tight items-start" : ""}`}
          style={{ fontSize, textAlign: f.kind === "checkbox" ? "center" : "left" }}
          data-testid={`fill-field-${f.id}`}
          data-filled={f.value && !needs ? "1" : "0"}
        >
          {shown}
        </button>
        {isSel && movable(f) && (
          <>
            <span onPointerDown={(e) => startDrag(e, f, "move")} role="button" aria-label="Move this value" title="Drag to move"
              className="absolute -top-5 -left-1 h-5 w-5 rounded-full bg-sky-600 text-white flex items-center justify-center cursor-move touch-none" data-testid="fill-handle-move"><Move className="h-3 w-3" /></span>
            <span onPointerDown={(e) => startDrag(e, f, "resize")} role="button" aria-label="Resize this value" title="Drag to resize"
              className="absolute -bottom-4 -right-4 h-5 w-5 rounded-full bg-sky-600 text-white flex items-center justify-center cursor-nwse-resize touch-none" data-testid="fill-handle-resize"><Maximize2 className="h-3 w-3" /></span>
          </>
        )}
      </div>
    );
  };
  const overlay = (pageIndex: number, box: PageBox) => (
    <div
      className={`absolute inset-0 ${adding || placing ? "cursor-crosshair" : ""}`}
      data-swipe-ignore
      onClick={(e) => {
        if (!(adding || placing)) { setSelectedId(null); return; }
        const p = pagePoint(e.currentTarget, e.clientX, e.clientY);
        addBox(pageIndex, p.x, p.y, placing);
      }}
      onDragOver={(e) => { if (dragFact) e.preventDefault(); }}
      onDrop={(e) => { if (!dragFact) return; e.preventDefault(); const p = pagePoint(e.currentTarget, e.clientX, e.clientY); addBox(pageIndex, p.x, p.y, dragFact); }}
      data-testid={`fill-layer-${pageIndex}`}
    >
      {fields.filter((f) => f.page === pageIndex).map((f) => renderField(f, box))}
    </div>
  );

  // ── the field being edited ──
  const editor = selected && (
    <div className="border-b border-border bg-card px-2.5 py-2 shrink-0" data-testid="fill-editor">
      <div className="flex items-center gap-2 max-w-3xl mx-auto">
        <label htmlFor="fill-editor-input" className="text-xs font-semibold truncate min-w-0 flex-1">{selected.label}</label>
        {selected.source && selected.value && <span className="text-[11px] text-muted-foreground truncate max-w-[45%]" data-testid="fill-editor-source">from {selected.source}</span>}
        <button type="button" onClick={() => setSelectedId(null)} aria-label="Done with this field" className="h-7 w-7 rounded-full hover:bg-muted flex items-center justify-center shrink-0"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex items-start gap-1.5 max-w-3xl mx-auto mt-1.5">
        {selected.kind === "signature" ? (
          <p className="text-xs text-muted-foreground flex-1">Signatures are never filled in. Sign the saved form yourself.</p>
        ) : selected.kind === "checkbox" ? (
          <button type="button" onClick={() => patchField(selected.id, { value: isYes(selected.value) ? "" : "yes", filledBy: "user" })} aria-pressed={isYes(selected.value)}
            className="h-9 px-3 rounded-full border border-border text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground" data-testid="fill-editor-check">
            {isYes(selected.value) ? "Ticked" : "Not ticked"}
          </button>
        ) : (selected.kind === "radio" || selected.kind === "choice") && selected.options?.length ? (
          <select id="fill-editor-input" value={selected.value} onChange={(e) => patchField(selected.id, { value: e.target.value, filledBy: "user" })}
            className="h-9 flex-1 min-w-0 rounded-md border border-border bg-background px-2 text-sm" data-testid="fill-editor-input">
            <option value="">— none —</option>
            {selected.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : selected.kind === "multiline" ? (
          <textarea id="fill-editor-input" value={selected.value} rows={3} onChange={(e) => patchField(selected.id, { value: e.target.value, filledBy: "user", confirmed: selected.sensitive ? true : undefined }, `type:${selected.id}`)}
            className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm" placeholder="Type a value" data-testid="fill-editor-input" />
        ) : (
          <input id="fill-editor-input" value={selected.value} onChange={(e) => patchField(selected.id, { value: e.target.value, filledBy: "user", confirmed: selected.sensitive ? true : undefined }, `type:${selected.id}`)}
            className="h-9 flex-1 min-w-0 rounded-md border border-border bg-background px-2 text-sm" placeholder={selected.kind === "date" ? "MM/DD/YYYY" : "Type a value"} data-testid="fill-editor-input" />
        )}
        {selected.value && selected.kind !== "signature" && (
          <button type="button" onClick={() => clearField(selected.id)} className="h-9 px-2.5 rounded-md border border-border text-xs shrink-0" data-testid="fill-editor-clear">Clear</button>
        )}
        {movable(selected) && (
          <button type="button" onClick={() => confirm(`rm:${selected.id}`, () => { commit((cur) => cur.filter((f) => f.id !== selected.id)); setSelectedId(null); })}
            aria-label={isArmed(`rm:${selected.id}`) ? "Tap again to remove this box" : "Remove this box from the page"}
            className={`h-9 px-2.5 rounded-md text-xs shrink-0 flex items-center gap-1 ${isArmed(`rm:${selected.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`} data-testid="fill-editor-remove">
            <Trash2 className="h-3.5 w-3.5" />{isArmed(`rm:${selected.id}`) ? "Remove?" : ""}
          </button>
        )}
      </div>
      {(selected.sensitive && !selected.confirmed && selected.value) || selected.alternatives?.length || movable(selected) ? (
        <div className="flex items-center gap-1.5 flex-wrap max-w-3xl mx-auto mt-1.5">
          {selected.sensitive && !selected.confirmed && selected.value && (
            <button type="button" onClick={() => patchField(selected.id, { confirmed: true })} className="h-7 px-2.5 rounded-full bg-amber-500 text-black text-xs font-semibold flex items-center gap-1" data-testid="fill-editor-confirm">
              <ShieldAlert className="h-3.5 w-3.5" /> Private value — tap to include it
            </button>
          )}
          {selected.alternatives?.map((a) => (
            <button key={`${a.value}|${a.source}`} type="button" onClick={() => patchField(selected.id, { value: selected.kind === "date" ? formatFormDate(a.value) : a.value, source: a.source, filledBy: "user" })}
              className="h-7 px-2.5 rounded-full border border-border text-xs max-w-full truncate" title={`Use the value from ${a.source}`} data-testid="fill-editor-alternative">
              {a.value} · {a.source}
            </button>
          ))}
          {movable(selected) && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Text size
              <button type="button" className="h-7 w-7 rounded-md border border-border" aria-label="Smaller text" onClick={() => patchField(selected.id, { fontSize: Math.max(5, (selected.fontSize || 10) - 1) })}>−</button>
              <button type="button" className="h-7 w-7 rounded-md border border-border" aria-label="Larger text" onClick={() => patchField(selected.id, { fontSize: Math.min(36, (selected.fontSize || 10) + 1) })}>+</button>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );

  // ── My Information ──
  const panel = <InformationPanel
    info={info} loading={infoQuery.isLoading} failed={infoQuery.isError && !info} retry={() => void infoQuery.refetch()}
    forId={forId} setForId={setForId}
    target={selected}
    onUse={(fact) => {
      if (selected && selected.kind !== "signature") { putFact(selected.id, fact); setPanelOpen(false); return; }
      setPlacing(fact); setPanelOpen(false);
    }}
    onDragStart={setDragFact} onDragEnd={() => setDragFact(null)}
  />;

  const status = !working ? (info ? `${facts.length} details on file` : "")
    : saveState === "saving" ? "Saving and checking the file…"
    : saveState === "error" ? "Not saved"
    : saved && !dirty ? "Saved and verified"
    : `${filledCount} of ${fillable} filled${waiting ? ` · ${waiting} to confirm` : ""}`;

  return (
    <WorkspaceShell
      kind="fill"
      title={<span className="text-sm font-semibold truncate block">{working ? working.name : "Fill in a form"}</span>}
      status={status}
      unsaved={!!working && dirty}
      onClose={() => leaveWorkspace()}
      save={working ? { state: saveState === "saving" ? "saving" : saveState === "error" ? "error" : saved && !dirty ? "saved" : "dirty", disabled: filledCount === 0, onSave: save } : undefined}
      actions={working ? (
        <button type="button" onClick={() => setPanelOpen((v) => !v)} className="lg:hidden h-8 px-2.5 rounded-full border border-border text-xs shrink-0 flex items-center gap-1" data-testid="button-fill-info">
          <PanelRightOpen className="h-3.5 w-3.5" /> {panelOpen ? "Form" : "My info"}
        </button>
      ) : undefined}
    >
      {busy && (
        <div className="absolute inset-0 z-30 bg-background/85 flex flex-col items-center justify-center gap-3 px-6 text-center" role="status" data-testid="fill-busy">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm">{busy.text}</p>
          {busy.skippable && <button type="button" className="h-8 px-3 rounded-full border border-border text-xs" onClick={() => { skipIndex.current = true; }} data-testid="fill-skip-index">Continue without the rest</button>}
        </div>
      )}
      {!working ? (
        <div
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer?.files?.[0]); }}
          data-testid="fill-start" data-workspace-scroll
        >
          <div className="max-w-xl mx-auto">
            <button type="button" onClick={() => { const el = inputRef.current; if (el) { el.value = ""; el.click(); } }}
              className={`w-full rounded-2xl border-2 border-dashed px-6 py-10 flex flex-col items-center gap-2 text-center transition-colors ${over ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"}`}
              data-testid="fill-drop-zone">
              <FileUp className="h-8 w-8 text-primary" />
              <span className="text-base font-semibold">Choose a form to fill in</span>
              <span className="text-xs text-muted-foreground">A PDF, a Word (.docx) form, or a photo or screenshot of a form. Drop it here or tap to choose.</span>
            </button>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf,.docx,image/*" className="hidden" onChange={(e) => void take(e.target.files?.[0])} data-testid="input-fill-file" />
            <p className="mt-3 text-xs text-muted-foreground" data-testid="fill-info-summary">
              {infoQuery.isLoading ? "Looking at what you have on file…"
                : infoQuery.isError && !info ? <>Couldn't load your information. <button type="button" className="underline" onClick={() => void infoQuery.refetch()}>Retry</button></>
                : info ? <>Fill In uses everything you've saved: {facts.length} details from {info.counts.profiles} profile{info.counts.profiles === 1 ? "" : "s"}, {info.counts.documents} document{info.counts.documents === 1 ? "" : "s"} and {info.counts.notes} note{info.counts.notes === 1 ? "" : "s"}.{info.unindexed > 0 ? ` ${info.unindexed} upload${info.unindexed === 1 ? " has" : "s have"} not been read yet — ${info.unindexed === 1 ? "it is" : "they are"} read when you choose a form.` : ""} Nothing is sent anywhere, and nothing is made up: what isn't on file is left blank.</>
                : null}
            </p>
            <div className="mt-5" data-testid="fill-forms">
              <p className="micro-label text-muted-foreground mb-1.5">Completed forms</p>
              {formsQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p>
                : formsQuery.isError && !formsQuery.data ? <p className="text-xs text-destructive">Couldn't load your completed forms. <button type="button" className="underline" onClick={() => void formsQuery.refetch()}>Retry</button></p>
                : (formsQuery.data || []).length === 0 ? <p className="text-xs text-muted-foreground">Forms you complete are listed here, to reopen and edit.</p>
                : (formsQuery.data || []).map((d) => (
                  <div key={d.id} className="flex items-center gap-2 h-10 pl-2 pr-1 rounded-lg border border-border bg-muted/30 mb-1.5 min-w-0" data-testid={`fill-form-${d.id}`}>
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="flex-1 min-w-0 text-xs truncate">{d.name}</span>
                    {d.editable && <button type="button" className="h-7 px-2.5 rounded-full border border-border text-xs shrink-0" onClick={() => void reopen(d.id)}>Edit</button>}
                    <button type="button" className="h-7 px-2.5 rounded-full text-xs text-muted-foreground shrink-0" onClick={() => hashNavigate(`/documents/${d.id}`)}>Open</button>
                  </div>
                ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 flex">
          <div className={`${panelOpen ? "hidden" : "flex"} lg:flex flex-1 min-w-0 flex-col`}>
            {/* Tools: one row that scrolls sideways on a phone. */}
            <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border bg-muted/30 overflow-x-auto overflow-y-hidden shrink-0 [scrollbar-width:none]" data-swipe-ignore data-testid="fill-toolbar">
              <button type="button" onClick={() => void autoFill()} className="h-8 px-2.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold flex items-center gap-1 shrink-0" data-testid="button-fill-auto"><Sparkles className="h-3.5 w-3.5" /> Auto-fill</button>
              <button type="button" onClick={undo} disabled={hist.past.length === 0} aria-label="Undo" className="h-8 w-8 rounded-md flex items-center justify-center hover:bg-muted disabled:opacity-40 shrink-0" data-testid="button-fill-undo"><Undo2 className="h-4 w-4" /></button>
              <button type="button" onClick={redo} disabled={hist.future.length === 0} aria-label="Redo" className="h-8 w-8 rounded-md flex items-center justify-center hover:bg-muted disabled:opacity-40 shrink-0" data-testid="button-fill-redo"><Redo2 className="h-4 w-4" /></button>
              {working.format === "pdf" && (
                <>
                  <button type="button" onClick={() => { setAdding((v) => !v); setPlacing(null); setView("page"); }} aria-pressed={adding} className="h-8 px-2.5 rounded-md text-xs flex items-center gap-1 hover:bg-muted aria-pressed:bg-primary/15 aria-pressed:text-primary shrink-0 whitespace-nowrap" data-testid="button-fill-add"><Plus className="h-3.5 w-3.5" /> Add text</button>
                  <button type="button" onClick={() => setView((v) => (v === "page" ? "list" : "page"))} className="h-8 px-2.5 rounded-md text-xs flex items-center gap-1 hover:bg-muted shrink-0 whitespace-nowrap" data-testid="button-fill-view"><ListIcon className="h-3.5 w-3.5" /> {view === "page" ? "List" : "Page"}</button>
                </>
              )}
              <button type="button" onClick={() => confirm("clear-all", clearAll)} disabled={!fields.some((f) => f.value)}
                className={`h-8 px-2.5 rounded-md text-xs shrink-0 whitespace-nowrap disabled:opacity-40 ${isArmed("clear-all") ? "bg-destructive text-destructive-foreground" : "hover:bg-muted"}`} data-testid="button-fill-clear-all">
                {isArmed("clear-all") ? "Tap again to clear all" : "Clear all"}
              </button>
              <button type="button" onClick={() => confirm("start-over", startOver)}
                className={`h-8 px-2.5 rounded-md text-xs shrink-0 whitespace-nowrap ${isArmed("start-over") ? "bg-destructive text-destructive-foreground" : "hover:bg-muted text-muted-foreground"}`} data-testid="button-fill-another">
                {isArmed("start-over") ? (dirty ? "Tap again — unsaved changes are dropped" : "Tap again") : "Another form"}
              </button>
            </div>
            {saveError && (
              <div role="alert" className="px-3 py-2 bg-destructive/10 border-b border-destructive/40 text-xs flex items-start gap-2 shrink-0" data-testid="fill-save-error">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <span className="flex-1">{saveError}</span>
                <button type="button" className="underline shrink-0" onClick={() => setSaveError(null)}>Hide</button>
              </div>
            )}
            {saved && showSaved && (
              <div className="px-3 py-2 bg-emerald-600/10 border-b border-emerald-600/40 text-xs flex items-center gap-2 flex-wrap shrink-0" role="status" data-testid="fill-saved">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span className="flex-1 min-w-[12rem]">Saved to Documents as “{saved.name}”. The saved file was reopened and holds {saved.verification.found} of {saved.verification.expected} value{saved.verification.expected === 1 ? "" : "s"}. The original form is kept unchanged.</span>
                <SavedActions saved={saved} />
                <button type="button" className="h-7 px-2.5 rounded-full border border-border" onClick={() => setShowSaved(false)} data-testid="button-fill-keep-editing">Keep editing</button>
              </div>
            )}
            {(placing || adding) && (
              <div className="px-3 py-1.5 bg-primary/10 border-b border-primary/30 text-xs flex items-center gap-2 shrink-0" data-testid="fill-placing">
                <span className="flex-1 min-w-0 truncate">{placing ? <>Tap a field — or an empty spot on the page — to place “{placing.sensitive ? placing.label : placing.value}”.</> : "Tap the page where the text should go."}</span>
                <button type="button" className="underline shrink-0" onClick={() => { setPlacing(null); setAdding(false); }}>Cancel</button>
              </div>
            )}
            {aiNote && !showSaved && (
              <p className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-xs shrink-0" data-testid="fill-ai-note">{aiNote} <button type="button" className="underline" onClick={() => setAiNote(null)}>Hide</button></p>
            )}
            {!showSaved && editor}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-muted/40" data-workspace-scroll data-testid="fill-document">
              {saved && showSaved ? (
                <SavedPreview saved={saved} />
              ) : working.format === "pdf" && view === "page" ? (
                <div className="p-2 sm:p-4"><FillPdfPages base64={working.base64} overlay={overlay} /></div>
              ) : (
                <FieldList fields={fields} selectedId={selectedId} placing={placing} onPick={(f) => { if (placing) putFact(f.id, placing); else setSelectedId(f.id); }} />
              )}
            </div>
          </div>
          <aside className={`${panelOpen ? "flex" : "hidden"} lg:flex flex-col w-full lg:w-80 border-l border-border bg-card min-h-0`} data-testid="fill-panel">{panel}</aside>
        </div>
      )}
    </WorkspaceShell>
  );
}

/** Download / open the completed file. */
function SavedActions({ saved }: { saved: Saved }) {
  const blob = useDocumentBlobUrl(saved.documentId, saved.mimeType);
  const ext = saved.mimeType === DOCX_MIME ? "docx" : "pdf";
  return (
    <>
      {blob.url ? (
        <a href={blob.url} download={`${saved.name}.${ext}`} className="h-7 px-2.5 rounded-full bg-primary text-primary-foreground font-semibold flex items-center gap-1" data-testid="button-fill-download"><Download className="h-3.5 w-3.5" /> Download</a>
      ) : (
        <span className="h-7 px-2.5 rounded-full border border-border flex items-center gap-1 text-muted-foreground">{blob.error ? "Couldn't load the file" : <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing</>}</span>
      )}
      <button type="button" className="h-7 px-2.5 rounded-full border border-border" onClick={() => hashNavigate(`/documents/${saved.documentId}`)} data-testid="button-fill-open-doc">Open in Documents</button>
    </>
  );
}

/** The SAVED file, read back from Documents — not the editing view. */
function SavedPreview({ saved }: { saved: Saved }) {
  const blob = useDocumentBlobUrl(saved.documentId, saved.mimeType);
  if (saved.mimeType === DOCX_MIME) return <p className="p-6 text-sm text-muted-foreground" data-testid="fill-saved-preview">The completed Word file is in Documents. Download it to open it in Word.</p>;
  if (blob.error) return <p className="p-6 text-sm text-destructive" data-testid="fill-saved-preview">The saved file could not be loaded for preview. It is in Documents.</p>;
  if (!blob.blob) return <p className="p-6 text-sm text-muted-foreground flex items-center gap-2" data-testid="fill-saved-preview"><Loader2 className="h-4 w-4 animate-spin" /> Opening the saved file…</p>;
  return <div className="p-2 sm:p-4 max-w-[900px] mx-auto" data-testid="fill-saved-preview"><PdfCanvas blob={blob.blob} /></div>;
}

/** Every field as a row: for Word forms, and as the other view of a PDF. */
function FieldList({ fields, selectedId, placing, onPick }: { fields: FillField[]; selectedId: string | null; placing: FillFact | null; onPick: (f: FillField) => void }) {
  if (fields.length === 0) return <p className="p-6 text-sm text-muted-foreground" data-testid="fill-list">No fields were found on this form.</p>;
  return (
    <div className="max-w-2xl mx-auto p-2 sm:p-4 space-y-1" data-testid="fill-list">
      {fields.map((f) => {
        const needs = !!f.sensitive && !f.confirmed && !!f.value;
        const fits = placing ? factFitsKind(placing, f.kind) : false;
        return (
          <button key={f.id} type="button" onClick={() => onPick(f)}
            className={`w-full text-left rounded-lg border px-3 py-2 flex items-center gap-2 min-w-0 bg-background ${f.id === selectedId ? "border-primary" : placing && fits ? "border-emerald-500" : "border-border"}`}
            data-testid={`fill-row-${f.id}`}>
            <span className="text-xs text-muted-foreground w-2/5 shrink-0 truncate">{f.label}</span>
            <span className={`text-sm flex-1 min-w-0 truncate ${f.value ? "" : "text-muted-foreground/70"}`}>
              {f.kind === "signature" ? "Sign by hand" : f.kind === "checkbox" ? (isYes(f.value) ? "Ticked" : "Not ticked") : needs ? `${maskValue(f.value)} · tap to confirm` : f.value || "Empty"}
            </span>
            {f.source && f.value && <span className="text-[11px] text-muted-foreground truncate max-w-[30%] shrink-0">{f.source}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** "My Information": search, categories, each value with its source; tap or drag one onto a field. */
function InformationPanel({
  info, loading, failed, retry, forId, setForId, target, onUse, onDragStart, onDragEnd,
}: {
  info: Information | undefined; loading: boolean; failed: boolean; retry: () => void;
  forId: string; setForId: (id: string) => void;
  target: FillField | null;
  onUse: (fact: FillFact) => void; onDragStart: (fact: FillFact) => void; onDragEnd: () => void;
}) {
  const [query, setQuery] = useState("");
  // A VIEW over the list: never stored, and it names what it hides (Rule 4).
  const [category, setCategory] = useState<FillCategory | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const facts = Array.isArray(info?.facts) ? info!.facts : [];
  const counts = useMemo(() => { const m = new Map<FillCategory, number>(); for (const f of facts) m.set(f.category, (m.get(f.category) || 0) + 1); return m; }, [facts]);
  const found = useMemo(() => searchFacts(facts, query), [facts, query]);
  const shown = category ? found.filter((f) => f.category === category) : found;
  const hidden = found.length - shown.length;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2.5 pb-1.5 shrink-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold flex-1">My Information</p>
          {info && info.people.length > 1 && (
            <select value={forId} onChange={(e) => setForId(e.target.value)} aria-label="Whose form this is" title="Whose form this is — their details answer the fields"
              className="ws-field h-7 rounded-full border border-border bg-background px-2 text-xs max-w-[9rem]" data-testid="select-fill-for">
              {info.people.map((p) => <option key={p.id} value={p.self ? "" : p.id}>{p.self ? "For me" : `For ${p.name}`}</option>)}
            </select>
          )}
        </div>
        <div className="relative mt-1.5">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your information" aria-label="Search your information"
            className="ws-title w-full h-8 rounded-full border border-border bg-background pl-8 pr-3 text-sm outline-none" data-testid="input-fill-search" />
        </div>
        <div className="flex gap-1 overflow-x-auto mt-1.5 pb-0.5 [scrollbar-width:none]" data-swipe-ignore data-testid="fill-categories">
          <button type="button" onClick={() => setCategory(null)} aria-pressed={!category} className="shrink-0 h-6 px-2 rounded-full border border-border text-[11px] aria-pressed:bg-foreground aria-pressed:text-background">All · {facts.length}</button>
          {FILL_CATEGORIES.filter((c) => counts.get(c)).map((c) => (
            <button key={c} type="button" onClick={() => setCategory(category === c ? null : c)} aria-pressed={category === c}
              className="shrink-0 h-6 px-2 rounded-full border border-border text-[11px] whitespace-nowrap aria-pressed:bg-foreground aria-pressed:text-background" data-testid={`fill-category-${c}`}>{c} · {counts.get(c)}</button>
          ))}
        </div>
        {category && hidden > 0 && (
          <p className="text-[11px] text-muted-foreground mt-1" data-testid="fill-category-notice">Showing {category} only — {hidden} other {hidden === 1 ? "detail is" : "details are"} hidden. <button type="button" className="underline" onClick={() => setCategory(null)}>Show all</button></p>
        )}
        <p className="text-[11px] text-muted-foreground mt-1">{target && target.kind !== "signature" ? <>Tap a detail to put it in “{target.label}”.</> : "Tap a detail, then a field — or drag it onto the form."}</p>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 space-y-1" data-testid="fill-facts">
        {loading ? <p className="p-2 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your information…</p>
          : failed ? <div className="p-2 text-xs" data-testid="fill-facts-error"><p className="text-destructive">Couldn't load your information.</p><button type="button" className="underline mt-1" onClick={retry}>Retry</button></div>
          : shown.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.trim() ? `Nothing on file matches “${query.trim()}”${category ? ` in ${category}` : ""}.` : category ? `Nothing in ${category}.` : "Nothing on file yet. Add details to your profile or upload documents, and they will be listed here."}
            </p>
          ) : shown.slice(0, 300).map((f) => {
            const fits = target ? factFitsKind(f, target.kind) : true;
            const show = !f.sensitive || revealed.has(f.id);
            return (
              <div key={f.id} draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", f.sensitive ? f.label : f.value); e.dataTransfer.effectAllowed = "copy"; onDragStart(f); }} onDragEnd={onDragEnd}
                className={`rounded-lg border border-border/70 bg-background px-2.5 py-1.5 flex items-center gap-1.5 min-w-0 ${fits ? "" : "opacity-50"}`} data-testid={`fill-fact-${f.id}`}>
                <button type="button" onClick={() => onUse(f)} className="flex-1 min-w-0 text-left" title={target ? `Put this in “${target.label}”` : "Place this on the form"}>
                  <span className="block text-[11px] text-muted-foreground truncate">{f.label} · {f.source.name}</span>
                  <span className="block text-sm truncate">{show ? f.value : maskValue(f.value)}</span>
                </button>
                {f.sensitive && (
                  <button type="button" aria-label={show ? "Hide this value" : "Show this value"} className="h-7 w-7 rounded-full hover:bg-muted flex items-center justify-center shrink-0"
                    onClick={() => setRevealed((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}>
                    {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            );
          })}
        {shown.length > 300 && <p className="p-2 text-[11px] text-muted-foreground">Showing the first 300 of {shown.length}. Search to narrow it down.</p>}
      </div>
    </div>
  );
}
