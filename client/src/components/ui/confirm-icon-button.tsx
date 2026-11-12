// A small destructive icon button that takes two taps (CLAUDE.md rule 8).
//
// The trash can / X at the end of a row used to fire its DELETE on the first
// tap in a dozen places — a payment reversal, a co-owner, a budget, a saved
// fact — with no confirmation and no undo, and on a phone a scroll that ends
// on a button IS a tap. One component so every such control behaves the same:
// the first tap arms it and swaps the icon for a worded prompt ("Delete?"),
// a second tap within the window runs the action, anything else disarms it.
import * as React from "react";
import { useConfirmArm } from "@/hooks/useConfirmArm";

export interface ConfirmIconButtonProps {
  /** Runs on the confirming (second) tap. */
  onConfirm: () => void;
  /** What the control does, for assistive tech and the tooltip: "Delete payment". */
  label: string;
  /** The worded prompt shown while armed. Default "Delete?". */
  armedText?: string;
  /** True while the action is running — blocks a second request. */
  pending?: boolean;
  className?: string;
  armedClassName?: string;
  children: React.ReactNode;
  "data-testid"?: string;
}

export function ConfirmIconButton({
  onConfirm, label, armedText = "Delete?", pending = false, className, armedClassName, children, ...rest
}: ConfirmIconButtonProps) {
  const { confirm, isArmed, disarm } = useConfirmArm();
  const armed = isArmed("x");
  return (
    <button
      type="button"
      disabled={pending}
      className={armed
        ? (armedClassName ?? "shrink-0 text-[11px] font-semibold text-destructive px-1.5 py-0.5 rounded-md bg-destructive/10")
        : className}
      onClick={(e) => { e.stopPropagation(); if (pending) return; confirm("x", onConfirm); }}
      onBlur={() => { if (armed) disarm(); }}
      aria-label={armed ? `Tap again: ${label}` : label}
      title={armed ? "Tap again to confirm" : label}
      data-armed={armed ? "true" : undefined}
      data-testid={rest["data-testid"]}
    >
      {armed ? armedText : children}
    </button>
  );
}
