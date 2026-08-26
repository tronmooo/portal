// One collapsible section per destination — "Recurring obligations", "Entity
// data", "Reference only".
//
// Reference-only starts collapsed. It is real information the user asked to keep
// and it must be reachable, but it is also the half of a document that does
// nothing, and opening on it buries the half that does.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ExtractionItem } from "@shared/extraction-destinations";
import type { ActionGroup } from "@shared/extraction-actions";
import { ActionRow, type ActionRowProps } from "./ActionRow";

type Handlers = Pick<ActionRowProps, "onToggle" | "onDestinationChange" | "onValueChange">;

export function ActionGroupSection({
  group,
  itemsById,
  ...handlers
}: { group: ActionGroup; itemsById: Map<string, ExtractionItem> } & Handlers) {
  // Reference-only and unsavable rows start collapsed. Both are real
  // information the user asked to see, and both are the half of a document that
  // changes nothing — opening on them buries the half that does.
  const startsClosed = group.destination === "reference"
    || group.destination === "ignore"
    || group.destination === "unsupported";
  const [open, setOpen] = useState(!startsClosed);
  const live = group.actions.filter((a) => a.selected && a.operation !== "NO_ACTION").length;
  const allUnsavable = group.actions.every((a) => a.savable === false);

  return (
    <div data-testid={`action-group-${group.destination}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1 bg-muted/50 hover:bg-muted/70 text-left"
        aria-expanded={open}
        data-testid={`action-group-toggle-${group.destination}`}
      >
        <ChevronRight className={`h-3 w-3 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="micro-label text-muted-foreground">{group.label}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {allUnsavable || live === 0 || live === group.actions.length
            ? group.actions.length
            : `${live}/${group.actions.length}`}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border/40">
          {group.actions.map((a) => (
            <ActionRow
              key={a.id}
              action={a}
              evidence={a.itemIds.map((id) => itemsById.get(id)).filter(Boolean) as ExtractionItem[]}
              {...handlers}
            />
          ))}
        </div>
      )}
    </div>
  );
}
