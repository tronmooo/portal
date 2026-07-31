// ── Chat suggestions ─────────────────────────────────────────────────────────
// The empty state of the chat page, and the follow-up row after a reply.
//
// What this replaces: a big logo, a tagline, a welcome bubble repeating the
// tagline, a screen of dead space between them, and six hardcoded chips. The
// logo was clipped off the top of the scroll box and the bubble was sliced
// mid-sentence by the chip row sitting outside the scroll container.
//
// What's here instead: a greeting that has read your data, and suggestions that
// were earned from specific records (shared/chat-suggestions.ts). Each carries
// the observation that produced it, because "Log weight" is a guess and "Log
// weight · last logged 6 days ago" is something the app noticed.
//
// Presentation only — the caller computes the suggestions and owns submission.

import { Medallion } from "@/components/dashboard/visuals";
import { conceptIcon, conceptAccent } from "@/lib/icon-map";
import type { ChatSuggestion } from "@shared/chat-suggestions";

/** Chat's own accent: the app primary, so this page doesn't invent an eighth hue. */
export const CHAT_ACCENT = "188 45% 52%";

function greetingFor(now: Date): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The line under the greeting.
 *
 * COUNTS, not a repeat of the list. The first version echoed the top two
 * suggestions verbatim — "Mark morning walk done · still due today · Pay
 * Progressive Au…" — directly above cards saying exactly that. Same duplicate-
 * information problem the Executive tab was rebuilt to remove: every item
 * should appear once. This says how much is waiting; the cards say what.
 */
function summaryLine(suggestions: ChatSuggestion[]): string | null {
  const n = (k: ChatSuggestion["kind"]) => suggestions.filter((s) => s.kind === k).length;
  const parts: string[] = [];
  const due = n("due");
  const gaps = n("gap");
  if (due > 0) parts.push(`${due} thing${due === 1 ? "" : "s"} need${due === 1 ? "s" : ""} you`);
  if (gaps > 0) parts.push(`${gaps} tracker${gaps === 1 ? "" : "s"} gone quiet`);
  return parts.length ? parts.join(" · ") : null;
}

export function ChatSuggestions({
  suggestions, onPick, name, now = new Date(), testId = "chat-suggestions",
}: {
  suggestions: ChatSuggestion[];
  onPick: (text: string) => void;
  /** First name of whoever the chat is scoped to. Omit for "Everyone". */
  name?: string | null;
  now?: Date;
  testId?: string;
}) {
  const summary = summaryLine(suggestions);
  return (
    <div className="w-full" data-testid={testId}>
      {/* Brand + greeting. The logo is small and INSIDE the normal flow — the
          old hero was `flex-1` inside a bottom-aligned 72vh box, which pushed
          it above the top of the scroll viewport on a phone. */}
      <div className="flex items-center gap-3 mb-5">
        <img
          src="/portol-logo-clean.png"
          alt=""
          className="w-11 h-11 object-contain shrink-0"
          style={{ filter: "drop-shadow(0 0 14px rgba(0,200,220,0.4))" }}
        />
        <div className="min-w-0">
          <p className="text-lg font-bold tracking-tight leading-tight">
            {greetingFor(now)}{name ? `, ${name}` : ""}.
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {summary ?? "Ask me anything, or start with one of these."}
          </p>
        </div>
      </div>

      <p className="micro-label text-muted-foreground mb-2">Suggested for you</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {suggestions.map((s, i) => (
          <button
            key={s.id}
            onClick={() => onPick(s.text)}
            className="bubble-row pressable bubble-enter flex items-center gap-3 px-3 py-2.5 text-left w-full"
            style={{ ["--accent-hsl" as any]: conceptAccent(s.icon), ["--i" as any]: i }}
            data-testid={`chat-suggestion-${s.id}`}
          >
            <Medallion icon={conceptIcon(s.icon)} accent={conceptAccent(s.icon)} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold leading-tight truncate">{s.label}</span>
              {s.reason && (
                <span className="block text-[11px] text-muted-foreground truncate mt-0.5">{s.reason}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The compact row after a reply. Same data, different density — you're mid-task
 * here, so these are one-line chips rather than cards.
 */
export function ChatFollowUps({
  suggestions, onPick, testId = "chat-followups",
}: {
  suggestions: ChatSuggestion[];
  onPick: (text: string) => void;
  testId?: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-1" data-testid={testId}>
      {suggestions.map((s, i) => (
        <button
          key={s.id}
          onClick={() => onPick(s.text)}
          className="bubble-row pressable bubble-enter inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium"
          style={{ ["--accent-hsl" as any]: conceptAccent(s.icon), ["--i" as any]: i }}
          data-testid={`chat-followup-${s.id}`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export default ChatSuggestions;
