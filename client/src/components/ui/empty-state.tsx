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

import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Medallion, tonePalette, type PillTone } from "@/components/dashboard/visuals";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon, label, hint, ctaLabel, onCta, tone = "neutral", className = "", testId,
}: {
  icon?: LucideIcon;
  /** State the outcome, not the absence. "You're clear for 14 days". */
  label: string;
  hint?: string;
  ctaLabel?: string;
  onCta?: () => void;
  /** "good" when empty is the *desired* state — nothing overdue, all caught up. */
  tone?: PillTone;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center text-center gap-2.5 py-8 px-4", className)}
      role="status"
      data-testid={testId ?? "empty-state"}
    >
      <Medallion icon={icon ?? Inbox} accent={tonePalette(tone)} />
      <p className="text-[13px] font-semibold text-foreground" data-testid="empty-state-title">{label}</p>
      {hint && (
        <p className="text-[11px] text-muted-foreground max-w-[34ch]" data-testid="empty-state-description">
          {hint}
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
