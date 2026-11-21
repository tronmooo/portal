// ── Details: every characteristic, every record, every flag ─────────────────
// The reporting side of the detail layer (shared/record-details):
//   · Report — pick a characteristic, see every record that has (or should
//     have) it, how the values are distributed, and filter ("Condition is at or
//     worse than Fair", "Renewal date is within 30 days", "VIN is missing").
//   · Characteristics — the catalog: type, options, where it applies, rules.
//   · Flags — everything the rules raise right now, derived from the values.
//
// The report filter is a filter (Rule 4): it is never persisted, the screen
// says how many rows it hides, and an empty result says it was the filter.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Flag, Pencil, Plus, SlidersHorizontal, Table2, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionHeading } from "@/components/ui/section-heading";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { DetailInput } from "@/components/details/DetailInput";
import { DetailFlagChip } from "@/components/details/RecordDetailsPanel";
import { DefinitionEditor } from "@/components/details/DefinitionEditor";
import {
  deleteDefinition, detailErrorMessage, useDetailDefinitions, useDetailFlags, useDetailReport,
} from "@/lib/record-details";
import {
  DETAIL_KIND_LABELS, DETAIL_OP_LABELS, describeCondition, opNeedsOperand, opsForKind, scopeLabel,
  type DetailDefinition, type DetailOp, type DetailValue,
} from "@shared/record-details";

const ACCENT = "262 70% 60%";

export default function DetailsPage() {
  const defs = useDetailDefinitions();
  const flags = useDetailFlags();
  const [tab, setTab] = useState("report");
  const [editing, setEditing] = useState<DetailDefinition | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const definitions = defs.data?.definitions ?? [];

  const openEditor = (d: DetailDefinition | null) => { setEditing(d); setEditorOpen(true); };

  return (
    <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full pb-24" data-testid="page-details">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold tracking-tight">Details</h1>
          <p className="text-xs text-muted-foreground">
            Characteristics you track on any record — search them, report on them, and get flagged when a rule trips.
          </p>
        </div>
        <Button size="sm" className="h-8 gap-1 text-xs" onClick={() => openEditor(null)} data-testid="details-new">
          <Plus className="h-3.5 w-3.5" /> New characteristic
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="report" data-testid="details-tab-report">Report</TabsTrigger>
          <TabsTrigger value="catalog" data-testid="details-tab-catalog">Characteristics</TabsTrigger>
          <TabsTrigger value="flags" data-testid="details-tab-flags">
            Flags{flags.data && flags.data.flags.length > 0 ? ` (${flags.data.flags.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="report" className="mt-4">
          {defs.isLoading ? <Skeleton className="h-40 w-full" />
            : defs.isError ? <LoadError what="characteristics" onRetry={() => defs.refetch()} />
            : definitions.length === 0 ? <NoDefinitions onCreate={() => openEditor(null)} />
            : <ReportView definitions={definitions} />}
        </TabsContent>

        <TabsContent value="catalog" className="mt-4">
          {defs.isLoading ? <Skeleton className="h-40 w-full" />
            : defs.isError ? <LoadError what="characteristics" onRetry={() => defs.refetch()} />
            : definitions.length === 0 ? <NoDefinitions onCreate={() => openEditor(null)} />
            : <CatalogView definitions={definitions} usage={defs.data?.usage ?? {}} onEdit={openEditor} />}
        </TabsContent>

        <TabsContent value="flags" className="mt-4">
          {flags.isLoading ? <Skeleton className="h-24 w-full" />
            : flags.isError ? <LoadError what="flags" onRetry={() => flags.refetch()} />
            : <FlagsView flags={flags.data?.flags ?? []} />}
        </TabsContent>
      </Tabs>

      <DefinitionEditor open={editorOpen} onOpenChange={setEditorOpen} definition={editing} />
    </div>
  );
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-destructive">
        Couldn't load {what} — nothing was lost.
        <button type="button" className="underline ml-1" onClick={onRetry}>Try again</button>
      </p>
    </Card>
  );
}

function NoDefinitions({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="p-6 text-center space-y-2" data-testid="details-none">
      <SlidersHorizontal className="h-6 w-6 mx-auto text-muted-foreground" />
      <p className="text-sm font-medium">No characteristics yet</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        Open any record — a car, a house, a person, a loan, a contract — and tap “Add detail”, or create one here.
      </p>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onCreate}>New characteristic</Button>
    </Card>
  );
}

function ReportView({ definitions }: { definitions: DetailDefinition[] }) {
  const [defId, setDefId] = useState(definitions[0]?.id || "");
  const def = definitions.find((d) => d.id === defId) || definitions[0];
  const [op, setOp] = useState<DetailOp | "">("");
  const [operand, setOperand] = useState<DetailValue | string | null>(null);

  const operandParam = operand === null ? "" : Array.isArray(operand) ? operand.join(",") : String(operand);
  const ready = !op || !opNeedsOperand(op) || operandParam !== "";
  const report = useDetailReport(def?.id, ready ? op : "", ready ? operandParam : "");
  // While an operand is being typed, keep showing the unfiltered report.
  const filterActive = !!op && ready;

  const clearFilter = () => { setOp(""); setOperand(null); };
  const selectDef = (id: string) => { setDefId(id); clearFilter(); };

  if (!def) return null;
  const data = report.data;

  return (
    <div className="space-y-3">
      <Card className="p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="space-y-1">
            <span className="micro-label text-muted-foreground">Characteristic</span>
            <Select value={def.id} onValueChange={selectDef}>
              <SelectTrigger className="h-8 text-xs" aria-label="Characteristic" data-testid="report-definition"><SelectValue /></SelectTrigger>
              <SelectContent>
                {definitions.map((d) => <SelectItem key={d.id} value={d.id} className="text-xs">{d.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="micro-label text-muted-foreground">Filter</span>
            <Select value={op || "any"} onValueChange={(v) => { setOp(v === "any" ? "" : (v as DetailOp)); setOperand(null); }}>
              <SelectTrigger className="h-8 text-xs" aria-label="Filter" data-testid="report-op"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any" className="text-xs">Any value</SelectItem>
                {opsForKind(def.kind).map((o) => <SelectItem key={o} value={o} className="text-xs">{DETAIL_OP_LABELS[o]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {op && opNeedsOperand(op) && (
            <div className="space-y-1">
              <span className="micro-label text-muted-foreground">Value</span>
              {op === "within_days" || (op === "contains" && def.kind !== "multiselect") ? (
                <Input
                  className="h-8 text-xs" inputMode={op === "within_days" ? "numeric" : undefined}
                  placeholder={op === "within_days" ? "Days" : "Text"}
                  value={typeof operand === "string" ? operand : ""}
                  onChange={(e) => setOperand(e.target.value)}
                  data-testid="report-operand"
                />
              ) : (
                <DetailInput
                  key={`${def.id}-${op}`}
                  definition={op === "any_of" ? { ...def, kind: "multiselect" } : def.kind === "multiselect" ? { ...def, kind: "select" } : def}
                  value={(operand ?? null) as DetailValue | null}
                  onChange={(v) => setOperand(v)}
                  onCommit={(v) => setOperand(v)}
                  testId="report-operand"
                />
              )}
            </div>
          )}
        </div>

        {data && data.distribution.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="report-distribution">
            {data.distribution.map((d) => {
              const pickable = d.value !== "—" && ["condition", "select", "boolean", "rating"].includes(def.kind);
              return (
                <button
                  key={d.value} type="button" disabled={!pickable}
                  onClick={() => {
                    if (d.value === "—") return;
                    setOp("is");
                    setOperand(def.kind === "boolean" ? d.value === "Yes" : def.kind === "rating" ? Number(d.value.split(" ")[0]) : d.value);
                  }}
                  className="h-6 rounded-full border border-border px-2 text-[11px] tabular-nums enabled:hover:bg-muted disabled:cursor-default"
                  data-testid={`report-dist-${d.value}`}
                >
                  {d.value === "—" ? "Not set" : d.value} · {d.count}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {filterActive && data?.filter && (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs" role="status" data-testid="report-filter-notice">
          <span className="flex-1">
            Showing {data.rows.length} of {data.total} — {def.label} {data.filter.label}
            {data.filter.value !== undefined ? ` ${Array.isArray(data.filter.value) ? data.filter.value.join(" or ") : String(data.filter.value)}` : ""}
          </span>
          <button type="button" onClick={clearFilter} className="inline-flex items-center gap-0.5 underline" data-testid="report-filter-clear">
            <X className="h-3 w-3" /> Show all
          </button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {report.isLoading ? (
          <div className="p-4"><Skeleton className="h-24 w-full" /></div>
        ) : report.isError ? (
          <p className="p-4 text-xs text-destructive">
            {detailErrorMessage(report.error)}
            <button type="button" className="underline ml-1" onClick={() => report.refetch()}>Try again</button>
          </p>
        ) : !data || data.rows.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground" data-testid="report-empty">
            {filterActive && data && data.total > 0
              ? <>No record matches this filter — {data.total} record{data.total === 1 ? "" : "s"} hidden. <button type="button" className="underline" onClick={clearFilter}>Show all</button></>
              : <>No record has {def.label} yet. Open a record and tap “Add detail”.</>}
          </p>
        ) : (
          <div className="divide-y divide-border/50" data-testid="report-rows">
            {data.rows.map((r) => (
              <Link key={`${r.entityType}:${r.entityId}`} href={r.href} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40" data-testid={`report-row-${r.entityId}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{r.name}</p>
                  <p className="text-[11px] text-muted-foreground capitalize">{scopeLabel(r.scope).replace(/s$/, "")}</p>
                  {r.flags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">{r.flags.map((f) => <DetailFlagChip key={f.ruleId} flag={f} />)}</div>
                  )}
                </div>
                <span className={`text-sm tabular-nums ${r.value === null ? "text-muted-foreground" : "font-semibold"}`}>
                  {r.value === null ? "Not set" : r.display}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function CatalogView({ definitions, usage, onEdit }: {
  definitions: DetailDefinition[];
  usage: Record<string, number>;
  onEdit: (d: DetailDefinition) => void;
}) {
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const sorted = useMemo(() => [...definitions].sort((a, b) => a.label.localeCompare(b.label)), [definitions]);

  const remove = async (d: DetailDefinition) => {
    try {
      const r = await deleteDefinition(d.id);
      toast({ title: `Deleted ${d.label}`, description: r.removedValues ? `Removed from ${r.removedValues} record${r.removedValues === 1 ? "" : "s"}` : undefined });
    } catch (err) {
      toast({ title: `Couldn't delete ${d.label}`, description: detailErrorMessage(err), variant: "destructive" });
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2" data-testid="details-catalog">
      {sorted.map((d) => {
        const used = usage[d.id] || 0;
        const armKey = `del-${d.id}`;
        return (
          <Card key={d.id} className="p-3 space-y-1.5" data-testid={`catalog-${d.id}`}>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold flex-1 truncate">{d.label}</p>
              <Badge variant="outline" className="text-[11px]">{DETAIL_KIND_LABELS[d.kind]}</Badge>
              <button type="button" onClick={() => onEdit(d)} className="p-1 text-muted-foreground hover:text-foreground" aria-label={`Edit ${d.label}`} data-testid={`catalog-edit-${d.id}`}>
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => confirm(armKey, () => { void remove(d); })}
                className={`rounded px-1.5 text-[11px] ${isArmed(armKey) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-destructive"}`}
                data-testid={`catalog-delete-${d.id}`}
              >
                {isArmed(armKey) ? (used ? `Delete from ${used} record${used === 1 ? "" : "s"}?` : "Delete?") : "Delete"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {d.appliesTo.map(scopeLabel).join(", ")} · used on {used} record{used === 1 ? "" : "s"}
              {d.required ? " · required" : ""}
            </p>
            {d.options && d.options.length > 0 && (
              <p className="text-[11px] text-muted-foreground truncate">{d.kind === "condition" ? "Scale" : "Options"}: {d.options.join(" · ")}</p>
            )}
            {(d.rules || []).length > 0 && (
              <ul className="text-[11px] text-muted-foreground space-y-0.5">
                {(d.rules || []).map((r) => (
                  <li key={r.id} className="flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    <span><span className="capitalize">{r.severity}</span>: {r.message || describeCondition(d, r.op, r.value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function FlagsView({ flags }: { flags: Array<{ entityType: string; entityId: string; name: string; href: string; flag: any }> }) {
  if (flags.length === 0) {
    return (
      <Card className="p-6 text-center" data-testid="flags-none">
        <Flag className="h-5 w-5 mx-auto text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground">Nothing flagged. Add rules to a characteristic to be told when a value needs attention.</p>
      </Card>
    );
  }
  return (
    <Card className="p-4" data-testid="flags-list">
      <SectionHeading title="Needs attention" icon={Table2} accent={ACCENT} count={flags.length} />
      <div className="divide-y divide-border/50 mt-2">
        {flags.map((f, i) => (
          <Link key={`${f.entityId}-${f.flag.definitionId}-${f.flag.ruleId}-${i}`} href={f.href} className="flex items-center gap-2 py-2 hover:bg-muted/30">
            <span className="text-sm font-medium flex-1 truncate">{f.name}</span>
            <DetailFlagChip flag={f.flag} />
          </Link>
        ))}
      </div>
    </Card>
  );
}
