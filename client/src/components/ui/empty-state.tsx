// ── EmptyState — the one "nothing here" ──────────────────────────────────────
// Rebuilt in the Executive tab's language: a medallion rather than a dimmed
// glyph, an 11px floor, and room for a CTA.
//
// The bigger change is editorial. An empty state was written as an apology —
// "No bills due in the next 14 days" — which reads as a hole in the screen. The
// same fact stated as a result — "You're clear for 14 days" — reads as an
// answer. Callers pass the answer as `label` and set `tone="good"` when the
// emptiness is the good outcome; the medallion turns green and the state stops
// looking like missing content.
//
// `hint` carries "and here's what you could do"; `ctaLabel`/`onCta` the one
// action that would fill it.
//
// `scope` (Rule 4 — a filter can't look like deletion). An empty list on a
// screen filtered by the app-wide profile scope is not "you have none": it
// may be "Max has none". With scope="global" the empty state says which
// profile the screen is filtered to and offers "Show everyone" whenever a
// scope is active (2026-11-09: "Nothing on your list" while the user's own
// two tasks were hidden by a leftover selection). scope="none" declares the
// list does not depend on the global scope. tests/sync-rules-scope-empty-states.test.ts
// requires every EmptyState in a file that reads the scope to choose one.

import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Medallion, tonePalette, type PillTone } from "@/components/dashboard/visuals";
import { cn } from "@/lib/utils";
import { useProfileScope } from "@/hooks/useProfileScope";
import { scopeLabel, setFilterEveryone } from "@/lib/profileFilter";

export function EmptyState({
  icon, label, hint, ctaLabel, onCta, tone = "neutral", accent, className = "", testId, scope = "none",
}: {
  icon?: LucideIcon;
  /** State the outcome, not the absence. "You're clear for 14 days". */
  label: string;
  hint?: string;
  ctaLabel?: string;
  onCta?: () => void;
  /** "good" when empty is the *desired* state — nothing overdue, all caught up. */
  tone?: PillTone;
  /** Raw HSL triple overriding `tone` — use the section's own accent so the
   *  empty medallion doesn't sit grey directly under a coloured heading. */
  accent?: string;
  className?: string;
  testId?: string;
  /** "global": the list is filtered by the app-wide profile scope, so an
   *  active scope is disclosed here. "none": it isn't. */
  scope?: "global" | "none";
}) {
  const active = useProfileScope();
  const scoped = scope === "global" && active.isFiltered;
  return (
    <div
      className={cn("flex flex-col items-center justify-center text-center gap-2.5 py-8 px-4", className)}
      role="status"
      data-testid={testId ?? "empty-state"}
    >
      <Medallion icon={icon ?? Inbox} accent={accent ?? tonePalette(tone)} />
      <p className="text-[13px] font-semibold text-foreground" data-testid="empty-state-title">{label}</p>
      {hint && (
        <p className="text-[11px] text-muted-foreground max-w-[34ch]" data-testid="empty-state-description">
          {hint}
        </p>
      )}
      {scoped && (
        <p className="text-[11px] text-muted-foreground max-w-[40ch]" data-testid="empty-state-scope">
          Filtered to <span className="font-medium text-foreground">{scopeLabel(active.selectedNames, active.mode, active.selectedIds.length)}</span>
          {" "}— anything for anyone else is hidden, not deleted.{" "}
          <button
            type="button"
            onClick={() => setFilterEveryone()}
            className="font-medium text-primary hover:underline"
            data-testid="empty-state-scope-clear"
          >
            Show everyone
          </button>
        </p>
      )}
      {ctaLabel && onCta && (
        <Button size="sm" variant="outline" className="mt-1 h-8 text-xs" onClick={onCta} data-testid="empty-state-cta">
          {ctaLabel}
        </Button>
      )}
    </div>
  );
}

export default EmptyState;
