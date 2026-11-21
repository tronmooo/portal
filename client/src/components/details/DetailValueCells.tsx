// ── Saved characteristics, shown as ordinary fields ─────────────────────────
// Owner, 2026-11-21: the separate Details box was too much ("delete this,
// make this simple"); new facts go through each page's own "Add field". A
// record may still carry values saved as characteristics (from chat, or the
// earlier Details box), so they show here as plain cards: tap to change, X to
// remove (two taps, Rule 8). Nothing renders when there are none, and opening
// the page writes nothing (Rule 3). A failed load says so (Rule 7).
import { useState } from "react";
import { Check, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { clearDetailValue, detailErrorMessage, setDetailValue, useRecordDetails } from "@/lib/record-details";
import type { DetailRowShape, RecordDetailsPayloadShape } from "@/lib/record-details-types";
import { formatDetailValue, type DetailEntityType } from "@shared/record-details";

function isPayload(v: unknown): v is RecordDetailsPayloadShape {
  const p = v as RecordDetailsPayloadShape | null | undefined;
  return !!p && Array.isArray(p.rows);
}

function editText(row: DetailRowShape): string {
  const v = row.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function DetailValueCells({
  entityType, entityId, className = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2",
}: {
  entityType: DetailEntityType;
  entityId: string;
  className?: string;
}) {
  const details = useRecordDetails(entityType, entityId);
  if (details.isLoading) return null;
  if (details.isError || (details.data !== undefined && !isPayload(details.data))) {
    return (
      <p className="text-xs text-destructive" data-testid="detail-cells-error">
        Couldn't load some saved fields — they are still saved.
        <button type="button" className="underline ml-1" onClick={() => details.refetch()}>Try again</button>
      </p>
    );
  }
  const rows = (details.data?.rows || []).filter((r) => r.value !== null);
  if (rows.length === 0) return null;
  return (
    <div className={className} data-testid="detail-cells">
      {rows.map((row) => <DetailCell key={row.definition.id} entityType={entityType} entityId={entityId} row={row} />)}
    </div>
  );
}

function DetailCell({ entityType, entityId, row }: { entityType: DetailEntityType; entityId: string; row: DetailRowShape }) {
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = row.definition.label;
  const armKey = `rm-${row.definition.id}`;

  const save = async () => {
    const text = draft.trim();
    setEditing(false);
    if (!text || text === editText(row)) return;
    try {
      await setDetailValue(entityType, entityId, row.definition.id, text);
    } catch (err) {
      toast({ title: `Couldn't change ${label}`, description: detailErrorMessage(err), variant: "destructive" });
    }
  };
  const remove = async () => {
    try {
      await clearDetailValue(entityType, entityId, row.definition.id);
    } catch (err) {
      toast({ title: `Couldn't remove ${label}`, description: detailErrorMessage(err), variant: "destructive" });
    }
  };

  if (editing) {
    return (
      <Card className="p-2.5">
        <label className="micro-label text-muted-foreground">{label}</label>
        <div className="flex items-center gap-1 mt-1">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-xs" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            data-testid={`detail-cell-edit-${row.definition.id}`} />
          <button onClick={() => void save()} className="text-emerald-500" aria-label="Save"><Check className="h-4 w-4" /></button>
          <button onClick={() => setEditing(false)} className="text-muted-foreground" aria-label="Cancel"><X className="h-4 w-4" /></button>
        </div>
      </Card>
    );
  }
  return (
    <Card
      className="p-2.5 relative cursor-pointer hover:border-primary/50"
      onClick={() => { setDraft(editText(row)); setEditing(true); }}
      data-testid={`detail-cell-${row.definition.id}`}
    >
      <div className="micro-label text-muted-foreground pr-6">{label}</div>
      <div className="text-sm font-medium truncate mt-0.5">{formatDetailValue(row.definition, row.value)}</div>
      <button
        onClick={(e) => { e.stopPropagation(); confirm(armKey, () => { void remove(); }); }}
        className={`absolute top-0.5 right-0.5 h-6 min-w-6 px-1 grid place-items-center rounded-md text-[11px] transition-colors ${isArmed(armKey) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"}`}
        aria-label={isArmed(armKey) ? `Tap again to remove ${label}` : `Remove ${label}`}
        data-testid={`detail-cell-remove-${row.definition.id}`}
      >{isArmed(armKey) ? "Remove?" : <X className="h-3.5 w-3.5" />}</button>
    </Card>
  );
}
