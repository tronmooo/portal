// What the three workspace APPS share (owner request 2026-11-25: Notes,
// Journal and Word each "expand into a dedicated, full-screen application
// with its own navigation, history, editor, and AI capabilities").
//
//  - WorkspaceTabs: the app's own navigation, under the header.
//  - AiConversation: a conversation with that app's AI. It only talks: the
//    server routes it calls write nothing (W5), and the conversation lives in
//    this sitting only — it is not saved.
//  - AiAccessPanel: what that AI may read (shared/workspace-access.ts). The
//    server enforces it; this is the switch.
//  - VersionHistory: the versions kept of a note, an entry or a document,
//    with a preview and a two-tap restore.
//  - DictateButton: voice dictation into whatever is being written.
//  - Workspace memory: the tab and record last open, and a draft kept in the
//    browser while it is not yet on the server.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, History, Loader2, Mic, MicOff, RotateCcw, Send, ShieldCheck, Sparkles } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import {
  DEFAULT_WORKSPACE_AI_ACCESS, WORKSPACE_AI_ACCESS_LABELS, WORKSPACE_AI_ACCESS_PREF, accessSummary, parseWorkspaceAiAccess,
  serializeWorkspaceAiAccess, withAccess, type WorkspaceAiAccess, type WorkspaceAiApp,
} from "@shared/workspace-access";
import type { ContentVersion, VersionKind, VersionSummary } from "@shared/content-versions";
import type { ChatTurn } from "@shared/workspace-intel";
import { sinceLastTalked, type AiMemory, type MemoryApp } from "@shared/ai-memory";
import { aiErrorText, useWorkspaceKeyboard } from "./WorkspaceShell";

// ── Tabs ─────────────────────────────────────────────────────────────────────

export interface WorkspaceTab<T extends string = string> { id: T; label: string; icon?: typeof Sparkles; badge?: number | null }

/**
 * The app's own navigation. One row that scrolls sideways on a phone (its own
 * drag, so it carries data-swipe-ignore — T1); it steps aside while the
 * keyboard is up, so the words get the room.
 */
export function WorkspaceTabs<T extends string>({ tabs, active, onPick, label }: { tabs: WorkspaceTab<T>[]; active: T; onPick: (tab: T) => void; label: string }) {
  const keyboardOpen = useWorkspaceKeyboard();
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div
      ref={row}
      role="tablist"
      aria-label={label}
      className={`${keyboardOpen ? "hidden" : "flex"} items-center gap-1 px-2 py-1 border-b border-border bg-card overflow-x-auto overflow-y-hidden shrink-0 [scrollbar-width:none]`}
      data-swipe-ignore
      data-testid="workspace-tabs"
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(t.id)}
            className={`shrink-0 h-8 px-2.5 rounded-full text-xs font-medium whitespace-nowrap flex items-center gap-1.5 transition-colors ${on ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            data-testid={`workspace-tab-${t.id}`}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
            {t.label}
            {t.badge ? <span className={`text-[11px] tabular-nums rounded-full px-1.5 ${on ? "bg-background/20" : "bg-muted"}`}>{t.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A tab's page: one scroll area, a centred column. */
export function TabPage({ children, testId, wide = false }: { children: ReactNode; testId?: string; wide?: boolean }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain" data-testid={testId}>
      <div className={`${wide ? "max-w-5xl" : "max-w-3xl"} mx-auto px-3 sm:px-6 py-3 pb-8`}>{children}</div>
    </div>
  );
}

/** A failed read: an error with a retry, never an empty page (Rule 7). */
export function LoadError({ what, onRetry, testId }: { what: string; onRetry: () => void; testId?: string }) {
  return (
    <div className="p-3 text-sm" role="alert" data-testid={testId}>
      <p className="text-destructive">Couldn't load {what}.</p>
      <button type="button" className="underline mt-1 text-xs" onClick={onRetry}>Retry</button>
    </div>
  );
}

// ── Memory: the last tab and record, and a draft not yet saved ───────────────
// Per-viewer conveniences, so they live in the browser. Every read and write
// is guarded: the app works the same with storage blocked.

const mem = {
  get(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string | null) {
    try { if (value == null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* storage blocked */ }
  },
};

export interface LastOpened { tab?: string; id?: string | null }
const lastKey = (app: string) => `portol_ws_last:${app}`;

export function readLastOpened(app: string): LastOpened {
  try {
    const v = JSON.parse(mem.get(lastKey(app)) || "{}");
    return v && typeof v === "object" ? { tab: typeof v.tab === "string" ? v.tab : undefined, id: typeof v.id === "string" ? v.id : null } : {};
  } catch { return {}; }
}
export function rememberLastOpened(app: string, patch: LastOpened): void {
  mem.set(lastKey(app), JSON.stringify({ ...readLastOpened(app), ...patch }));
}

export interface SavedDraft { id: string | null; title: string; text: string; at: number }
const draftKey = (app: string) => `portol_ws_draft:${app}`;
export const DRAFT_MAX_CHARS = 500_000;

/**
 * Draft recovery. While what is written is not on the server (never saved, or
 * a save failed) the text is kept in the browser; once it is saved the copy
 * is dropped. `leftover` is a draft found when the workspace opened — it is
 * OFFERED, never applied on its own, and opening writes nothing (W3).
 */
export function useDraftRecovery(app: string) {
  const [leftover, setLeftover] = useState<SavedDraft | null>(() => {
    try {
      const v = JSON.parse(mem.get(draftKey(app)) || "null");
      return v && typeof v.text === "string" && v.text.trim() ? { id: typeof v.id === "string" ? v.id : null, title: String(v.title || ""), text: v.text, at: Number(v.at) || 0 } : null;
    } catch { return null; }
  });
  // While a found draft is still waiting for an answer, nothing is written
  // over it: the offer on screen must stay true.
  const waiting = useRef(!!leftover);
  const keep = useCallback((draft: { id: string | null; title: string; text: string }) => {
    if (waiting.current || !draft.text.trim() || draft.text.length > DRAFT_MAX_CHARS) return;
    mem.set(draftKey(app), JSON.stringify({ ...draft, at: Date.now() }));
  }, [app]);
  const clear = useCallback(() => { if (!waiting.current) mem.set(draftKey(app), null); }, [app]);
  const dismiss = useCallback(() => { waiting.current = false; mem.set(draftKey(app), null); setLeftover(null); }, [app]);
  const taken = useCallback(() => { waiting.current = false; setLeftover(null); }, []);
  return { leftover, keep, clear, dismiss, taken };
}

/** The bar that offers a draft found on opening. */
export function DraftRecoveryBar({ draft, onRestore, onDiscard }: { draft: SavedDraft; onRestore: () => void; onDiscard: () => void }) {
  const { confirm, isArmed } = useConfirmArm();
  const when = draft.at ? new Date(draft.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "earlier";
  return (
    <div role="status" className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/40 text-xs shrink-0" data-testid="workspace-draft-recovery">
      <span className="flex-1 min-w-0 truncate">Unsaved writing from {when} was kept on this device: “{draft.text.replace(/\s+/g, " ").slice(0, 60)}…”</span>
      <button type="button" onClick={onRestore} className="h-7 px-2.5 rounded-full bg-primary text-primary-foreground font-semibold shrink-0" data-testid="button-draft-restore">Restore</button>
      <button type="button" onClick={() => confirm("discard", onDiscard)} className={`h-7 px-2.5 rounded-full border shrink-0 ${isArmed("discard") ? "border-destructive bg-destructive text-destructive-foreground" : "border-border"}`} data-testid="button-draft-discard">
        {isArmed("discard") ? "Tap again" : "Discard"}
      </button>
    </div>
  );
}

// ── Voice dictation ──────────────────────────────────────────────────────────

const recognitionCtor = () => (typeof window === "undefined" ? null : (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null);

/** Dictation by the browser's own speech recognition. Each finished phrase is handed over as text. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);
  const handler = useRef(onText);
  handler.current = onText;
  const { toast } = useToast();
  const supported = !!recognitionCtor();
  const stop = useCallback(() => { try { rec.current?.stop(); } catch { /* already stopped */ } setListening(false); }, []);
  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) { toast({ title: "Dictation isn't available in this browser", description: "Chrome and Safari support it." }); return; }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = false;
    r.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = String(e.results[i]?.[0]?.transcript || "").trim();
        if (e.results[i]?.isFinal !== false && text) handler.current(text);
      }
    };
    r.onerror = (e: any) => {
      setListening(false);
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") toast({ title: "Microphone access is blocked", description: "Allow the microphone for this site to dictate.", variant: "destructive" });
    };
    r.onend = () => setListening(false);
    rec.current = r;
    try { r.start(); setListening(true); } catch { setListening(false); }
  }, [toast]);
  useEffect(() => () => { try { rec.current?.stop(); } catch { /* gone */ } }, []);
  return { supported, listening, start, stop };
}

/** The microphone button. Hidden where the browser cannot dictate (never a dead button, O4). */
export function DictateButton({ onText, testId = "button-dictate", className = "" }: { onText: (text: string) => void; testId?: string; className?: string }) {
  const d = useDictation(onText);
  if (!d.supported) return null;
  return (
    <button
      type="button"
      onClick={() => (d.listening ? d.stop() : d.start())}
      aria-pressed={d.listening}
      aria-label={d.listening ? "Stop dictating" : "Dictate"}
      title={d.listening ? "Listening — tap to stop" : "Dictate with your voice"}
      className={`h-7 px-2 rounded-full border text-xs flex items-center gap-1 shrink-0 ${d.listening ? "border-red-500 bg-red-500/10 text-red-600 dark:text-red-400" : "border-border text-muted-foreground hover:text-foreground"} ${className}`}
      data-testid={testId}
    >
      {d.listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}{d.listening ? " Listening" : " Dictate"}
    </button>
  );
}

// ── AI access ────────────────────────────────────────────────────────────────

const ACCESS_KEY = [`/api/preferences/${WORKSPACE_AI_ACCESS_PREF}`];

/** The stored AI-access row. `ready` is false until it has really been read. */
export function useAiAccess() {
  const qc = useQueryClient();
  const query = useQuery<{ value: string | null }>({ queryKey: ACCESS_KEY });
  const ready = query.isSuccess;
  const access = useMemo(() => (ready ? parseWorkspaceAiAccess(query.data?.value ?? null) : DEFAULT_WORKSPACE_AI_ACCESS), [ready, query.data]);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const set = useCallback(async <A extends WorkspaceAiApp>(app: A, key: keyof WorkspaceAiAccess[A] & string, on: boolean) => {
    // Never written over a row that was not read: the other switches would be
    // put back to their defaults.
    if (!ready) return;
    const next = withAccess(parseWorkspaceAiAccess(qc.getQueryData<{ value: string | null }>(ACCESS_KEY)?.value ?? null), app, key, on);
    const value = serializeWorkspaceAiAccess(next);
    const before = qc.getQueryData(ACCESS_KEY);
    qc.setQueryData(ACCESS_KEY, { value });
    setSaving(true);
    try {
      await apiRequest("PUT", `/api/preferences/${WORKSPACE_AI_ACCESS_PREF}`, { value });
    } catch (err) {
      qc.setQueryData(ACCESS_KEY, before);
      toast({ title: "Couldn't save that setting", description: aiErrorText(err), variant: "destructive" });
    } finally { setSaving(false); }
  }, [qc, ready, toast]);
  return { access, ready, loading: query.isLoading, failed: query.isError, retry: () => query.refetch(), set, saving };
}

/** The switches for one app's AI. */
export function AiAccessPanel({ app, onClose }: { app: WorkspaceAiApp; onClose?: () => void }) {
  const a = useAiAccess();
  return (
    <div className="bubble p-3" data-testid={`ai-access-${app}`}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
        <p className="text-sm font-semibold flex-1">What this AI may read</p>
        {onClose && <button type="button" onClick={onClose} className="text-xs underline text-muted-foreground">Done</button>}
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">
        A switch that is off means that information is not sent to the AI at all. Passwords, ID and card numbers are never sent.
        {app !== "journal" && " Journal entries stay private to the Journal unless you turn them on here."}
      </p>
      {a.loading ? (
        <p className="text-xs text-muted-foreground mt-2 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your settings…</p>
      ) : a.failed ? (
        <LoadError what="your AI access settings" onRetry={a.retry} testId="ai-access-error" />
      ) : (
        <ul className="mt-2 space-y-1.5">
          {WORKSPACE_AI_ACCESS_LABELS[app].map((row) => {
            const on = (a.access[app] as Record<string, boolean>)[row.key];
            return (
              <li key={row.key} className="flex items-start gap-2.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={row.label}
                  disabled={a.saving}
                  onClick={() => void a.set(app, row.key as never, !on)}
                  className={`mt-0.5 h-5 w-9 rounded-full shrink-0 relative transition-colors ${on ? "bg-primary" : "bg-muted-foreground/30"}`}
                  data-testid={`ai-access-${app}-${row.key}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <span className="min-w-0">
                  <span className="text-sm block leading-tight">{row.label}</span>
                  <span className="text-[11px] text-muted-foreground block">{row.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One line saying what the AI reads now, with the way to change it. */
export function AiAccessLine({ app, onChange }: { app: WorkspaceAiApp; onChange: () => void }) {
  const a = useAiAccess();
  const reads = accessSummary(a.access, app);
  return (
    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap" data-testid={`ai-access-line-${app}`}>
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
      {a.failed ? "Couldn't load your AI access settings." : !a.ready ? "Checking what the AI may read…" : reads.length ? <>Reads: {reads.join(" · ")}.</> : "Reads only what is on this page."}
      <button type="button" className="underline" onClick={onChange} data-testid={`button-ai-access-${app}`}>AI access</button>
    </p>
  );
}

// ── AI conversation ──────────────────────────────────────────────────────────

export interface ConversationReply { answer: string; note?: string; /** What the AI kept from this exchange. */ remembered?: string[] }
interface MemoryView extends AiMemory { remember: boolean; name: string }
const memoryQueryKey = (app: MemoryApp) => [`/api/workspace/memory/${app}`];

/**
 * What the AI remembers, for the person to read and change: every memory is
 * listed, any one can be removed (two taps), their own can be added, and
 * "Forget everything" clears the memories and the conversation.
 */
export function MemoryPanel({ app, view, onChanged, onClose }: { app: MemoryApp; view: MemoryView; onChanged: (next: MemoryView) => void; onClose: () => void }) {
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (method: string, path: string, body?: any) => {
    setBusy(true);
    try {
      const r = await apiRequest(method, `/api/workspace/memory/${app}${path}`, body);
      const j = await r.json();
      if (!j || !Array.isArray(j.memories)) throw new Error("The memory was not changed.");
      onChanged(j);
      return true;
    } catch (err) {
      toast({ title: "Couldn't change what is remembered", description: aiErrorText(err), variant: "destructive" });
      return false;
    } finally { setBusy(false); }
  };
  return (
    <div className="bubble p-3" data-testid={`memory-panel-${app}`}>
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-primary shrink-0" />
        <p className="text-sm font-semibold flex-1">What I remember about you · {view.memories.length}</p>
        <button type="button" onClick={onClose} className="text-xs underline text-muted-foreground">Done</button>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">
        Things you told me, kept on your account so I don't make you repeat yourself. Only this assistant reads them. Remove anything that is wrong or that you'd rather I didn't keep.
        {!view.remember && " Remembering is switched off in AI access: nothing here is used or added to until you turn it back on."}
      </p>
      {view.memories.length === 0 ? (
        <p className="text-sm text-muted-foreground mt-2" data-testid="memory-empty">Nothing yet. As we talk I'll keep the things that matter — the people in your life, what you're working on — and they will show up here.</p>
      ) : (
        <ul className="mt-2 space-y-1" data-testid="memory-list">
          {[...view.memories].reverse().map((m) => (
            <li key={m.id} className="flex items-start gap-2 text-sm" data-testid={`memory-${m.id}`}>
              <span className="flex-1 min-w-0">{m.text}<span className="block text-[11px] text-muted-foreground">{m.by === "you" ? "You added this" : "From our conversation"} · {new Date(m.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></span>
              <button type="button" disabled={busy} onClick={() => confirm(`forget:${m.id}`, () => void run("DELETE", `/items/${m.id}`))}
                aria-label={isArmed(`forget:${m.id}`) ? "Tap again to forget this" : "Forget this"}
                className={`h-7 px-2 rounded-full text-[11px] shrink-0 ${isArmed(`forget:${m.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}
                data-testid={`button-forget-${m.id}`}>{isArmed(`forget:${m.id}`) ? "Tap again" : "Forget"}</button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-1.5 mt-2" onSubmit={(e) => { e.preventDefault(); const v = text.trim(); if (v.length >= 4) void run("POST", "/remember", { text: v }).then((ok) => { if (ok) setText(""); }); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={220} placeholder="Something you want me to remember…" aria-label="Something to remember"
          className="ws-title flex-1 min-w-0 h-8 rounded-full border border-border bg-background px-3 text-sm outline-none" data-testid={`input-memory-${app}`} />
        <button type="submit" disabled={busy || text.trim().length < 4} className="h-8 px-3 rounded-full border border-border text-xs font-semibold disabled:opacity-40" data-testid={`button-memory-add-${app}`}>Remember</button>
      </form>
      {(view.memories.length > 0 || view.turns.length > 0) && (
        <button type="button" disabled={busy} onClick={() => confirm("forget-all", () => void run("DELETE", ""))}
          className={`mt-2 h-7 px-2.5 rounded-full text-[11px] ${isArmed("forget-all") ? "bg-destructive text-destructive-foreground" : "text-muted-foreground underline"}`} data-testid={`button-forget-all-${app}`}>
          {isArmed("forget-all") ? "Tap again: forget every memory and our conversation" : "Forget everything"}
        </button>
      )}
    </div>
  );
}

/**
 * A conversation with one app's AI. `ask` sends the conversation and answers
 * with the reply and a line saying what was read.
 *
 * With `memoryApp`, and remembering on (the writer's switch), the
 * conversation is the one saved on the account: it is there again next time,
 * and what the AI learned is listed for the person to read and remove
 * (`MemoryPanel`). With remembering off — or no `memoryApp` — it lives in
 * this sitting only, and the screen says which.
 */
export function AiConversation({
  app, ask, intro, suggestions, placeholder, boundary, testId, footer, memoryApp, greet, wrapUp, onSaveReply, accessLine, sendNow,
}: {
  /** In place of the workspace AI-access line (a custom AI Mode carries its own switches). */
  accessLine?: ReactNode;
  /** A message to send as soon as it changes (a suggested conversation tapped on another tab). */
  sendNow?: { text: string; key: number } | null;
  /** Shown once the conversation has some length: sends this message ("wrap up our session"). */
  wrapUp?: { label: string; message: string };
  /** Offers "Save to my journal" under each reply. The person taps it; the AI saves nothing on its own (W5). */
  onSaveReply?: (text: string) => Promise<void>;
  app?: WorkspaceAiApp;
  ask: (turns: ChatTurn[]) => Promise<ConversationReply>;
  intro: string;
  suggestions: string[];
  placeholder: string;
  /** A standing notice shown with the conversation (the coach's limits). */
  boundary?: string;
  testId: string;
  footer?: ReactNode;
  /** This AI remembers (shared/ai-memory.ts). */
  memoryApp?: MemoryApp;
  /** The opening line, once it is known who is here and when they last talked. */
  greet?: (who: { name: string; since: string | null; memories: number }) => string;
}) {
  type Shown = ChatTurn & { note?: string; remembered?: string[] };
  const qc = useQueryClient();
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const mem = useQuery<MemoryView>({ queryKey: memoryApp ? memoryQueryKey(memoryApp) : ["no-ai-memory"], enabled: !!memoryApp });
  // An unexpected answer (an older server) is "no memory", never a crash.
  const view: MemoryView | null = memoryApp && mem.data && Array.isArray((mem.data as any).memories) && Array.isArray((mem.data as any).turns) ? mem.data : null;
  const remembering = !!view?.remember;
  const [turns, setTurns] = useState<Shown[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Replies the person saved to their journal in this sitting (by position), so each is saved once.
  const [savedReplies, setSavedReplies] = useState<Record<number, "saving" | "saved">>({});
  const saveReply = async (i: number, content: string) => {
    if (!onSaveReply || savedReplies[i]) return;
    setSavedReplies((m) => ({ ...m, [i]: "saving" }));
    try { await onSaveReply(content); setSavedReplies((m) => ({ ...m, [i]: "saved" })); }
    catch (err) {
      setSavedReplies((m) => { const { [i]: _gone, ...rest } = m; return rest; });
      toast({ title: "Couldn't save that to your journal", description: aiErrorText(err), variant: "destructive" });
    }
  };
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [turns, busy]);
  // The saved conversation is put on screen once, when it arrives.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !view) return;
    hydrated.current = true;
    if (view.remember && view.turns.length) setTurns((now) => (now.length ? now : view.turns.map(({ role, content }) => ({ role, content }))));
  }, [view]);
  const setView = (next: MemoryView) => { if (memoryApp) qc.setQueryData(memoryQueryKey(memoryApp), next); };

  const send = async (value: string) => {
    const q = value.trim();
    if (!q || busy) return;
    const next = [...turns, { role: "user" as const, content: q }];
    setTurns(next);
    setText("");
    setError(null);
    setBusy(true);
    try {
      const reply = await ask(next.map(({ role, content }) => ({ role, content })));
      setTurns((t) => [...t, { role: "assistant", content: reply.answer, note: reply.note, remembered: reply.remembered }]);
      // The server saved the exchange and anything it kept: read it back.
      if (memoryApp) void qc.invalidateQueries({ queryKey: memoryQueryKey(memoryApp) });
    } catch (err) {
      // The question stays on screen with the reason and a retry: nothing is made up.
      setError(aiErrorText(err));
    } finally { setBusy(false); }
  };
  // A suggested conversation tapped elsewhere is sent once, when it arrives.
  const sentKey = useRef<number | null>(null);
  useEffect(() => {
    if (!sendNow || sentKey.current === sendNow.key) return;
    sentKey.current = sendNow.key;
    void send(sendNow.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendNow?.key]);
  const retry = () => {
    const last = turns[turns.length - 1];
    if (!last || last.role !== "user") return;
    setTurns(turns.slice(0, -1));
    void send(last.content);
  };
  /** A fresh start. A saved conversation is cleared on the account (two taps); what was learned stays. */
  const startOver = async () => {
    if (memoryApp && remembering) {
      try {
        const r = await apiRequest("DELETE", `/api/workspace/memory/${memoryApp}/conversation`);
        const j = await r.json();
        if (j && Array.isArray(j.memories)) setView(j);
      } catch (err) {
        toast({ title: "Couldn't clear the conversation", description: aiErrorText(err), variant: "destructive" });
        return;
      }
    }
    setTurns([]); setError(null); setSavedReplies({});
  };
  const opening = greet && view ? greet({ name: view.name, since: remembering ? sinceLastTalked(view.lastTalked, new Date()) : null, memories: remembering ? view.memories.length : 0 }) : intro;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid={testId}>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto px-3 sm:px-6 py-3 space-y-3">
          {boundary && <p className="text-[11px] rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-muted-foreground" data-testid={`${testId}-boundary`}>{boundary}</p>}
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
            {accessLine ?? (app && <AiAccessLine app={app} onChange={() => setAccessOpen((v) => !v)} />)}
            {memoryApp && (
              mem.isError ? <span className="text-[11px] text-destructive" role="alert" data-testid={`${testId}-memory-error`}>Couldn't load what I remember. <button type="button" className="underline" onClick={() => mem.refetch()}>Retry</button></span>
                : view ? (
                  <button type="button" onClick={() => setMemoryOpen((v) => !v)} aria-expanded={memoryOpen}
                    className="text-[11px] text-muted-foreground flex items-center gap-1 underline" data-testid={`button-memory-${memoryApp}`}>
                    <Brain className="h-3.5 w-3.5" /> {remembering ? `What I remember · ${view.memories.length}` : "Remembering is off"}
                  </button>
                ) : null
            )}
          </div>
          {accessOpen && app && <AiAccessPanel app={app} onClose={() => setAccessOpen(false)} />}
          {memoryOpen && memoryApp && view && (
            <MemoryPanel app={memoryApp} view={view} onClose={() => setMemoryOpen(false)}
              onChanged={(next) => { setView(next); if (next.turns.length === 0 && next.memories.length === 0) { setTurns([]); setError(null); } }} />
          )}
          {turns.length === 0 && (
            <div className="pt-2">
              <p className="text-sm text-muted-foreground" data-testid={`${testId}-opening`}>{opening}</p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {suggestions.map((s) => (
                  <button key={s} type="button" disabled={busy} onClick={() => void send(s)}
                    className="text-left text-xs rounded-full border border-border px-3 py-1.5 hover:bg-muted/60" data-testid={`${testId}-suggestion`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${t.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`} data-testid={`${testId}-${t.role}`}>
                {t.content}
                {t.remembered && t.remembered.length > 0 && (
                  <span className="block mt-1.5 text-[11px] opacity-80" data-testid={`${testId}-remembered`}>
                    <Brain className="inline h-3 w-3 mr-1 -mt-0.5" />I'll remember: {t.remembered.join(" · ")}
                  </span>
                )}
                {t.note && <span className="block mt-1.5 text-[11px] opacity-70">{t.note}</span>}
                {t.role === "assistant" && onSaveReply && (
                  <button type="button" disabled={!!savedReplies[i]} onClick={() => void saveReply(i, t.content)}
                    className="block mt-1.5 text-[11px] underline opacity-80 disabled:no-underline disabled:opacity-60" data-testid={`${testId}-save-reply`}>
                    {savedReplies[i] === "saved" ? "Saved to your journal" : savedReplies[i] === "saving" ? "Saving…" : "Save this to my journal"}
                  </button>
                )}
              </div>
            </div>
          ))}
          {busy && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {memoryApp === "journal" ? "Thinking about what you said…" : "Reading and thinking…"}</p>}
          {error && (
            <div role="alert" className="text-xs rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2" data-testid={`${testId}-error`}>
              {error} <button type="button" className="underline ml-1" onClick={retry}>Try again</button>
            </div>
          )}
          {wrapUp && turns.length >= 4 && !busy && turns[turns.length - 1]?.role === "assistant" && (
            <button type="button" onClick={() => void send(wrapUp.message)}
              className="h-8 px-3 rounded-full border border-border text-xs hover:bg-muted/60" data-testid={`${testId}-wrap-up`}>{wrapUp.label}</button>
          )}
          {turns.length > 0 && !busy && (
            <button type="button" className={`text-[11px] flex items-center gap-1 ${isArmed("new") ? "rounded-full bg-destructive text-destructive-foreground px-2.5 h-7" : "text-muted-foreground underline"}`}
              onClick={() => (remembering ? confirm("new", () => void startOver()) : void startOver())} data-testid={`${testId}-new`}>
              <RotateCcw className="h-3 w-3" /> {isArmed("new") ? "Tap again to clear this conversation (what I remember stays)" : "Start a new conversation"}
            </button>
          )}
          <p className="text-[11px] text-muted-foreground" data-testid={`${testId}-saved-note`}>
            {remembering
              ? "This conversation is saved privately on your account, so we can pick up where we left off. You can read and remove what I remember, or turn remembering off in AI access."
              : memoryApp && view
                ? "Remembering is off: this conversation is not saved and ends when you close the workspace."
                : "This conversation is not saved: it ends when you close the workspace. The AI changes nothing."}
            {remembering ? " Nothing in your notes or journal is changed." : ""}
          </p>
          {footer}
          <div ref={end} />
        </div>
      </div>
      <form
        className="border-t border-border bg-card px-2 py-1.5 shrink-0"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 6px)" }}
        onSubmit={(e) => { e.preventDefault(); void send(text); }}
      >
        <div className="flex items-end gap-1.5 max-w-3xl mx-auto">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }}
            rows={1}
            placeholder={placeholder}
            aria-label={placeholder}
            className="ws-title flex-1 min-w-0 max-h-32 rounded-2xl border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/60 resize-none"
            data-testid={`${testId}-input`}
          />
          <DictateButton onText={(t) => setText((v) => (v.trim() ? `${v.replace(/\s+$/, "")} ${t}` : t))} testId={`${testId}-dictate`} className="h-8" />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send"
            className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50 flex items-center gap-1 shrink-0" data-testid={`${testId}-send`}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Version history ──────────────────────────────────────────────────────────

const versionsQueryKey = (kind: VersionKind, id: string) => [`/api/workspace/versions/${kind}/${id}`];

/**
 * The versions kept of one record. Restoring takes two taps (Rule 8) and is
 * itself undoable: what it replaces is kept as a version first.
 */
export function VersionHistory({
  kind, id, onRestored, renderPreview,
}: {
  kind: VersionKind;
  id: string;
  /** The record as the server saved it after a restore. */
  onRestored: (record: any) => void;
  /** How a version's full text is shown (a document is HTML; a note is markdown). */
  renderPreview?: (version: ContentVersion) => ReactNode;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  // Read fresh each time it is opened: a save made a moment ago may have
  // kept a version, and nothing else invalidates this key.
  const list = useQuery<{ versions: VersionSummary[] }>({ queryKey: versionsQueryKey(kind, id), staleTime: 0, refetchOnMount: "always" });
  const [openId, setOpenId] = useState<string | null>(null);
  const full = useQuery<ContentVersion>({ queryKey: [`/api/workspace/versions/${kind}/${id}/${openId}`], enabled: !!openId });
  const [restoring, setRestoring] = useState(false);
  const versions = Array.isArray(list.data?.versions) ? list.data!.versions : [];

  const restore = async (versionId: string) => {
    setRestoring(true);
    try {
      const r = await apiRequest("POST", `/api/workspace/versions/${kind}/${id}/restore`, { versionId });
      const j = await r.json();
      void qc.invalidateQueries({ queryKey: versionsQueryKey(kind, id) });
      setOpenId(null);
      toast({ title: "Version restored", description: "What it replaced was kept as a version, so this can be undone." });
      onRestored(j?.record);
    } catch (err) {
      toast({ title: "Couldn't restore that version", description: aiErrorText(err), variant: "destructive" });
    } finally { setRestoring(false); }
  };

  if (list.isLoading) return <p className="text-xs text-muted-foreground flex items-center gap-2 p-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading versions…</p>;
  if (list.isError) return <LoadError what="the version history" onRetry={() => list.refetch()} testId="versions-error" />;
  return (
    <div data-testid={`versions-${kind}`}>
      <p className="text-[11px] text-muted-foreground mb-2 flex items-center gap-1.5">
        <History className="h-3.5 w-3.5" /> A version is kept when a save replaces the text, about one per sitting (up to 30). The newest text is what is saved now.
      </p>
      {versions.length === 0 ? (
        <p className="text-sm text-muted-foreground p-2" data-testid="versions-empty">No earlier versions yet. One is kept the next time this is changed.</p>
      ) : (
        <ul className="space-y-1.5">
          {versions.map((v) => {
            const open = openId === v.id;
            return (
              <li key={v.id} className={`rounded-xl border ${open ? "border-primary" : "border-border"} bg-card`} data-testid={`version-${v.id}`}>
                <button type="button" className="w-full text-left px-3 py-2" onClick={() => setOpenId(open ? null : v.id)} aria-expanded={open}>
                  <span className="text-sm font-medium block">
                    {new Date(v.savedAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                    {v.reason === "restore" && <span className="ml-2 text-[11px] text-muted-foreground">replaced by a restore</span>}
                  </span>
                  <span className="text-xs text-muted-foreground block truncate">{v.words} {v.words === 1 ? "word" : "words"} · {v.preview || "(no text)"}</span>
                </button>
                {open && (
                  <div className="px-3 pb-3">
                    {full.isLoading ? <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
                      : full.isError || !full.data ? <LoadError what="that version" onRetry={() => full.refetch()} />
                      : (
                        <div className="rounded-lg bg-muted/40 p-2.5 max-h-72 overflow-y-auto text-sm" data-testid="version-preview">
                          {renderPreview ? renderPreview(full.data) : <p className="whitespace-pre-wrap break-words">{full.data.content}</p>}
                        </div>
                      )}
                    <button
                      type="button"
                      disabled={restoring}
                      onClick={() => confirm(`restore:${v.id}`, () => void restore(v.id))}
                      className={`mt-2 h-8 px-3 rounded-full text-xs font-semibold flex items-center gap-1 ${isArmed(`restore:${v.id}`) ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
                      data-testid={`button-version-restore-${v.id}`}
                    >
                      {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      {isArmed(`restore:${v.id}`) ? "Tap again to replace the current text" : "Restore this version"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A small card heading used across the tabs. */
export function SectionTitle({ icon: Icon, children, aside }: { icon?: typeof Sparkles; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      {Icon ? <Icon className="h-4 w-4 text-primary shrink-0" aria-hidden /> : null}
      <h2 className="text-sm font-semibold flex-1 min-w-0">{children}</h2>
      {aside}
    </div>
  );
}
