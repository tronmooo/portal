// client/src/components/recurring/WeekdayPicker.tsx
//
// The "Specific days…" half of a recurrence control: toggle buttons for the
// days a `weekly:<days>` series repeats on (see shared/date-math). Shared by
// the calendar's event form and the recurring-dates manager so both compose
// the identical token — a series created in one is editable in the other.

import { Button } from "@/components/ui/button";
import { weekdaySetFor, weekdaySetToRecurrence } from "@shared/date-math";

const DAYS: { n: number; label: string }[] = [
  { n: 0, label: "S" }, { n: 1, label: "M" }, { n: 2, label: "T" },
  { n: 3, label: "W" }, { n: 4, label: "T" }, { n: 5, label: "F" },
  { n: 6, label: "S" },
];
const FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The Select's displayed value: a day set collapses to one "custom" option. */
export const CUSTOM_DAYS_VALUE = "custom-days";

/** Is this recurrence the parametrized weekday-set form (not weekdays/weekends)? */
export function isCustomDaySet(recurrence: string | undefined): boolean {
  return /^weekly:[0-6](,[0-6])*$/.test(String(recurrence || ""));
}

/** Seed a day set from the series' start date, so the control opens on a real day. */
export function seedDaySet(startDate: string | undefined): string {
  const d = new Date(`${String(startDate || "").slice(0, 10)}T00:00:00`);
  return weekdaySetToRecurrence([isNaN(d.getTime()) ? 1 : d.getDay()]);
}

export function WeekdayPicker({
  recurrence,
  onChange,
  testId = "weekday-picker",
}: {
  recurrence: string;
  onChange: (recurrence: string) => void;
  testId?: string;
}) {
  const selected = weekdaySetFor(recurrence) ?? new Set<number>();
  const toggle = (n: number) => {
    const next = new Set(selected);
    // Never let the set empty out — a series with no days repeats on nothing.
    if (next.has(n) && next.size === 1) return;
    next.has(n) ? next.delete(n) : next.add(n);
    onChange(weekdaySetToRecurrence(Array.from(next)));
  };
  return (
    <div className="flex gap-1" role="group" aria-label="Repeat on" data-testid={testId}>
      {DAYS.map(({ n, label }) => (
        <Button
          key={n}
          type="button"
          size="sm"
          variant={selected.has(n) ? "default" : "outline"}
          className="h-8 w-8 p-0 text-xs"
          aria-pressed={selected.has(n)}
          aria-label={FULL[n]}
          title={FULL[n]}
          data-testid={`${testId}-${n}`}
          onClick={() => toggle(n)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
