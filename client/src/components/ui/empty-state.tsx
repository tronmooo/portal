// One consistent empty-state for lists/pop-ups: muted icon, label, optional
// hint, optional CTA. Replaces the ad-hoc "No X yet" blocks that each rendered
// different spacing/markup across the dashboard, finance, and pop-ups.
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState({
  icon: Icon, label, hint, ctaLabel, onCta, className = "",
}: {
  icon?: LucideIcon;
  label: string;
  hint?: string;
  ctaLabel?: string;
  onCta?: () => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center gap-2 py-8 px-4 ${className}`}>
      {Icon && <Icon className="h-9 w-9 text-muted-foreground/40" />}
      <p className="text-sm text-muted-foreground">{label}</p>
      {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
      {ctaLabel && onCta && (
        <Button size="sm" variant="outline" className="mt-1" onClick={onCta} data-testid="empty-state-cta">
          {ctaLabel}
        </Button>
      )}
    </div>
  );
}
