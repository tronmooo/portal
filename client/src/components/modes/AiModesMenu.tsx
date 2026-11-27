// AI Modes on the Chat page (owner request 2026-11-27): "keep the current
// modes and introduce a More button without overcrowding the Chat page."
//
//  - `ModeTiles` — the home's row: Chat, Notes, Journal, Word, Fill In, the
//    modes the person PINNED, and More.
//  - `ModesSheet` — what More opens: Your AI Modes (each opens its own app),
//    Customize, Create Mode, and the pages that used to crowd the row
//    (Documents, Analyze, Plan, Dashboard). During a conversation the chat
//    box opens the same sheet from one small button, with the workspaces at
//    its top, so nothing is pinned above the box while reading.
//
// The list comes in as props (`ModesState`), read once by the page with
// useAiModes: a failed read is an error with a retry, never "no modes" (Rule 7).
// Opening the sheet writes nothing (Rule 3).
import { useState } from "react";
import { ChevronRight, LayoutGrid, Loader2, MessageCircle, Plus, Settings2, Sparkles } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { hashNavigate } from "@/lib/hashNavigate";
import { MODES_ROUTE, modeRoute } from "@/lib/ai-modes-client";
import { WORKSPACES, type WorkspaceKind } from "@/components/workspace/WorkspaceShell";
import type { AiMode } from "@shared/ai-modes";
import { ModeGlyph, MODE_ICON_COMPONENTS, modeHsl } from "./ModeIcon";
import { CHAT_APPS } from "@/components/chat/chat-apps";

export interface ModesState { modes?: AiMode[]; failed?: boolean; retry?: () => void }

/** The four page shortcuts, named for where they go. */
const APP_LABEL: Record<string, string> = { documents: "Documents", analyze: "Analyze", plan: "Plan", more: "Dashboard" };

export function ModesSheet({ open, onOpenChange, state, onOpenWorkspace, onOpenApp = hashNavigate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ModesState;
  /** With this, the workspaces lead the sheet (the chat box's button). */
  onOpenWorkspace?: (kind: WorkspaceKind) => void;
  onOpenApp?: (href: string) => void;
}) {
  const go = (href: string) => { onOpenChange(false); hashNavigate(href); };
  const modes = state.modes ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-3xl p-4 pb-[max(env(safe-area-inset-bottom),16px)]" data-testid="modes-sheet">
        <div className="max-w-2xl mx-auto space-y-4">
          <div>
            <SheetTitle className="text-base">AI Modes</SheetTitle>
            <SheetDescription className="text-[12px]">Each one is its own workspace. Chat is the box on the page.</SheetDescription>
          </div>

          {onOpenWorkspace && (
            <section aria-label="Built-in modes" className="grid grid-cols-4 gap-2">
              {(Object.keys(WORKSPACES) as WorkspaceKind[]).map((kind) => {
                const { label, icon: Icon, blurb } = WORKSPACES[kind];
                return (
                  <button key={kind} type="button" title={blurb} onClick={() => { onOpenChange(false); onOpenWorkspace(kind); }}
                    className="aurora-mode pressable rounded-2xl py-2.5 text-[11.5px] font-medium flex flex-col items-center gap-1" data-testid={`button-workspace-${kind}`}>
                    <Icon className="h-5 w-5" aria-hidden="true" /> {label}
                  </button>
                );
              })}
            </section>
          )}

          <section aria-label="Your AI modes">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-bold">Your AI Modes</p>
              <button type="button" onClick={() => go(MODES_ROUTE)} className="aurora-link text-xs font-semibold inline-flex items-center gap-1" data-testid="modes-sheet-customize">
                <Settings2 className="h-3.5 w-3.5" /> Customize
              </button>
            </div>
            {state.failed ? (
              <p className="text-[12px] text-destructive" role="alert" data-testid="modes-sheet-error">
                Couldn't load your modes. {state.retry && <button type="button" className="underline" onClick={state.retry}>Retry</button>}
              </p>
            ) : !state.modes ? (
              <p className="text-[12px] text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
            ) : modes.length === 0 ? (
              <p className="text-[12px] text-muted-foreground" data-testid="modes-sheet-empty">None yet — build your first one below.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="modes-sheet-list">
                {modes.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => go(modeRoute(m.id))} className="bubble pressable w-full p-2.5 flex items-center gap-2.5 text-left" data-testid={`modes-sheet-open-${m.id}`}>
                      <ModeGlyph icon={m.icon} color={m.color} size="sm" />
                      <span className="flex-1 min-w-0">
                        <span className="text-sm font-semibold block truncate">{m.name}</span>
                        {m.tagline && <span className="text-[11px] text-muted-foreground block truncate">{m.tagline}</span>}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <button type="button" onClick={() => go(`${MODES_ROUTE}?new=1`)} className="aurora-tile pressable w-full p-3 rounded-2xl flex items-start gap-3 text-left" data-testid="modes-sheet-create">
            <span className="h-9 w-9 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0"><Plus className="h-5 w-5" /></span>
            <span className="min-w-0">
              <span className="text-sm font-bold block">Create Mode</span>
              <span className="text-[12px] text-muted-foreground block">Build your own AI mode. Describe what you want your AI to do — we'll build a workspace around it.</span>
            </span>
          </button>

          <section aria-label="Pages">
            <p className="text-sm font-bold mb-2">Go to</p>
            <div className="grid grid-cols-4 gap-2">
              {CHAT_APPS.map(({ id, icon: Icon, href, blurb }) => (
                <button key={id} type="button" title={blurb} onClick={() => { onOpenChange(false); onOpenApp(href); }}
                  className="aurora-mode pressable rounded-2xl py-2.5 text-[11.5px] font-medium flex flex-col items-center gap-1" data-testid={`button-app-${id}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" /> {APP_LABEL[id] ?? id}
                </button>
              ))}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const MODE_TILE = "aurora-mode pressable shrink-0 min-w-[68px] px-2.5 py-2.5 rounded-2xl text-[11.5px] font-medium flex flex-col items-center justify-center gap-1.5";

/** The home's AI Modes row. Chat focuses the box; the rest open their own app. */
export function ModeTiles({ state, onOpenWorkspace, onFocusChat }: { state: ModesState; onOpenWorkspace: (kind: WorkspaceKind) => void; onFocusChat?: () => void }) {
  const [open, setOpen] = useState(false);
  const pinned = (state.modes ?? []).filter((m) => m.pinned);
  return (
    <>
      <div className="flex items-stretch gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1" data-swipe-ignore>
        <button type="button" onClick={onFocusChat} aria-current="true" className={`${MODE_TILE} aurora-mode-active`} data-testid="button-mode-chat">
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
        {pinned.map((m) => {
          const Icon = MODE_ICON_COMPONENTS[m.icon] ?? Sparkles;
          return (
            <button key={m.id} type="button" onClick={() => hashNavigate(modeRoute(m.id))} title={m.tagline || m.name} className={MODE_TILE} data-testid={`button-ai-mode-${m.id}`}>
              <Icon className="h-5 w-5" style={{ color: `hsl(${modeHsl(m.color)})` }} aria-hidden="true" /> <span className="max-w-[76px] truncate">{m.name}</span>
            </button>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className={MODE_TILE} data-testid="button-modes-more">
          <LayoutGrid className="h-5 w-5" aria-hidden="true" /> More
        </button>
      </div>
      <ModesSheet open={open} onOpenChange={setOpen} state={state} />
    </>
  );
}
