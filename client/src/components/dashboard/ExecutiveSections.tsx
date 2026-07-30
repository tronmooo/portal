// ── The Executive tab's ten sections ─────────────────────────────────────────
// Presentation only. Which section a record belongs to — and the guarantee that
// it belongs to exactly one — lives in shared/executive-sections.ts.
//
// Each section is collapsible, hides itself when empty, and caps its list with
// an honest "+N more". Rows are the same card the attention feed used: title,
// why it's here, one action, and the whole card links to the source record.

import { useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, ChevronRight, Check, CreditCard, ArrowRight, X, Clock } from "lucide-react";
import type { AttentionItem } from "@shared/attention";
import type { ExecSection } from "@shared/executive-sections";

const ACTION_ICON = {
  complete: Check,
  pay: CreditCard,
  checkin: Check,
  dismiss: X,
  snooze: Clock,
  open: ArrowRight,
} as const;

const TIER_DOT: Record<string, string> = {
  immediate: "0 72% 58%",
  soon: "25 95% 58%",
  upcoming: "48 96% 53%",
};

export interface ExecutiveSectionsProps {
  sections: ExecSection[];
  loading?: boolean;
  onAction: (item: AttentionItem) => void;
  busyKeys?: Set<string>;
  /** Money-moving rows arm on the first tap and commit on the second. */
  armedKey?: string | null;
}

function ActionButton({ item, busy, armed, onAction }: {
  item: AttentionItem; busy: boolean; armed: boolean; onAction: (i: AttentionItem) => void;
}) {
  if (!item.action) return null;
  const Icon = ACTION_ICON[item.action.kind] || ArrowRight;
  const label = armed ? "Confirm" : item.action.label;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onAction(item); }}
      disabled={busy}
      data-testid={`exec-action-${item.key}`}
      aria-label={`${label} — ${item.title}`}
      className={`shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
        armed
          ? "border-red-500/50 bg-red-500/10 text-red-500"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="h-3 w-3" />
      {busy ? "…" : label}
    </button>
  );
}

function Row({ item, accent, depth = 0, busyKeys, armedKey, onAction }: {
  item: AttentionItem; accent: string; depth?: number;
  busyKeys?: Set<string>; armedKey?: string | null;
  onAction: (i: AttentionItem) => void;
}) {
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState(false);
  const hasChildren = !!item.children?.length && (item.count ?? 0) > 1;
  const dot = TIER_DOT[item.tier] || accent;
  const open = () => (hasChildren ? setExpanded((x) => !x) : navigate(item.href));

  return (
    <div data-testid={`exec-item-${item.key}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        className={`w-full flex items-center gap-2 rounded-md border border-border/40 border-l-2 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-muted/40 cursor-pointer ${depth ? "ml-4" : ""}`}
        style={{ borderLeftColor: `hsl(${dot})` }}
      >
        {hasChildren && (
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{item.title}</p>
          <p className="text-[11px] truncate" style={{ color: `hsl(${dot})` }}>{item.reason}</p>
        </div>
        <ActionButton item={item} busy={!!busyKeys?.has(item.key)} armed={armedKey === item.key} onAction={onAction} />
      </div>
      {hasChildren && expanded && (
        <div className="mt-1 space-y-1">
          {item.children!.map((c) => (
            <Row key={c.key} item={c} accent={accent} depth={depth + 1} busyKeys={busyKeys} armedKey={armedKey} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ section, busyKeys, armedKey, onAction }: {
  section: ExecSection;
  busyKeys?: Set<string>; armedKey?: string | null;
  onAction: (i: AttentionItem) => void;
}) {
  // Everything above the fold on arrival except the two reference sections —
  // recent activity and insights are context, not a call to action.
  const [open, setOpen] = useState(section.id !== "activity" && section.id !== "insights");
  const [showAll, setShowAll] = useState(false);
  const hidden = section.total - section.items.length;

  return (
    <div
      className="mb-2 rounded-lg border bg-card/40 px-2 pt-0.5 pb-1.5"
      style={{ borderColor: `hsl(${section.accent} / 0.25)` }}
      data-testid={`exec-section-${section.id}`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 py-1.5 text-left group"
        aria-expanded={open}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: `hsl(${section.accent})`, boxShadow: `0 0 5px hsl(${section.accent} / 0.7)` }}
        />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
          {section.title}
        </span>
        <span className="text-[10px] px-1.5 rounded-full" style={{ background: `hsl(${section.accent} / 0.15)`, color: `hsl(${section.accent})` }}>
          {section.total}
        </span>
        {section.subtitle && (
          <span className="ml-auto mr-1 text-[10px] text-muted-foreground truncate max-w-[55%]">{section.subtitle}</span>
        )}
        <ChevronDown className={`h-3 w-3 ${section.subtitle ? "" : "ml-auto"} text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="space-y-1 pb-0.5">
          {section.items.map((i) => (
            <Row key={i.key} item={i} accent={section.accent} busyKeys={busyKeys} armedKey={armedKey} onAction={onAction} />
          ))}
          {hidden > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full text-[11px] text-muted-foreground hover:text-foreground py-1 rounded-md hover:bg-muted/40 transition-colors"
              data-testid={`exec-more-${section.id}`}
            >
              +{hidden} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ExecutiveSections({ sections, loading, onAction, busyKeys, armedKey }: ExecutiveSectionsProps) {
  if (loading) {
    return (
      <div className="space-y-2" data-testid="exec-sections" aria-label="Loading what needs attention">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 rounded-lg border border-border/40 bg-card/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <div
        className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-4 py-8 text-center"
        data-testid="exec-sections"
      >
        <p className="text-sm font-medium text-emerald-500">Nothing needs your attention.</p>
        <p className="text-[11px] text-muted-foreground mt-1">
          No overdue work, nothing scheduled, nothing expiring soon.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="exec-sections">
      {sections.map((s) => (
        <Section key={s.id} section={s} busyKeys={busyKeys} armedKey={armedKey} onAction={onAction} />
      ))}
    </div>
  );
}

export default ExecutiveSections;
