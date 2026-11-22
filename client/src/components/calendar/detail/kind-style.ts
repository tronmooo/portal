// Icon + accent for each calendar kind, and the date formats the detail
// screens share. One mapping so a birthday is purple and a task is green on
// every screen of the detail flow.
import {
  Cake, CalendarHeart, CreditCard, Receipt, Wallet, RefreshCw, Wrench,
  Stethoscope, CheckSquare, FileText, CalendarDays, Repeat,
} from "lucide-react";
import type { OccurrenceKind } from "@shared/calendar-occurrences";

export const KIND_ICONS: Record<OccurrenceKind, any> = {
  birthday: Cake,
  anniversary: CalendarHeart,
  subscription: CreditCard,
  liability: Wallet,
  bill: Receipt,
  renewal: RefreshCw,
  maintenance: Wrench,
  appointment: Stethoscope,
  task: CheckSquare,
  habit: Repeat,
  document: FileText,
  event: CalendarDays,
  custom: CalendarDays,
  expiration: FileText,
  income: Wallet,
};

/** HSL triplets ("H S% L%"). */
export const KIND_HSL: Record<OccurrenceKind, string> = {
  birthday: "262 75% 64%",
  anniversary: "330 75% 60%",
  subscription: "220 80% 62%",
  liability: "270 70% 62%",
  bill: "0 72% 58%",
  renewal: "38 92% 52%",
  maintenance: "199 85% 55%",
  appointment: "155 62% 44%",
  task: "142 64% 45%",
  habit: "170 60% 45%",
  document: "215 15% 60%",
  event: "240 60% 66%",
  custom: "240 60% 66%",
  expiration: "22 80% 55%",
  income: "150 60% 45%",
};

const at = (iso: string) => new Date(`${String(iso).slice(0, 10)}T12:00:00`);

/** "Wed, Sep 22, 2027" */
export const fmtDate = (iso: string) =>
  at(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
/** "Sep 22, 2027" */
export const fmtShort = (iso: string) =>
  at(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
/** "Sep 22" */
export const fmtDay = (iso: string) =>
  at(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
