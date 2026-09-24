// Every downstream effect of one suggested action, listed under it.
//
// A date action used to read as one line ("Expiration — Expiration Date")
// while the app went on to store the date, derive an expiration rule, put it on
// the Calendar and in Upcoming, and raise a bell alert before it lapsed, none
// of which the rail named. The list comes from the plan itself
// (ProposedAction.effects, shared/extraction-actions.dateActionEffects), so
// the rail shows the same steps that run. Shared by the full-screen review and
// the inline chat pane so both describe an action the same way.

import {
  Bell, CalendarCheck, CalendarPlus, Equal, ListChecks, PencilLine, Repeat, Save, FileText,
} from "lucide-react";
import type { ActionEffect, ActionEffectKind } from "@shared/extraction-actions";

const EFFECT_ICON: Record<ActionEffectKind, typeof Save> = {
  save_date: Save,
  update_date: PencilLine,
  no_change: Equal,
  keep_on_document: FileText,
  date_rule: Repeat,
  calendar: CalendarCheck,
  event: CalendarPlus,
  upcoming: ListChecks,
  notification: Bell,
};

export function ActionEffects({ effects, actionId }: { effects?: ActionEffect[]; actionId: string }) {
  if (!effects || effects.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5" data-testid={`action-effects-${actionId}`}>
      {effects.map((e, i) => {
        const Icon = EFFECT_ICON[e.kind] ?? ListChecks;
        return (
          <li
            key={`${e.kind}-${i}`}
            className="flex items-start gap-1.5 text-[11px] leading-tight text-muted-foreground"
            data-testid={`action-effect-${actionId}-${e.kind}`}
          >
            <Icon className="h-3 w-3 mt-px shrink-0" aria-hidden="true" />
            <span className="min-w-0">{e.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
