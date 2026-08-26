/**
 * DYNAMIC OVERVIEW RENDERER (2026-08-26)
 *
 * Draws the structured OverviewSpec the server composes for an asset or
 * liability profile. The server decides WHAT belongs on the page and how it is
 * grouped; this file decides how any of that looks — cards, spacing, type,
 * color, interaction. That split is the whole point: the composition can be
 * re-reasoned for an entity nobody designed for (a boat, a patent, a solar
 * install) without a single new component, and the page still looks like the
 * rest of the app because the model never gets to draw anything.
 *
 * Values arrive already resolved from canonical storage, so this renders what
 * is true right now — there is no stale-layout-with-stale-numbers failure mode
 * to guard against here.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle, Calendar, ChevronDown, ChevronRight, FileText,
  Link2, Plus, Search, Sparkles, TrendingDown, TrendingUp, Users, Wrench,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyCompact, formatFullDate } from "@/lib/format";
import { invalidateDomains } from "@/lib/cache-bus";
import type {
  OverviewSection, OverviewSpec, OverviewValue,
} from "@shared/overview-spec";

// ── Value formatting ─────────────────────────────────────────────────────────

function formatValue(v: OverviewValue): string {
  const raw = v.value;
  if (raw == null || raw === "") return "—";
  switch (v.displayType) {
    case "money":
      return typeof raw === "number" ? formatMoneyCompact(raw) : String(raw);
    case "moneyPerMonth":
      return typeof raw === "number" ? `${formatMoneyCompact(raw)}/mo` : String(raw);
    case "percent": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? `${Math.round(n * 10) / 10}%` : String(raw);
    }
    case "number":
      return typeof raw === "number" ? raw.toLocaleString() : String(raw);
    case "date":
      return formatFullDate(String(raw)) || String(raw);
    case "list":
      return String(raw);
    default:
      return String(raw);
  }
}

/** Estimates and model-derived numbers must never read as hand-entered fact.
 *  Only provenance that CHANGES how much you should trust a number is marked —
 *  putting an "AI" chip on everything would make the chip meaningless. */
function ProvenanceMark({ value }: { value: OverviewValue }) {
  if (value.provenance === "user" || value.provenance === "document") return null;
  const label =
    value.provenance === "calculated" ? "calculated"
      : value.provenance === "linked" ? "linked"
      : value.provenance === "external" ? "estimate"
      : "AI";
  return (
    <span
      className="text-[11px] px-1.5 py-0 rounded-full bg-muted text-muted-foreground/80 shrink-0"
      title={
        value.sourceReference.inputs?.length
          ? `From ${value.sourceReference.inputs.join(", ")}`
          : value.sourceReference.entityName
            ? `Owned by ${value.sourceReference.entityName}`
            : undefined
      }
    >
      {label}
      {value.confidence != null ? ` ${Math.round(value.confidence * 100)}%` : ""}
    </span>
  );
}

function toneClass(tone?: OverviewValue["tone"]): string {
  switch (tone) {
    case "positive": return "text-emerald-500";
    case "negative": return "text-red-500";
    case "warning": return "text-amber-500";
    default: return "";
  }
}

// ── Inline field editing ─────────────────────────────────────────────────────

function useFieldWrite(profileId: string) {
  const { toast } = useToast();
  return async (fieldKey: string, value: string) => {
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { [fieldKey]: value } });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "overview"] });
      invalidateDomains("profiles");
      return true;
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
      return false;
    }
  };
}

function ValueRow({ value, profileId }: { value: OverviewValue; profileId: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.value == null ? "" : String(value.value));
  const [saving, setSaving] = useState(false);
  const write = useFieldWrite(profileId);
  const editable = value.editable;

  if (editing && editable) {
    return (
      <div className="flex items-center gap-2 py-1.5">
        <span className="text-[13px] text-muted-foreground w-28 shrink-0">{value.label}</span>
        <Input
          className="h-8 text-[14px] flex-1"
          value={draft}
          autoFocus
          onChange={e => setDraft(e.target.value)}
          onKeyDown={async e => {
            if (e.key === "Escape") setEditing(false);
            if (e.key === "Enter") {
              setSaving(true);
              const ok = await write(editable.fieldKey, draft);
              setSaving(false);
              if (ok) setEditing(false);
            }
          }}
        />
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            const ok = await write(editable.fieldKey, draft);
            setSaving(false);
            if (ok) setEditing(false);
          }}
        >
          {saving ? "…" : "Save"}
        </Button>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 py-2 border-b border-border/30 last:border-0 ${editable ? "cursor-pointer hover:bg-muted/20 px-2 -mx-2 rounded" : ""}`}
      onClick={editable ? () => { setDraft(value.value == null ? "" : String(value.value)); setEditing(true); } : undefined}
      data-testid={`overview-field-${value.semanticKey}`}
    >
      <span className="text-[13px] text-muted-foreground shrink-0">{value.label}</span>
      <div className="flex items-center gap-1.5 min-w-0">
        {value.note && <span className="text-[11px] text-muted-foreground/70 truncate">{value.note}</span>}
        <ProvenanceMark value={value} />
        <span className={`text-[14px] font-semibold text-right tabular-nums truncate max-w-[200px] ${toneClass(value.tone)}`}>
          {formatValue(value)}
        </span>
      </div>
    </div>
  );
}

// ── Section renderers ────────────────────────────────────────────────────────

function SectionShell({
  title, icon: Icon, collapsible, defaultCollapsed, testId, children,
}: {
  title?: string;
  icon?: any;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  return (
    <Card data-testid={testId}>
      {title && (
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 transition-colors"
          onClick={() => collapsible && setCollapsed(c => !c)}
          disabled={!collapsible}
        >
          <span className="flex items-center gap-2 min-w-0">
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className="text-xs font-semibold truncate">{title}</span>
          </span>
          {collapsible && (collapsed
            ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />)}
        </button>
      )}
      {!collapsed && <CardContent className={title ? "px-4 pb-3 pt-0" : "p-4"}>{children}</CardContent>}
    </Card>
  );
}

function FinancialSection({ section, profileId }: { section: OverviewSection; profileId: string }) {
  const values = section.values || [];
  return (
    <SectionShell title={section.title} testId="overview-financial">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {values.map(v => (
          <div key={v.semanticKey} data-testid={`overview-metric-${v.semanticKey}`}>
            <p className="micro-label text-muted-foreground flex items-center gap-1">
              {v.label}
              <ProvenanceMark value={v} />
            </p>
            <p className={`text-[17px] font-bold tabular-nums leading-tight ${toneClass(v.tone)}`}>
              {formatValue(v)}
              {v.tone === "positive" && v.semanticKey === "appreciation" && <TrendingUp className="inline h-3.5 w-3.5 ml-1" />}
              {v.tone === "negative" && v.semanticKey === "depreciation" && <TrendingDown className="inline h-3.5 w-3.5 ml-1" />}
            </p>
            {v.note && <p className="text-[11px] text-muted-foreground/80 mt-0.5">{v.note}</p>}
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function ProgressSection({ section }: { section: OverviewSection }) {
  const percent = Math.max(0, Math.min(100, Number(section.data?.percent) || 0));
  const label = String(section.data?.label || "");
  return (
    <SectionShell title={section.title} testId="overview-progress">
      <div className="space-y-1.5">
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{percent}% paid</span>
          {label && <span>{label}</span>}
        </div>
      </div>
    </SectionShell>
  );
}

function RelationshipSection({ section }: { section: OverviewSection }) {
  const [, navigate] = useLocation();
  return (
    <SectionShell title={section.title} icon={Link2} testId="overview-relationships">
      <div className="space-y-2">
        {(section.relationships || []).map(rel => (
          <button
            key={rel.entityId}
            type="button"
            className="w-full text-left rounded-lg border border-border/50 p-2.5 hover:bg-muted/20 transition-colors"
            onClick={() => navigate(`/profiles/${rel.entityId}`)}
            data-testid={`overview-relationship-${rel.entityId}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="micro-label text-muted-foreground">{rel.label}</p>
                <p className="text-[13px] font-semibold truncate">{rel.entityName}</p>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </div>
            {rel.facts.length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                {rel.facts.map(f => (
                  <span key={f.semanticKey} className="text-[11px] text-muted-foreground">
                    {f.label}: <span className="font-semibold text-foreground tabular-nums">{formatValue(f)}</span>
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </SectionShell>
  );
}

function OwnershipSection({ section }: { section: OverviewSection }) {
  return (
    <SectionShell title={section.title} icon={Users} testId="overview-ownership">
      <div className="space-y-1.5">
        {(section.values || []).map(v => (
          <div key={v.semanticKey} className="flex items-center justify-between">
            <span className="text-[13px]">{v.label}</span>
            <span className="text-[13px] font-semibold tabular-nums">{formatValue(v)}</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function DatesSection({ section }: { section: OverviewSection }) {
  return (
    <SectionShell title={section.title} icon={Calendar} testId="overview-dates">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(section.values || []).map(v => (
          <div key={v.semanticKey} className="rounded-lg border border-border/50 p-2.5">
            <p className="micro-label text-muted-foreground">{v.label}</p>
            <p className="text-[13px] font-semibold">{formatValue(v)}</p>
            {v.note && <p className="text-[11px] text-muted-foreground/80">{v.note}</p>}
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function DocumentsSection({ section }: { section: OverviewSection }) {
  const [, navigate] = useLocation();
  const count = Number(section.data?.count) || 0;
  const recent = (section.data?.recent || []) as Array<{ id: string; name: string }>;
  return (
    <SectionShell title={`${section.title} (${count})`} icon={FileText} collapsible defaultCollapsed testId="overview-documents">
      <div className="space-y-1">
        {recent.map(doc => (
          <button
            key={doc.id}
            type="button"
            className="w-full text-left text-[13px] py-1 hover:text-primary truncate"
            onClick={() => navigate(`/documents/${doc.id}`)}
          >
            {doc.name}
          </button>
        ))}
      </div>
    </SectionShell>
  );
}

function MaintenanceSection({ section }: { section: OverviewSection }) {
  const d = section.data || {};
  return (
    <SectionShell title={section.title} icon={Wrench} testId="overview-maintenance">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-[13px] font-semibold">{d.lastServiceDate ? formatFullDate(String(d.lastServiceDate)) : "—"}</p>
          <p className="micro-label text-muted-foreground">Last service</p>
        </div>
        <div>
          <p className="text-[13px] font-semibold">{d.nextServiceDate ? formatFullDate(String(d.nextServiceDate)) : "—"}</p>
          <p className="micro-label text-muted-foreground">Next service</p>
        </div>
        <div>
          <p className="text-[13px] font-semibold">{Number(d.openItems) || 0}</p>
          <p className="micro-label text-muted-foreground">Open items</p>
        </div>
      </div>
    </SectionShell>
  );
}

function TimelineSection({ section }: { section: OverviewSection }) {
  const events = (section.data?.events || []) as Array<{ title: string; timestamp: string }>;
  return (
    <SectionShell title={section.title} collapsible defaultCollapsed testId="overview-timeline">
      <div className="space-y-1.5">
        {events.map((e, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <span className="text-[13px] truncate">{e.title}</span>
            <span className="text-[11px] text-muted-foreground shrink-0">{formatFullDate(e.timestamp)}</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function MissingInfoSection({ section, profileId }: { section: OverviewSection; profileId: string }) {
  const items = (section.data?.items || []) as Array<{ semanticKey: string; label: string; reason: string; fieldKey: string }>;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const write = useFieldWrite(profileId);
  if (items.length === 0) return null;
  return (
    <SectionShell title={section.title} icon={Plus} testId="overview-missing">
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.semanticKey}>
            {openKey === item.semanticKey ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted-foreground w-28 shrink-0">{item.label}</span>
                <Input
                  className="h-8 text-[14px] flex-1"
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={async e => {
                    if (e.key === "Escape") setOpenKey(null);
                    if (e.key === "Enter" && draft.trim()) {
                      setSaving(true);
                      const ok = await write(item.fieldKey, draft.trim());
                      setSaving(false);
                      if (ok) { setOpenKey(null); setDraft(""); }
                    }
                  }}
                />
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={saving || !draft.trim()}
                  onClick={async () => {
                    setSaving(true);
                    const ok = await write(item.fieldKey, draft.trim());
                    setSaving(false);
                    if (ok) { setOpenKey(null); setDraft(""); }
                  }}
                >
                  {saving ? "…" : "Save"}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className="w-full text-left flex items-center justify-between gap-2 rounded-lg border border-dashed border-border/60 px-2.5 py-2 hover:bg-muted/20 transition-colors"
                onClick={() => { setOpenKey(item.semanticKey); setDraft(""); }}
                data-testid={`overview-missing-${item.semanticKey}`}
              >
                <span className="min-w-0">
                  <span className="text-[13px] font-medium">{item.label}</span>
                  <span className="block text-[11px] text-muted-foreground truncate">{item.reason}</span>
                </span>
                <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </button>
            )}
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function InsightsSection({ section }: { section: OverviewSection }) {
  const insights = (section.data?.insights || []) as Array<{ id: string; title: string; detail: string; confidence?: number }>;
  if (insights.length === 0) return null;
  return (
    <SectionShell title={section.title} icon={Sparkles} testId="overview-insights">
      <div className="space-y-2">
        {insights.map(i => (
          <div key={i.id}>
            <p className="text-[13px] font-semibold">{i.title}</p>
            <p className="text-[12px] text-muted-foreground leading-relaxed">{i.detail}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function GroupedSection({ section, profileId }: { section: OverviewSection; profileId: string }) {
  return (
    <SectionShell
      title={section.title}
      collapsible
      defaultCollapsed={!!section.collapsed}
      testId={`overview-group-${section.id}`}
    >
      {(section.values || []).map(v => (
        <ValueRow key={v.semanticKey} value={v} profileId={profileId} />
      ))}
    </SectionShell>
  );
}

function renderSection(section: OverviewSection, profileId: string) {
  switch (section.component) {
    case "financialSummary": return <FinancialSection key={section.id} section={section} profileId={profileId} />;
    case "progressIndicator": return <ProgressSection key={section.id} section={section} />;
    case "relationshipSummary": return <RelationshipSection key={section.id} section={section} />;
    case "ownershipSummary": return <OwnershipSection key={section.id} section={section} />;
    case "dateCard": return <DatesSection key={section.id} section={section} />;
    case "documentSummary": return <DocumentsSection key={section.id} section={section} />;
    case "maintenanceSummary": return <MaintenanceSection key={section.id} section={section} />;
    case "miniTimeline": return <TimelineSection key={section.id} section={section} />;
    case "missingInfo": return <MissingInfoSection key={section.id} section={section} profileId={profileId} />;
    case "aiInsight": return <InsightsSection key={section.id} section={section} />;
    default: return <GroupedSection key={section.id} section={section} profileId={profileId} />;
  }
}

// ── Header pieces ────────────────────────────────────────────────────────────

/**
 * "Find value" — the market-lookup affordance that used to hang off the
 * Current Value row on the static Info tab. It survives the rebuild because it
 * is an ACTION, not a layout decision: the composition says this entity leads
 * with a value it doesn't have (or has an old one), and this offers to go get
 * one. The estimate is never written silently — the user accepts it.
 */
function FindValueButton({ profileId, fieldKey }: { profileId: string; fieldKey: string }) {
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ estimatedValue: number; confidence: string; explanation: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const write = useFieldWrite(profileId);

  const run = async () => {
    setFinding(true);
    try {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/find-value`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFound(data);
    } catch (err: any) {
      toast({ title: err?.message || "Could not find value", variant: "destructive" });
    } finally {
      setFinding(false);
    }
  };

  if (found) {
    return (
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-2.5 space-y-1.5" data-testid="overview-find-value-result">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-primary">
            Estimate {formatMoneyCompact(found.estimatedValue)}
          </span>
          <span className="text-[11px] text-muted-foreground capitalize">{found.confidence} confidence</span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">{found.explanation}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const ok = await write(fieldKey, String(Math.round(found.estimatedValue)));
              setSaving(false);
              if (ok) setFound(null);
            }}
          >
            {saving ? "…" : "Use this"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setFound(null)}>Dismiss</Button>
        </div>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs gap-1"
      onClick={run}
      disabled={finding}
      data-testid="overview-find-value"
    >
      <Search className="h-3 w-3" />
      {finding ? "Finding…" : "Find value"}
    </Button>
  );
}

function IdentityHeader({ spec }: { spec: OverviewSpec }) {
  const { identity, summaryMetrics } = spec;
  // Offer a market lookup where one is meaningful: an owned thing whose
  // headline IS its value, or one that is missing that value entirely.
  const headlineValueKey = identity.headline?.editable && /value$/i.test(identity.headline.semanticKey)
    ? identity.headline.editable.fieldKey : null;
  const missingValueKey = spec.missingInformation.find(m => m.semanticKey === "currentValue")?.fieldKey || null;
  const valueLookupKey = identity.entityClass === "asset" ? (headlineValueKey || missingValueKey) : null;
  const toneCls = identity.status?.tone === "positive" ? "bg-emerald-500/15 text-emerald-400"
    : identity.status?.tone === "critical" ? "bg-red-500/15 text-red-400"
    : identity.status?.tone === "warning" ? "bg-amber-500/15 text-amber-400"
    : "bg-muted text-muted-foreground";
  return (
    <div className="space-y-3" data-testid="overview-identity">
      <div className="flex items-start justify-between gap-3 pb-2 border-b border-border/30">
        <div className="min-w-0">
          {identity.subtitle && (
            <p className="text-[13px] text-muted-foreground truncate">{identity.subtitle}</p>
          )}
          {identity.status && (
            <Badge variant="secondary" className={`mt-1 text-xs capitalize ${toneCls}`} data-testid="overview-status">
              {identity.status.label}
            </Badge>
          )}
        </div>
        {identity.headline && (
          <div className="text-right shrink-0" data-testid="overview-headline">
            <p className="micro-label text-muted-foreground">{identity.headline.label}</p>
            <p className="metric-value text-[20px] leading-tight">{formatValue(identity.headline)}</p>
          </div>
        )}
      </div>
      {valueLookupKey && (
        <FindValueButton profileId={identity.profileId} fieldKey={valueLookupKey} />
      )}
      {summaryMetrics.length > 0 && (
        <div className={`grid gap-2 ${summaryMetrics.length >= 3 ? "grid-cols-3" : "grid-cols-2"}`} data-testid="overview-summary-metrics">
          {summaryMetrics.map(m => (
            <Card key={m.semanticKey} className="p-2.5" data-testid={`overview-summary-${m.semanticKey}`}>
              <p className="micro-label text-muted-foreground flex items-center gap-1 truncate">
                {m.label}
                <ProvenanceMark value={m} />
              </p>
              <p className={`text-[16px] font-bold tabular-nums leading-tight ${toneClass(m.tone)}`}>{formatValue(m)}</p>
              {m.note && <p className="text-[11px] text-muted-foreground/80 truncate">{m.note}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AttentionStrip({ spec }: { spec: OverviewSpec }) {
  if (spec.attentionItems.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="overview-attention">
      {spec.attentionItems.map(item => {
        const cls = item.severity === "critical" ? "border-red-500/40 bg-red-500/10 text-red-400"
          : item.severity === "warning" ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
          : "border-border/60 bg-muted/20 text-muted-foreground";
        return (
          <div key={item.id} className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${cls}`}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[13px] font-medium min-w-0 truncate">{item.title}</span>
            {item.detail && <span className="text-[11px] opacity-80 shrink-0">{item.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function DynamicOverview({
  profileId,
  fallback,
  children,
}: {
  profileId: string;
  /** Rendered when the composition is unavailable (offline, 500, or a profile
   *  class this engine doesn't drive). The page must never go blank because a
   *  layout couldn't be composed. */
  fallback?: React.ReactNode;
  /** Editing affordances the composition doesn't own (location picker,
   *  belongs-to). Rendered only when a composition actually loaded, so a
   *  fallback render never shows them twice. */
  children?: React.ReactNode;
}) {
  const { data: spec, isLoading, isError } = useQuery<OverviewSpec>({
    queryKey: ["/api/profiles", profileId, "overview"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/overview`);
      return res.json();
    },
    staleTime: 0,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="overview-loading">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (isError || !spec?.identity) return <>{fallback ?? null}</>;

  return (
    <div className="space-y-3" data-testid="dynamic-overview">
      <IdentityHeader spec={spec} />
      <AttentionStrip spec={spec} />
      {spec.sections.map(section => renderSection(section, profileId))}
      {children}
    </div>
  );
}

export default DynamicOverview;
