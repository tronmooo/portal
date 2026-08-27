// "+ Add action" — routing the engine did not propose.
//
// Automatic intelligence must never take away manual control. Everything the
// planner produced can be re-routed or switched off, but that only covers
// choices the planner thought to offer. This covers the rest: pick any rows,
// pick where they should go, pick which record, done.
//
// It is how "Annual Premium → also add to property cost calculations" and
// "Named Insured → also update profile" get expressed — an ADDITIONAL
// destination for a fact that already has one, which is why this produces a
// new action rather than editing an existing one.

import { useMemo, useState } from "react";
import { ACTION_KIND_LABEL, classifyActionKind } from "@shared/action-kinds";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DESTINATION_LABEL, type ExtractionDestination, type ExtractionItem,
} from "@shared/extraction-destinations";
import type { ProposedAction, ActionOperation } from "@shared/extraction-actions";

/** Where a hand-made action may send things. Kept deliberately short. */
const MANUAL_DESTINATIONS: ExtractionDestination[] = [
  "profile", "entity_field", "entity_record", "tracker",
  "obligation", "expense", "income", "calendar", "task", "note", "reference",
];

/** Destinations whose write needs a record to aim at. */
const NEEDS_TARGET = new Set<ExtractionDestination>([
  "profile", "entity_field", "entity_record", "tracker",
]);

export interface ProfileOption { id: string; name: string; type?: string }

export function AddActionDialog({
  items,
  profiles,
  documentId,
  onAdd,
}: {
  items: ExtractionItem[];
  profiles: ProfileOption[];
  documentId: string;
  onAdd: (action: ProposedAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<ExtractionDestination>("profile");
  const [targetId, setTargetId] = useState<string>("");
  const [amount, setAmount] = useState("");

  const sortedProfiles = useMemo(
    () => profiles.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [profiles],
  );

  const isMoney = destination === "obligation" || destination === "expense" || destination === "income";
  const needsTarget = NEEDS_TARGET.has(destination);
  const canAdd = picked.size > 0 && (!needsTarget || Boolean(targetId)) && (!isMoney || Number(amount) > 0);

  const reset = () => {
    setPicked(new Set());
    setDestination("profile");
    setTargetId("");
    setAmount("");
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const submit = () => {
    const chosen = items.filter((i) => picked.has(i.id));
    const target = sortedProfiles.find((p) => p.id === targetId);
    const fields: Record<string, any> = {};
    for (const row of chosen) fields[row.key] = row.value;

    const operation: ActionOperation =
      destination === "reference" ? "NO_ACTION"
        : destination === "tracker" ? "APPEND"
          : needsTarget ? "UPDATE" : "CREATE";

    const label = chosen.length === 1
      ? chosen[0].label
      : `${chosen.length} fields`;

    const kind = classifyActionKind({
      destination,
      operation,
      targetKind: target ? "profile" : (destination === "obligation" ? "obligation" : "none"),
      profileType: target?.type,
    });

    onAdd({
      kind,
      kindLabel: ACTION_KIND_LABEL[kind],
      // `manual-` keeps hand-made ids from ever colliding with planner ids, and
      // the destination is part of the key so the SAME rows can be sent to a
      // second destination — which is the whole point of "also add to…".
      id: `manual-${destination}-${chosen.map((c) => c.id).join("-")}`.slice(0, 120),
      operation,
      destination,
      destinationOptions: MANUAL_DESTINATIONS,
      target: target
        ? { kind: "profile", id: target.id, name: target.name, profileType: target.type }
        : { kind: destination === "obligation" ? "obligation" : "none", id: null, name: label },
      roles: [],
      title: `${label} → ${DESTINATION_LABEL[destination]}`,
      detail: target ? `You routed this here` : "You added this",
      factIds: [],
      itemIds: chosen.map((c) => c.id),
      payload: {
        profileId: target?.id,
        fields: needsTarget ? fields : undefined,
        name: label,
        amount: isMoney ? Number(amount) : undefined,
        frequency: destination === "obligation" ? "monthly" : undefined,
        trackerName: destination === "tracker" ? chosen[0]?.label : undefined,
        values: destination === "tracker" ? { value: Number(chosen[0]?.value) } : undefined,
        key: chosen[0]?.key,
        value: chosen[0]?.value,
        date: destination === "calendar" ? String(chosen[0]?.value ?? "") : undefined,
        title: label,
        content: chosen.map((c) => `${c.label}: ${c.value}`).join("\n"),
        _source: { documentId, factIds: [] },
      },
      origin: "manual",
      selected: true,
      confidence: 1,
      warnings: [],
      stage: 2,
      dedupeKey: `manual|${documentId}|${destination}|${targetId}|${chosen.map((c) => c.id).join(",")}`,
      // A hand-made action only ever targets an EXISTING record — the picker
      // lists nothing else — so it is always savable.
      savable: true,
      writesLabel: target
        ? `You routed this to ${target.name}`
        : `You routed this to ${DESTINATION_LABEL[destination]}`,
    });
    reset();
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground w-full"
        data-testid="add-action-open"
      >
        <Plus className="h-3 w-3" />
        Add action
      </button>
    );
  }

  return (
    <div className="px-2.5 py-2 border-t border-border/60 bg-muted/20" data-testid="add-action-dialog">
      <div className="flex items-center justify-between mb-1.5">
        <span className="micro-label text-muted-foreground">Add an action</span>
        <button
          type="button"
          onClick={() => { reset(); setOpen(false); }}
          aria-label="Cancel"
          data-testid="add-action-cancel"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      <div className="max-h-32 overflow-y-auto space-y-0.5 mb-1.5">
        {items.map((row) => (
          <label key={row.id} className="flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={picked.has(row.id)}
              onCheckedChange={() => toggle(row.id)}
              className="h-3.5 w-3.5"
              data-testid={`add-action-row-${row.id}`}
            />
            <span className="text-[11px] truncate">
              {row.label}
              <span className="text-muted-foreground"> · {String(row.value ?? "")}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className="text-[11px] bg-background border border-border rounded px-1 py-0.5"
          value={destination}
          onChange={(e) => setDestination(e.target.value as ExtractionDestination)}
          aria-label="Destination"
          data-testid="add-action-destination"
        >
          {MANUAL_DESTINATIONS.map((d) => (
            <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>
          ))}
        </select>

        {needsTarget && (
          <select
            className="text-[11px] bg-background border border-border rounded px-1 py-0.5 max-w-[160px]"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            aria-label="Which record"
            data-testid="add-action-target"
          >
            <option value="">Which record…</option>
            {sortedProfiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.type ? ` (${p.type})` : ""}</option>
            ))}
          </select>
        )}

        {isMoney && (
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            className="w-24 text-[11px] bg-background border border-border rounded px-1.5 py-0.5 tabular-nums"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount"
            data-testid="add-action-amount"
          />
        )}

        <Button
          size="sm"
          className="h-6 text-[11px] px-2"
          disabled={!canAdd}
          onClick={submit}
          data-testid="add-action-submit"
        >
          Add
        </Button>
      </div>
    </div>
  );
}
