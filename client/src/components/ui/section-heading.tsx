// ── SectionHeading ───────────────────────────────────────────────────────────
// The heading above a group of content, identical on every hub tab.
//
// It exists because each tab had grown its own: different sizes, different
// weights, an icon here and none there. That inconsistency is most of why the
// tabs read as separate products rather than one app. This is the Executive
// tab's treatment — icon medallion, bold title, count pill — packaged so the
// other tabs use it verbatim.

import { ChevronDown, type LucideIcon } from "lucide-react";
import { Medallion } from "@/components/dashboard/visuals";

export function SectionHeading({
  title, icon, accent, count, meta, onClick, expanded, size = "md", testId,
}: {
  title: string;
  icon: LucideIcon;
  /** HSL triple, e.g. "155 65% 45%". */
  accent: string;
  count?: number;
  /** Right-hand context — progress, totals, "3 overdue". */
  meta?: React.ReactNode;
  /** Makes the heading a control: opens a popup, or expands the section. */
  onClick?: () => void;
  /** When set, renders a chevron and reports state to assistive tech. */
  expanded?: boolean;
  size?: "md" | "lg";
  testId?: string;
}) {
  const inner = (
    <>
      <Medallion icon={icon} accent={accent} size={size === "lg" ? "lg" : "sm"} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className={`font-bold tracking-tight truncate ${size === "lg" ? "text-base" : "text-sm"}`}>
            {title}
          </h3>
          {typeof count === "number" && count > 0 && (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums"
              style={{ background: `hsl(${accent} / 0.16)`, color: `hsl(${accent})` }}
            >
              {count}
            </span>
          )}
        </div>
      </div>
      {meta && <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>}
      {expanded !== undefined && (
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
      )}
    </>
  );

  if (!onClick) {
    return <div className="flex items-center gap-3 mb-3" data-testid={testId}>{inner}</div>;
  }
  return (
    <button
      onClick={onClick}
      className="pressable w-full flex items-center gap-3 mb-3 text-left rounded-xl touch-hit"
      aria-expanded={expanded}
      data-testid={testId}
    >
      {inner}
    </button>
  );
}

export default SectionHeading;
