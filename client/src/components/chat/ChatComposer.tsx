// ── Chat composer ────────────────────────────────────────────────────────────
// PERF (2026-07-21, QA scorecard defect #2): the composer textarea used to live
// directly inside the 3.6k-line chat page component, so EVERY keystroke
// re-rendered the entire page — all bubbles, images, and tool cards. The input
// state now lives here; the parent only hears about boundary events:
//  - onSubmit(text)   → user pressed Send / Enter (returns true if consumed,
//                       in which case the composer clears itself)
//  - onEmptyChange    → fires only when the draft flips empty ⇄ non-empty
//                       (the parent uses it to show/hide starter prompts)
// Programmatic access (suggestion chips, seeding an attachment note from the
// draft) goes through the imperative ChatComposerHandle instead of lifted state.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { BarChart3, CalendarDays, Camera, FolderOpen, Layers, LayoutGrid, Loader2, MessageCircle, Mic, Paperclip, RotateCcw, Search, Send, type LucideIcon } from "lucide-react";
import { WORKSPACES, type WorkspaceKind } from "@/components/workspace/WorkspaceShell";
import { useToast } from "@/hooks/use-toast";

// Moved verbatim from pages/chat.tsx — the composer is the only consumer.
function useSpeechInput(onResult: (text: string) => void, onError?: (title: string, description?: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const start = useCallback(async () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      onError?.("Voice input not supported", "Use Chrome or Safari for voice input.");
      return;
    }

    // If running in Capacitor, request native mic permission
    if ((window as any).Capacitor?.isNativePlatform()) {
      try {
        // Dynamic import with variable to prevent Rollup from resolving at build time
        const modPath = '@capacitor-community/microphone';
        const mod = await (Function('p', 'return import(p)'))(modPath);
        const permission = await mod.Microphone.requestPermission();
        if (permission.microphone !== 'granted') {
          onError?.("Microphone permission required", "Enable microphone access in your device settings.");
          return;
        }
      } catch { /* Capacitor plugin not installed, fallback to web */ }
    }

    // Check browser microphone permission
    if (navigator.permissions) {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (result.state === 'denied') {
          onError?.("Microphone access denied", "Enable microphone in your browser settings.");
          return;
        }
      } catch { /* permissions API not supported for microphone in this browser */ }
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      onResult(transcript);
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [onResult, onError]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const supported = typeof window !== 'undefined' && (
    !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition
  );

  return { listening, start, stop, supported };
}

/** The pages offered beside the workspaces, here and on the chat home. */
export const CHAT_APPS: Array<{ id: string; label: string; icon: LucideIcon; href: string; blurb: string }> = [
  { id: "documents", label: "Documents", icon: FolderOpen, href: "/artifacts", blurb: "Everything you have saved" },
  { id: "analyze", label: "Analyze", icon: BarChart3, href: "/insights", blurb: "Patterns across your records" },
  { id: "plan", label: "Plan", icon: CalendarDays, href: "/calendar", blurb: "Your calendar" },
  { id: "more", label: "More", icon: LayoutGrid, href: "/dashboard", blurb: "The full dashboard" },
];

const MODE_TILE = "aurora-mode pressable shrink-0 min-w-[68px] px-2.5 py-2.5 rounded-2xl text-[11.5px] font-medium flex flex-col items-center justify-center gap-1.5";
const MODE_PILL ="aurora-mode pressable shrink-0 h-7 px-2.5 rounded-full text-xs font-medium flex items-center gap-1";

export interface ChatComposerHandle {
  /** Current draft text (used to seed an attachment note from the draft). */
  getText: () => string;
  /** Replace the draft (suggestion chips, external prefill). */
  setText: (text: string) => void;
  /** Clear the draft. */
  clear: () => void;
  /** Focus the textarea. */
  focus: () => void;
}

interface ChatComposerProps {
  /** Called with the raw draft on send. Return true to consume (clears the draft). */
  onSubmit: (text: string) => boolean;
  isPending: boolean;
  searchOpen: boolean;
  onToggleSearch: () => void;
  /** Open the hidden file input (lives in the parent next to its handlers). */
  onAttach: () => void;
  /** Fires on pointerdown of the attach button — before click — so the parent
   *  can warm lazy chunks (e.g. SmartFillDialog) ahead of first open. */
  onAttachPointerDown?: () => void;
  showReset: boolean;
  onReset: () => void;
  /** Fires only when the draft flips between empty and non-empty. */
  onEmptyChange?: (empty: boolean) => void;
  /** The "+ New doc/sheet" button — rendered by the parent, slotted in here. */
  newDocButton?: ReactNode;
  /**
   * The Notes / Journal / Document / Fill In buttons: each opens its own
   * full-screen workspace. They do not change what the chat box does.
   */
  onOpenWorkspace?: (kind: WorkspaceKind) => void;
  /** The Documents / Analyze / Plan / More tiles: each goes to its page. */
  onOpenApp?: (href: string) => void;
  /** Before the first message the modes are drawn as tiles, pinned with the box. */
  modeTiles?: boolean;
  /** Files dropped onto the box (same as picking them with the paperclip). */
  onDropFiles?: (files: File[]) => void;
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  {
    onSubmit,
    isPending,
    searchOpen,
    onToggleSearch,
    onAttach,
    onAttachPointerDown,
    showReset,
    onReset,
    onEmptyChange,
    newDocButton,
    onOpenWorkspace,
    onOpenApp,
    modeTiles,
    onDropFiles,
  },
  ref,
) {
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Keep the latest draft readable from the stable imperative handle.
  const inputValueRef = useRef(input);
  inputValueRef.current = input;
  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;

  // Notify the parent only on empty ⇄ non-empty flips (starts as null so the
  // parent re-syncs on every mount — the composer unmounts while an attachment
  // is staged).
  const emptyRef = useRef<boolean | null>(null);
  useEffect(() => {
    const empty = input.trim().length === 0;
    if (empty !== emptyRef.current) {
      emptyRef.current = empty;
      onEmptyChangeRef.current?.(empty);
    }
  }, [input]);

  // Read prefill set by popup AI buttons (sessionStorage approved for this use)
  useEffect(() => {
    try {
      const prefill = sessionStorage.getItem('portol_chat_prefill');
      if (prefill) { setInput(prefill); sessionStorage.removeItem('portol_chat_prefill'); }
    } catch {}
  }, []);

  useImperativeHandle(ref, () => ({
    getText: () => inputValueRef.current,
    setText: (text: string) => setInput(text),
    clear: () => setInput(""),
    focus: () => textareaRef.current?.focus(),
  }), []);

  const speech = useSpeechInput(
    useCallback((text: string) => setInput(prev => prev ? prev + ' ' + text : text), []),
    useCallback((title: string, description?: string) => toast({ title, description, variant: 'destructive' }), [toast]),
  );

  const handleSubmit = () => {
    // The LATEST draft, through the ref rather than the render closure, and
    // cleared synchronously BEFORE the parent dispatches the send. The old
    // order — send first, clear on a truthy return — let a re-render land
    // between the two with the draft still in state, so roughly one send in
    // five stayed in the box after appearing in the thread, and Send again
    // sent it twice (QA 2026-09-18 F-45). State, ref AND the DOM value are
    // cleared together so no controlled-value round trip can restore it; a
    // rejected send (one already in flight) hands the draft back untouched.
    const draft = inputValueRef.current;
    if (!draft.trim()) return;
    setInput("");
    inputValueRef.current = "";
    if (textareaRef.current) textareaRef.current.value = "";
    try { sessionStorage.removeItem('portol_chat_prefill'); } catch {}
    if (!onSubmit(draft)) {
      // React bails out of a re-render when state lands where it started, so
      // the DOM value is put back by hand too.
      setInput(draft);
      inputValueRef.current = draft;
      if (textareaRef.current) textareaRef.current.value = draft;
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // Enter that commits an IME composition is not a send; a held key that
      // auto-repeats is one send, not one per repeat.
      if ((e.nativeEvent as any)?.isComposing) return;
      e.preventDefault();
      if (e.repeat) return;
      handleSubmit();
    }
  };

  return (
    <div className="px-3 pt-2 pb-[env(safe-area-inset-bottom,12px)] bg-background/95 backdrop-blur-sm border-t border-border/40">
      <div className="max-w-2xl mx-auto">
        {/* The field's label. The modes row is what is on screen (owner's
            design, 2026-11-25); the label stays for assistive tech, so the box
            is never unlabelled once the placeholder is typed over. */}
        <label htmlFor="chat-message-input" className="sr-only">Message</label>
        {/* AI Modes, as one compact line. Chat is this box; each of the
            others is its own tool — a full-screen workspace or a page — not a
            version of this box. Before the first message the chat home shows
            them as tiles instead (`hideModes`), so they are on screen once.
            The row scrolls sideways inside itself (T1: data-swipe-ignore). */}
        {onOpenWorkspace && modeTiles && (
          <section aria-label="AI modes" data-testid="chat-modes" className="pb-2">
            <div className="flex items-center gap-2 pb-2 text-[15px] font-bold">
              <Layers className="h-4 w-4 text-primary" aria-hidden="true" /> AI Modes{" "}
              <span className="text-xs font-medium text-muted-foreground">(Apps)</span>
            </div>
            <div className="flex items-stretch gap-2 overflow-x-auto no-scrollbar -mx-3 px-3" data-swipe-ignore>
              <button type="button" onClick={() => textareaRef.current?.focus()} aria-current="true" className={`${MODE_TILE} aurora-mode-active`} data-testid="button-mode-chat">
                <MessageCircle className="h-5 w-5" aria-hidden="true" /> Chat
              </button>
              {(Object.keys(WORKSPACES) as WorkspaceKind[]).map((kind) => {
                const { label, icon: Icon, blurb } = WORKSPACES[kind];
                return (
                  <button key={kind} type="button" onClick={() => onOpenWorkspace(kind)} title={blurb} className={MODE_TILE} data-testid={`button-workspace-${kind}`}>
                    <Icon className="h-5 w-5" aria-hidden="true" /> {label}
                  </button>
                );
              })}
              {onOpenApp && CHAT_APPS.map(({ id, label, icon: Icon, href, blurb }) => (
                <button key={id} type="button" onClick={() => onOpenApp(href)} title={blurb} className={MODE_TILE} data-testid={`button-app-${id}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" /> {label}
                </button>
              ))}
            </div>
          </section>
        )}
        {onOpenWorkspace && !modeTiles && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-3 px-3 pb-2" data-swipe-ignore data-testid="chat-modes">
            {(Object.keys(WORKSPACES) as WorkspaceKind[]).map((kind) => {
              const { label, icon: Icon, blurb } = WORKSPACES[kind];
              return (
                <button key={kind} type="button" onClick={() => onOpenWorkspace(kind)} title={blurb} className={MODE_PILL} data-testid={`button-workspace-${kind}`}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              );
            })}
            {onOpenApp && CHAT_APPS.map(({ id, label, icon: Icon, href, blurb }) => (
              <button key={id} type="button" onClick={() => onOpenApp(href)} title={blurb} className={MODE_PILL} data-testid={`button-app-${id}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        )}
        {/* Large prominent input box */}
        <div
          className={`bubble aurora-composer relative transition-all duration-200 ${dragOver ? "ring-2 ring-primary border-primary" : ""}`}
          onDragOver={(e) => {
            if (!onDropFiles || !Array.from(e.dataTransfer?.types || []).includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!onDropFiles) return;
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length === 0) return;
            e.preventDefault();
            setDragOver(false);
            onDropFiles(files);
          }}
          data-testid="chat-drop-zone"
        >
          {dragOver && (
            <div className="absolute inset-0 z-20 rounded-2xl bg-primary/10 flex items-center justify-center text-sm font-medium text-primary pointer-events-none" data-testid="chat-drop-hint">
              Drop to attach
            </div>
          )}
          <Textarea
            id="chat-message-input"
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything, or drop a file here…"
            maxLength={10000}
            className="min-h-[76px] max-h-[280px] resize-none border-0 bg-transparent px-4 pt-3.5 pb-14 text-sm leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 rounded-2xl"
            rows={3}
            data-testid="input-chat"
          />
          {/* Action row inside the box. z-10 keeps these controls stacked
              ABOVE the textarea — without it, on mobile the native textarea
              (which extends under this row via its pb-14 padding) could
              swallow taps meant for the Send button, so only the Enter key
              worked (#2, 2026-06-25 user report). */}
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between px-3 pb-3">
            <div className="flex items-center gap-0.5">
              <button
                onClick={onAttach}
                onPointerDown={onAttachPointerDown}
                disabled={isPending}
                title="Attach file or image"
                aria-label="Attach file or image"
                data-testid="button-attach"
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              {/* Doc/Sheet creator — opens a popover with two tiles, then
                  navigates to /editor/new/<type>?source=chat. The editor
                  saves to the existing artifacts table; on save it surfaces
                  both as a chat preview card and on the Artifacts page. */}
              {newDocButton}
              <button
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                onClick={() => {
                  // On mobile, opens camera. On desktop where `capture` is
                  // ignored, this falls through to a normal image picker.
                  const camera = document.getElementById('camera-capture') as HTMLInputElement | null;
                  if (camera) {
                    // Reset value so re-selecting the same photo re-fires onChange
                    camera.value = '';
                    camera.click();
                  }
                }}
                disabled={isPending}
                title="Take photo / pick image"
                aria-label="Take photo or pick image"
                data-testid="button-camera"
              >
                <Camera className="h-4 w-4" />
              </button>
              {/* Search button */}
              <button
                onClick={onToggleSearch}
                title="Search messages"
                aria-label="Search messages"
                data-testid="button-chat-search"
                className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
                  searchOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                }`}
              >
                <Search className="h-4 w-4" />
              </button>
              <button
                onClick={() => speech.listening ? speech.stop() : speech.start()}
                title={!speech.supported ? 'Voice input not supported in this browser. Use Chrome or Safari.' : speech.listening ? 'Recording… click to stop' : 'Voice input'}
                aria-label={speech.listening ? 'Stop recording' : 'Start voice input'}
                data-testid="button-voice-input"
                className={`h-8 rounded-lg flex items-center justify-center transition-colors ${
                  speech.listening
                    ? 'px-2 gap-1 text-red-500 bg-red-500/10 ring-1 ring-red-500/40'
                    : 'w-8 ' + (!speech.supported
                      ? 'text-muted-foreground/40 cursor-not-allowed'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60')
                }`}
              >
                {speech.listening ? (
                  <>
                    {/* Animated waveform bars to show the mic is live */}
                    <span className="flex items-end gap-0.5" aria-hidden="true">
                      <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-1" style={{ height: 6 }} />
                      <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-2" style={{ height: 10 }} />
                      <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-3" style={{ height: 14 }} />
                      <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-2" style={{ height: 10 }} />
                      <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-1" style={{ height: 6 }} />
                    </span>
                    <span className="micro-label">Rec</span>
                  </>
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              {input.length > 9000 && (
                <span className={`text-xs tabular-nums ${input.length >= 10000 ? 'text-red-500 font-medium' : 'text-muted-foreground'}`} data-testid="chat-char-count">
                  {input.length.toLocaleString()}/10,000
                </span>
              )}
              {showReset && (
                <button
                  onClick={onReset}
                  className="h-8 px-2.5 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors flex items-center gap-1"
                  aria-label="Reset chat"
                  title="Reset chat"
                  data-testid="button-reset-chat"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              )}
              <Button
                onClick={handleSubmit}
                disabled={!input.trim() || isPending}
                size="sm"
                className="aurora-send h-9 px-5 rounded-xl text-[13px] font-semibold gap-1.5 hover:scale-105 active:scale-95 transition-transform"
                data-testid="button-send"
              >
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="h-3.5 w-3.5" /> Send</>}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatComposer;
