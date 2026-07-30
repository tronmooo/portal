// ── The Executive tab's attention feed ───────────────────────────────────────
// One ranked list, grouped by how soon it matters, replacing the 17-section
// masonry that used to fill this tab. Everything it renders comes from
// shared/attention.ts — this file decides only how an item LOOKS and which
// mutation its button fires; what qualifies as attention lives in the model.
//
// Every card answers the four questions the old board never did: what needs
// attention, why, how soon, and what to do about it — with the whole card
// linking to the record it came from.

import { useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, ChevronRight, Check, CreditCard, ArrowRight, X, Clock } from "lucide-react";
import type { AttentionItem, AttentionTier } from "@shared/attention";

const TIER_META: Record<AttentionTier, { label: string; accent: string; blurb: string }> = {
  immediate: { label: "Immediate", accent: "0 72% 58%",  blurb: "overdue or due today" },
  soon:      { label: "Soon",      accent: "25 95% 58%", blurb: "within 7 days" },
  upcoming:  { label: "Upcoming",  accent: "48 96% 53%", blurb: "worth knowing about" },
};

const TIER_ORDER: AttentionTier[] = ["immediate", "soon", "upcoming"];

const ACTION_ICON = {
  complete: Check,
  pay: CreditCard,
  checkin: Check,
  dismiss: X,
  snooze: Clock,
  open: ArrowRight,
} as const;

export interface AttentionFeedProps {
  items: AttentionItem[];
  counts: Record<AttentionTier, number>;
  /** Real items held back by the threshold — surfaced as "show N more". */
  suppressed: number;
  loading?: boolean;
  /** Fires the item's primary action. Resolves when the mutation settles. */
  onAction: (item: AttentionItem) => void;
  /** Items mid-flight, so their button can show as busy and can't double-fire. */
  busyKeys?: Set<string>;
  /** Bills arm on the first tap and commit on the second — money is one-way. */
  armedKey?: string | null;
  onShowSuppressed?: () => void;
  showingSuppressed?: boolean;
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
      data-testid={`attention-action-${item.key}`}
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

function Card({ item, depth = 0, busyKeys, armedKey, onAction }: {
  item: AttentionItem; depth?: number;
  busyKeys?: Set<string>; armedKey?: string | null;
  onAction: (i: AttentionItem) => void;
}) {
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState(false);
  const hasChildren = !!item.children?.length && (item.count ?? 0) > 1;
  const accent = TIER_META[item.tier].accent;

  return (
    <div data-testid={`attention-item-${item.key}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => (hasChildren ? setExpanded((x) => !x) : navigate(item.href))}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          hasChildren ? setExpanded((x) => !x) : navigate(item.href);
        }}
        className={`w-full flex items-center gap-2 rounded-md border border-border/40 border-l-2 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-muted/40 cursor-pointer ${depth ? "ml-4" : ""}`}
        style={{ borderLeftColor: `hsl(${accent})` }}
      >
        {hasChildren && (
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{item.title}</p>
          <p className="text-[11px] truncate" style={{ color: `hsl(${accent})` }}>{item.reason}</p>
        </div>
        <ActionButton
          item={item}
          busy={!!busyKeys?.has(item.key)}
          armed={armedKey === item.key}
          onAction={onAction}
        />
      </div>
      {hasChildren && expanded && (
        <div className="mt-1 space-y-1">
          {item.children!.map((c) => (
            <Card key={c.key} item={c} depth={depth + 1} busyKeys={busyKeys} armedKey={armedKey} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

function TierGroup({ tier, items, busyKeys, armedKey, onAction }: {
  tier: AttentionTier; items: AttentionItem[];
  busyKeys?: Set<string>; armedKey?: string | null;
  onAction: (i: AttentionItem) => void;
}) {
  // What can't wait and what's due this week are both open on arrival — the
  // point of the tab is to be readable in one glance, and the model's threshold
  // already guarantees the list is short. Only "Upcoming" (things that are
  // merely worth knowing about) starts folded.
  const [open, setOpen] = useState(tier !== "upcoming");
  const meta = TIER_META[tier];
  return (
    <div
      className="rounded-lg border bg-card/40 px-2 pt-0.5 pb-1.5 mb-2"
      style={{ borderColor: `hsl(${meta.accent} / 0.25)` }}
      data-testid={`attention-group-${tier}`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 py-1.5 text-left group"
        aria-expanded={open}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: `hsl(${meta.accent})`, boxShadow: `0 0 5px hsl(${meta.accent} / 0.7)` }}
        />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
          {meta.label}
        </span>
        <span className="text-[10px] px-1.5 rounded-full" style={{ background: `hsl(${meta.accent} / 0.15)`, color: `hsl(${meta.accent})` }}>
          {items.length}
        </span>
        <span className="ml-auto mr-1 text-[10px] text-muted-foreground hidden sm:inline">{meta.blurb}</span>
        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="space-y-1 pb-0.5">
          {items.map((i) => (
            <Card key={i.key} item={i} busyKeys={busyKeys} armedKey={armedKey} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AttentionFeed({
  items, counts, suppressed, loading,
  onAction, busyKeys, armedKey,
  onShowSuppressed, showingSuppressed,
}: AttentionFeedProps) {
  if (loading) {
    return (
      <div className="space-y-2" data-testid="attention-feed" aria-label="Loading what needs attention">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 rounded-md border border-border/40 bg-card/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-4 py-8 text-center"
        data-testid="attention-feed"
      >
        <p className="text-sm font-medium text-emerald-500">Nothing needs your attention.</p>
        <p className="text-[11px] text-muted-foreground mt-1">
          No overdue work, no bills due, nothing expiring soon.
        </p>
        {suppressed > 0 && onShowSuppressed && (
          <button
            onClick={onShowSuppressed}
            className="mt-3 text-[11px] font-medium text-muted-foreground hover:text-foreground underline"
            data-testid="attention-show-suppressed"
          >
            {showingSuppressed ? "Hide lower-priority items" : `Show ${suppressed} lower-priority item${suppressed === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div data-testid="attention-feed">
      {TIER_ORDER.filter((t) => counts[t] > 0).map((tier) => (
        <TierGroup
          key={tier}
          tier={tier}
          items={items.filter((i) => i.tier === tier)}
          busyKeys={busyKeys}
          armedKey={armedKey}
          onAction={onAction}
        />
      ))}
      {suppressed > 0 && onShowSuppressed && (
        <button
          onClick={onShowSuppressed}
          className="w-full text-[11px] text-muted-foreground hover:text-foreground py-1.5 rounded-md hover:bg-muted/40 transition-colors"
          data-testid="attention-show-suppressed"
        >
          {showingSuppressed
            ? "Hide lower-priority items"
            : `Show ${suppressed} lower-priority item${suppressed === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

export default AttentionFeed;
