// The full-screen frame every AI workspace opens in (owner request
// 2026-11-22): Notes, Journal, Document and Fill In each take the whole
// screen, with the app's navigation out of the way.
//
// The editors' phone layout (owner request 2026-11-23, "compact, mobile-
// friendly, unlimited length"): ONE sticky header — X at the left, the title
// and its save status, then Save at the right — over a single scroll area
// that holds the compact options and a writing area that grows with what is
// written. The frame is sized to the VISUAL viewport (`useVisualViewportBox`),
// so the header stays on screen and the bottom bars sit above the phone's
// keyboard; while the keyboard is up for the writing area, the Ask AI bar
// steps aside (`useWorkspaceKeyboard`) to give the words the room.
//
// Saving (W2): the X saves what is pending, then leaves. It never discards on
// its own: when that save FAILS, the header says so and offers "Keep editing"
// or "Leave without saving" — the one way to leave with unsaved work, and only
// after the warning. Save is never hidden; it is disabled only when there is
// nothing to save yet.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Camera, Check, FileInput, FileText, Image as ImageIcon, Loader2, Paperclip, Save, StickyNote, X } from "lucide-react";
import { hashNavigate } from "@/lib/hashNavigate";

export type WorkspaceKind = "notes" | "journal" | "document" | "fill";

export const WORKSPACES: Record<WorkspaceKind, { label: string; route: string; icon: typeof FileText; blurb: string }> = {
  notes: { label: "Notes", route: "/workspace/notes", icon: StickyNote, blurb: "Open the full-screen notes workspace" },
  journal: { label: "Journal", route: "/workspace/journal", icon: BookOpen, blurb: "Open the full-screen journal" },
  document: { label: "Document", route: "/editor/new/doc?source=chat", icon: FileText, blurb: "Open the full-screen document editor" },
  fill: { label: "Fill In", route: "/workspace/fill", icon: FileInput, blurb: "Open the full-screen form filler" },
};

/**
 * Hide the app's floating chrome (bottom tab bar) while a workspace is open,
 * and stop the phone zooming into a small field on focus: iOS zooms into any
 * field under 16px and leaves the page wider than the screen — the sideways
 * scroll and cut-off buttons of the old editors. `maximum-scale=1` stops that
 * zoom (iOS still lets a person pinch-zoom); it is put back on leaving.
 */
export function useFullScreenWorkspace(): void {
  useEffect(() => {
    // On <html> too: the desktop scrollbar gutters are reserved there.
    document.body.setAttribute("data-workspace", "1");
    document.documentElement.setAttribute("data-workspace", "1");
    // The app behind a workspace is covered, so it must not be reachable
    // either: its sidebar links stayed in the tab order and the accessibility
    // tree, where a keyboard, a screen reader or a browsing agent found
    // "Dashboard" / "Artifacts", activated them at their on-screen position,
    // and hit the workspace instead (2026-11-24: "clicking Artifacts left me
    // in the Fill In workspace"). `inert` takes the covered shell out of both.
    const shells = Array.from(document.querySelectorAll<HTMLElement>("[data-app-shell]")).filter((el) => !el.hasAttribute("inert"));
    for (const el of shells) el.setAttribute("inert", "");
    const meta = document.querySelector('meta[name="viewport"]');
    const before = meta?.getAttribute("content") ?? null;
    if (meta && before != null && !/maximum-scale/i.test(before)) meta.setAttribute("content", `${before}, maximum-scale=1`);
    return () => {
      document.body.removeAttribute("data-workspace");
      document.documentElement.removeAttribute("data-workspace");
      for (const el of shells) el.removeAttribute("inert");
      if (meta && before != null) meta.setAttribute("content", before);
    };
  }, []);
}

/** How far the visual viewport is shorter than the window before we call it a keyboard. */
export const KEYBOARD_MIN_PX = 120;

interface ViewportBox { top: number; height: number | null; keyboardOpen: boolean }

/**
 * The box the workspace should fill: the VISUAL viewport. On a phone the
 * keyboard shrinks the visual viewport but not the window, so a frame sized to
 * the window has its bottom (and the caret) under the keyboard, and iOS
 * scrolls the page to make room, pushing the header off the top. Following the
 * visual viewport keeps the header on screen and the bottom bars above the
 * keyboard. Without `visualViewport` (old browsers, tests) the frame is the
 * window, as before.
 */
export function useVisualViewportBox(): ViewportBox {
  const read = (): ViewportBox => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    if (!vv) return { top: 0, height: null, keyboardOpen: false };
    return { top: Math.max(0, vv.offsetTop), height: vv.height, keyboardOpen: window.innerHeight - vv.height > KEYBOARD_MIN_PX };
  };
  const [box, setBox] = useState<ViewportBox>(read);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = read();
        setBox((prev) => (prev.top === next.top && prev.height === next.height && prev.keyboardOpen === next.keyboardOpen ? prev : next));
      });
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return box;
}

/** The inline style that pins a full-screen frame to the visual viewport. */
export function viewportBoxStyle(box: ViewportBox): CSSProperties | undefined {
  return box.height == null ? undefined : { top: box.top, height: box.height, bottom: "auto" };
}

const KeyboardContext = createContext(false);
/** Is the phone keyboard up? (Read by the bars that step aside for it.) */
export function useWorkspaceKeyboard(): boolean {
  return useContext(KeyboardContext);
}
export const WorkspaceKeyboardProvider = KeyboardContext.Provider;

/**
 * Render a workspace over the WHOLE window. The app's layout is a centred,
 * max-width column, and a `position: fixed` box inside it is laid out against
 * that column, not the window — so the workspace is mounted on <body>.
 */
export function WorkspacePortal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}

/** Back to AI Chat. */
export function leaveWorkspace(): void {
  hashNavigate("/chat");
}

/**
 * Warn before the browser tab is closed or reloaded while something is not
 * saved yet (the in-app X saves first; this is the road around it).
 */
export function useUnsavedWarning(unsaved: boolean): void {
  useEffect(() => {
    if (!unsaved) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [unsaved]);
}

/**
 * What an `onClose` may answer: nothing (it left), or `false` — "the save
 * failed, nothing was left behind yet" — which opens the unsaved warning.
 */
export type WorkspaceCloseResult = void | boolean;

/** The X: runs the workspace's save-then-leave, once, and shows it is working. */
export function WorkspaceCloseButton({
  onClose, onSaveFailed, className = "",
}: {
  onClose: () => WorkspaceCloseResult | Promise<WorkspaceCloseResult>;
  /** Called when `onClose` answers false (its save failed). */
  onSaveFailed?: () => void;
  className?: string;
}) {
  const [closing, setClosing] = useState(false);
  return (
    <button
      type="button"
      disabled={closing}
      onClick={async () => {
        if (closing) return;
        setClosing(true);
        try {
          const result = await onClose();
          if (result === false) onSaveFailed?.();
        } finally { setClosing(false); }
      }}
      aria-label="Close and go back"
      title="Close — your work is saved first"
      className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-foreground hover:bg-muted transition-colors ${className}`}
      data-testid="button-workspace-close"
    >
      {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-5 w-5" />}
    </button>
  );
}

export type WorkspaceSaveState = "empty" | "dirty" | "saving" | "saved" | "error";

export interface WorkspaceSaveProps {
  /** Save now. Resolve `false` when it did not save. */
  onSave: () => Promise<boolean | void> | boolean | void;
  state: WorkspaceSaveState;
  /** Nothing to save yet (an empty entry). Save is shown, never hidden. */
  disabled?: boolean;
}

/** How long the "Saved" tick stays after a tap on Save. */
export const SAVED_FLASH_MS = 2000;

/** The Save button at the top right of every editor. */
export function WorkspaceSaveButton({ onSave, state, disabled }: WorkspaceSaveProps) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const saving = busy || state === "saving";
  const showSaved = !saving && (flash || state === "saved");
  const failed = !saving && state === "error";
  return (
    <button
      type="button"
      disabled={disabled || saving}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          const ok = await onSave();
          if (ok !== false) {
            setFlash(true);
            if (flashTimer.current) clearTimeout(flashTimer.current);
            flashTimer.current = setTimeout(() => setFlash(false), SAVED_FLASH_MS);
          }
        } finally { setBusy(false); }
      }}
      aria-label={failed ? "Save failed — tap to try again" : showSaved ? "Saved" : "Save"}
      title={disabled ? "Write something first" : failed ? "The last save failed — tap to try again" : "Save now"}
      className={`h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50 ${
        failed ? "bg-destructive text-destructive-foreground"
          : showSaved ? "bg-emerald-600/15 text-emerald-600 dark:text-emerald-400"
          : "bg-primary text-primary-foreground"
      }`}
      data-testid="button-workspace-save"
      data-state={saving ? "saving" : failed ? "error" : showSaved ? "saved" : "idle"}
    >
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : showSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
      <span>{saving ? "Saving" : failed ? "Retry" : showSaved ? "Saved" : "Save"}</span>
    </button>
  );
}

/** Shown when the X's save failed: stay (nothing lost) or leave knowingly. */
export function UnsavedLeaveBar({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 px-3 py-1.5 bg-destructive/10 border-b border-destructive/40 text-xs shrink-0" data-testid="workspace-unsaved-warning">
      <span className="flex-1 min-w-0">Couldn't save your latest changes. Leaving now loses them.</span>
      <button type="button" onClick={onStay} className="h-7 px-2.5 rounded-full bg-primary text-primary-foreground font-semibold shrink-0" data-testid="button-unsaved-stay">Keep editing</button>
      <button type="button" onClick={onLeave} className="h-7 px-2.5 rounded-full border border-destructive/60 text-destructive shrink-0" data-testid="button-unsaved-leave">Leave without saving</button>
    </div>
  );
}

/**
 * The one header every editor shares: X | title + status | actions | Save.
 * Sticky by construction: it sits outside the scroll area.
 */
export function WorkspaceHeader({
  kind, title, status, actions, onClose, onLeave = leaveWorkspace, save,
}: {
  kind: WorkspaceKind;
  title?: ReactNode;
  status?: string;
  actions?: ReactNode;
  onClose: () => WorkspaceCloseResult | Promise<WorkspaceCloseResult>;
  /** Where "Leave without saving" goes. */
  onLeave?: () => void;
  save?: WorkspaceSaveProps;
}) {
  const meta = WORKSPACES[kind];
  const Icon = meta.icon;
  const [warn, setWarn] = useState(false);
  return (
    <>
      <header
        className="flex items-center gap-1.5 pl-1.5 pr-2 border-b border-border bg-card shrink-0 min-w-0"
        style={{ minHeight: 48, paddingTop: "env(safe-area-inset-top, 0px)" }}
        data-testid="workspace-header"
      >
        <WorkspaceCloseButton onClose={onClose} onSaveFailed={() => setWarn(true)} />
        <Icon className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" aria-hidden />
        <div className="flex-1 min-w-0 flex flex-col justify-center leading-tight">
          <div className="min-w-0">{title}</div>
          {status && (
            <span className="text-[11px] text-muted-foreground truncate" role="status" data-testid="workspace-save-status">{status}</span>
          )}
        </div>
        {actions}
        {save && <WorkspaceSaveButton {...save} />}
      </header>
      {warn && <UnsavedLeaveBar onStay={() => setWarn(false)} onLeave={() => { setWarn(false); onLeave(); }} />}
    </>
  );
}

export function WorkspaceShell({
  kind, title, status, actions, onClose, onLeave, save, unsaved = false, children,
}: {
  kind: WorkspaceKind;
  /** The title area: usually an input. */
  title?: ReactNode;
  /** "Saved", "Saving…", "Not saved yet" … */
  status?: string;
  /** Workspace-specific header buttons (the list of previous work). */
  actions?: ReactNode;
  onClose: () => WorkspaceCloseResult | Promise<WorkspaceCloseResult>;
  onLeave?: () => void;
  /** The Save button (editors). */
  save?: WorkspaceSaveProps;
  /** Something is not saved yet: closing the browser tab warns. */
  unsaved?: boolean;
  children: ReactNode;
}) {
  useFullScreenWorkspace();
  useUnsavedWarning(unsaved);
  const box = useVisualViewportBox();
  const meta = WORKSPACES[kind];
  return (
    <WorkspacePortal>
    <WorkspaceKeyboardProvider value={box.keyboardOpen}>
    <section
      className="workspace-surface fixed inset-0 z-40 flex flex-col bg-background overflow-hidden"
      style={viewportBoxStyle(box)}
      aria-label={`${meta.label} workspace`}
      data-testid={`workspace-${kind}`}
      data-keyboard={box.keyboardOpen ? "1" : undefined}
    >
      <WorkspaceHeader kind={kind} title={title} status={status} actions={actions} onClose={onClose} onLeave={onLeave} save={save} />
      <div className="flex-1 min-h-0 min-w-0 flex flex-col">{children}</div>
    </section>
    </WorkspaceKeyboardProvider>
    </WorkspacePortal>
  );
}

/**
 * A textarea that grows with what is written, so a long entry is one page
 * that the workspace scrolls — never a box with its own scrollbar, never cut
 * off. Typing at the end keeps the caret in view above the keyboard.
 */
export function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Hold the scroll position: resetting the height to measure it would
    // otherwise make the page jump on every keystroke.
    const scroller = el.closest("[data-workspace-scroll]") as HTMLElement | null;
    const keep = scroller?.scrollTop;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (scroller && keep != null) scroller.scrollTop = keep;
    if (document.activeElement === el && el.selectionEnd >= el.value.length - 1 && scroller) {
      const elBottom = el.getBoundingClientRect().bottom;
      const viewBottom = scroller.getBoundingClientRect().bottom;
      if (elBottom > viewBottom - 24) scroller.scrollTop += elBottom - viewBottom + 48;
    }
  }, [ref, value]);
}

/**
 * The small attach button every editor has: a photo from the library, a new
 * photo from the camera, or any file. Each choice is its own hidden input so
 * the phone offers the right picker; several files may be chosen at once.
 */
export function AttachMenu({
  onFiles, busy = false, disabled = false, photosOnly = false, testId = "workspace-attach", label = "Attach", disabledTitle,
}: {
  onFiles: (files: File[]) => void;
  busy?: boolean;
  disabled?: boolean;
  /** Photos only (no "File" choice). */
  photosOnly?: boolean;
  testId?: string;
  label?: string;
  disabledTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  // The menu is placed on the screen, not inside the button's row: a row that
  // scrolls sideways (the phone toolbar) would clip it. It opens upward when
  // the button is near the bottom (the bar over the keyboard).
  const [at, setAt] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [open]);
  const pick = (ref: React.RefObject<HTMLInputElement | null>) => {
    setOpen(false);
    const el = ref.current;
    if (el) { el.value = ""; el.click(); }
  };
  const take = (list: FileList | null) => { const files = Array.from(list || []); if (files.length) onFiles(files); };
  const item = "w-full h-9 px-3 flex items-center gap-2 text-sm hover:bg-muted text-left";
  return (
    <div ref={wrap} className="shrink-0">
      <button
        type="button"
        disabled={disabled || busy}
        ref={button}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) {
            const left = Math.max(8, Math.min(r.left, window.innerWidth - 184));
            setAt(window.innerHeight - r.bottom < 160 ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 });
          }
          setOpen((v) => !v);
        }}
        aria-label={label ? undefined : "Attach a photo or a file"}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled && disabledTitle ? disabledTitle : "Attach a photo or a file"}
        className="h-7 px-2 rounded-full border border-border text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        data-testid={`button-${testId}`}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}{label ? ` ${label}` : null}
      </button>
      {open && (
        <div role="menu" style={at} className="fixed z-50 w-44 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg py-1" data-testid={`${testId}-menu`}>
          <button type="button" role="menuitem" className={item} onClick={() => pick(library)} data-testid={`${testId}-library`}><ImageIcon className="h-4 w-4" /> Photo library</button>
          <button type="button" role="menuitem" className={item} onClick={() => pick(camera)} data-testid={`${testId}-camera`}><Camera className="h-4 w-4" /> Take a photo</button>
          {!photosOnly && <button type="button" role="menuitem" className={item} onClick={() => pick(file)} data-testid={`${testId}-file`}><FileText className="h-4 w-4" /> File</button>}
        </div>
      )}
      <input ref={library} type="file" accept="image/*" multiple className="hidden" onChange={(e) => take(e.target.files)} data-testid={`input-${testId}-library`} />
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => take(e.target.files)} data-testid={`input-${testId}-camera`} />
      {!photosOnly && <input ref={file} type="file" multiple className="hidden" onChange={(e) => take(e.target.files)} data-testid={`input-${testId}-file`} />}
    </div>
  );
}

/** Read a file the way /api/upload/save-only takes it (a data URL). */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name || "that file"}.`));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

/**
 * The "Ask AI" box each workspace has. It only asks: what comes back is shown
 * by the workspace as a proposal, never applied on its own.
 *
 * One slim row. The suggestion chips show on a wide screen, or on a phone
 * once the box is tapped; while the keyboard is up for the WRITING (not for
 * this box), the bar steps aside so the words get the room.
 */
export function WorkspaceAiBar({
  placeholder, busy, onAsk, suggestions = [], testId = "workspace-ai",
}: {
  placeholder: string;
  busy: boolean;
  onAsk: (instruction: string) => void;
  suggestions?: string[];
  testId?: string;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const keyboardOpen = useWorkspaceKeyboard();
  const send = (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    onAsk(v);
    setText("");
  };
  const onBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  }, []);
  const away = keyboardOpen && !focused && !busy;
  return (
    <div
      className={`border-t border-border bg-card px-2 py-1.5 shrink-0 ${away ? "hidden" : ""}`}
      style={{ paddingBottom: keyboardOpen ? 6 : "max(env(safe-area-inset-bottom, 0px), 6px)" }}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      data-testid={`${testId}-bar`}
    >
      {suggestions.length > 0 && (
        <div className={`${focused ? "flex" : "hidden md:flex"} gap-1.5 overflow-x-auto pb-1.5 max-w-3xl mx-auto`} data-swipe-ignore>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => send(s)}
              className="shrink-0 h-6 px-2 rounded-full border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form className="flex items-center gap-1.5 max-w-3xl mx-auto" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={2000}
          className="ws-title flex-1 min-w-0 h-8 rounded-full border border-border bg-background px-3 text-sm outline-none focus:border-primary/60"
          data-testid={`${testId}-input`}
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50 flex items-center gap-1 shrink-0"
          data-testid={`${testId}-send`}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Ask AI
        </button>
      </form>
    </div>
  );
}

/** Read a response's error text the way apiRequest throws it ("400: {...}"). */
export function aiErrorText(err: unknown): string {
  const raw = String((err as any)?.message || err || "");
  const m = /"error"\s*:\s*"([^"]+)"/.exec(raw);
  return m ? m[1] : raw.replace(/^\d{3}:\s*/, "") || "The AI request failed. Nothing was changed.";
}
