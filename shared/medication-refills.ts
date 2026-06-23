// Prescription refill scheduling — pure + unit-tested so refill reminder dates
// are provably correct (the AI "said it set a reminder" but none landed on the
// calendar; this makes the dates deterministic and the tool actually create
// them).

export interface RefillScheduleInput {
  startDate: string;     // YYYY-MM-DD the course/first fill began
  pillsPerFill: number;  // pills dispensed per fill (e.g. 30)
  refills: number;       // number of REFILLS after the initial fill (e.g. 5)
  dosesPerDay?: number;  // default 1
  leadDays?: number;     // remind this many days BEFORE running out (default 3)
}

export interface RefillReminder { date: string; fillNumber: number }

export interface RefillSchedule {
  supplyDaysPerFill: number;
  reminders: RefillReminder[];
  courseEndDate: string; // when the last fill runs out
}

// Map a free-text frequency to doses per day.
export function parseFrequencyToDosesPerDay(freq?: string | null): number {
  if (!freq) return 1;
  const f = String(freq).toLowerCase();
  if (/\b(four times|4x|4 times|qid)\b/.test(f)) return 4;
  if (/\b(three times|3x|3 times|thrice|tid)\b/.test(f)) return 3;
  if (/\b(twice|2x|2 times|two times|bid)\b/.test(f)) return 2;
  if (/\b(every other day|eod|alternate days)\b/.test(f)) return 0.5;
  if (/\b(weekly|once a week)\b/.test(f)) return 1 / 7;
  return 1; // once daily / daily / unspecified
}

// Add whole days to a YYYY-MM-DD date using UTC so there's no timezone drift.
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + Math.round(days));
  return dt.toISOString().slice(0, 10);
}

export function computeRefillSchedule(input: RefillScheduleInput): RefillSchedule {
  const dosesPerDay = input.dosesPerDay && input.dosesPerDay > 0 ? input.dosesPerDay : 1;
  const leadDays = input.leadDays != null && input.leadDays >= 0 ? input.leadDays : 3;
  const supplyDays = Math.max(1, Math.floor(input.pillsPerFill / dosesPerDay));
  const refills = Math.max(0, Math.floor(input.refills));

  const reminders: RefillReminder[] = [];
  for (let n = 1; n <= refills; n++) {
    // Fill n's supply runs out at startDate + n*supplyDays; remind leadDays before.
    const runOutDay = n * supplyDays;
    reminders.push({ date: addDaysISO(input.startDate, runOutDay - leadDays), fillNumber: n });
  }
  // After the initial fill + `refills` refills, the course runs out here.
  const courseEndDate = addDaysISO(input.startDate, (refills + 1) * supplyDays);
  return { supplyDaysPerFill: supplyDays, reminders, courseEndDate };
}
