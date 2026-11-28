import { changedFieldsOnly } from "@shared/field-patch";
/**
 * Dedicated profile page for liabilities (mortgage / auto loan / credit card / etc.).
 *
 * Phase 2 scope: Overview · Details · Payments v1 · Amortization tabs.
 * Phase 3+ will layer in payoff calculator, smart actions, viz, linked tabs,
 * documents OCR, calendar auto-events, and subtype-specific UI on top of this.
 */

import { DetailValueCells } from "@/components/details/DetailValueCells";
import { AddFieldPanel } from "@/components/AddFieldPanel";
import { localTodayISO } from "@/lib/dates";
import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { flattenProfile } from "@/lib/flattenProfile";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  Wallet,
  Calendar as CalendarIcon,
  TrendingDown,
  TrendingUp,
  Minus,
  Percent,
  DollarSign,
  Plus,
  Loader2,
  ChevronRight,
  ChevronDown,
  Calculator,
  RotateCcw,
  Sparkles,
  Link2,
  Users,
  FileText,
  Upload,
  Trash2,
  X,
  RefreshCw,
  Circle,
  Clock,
  Activity as ActivityIcon,
  CreditCard,
  AlertTriangle,
  Edit,
  User,
  Camera,
  MoreHorizontal,
  Check,
  Shield,
  Info,
  Landmark,
  Layers,
  Flag,
  Car,
  Home,
  GraduationCap,
  Building2,
  Receipt,
  Bell,
  Pencil,
  BarChart3,
  HeartPulse,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Panel, FieldGrid, FieldRow, ReadValue, InfoRow, InfoList, PayoffLine, FigureRow } from "@/components/liability/LiabilityOverviewCards";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SmartFillTrigger } from "@/components/SmartFillTrigger";
import { BillScheduleSection } from "@/components/liability/BillScheduleSection";
import { AutoPaySection, useAutoPaySave } from "@/components/liability/AutoPaySection";
import { PaymentStatusBadge, PaymentStatusControls } from "@/components/liability/PaymentStatusControls";
import { autoPaySettingPatch, isAutoPayOn, type OccurrencePaymentStatus } from "@shared/autopay";
import { DetailHero, type HeroStat } from "@/components/profile/DetailHero";
import { Pill } from "@/components/dashboard/visuals";
import { MetricCard } from "@/components/ui/metric-card";
import type { LucideIcon } from "lucide-react";
import { profileVisual } from "@/lib/profile-visuals";
import { formatFullDate, formatListDate, parseLocalDate, timelineStamp, timelineInstant, formatTimelineStamp, isDateOnly } from "@/lib/format";
import { dayLabel } from "@shared/now-rank";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LinkedPeopleTab } from "@/pages/profile-detail";
import { OwnershipEditor } from "@/components/OwnershipEditor";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday, toLocalDateStr, addDays as tzAddDays } from "@shared/timezone";
import { invalidateDomains } from "@/lib/cache-bus";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { HistoryTab } from "@/components/ProfileSharedTabs";
import { DocumentViewerDialog } from "@/components/DocumentViewer";
import { DocumentDeleteDialog } from "@/components/DocumentDeleteDialog";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import {
  buildAmortization,
  summarizeLiability,
  allocatePayment,
  interestChargedInMonth,
  type AmortizationRow,
} from "@shared/liability-calc";
import { liabilityFamily, isAmortizable, isRecurringBill } from "@shared/liability-types";
import { liabilityBillStatus, BILL_STATUS_META, isWithinOverdueGrace } from "@shared/liability-status";
import { isPausedBillFields } from "@shared/liability-recurrence";
import { profileValueFingerprint } from "@shared/profile-summary-fingerprint";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useAutosave, autosaveStatusLabel } from "@/hooks/useAutosave";
import { readAnnualRate, readBalance, readMonthlyPayment, readInterestRateRaw, storedRateFields, rateInputValue } from "@shared/liability-fields";
import { payoffMissingFields } from "@shared/liability-payoff";
import { PayoffOutlook } from "@/components/liability/PayoffOutlook";
import { getRecordTemporalStatus } from "@shared/temporal-status";
import { DynamicOverview } from "@/components/overview/DynamicOverview";

interface LiabilityProfileLike {
  id: string;
  name: string;
  type: string;          // "liability" or legacy "loan"
  type_key?: string | null;  // canonical subtype from DB column
  subtype?: string | null;   // legacy alias
  fields?: any;
  createdAt?: string;
}

interface LiabilityPayment {
  id: string;
  liabilityProfileId: string;
  paymentDate: string;     // ISO YYYY-MM-DD
  amount: number;
  principalPortion: number;
  interestPortion: number;
  fees: number;
  remainingBalanceAfter?: number | null;
  notes?: string | null;
  createdAt?: string;
  /** Auto Pay view of this payment (GET /api/liabilities/:id/payments). */
  status?: OccurrencePaymentStatus;
  occurrenceDate?: string | null;
  autopay?: boolean;
  expectedAmount?: number | null;
}

const SUBTYPE_LABELS: Record<string, string> = {
  mortgage: "Mortgage",
  auto_loan: "Auto loan",
  credit_card: "Credit card",
  student_loan: "Student loan",
  medical_debt: "Medical debt",
  business_loan: "Business loan",
  tax_debt: "Tax debt",
  line_of_credit: "Line of credit",
  bnpl: "Buy now pay later",
  personal_loan: "Personal loan",
  financing: "Financing",
  utility_plan: "Utility plan",
  custom: "Other liability",
};

// What "Change type" offers: the debt kinds this page has a layout for, then
// the common recurring bills (shared/liability-types classifies each).
const LIABILITY_TYPE_CHOICES: Record<string, string> = {
  mortgage: "Mortgage", auto_loan: "Auto loan", student_loan: "Student loan", personal_loan: "Personal loan",
  business_loan: "Business loan", credit_card: "Credit card", line_of_credit: "Line of credit",
  medical_debt: "Medical debt", tax_debt: "Tax debt",
  subscription: "Subscription", utility: "Utility", phone_plan: "Phone plan", internet: "Internet",
  insurance: "Insurance", rent: "Rent", bill: "Bill",
};

// The glyph beside the type under the title (owner's design, 2026-11-22: a car
// for an auto loan). A subtype with none falls back by family.
const SUBTYPE_ICONS: Record<string, LucideIcon> = {
  mortgage: Home,
  auto_loan: Car,
  credit_card: CreditCard,
  student_loan: GraduationCap,
  medical_debt: HeartPulse,
  business_loan: Building2,
  line_of_credit: CreditCard,
};

const ordinal = (n: number) => {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] || "th");
  return `${n}${suffix}`;
};

// ─── Formatting helpers ──────────────────────────────────────────────────────

const fmtUSD = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : "$0.00";

// Smart formatter: shows decimals only when needed (e.g. $325,000.50 keeps cents, $325,000 stays clean).
const fmtUSDShort = (n: number) => {
  if (!Number.isFinite(n)) return "$0";
  const hasCents = Math.round(n * 100) !== Math.round(n) * 100;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
};

// Smart percent formatter: shows 3 decimals for sub-1%, 2 decimals otherwise so micro-rates aren't lost.
const fmtPct = (decimal: number) => {
  if (!Number.isFinite(decimal)) return "0.00%";
  const pct = decimal * 100;
  const digits = Math.abs(pct) > 0 && Math.abs(pct) < 1 ? 3 : 2;
  return `${pct.toFixed(digits)}%`;
};

// A due date is a calendar day, not an instant. This used to be a local
// `new Date(iso)`, which reads a bare "2026-08-30" as UTC midnight — so the hero
// said "Aug 29" while the Schedule card directly beneath it said "Aug 30".
// formatFullDate parses length-10 strings at LOCAL midnight; both agree now.
const fmtDate = (iso?: string | null) => formatFullDate(iso);

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Cadences the bill editor offers. Deliberately only the tokens
// shared/recurrence freqToUnit() maps to a real unit — anything it doesn't
// recognize returns unit:"" and the "series" quietly becomes one occurrence,
// which is a worse outcome than not offering the option at all.
const BILL_FREQUENCIES = ["weekly", "biweekly", "monthly", "yearly"];

// Read a liability term consistently — data lives across many key shapes:
//   * camelCase keys written by LiabilityProfilePage / older flows
//     (currentBalance, monthlyPayment, annualInterestRate)
//   * snake_case keys written by the registry-driven CreateProfileDialog
//     (current_balance, monthly_payment, interest_rate, loan_term_months,
//      start_date, original_balance, extra_payment)
//   * legacy nested paths (fields.loan.*, fields.finance.*)
/** A fresh idempotency key for one payment. */
function newPaymentKey(): string {
  try { return crypto.randomUUID(); } catch { return `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

function readTerms(profile: LiabilityProfileLike) {
  const f = profile.fields || {};
  const loan = f.loan || {};
  const finance = f.finance || {};
  const pick = (...vals: any[]) => {
    for (const v of vals) {
      if (v == null || v === "") continue;
      const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  // Rule 11: the canonical readers (shared/liability-fields) — the same
  // balance, rate and payment every other surface reads, in the same order.
  const currentBalance = readBalance(f) || 0;
  const originalBalance =
    pick(
      f.originalBalance, f.original_balance,
      f.originalAmount, f.original_amount,
      f.principal,
      finance.originalBalance, finance.original_balance,
      finance.originalAmount, finance.original_amount,
      loan.originalBalance, loan.original_balance,
      loan.originalAmount, loan.original_amount,
    ) || 0;
  const annualRate = readAnnualRate(f);
  const monthlyPayment = readMonthlyPayment(f) || 0;
  // term may be stored as a number, or as "60 months" string
  const parseTermNumber = (raw: any): number => {
    if (raw == null) return 0;
    if (typeof raw === "number") return raw;
    const m = String(raw).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const remainingTermMonthsRaw =
    pick(
      f.remainingTermMonths, f.remaining_term_months,
      f.loanTermMonths, f.loan_term_months,
      f.termMonths, f.term_months,
      finance.termMonths, finance.term_months,
      loan.termMonths, loan.term_months,
    ) ||
    parseTermNumber(f.term) ||
    parseTermNumber(finance.term) ||
    parseTermNumber(loan.term);
  const remainingTermMonths = remainingTermMonthsRaw > 0 ? remainingTermMonthsRaw : undefined;
  const rawDate =
    f.firstPaymentDate ??
    f.first_payment_date ??
    f.loanStartDate ??
    f.loan_start_date ??
    f.startDate ??
    f.start_date ??
    finance.startDate ??
    finance.start_date ??
    loan.startDate ??
    loan.start_date ??
    undefined;
  // Reject obviously broken date strings (e.g. accidental year 12024 from a
  // browser date input fat-finger). Year must be 1900–2100.
  let firstPaymentDate: string | undefined = undefined;
  if (typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    const yr = parseInt(rawDate.slice(0, 4), 10);
    if (yr >= 1900 && yr <= 2100) firstPaymentDate = rawDate.slice(0, 10);
  }
  const lender = (f.lender || f.creditor || f.servicer || "").toString();
  const accountNumberLast4 = (
    f.accountNumberLast4 ||
    f.account_number_last4 ||
    f.loanNumber ||
    f.loan_number ||
    f.last4 ||
    ""
  ).toString();
  const dueDay =
    pick(f.dueDay, f.due_day, f.paymentDueDay, f.payment_due_day) || undefined;

  // Subtype-specific reads (Phase 5)
  const creditLimit =
    pick(
      f.creditLimit, f.credit_limit,
      finance.creditLimit, finance.credit_limit,
    ) || 0;
  const minimumPayment =
    pick(
      f.minimumPayment, f.minimum_payment, f.min_payment,
      finance.minimumPayment, finance.minimum_payment,
    ) || 0;
  const propertyAddress = (
    f.propertyAddress || f.property_address || f.address || ""
  ).toString();
  const escrowMonthly = pick(
    f.escrowMonthly, f.escrow_monthly, f.escrow,
  ) || 0;
  const propertyTaxes = pick(
    f.propertyTaxes, f.property_taxes, f.annualPropertyTaxes,
  ) || 0;
  const homeownersInsurance = pick(
    f.homeownersInsurance, f.homeowners_insurance, f.insurance,
  ) || 0;
  const vehicleVin = (
    f.vehicleVin || f.vehicle_vin || f.vin || ""
  ).toString();
  const vehicleYear = (
    f.vehicleYear || f.vehicle_year || f.year || ""
  ).toString();
  const vehicleMake = (
    f.vehicleMake || f.vehicle_make || f.make || ""
  ).toString();
  const vehicleModel = (
    f.vehicleModel || f.vehicle_model || f.model || ""
  ).toString();
  const pslfEligible = !!(
    f.pslfEligible ?? f.pslf_eligible ?? false
  );
  const idrPlan = (
    f.idrPlan || f.idr_plan || ""
  ).toString();
  const forgivenessDate = (
    f.forgivenessDate || f.forgiveness_date || ""
  ).toString();

  return {
    currentBalance,
    originalBalance,
    annualRate,
    monthlyPayment,
    remainingTermMonths,
    firstPaymentDate,
    lender,
    accountNumberLast4,
    dueDay,
    // subtype-specific
    creditLimit,
    minimumPayment,
    propertyAddress,
    escrowMonthly,
    propertyTaxes,
    homeownersInsurance,
    vehicleVin,
    vehicleYear,
    vehicleMake,
    vehicleModel,
    pslfEligible,
    idrPlan,
    forgivenessDate,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface LiabilityProfilePageProps {
  profile: LiabilityProfileLike;
}

type TabKey =
  | "overview"
  | "payments"
  | "schedule"
  | "cost"
  | "documents"
  | "history";

const PROFILE_LINK_ROLES: { value: string; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "co_signer", label: "Co-signer" },
  { value: "guarantor", label: "Guarantor" },
  { value: "responsible_party", label: "Responsible party" },
  { value: "authorized_user", label: "Authorized user" },
];

const ASSET_LINK_ROLES: { value: string; label: string }[] = [
  { value: "collateral", label: "Collateral" },
  { value: "secured_by", label: "Secured by" },
  { value: "associated", label: "Associated" },
];

export function LiabilityProfilePage({ profile }: LiabilityProfilePageProps) {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<TabKey>("overview");
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Edit / delete / avatar — match asset profile parity ────────────────────
  const [showDeleteProfileDialog, setShowDeleteProfileDialog] = useState(false);
  const [editName, setEditName] = useState<string>(profile.name || "");
  const [editNotes, setEditNotes] = useState<string>((profile as any).notes || "");
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const avatarMutation = useMutation({
    mutationFn: async (base64: string) => {
      // No invalidateDomains here. Every write leaves through apiRequest, and
      // the server's response says which entities it changed and which domains
      // those feed — so the cache is already patched and the right queries are
      // already refreshing by the time this runs. Screens declaring it
      // themselves is the pattern that let one quietly forget a domain; see
      // lib/write-sync.ts applyWriteManifest.
      //
      // The few calls left in this file name a domain the write itself does not
      // touch (deleting a liability clears calendar events; an upload links a
      // document to a profile). Those are claims about consequences the server
      // cannot report, so they stay.
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { avatar: base64 });
    },
    onSuccess: () => {
      toast({ title: "Profile picture updated" });
    },
    onError: (err: Error) => toast({ title: "Failed to update picture", description: formatApiError(err), variant: "destructive" }),
  });

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Please choose an image under 2MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      avatarMutation.mutate(result);
    };
    reader.readAsDataURL(file);
  };

  // ── Inline edit for loan terms (Details tab) ───────────────────────────────
  // Lets the user set monthlyPayment + dueDay + firstPaymentDate inline so the
  // payment lands on the calendar. The server's syncLiabilityObligation hook
  // turns those fields into a recurring obligation automatically.
  const [editingTerms, setEditingTerms] = useState(false);
  const [tBalance, setTBalance] = useState("");
  const [tOriginal, setTOriginal] = useState("");
  const [tRate, setTRate] = useState("");
  const [tTerm, setTTerm] = useState("");
  const [tMonthly, setTMonthly] = useState("");
  const [tDueDay, setTDueDay] = useState("");
  const [tFirstPayment, setTFirstPayment] = useState("");
  const [tLender, setTLender] = useState("");
  /** The terms form → the field patch it means. Pure, so the SAME builder can
   *  run on the values the form opened with: only what the user changed is
   *  written, and a balance moved by a payment while the dialog sat open is
   *  not put back (D246). */
  const buildTermsFields = (v: { balance: string; original: string; rate: string; term: string; monthly: string; dueDay: string; firstPayment: string; lender: string }): Record<string, any> => {
    const fields: Record<string, any> = {};
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    if (v.balance !== "") fields.currentBalance = num(v.balance);
    if (v.original !== "") fields.originalBalance = num(v.original);
    if (v.rate !== "") {
      // Stored as a PERCENT under the canonical key. Writing a decimal here
      // made the Overview print "0.1%" for a 6.25% loan.
      // What is typed IS the percent (0.9 is 0.9%), stored with its unit
      // marker so no reader has to guess (shared/liability-fields).
      Object.assign(fields, storedRateFields(v.rate));
    }
    if (v.term !== "") fields.remainingTermMonths = num(v.term);
    if (v.monthly !== "") fields.monthlyPayment = num(v.monthly);
    const clearOrSet = (key: string, raw: string, stored: boolean, value: any) => {
      if (raw.trim() === "") { if (stored) fields[key] = null; return; }
      if (value !== undefined) fields[key] = value;
    };
    {
      const d = num(v.dueDay);
      clearOrSet("dueDay", v.dueDay, f2.dueDay != null, d != null && d >= 1 && d <= 31 ? d : undefined);
    }
    clearOrSet("firstPaymentDate", v.firstPayment, f2.firstPaymentDate != null,
      /^\d{4}-\d{2}-\d{2}$/.test(v.firstPayment.trim()) ? v.firstPayment.trim() : undefined);
    clearOrSet("lender", v.lender, f2.lender != null, v.lender.trim());
    return fields;
  };
  type TermsForm = Parameters<typeof buildTermsFields>[0];
  // The page header reads the profile-detail cache. A save used to show there
  // only after a full refetch of that payload (~3 s of the old APR after the
  // form said "Saved"); the saved fields are written into the cache at once
  // and the refetch then confirms them.
  const patchDetailFields = (saved: Record<string, any>) => {
    qc.setQueryData(["/api/profiles", profile.id, "detail"], (old: any) => {
      if (!old || typeof old !== "object") return old;
      const next = { ...(old.fields || {}) };
      for (const [k, v] of Object.entries(saved)) { if (v === null || v === undefined) delete next[k]; else next[k] = v; }
      return { ...old, fields: next };
    });
  };
  // AUTO-SAVE: every change is saved as it is made (hooks/useAutosave) — only
  // what changed since the last save is written, so a balance moved by a
  // payment while the form sat open is still not put back (D246).
  const termsAutosave = useAutosave<TermsForm>({
    enabled: editingTerms,
    snapshot: { balance: tBalance, original: tOriginal, rate: tRate, term: tTerm, monthly: tMonthly, dueDay: tDueDay, firstPayment: tFirstPayment, lender: tLender },
    save: async (current, saved) => {
      const fields = changedFieldsOnly(buildTermsFields(saved), buildTermsFields(current));
      if (Object.keys(fields).length === 0) return;
      try {
        await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields });
      } catch (err: any) {
        toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" });
        throw err;
      }
      patchDetailFields(fields);
      invalidateDomains("liabilities", "events");
    },
  });
  // Done saves what is still waiting BEFORE the form closes: closing first
  // reset the autosave baseline while a save was in flight and the last edit
  // could be dropped.
  const closeTermsEditor = async () => { await termsAutosave.flush(); setEditingTerms(false); };
  /** Put the form back to the values it opened with; the autosave writes the reversal. */
  const undoTermsEdits = () => {
    const o = termsAutosave.opened;
    if (!o) return;
    // A field that opened blank is cleared on the record: the form's own
    // builder skips blank inputs, so the typed value would otherwise stay.
    const cleared: Record<string, null> = {};
    const now = { balance: tBalance, original: tOriginal, rate: tRate, term: tTerm, monthly: tMonthly };
    const stored: Record<keyof typeof now, string[]> = {
      balance: ["balance"], original: ["originalBalance"], rate: ["interestRate"], term: ["remainingTermMonths"], monthly: ["monthlyPayment"],
    };
    for (const k of Object.keys(now) as Array<keyof typeof now>) {
      if (o[k] === "" && now[k] !== "") for (const key of stored[k]) cleared[key] = null;
    }
    setTBalance(o.balance); setTOriginal(o.original); setTRate(o.rate); setTTerm(o.term);
    setTMonthly(o.monthly); setTDueDay(o.dueDay); setTFirstPayment(o.firstPayment); setTLender(o.lender);
    if (Object.keys(cleared).length > 0) {
      void apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields: cleared })
        .then(() => { patchDetailFields(cleared); invalidateDomains("liabilities", "events"); })
        .catch((err: any) => toast({ title: "Failed to undo", description: formatApiError(err), variant: "destructive" }));
    }
  };
  const openTermsEditor = () => {
    setTBalance(terms.currentBalance ? String(terms.currentBalance) : "");
    setTOriginal(terms.originalBalance ? String(terms.originalBalance) : "");
    // The field is labelled "%": show the percent (6.25), not the decimal the
    // amortization engine works in (0.0625).
    setTRate(rateInputValue(profile));
    setTTerm(terms.remainingTermMonths ? String(terms.remainingTermMonths) : "");
    setTMonthly(terms.monthlyPayment ? String(terms.monthlyPayment) : "");
    setTDueDay(terms.dueDay ? String(terms.dueDay) : "");
    setTFirstPayment(terms.firstPaymentDate || "");
    setTLender(terms.lender || "");
    setEditingTerms(true);
  };

  // ── Inline edit for a recurring bill (Details tab) ─────────────────────────
  // "Bill details" was a read-only list: the page would state the amount, the
  // frequency, the due date, the term, the reminder and autopay, and give the
  // user no way to change a single one of them — while a loan, one subtype
  // over, had an Edit button on the very same card. Same card, same
  // affordance now.
  //
  // Writes go to the canonical field names that shared/liability-schedule
  // generates the series from, so the hero, the Payments tab, and the calendar
  // all move together instead of one surface disagreeing with the next.
  const [editingBill, setEditingBill] = useState(false);
  const [bAmount, setBAmount] = useState("");
  const [bFrequency, setBFrequency] = useState("monthly");
  const [bDueDate, setBDueDate] = useState("");
  const [bCount, setBCount] = useState("");
  const [bEnd, setBEnd] = useState("");
  const [bReminder, setBReminder] = useState("");
  const [bAutopay, setBAutopay] = useState(false);
  /** The bill form → its field patch. Pure for the same reason as
   *  buildTermsFields: a due date advanced by a payment while the dialog sat
   *  open must not be put back by a save that only changed the reminder (D246). */
  const buildBillFields = (v: { amount: string; frequency: string; dueDate: string; count: string; end: string; reminder: string; autopay: boolean }): Record<string, any> => {
      const isoDay = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null);
      const num = (s: string) => {
        if (s.trim() === "") return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };
      const fields: Record<string, any> = {};

      const amt = num(v.amount);
      if (amt != null && amt >= 0) {
        // liabilityAmount() reads monthlyAmount ?? amount ?? cost — write the
        // first two so no stale alias outranks the edit.
        fields.monthlyAmount = amt;
        fields.amount = amt;
      }
      if (v.frequency) {
        fields.frequency = v.frequency;
        fields.billingFrequency = v.frequency;
      }
      const due = isoDay(v.dueDate);
      if (due) {
        // One input, three keys, deliberately: the occurrence series is
        // generated from `firstPaymentDate ?? dueDate ?? nextDueDate`, so
        // writing dueDate alone on a bill that carries a firstPaymentDate
        // moves nothing the user can see. This field moves the SERIES —
        // shifting one occurrence is the pencil in the Payments tab.
        fields.firstPaymentDate = due;
        fields.dueDate = due;
        fields.nextDueDate = due;
      }
      // A null clears the key server-side (mergeAndApplyDeletes drops nulled
      // fields), which is how "ongoing", "no end date" and "no reminder" are
      // said — blanking the input has to actually remove the bound, not leave
      // the old one standing.
      const count = num(v.count);
      fields.count = count != null && count >= 1 ? Math.floor(count) : null;
      fields.recurrenceEnd = isoDay(v.end);
      const lead = num(v.reminder);
      fields.reminderLeadDays = lead != null && lead >= 0 ? Math.floor(lead) : null;
      // Three spellings reach the two surfaces that render this (the schedule
      // reads autopay/autoPay, the Details row also honours autoRenew), so the
      // toggle has to set every one it could be read through — otherwise
      // turning autopay off leaves the row still reading "On".
      // …and the day it was switched on is stamped with it, by the one
      // shared patch (shared/autopay): Auto Pay must not back-fill a payment
      // that was due before the switch.
      Object.assign(fields, autoPaySettingPatch(f2, v.autopay, todayISO));
      if (f2.autoRenew !== undefined) fields.autoRenew = v.autopay;

      return fields;
  };
  type BillForm = Parameters<typeof buildBillFields>[0];
  // AUTO-SAVE, as for the loan terms above.
  const billAutosave = useAutosave<BillForm>({
    enabled: editingBill,
    snapshot: { amount: bAmount, frequency: bFrequency, dueDate: bDueDate, count: bCount, end: bEnd, reminder: bReminder, autopay: bAutopay },
    save: async (current, saved) => {
      const fields = changedFieldsOnly(buildBillFields(saved), buildBillFields(current));
      if (Object.keys(fields).length === 0) return;
      try {
        await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields });
      } catch (err: any) {
        toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" });
        throw err;
      }
      // The schedule key is ["/api/liabilities", id, "schedule"] — the domain
      // bus predicate matches "/api/liabilities/" (with the slash), so this one
      // has to be invalidated by hand or the card keeps the pre-edit series.
      patchDetailFields(fields);
      qc.invalidateQueries({ queryKey: ["/api/liabilities", profile.id, "schedule"] });
      invalidateDomains("liabilities", "events");
    },
  });
  const closeBillEditor = async () => { await billAutosave.flush(); setEditingBill(false); };
  const undoBillEdits = () => {
    const o = billAutosave.opened;
    if (!o) return;
    setBAmount(o.amount); setBFrequency(o.frequency); setBDueDate(o.dueDate); setBCount(o.count);
    setBEnd(o.end); setBReminder(o.reminder); setBAutopay(o.autopay);
  };
  const openBillEditor = () => {
    setBAmount(String(schedule?.amount ?? billMonthly ?? ""));
    setBFrequency(billFrequencyLabel || "monthly");
    setBDueDate((schedule?.firstPayment || billNextDueEff || billDueRaw || "").slice(0, 10));
    setBCount(billTotalTerm != null ? String(billTotalTerm) : "");
    setBEnd((schedule?.recurrenceEnd || "").slice(0, 10));
    setBReminder(billReminderLead != null ? String(billReminderLead) : "");
    setBAutopay(isAutoPayOn(f2));
    setEditingBill(true);
  };

  // Deleting stops what is scheduled; the payments already recorded are history
  // and go only when the person ticks this.
  const [deleteHistoryToo, setDeleteHistoryToo] = useState(false);
  const deleteProfileMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/profiles/${profile.id}${deleteHistoryToo ? "?deleteHistory=1" : ""}`);
      return res.json().catch(() => ({}));
    },
    onSuccess: (out: any) => {
      queryClient.setQueryData(["/api/profiles"], (old: any[]) =>
        old?.filter((p: any) => p.id !== profile.id) || []
      );
      // Say what happened to the money already recorded (owner, 2026-11-27).
      const kept = Number(out?.keptPayments) || 0, gone = Number(out?.deletedPayments) || 0;
      toast({
        title: `"${profile.name}" deleted`,
        description: gone ? `Its ${gone} recorded payment${gone === 1 ? "" : "s"} left your spending history too.`
          : kept ? `Its ${kept} recorded payment${kept === 1 ? " stays" : "s stay"} in your spending history, marked as paid to "${profile.name}".`
          : "Nothing further is scheduled for it.",
      });
      invalidateDomains("liabilities", "events", "expenses");
      // Back where the liability was listed — `/profiles` is the Info tab.
      navigate("/linked?tab=liabilities");
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" }),
  });

  // ── Multi-owner popover (mirrors asset profile picker) ──────────────────────
  const [ownerPopoverOpen, setOwnerPopoverOpen] = useState(false);

  const { data: ownerCandidates } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: !!profile.id,
  });
  const personOptions = (ownerCandidates || []).filter((p: any) =>
    ["self", "person"].includes(p.type) && !p.parentProfileId
  );

  // Fetch current liability party links
  const { data: currentPartyLinks = [], refetch: refetchPartyLinks } = useQuery<any[]>({
    queryKey: ["/api/liabilities", profile.id, "parties"],
    queryFn: () => apiRequest("GET", `/api/liabilities/${profile.id}/parties`).then(r => r.json()),
    enabled: !!profile.id,
  });

  const linkedPersonIdSet = useMemo(() =>
    new Set((currentPartyLinks || []).map((l: any) => l.partyProfileId || l.party?.id)),
    [currentPartyLinks]
  );

  const [checkedOwnerIds, setCheckedOwnerIds] = useState<Set<string>>(new Set());

  // Sync checked state when popover opens. If no links exist yet, default to
  // the user's self profile so a single Save click confirms self-ownership.
  useEffect(() => {
    if (ownerPopoverOpen) {
      if (linkedPersonIdSet.size === 0) {
        const self = (personOptions || []).find((p: any) => p.type === "self");
        setCheckedOwnerIds(self ? new Set([self.id]) : new Set());
      } else {
        setCheckedOwnerIds(new Set(linkedPersonIdSet));
      }
    }
  }, [ownerPopoverOpen, linkedPersonIdSet, personOptions]);

  const saveOwnersMutation = useMutation({
    mutationFn: async (selectedIds: string[]) => {
      const pct = selectedIds.length > 0 ? Math.round(10000 / selectedIds.length) / 100 : 100;
      const toAdd = selectedIds.filter(sid => !linkedPersonIdSet.has(sid));
      const toRemove = (currentPartyLinks || []).filter((l: any) => {
        const lid = l.partyProfileId || l.party?.id;
        return lid && !selectedIds.includes(lid);
      });
      for (const link of toRemove) {
        await apiRequest("DELETE", `/api/liability-profile-links/${link.id || link.linkId}`);
      }
      for (const sid of toAdd) {
        await apiRequest("POST", "/api/liability-profile-links", {
          liabilityProfileId: profile.id,
          partyProfileId: sid,
          ownershipPercentage: pct,
          role: "borrower",
        });
      }
      const toKeep = (currentPartyLinks || []).filter((l: any) => {
        const lid = l.partyProfileId || l.party?.id;
        return lid && selectedIds.includes(lid);
      });
      for (const link of toKeep) {
        await apiRequest("PATCH", `/api/liability-profile-links/${link.id || link.linkId}`, {
          ownershipPercentage: pct,
        });
      }
      // Bug #1: return union of old + new owners so each affected person's
      // caches can be invalidated.
      const oldOwnerIds = (currentPartyLinks || [])
        .map((l: any) => l.partyProfileId || l.party?.id)
        .filter(Boolean) as string[];
      return Array.from(new Set([...oldOwnerIds, ...selectedIds]));
    },
    onSuccess: (affectedOwnerIds: string[] = []) => {
      toast({ title: "Ownership updated" });
      refetchPartyLinks();
      qc.invalidateQueries({ queryKey: ["/api/liabilities", profile.id, "parties"] });
      qc.invalidateQueries({ queryKey: ["/api/liability-profile-links"] });
      void invalidateDomains("everything"); // co-ownership changes every scoped list (see shared/storage-domains)
      // Bug #1 + #15: the "liabilities" + "people" domains cover the liability
      // profile's detail, the profiles list, the dashboard, rel-people, and
      // every affected owner's detail / ["/api/parties", ownerId, "liabilities"]
      // caches via the bus predicate — no per-owner loop needed.
      void affectedOwnerIds;
      setOwnerPopoverOpen(false);
    },
    onError: (err: Error) => toast({ title: "Failed to update ownership", description: formatApiError(err), variant: "destructive" }),
  });

  const ownerButtonLabel = useMemo(() => {
    const linked = (currentPartyLinks || []).map((l: any) =>
      l.party?.name || personOptions.find((p: any) => p.id === (l.partyProfileId || l.party?.id))?.name
    ).filter(Boolean);
    if (linked.length === 0) {
      // Fall back to fields.ownerName, then self profile name, before "Set owner".
      if ((profile as any)?.fields?.ownerName) return (profile as any).fields.ownerName;
      const self = (personOptions || []).find((p: any) => p.type === "self");
      if (self?.name) return self.name;
      return "Set owner";
    }
    if (linked.length === 1) return linked[0];
    if (linked.length === 2) return `Shared · ${linked[0]} + ${linked[1]}`;
    return `Shared · ${linked.length} people`;
  }, [currentPartyLinks, personOptions, profile]);

  const terms = useMemo(() => readTerms(profile), [profile]);
  // Subtype lookup: type_key is the canonical column on the profiles table
  // (e.g. 'auto_loan', 'mortgage'). We fall back to legacy fields for older
  // rows that might still carry the value inside the JSON blob.
  const subtypeRaw = (
    profile.type_key ||
    profile.subtype ||
    profile.fields?.subtype ||
    profile.fields?.type_key ||
    profile.fields?.liabilityType ||
    ""
  ).toString();
  const subtypeLabel = SUBTYPE_LABELS[subtypeRaw] || LIABILITY_TYPE_CHOICES[subtypeRaw] || "Liability";
  // Behavioral family drives which cards/calcs the page shows. A phone bill is
  // NOT amortized over 360 months (that produced the $0.17/mo bug); only real
  // loans + credit cards run the payoff schedule.
  const family = liabilityFamily(subtypeRaw);
  const amortize = isAmortizable(subtypeRaw);
  const recurringBill = isRecurringBill(subtypeRaw);
  const f2 = (profile.fields || {}) as any;
  // A paused bill has no next due date, and "no due date" reads as
  // "upcoming" — the STATUS tile said Upcoming while the bill was paused.
  const billHeldLabel: string | null = recurringBill && isPausedBillFields(f2)
    ? (String(f2.status || "").toLowerCase() === "cancelled" ? "Cancelled" : "Paused")
    : null;
  const billMonthly = readMonthlyPayment(f2) || Number(f2.balance ?? 0) || 0;
  // The user's calendar day — the same helper the server uses (Rule 13).
  const todayISO = getUserToday(BROWSER_TIMEZONE);
  // THE next due (shared/temporal-status): a bill answers with the occurrence
  // still owed (F-16) on the day it was moved to; a loan with its payment day
  // counted from today. The header chip and the amortization start below read
  // this ONE value, so they cannot disagree (Rule 13).
  const temporal = getRecordTemporalStatus({ kind: "liability", fields: f2, row: profile as any, typeKey: subtypeRaw }, todayISO);
  const billDueRaw = temporal.nextOccurrence ?? "";
  const billStatus = liabilityBillStatus(billDueRaw, todayISO, false);
  const creditLimit = Number(f2.creditLimit ?? f2.credit_limit ?? 0) || 0;
  const utilizationPct = creditLimit > 0 ? Math.min(999, Math.round((readBalance(f2) / creditLimit) * 100)) : 0;

  // Payments fetch
  const paymentsQuery = useQuery<LiabilityPayment[]>({
    queryKey: [`/api/liabilities/${profile.id}/payments`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/liabilities/${profile.id}/payments`);
      return res.json();
    },
    enabled: !!profile.id,
  });
  const payments = paymentsQuery.data || [];
  const paymentsTotal = useMemo(
    () => payments.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [payments],
  );
  const interestPaidToDate = useMemo(
    () => payments.reduce((s, p) => s + (Number(p.interestPortion) || 0), 0),
    [payments],
  );

  // Canonical derived schedule — the SAME source the Schedule & Calendar section
  // and the main Calendar read. Drives the recurring-bill header + Details card
  // so "next due", "status", "remaining term", and "progress" are computed one
  // way everywhere and never contradict each other. (Shares the query key with
  // <BillScheduleSection> so React Query dedupes to a single request.)
  const scheduleQuery = useQuery<any>({
    queryKey: ["/api/liabilities", profile.id, "schedule"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/liabilities/${profile.id}/schedule?months=12`)).json(),
    enabled: !!profile.id,
  });
  const schedule = scheduleQuery.data;
  // Derived recurring-bill facts (all from the schedule, not amortization math).
  const scheduleOccs: any[] = schedule?.occurrences || [];
  const missedCount = scheduleOccs.filter((o) => o.status === "overdue").length;
  const seriesComplete =
    recurringBill && schedule && schedule.remainingPayments === 0 && (schedule.totalPayments ?? 0) > 0;
  // The header shows the next *scheduled* date (rolled forward to today or
  // later) — a passed due date rolls to the next cycle instead of turning the
  // whole bill "Overdue". Genuinely missed occurrences surface separately in the
  // Schedule section (and via missedCount), keeping date and status distinct.
  // …except an unpaid occurrence still inside the overdue grace window
  // (shared/liability-status): that IS the next due date, and it reads
  // "Overdue" here exactly as it does on the bills list and the calendar,
  // instead of rolling forward silently (F-16).
  // 2026-11-22 (A7): the header names the bill's NEXT date, as the dashboard,
  // Finance and the bell do — an elapsed date is assumed paid. It used to hold
  // an unpaid date inside a 30-day grace window as "Overdue", so tapping
  // "Netflix · Nov 25" on the dashboard landed on "Overdue · Oct 25". The
  // schedule below still lists every past date, where one can be recorded.
  const nextFutureOcc = scheduleOccs.find(
    (o) => o.effectiveDate >= todayISO && o.status !== "paid" && o.status !== "skipped" && o.status !== "missed",
  );
  const billNextDueEff = nextFutureOcc?.effectiveDate
    || schedule?.nextDue?.effectiveDate
    || billDueRaw
    || null;
  // Status for the header/KPI: complete → Paid; otherwise upcoming/due-today
  // computed from the rolled-forward date (never spuriously overdue).
  const billStatusEff: typeof billStatus = seriesComplete
    ? "paid"
    : recurringBill
      ? liabilityBillStatus(billNextDueEff, todayISO, false)
      : billStatus;
  const billTotalTerm: number | null = schedule?.totalPayments ?? null;
  const billPaidCount: number = schedule?.paidCount ?? payments.length;
  const billRemainingTerm: number | null = schedule?.remainingPayments ?? null;
  const billProgressPct =
    billTotalTerm && billTotalTerm > 0
      ? Math.min(100, Math.round((billPaidCount / billTotalTerm) * 100))
      : 0;
  const billReminderLead: number | null = schedule?.reminderLeadDays ?? null;
  const billFrequencyLabel: string = schedule?.frequency || String(f2.frequency || "monthly");

  // Summary + amortization. The schedule of TODAY's balance starts at the
  // NEXT payment (shared/loan-facts nextLoanDueDate) — never at the loan's
  // origin. Seeded with today's balance but dated from the first payment 18
  // months back, row 1 read "Mar 31 2025 · 536d overdue" and every payoff
  // figure was shifted by the months already paid (F-08, F-09).
  const scheduleStart = useMemo(
    () => (recurringBill ? null : temporal.nextOccurrence) ?? terms.firstPaymentDate,
    [recurringBill, temporal.nextOccurrence, terms.firstPaymentDate],
  );
  const summary = useMemo(
    () =>
      summarizeLiability({
        currentBalance: terms.currentBalance,
        originalBalance: terms.originalBalance,
        monthlyPayment: terms.monthlyPayment || undefined,
        annualRate: terms.annualRate,
        remainingTermMonths: terms.remainingTermMonths,
        firstPaymentDate: scheduleStart,
      }),
    [terms, scheduleStart],
  );

  const amortization = useMemo(
    () =>
      buildAmortization({
        currentBalance: terms.currentBalance,
        annualInterestRate: terms.annualRate,
        monthlyPayment: terms.monthlyPayment || undefined,
        remainingTermMonths: terms.remainingTermMonths,
        firstPaymentDate: scheduleStart,
      }),
    [terms, scheduleStart],
  );

  // What the record lacks before a payoff can be drawn. Without a payment or a
  // term the engine would assume 360 months — a guess, not this loan.
  const payoffMissing = payoffMissingFields({
    balance: terms.currentBalance,
    rateRaw: readInterestRateRaw(f2),
    monthlyPayment: terms.monthlyPayment,
    remainingTermMonths: terms.remainingTermMonths,
  });

  // Quick payment dialog
  const [paymentDialog, setPaymentDialog] = useState<{
    open: boolean;
    preset: "minimum" | "custom" | "extra" | "interest_only";
    amount: string;
    paymentDate: string;
    notes: string;
  }>({
    open: false,
    preset: "minimum",
    amount: "",
    paymentDate: localTodayISO(),
    notes: "",
  });

  function openPaymentDialog(preset: "minimum" | "custom" | "extra" | "interest_only") {
    let initial = "";
    const monthlyInterest = (terms.currentBalance * terms.annualRate) / 12;
    if (preset === "minimum") initial = (terms.monthlyPayment || summary.monthlyPayment || 0).toFixed(2);
    // Extra principal is the EXTRA money only, on top of the regular payment
    // (recorded separately). It used to prefill payment + $100 and post it as
    // an ordinary payment, so interest was charged on an "extra principal" one.
    else if (preset === "extra") initial = "100.00";
    else if (preset === "interest_only") initial = monthlyInterest.toFixed(2);
    // One key per payment the person sets out to make: minted when the dialog
    // OPENS, so a second tap that lands after the first payment was recorded
    // (the dialog still on screen while it closes) repeats the key and is the
    // same payment. Minting it on success made that tap a second payment
    // (integrity run, 2026-11-27: two taps 300 ms apart on a phone, two rows).
    paymentKeyRef.current = newPaymentKey();
    setPaymentDialog({
      open: true,
      preset,
      amount: initial,
      paymentDate: localTodayISO(),
      notes: "",
    });
  }

  // Reverse a payment. The server's unpay operation puts the principal back on
  // the balance, rolls the due date back and clears the occurrence stamp. This
  // used to follow with a profile PATCH of its own: the page's whole field map
  // (stale by then: it still held the advanced due date the server had just
  // rolled back) plus a balance it computed itself, fees included, though a
  // fee never reduced the balance. Nothing to write here.
  const reversePaymentMutation = useMutation({
    mutationFn: async (payment: LiabilityPayment) => {
      await apiRequest("DELETE", `/api/liability-payments/${payment.id}`);
    },
    onSuccess: () => {
      toast({ title: "Payment reversed" });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not reverse payment",
        description: formatApiError(err),
        variant: "destructive",
      }),
  });

  // The name of the payment being made (L5, I10): kept across a double press,
  // a retry and a tap on the closing dialog; a new one each time the dialog
  // opens for another payment (openPaymentDialog).
  const paymentKeyRef = useRef(newPaymentKey());
  const recordPaymentMutation = useMutation({
    mutationFn: async (input: {
      amount: number;
      paymentDate: string;
      notes?: string;
      paymentType?: "extra_principal";
    }) => {
      // The server owns the principal/interest split AND the resulting balance
      // (single source of truth). We send only the raw payment; the server
      // computes the rest from the liability's balance + APR and updates the
      // profile balance atomically. See POST /api/liabilities/:id/payments.
      // One key per payment the person makes: a double press or a retried
      // request repeats the key (one payment); the next payment gets a new
      // one, so two equal payments a moment apart are two payments.
      const res = await apiRequest("POST", `/api/liabilities/${profile.id}/payments`, {
        paymentDate: input.paymentDate,
        amount: input.amount,
        notes: input.notes || null,
        ...(input.paymentType ? { paymentType: input.paymentType } : {}),
        idempotencyKey: paymentKeyRef.current,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      setPaymentDialog((s) => ({ ...s, open: false }));
    },
    onError: (err: Error) =>
      toast({
        title: "Could not record payment",
        description: formatApiError(err),
        variant: "destructive",
      }),
  });

  function submitPayment() {
    // The dialog already answered (it is closing): a late second tap records nothing.
    if (!paymentDialog.open) return;
    const amt = parseFloat(paymentDialog.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({
        title: "Enter a payment amount",
        description: "Amount must be greater than zero.",
        variant: "destructive",
      });
      return;
    }
    recordPaymentMutation.mutate({
      amount: amt,
      paymentDate: paymentDialog.paymentDate,
      notes: paymentDialog.notes,
      ...(paymentDialog.preset === "extra" ? { paymentType: "extra_principal" as const } : {}),
    });
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  // The Overview is the owner's design (2026-11-22): a flat header, ONE
  // balance card with the liability's live facts, the details as rows, the
  // payoff ring, then Upcoming / Documents / Alerts / Calendar and the actions.
  // Type-aware as the old stat strip was: an amortizing loan shows payoff
  // math, a card its utilization, a recurring bill its amount + due + term.
  // A recurring bill NEVER shows APR/payoff (the $0.17 bug).
  //
  // Everything below is derived from values this page already had (Rule 1):
  // the balance card, the rows and the cards cannot disagree with the tabs.
  const autoPaySave = useAutoPaySave(profile.id);
  // Same keys as <LinkedAssetsCard> and <LiabilityDocumentsCard>, so each is
  // one request however many places read it.
  const assetLinksQuery = useQuery<any[]>({
    queryKey: [`/api/liabilities/${profile.id}/assets`],
    queryFn: async () => (await apiRequest("GET", `/api/liabilities/${profile.id}/assets`)).json(),
    enabled: !!profile.id,
  });
  const [addFieldSignal, setAddFieldSignal] = useState(0);
  // One-shot signals to a section that lives in another tab: "open the asset
  // picker", "open the file chooser". The section clears it once it has acted.
  const [linkAssetSignal, setLinkAssetSignal] = useState(0);
  const [uploadSignal, setUploadSignal] = useState(0);
  const [showLinks, setShowLinks] = useState(false);
  const [expenseDialog, setExpenseDialog] = useState({ open: false, description: "", amount: "", date: "" });
  const [taskDialog, setTaskDialog] = useState({ open: false, title: "", dueDate: "" });
  // The type decides how the page behaves (a loan amortizes, a card revolves,
  // a bill recurs), so it is the stored `type_key` column that changes (L4).
  const changeTypeMutation = useMutation({
    mutationFn: async (typeKey: string) => { await apiRequest("PATCH", `/api/profiles/${profile.id}`, { type_key: typeKey }); },
    onSuccess: (_d, typeKey) => {
      qc.setQueryData(["/api/profiles", profile.id, "detail"], (old: any) => (old && typeof old === "object" ? { ...old, type_key: typeKey } : old));
      qc.invalidateQueries({ queryKey: ["/api/liabilities", profile.id, "schedule"] });
      invalidateDomains("liabilities", "events");
      toast({ title: "Type changed" });
    },
    onError: (err: Error) => toast({ title: "Couldn't change the type", description: formatApiError(err), variant: "destructive" }),
  });
  // Chat edits this same record (update_liability, record payment, Auto Pay):
  // hand it the liability by name so the user only types what they want.
  const askPortol = () => {
    try { sessionStorage.setItem("portol_chat_prefill", `About my ${profile.name || subtypeLabel}: `); } catch { /* the chat simply opens empty */ }
    navigate("/chat");
  };
  const typeChoices = Array.from(new Set([...Object.keys(LIABILITY_TYPE_CHOICES), ...(subtypeRaw ? [subtypeRaw] : [])]));
  const typeLabelOf = (k: string) => LIABILITY_TYPE_CHOICES[k] || SUBTYPE_LABELS[k] || cap(k.replace(/_/g, " "));

  // An expense or a task about this liability, filed under it in one go.
  const addExpenseMutation = useMutation({
    mutationFn: async (v: { description: string; amount: number; date: string }) => {
      await apiRequest("POST", "/api/expenses", { description: v.description, amount: v.amount, date: v.date, category: "other", linkedProfiles: [profile.id] });
    },
    onSuccess: () => {
      toast({ title: "Expense added" });
      invalidateDomains("expenses", "profiles");
      setExpenseDialog((d) => ({ ...d, open: false }));
    },
    onError: (err: Error) => toast({ title: "Couldn't add the expense", description: formatApiError(err), variant: "destructive" }),
  });
  const addTaskMutation = useMutation({
    mutationFn: async (v: { title: string; dueDate: string }) => {
      const res = await apiRequest("POST", "/api/tasks", { title: v.title, priority: "medium", dueDate: v.dueDate || undefined });
      const task = await res.json();
      await apiRequest("POST", `/api/profiles/${profile.id}/link`, { entityType: "task", entityId: task.id });
    },
    onSuccess: () => {
      toast({ title: "Task added" });
      invalidateDomains("tasks", "profiles");
      setTaskDialog((d) => ({ ...d, open: false }));
    },
    onError: (err: Error) => toast({ title: "Couldn't add the task", description: formatApiError(err), variant: "destructive" }),
  });

  // ── Liability Details edits in place ───────────────────────────────────────
  // ONE edit mode for the whole card: the terms (or bill) form, which saves
  // itself (L7), plus the name and notes, written when a field is left and
  // again on Save. Starting never resets a form that is already open.
  const detailsRef = useRef<HTMLElement>(null);
  const editing = recurringBill ? editingBill : editingTerms;
  const startEditing = () => {
    if (!editing) {
      sentNameNotes.current = null;
      setEditName(profile.name || "");
      setEditNotes(String((profile as any).notes || ""));
      if (recurringBill) openBillEditor(); else openTermsEditor();
    }
    setTab("overview");
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
  };
  // What was last sent, so leaving the Notes box and pressing Save (two
  // commits a moment apart) is one write, not two.
  const sentNameNotes = useRef<{ name: string; notes: string } | null>(null);
  const nameNotesWrite = useRef<Promise<void>>(Promise.resolve());
  // Save waits for a write already on its way (L7: Done awaits the pending
  // save), so the card never closes showing the value from before it.
  const commitNameNotes = (): Promise<void> => {
    const base = sentNameNotes.current ?? { name: profile.name || "", notes: String((profile as any).notes || "") };
    const name = editName.trim();
    const changed = (name && name !== base.name) || editNotes !== base.notes;
    if (!changed) return nameNotesWrite.current;
    nameNotesWrite.current = nameNotesWrite.current.then(writeNameNotes);
    return nameNotesWrite.current;
  };
  const writeNameNotes = async () => {
    const base = sentNameNotes.current ?? { name: profile.name || "", notes: String((profile as any).notes || "") };
    const patch: Record<string, string> = {};
    const name = editName.trim();
    if (name && name !== base.name) patch.name = name;
    if (editNotes !== base.notes) patch.notes = editNotes;
    if (Object.keys(patch).length === 0) return;
    sentNameNotes.current = { ...base, ...patch };
    try {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, patch);
      qc.setQueryData(["/api/profiles", profile.id, "detail"], (old: any) => (old && typeof old === "object" ? { ...old, ...patch } : old));
    } catch (err: any) {
      sentNameNotes.current = base;
      toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" });
    }
  };
  const finishEditing = async () => {
    await commitNameNotes();
    if (recurringBill) await closeBillEditor(); else await closeTermsEditor();
  };
  const undoEditing = () => {
    setEditName(profile.name || "");
    setEditNotes(String((profile as any).notes || ""));
    if (recurringBill) undoBillEdits(); else undoTermsEdits();
  };
  const TypeIcon: LucideIcon = SUBTYPE_ICONS[subtypeRaw] || (recurringBill ? Receipt : Landmark);
  const paidOff = !recurringBill && terms.originalBalance > 0 && terms.currentBalance <= 0;
  const autopayOn = schedule ? schedule.autopay === true : isAutoPayOn(f2);

  // Whose debt this is, as a chip. No owner link means it counts toward the
  // person it is filed under — the account holder unless that is someone else.
  const ownerChipLabel = (() => {
    const links = (currentPartyLinks || []) as any[];
    const person = (id: string | undefined) => (ownerCandidates || []).find((p: any) => p.id === id);
    if (links.length === 0) {
      const parent = person((profile as any).parentProfileId);
      return parent && parent.type === "person" && parent.name ? `${parent.name} owes this` : "You owe this";
    }
    if (links.length > 1) return `Shared · ${links.length} people`;
    const owner = person(links[0].partyProfileId || links[0].party?.id) || links[0].party;
    if (!owner || owner.type === "self") return "You owe this";
    return owner.name ? `${owner.name} owes this` : "You owe this";
  })();
  const statusChip: { label: string; accent: string } = recurringBill
    ? seriesComplete ? { label: "Complete", accent: "240 20% 65%" }
      : billHeldLabel ? { label: billHeldLabel, accent: "43 96% 53%" }
      : billStatusEff === "due_today" ? { label: "Due today", accent: "43 96% 53%" }
      : { label: "Active", accent: "155 60% 50%" }
    : paidOff ? { label: "Paid off", accent: "155 60% 50%" } : { label: "Active", accent: "155 60% 50%" };

  // THE next date (L4 / A7): a bill's next occurrence still owed, a loan's
  // payment day counted from today (temporal engine). None when nothing is owed.
  const nextDueISO: string | null = recurringBill
    ? (seriesComplete || billHeldLabel ? null : billNextDueEff)
    : (paidOff ? null : billDueRaw || null);
  const nextDueDays: number | null = (() => {
    const due = parseLocalDate(nextDueISO);
    const today = parseLocalDate(todayISO);
    return due && today ? Math.round((due.getTime() - today.getTime()) / 86400000) : null;
  })();
  const repeats = recurringBill || amortize;
  const payAmount: number = recurringBill
    ? Number(schedule?.amount ?? billMonthly) || 0
    : family === "revolving"
      ? terms.minimumPayment || summary.monthlyPayment || 0
      // The stored payment, or the one the stored TERM implies. With neither,
      // the engine's figure assumes 360 months: a guess, never shown as the
      // loan's payment ("$11.11" on a $4,000 loan with nothing else filled in).
      : terms.monthlyPayment || (amortize && payoffMissing.length === 0 ? summary.monthlyPayment : 0) || 0;
  const cadence = recurringBill ? String(billFrequencyLabel || "monthly").toLowerCase() : "monthly";
  // The day the payment repeats on is the SCHEDULE's day, not the next date's:
  // a bill due on the 31st falls on Feb 28 and is still "every 31st".
  const repeatDay: number | null = (() => {
    if (terms.dueDay) return terms.dueDay;
    const anchor = String(schedule?.firstPayment || nextDueISO || "");
    const d = Number(anchor.slice(8, 10));
    return d >= 1 && d <= 31 ? d : null;
  })();
  const cadenceLabel = !repeats ? "One-time payment"
    : cadence === "monthly" && repeatDay ? `Monthly (every ${ordinal(repeatDay)})` : cap(cadence);
  const repeatsLabel = !repeats ? "One-time"
    : cadence === "monthly" && repeatDay ? `Repeats monthly (on the ${ordinal(repeatDay)})` : `Repeats ${cadence}`;

  const paidDown = Math.max(0, summary.originalBalance - summary.currentBalance);
  const monthYear = (iso?: string | null) => parseLocalDate(iso)?.toLocaleDateString("en-US", { month: "short", year: "numeric" }) || "";
  // When the balance reaches zero, from THIS page's one amortization. Empty
  // when there is nothing honest to say (no rate or payment: the engine would
  // assume 360 months).
  const canProject = amortize && payoffMissing.length === 0 && !summary.neverAmortizes && !summary.beyondHorizon && summary.remainingMonths > 0;
  const payoffText = paidOff ? "Paid off"
    : amortize && payoffMissing.length === 0 && summary.neverAmortizes ? "Never at this payment"
    : amortize && payoffMissing.length === 0 && summary.beyondHorizon ? "Over 50 years at this payment"
    : canProject ? fmtDate(summary.payoffDate) : "";
  const profileNotes = String((profile as any).notes || "");

  // ── Header figures: the four numbers the page is opened for ───────────────
  const RED = "0 78% 62%";
  const GREEN = "155 62% 50%";
  const addValue = <span className="text-cyan-400">+ Add</span>;
  const headerStats: HeroStat[] = recurringBill
    ? [
        { label: "Amount", value: fmtUSDShort(payAmount), accent: RED, testId: "kpi-bill-monthly", onClick: startEditing },
        {
          label: seriesComplete ? "Ended" : "Next due",
          value: nextDueISO ? formatListDate(nextDueISO) || fmtDate(nextDueISO) : seriesComplete ? "Complete" : billHeldLabel ?? addValue,
          accent: nextDueDays != null && nextDueDays < 0 ? RED : nextDueDays === 0 ? "43 96% 53%" : undefined,
          testId: "kpi-bill-due", onClick: startEditing,
        },
        { label: "Frequency", value: cap(cadence), testId: "kpi-bill-frequency", onClick: startEditing },
        {
          label: "Status",
          value: seriesComplete ? "Complete" : billHeldLabel ?? BILL_STATUS_META[billStatusEff].label,
          accent: GREEN, testId: "kpi-bill-status", onClick: () => setTab("payments"),
        },
      ]
    : [
        { label: family === "one_time" ? "Owed" : "Balance", value: fmtUSDShort(summary.currentBalance), accent: RED, testId: "kpi-balance", onClick: startEditing },
        {
          label: family === "revolving" ? "Minimum" : "Payment",
          value: payAmount > 0 ? <>{fmtUSDShort(payAmount)}<span className="text-[0.62em] font-medium opacity-80">/mo</span></> : addValue,
          testId: family === "revolving" ? "kpi-min-payment" : "kpi-monthly", onClick: startEditing,
        },
        { label: "APR", value: summary.annualRate > 0 ? fmtPct(summary.annualRate) : addValue, testId: "kpi-apr", onClick: startEditing },
        family === "revolving" && creditLimit > 0
          ? { label: "Used", value: `${utilizationPct}%`, accent: utilizationPct >= 80 ? RED : GREEN, testId: "kpi-utilization", onClick: startEditing }
          : amortize
            ? {
                label: "Payoff",
                value: paidOff ? "Paid off" : canProject ? monthYear(summary.payoffDate) : payoffText || addValue,
                accent: paidOff || canProject ? GREEN : undefined, testId: "kpi-payoff",
                onClick: () => (canProject ? setTab("cost") : startEditing()),
              }
            : { label: "Next due", value: nextDueISO ? formatListDate(nextDueISO) || fmtDate(nextDueISO) : paidOff ? "Paid off" : addValue, testId: "kpi-next-due", onClick: startEditing },
      ];

  const linkedAssets = (assetLinksQuery.data || [])
    .map((l: any) => (ownerCandidates || []).find((p: any) => p.id === l.assetProfileId))
    .filter(Boolean) as any[];
  const openLinks = (pickAsset = false) => { if (pickAsset) setLinkAssetSignal((n) => n + 1); setShowLinks(true); };
  // A payment marked missed is the alert Auto Pay rules keep raised (A3/A6);
  // it is derived from the occurrence stamps, not stored here (Rule 5).
  const missedPayments = scheduleOccs.filter((o) => o.status === "missed").length;

  // The same actions behind the header's ⋯ and the "+ More" button.
  const moreItems = (
    <>
      <DropdownMenuItem onSelect={() => { setUploadSignal((n) => n + 1); setTab("documents"); }} data-testid="menu-add-document">
        <FileText className="h-4 w-4 mr-2" /> Add document
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { setTab("overview"); setAddFieldSignal((n) => n + 1); }} data-testid="menu-add-characteristic">
        <Plus className="h-4 w-4 mr-2" /> Add characteristic
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => openLinks(false)} data-testid="menu-links">
        <Users className="h-4 w-4 mr-2" /> Owners &amp; linked records
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={askPortol} data-testid="menu-ask-portol">
        <Sparkles className="h-4 w-4 mr-2" /> Ask Portol about this
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => avatarInputRef.current?.click()}>
        <Camera className="h-4 w-4 mr-2" /> Change picture
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {/* Opens the confirmation: deleting takes two taps (Rule 8). */}
      <DropdownMenuItem onSelect={() => setShowDeleteProfileDialog(true)} className="text-destructive focus:text-destructive" data-testid="button-delete-profile">
        <Trash2 className="h-4 w-4 mr-2" /> Delete this liability
      </DropdownMenuItem>
    </>
  );
  const chipCls = "!text-[13px] !px-2.5 !py-1.5 !font-medium";
  const actionBtn = "h-9 gap-1.5 rounded-lg text-[13px] shrink-0";
  const tabCls = "text-[14px] px-3.5 h-9 rounded-lg whitespace-nowrap data-[state=active]:shadow-[inset_0_-2px_0_hsl(155_62%_50%)]";
  const inputCls = "h-9 text-[14px]";

  return (
    <div className="overflow-y-auto h-full pb-24" data-testid="liability-profile-page">
      <div className="px-3 sm:px-4 md:px-6 pt-3 max-w-7xl mx-auto">
        <DetailHero
          testId="liability-header"
          layout="card"
          pageTitle="Liability Profile"
          accent={profileVisual("liability").accent}
          icon={TypeIcon}
          title={
            <button type="button" onClick={startEditing} className="text-left" title="Edit name" data-testid="liability-title">
              {profile.name || subtypeLabel}
            </button>
          }
          stats={headerStats}
          badges={<>
            {/* The type is a menu: choosing one writes the type_key column (L4). */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" title="Change type" data-testid="chip-type">
                  <Pill accent="225 30% 72%" className={chipCls}><TypeIcon className="h-4 w-4" /> {subtypeLabel} <ChevronDown className="h-3.5 w-3.5" /></Pill>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[60dvh] overflow-y-auto">
                {typeChoices.map((k) => (
                  <DropdownMenuItem key={k} disabled={k === subtypeRaw || changeTypeMutation.isPending} onSelect={() => changeTypeMutation.mutate(k)} data-testid={`type-choice-${k}`}>
                    {typeLabelOf(k)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {terms.lender && (
              <button type="button" onClick={startEditing} title="Edit lender" data-testid="chip-lender">
                <Pill accent="225 30% 72%" className={chipCls}>{terms.lender}</Pill>
              </button>
            )}
            <button type="button" onClick={() => openLinks(false)} title="See who owns this debt" data-testid="chip-owner">
              <Pill accent="270 85% 74%" className={chipCls}><User className="h-4 w-4" /> {ownerChipLabel}</Pill>
            </button>
            {statusChip.label !== "Active" && (
              <span data-testid="chip-status">
                <Pill accent={statusChip.accent} className={chipCls}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> {statusChip.label}
                </Pill>
              </span>
            )}
          </>}
          avatar={{
            src: (profile as any).avatar,
            onPick: () => avatarInputRef.current?.click(),
            busy: avatarMutation.isPending,
            inputRef: avatarInputRef,
            onChange: handleAvatarChange,
          }}
          // Back goes to the listing this liability came FROM — the Liabilities
          // tab — not the generic Profiles page, and the label says so. Same
          // treatment assets got (QA report 2026-08-05); a query-carrying
          // backHref keeps the tab param inside the hash route.
          backHref="/linked?tab=liabilities"
          backLabel="Back to Liabilities"
          menu={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="pressable grid h-9 w-9 place-items-center rounded-full hover:bg-foreground/5 transition-colors"
                  aria-label="More actions" data-testid="button-liability-menu">
                  <MoreHorizontal className="h-5 w-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">{moreItems}</DropdownMenuContent>
            </DropdownMenu>
          }
        />
      </div>
      {/* Rule 33: the schedule payload carries the integrity check of the
          stored record; a row still holding two spellings of one fact with
          two values says so here instead of showing whichever won. */}
      {Array.isArray(schedule?.integrity?.warnings) && schedule.integrity.warnings.length > 0 && (
        <div className="px-3 sm:px-4 md:px-6 pt-2 max-w-7xl mx-auto" data-testid="liability-integrity-notice">
          <p className="text-[12px] text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>These records conflict: {schedule.integrity.warnings.map((w: any) => w.message).join("; ")}. Showing the canonical value.</span>
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="px-3 sm:px-4 md:px-6 pt-3 max-w-7xl mx-auto">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} data-testid="liability-tabs">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="overflow-x-auto -mx-1 px-1" style={{ WebkitOverflowScrolling: "touch" as any }}>
              <TabsList className="inline-flex h-auto w-max gap-0.5 p-0 bg-transparent">
                <TabsTrigger value="overview" className={tabCls} data-testid="tab-overview">Overview</TabsTrigger>
                <TabsTrigger value="payments" className={tabCls} data-testid="tab-payments">Payments</TabsTrigger>
                <TabsTrigger value="schedule" className={tabCls} data-testid="tab-schedule">Schedule</TabsTrigger>
                <TabsTrigger value="cost" className={tabCls} data-testid="tab-cost">Cost of Ownership</TabsTrigger>
                <TabsTrigger value="documents" className={tabCls} data-testid="tab-documents">Documents</TabsTrigger>
                <TabsTrigger value="history" className={tabCls} data-testid="tab-history">History</TabsTrigger>
              </TabsList>
            </div>
            {/* What can be added to this liability, one tap each. */}
            <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1 pb-0.5" data-testid="liability-quick-add">
              <Button variant="outline" size="sm" className={actionBtn} onClick={() => openPaymentDialog(recurringBill ? "custom" : "minimum")} data-testid="quick-pay-min">
                <Plus className="h-4 w-4 text-emerald-400" /> Payment
              </Button>
              <Button variant="outline" size="sm" className={actionBtn} onClick={() => setExpenseDialog({ open: true, description: "", amount: "", date: localTodayISO() })} data-testid="button-add-expense">
                <Plus className="h-4 w-4 text-emerald-400" /> Expense
              </Button>
              <Button variant="outline" size="sm" className={actionBtn} onClick={() => setTaskDialog({ open: true, title: "", dueDate: "" })} data-testid="button-add-task">
                <Plus className="h-4 w-4 text-emerald-400" /> Task
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className={actionBtn} data-testid="button-more-actions">
                    <Plus className="h-4 w-4 text-emerald-400" /> More <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[220px]">{moreItems}</DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* OVERVIEW — the owner's design (2026-11-23): the details as a form
              that edits in place, the characteristics the user added, the
              quick figures, and the AI summary beside the balance falling to
              zero. Payments, the schedule and the cost of the debt have their
              own tabs. */}
          <TabsContent value="overview" className="mt-3 space-y-3">
            {missedPayments > 0 && (
              <button type="button" onClick={() => setTab("schedule")} className="bubble w-full px-4 py-2.5 flex items-center gap-2 text-left text-[13px]" style={{ ["--accent-hsl" as any]: RED }} data-testid="missed-payments-notice">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
                <span className="flex-1"><span className="font-semibold text-red-500">{missedPayments} missed payment{missedPayments === 1 ? "" : "s"}.</span> Review the schedule.</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            )}

            <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {/* LIABILITY DETAILS — read as the fields they become; Edit (or a
                  tap on any value) turns them into inputs that save themselves
                  (L7). Save finishes: it waits for the pending save. */}
              <section
                ref={detailsRef}
                className="bubble p-4 scroll-mt-3"
                data-testid={recurringBill && editing ? "bill-details-edit-card" : "liability-details-card"}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3 min-h-8">
                  <h2 className="text-[16px] font-semibold tracking-tight">Liability Details</h2>
                  <div className="flex items-center gap-2">
                    {editing && (
                      <span className="text-[12px] text-muted-foreground" role="status" aria-live="polite" data-testid={recurringBill ? "bill-autosave-status" : "terms-autosave-status"}>
                        {autosaveStatusLabel(recurringBill ? billAutosave.status : termsAutosave.status)}
                      </span>
                    )}
                    {editing ? (
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-[13px] rounded-lg" onClick={undoEditing}
                        disabled={!(recurringBill ? billAutosave.changedSinceOpen : termsAutosave.changedSinceOpen)}
                        title="Put every field back to what it was when you started editing"
                        data-testid={recurringBill ? "button-undo-bill-edits" : "button-undo-terms-edits"}>
                        <RotateCcw className="h-3.5 w-3.5" /> Undo
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-[13px] rounded-lg" onClick={startEditing} data-testid={recurringBill ? "button-edit-bill" : "button-edit-terms"}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                    )}
                    <Button size="sm" className="h-8 gap-1 text-[13px] rounded-lg bg-emerald-500 text-white hover:bg-emerald-500/90 disabled:opacity-40"
                      onClick={() => void finishEditing()} disabled={!editing} data-testid={recurringBill ? "button-save-bill" : "button-save-terms"}>
                      <Check className="h-3.5 w-3.5" /> Save
                    </Button>
                  </div>
                </div>

                <FieldGrid testId="liability-details-fields">
                  <FieldRow icon={FileText} label="Name" wide htmlFor="liability-name">
                    {editing
                      ? <Input id="liability-name" className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} onBlur={() => void commitNameNotes()} maxLength={120} data-testid="input-edit-name" />
                      : <ReadValue value={profile.name} onClick={startEditing} actionLabel="Edit name" testId="detail-name" />}
                  </FieldRow>
                  <FieldRow icon={TypeIcon} label="Type" wide>
                    <Select value={subtypeRaw || undefined} onValueChange={(k) => { if (k !== subtypeRaw) changeTypeMutation.mutate(k); }} disabled={changeTypeMutation.isPending}>
                      <SelectTrigger className={inputCls} data-testid="select-liability-type"><SelectValue placeholder="Choose a type" /></SelectTrigger>
                      <SelectContent>
                        {typeChoices.map((k) => <SelectItem key={k} value={k}>{typeLabelOf(k)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FieldRow>

                  {recurringBill ? (<>
                    <FieldRow icon={Wallet} label="Amount" htmlFor="bill-amount">
                      {editing
                        ? <Input id="bill-amount" className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={bAmount} onChange={(e) => setBAmount(e.target.value)} placeholder="e.g. 14.99" data-testid="input-bill-amount" />
                        : <ReadValue value={payAmount > 0 ? fmtUSD(payAmount) : ""} onClick={startEditing} actionLabel="Edit amount" testId="detail-amount" />}
                    </FieldRow>
                    <FieldRow icon={RefreshCw} label="Frequency">
                      {editing ? (
                        // Only cadences the recurrence engine understands
                        // (shared/recurrence freqToUnit): an unsupported token
                        // collapses the series to one occurrence. The bill's
                        // own current value stays selectable so opening the
                        // form can never rewrite a cadence by itself.
                        <Select value={bFrequency} onValueChange={setBFrequency}>
                          <SelectTrigger className={inputCls} data-testid="select-bill-frequency"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Array.from(new Set([...BILL_FREQUENCIES, bFrequency].filter(Boolean))).map((fr) => (
                              <SelectItem key={fr} value={fr} className="capitalize">{cap(fr)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : <ReadValue value={cap(cadence)} onClick={startEditing} actionLabel="Edit frequency" testId="detail-frequency" />}
                    </FieldRow>
                    <FieldRow icon={CalendarIcon} label="Payment Date" htmlFor="bill-due">
                      {editing
                        // Moves the whole series. One payment only is moved on
                        // its date in the Schedule tab.
                        ? <Input id="bill-due" className={inputCls} type="date" value={bDueDate} onChange={(e) => setBDueDate(e.target.value)} title="Moves the whole series" data-testid="input-bill-due-date" />
                        : <ReadValue value={nextDueISO ? fmtDate(nextDueISO) : seriesComplete ? "Complete" : billHeldLabel ?? ""} onClick={startEditing} actionLabel="Edit payment date" testId="detail-next-due" />}
                    </FieldRow>
                    <FieldRow icon={Layers} label="Term" htmlFor="bill-count">
                      {editing
                        ? <Input id="bill-count" className={inputCls} type="number" inputMode="numeric" min={1} value={bCount} onChange={(e) => setBCount(e.target.value)} placeholder="Blank = ongoing" data-testid="input-bill-count" />
                        : <ReadValue value={billTotalTerm != null ? `${billRemainingTerm ?? billTotalTerm} of ${billTotalTerm} left` : "Ongoing"} onClick={startEditing} actionLabel="Edit number of payments" testId="detail-term" />}
                    </FieldRow>
                    <FieldRow icon={Flag} label="Ends On" htmlFor="bill-end">
                      {editing
                        ? <Input id="bill-end" className={inputCls} type="date" value={bEnd} onChange={(e) => setBEnd(e.target.value)} title="Blank = no end date" data-testid="input-bill-end" />
                        : <ReadValue value={schedule?.recurrenceEnd ? fmtDate(schedule.recurrenceEnd) : "No end date"} onClick={startEditing} actionLabel="Edit end date" testId="detail-end" />}
                    </FieldRow>
                    <FieldRow icon={Bell} label="Reminder" htmlFor="bill-reminder">
                      {editing
                        ? <Input id="bill-reminder" className={inputCls} type="number" inputMode="numeric" min={0} value={bReminder} onChange={(e) => setBReminder(e.target.value)} placeholder="Days before" data-testid="input-bill-reminder" />
                        : <ReadValue value={billReminderLead != null ? `${billReminderLead} day${billReminderLead === 1 ? "" : "s"} before` : ""} onClick={startEditing} actionLabel="Edit reminder" testId="detail-reminder" />}
                    </FieldRow>
                  </>) : (<>
                    <FieldRow icon={Landmark} label="Lender" wide htmlFor="terms-lender">
                      {editing
                        ? <Input id="terms-lender" className={inputCls} value={tLender} onChange={(e) => setTLender(e.target.value)} placeholder="e.g. Chase Auto" data-testid="input-terms-lender" />
                        : <ReadValue value={terms.lender} onClick={startEditing} actionLabel="Edit lender" testId="detail-lender" />}
                    </FieldRow>
                    <FieldRow icon={Layers} label="Original Amount" htmlFor="terms-original">
                      {editing
                        ? <Input id="terms-original" className={inputCls} type="number" inputMode="decimal" step="0.01" value={tOriginal} onChange={(e) => setTOriginal(e.target.value)} placeholder="e.g. 35000" data-testid="input-terms-original" />
                        : <ReadValue value={terms.originalBalance > 0 ? fmtUSDShort(terms.originalBalance) : ""} onClick={startEditing} actionLabel="Edit original amount" testId="detail-original" />}
                    </FieldRow>
                    <FieldRow icon={Wallet} label="Current Balance" htmlFor="terms-balance">
                      {editing
                        ? <Input id="terms-balance" className={inputCls} type="number" inputMode="decimal" step="0.01" value={tBalance} onChange={(e) => setTBalance(e.target.value)} placeholder="e.g. 25000" data-testid="input-terms-balance" />
                        : <ReadValue value={fmtUSDShort(terms.currentBalance)} onClick={startEditing} actionLabel="Edit current balance" testId="detail-balance" />}
                    </FieldRow>
                    <FieldRow icon={Percent} label="APR (Interest)" htmlFor="terms-rate">
                      {editing
                        ? <Input id="terms-rate" className={inputCls} type="number" inputMode="decimal" step="0.01" value={tRate} onChange={(e) => setTRate(e.target.value)} placeholder="% e.g. 6.5" data-testid="input-terms-rate" />
                        : <ReadValue value={summary.annualRate > 0 ? fmtPct(summary.annualRate) : ""} onClick={startEditing} actionLabel="Edit interest rate" testId="detail-rate" />}
                    </FieldRow>
                    <FieldRow icon={Clock} label="Term (months)" htmlFor="terms-term">
                      {editing
                        ? <Input id="terms-term" className={inputCls} type="number" inputMode="numeric" value={tTerm} onChange={(e) => setTTerm(e.target.value)} placeholder="e.g. 60" data-testid="input-terms-term" />
                        : <ReadValue value={terms.remainingTermMonths ? `${terms.remainingTermMonths} months` : ""} onClick={startEditing} actionLabel="Edit term" testId="detail-term" />}
                    </FieldRow>
                    <FieldRow icon={CreditCard} label={family === "revolving" ? "Min. Payment" : "Monthly Payment"} htmlFor="terms-monthly">
                      {editing
                        ? <Input id="terms-monthly" className={inputCls} type="number" inputMode="decimal" step="0.01" value={tMonthly} onChange={(e) => setTMonthly(e.target.value)} placeholder="e.g. 440" data-testid="input-terms-monthly" />
                        : <ReadValue value={payAmount > 0 ? fmtUSD(payAmount) : ""} onClick={startEditing} actionLabel="Edit payment" testId="detail-payment" />}
                    </FieldRow>
                    <FieldRow icon={CalendarIcon} label="Due Day" htmlFor="terms-due-day">
                      {editing
                        // A day of the month and a payment put this loan on the calendar.
                        ? <Input id="terms-due-day" className={inputCls} type="number" inputMode="numeric" min={1} max={31} value={tDueDay} onChange={(e) => setTDueDay(e.target.value)} placeholder="1–31" data-testid="input-terms-due-day" />
                        : <ReadValue value={terms.dueDay ? ordinal(terms.dueDay) : ""} onClick={startEditing} actionLabel="Edit due day" testId="detail-due-day" />}
                    </FieldRow>
                    <FieldRow icon={CalendarIcon} label="Start Date" htmlFor="terms-first-payment">
                      {editing
                        ? <Input id="terms-first-payment" className={inputCls} type="date" value={tFirstPayment} onChange={(e) => setTFirstPayment(e.target.value)} data-testid="input-terms-first-payment" />
                        : <ReadValue value={terms.firstPaymentDate ? fmtDate(terms.firstPaymentDate) : ""} onClick={startEditing} actionLabel="Edit start date" testId="detail-start" />}
                    </FieldRow>
                    <FieldRow icon={Flag} label="Payoff Date">
                      {/* Calculated from the balance, rate and payment above —
                          it changes when they do, so it has no input of its own. */}
                      {payoffText
                        ? <ReadValue value={payoffText} onClick={canProject ? () => setTab("cost") : undefined} actionLabel="See the payoff schedule" testId="detail-payoff" />
                        : <ReadValue value="" onClick={startEditing} actionLabel="Add a rate and a payment to project the payoff" testId="detail-payoff" />}
                    </FieldRow>
                  </>)}

                  <FieldRow icon={Shield} label="Autopay" wide>
                    <div className="flex items-center gap-2.5 min-h-9">
                      {recurringBill && editing ? (
                        <Switch checked={bAutopay} onCheckedChange={setBAutopay} aria-label="Autopay" className="data-[state=checked]:bg-emerald-500" data-testid="switch-bill-autopay" />
                      ) : (
                        <Switch checked={autopayOn} disabled={autoPaySave.isPending || !schedule} onCheckedChange={(enabled) => autoPaySave.mutate({ enabled })}
                          aria-label="Autopay" className="data-[state=checked]:bg-emerald-500" data-testid="switch-autopay-hero" />
                      )}
                      <span className="text-[13px] leading-snug" data-testid="hero-autopay-state">
                        {(recurringBill && editing ? bAutopay : autopayOn)
                          ? (recurringBill ? "Automatically record each payment" : "Automatically record payment & expense")
                          : "Off: you record each payment yourself"}
                      </span>
                      <span title="When Autopay is on, Portol records the payment on its due date (shown as Assumed paid until confirmed) and stops due-date reminders." className="text-muted-foreground"><Info className="h-4 w-4" /></span>
                    </div>
                  </FieldRow>
                  <FieldRow icon={FileText} label="Notes" wide alignTop htmlFor="liability-notes">
                    {editing ? (
                      <div className="relative">
                        <Textarea id="liability-notes" value={editNotes} onChange={(e) => setEditNotes(e.target.value.slice(0, 500))} onBlur={() => void commitNameNotes()} rows={2} className="text-[14px] pr-14" data-testid="input-edit-notes" />
                        <span className="absolute bottom-1.5 right-2 text-[11px] text-muted-foreground tabular-nums">{editNotes.length}/500</span>
                      </div>
                    ) : <ReadValue value={profileNotes.trim()} onClick={startEditing} actionLabel="Edit notes" testId="detail-notes" multiline />}
                  </FieldRow>
                </FieldGrid>
              </section>

              <div className="space-y-3 min-w-0">
                {/* CHARACTERISTICS — anything the form has no box for. The same
                    Field | Value | Add as every profile (D7/D8): each line can
                    be changed (pencil) or removed (X, two taps). */}
                <Panel
                  title="Characteristics"
                  testId="characteristics-card"
                  actions={
                    <Button variant="outline" size="sm" className="h-8 gap-1 text-[13px] rounded-lg border-emerald-500/60 text-emerald-400 hover:text-emerald-300" onClick={() => setAddFieldSignal((n) => n + 1)} data-testid="add-field-button">
                      <Plus className="h-3.5 w-3.5" /> Add Characteristic
                    </Button>
                  }
                >
                  <AddFieldPanel
                    profileId={profile.id} fields={profile.fields} showFields hideHeader list openSignal={addFieldSignal}
                    leading={
                      <InfoRow
                        icon={SUBTYPE_ICONS[subtypeRaw] === Car ? Car : Link2}
                        label="Linked asset"
                        testId="detail-row-linked-asset"
                        // A failed request is not "none linked" (Rule 7).
                        value={assetLinksQuery.isError ? "Couldn't load"
                          : !assetLinksQuery.data ? "Loading…"
                          : linkedAssets.length === 0
                            ? <button type="button" className="font-semibold text-cyan-400" onClick={() => openLinks(true)} data-testid="link-asset-add">+ Add</button>
                            : linkedAssets.map((a) => a.name).join(", ")}
                        onEdit={() => openLinks(!!assetLinksQuery.data && linkedAssets.length === 0)}
                        editLabel={linkedAssets.length === 0 ? "Link an asset" : "Manage linked assets"}
                      />
                    }
                  />
                  <DetailValueCells entityType="profile" entityId={profile.id} className="grid grid-cols-2 gap-2 mt-2" />
                </Panel>

                {/* QUICK INFO — figures the page works out; the pencil opens
                    the terms they are worked out from. */}
                <Panel title="Quick Info" testId="quick-info-card">
                  <InfoList>
                    <InfoRow
                      icon={CalendarIcon} label="Next Due" testId="quick-next-due"
                      value={nextDueISO ? `${fmtDate(nextDueISO)}${nextDueDays != null ? ` · ${dayLabel(nextDueDays)}` : ""}` : paidOff ? "Paid off" : seriesComplete ? "Complete" : billHeldLabel ?? addValue}
                      tone={nextDueDays != null && nextDueDays < 0 ? "danger" : undefined}
                      onEdit={startEditing} editLabel="Edit the payment day"
                    />
                    {recurringBill ? (<>
                      <InfoRow icon={ActivityIcon} label="Payment Status" testId="quick-status"
                        value={seriesComplete ? "Complete" : billHeldLabel ?? BILL_STATUS_META[billStatusEff].label}
                        onEdit={() => setTab("schedule")} editLabel="Open the schedule" />
                      <InfoRow icon={Check} label="Payments Made" testId="quick-paid" value={String(billPaidCount)} onEdit={() => setTab("payments")} editLabel="Open payments" />
                      <InfoRow icon={Layers} label="Yearly Total" testId="quick-annual" value={schedule?.annualTotal != null ? fmtUSD(schedule.annualTotal) : schedule ? addValue : "Loading…"} onEdit={startEditing} editLabel="Edit the amount" />
                    </>) : (<>
                      <InfoRow icon={Clock} label="Remaining Term" testId="quick-remaining-term"
                        value={paidOff ? "Paid off" : canProject ? `${summary.remainingMonths} month${summary.remainingMonths === 1 ? "" : "s"}` : payoffText || addValue}
                        onEdit={startEditing} editLabel="Edit the terms" />
                      <InfoRow icon={Percent} label="Interest Left (Est.)" testId="quick-interest"
                        value={canProject ? fmtUSDShort(Math.round(summary.totalRemainingInterest)) : paidOff ? fmtUSDShort(0) : payoffText || addValue}
                        onEdit={startEditing} editLabel="Edit the terms" />
                      <InfoRow icon={Layers} label="Left to Pay (Est.)" testId="quick-total"
                        value={canProject ? fmtUSDShort(Math.round(summary.currentBalance + summary.totalRemainingInterest)) : paidOff ? fmtUSDShort(0) : payoffText || addValue}
                        onEdit={startEditing} editLabel="Edit the terms" />
                    </>)}
                  </InfoList>
                </Panel>
              </div>
            </div>

            {/* The AI summary draws nothing until it has one; the card beside
                it then takes the row (`only:`), so there is never a hole. */}
            <div className="grid gap-3 lg:grid-cols-2 [&>*:only-child]:lg:col-span-2">
              <AISummaryCard profileId={profile.id} valueFingerprint={profileValueFingerprint(profile)} />

              {recurringBill ? (
                <Panel title="Next Payment" testId="next-payment-card"
                  actions={<Button variant="outline" size="sm" className="h-8 text-[13px] rounded-lg" onClick={() => setTab("schedule")} data-testid="button-open-schedule">Open schedule</Button>}>
                  <FigureRow label="Date" value={nextDueISO ? fmtDate(nextDueISO) : seriesComplete ? "Complete" : billHeldLabel ?? "Not scheduled"} testId="next-payment-date" />
                  <FigureRow label="Amount" value={payAmount > 0 ? fmtUSD(payAmount) : "Not set"} tone="danger" />
                  <FigureRow label="Repeats" value={repeatsLabel.replace(/^Repeats /, "").replace(/^./, (c) => c.toUpperCase())} />
                  <FigureRow label="Autopay" value={autopayOn ? "On" : "Off"} tone={autopayOn ? "good" : undefined} />
                </Panel>
              ) : (
                <Panel title="Balance & Payoff" testId="balance-payoff-card">
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                    {canProject ? (
                      <PayoffLine
                        balances={[summary.currentBalance, ...amortization.rows.map((r) => r.remainingBalance)]}
                        label={`Balance falling from ${fmtUSDShort(summary.currentBalance)} to zero by ${fmtDate(summary.payoffDate)}`}
                      />
                    ) : (
                      <div className="text-[13px] text-muted-foreground" data-testid="payoff-line-missing">
                        {paidOff ? "This debt is paid off."
                          : payoffText ? "The payment does not cover the monthly interest, so the balance never falls."
                          : <>Add {payoffMissing.length > 0 ? payoffMissing.join(" and ") : "a rate and a payment"} to see the balance fall to zero.
                            <button type="button" onClick={startEditing} className="ml-1 font-semibold text-cyan-400">+ Add</button></>}
                      </div>
                    )}
                    <div>
                      <FigureRow label="Current Balance" value={fmtUSDShort(summary.currentBalance)} tone="danger" />
                      <FigureRow label="Original Amount" value={summary.originalBalance > 0 ? fmtUSDShort(summary.originalBalance) : "Not set"} />
                      {summary.originalBalance > 0 && <FigureRow label="Paid Down" value={`${fmtUSDShort(paidDown)} · ${summary.payoffProgressPct.toFixed(1)}%`} testId="paid-down" />}
                      <FigureRow label="Interest Left (Est.)" value={canProject ? fmtUSDShort(Math.round(summary.totalRemainingInterest)) : "Not projected"} />
                      <FigureRow label="Payoff (Est.)" value={payoffText || "Not projected"} tone={paidOff || canProject ? "good" : undefined} testId="payoff-est" />
                    </div>
                  </div>
                </Panel>
              )}
            </div>
          </TabsContent>

          {/* PAYMENTS — what has been paid, and recording one. Auto Pay is
              the setting that records them by itself. */}
          <TabsContent value="payments" className="mt-3 space-y-4">
            {/* Auto Pay: every liability has the setting. On = payments are
                recorded on their due date (assumed until confirmed) and no
                reminders are raised. */}
            <AutoPaySection liabilityId={profile.id} />

            {/* Payment mechanics belong to DEBT (amortizing / one-time), not
                recurring bills: a bill pays through its schedule above. */}
            {!recurringBill && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Quick actions</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <QuickActionButton
                    label="Pay minimum"
                    hint={fmtUSD(terms.monthlyPayment || summary.monthlyPayment)}
                    onClick={() => openPaymentDialog("minimum")}
                    testid="action-min"
                  />
                  <QuickActionButton
                    label="Pay custom"
                    hint="Choose amount"
                    onClick={() => openPaymentDialog("custom")}
                    testid="action-custom"
                  />
                  <QuickActionButton
                    label="Extra principal"
                    hint="+$100"
                    onClick={() => openPaymentDialog("extra")}
                    testid="action-extra"
                  />
                  <QuickActionButton
                    label="Interest only"
                    hint={fmtUSD((terms.currentBalance * terms.annualRate) / 12)}
                    onClick={() => openPaymentDialog("interest_only")}
                    testid="action-interest"
                  />
                </CardContent>
              </Card>
            )}

            {/* Payment history */}
            <div className="space-y-3">
              <p className="micro-label text-muted-foreground px-0.5">Payment History</p>
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {payments.length} payment{payments.length === 1 ? "" : "s"} on record
                </div>
                <Button size="sm" onClick={() => openPaymentDialog("custom")} data-testid="payments-add">
                  <Plus className="w-4 h-4 mr-1" />
                  Record payment
                </Button>
              </div>
              <Card>
                <CardContent className="p-0">
                  {paymentsQuery.isLoading ? (
                    <div className="p-4 space-y-2">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : payments.length === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground" data-testid="payments-empty">
                      No payments recorded yet.
                    </div>
                  ) : (
                    <div className="divide-y" data-testid="payments-list">
                      {payments.map((p) => (
                        <PaymentRow
                          key={p.id}
                          p={p}
                          expanded
                          onReverse={() => reversePaymentMutation.mutate(p)}
                          reversing={reversePaymentMutation.isPending}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* SCHEDULE — what is still owed and when (owner's design,
              2026-11-23: its own tab): every date with Pay / Skip /
              Reschedule on it, then the amortization table for a loan. */}
          <TabsContent value="schedule" className="mt-3 space-y-4">
            <BillScheduleSection liabilityId={profile.id} />

            {/* Amortization Schedule (amortizing debt only) */}
            {amortize && (
            <div>
              <p className="micro-label text-muted-foreground mb-3 px-0.5">Amortization Schedule</p>
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Amortization schedule</CardTitle>
                  <div className="text-xs text-muted-foreground">
                    {amortization.neverAmortizes
                      ? "the payment does not cover the monthly interest — the balance never falls"
                      : amortization.beyondHorizon
                      ? `the first ${amortization.rows.length} payments (50 years) — at this payment the balance is not paid off within them`
                      : <>{amortization.rows.length} period{amortization.rows.length === 1 ? "" : "s"} · total interest {fmtUSD(amortization.totalInterest)}</>}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {amortization.rows.length === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground" data-testid="amort-empty">
                      No schedule available — set a balance, rate, and either a monthly payment or a remaining term.
                    </div>
                  ) : (
                    <div className="overflow-x-auto" data-testid="amort-table">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium">#</th>
                            <th className="text-left px-3 py-2 font-medium">Due</th>
                            <th className="text-right px-3 py-2 font-medium">Payment</th>
                            <th className="text-right px-3 py-2 font-medium">Principal</th>
                            <th className="text-right px-3 py-2 font-medium">Interest</th>
                            <th className="text-right px-3 py-2 font-medium">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {amortization.rows.map((r) => (
                            <AmortRow key={r.paymentNumber} row={r} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
            )}
          </TabsContent>

          {/* COST OF OWNERSHIP — what this debt costs: the payoff outlook, the
              interest paid and left, and what paying extra would save. A
              recurring bill has no payoff; it shows what it adds up to. */}
          <TabsContent value="cost" className="mt-3 space-y-4">
            {/* Payoff outlook — the balance falling to zero and the
                principal/interest split, drawn from THIS page's summary +
                amortization (one schedule), so it can never disagree with the
                balance card or the table. A record missing balance, rate or
                payment gets a one-line note instead of a guess. */}
            {amortize && !recurringBill && (
              <PayoffOutlook summary={summary} amortization={amortization} todayISO={todayISO} missing={payoffMissing} />
            )}

            {!recurringBill && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Cost of borrowing</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Remaining interest"
                    value={summary.neverAmortizes ? "Never pays off at this payment" : summary.beyondHorizon ? "Not paid off within 50 years at this payment" : fmtUSD(summary.totalRemainingInterest)} />
                  <Row label="Interest paid (history)"
                    value={fmtUSD(interestPaidToDate)} />
                  <Row label="Total payments made"
                    value={fmtUSD(paymentsTotal)} />
                  <Row label="Original balance"
                    value={summary.originalBalance ? fmtUSD(summary.originalBalance) : "—"} />
                </CardContent>
              </Card>
            )}

            {/* Payoff Calculator — only for amortizing/revolving debt.
                Recurring bills + generic one-time debt don't have a payoff
                schedule; showing one produced the $0.17/360-month nonsense. */}
            {amortize && (
            <div>
              <p className="micro-label text-muted-foreground mb-3 px-0.5">Payoff Calculator</p>
              <PayoffCalculator terms={terms} baseSummary={summary} />
            </div>
            )}
            {recurringBill && (
              <Card data-testid="bill-cost-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">What this bill costs</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Each payment" value={fmtUSD(payAmount)} />
                  <Row label="Per year" value={schedule?.annualTotal != null ? fmtUSD(schedule.annualTotal) : "Not set"} />
                  <Row label="Paid so far" value={fmtUSD(paymentsTotal)} />
                  <Row label="Payments made" value={String(billPaidCount)} />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* DOCUMENTS */}
          <TabsContent value="documents" className="mt-3">
            <LiabilityDocumentsCard liabilityId={profile.id} liabilityName={profile.name} openSignal={uploadSignal} onOpened={() => setUploadSignal(0)} />
          </TabsContent>

          {/* HISTORY — what happened to this liability (payments and events),
              then every change made to the record. */}
          <TabsContent value="history" className="mt-3 space-y-4 px-1 sm:px-0">
            <ActivityTimelineCard
              profileId={profile.id}
              payments={payments}
            />
            <HistoryTab profileId={profile.id} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Owners, linked assets and people, nested debts and the composed
          facts: reached from the owner chip and the More menu. */}
      <Dialog open={showLinks} onOpenChange={setShowLinks}>
        <DialogContent className="max-w-2xl max-h-[88dvh] overflow-y-auto" data-testid="dialog-links">
          <DialogHeader>
            <DialogTitle>Owners &amp; linked records</DialogTitle>
            <DialogDescription>Who owes this, what secures it, and what is filed under it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <section data-testid="overview-linked-assets">
              <p className="micro-label text-muted-foreground mb-2 px-0.5">Linked assets</p>
              <LinkedAssetsCard liabilityId={profile.id} openSignal={linkAssetSignal} onOpened={() => setLinkAssetSignal(0)} />
            </section>
            {/* Ownership — fractional owner shares, atomic + validated
                (PUT /api/profiles/:id/liability-owners replaces the whole set
                and validates total=100). */}
            <section data-testid="overview-ownership">
              <OwnershipEditor
                profile={profile as any}
                allProfiles={(ownerCandidates || []) as any}
                onSaved={() => { /* React Query invalidations handled inside OwnershipEditor */ }}
                kind="liability"
              />
            </section>
            {/* Linked people — non-owner roles (co_signer, guarantor, etc.). */}
            <section data-testid="overview-linked-people">
              <p className="micro-label text-muted-foreground mb-2 px-0.5">Linked people</p>
              <LinkedPeopleTab
                profileId={profile.id}
                profileType={profile.type}
                onChanged={() => { /* React Query invalidations handled inside */ }}
              />
            </section>
            <section>
              <p className="micro-label text-muted-foreground mb-2 px-0.5">Nested Liabilities</p>
              <NestedLiabilitiesCard liabilityId={profile.id} />
            </section>
            {/* Composed facts — what this liability IS decides what shows
                here (utilization, linked collateral, escrow, rate, dates). */}
            <DynamicOverview profileId={profile.id} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={expenseDialog.open} onOpenChange={(o) => setExpenseDialog((d) => ({ ...d, open: o }))}>
        <DialogContent data-testid="dialog-liability-expense">
          <DialogHeader>
            <DialogTitle>Add expense</DialogTitle>
            <DialogDescription>A cost tied to {profile.name}: a fee, insurance, a repair. A payment on the debt itself is recorded with Payment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="liability-expense-desc">What was it for</Label>
              <Input id="liability-expense-desc" value={expenseDialog.description} onChange={(e) => setExpenseDialog((d) => ({ ...d, description: e.target.value }))} placeholder="e.g. Late fee" data-testid="input-liability-expense-desc" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="liability-expense-amount">Amount</Label>
                <Input id="liability-expense-amount" type="number" inputMode="decimal" step="0.01" min="0" value={expenseDialog.amount} onChange={(e) => setExpenseDialog((d) => ({ ...d, amount: e.target.value }))} data-testid="input-liability-expense-amount" />
              </div>
              <div>
                <Label htmlFor="liability-expense-date">Date</Label>
                <Input id="liability-expense-date" type="date" value={expenseDialog.date} onChange={(e) => setExpenseDialog((d) => ({ ...d, date: e.target.value }))} data-testid="input-liability-expense-date" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExpenseDialog((d) => ({ ...d, open: false }))}>Cancel</Button>
            <Button
              disabled={addExpenseMutation.isPending || !expenseDialog.description.trim() || !(Number(expenseDialog.amount) > 0) || !expenseDialog.date}
              onClick={() => addExpenseMutation.mutate({ description: expenseDialog.description.trim(), amount: Number(expenseDialog.amount), date: expenseDialog.date })}
              data-testid="button-save-liability-expense"
            >
              {addExpenseMutation.isPending ? "Adding…" : "Add expense"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={taskDialog.open} onOpenChange={(o) => setTaskDialog((d) => ({ ...d, open: o }))}>
        <DialogContent data-testid="dialog-liability-task">
          <DialogHeader>
            <DialogTitle>Add task</DialogTitle>
            <DialogDescription>Something to do about {profile.name}. It shows on your task list, linked to this liability.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="liability-task-title">Task</Label>
              <Input id="liability-task-title" value={taskDialog.title} onChange={(e) => setTaskDialog((d) => ({ ...d, title: e.target.value }))} placeholder="e.g. Call about refinancing" data-testid="input-liability-task-title" />
            </div>
            <div>
              <Label htmlFor="liability-task-due">Due (optional)</Label>
              <Input id="liability-task-due" type="date" value={taskDialog.dueDate} onChange={(e) => setTaskDialog((d) => ({ ...d, dueDate: e.target.value }))} data-testid="input-liability-task-due" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTaskDialog((d) => ({ ...d, open: false }))}>Cancel</Button>
            <Button disabled={addTaskMutation.isPending || !taskDialog.title.trim()} onClick={() => addTaskMutation.mutate({ title: taskDialog.title.trim(), dueDate: taskDialog.dueDate })} data-testid="button-save-liability-task">
              {addTaskMutation.isPending ? "Adding…" : "Add task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick payment dialog */}
      {/* U3: when the dialog closes, reset state to defaults so the next open
         doesn't show stale amount/date/notes from the previous attempt. We
         keep the preset stable across closes since it's set by the opener. */}
      <Dialog open={paymentDialog.open} onOpenChange={(o) => setPaymentDialog((s) => o ? { ...s, open: o } : {
        open: false,
        preset: s.preset,
        amount: "",
        paymentDate: localTodayISO(),
        notes: "",
      })}>
        <DialogContent data-testid="payment-dialog">
          <DialogHeader>
            <DialogTitle>
              {paymentDialog.preset === "minimum"
                ? "Pay minimum"
                : paymentDialog.preset === "extra"
                ? "Pay extra principal"
                : paymentDialog.preset === "interest_only"
                ? "Pay interest only"
                : "Record payment"}
            </DialogTitle>
            <DialogDescription>
              We'll split this payment into interest and principal automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="liability-payment-amount">Amount</Label>
              {/* U4: min=0 prevents negative input at the browser level
                 U10: max=999999999 prevents the JS-Number precision loss
                 that starts around 1e16 */}
              <Input
                id="liability-payment-amount"
                type="number"
                step="0.01"
                min="0"
                max="999999999"
                value={paymentDialog.amount}
                onChange={(e) => setPaymentDialog((s) => ({ ...s, amount: e.target.value }))}
                data-testid="payment-amount-input"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Estimated split: {(() => {
                  const amt = parseFloat(paymentDialog.amount) || 0;
                  // Mirrors the server's rule: extra principal carries no interest,
                  // and a month's interest is charged once.
                  const noInterest = paymentDialog.preset === "extra" || interestChargedInMonth(payments, paymentDialog.paymentDate);
                  const split = allocatePayment(amt, terms.currentBalance, noInterest ? 0 : terms.annualRate, 0);
                  return `${fmtUSD(split.principal)} principal · ${fmtUSD(split.interest)} interest`;
                })()}
              </p>
            </div>
            <div>
              <Label htmlFor="liability-payment-date">Date</Label>
              <Input
                id="liability-payment-date"
                type="date"
                value={paymentDialog.paymentDate}
                onChange={(e) => setPaymentDialog((s) => ({ ...s, paymentDate: e.target.value }))}
                data-testid="payment-date-input"
              />
            </div>
            <div>
              <Label htmlFor="liability-payment-notes">Notes (optional)</Label>
              <Input
                id="liability-payment-notes"
                value={paymentDialog.notes}
                onChange={(e) => setPaymentDialog((s) => ({ ...s, notes: e.target.value }))}
                placeholder="e.g. paid via Chase auto-pay"
                data-testid="payment-notes-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPaymentDialog((s) => ({ ...s, open: false }))}>
              Cancel
            </Button>
            <Button onClick={submitPayment} disabled={recordPaymentMutation.isPending} data-testid="payment-submit">
              {recordPaymentMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Record payment"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteProfileDialog} onOpenChange={setShowDeleteProfileDialog}>
        <AlertDialogContent data-testid="dialog-confirm-delete-profile">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{profile.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the liability and everything scheduled for it. Payments already recorded stay in your
              spending history, marked as paid to "{profile.name}". This cannot be undone.
            </AlertDialogDescription>
            <label className="flex items-start gap-2 text-sm text-left pt-1 cursor-pointer" data-testid="label-delete-history">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={deleteHistoryToo}
                onChange={(e) => setDeleteHistoryToo(e.target.checked)}
                data-testid="checkbox-delete-history"
              />
              <span>Also delete its recorded payments from my spending history</span>
            </label>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-profile">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteProfileMutation.mutate()}
              disabled={deleteProfileMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-profile"
            >
              {deleteProfileMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

/**
 * A stat tile inside a subtype overview card.
 *
 * Now a thin pass-through to MetricCard — the app's one stat tile — rather than
 * a fourth local recipe. The old className read `"bubble -card- p-3 card-lift"`;
 * `-card-` matches no rule in index.css, so it was a dead token riding along on
 * every tile.
 */
function KpiTile({
  label,
  value,
  sub,
  icon,
  accent = "0 72% 55%",
  testid,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  accent?: string;
  testid?: string;
}) {
  return <MetricCard label={label} value={value} sub={sub} icon={icon} accent={accent} testId={testid} />;
}

/**
 * A label/value line in a detail card.
 *
 * The value is deliberately a size AND a weight above its label: these cards are
 * read by scanning down the right-hand column for a number, and at the old
 * uniform 12px there was nothing to scan for.
 */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[14px] font-semibold text-right tabular-nums">{value}</span>
    </div>
  );
}

function QuickActionButton({
  label,
  hint,
  onClick,
  testid,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border p-3 text-left hover:bg-accent transition-colors"
      data-testid={testid}
      type="button"
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
    </button>
  );
}

function PaymentRow({
  p,
  expanded,
  onReverse,
  reversing,
}: {
  p: LiabilityPayment;
  expanded?: boolean;
  onReverse?: () => void;
  reversing?: boolean;
}) {
  // Rule 8: reversing a payment puts money back on the balance. One stray tap
  // must not do that: the first tap arms the button, the second reverses.
  const { confirm: confirmReverse, isArmed: isReverseArmed } = useConfirmArm();
  const reverseArmed = isReverseArmed(`reverse-${p.id}`);
  return (
    <div className="px-3 py-2 flex items-center justify-between gap-3" data-testid={`payment-row-${p.id}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
          {fmtUSD(Number(p.amount) || 0)}
          {/* Assumed (Auto Pay recorded it) is never shown as plainly "paid". */}
          {p.status ? <PaymentStatusBadge status={p.status} autopay={p.autopay} /> : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtDate(p.paymentDate)}
          {p.status === "partial" && p.expectedAmount ? ` · ${fmtUSD(p.expectedAmount)} was scheduled` : ""}
        </div>
        {expanded && p.notes ? (
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{p.notes}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right text-xs text-muted-foreground shrink-0">
          <div>P {fmtUSD(Number(p.principalPortion) || 0)}</div>
          <div>I {fmtUSD(Number(p.interestPortion) || 0)}</div>
          {expanded && p.remainingBalanceAfter != null ? (
            <div className="mt-0.5">Bal {fmtUSD(Number(p.remainingBalanceAfter) || 0)}</div>
          ) : null}
        </div>
        {expanded && p.status ? (
          <PaymentStatusControls
            target={{ liabilityId: p.liabilityProfileId, paymentId: p.id }}
            status={p.status}
            amount={Number(p.expectedAmount ?? p.amount) || 0}
            date={String(p.paymentDate || "").slice(0, 10)}
          />
        ) : null}
        {expanded && onReverse ? (
          <Button
            variant="ghost"
            size="sm"
            className={reverseArmed ? "text-destructive" : "text-muted-foreground hover:text-destructive"}
            onClick={() => confirmReverse(`reverse-${p.id}`, onReverse)}
            disabled={reversing}
            title={reverseArmed ? "Tap again to reverse this payment" : "Reverse this payment"}
            aria-label={reverseArmed ? "Tap again to reverse this payment" : "Reverse this payment"}
            data-testid={`reverse-payment-${p.id}`}
          >
            {reversing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            {reverseArmed ? <span className="ml-1 text-xs">Tap again to reverse</span> : null}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Payoff Calculator ───────────────────────────────────────────────────────

function PayoffCalculator({
  terms,
  baseSummary,
}: {
  terms: ReturnType<typeof readTerms>;
  baseSummary: ReturnType<typeof summarizeLiability>;
}) {
  const [extra, setExtra] = useState<string>("100");
  const [lumpSum, setLumpSum] = useState<string>("0");
  const [targetMonths, setTargetMonths] = useState<string>("");

  const extraNum = Math.max(0, parseFloat(extra) || 0);
  const lumpSumNum = Math.max(0, parseFloat(lumpSum) || 0);
  const targetMonthsNum = Math.max(0, parseInt(targetMonths) || 0);

  const accelerated = useMemo(() => {
    if (terms.currentBalance <= 0) return null;
    const adjustedBalance = Math.max(0, terms.currentBalance - lumpSumNum);
    return buildAmortization({
      currentBalance: adjustedBalance,
      annualInterestRate: terms.annualRate,
      monthlyPayment: terms.monthlyPayment || baseSummary.monthlyPayment || undefined,
      remainingTermMonths: terms.remainingTermMonths,
      firstPaymentDate: terms.firstPaymentDate,
      extraPerPeriod: extraNum,
    });
  }, [terms, lumpSumNum, extraNum, baseSummary.monthlyPayment]);

  // "Pay it off in N months" reverse-solve: compute the required monthly payment
  // for a given target term, given current balance + APR.
  const targetSolve = useMemo(() => {
    if (!targetMonthsNum || terms.currentBalance <= 0) return null;
    const required =
      ((terms.currentBalance) * (terms.annualRate / 12)) /
      (1 - Math.pow(1 + terms.annualRate / 12, -targetMonthsNum));
    const safeRequired = Number.isFinite(required) && required > 0 ? required : terms.currentBalance / targetMonthsNum;
    const projection = buildAmortization({
      currentBalance: terms.currentBalance,
      annualInterestRate: terms.annualRate,
      monthlyPayment: safeRequired,
      firstPaymentDate: terms.firstPaymentDate,
    });
    return { requiredMonthlyPayment: safeRequired, projection };
  }, [terms, targetMonthsNum]);

  const baseMonths = baseSummary.remainingMonths;
  const baseInterest = baseSummary.totalRemainingInterest;
  const accMonths = accelerated?.payoffMonths ?? baseMonths;
  const accInterest = accelerated?.totalInterest ?? baseInterest;
  const monthsSaved = Math.max(0, baseMonths - accMonths);
  const interestSaved = Math.max(0, baseInterest - accInterest);

  return (
    <div className="space-y-4" data-testid="payoff-calculator">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calculator className="w-4 h-4 text-primary" />
            What if you paid more?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="calc-extra">Extra principal per month</Label>
              <Input
                id="calc-extra"
                type="number"
                step="10"
                min="0"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                data-testid="calc-extra-input"
              />
              <p className="text-xs text-muted-foreground mt-1">Applied on top of the regular monthly payment.</p>
            </div>
            <div>
              <Label htmlFor="calc-lump">One-time lump sum</Label>
              <Input
                id="calc-lump"
                type="number"
                step="100"
                min="0"
                value={lumpSum}
                onChange={(e) => setLumpSum(e.target.value)}
                data-testid="calc-lump-input"
              />
              <p className="text-xs text-muted-foreground mt-1">Applied immediately to the principal balance.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-3 gap-3" data-testid="calc-impact">
        <ImpactTile
          label="Months saved"
          value={monthsSaved > 0 ? `${monthsSaved} mo` : "—"}
          accent="text-emerald-600"
          icon={<TrendingDown className="w-4 h-4" />}
          testid="impact-months"
        />
        <ImpactTile
          label="Interest saved"
          value={interestSaved > 0 ? fmtUSD(interestSaved) : "—"}
          accent="text-emerald-600"
          icon={<DollarSign className="w-4 h-4" />}
          testid="impact-interest"
        />
        <ImpactTile
          label="New payoff date"
          value={accelerated && accMonths > 0 ? fmtDate(accelerated.payoffDate) : "—"}
          accent="text-foreground"
          icon={<CalendarIcon className="w-4 h-4" />}
          testid="impact-payoff"
        />
      </div>

      {/* Side-by-side schedule */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Current pace</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Months remaining" value={`${baseMonths}`} />
            <Row label="Total interest" value={fmtUSD(baseInterest)} />
            <Row label="Payoff date" value={baseMonths > 0 ? fmtDate(baseSummary.payoffDate) : "—"} />
          </CardContent>
        </Card>
        <Card className="border-emerald-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Accelerated
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Months remaining" value={`${accMonths}`} />
            <Row label="Total interest" value={fmtUSD(accInterest)} />
            <Row label="Payoff date" value={accMonths > 0 && accelerated ? fmtDate(accelerated.payoffDate) : "—"} />
          </CardContent>
        </Card>
      </div>

      {/* Balance-over-time mini chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Balance over time</CardTitle>
        </CardHeader>
        <CardContent>
          <BalanceChart
            baseRows={baseSummary.remainingMonths > 0 ? buildAmortization({
              currentBalance: terms.currentBalance,
              annualInterestRate: terms.annualRate,
              monthlyPayment: terms.monthlyPayment || baseSummary.monthlyPayment || undefined,
              remainingTermMonths: terms.remainingTermMonths,
              firstPaymentDate: terms.firstPaymentDate,
            }).rows : []}
            acceleratedRows={accelerated?.rows ?? []}
          />
          <div className="flex items-center gap-4 text-xs text-muted-foreground mt-3">
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-muted-foreground/50" /> Current pace</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-emerald-500" /> Accelerated</span>
          </div>
        </CardContent>
      </Card>

      {/* Reverse-solve: target months → required payment */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pay it off by a target date</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="calc-target">Target months until payoff</Label>
            <Input
              id="calc-target"
              type="number"
              step="1"
              min="0"
              value={targetMonths}
              onChange={(e) => setTargetMonths(e.target.value)}
              placeholder="e.g. 36"
              data-testid="calc-target-input"
            />
          </div>
          {targetSolve ? (
            <div className="text-sm space-y-1" data-testid="calc-target-result">
              <Row
                label="Required monthly payment"
                value={fmtUSD(targetSolve.requiredMonthlyPayment)}
              />
              <Row
                label="Total interest at this pace"
                value={fmtUSD(targetSolve.projection.totalInterest)}
              />
              <Row
                label="Final payment"
                value={fmtDate(targetSolve.projection.payoffDate)}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Enter a target term to see the monthly payment required.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ImpactTile({
  label,
  value,
  accent,
  icon,
  testid,
}: {
  label: string;
  value: string;
  accent: string;
  icon: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="bubble p-3" data-testid={testid}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-xl font-semibold mt-1 leading-tight ${accent}`}>{value}</div>
    </div>
  );
}

function BalanceChart({
  baseRows,
  acceleratedRows,
}: {
  baseRows: AmortizationRow[];
  acceleratedRows: AmortizationRow[];
}) {
  if (baseRows.length === 0 && acceleratedRows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4" data-testid="chart-empty">
        Set a balance, rate, and payment to see the projection.
      </div>
    );
  }

  const W = 600;
  const H = 140;
  const padding = 8;
  const allRows = [...baseRows, ...acceleratedRows];
  const maxBalance = Math.max(
    1,
    ...allRows.map((r) => r.remainingBalance),
    baseRows[0]?.remainingBalance || 0,
    acceleratedRows[0]?.remainingBalance || 0,
  );
  const maxMonths = Math.max(1, baseRows.length, acceleratedRows.length);

  const toPath = (rows: AmortizationRow[]): string => {
    if (rows.length === 0) return "";
    const startBalance =
      rows[0].remainingBalance + rows[0].principal + rows[0].extraPrincipal;
    const points = [
      [0, startBalance] as const,
      ...rows.map((r, i) => [i + 1, r.remainingBalance] as const),
    ];
    return points
      .map(([m, b], i) => {
        const x = padding + (m / maxMonths) * (W - padding * 2);
        const y = padding + (1 - b / maxBalance) * (H - padding * 2);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" data-testid="balance-chart">
      {/* Grid */}
      <line x1={padding} y1={H - padding} x2={W - padding} y2={H - padding} stroke="currentColor" strokeOpacity="0.1" />
      <line x1={padding} y1={padding} x2={padding} y2={H - padding} stroke="currentColor" strokeOpacity="0.1" />
      {baseRows.length > 0 && (
        <path d={toPath(baseRows)} fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
      )}
      {acceleratedRows.length > 0 && (
        <path d={toPath(acceleratedRows)} fill="none" stroke="#10b981" strokeWidth="2" />
      )}
    </svg>
  );
}

function AmortRow({ row }: { row: AmortizationRow }) {
  return (
    <tr className="border-t">
      <td className="px-3 py-2 text-muted-foreground">{row.paymentNumber}</td>
      <td className="px-3 py-2">{fmtDate(row.dueDate)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.payment)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.principal + row.extraPrincipal)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.interest)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.remainingBalance)}</td>
    </tr>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 4: Linked Assets / Linked Profiles / Documents tabs
// ───────────────────────────────────────────────────────────────────────────

interface ProfileLite {
  id: string;
  name: string;
  type: string;
  type_key?: string | null;
  fields?: any;
}

function useAllProfiles() {
  return useQuery<ProfileLite[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/profiles");
      return res.json();
    },
  });
}

// ─── Linked Assets tab ────────────────────────────────────────────────────

interface LiabilityAssetLinkRow {
  id: string;
  liabilityProfileId: string;
  assetProfileId: string;
  ownershipPercentage: number;
  allocationAmount?: number | null;
  role: string;
  notes?: string | null;
}

function LinkedAssetsCard({ liabilityId, openSignal, onOpened }: { liabilityId: string; openSignal?: number; onOpened?: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The Overview's "Linked asset: Add" row asks for the picker.
  useEffect(() => { if (openSignal) { setPickerOpen(true); onOpened?.(); } }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedAssetId, setSelectedAssetId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<string>("collateral");

  const linksQuery = useQuery<LiabilityAssetLinkRow[]>({
    queryKey: [`/api/liabilities/${liabilityId}/assets`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/liabilities/${liabilityId}/assets`);
      return res.json();
    },
  });

  const profilesQuery = useAllProfiles();
  const allProfiles = profilesQuery.data || [];

  // Asset-eligible profiles: anything that's NOT a liability/loan/person/self
  const eligibleAssets = useMemo(() => {
    return allProfiles.filter((p) => {
      const t = (p.type || "").toLowerCase();
      return t !== "liability" && t !== "loan" && t !== "person" && t !== "self";
    });
  }, [allProfiles]);

  const linkedIds = new Set((linksQuery.data || []).map((l) => l.assetProfileId));
  const availableAssets = eligibleAssets.filter((p) => !linkedIds.has(p.id));

  const profileById = useMemo(() => {
    const map = new Map<string, ProfileLite>();
    for (const p of allProfiles) map.set(p.id, p);
    return map;
  }, [allProfiles]);

  const createLink = useMutation({
    mutationFn: async (input: { assetProfileId: string; role: string }) => {
      const res = await apiRequest("POST", "/api/liability-asset-links", {
        liabilityProfileId: liabilityId,
        assetProfileId: input.assetProfileId,
        ownershipPercentage: 100,
        role: input.role,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Asset linked" });
      qc.invalidateQueries({ queryKey: [`/api/liabilities/${liabilityId}/assets`] });
      setPickerOpen(false);
      setSelectedAssetId("");
    },
    onError: (err: Error) =>
      toast({ title: "Could not link asset", description: formatApiError(err), variant: "destructive" }),
  });

  const updateLink = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<LiabilityAssetLinkRow> }) => {
      const res = await apiRequest("PATCH", `/api/liability-asset-links/${input.id}`, input.patch);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/liabilities/${liabilityId}/assets`] });
    },
    onError: (err: Error) =>
      toast({ title: "Update failed", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteLink = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/liability-asset-links/${id}`);
    },
    // Optimistic removal (same pattern as CalendarView): drop the row from the
    // cached list immediately, roll back on error, reconcile on settle.
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: [`/api/liabilities/${liabilityId}/assets`] });
      const prev = qc.getQueryData<LiabilityAssetLinkRow[]>([`/api/liabilities/${liabilityId}/assets`]);
      qc.setQueryData<LiabilityAssetLinkRow[]>([`/api/liabilities/${liabilityId}/assets`], (old) =>
        (old || []).filter((l) => l.id !== id)
      );
      return { prev };
    },
    onSuccess: () => {
      toast({ title: "Asset unlinked" });
    },
    onError: (err: Error, _id, ctx: any) => {
      if (ctx?.prev) qc.setQueryData([`/api/liabilities/${liabilityId}/assets`], ctx.prev);
      toast({ title: "Could not unlink", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [`/api/liabilities/${liabilityId}/assets`] });
    },
  });

  return (
    <Card data-testid="linked-assets-card">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="w-4 h-4" /> Linked assets
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPickerOpen((s) => !s)}
          data-testid="link-asset-toggle"
          disabled={availableAssets.length === 0}
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          Link asset
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {pickerOpen && (
          <div className="rounded-md border p-3 bg-muted/30 space-y-2" data-testid="link-asset-picker">
            <div className="flex flex-col md:flex-row gap-2">
              <Select value={selectedAssetId} onValueChange={setSelectedAssetId}>
                <SelectTrigger className="flex-1" data-testid="link-asset-select">
                  <SelectValue placeholder="Choose an asset profile…" />
                </SelectTrigger>
                <SelectContent>
                  {availableAssets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} <span className="text-xs text-muted-foreground ml-1">({p.type})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger className="w-full md:w-44" data-testid="link-asset-role-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSET_LINK_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => {
                  if (!selectedAssetId) return;
                  createLink.mutate({ assetProfileId: selectedAssetId, role: selectedRole });
                }}
                disabled={!selectedAssetId || createLink.isPending}
                data-testid="link-asset-confirm"
              >
                {createLink.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Link"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)} aria-label="Cancel">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {linksQuery.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (linksQuery.data || []).length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="linked-assets-empty">
            No assets linked yet. Link a property, vehicle, or other asset that secures or relates to this liability.
          </div>
        ) : (
          <div className="space-y-2" data-testid="linked-assets-list">
            {(linksQuery.data || []).map((link) => {
              const asset = profileById.get(link.assetProfileId);
              return (
                <AssetLinkRow
                  key={link.id}
                  link={link}
                  assetId={link.assetProfileId}
                  assetName={asset?.name || "Unknown asset"}
                  assetType={asset?.type || ""}
                  onChange={(patch) => updateLink.mutate({ id: link.id, patch })}
                  onDelete={() => deleteLink.mutate(link.id)}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssetLinkRow({
  link,
  assetId,
  assetName,
  assetType,
  onChange,
  onDelete,
}: {
  link: LiabilityAssetLinkRow;
  assetId: string;
  assetName: string;
  assetType: string;
  onChange: (patch: Partial<LiabilityAssetLinkRow>) => void;
  onDelete: () => void;
}) {
  const [, navigate] = useLocation();
  const [pct, setPct] = useState<number>(link.ownershipPercentage ?? 100);
  // Rule 8: unlinking takes two taps (it used to go on the first).
  const unlinkArm = useConfirmArm();
  const armed = unlinkArm.isArmed("unlink");
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid={`asset-link-row-${link.id}`}>
      <div className="flex items-center justify-between gap-2">
        {/* Name/type is the primary tap target — navigates to the linked
            asset's detail page. The role select, ownership slider, and
            unlink button remain interactive on the same row. */}
        <button
          type="button"
          className="flex-1 min-w-0 text-left hover:bg-muted/40 rounded -mx-1 px-1 py-0.5"
          onClick={() => navigate(`/profiles/${assetId}`)}
          data-testid={`button-open-asset-${assetId}`}
        >
          <div className="font-medium truncate">{assetName}</div>
          <div className="text-xs text-muted-foreground">{assetType}</div>
        </button>
        <Select value={link.role} onValueChange={(v) => onChange({ role: v })}>
          <SelectTrigger className="w-36" data-testid="asset-link-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSET_LINK_ROLES.map((r) => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size={armed ? "sm" : "icon"} variant="ghost" onClick={() => unlinkArm.confirm("unlink", onDelete)} data-testid="asset-link-delete"
          aria-label={armed ? "Tap again to unlink" : "Unlink asset"} title={armed ? "Tap again to unlink" : "Unlink asset"}>
          {armed ? <span className="text-xs text-rose-500">Tap again</span> : <Trash2 className="w-4 h-4 text-rose-500" />}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground w-24 shrink-0">Ownership %</span>
        <Slider
          value={[pct]}
          min={0}
          max={100}
          step={1}
          onValueChange={(vs) => setPct(vs[0] ?? 0)}
          onValueCommit={(vs) => onChange({ ownershipPercentage: vs[0] ?? 0 })}
          className="flex-1"
        />
        <span className="text-sm font-medium w-12 text-right tabular-nums">{pct}%</span>
      </div>
    </div>
  );
}

// ─── Linked Profiles tab ────────────────────────────────────────────────────

interface LiabilityProfileLinkRow {
  id: string;
  liabilityProfileId: string;
  partyProfileId: string;
  ownershipPercentage: number;
  role: string;
  notes?: string | null;
}

function LinkedProfilesCard({ liabilityId }: { liabilityId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPartyId, setSelectedPartyId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<string>("owner");

  const linksQuery = useQuery<LiabilityProfileLinkRow[]>({
    queryKey: [`/api/liabilities/${liabilityId}/parties`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/liabilities/${liabilityId}/parties`);
      return res.json();
    },
  });

  const profilesQuery = useAllProfiles();
  const allProfiles = profilesQuery.data || [];

  // Party-eligible profiles: people only (person, self)
  const eligibleParties = useMemo(() => {
    return allProfiles.filter((p) => {
      const t = (p.type || "").toLowerCase();
      return t === "person" || t === "self";
    });
  }, [allProfiles]);

  const linkedIds = new Set((linksQuery.data || []).map((l) => l.partyProfileId));
  const availableParties = eligibleParties.filter((p) => !linkedIds.has(p.id));

  const profileById = useMemo(() => {
    const map = new Map<string, ProfileLite>();
    for (const p of allProfiles) map.set(p.id, p);
    return map;
  }, [allProfiles]);

  const totalOwnership = useMemo(
    () => (linksQuery.data || []).reduce((s, l) => s + (Number(l.ownershipPercentage) || 0), 0),
    [linksQuery.data],
  );

  const createLink = useMutation({
    mutationFn: async (input: { partyProfileId: string; role: string }) => {
      const res = await apiRequest("POST", "/api/liability-profile-links", {
        liabilityProfileId: liabilityId,
        partyProfileId: input.partyProfileId,
        ownershipPercentage: 100,
        role: input.role,
      });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({ title: "Person linked" });
      // Bug #2: the "liabilities" + "people" domains cover the profiles list,
      // the liability + party detail keys, /api/parties/* and the dashboard.
      void vars;
      qc.invalidateQueries({ queryKey: ["/api/liabilities", liabilityId, "parties"] });
      qc.invalidateQueries({ queryKey: ["/api/liability-profile-links"] });
      void invalidateDomains("everything"); // co-ownership changes every scoped list (see shared/storage-domains)
      setPickerOpen(false);
      setSelectedPartyId("");
    },
    onError: (err: Error) =>
      toast({ title: "Could not link person", description: formatApiError(err), variant: "destructive" }),
  });

  const updateLink = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<LiabilityProfileLinkRow> }) => {
      const res = await apiRequest("PATCH", `/api/liability-profile-links/${input.id}`, input.patch);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/liabilities/${liabilityId}/parties`] });
    },
    onError: (err: Error) =>
      toast({ title: "Update failed", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteLink = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/liability-profile-links/${id}`);
    },
    // Optimistic removal (same pattern as CalendarView): drop the row from the
    // cached list immediately, roll back on error, reconcile on settle.
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: [`/api/liabilities/${liabilityId}/parties`] });
      const prev = qc.getQueryData<LiabilityProfileLinkRow[]>([`/api/liabilities/${liabilityId}/parties`]);
      qc.setQueryData<LiabilityProfileLinkRow[]>([`/api/liabilities/${liabilityId}/parties`], (old) =>
        (old || []).filter((l) => l.id !== id)
      );
      return { prev };
    },
    onSuccess: () => {
      toast({ title: "Person unlinked" });
    },
    onError: (err: Error, _id, ctx: any) => {
      if (ctx?.prev) qc.setQueryData([`/api/liabilities/${liabilityId}/parties`], ctx.prev);
      toast({ title: "Could not unlink", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // Bug #14 (liability side): the "liabilities" + "people" domains cover the
      // profiles list, detail keys, /api/parties/* and the dashboard.
      qc.invalidateQueries({ queryKey: ["/api/liabilities", liabilityId, "parties"] });
      qc.invalidateQueries({ queryKey: ["/api/liability-profile-links"] });
      void invalidateDomains("everything"); // co-ownership changes every scoped list (see shared/storage-domains)
    },
  });

  return (
    <Card data-testid="linked-profiles-card">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="w-4 h-4" /> Linked people
          {(linksQuery.data || []).length > 1 && (
            <Badge
              variant={Math.abs(totalOwnership - 100) < 0.5 ? "secondary" : "destructive"}
              className="ml-2 text-[11px]"
              data-testid="ownership-total-badge"
            >
              Total {totalOwnership.toFixed(0)}%
            </Badge>
          )}
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPickerOpen((s) => !s)}
          data-testid="link-party-toggle"
          disabled={availableParties.length === 0}
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          Add person
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {pickerOpen && (
          <div className="rounded-md border p-3 bg-muted/30 space-y-2" data-testid="link-party-picker">
            <div className="flex flex-col md:flex-row gap-2">
              <Select value={selectedPartyId} onValueChange={setSelectedPartyId}>
                <SelectTrigger className="flex-1" data-testid="link-party-select">
                  <SelectValue placeholder="Choose a person…" />
                </SelectTrigger>
                <SelectContent>
                  {availableParties.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger className="w-full md:w-44" data-testid="link-party-role-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROFILE_LINK_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => {
                  if (!selectedPartyId) return;
                  createLink.mutate({ partyProfileId: selectedPartyId, role: selectedRole });
                }}
                disabled={!selectedPartyId || createLink.isPending}
                data-testid="link-party-confirm"
              >
                {createLink.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Add"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)} aria-label="Cancel">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {linksQuery.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (linksQuery.data || []).length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="linked-profiles-empty">
            No people linked yet. Add the borrower, co-signer, guarantor, or other responsible parties.
          </div>
        ) : (
          <div className="space-y-2" data-testid="linked-profiles-list">
            {(linksQuery.data || []).map((link) => {
              const party = profileById.get(link.partyProfileId);
              return (
                <PartyLinkRow
                  key={link.id}
                  link={link}
                  partyName={party?.name || "Unknown"}
                  onChange={(patch) => updateLink.mutate({ id: link.id, patch })}
                  onDelete={() => deleteLink.mutate(link.id)}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PartyLinkRow({
  link,
  partyName,
  onChange,
  onDelete,
}: {
  link: LiabilityProfileLinkRow;
  partyName: string;
  onChange: (patch: Partial<LiabilityProfileLinkRow>) => void;
  onDelete: () => void;
}) {
  const [pct, setPct] = useState<number>(link.ownershipPercentage ?? 100);
  const roleLabel = PROFILE_LINK_ROLES.find((r) => r.value === link.role)?.label || link.role;
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid={`party-link-row-${link.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{partyName}</div>
          <div className="text-xs text-muted-foreground">{roleLabel}</div>
        </div>
        <Select value={link.role} onValueChange={(v) => onChange({ role: v })}>
          <SelectTrigger className="w-44" data-testid="party-link-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROFILE_LINK_ROLES.map((r) => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" onClick={onDelete} aria-label="Remove owner" data-testid="party-link-delete">
          <Trash2 className="w-4 h-4 text-rose-500" />
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground w-24 shrink-0">Ownership %</span>
        <Slider
          value={[pct]}
          min={0}
          max={100}
          step={1}
          onValueChange={(vs) => setPct(vs[0] ?? 0)}
          onValueCommit={(vs) => onChange({ ownershipPercentage: vs[0] ?? 0 })}
          className="flex-1"
        />
        <span className="text-sm font-medium w-12 text-right tabular-nums">{pct}%</span>
      </div>
    </div>
  );
}

// ─── Nested Liabilities card ───────────────────────────────────────────────

function NestedLiabilitiesCard({ liabilityId }: { liabilityId: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState("");
  const [childSubtype, setChildSubtype] = useState("other");
  const [childBalance, setChildBalance] = useState("");

  const graphQuery = useQuery<{ rootId?: string; nodes: { id: string; name: string; typeKey: string; type?: string }[]; edges?: { from: string; to: string }[] }>({
    queryKey: [`/api/relationships/graph/${liabilityId}`, "hops2"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/relationships/graph/${liabilityId}?hops=2`);
      return res.json();
    },
  });

  // Only surface DIRECTLY related liabilities. Don't bridge through person/self/pet/business
  // nodes — sharing an owner doesn't make two liabilities related.
  const linkedLiabilities = useMemo(() => {
    const data = graphQuery.data;
    if (!data) return [];
    const root = data.rootId || liabilityId;
    const personTypes = new Set(["person", "self", "pet", "business"]);
    const liabTypes = new Set(["liability", "loan"]);
    const nodeById: Record<string, any> = {};
    for (const n of (data.nodes || [])) nodeById[n.id] = n;
    const adj: Record<string, Set<string>> = {};
    const addEdge = (a: string, b: string) => { if (!adj[a]) adj[a] = new Set(); adj[a].add(b); };
    for (const e of (data.edges || [])) {
      const fromNode = nodeById[e.from];
      const toNode = nodeById[e.to];
      if (!fromNode || !toNode) continue;
      const ft = (fromNode.typeKey || fromNode.type || "").toLowerCase();
      const tt = (toNode.typeKey || toNode.type || "").toLowerCase();
      if (personTypes.has(ft) || personTypes.has(tt)) continue;
      addEdge(e.from, e.to);
      addEdge(e.to, e.from);
    }
    const reachable = new Set<string>();
    const queue: string[] = [root];
    const visited = new Set<string>([root]);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of (adj[cur] || [])) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        reachable.add(nb);
        queue.push(nb);
      }
    }
    // A liability's `typeKey` is its SUBTYPE ("mortgage"), so testing it
    // against {"liability","loan"} rejected every typed debt. The record type
    // is what says "this is a debt".
    return (data.nodes || []).filter((n) => {
      if (!reachable.has(n.id)) return false;
      const t = (n.type || n.typeKey || "").toLowerCase();
      return liabTypes.has(t);
    });
  }, [graphQuery.data, liabilityId]);

  // The panel's own "add" files the child UNDER this liability
  // (parentProfileId), which is not a link-table edge, so the graph never
  // returned it: the child showed under Linked records and in the list while
  // this panel said "No nested liabilities". Children are read from the
  // profile list, the same rows the list shows.
  const profilesQuery = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const nestedLiabilities = useMemo(() => {
    const out = new Map<string, { id: string; name: string; typeKey: string; type?: string }>();
    for (const p of profilesQuery.data || []) {
      if (p?.parentProfileId !== liabilityId) continue;
      if (!["liability", "loan"].includes(String(p.type || "").toLowerCase())) continue;
      out.set(p.id, { id: p.id, name: p.name, type: p.type, typeKey: p.type_key || p.typeKey || "" });
    }
    for (const n of linkedLiabilities) if (!out.has(n.id)) out.set(n.id, n);
    return [...out.values()];
  }, [profilesQuery.data, linkedLiabilities, liabilityId]);

  const SUBTYPE_LABELS_LOCAL: Record<string, string> = {
    mortgage: "Mortgage",
    auto_loan: "Auto loan",
    credit_card: "Credit card",
    student_loan: "Student loan",
    medical_debt: "Medical debt",
    business_loan: "Business loan",
    tax_debt: "Tax debt",
    line_of_credit: "Line of credit",
    bnpl: "Buy now pay later",
    personal_loan: "Personal loan",
    financing: "Financing",
    utility_plan: "Utility plan",
    custom: "Other liability",
    liability: "Liability",
    loan: "Loan",
  };

  const createChildMut = useMutation({
    mutationFn: async () => {
      const fields: Record<string, any> = {};
      const bal = parseFloat(childBalance);
      if (!isNaN(bal)) { fields.currentBalance = bal; fields.originalBalance = bal; }
      const res = await apiRequest("POST", "/api/profiles", {
        type: "liability",
        type_key: childSubtype,
        name: childName.trim(),
        parentProfileId: liabilityId,
        fields,
      });
      return res.json();
    },
    onSuccess: () => {
      setChildName(""); setChildBalance(""); setChildSubtype("other"); setAdding(false);
      toast({ title: "Nested liability added" });
    },
    onError: (e: any) => toast({ title: "Couldn't add it", description: formatApiError(e), variant: "destructive" }),
  });

  const CHILD_SUBTYPES: { value: string; label: string }[] = [
    { value: "other", label: "Other liability" },
    { value: "credit_card", label: "Credit card" },
    { value: "auto_loan", label: "Auto loan" },
    { value: "personal_loan", label: "Personal loan" },
    { value: "student_loan", label: "Student loan" },
    { value: "medical_debt", label: "Medical debt" },
    { value: "bnpl", label: "Buy now pay later" },
    { value: "mortgage", label: "Mortgage" },
  ];

  return (
    <div data-testid="nested-liabilities-card" className="space-y-3">
      {/* Add nested liability — parent/child like nested assets. */}
      {adding ? (
        <div className="rounded-lg border p-3 space-y-2" data-testid="add-nested-liability-form">
          <Input placeholder="Name (e.g. Store Card)" value={childName} onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && childName.trim()) createChildMut.mutate(); }} data-testid="input-child-name" />
          <div className="flex gap-2">
            <Select value={childSubtype} onValueChange={setChildSubtype}>
              <SelectTrigger className="flex-1" data-testid="select-child-subtype"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHILD_SUBTYPES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="number" step="0.01" placeholder="Balance" className="w-28" value={childBalance}
              onChange={(e) => setChildBalance(e.target.value)} data-testid="input-child-balance" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createChildMut.mutate()} disabled={createChildMut.isPending || !childName.trim()} data-testid="btn-create-child-liability">
              {createChildMut.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid="btn-add-nested-liability">
          <Plus className="w-4 h-4 mr-1" />Add nested liability
        </Button>
      )}
      {graphQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : nestedLiabilities.length === 0 ? (
        // Stated as the outcome, not as a hole. Nothing nested under a bill is
        // the normal, healthy case — it was reading as missing content because
        // it rendered as bare grey text with no container around it.
        <EmptyState
          icon={TrendingDown}
          label="Nothing nested under this"
          hint="Add a fee or add-on that bills alongside it."
          tone="good"
          testId="nested-liabilities-empty"
        />
      ) : (
        <div className="flex flex-wrap gap-3" data-testid="nested-liabilities-list">
          {nestedLiabilities.map((node) => {
            const tk = (node.typeKey || node.type || "").toLowerCase();
            const typeLabel = SUBTYPE_LABELS_LOCAL[tk] || "Liability";
            return (
              <div
                key={node.id}
                style={{ height: 160 }}
                className="w-40 shrink-0 bubble p-3 flex flex-col justify-between cursor-pointer hover:bg-accent transition-colors pressable"
                onClick={() => navigate(`/profiles/${node.id}`)}
                data-testid={`nested-liability-${node.id}`}
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-rose-500/10 text-rose-600">
                  <Wallet className="w-5 h-5" />
                </div>
                <div className="mt-2 min-w-0">
                  <div className="font-medium text-sm truncate">{node.name}</div>
                  <Badge variant="secondary" className="text-[11px] mt-1">{typeLabel}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Documents tab ─────────────────────────────────────────────────────────

interface LiabilityDocument {
  id: string;
  name: string;
  type: string;
  mimeType?: string;
  fileData?: string | null;
  linkedProfiles?: string[];
  createdAt?: string;
  ocrText?: string | null;
  extractedData?: any;
}

function LiabilityDocumentsCard({ liabilityId, liabilityName, openSignal, onOpened }: { liabilityId: string; liabilityName: string; openSignal?: number; onOpened?: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The Overview's "Add document" button asks for the file chooser.
  useEffect(() => { if (openSignal) { fileInputRef.current?.click(); onOpened?.(); } }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);

  const docsQuery = useQuery<LiabilityDocument[]>({
    queryKey: [`/api/profiles/${liabilityId}/documents`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${liabilityId}/documents`);
      return res.json();
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
      const fileData = await toBase64(file);
      // /api/upload runs OCR + AI extraction and links to profileId.
      const res = await apiRequest("POST", "/api/upload", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileId: liabilityId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded", description: "OCR & AI extraction running." });
      invalidateDomains("documents", "profiles");
    },
    onError: (err: Error) =>
      toast({ title: "Upload failed", description: formatApiError(err), variant: "destructive" }),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    e.target.value = "";
  }

  const docs = docsQuery.data || [];
  const viewingDoc = viewingDocId ? docs.find((d) => d.id === viewingDocId) : undefined;

  return (
    <Card data-testid="liability-documents-card">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="w-4 h-4" /> Documents
        </CardTitle>
        <div className="flex items-center gap-2">
          <SmartFillTrigger
            preselectedSources={[{ id: liabilityId, kind: "liability", name: liabilityName }]}
            testId="liability-doc-smart-fill"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
            data-testid="liability-doc-upload"
          >
            {uploadMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5 mr-1" />
            )}
            Upload
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,application/pdf"
          onChange={handleFileChange}
          data-testid="liability-doc-file-input"
        />
      </CardHeader>
      <CardContent>
        {docsQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : docs.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center" data-testid="liability-docs-empty">
            No documents yet. Upload statements, payoff letters, or original loan agreements — we'll OCR them and pull out key fields.
          </div>
        ) : (
          <div className="space-y-2" data-testid="liability-docs-list">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between gap-2 rounded-md border p-3"
                data-testid={`liability-doc-${doc.id}`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{doc.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {doc.type}{doc.createdAt ? ` · ${fmtDate(doc.createdAt)}` : ""}
                      {doc.ocrText ? " · OCR ready" : ""}
                    </div>
                  </div>
                </div>
                {/* Opens the shared document view (file first). This was a bare
                    link to the file endpoint, which a new tab cannot load: the
                    request carries no sign-in. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewingDocId(doc.id)}
                  data-testid={`liability-doc-view-${doc.id}`}
                >
                  View
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setDeletingDocId(doc.id)}
                  aria-label="Delete document"
                  data-testid={`liability-doc-delete-${doc.id}`}
                >
                  <Trash2 className="w-4 h-4 text-rose-500" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {/* Deleting from a liability is the same act as deleting from the
          Documents page — the shared dialog asks whether the data the document
          created goes with it, then runs the one cascade. This button used to
          delete on the spot, with no confirmation at all. */}
      <DocumentDeleteDialog
        documentId={deletingDocId}
        documentName={docs.find((d: any) => d.id === deletingDocId)?.name}
        onOpenChange={(open) => { if (!open) setDeletingDocId(null); }}
        onDeleted={() => setDeletingDocId(null)}
      />
      {viewingDoc && (
        <DocumentViewerDialog
          open
          onOpenChange={(open) => { if (!open) setViewingDocId(null); }}
          id={viewingDoc.id}
          name={viewingDoc.name}
          mimeType={viewingDoc.mimeType || ""}
          data=""
        />
      )}
    </Card>
  );
}

// ─── Phase 5: AI Summary card ────────────────────────────────────────────────

interface AISummaryData {
  summary: string;
  actionItems: string[];
  highlights: Array<{
    label: string;
    value: string;
    trend?: "up" | "down" | "stable";
  }>;
  generatedAt: string;
  /** The figures the summary was written from (shared/profile-summary-fingerprint). */
  fingerprint?: string;
}

function AISummaryCard({ profileId, valueFingerprint }: { profileId: string; valueFingerprint?: string }) {
  // When set, the next fetch appends ?force=true so the server regenerates
  // instead of serving its 2h cache. A ref (not state) keeps the single
  // useQuery queryFn as the only fetch path — the old handler set the cache to
  // undefined and kicked a second fetchQuery, which blanked the card mid-refresh
  // and, on error, made it disappear for good.
  const forceRef = useRef(false);
  const { data: aiSummary, isLoading, isError, isFetching, refetch } = useQuery<AISummaryData>({
    queryKey: ["/api/profiles", profileId, "ai-summary"],
    queryFn: async () => {
      const force = forceRef.current;
      forceRef.current = false;
      const res = await apiRequest(
        "GET",
        `/api/profiles/${profileId}/ai-summary${force ? "?force=true" : ""}`,
      );
      return res.json();
    },
    enabled: !!profileId,
    retry: false,
  });

  const handleRefresh = useCallback(() => {
    forceRef.current = true;
    refetch();
  }, [refetch]);

  // The summary carries the fingerprint of the figures it was written from
  // (balance, last payment). When the page now shows different figures — a
  // payment was just recorded — it is out of date: ask for a new one, once
  // per change, and say so meanwhile instead of showing old numbers as
  // "Generated 5m ago" (2026-11-20). A read, never a write.
  const summaryStale = !!aiSummary?.fingerprint && !!valueFingerprint && aiSummary.fingerprint !== valueFingerprint;
  const refetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!summaryStale || isFetching || !valueFingerprint) return;
    if (refetchedFor.current === valueFingerprint) return;
    refetchedFor.current = valueFingerprint;
    refetch();
  }, [summaryStale, isFetching, valueFingerprint, refetch]);

  // Only hide outright when there's nothing to show. Once a summary has loaded,
  // keep it on screen across refresh errors (react-query retains the last data)
  // instead of blanking the whole card.
  if (isError && !aiSummary) return null;

  if (isLoading) {
    return (
      <Card data-testid="liability-ai-summary-loading">
        <div className="h-1 bg-gradient-to-r from-rose-500/60 via-rose-500/30 to-transparent" />
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="flex gap-2 mt-3">
            <Skeleton className="h-14 flex-1 rounded-lg" />
            <Skeleton className="h-14 flex-1 rounded-lg" />
            <Skeleton className="h-14 flex-1 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!aiSummary) return null;

  return (
    <Card data-testid="liability-ai-summary">
      <div className="h-1 bg-gradient-to-r from-rose-500/60 via-rose-500/30 to-transparent" />
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">AI Summary</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
            onClick={handleRefresh}
            disabled={isFetching}
            data-testid="liability-ai-refresh"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          className="text-sm text-muted-foreground leading-relaxed"
          data-testid="liability-ai-summary-text"
        >
          {aiSummary.summary}
        </p>

        {aiSummary.highlights && aiSummary.highlights.length > 0 && (
          <div
            className="flex flex-wrap gap-2"
            data-testid="liability-ai-highlights"
          >
            {aiSummary.highlights.map((h, i) => (
              <div
                key={i}
                className="flex-1 min-w-[100px] rounded-lg border border-border bg-muted/30 px-3 py-2 text-center"
                data-testid={`liability-ai-highlight-${i}`}
              >
                <p className="text-xs text-muted-foreground">{h.label}</p>
                <div className="flex items-center justify-center gap-1 mt-0.5">
                  <p className="text-sm font-semibold tabular-nums">{h.value}</p>
                  {h.trend === "up" && <TrendingUp className="h-3 w-3 text-green-500" />}
                  {h.trend === "down" && <TrendingDown className="h-3 w-3 text-red-500" />}
                  {h.trend === "stable" && <Minus className="h-3 w-3 text-muted-foreground" />}
                </div>
              </div>
            ))}
          </div>
        )}

        {aiSummary.actionItems && aiSummary.actionItems.length > 0 && (
          <div className="space-y-1.5" data-testid="liability-ai-actions">
            <p className="text-xs font-medium text-muted-foreground">Action Items</p>
            {aiSummary.actionItems.map((item, i) => (
              <div
                key={i}
                className="flex items-start gap-2"
                data-testid={`liability-ai-action-${i}`}
              >
                <Circle className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                <p className="text-xs text-foreground">{item}</p>
              </div>
            ))}
          </div>
        )}

        {aiSummary.generatedAt && (
          <p className="text-xs text-muted-foreground pt-1">
            {summaryStale
              ? (isFetching ? "Updating for your latest change…" : isError ? "Out of date — couldn't refresh. Tap refresh to try again." : "Out of date — updating…")
              : <>Generated {fmtTimeAgo(new Date(aiSummary.generatedAt))}</>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function fmtTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

interface ActivityEntry {
  id: string;
  type: "payment" | "document" | "event" | "task" | "obligation" | "note";
  title: string;
  description?: string;
  timestamp: string; // ISO
}

function ActivityTimelineCard({
  profileId,
  payments,
}: {
  profileId: string;
  payments: LiabilityPayment[];
}) {
  // Pull the standard profile detail (which already collects related events,
  // tasks, obligations, documents, etc.). This key is normally already in
  // cache — ProfileDetailPage populates it before rendering this page — so no
  // network call fires on mount. BUG FIX (2026-07-08): the queryFn previously
  // fetched the PLAIN profile (`/api/profiles/:id`), so whenever a stale
  // refetch ran through THIS observer it overwrote the rich detail object in
  // the shared cache with one missing every related* array — blanking the
  // timeline and the rest of the page's linked data. Fetch the real detail
  // endpoint with the same flattened shape the page-level query writes.
  const detailQuery = useQuery<any>({
    queryKey: ["/api/profiles", profileId, "detail"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/detail`);
      return flattenProfile(await res.json());
    },
    enabled: !!profileId,
  });

  const entries = useMemo<ActivityEntry[]>(() => {
    const out: ActivityEntry[] = [];

    for (const p of payments) {
      const ts = p.paymentDate || p.createdAt;
      if (!ts) continue;
      out.push({
        id: `pay-${p.id}`,
        type: "payment",
        title: `Payment ${fmtUSD(Number(p.amount) || 0)}`,
        description: `${fmtUSD(Number(p.principalPortion) || 0)} principal · ${fmtUSD(Number(p.interestPortion) || 0)} interest${p.notes ? ` · ${p.notes}` : ""}`,
        timestamp: timelineStamp(ts),
      });
    }

    const detail = detailQuery.data;
    if (detail) {
      for (const d of detail.relatedDocuments || []) {
        out.push({
          id: `doc-${d.id}`,
          type: "document",
          title: d.title || d.filename || "Document",
          description: d.summary || d.kind || undefined,
          timestamp: timelineStamp(d.createdAt || d.uploadedAt),
        });
      }
      for (const e of detail.relatedEvents || []) {
        out.push({
          id: `evt-${e.id}`,
          type: "event",
          title: e.title || "Event",
          description: e.description || undefined,
          timestamp: timelineStamp(e.startTime || e.start || e.createdAt),
        });
      }
      for (const t of detail.relatedTasks || []) {
        out.push({
          id: `task-${t.id}`,
          type: "task",
          title: t.title || "Task",
          description: t.description || undefined,
          timestamp: timelineStamp(t.dueDate || t.createdAt),
        });
      }
      for (const o of detail.relatedObligations || []) {
        out.push({
          id: `obl-${o.id}`,
          type: "obligation",
          title: o.title || "Obligation",
          description: o.description || undefined,
          timestamp: timelineStamp(o.dueDate || o.createdAt),
        });
      }
    }

    out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return out;
  }, [payments, detailQuery.data]);

  if (detailQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center" data-testid="liability-activity-empty">
          <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No activity yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Payments, documents, events and tasks tied to this liability will appear here.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Group by Today / Yesterday / This Week / Earlier, in the browser's zone —
  // the UTC slice put an 8 PM entry under "Today" all the next morning.
  const now = new Date();
  const todayStr = getUserToday(BROWSER_TIMEZONE);
  const yesterday = tzAddDays(todayStr, -1);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).getTime();
  const groups: { label: string; items: ActivityEntry[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const e of entries.slice(0, 100)) {
    let d: string;
    try { d = isDateOnly(e.timestamp) ? e.timestamp : toLocalDateStr(new Date(e.timestamp), BROWSER_TIMEZONE); } catch { d = String(e.timestamp || "").slice(0, 10); }
    const t = timelineInstant(e.timestamp).getTime();
    if (d === todayStr) groups[0].items.push(e);
    else if (d === yesterday) groups[1].items.push(e);
    else if (t >= weekAgo) groups[2].items.push(e);
    else groups[3].items.push(e);
  }

  return (
    <Card data-testid="liability-activity-card">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <ActivityIcon className="w-4 h-4 text-primary" />
          <CardTitle className="text-base">Activity</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.label} data-testid={`activity-group-${g.label.toLowerCase().replace(/\s+/g, "-")}`}>
              <p className="micro-label text-muted-foreground mb-2">
                {g.label}
              </p>
              <div className="divide-y">
                {g.items.map((e) => (
                  <ActivityRow key={e.id} entry={e} />
                ))}
              </div>
            </div>
          ),
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const colors: Record<string, string> = {
    payment: "bg-emerald-500/10 text-emerald-600",
    document: "bg-primary/10 text-primary",
    event: "bg-chart-2/10 text-chart-2",
    task: "bg-chart-3/10 text-chart-3",
    obligation: "bg-orange-500/10 text-orange-500",
    note: "bg-muted text-muted-foreground",
  };
  const icons: Record<string, any> = {
    payment: DollarSign,
    document: FileText,
    event: CalendarIcon,
    task: ActivityIcon,
    obligation: CreditCard,
    note: FileText,
  };
  const Icon = icons[entry.type] || Clock;
  const color = colors[entry.type] || "bg-muted text-muted-foreground";

  return (
    <div className="flex gap-3 py-3" data-testid={`activity-row-${entry.type}`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${color}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{entry.title}</p>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{entry.description}</p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {formatTimelineStamp(entry.timestamp)}
        </p>
      </div>
      <Badge variant="secondary" className="text-xs capitalize shrink-0 h-fit">
        {entry.type}
      </Badge>
    </div>
  );
}

export default LiabilityProfilePage;
