// ── Details panel: structured characteristics on any record ────────────────
// Drop it on any record page — a car, a house, a person, a loan, a contract,
// a task — with the record's entity type and id. It shows the record's
// characteristics as structured values (a condition scale, stars, yes/no, a
// dropdown, money, a date…), saves each one as it is set, raises the flags its
// rules derive from the values, and offers "Add detail" to define a new
// characteristic on the spot or reuse one already tracked elsewhere.
//
// Rules this honours: a load failure is an error with a retry, never an empty
// panel (Rule 7); opening it writes nothing (Rule 3); removing a value takes
// two taps (Rule 8); flags are derived from the current values (Rule 5).
import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Info, Loader2, Plus, SlidersHorizontal, Sparkles, X, OctagonAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeading } from "@/components/ui/section-heading";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { queryClient } from "@/lib/queryClient";
import {
  clearDetailValue, detailErrorMessage, detailsKey, setDetailValue, useDetailDefinitions, useRecordDetails,
} from "@/lib/record-details";
import type { DetailRowShape, RecordDetailsPayloadShape } from "@/lib/record-details-types";
import { DetailInput } from "./DetailInput";
import { AddDetailDialog, type AddDetailPreset } from "./AddDetailDialog";
import { formatDetailValue, type DetailEntityType, type DetailFlag, type DetailSeverity, type DetailValue } from "@shared/record-details";

const ACCENT = "262 70% 60%";

const SEVERITY_STYLE: Record<DetailSeverity, { cls: string; Icon: typeof Info }> = {
  critical: { cls: "border-destructive/40 bg-destructive/10 text-destructive", Icon: OctagonAlert },
  warning: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", Icon: AlertTriangle },
  info: { cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400", Icon: Info },
};

export function DetailFlagChip({ flag }: { flag: DetailFlag }) {
  const { cls, Icon } = SEVERITY_STYLE[flag.severity];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`} data-testid={`detail-flag-${flag.definitionId}-${flag.ruleId}`}>
      <Icon className="h-3 w-3 shrink-0" />
      {flag.message}
    </span>
  );
}

function isPayload(v: unknown): v is RecordDetailsPayloadShape {
  const p = v as RecordDetailsPayloadShape | null | undefined;
  return !!p && Array.isArray(p.rows) && Array.isArray(p.available) && Array.isArray(p.suggestions)
    && Array.isArray(p.flags) && Array.isArray(p.scopeTokens);
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function RecordDetailsPanel({
  entityType, entityId, title = "Details", className = "",
}: {
  entityType: DetailEntityType;
  entityId: string;
  title?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const details = useRecordDetails(entityType, entityId);
  const defs = useDetailDefinitions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preset, setPreset] = useState<AddDetailPreset>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const { confirm, isArmed } = useConfirmArm();

  const openAdd = (p: AddDetailPreset) => { setPreset(p); setDialogOpen(true); };

  const commit = async (row: DetailRowShape, raw: DetailValue | string) => {
    if (typeof raw === "string" && raw.trim() === "") {
      // Emptying a typed field is not a delete — removal is the two-tap X.
      return;
    }
    setSaving(row.definition.id);
    try {
      await setDetailValue(entityType, entityId, row.definition.id, raw);
    } catch (err) {
      toast({ title: `Couldn't save ${row.definition.label}`, description: detailErrorMessage(err), variant: "destructive" });
      // Put the stored value back on screen.
      void queryClient.invalidateQueries({ queryKey: detailsKey(entityType, entityId) });
    } finally {
      setSaving(null);
    }
  };

  const remove = async (row: DetailRowShape) => {
    setSaving(row.definition.id);
    try {
      await clearDetailValue(entityType, entityId, row.definition.id);
    } catch (err) {
      toast({ title: `Couldn't remove ${row.definition.label}`, description: detailErrorMessage(err), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  if (details.isLoading) {
    return (
      <Card className={`p-4 space-y-3 ${className}`} data-testid="record-details-panel">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-16 w-full" />
      </Card>
    );
  }
  // A response that isn't this shape (a proxy page, an older server) is an
  // error state — the panel must never take down the page it sits on.
  if (details.isError || !isPayload(details.data)) {
    return (
      <Card className={`p-4 ${className}`} data-testid="record-details-panel">
        <SectionHeading title={title} icon={SlidersHorizontal} accent={ACCENT} />
        <p className="text-xs text-destructive mt-2" data-testid="record-details-error">
          Couldn't load details — they are still saved.
          <button type="button" className="underline ml-1" onClick={() => details.refetch()}>Try again</button>
        </p>
      </Card>
    );
  }

  const data: RecordDetailsPayloadShape = details.data;
  const allDefs = Array.isArray(defs.data?.definitions) ? defs.data!.definitions : data.available.concat(data.rows.map((r) => r.definition));
  const quickDefs = data.available.slice(0, 6);
  const quickTemplates = data.suggestions.slice(0, Math.max(0, 6 - quickDefs.length));

  return (
    <Card className={`p-4 ${className}`} data-testid="record-details-panel">
      <SectionHeading
        title={title}
        icon={SlidersHorizontal}
        accent={ACCENT}
        count={data.rows.filter((r) => r.value !== null).length}
        meta={
          <div className="flex items-center gap-1">
            {data.flags.length > 0 && (
              <span className="text-[11px] text-amber-700 dark:text-amber-400 mr-1 tabular-nums" data-testid="record-details-flag-count">
                {data.flags.length} flag{data.flags.length === 1 ? "" : "s"}
              </span>
            )}
            <Link href="/details" className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline" data-testid="record-details-manage">
              Manage
            </Link>
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => openAdd(null)} data-testid="record-details-add">
              <Plus className="h-3.5 w-3.5" /> Add detail
            </Button>
          </div>
        }
      />

      {/* Flags sit under the value that raised them; the heading counts them. */}

      {data.rows.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3" data-testid="record-details-rows">
          {data.rows.map((row) => {
            const prev = row.history[row.history.length - 1];
            const armKey = `rm-${row.definition.id}`;
            return (
              <div key={row.definition.id} className="bubble px-3 py-2 min-w-0" data-testid={`record-detail-${row.definition.id}`}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="micro-label text-muted-foreground truncate flex-1" title={row.definition.description || row.definition.label}>
                    {row.definition.label}
                  </span>
                  {saving === row.definition.id && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  {row.stale && (
                    <span className="text-[11px] text-amber-600" title="This value is no longer one of the characteristic's options">not in list</span>
                  )}
                  {row.value !== null && (
                    <button
                      type="button"
                      onClick={() => confirm(armKey, () => { void remove(row); })}
                      className={`rounded px-1 text-[11px] ${isArmed(armKey) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      aria-label={isArmed(armKey) ? `Tap again to remove ${row.definition.label}` : `Remove ${row.definition.label}`}
                      data-testid={`record-detail-remove-${row.definition.id}`}
                    >
                      {isArmed(armKey) ? "Remove?" : <X className="h-3 w-3" />}
                    </button>
                  )}
                </div>
                <DetailInput
                  definition={row.definition}
                  value={row.value}
                  onCommit={(v) => { void commit(row, v); }}
                  disabled={saving === row.definition.id}
                />
                {(prev || row.flags.length > 0) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {row.flags.map((f) => <DetailFlagChip key={f.ruleId} flag={f} />)}
                    {prev && prev.value !== null && (
                      <span className="text-[11px] text-muted-foreground" data-testid={`record-detail-prev-${row.definition.id}`}>
                        was {formatDetailValue(row.definition, prev.value)}{row.updatedAt ? ` · changed ${shortDate(row.updatedAt)}` : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground mt-3" data-testid="record-details-empty">
          No details on {data.name} yet. Add any characteristic — its condition, a rating, a choice from a list, a date — and it becomes searchable and reportable.
        </p>
      )}

      {(quickDefs.length > 0 || quickTemplates.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 mt-3" data-testid="record-details-quick">
          <span className="text-[11px] text-muted-foreground mr-0.5">Add:</span>
          {quickDefs.map((d) => (
            <button key={d.id} type="button" onClick={() => openAdd({ definition: d })}
              className="h-6 rounded-full border border-border px-2 text-[11px] hover:bg-muted inline-flex items-center gap-0.5"
              data-testid={`record-details-quick-${d.id}`}>
              <Plus className="h-3 w-3" /> {d.label}
            </button>
          ))}
          {quickTemplates.map((t) => (
            <button key={`t-${t.label}`} type="button" onClick={() => openAdd({ template: t })}
              className="h-6 rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground hover:bg-muted inline-flex items-center gap-1"
              data-testid={`record-details-suggest-${t.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
              <Sparkles className="h-3 w-3" /> {t.label}
            </button>
          ))}
        </div>
      )}

      <AddDetailDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        payload={data}
        definitions={allDefs}
        preset={preset}
        onSaved={(label, created) => toast({ title: created ? `Added ${label}` : `Saved ${label}` })}
      />
    </Card>
  );
}
