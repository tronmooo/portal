// The full-screen frame every AI workspace opens in (owner request
// 2026-11-22): Notes, Journal, Document and Fill In each take the whole
// screen, with the app's navigation out of the way, a title, a save status
// and an X at the top right that goes back to AI Chat.
//
// The X never discards: each workspace hands `onClose` a function that saves
// what is pending first.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpen, FileInput, FileText, Loader2, StickyNote, X } from "lucide-react";
import { hashNavigate } from "@/lib/hashNavigate";

export type WorkspaceKind = "notes" | "journal" | "document" | "fill";

export const WORKSPACES: Record<WorkspaceKind, { label: string; route: string; icon: typeof FileText; blurb: string }> = {
  notes: { label: "Notes", route: "/workspace/notes", icon: StickyNote, blurb: "Open the full-screen notes workspace" },
  journal: { label: "Journal", route: "/workspace/journal", icon: BookOpen, blurb: "Open the full-screen journal" },
  document: { label: "Document", route: "/editor/new/doc?source=chat", icon: FileText, blurb: "Open the full-screen document editor" },
  fill: { label: "Fill In", route: "/workspace/fill", icon: FileInput, blurb: "Open the full-screen form filler" },
};

/** Hide the app's floating chrome (bottom tab bar) while a workspace is open. */
export function useFullScreenWorkspace(): void {
  useEffect(() => {
    // On <html> too: the desktop scrollbar gutters are reserved there.
    document.body.setAttribute("data-workspace", "1");
    document.documentElement.setAttribute("data-workspace", "1");
    return () => {
      document.body.removeAttribute("data-workspace");
      document.documentElement.removeAttribute("data-workspace");
    };
  }, []);
}

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

/** The X: runs the workspace's save-then-leave, once, and shows it is working. */
export function WorkspaceCloseButton({ onClose, className = "" }: { onClose: () => void | Promise<void>; className?: string }) {
  const [closing, setClosing] = useState(false);
  return (
    <button
      type="button"
      disabled={closing}
      onClick={async () => {
        if (closing) return;
        setClosing(true);
        try { await onClose(); } finally { setClosing(false); }
      }}
      aria-label="Close and go back to AI Chat"
      title="Close — your work is saved"
      className={`h-9 w-9 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-muted transition-colors ${className}`}
      data-testid="button-workspace-close"
    >
      {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
    </button>
  );
}

export function WorkspaceShell({
  kind, title, status, actions, onClose, children,
}: {
  kind: WorkspaceKind;
  /** The title area: usually an input. */
  title?: ReactNode;
  /** "Saved", "Saving…", "Not saved yet" … */
  status?: string;
  /** Workspace-specific header buttons (previous work, delete, export). */
  actions?: ReactNode;
  onClose: () => void | Promise<void>;
  children: ReactNode;
}) {
  useFullScreenWorkspace();
  const meta = WORKSPACES[kind];
  const Icon = meta.icon;
  return (
    <WorkspacePortal>
    <section
      className="workspace-surface fixed inset-0 z-40 flex flex-col bg-background"
      aria-label={`${meta.label} workspace`}
      data-testid={`workspace-${kind}`}
    >
      <header
        className="flex items-center gap-2 px-3 border-b border-border bg-card shrink-0"
        style={{ minHeight: 52, paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
          <Icon className="h-4 w-4" /> <span className="hidden sm:inline">{meta.label}</span>
        </span>
        <div className="flex-1 min-w-0">{title}</div>
        {status && (
          <span className="text-[11px] text-muted-foreground shrink-0" role="status" data-testid="workspace-save-status">{status}</span>
        )}
        {actions}
        <WorkspaceCloseButton onClose={onClose} />
      </header>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </section>
    </WorkspacePortal>
  );
}

/**
 * The "Ask AI" box each workspace has. It only asks: what comes back is shown
 * by the workspace as a proposal, never applied on its own.
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
  const send = (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    onAsk(v);
    setText("");
  };
  return (
    <div className="border-t border-border bg-card px-3 py-2 shrink-0" style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}>
      {suggestions.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => send(s)}
              className="shrink-0 h-7 px-2.5 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form className="flex items-center gap-2 max-w-3xl mx-auto" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={2000}
          className="flex-1 h-10 rounded-full border border-border bg-background px-4 text-sm outline-none focus:border-primary/60"
          data-testid={`${testId}-input`}
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="h-10 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5"
          data-testid={`${testId}-send`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Ask AI
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
