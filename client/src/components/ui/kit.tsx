// ── Small shared design-kit primitives ───────────────────────────────────────
// FilterChip, StatusBadge, CollapseArrow, IconButton, DashboardCard, DataTable.
// All built on existing tokens/components so the whole app shares one look.
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, type LucideIcon } from "lucide-react";

// A selectable filter/segment chip (category chips, view toggles, tab filters).
export function FilterChip({
  active, onClick, children, className, testId,
}: {
  active?: boolean; onClick?: () => void; children: React.ReactNode; className?: string; testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/60 bg-card/60 text-muted-foreground hover:text-foreground hover:bg-muted/50",
        className,
      )}
    >
      {children}
    </button>
  );
}

// Status pill with a small tone vocabulary shared across the app.
export type StatusTone = "pos" | "neg" | "warn" | "info" | "neutral";
const STATUS_CLASS: Record<StatusTone, string> = {
  pos: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  neg: "border-red-500/30 bg-red-500/10 text-red-500",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-500",
  neutral: "border-border bg-muted/40 text-muted-foreground",
};
export function StatusBadge({ tone = "neutral", children, className, testId }: {
  tone?: StatusTone; children: React.ReactNode; className?: string; testId?: string;
}) {
  return (
    <Badge variant="outline" data-testid={testId}
      className={cn("font-medium", STATUS_CLASS[tone], className)}>
      {children}
    </Badge>
  );
}

// A chevron that rotates on expand — the one collapse affordance for every
// collapsible section (replaces the assorted chevron implementations).
export function CollapseArrow({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronDown
      className={cn("h-4 w-4 text-muted-foreground transition-transform duration-200 shrink-0", open && "rotate-180", className)}
      aria-hidden="true"
    />
  );
}

// Square icon-only button, consistent hit target.
export function IconButton({
  icon: Icon, label, onClick, className, testId, variant = "ghost",
}: {
  icon: LucideIcon; label: string; onClick?: () => void; className?: string;
  testId?: string; variant?: "ghost" | "outline";
}) {
  return (
    <Button type="button" size="icon" variant={variant} onClick={onClick}
      aria-label={label} title={label} data-testid={testId} className={cn("h-8 w-8", className)}>
      <Icon className="h-4 w-4" />
    </Button>
  );
}

// Neutral (non-accent) section card: consistent surface, radius, padding.
export function DashboardCard({ className, children, testId, ...rest }: React.HTMLAttributes<HTMLDivElement> & { testId?: string }) {
  return (
    <div data-testid={testId}
      className={cn("shadcn-card bubble p-4", className)} {...rest}>
      {children}
    </div>
  );
}

// A minimal shared table wrapper (horizontal-scroll safe) so tables read the
// same everywhere. Columns render header + cell; rows are arbitrary objects.
export interface DataTableColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}
export function DataTable<T>({
  columns, rows, rowKey, onRowClick, empty, className, testId,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const alignClass = (a?: string) => a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  return (
    <div className="w-full overflow-x-auto" data-testid={testId}>
      <table className={cn("w-full text-sm", className)}>
        <thead>
          <tr className="border-b border-border/60">
            {columns.map((c) => (
              <th key={c.key} className={cn("py-2 px-2 micro-label text-muted-foreground", alignClass(c.align))}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn("border-b border-border/40 last:border-0", onRowClick && "cursor-pointer hover:bg-muted/40")}>
              {columns.map((c) => (
                <td key={c.key} className={cn("py-2 px-2 tabular-nums", alignClass(c.align), c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
