// ── Page shell — one layout skeleton for every standalone page ───────────────
// Pages diverged: some `max-w-2xl`, some `max-w-4xl`, some full-width; different
// paddings and header treatments. PageContainer + PageHeader give every page the
// SAME width, padding rhythm, scroll behavior, and header design so the app
// reads as one product. Hub-embedded pages hide their own chrome and don't use
// these (the hub supplies the frame).
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { Medallion } from "@/components/dashboard/visuals";
import { hashNavigate } from "@/lib/hashNavigate";

type Width = "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "full";
const WIDTH: Record<Width, string> = {
  "2xl": "max-w-2xl", "3xl": "max-w-3xl", "4xl": "max-w-4xl",
  "5xl": "max-w-5xl", "6xl": "max-w-6xl", full: "",
};

// The scroll container + consistent padding/width every page opts into.
export function PageContainer({
  width = "5xl", className, children, testId,
}: {
  width?: Width; className?: string; children: React.ReactNode; testId?: string;
}) {
  return (
    <div className="h-full overflow-y-auto pb-24" data-testid={testId}>
      <div className={cn("mx-auto px-4 py-4 md:px-6 md:py-6 space-y-4", WIDTH[width], className)}>
        {children}
      </div>
    </div>
  );
}

// The one page header: optional back button, icon medallion, title, subtitle,
// and a right-aligned actions slot. This is SectionHeading at page scale — same
// medallion, same bold tracking — so a standalone page and a hub tab read as
// the same product. (It used to draw its own rounded-square tinted chip, which
// is the treatment the rest of the app moved off.)
export function PageHeader({
  title, subtitle, icon: Icon, accent = "213 90% 62%", backHref, onBack, actions, testId,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: LucideIcon;
  /** HSL triple `H S% L%` (no wrapper). */
  accent?: string;
  backHref?: string;
  onBack?: () => void;
  actions?: React.ReactNode;
  testId?: string;
}) {
  const showBack = !!(backHref || onBack);
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      {showBack && (
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Back"
          onClick={() => (onBack ? onBack() : hashNavigate(backHref!))} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      )}
      {Icon && <Medallion icon={Icon} accent={accent} />}
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-bold tracking-tight leading-tight truncate">{title}</h1>
        {subtitle && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
