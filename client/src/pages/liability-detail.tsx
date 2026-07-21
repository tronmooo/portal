/**
 * Dedicated profile page for liabilities (mortgage / auto loan / credit card / etc.).
 *
 * Phase 2 scope: Overview · Details · Payments v1 · Amortization tabs.
 * Phase 3+ will layer in payoff calculator, smart actions, viz, linked tabs,
 * documents OCR, calendar auto-events, and subtype-specific UI on top of this.
 */

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
  Home,
  Car,
  GraduationCap,
  AlertTriangle,
  Edit,
  User,
  Camera,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SmartFillTrigger } from "@/components/SmartFillTrigger";
import { BillScheduleSection } from "@/components/liability/BillScheduleSection";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { HistoryTab } from "@/components/ProfileSharedTabs";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import {
  buildAmortization,
  summarizeLiability,
  allocatePayment,
  normalizeAnnualRate,
  type AmortizationRow,
} from "@shared/liability-calc";
import { liabilityFamily, isAmortizable, isRecurringBill } from "@shared/liability-types";
import { liabilityBillStatus, BILL_STATUS_META } from "@shared/liability-status";

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

const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Read a liability term consistently — data lives across many key shapes:
//   * camelCase keys written by LiabilityProfilePage / older flows
//     (currentBalance, monthlyPayment, annualInterestRate)
//   * snake_case keys written by the registry-driven CreateProfileDialog
//     (current_balance, monthly_payment, interest_rate, loan_term_months,
//      start_date, original_balance, extra_payment)
//   * legacy nested paths (fields.loan.*, fields.finance.*)
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
  const currentBalance =
    pick(
      f.currentBalance, f.current_balance,
      f.remainingBalance, f.remaining_balance,
      f.loanBalance, f.loan_balance,
      f.balance,
      finance.currentBalance, finance.current_balance,
      finance.remainingBalance, finance.remaining_balance, finance.balance,
      loan.currentBalance, loan.current_balance,
      loan.remainingBalance, loan.remaining_balance, loan.balance,
    ) || 0;
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
  const annualRate = normalizeAnnualRate(
    f.annualInterestRate ??
    f.annual_interest_rate ??
    f.interestRate ??
    f.interest_rate ??
    f.rate ??
    f.apr ??
    finance.interestRate ??
    finance.interest_rate ??
    finance.apr ??
    loan.interestRate ??
    loan.interest_rate ??
    0,
  );
  const monthlyPayment =
    pick(
      f.monthlyPayment, f.monthly_payment,
      f.minimumPayment, f.minimum_payment, f.min_payment,
      finance.monthlyPayment, finance.monthly_payment,
      loan.monthlyPayment, loan.monthly_payment,
    ) || 0;
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
  | "details"
  | "payments"
  | "documents"
  | "activity"
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
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteProfileDialog, setShowDeleteProfileDialog] = useState(false);
  const [editName, setEditName] = useState<string>(profile.name || "");
  const [editNotes, setEditNotes] = useState<string>((profile as any).notes || "");
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const avatarMutation = useMutation({
    mutationFn: async (base64: string) => {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { avatar: base64 });
    },
    onSuccess: () => {
      toast({ title: "Profile picture updated" });
      invalidateDomains("liabilities");
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

  const editProfileMutation = useMutation({
    mutationFn: async (patch: { name: string; notes: string }) => {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, patch);
    },
    onSuccess: () => {
      toast({ title: "Profile updated" });
      invalidateDomains("liabilities");
      setShowEditDialog(false);
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" }),
  });

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
  const saveTermsMutation = useMutation({
    mutationFn: async () => {
      const fields: Record<string, any> = {};
      const num = (s: string) => (s.trim() === "" ? null : Number(s));
      if (tBalance !== "") fields.currentBalance = num(tBalance);
      if (tOriginal !== "") fields.originalBalance = num(tOriginal);
      if (tRate !== "") {
        // Accept either 6 or 0.06 — store as decimal (0.06) consistent with
        // existing fields.annualInterestRate.
        const r = num(tRate);
        if (r != null) fields.annualInterestRate = r > 1 ? r / 100 : r;
      }
      if (tTerm !== "") fields.remainingTermMonths = num(tTerm);
      if (tMonthly !== "") fields.monthlyPayment = num(tMonthly);
      if (tDueDay !== "") {
        const d = num(tDueDay);
        if (d != null && d >= 1 && d <= 31) fields.dueDay = d;
      }
      if (tFirstPayment !== "") fields.firstPaymentDate = tFirstPayment;
      if (tLender !== "") fields.lender = tLender;
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields });
    },
    onSuccess: () => {
      toast({ title: "Loan terms saved", description: "Calendar will update with the new due date." });
      setEditingTerms(false);
      invalidateDomains("liabilities", "events");
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" }),
  });
  const openTermsEditor = () => {
    setTBalance(terms.currentBalance ? String(terms.currentBalance) : "");
    setTOriginal(terms.originalBalance ? String(terms.originalBalance) : "");
    // annualRate from terms is a percent (e.g. 6 not 0.06) per liability page convention
    setTRate(terms.annualRate ? String(terms.annualRate) : "");
    setTTerm(terms.remainingTermMonths ? String(terms.remainingTermMonths) : "");
    setTMonthly(terms.monthlyPayment ? String(terms.monthlyPayment) : "");
    setTDueDay(terms.dueDay ? String(terms.dueDay) : "");
    setTFirstPayment(terms.firstPaymentDate || "");
    setTLender(terms.lender || "");
    setEditingTerms(true);
  };

  const deleteProfileMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/profiles/${profile.id}`);
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/profiles"], (old: any[]) =>
        old?.filter((p: any) => p.id !== profile.id) || []
      );
      toast({ title: "Profile deleted", description: "All linked data has been removed" });
      invalidateDomains("liabilities", "events", "expenses");
      navigate("/profiles");
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
      // Bug #1 + #15: the "liabilities" + "people" domains cover the liability
      // profile's detail, the profiles list, the dashboard, rel-people, and
      // every affected owner's detail / ["/api/parties", ownerId, "liabilities"]
      // caches via the bus predicate — no per-owner loop needed.
      void affectedOwnerIds;
      invalidateDomains("liabilities", "people");
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
  const subtypeLabel = SUBTYPE_LABELS[subtypeRaw] || "Liability";
  // Behavioral family drives which cards/calcs the page shows. A phone bill is
  // NOT amortized over 360 months (that produced the $0.17/mo bug); only real
  // loans + credit cards run the payoff schedule.
  const family = liabilityFamily(subtypeRaw);
  const amortize = isAmortizable(subtypeRaw);
  const recurringBill = isRecurringBill(subtypeRaw);
  const f2 = (profile.fields || {}) as any;
  const billMonthly = Number(f2.monthlyAmount ?? f2.monthly_amount ?? f2.amount ?? f2.balance ?? f2.cost ?? 0) || 0;
  const billDueRaw = String(f2.dueDate ?? f2.due_date ?? f2.nextDueDate ?? f2.renewalDate ?? "").slice(0, 10);
  const todayISO = new Date().toLocaleDateString("en-CA");
  const billStatus = liabilityBillStatus(billDueRaw, todayISO, false);
  const creditLimit = Number(f2.creditLimit ?? f2.credit_limit ?? 0) || 0;
  const utilizationPct = creditLimit > 0 ? Math.min(999, Math.round((Number(f2.balance ?? f2.currentBalance ?? 0) / creditLimit) * 100)) : 0;

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
  const nextFutureOcc = scheduleOccs.find(
    (o) => o.effectiveDate >= todayISO && o.status !== "paid" && o.status !== "skipped",
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

  // Summary + amortization
  const summary = useMemo(
    () =>
      summarizeLiability({
        currentBalance: terms.currentBalance,
        originalBalance: terms.originalBalance,
        monthlyPayment: terms.monthlyPayment || undefined,
        annualRate: terms.annualRate,
        remainingTermMonths: terms.remainingTermMonths,
        firstPaymentDate: terms.firstPaymentDate,
      }),
    [terms],
  );

  const amortization = useMemo(
    () =>
      buildAmortization({
        currentBalance: terms.currentBalance,
        annualInterestRate: terms.annualRate,
        monthlyPayment: terms.monthlyPayment || undefined,
        remainingTermMonths: terms.remainingTermMonths,
        firstPaymentDate: terms.firstPaymentDate,
      }),
    [terms],
  );

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
    paymentDate: new Date().toISOString().slice(0, 10),
    notes: "",
  });

  function openPaymentDialog(preset: "minimum" | "custom" | "extra" | "interest_only") {
    let initial = "";
    const monthlyInterest = (terms.currentBalance * terms.annualRate) / 12;
    if (preset === "minimum") initial = (terms.monthlyPayment || summary.monthlyPayment || 0).toFixed(2);
    else if (preset === "extra")
      initial = ((terms.monthlyPayment || summary.monthlyPayment || 0) + 100).toFixed(2);
    else if (preset === "interest_only") initial = monthlyInterest.toFixed(2);
    setPaymentDialog({
      open: true,
      preset,
      amount: initial,
      paymentDate: new Date().toISOString().slice(0, 10),
      notes: "",
    });
  }

  // Reverse a payment — deletes the row and adds the principal+fees back to the balance.
  const reversePaymentMutation = useMutation({
    mutationFn: async (payment: LiabilityPayment) => {
      // Restore principal + fees to the balance (interest doesn't change balance,
      // it accrued separately).
      const restoreAmount = (Number(payment.principalPortion) || 0) + (Number(payment.fees) || 0);
      const newBalance = (terms.currentBalance || 0) + restoreAmount;
      await apiRequest("DELETE", `/api/liability-payments/${payment.id}`);
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        fields: {
          ...(profile.fields || {}),
          currentBalance: newBalance,
          remainingBalance: newBalance,
          loanBalance: newBalance,
        },
      });
    },
    onSuccess: () => {
      toast({ title: "Payment reversed" });
      invalidateDomains("liabilities");
    },
    onError: (err: Error) =>
      toast({
        title: "Could not reverse payment",
        description: formatApiError(err),
        variant: "destructive",
      }),
  });

  const recordPaymentMutation = useMutation({
    mutationFn: async (input: {
      amount: number;
      paymentDate: string;
      notes?: string;
    }) => {
      // The server owns the principal/interest split AND the resulting balance
      // (single source of truth). We send only the raw payment; the server
      // computes the rest from the liability's balance + APR and updates the
      // profile balance atomically. See POST /api/liabilities/:id/payments.
      const res = await apiRequest("POST", `/api/liabilities/${profile.id}/payments`, {
        paymentDate: input.paymentDate,
        amount: input.amount,
        notes: input.notes || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      invalidateDomains("liabilities");
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
    });
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="overflow-y-auto h-full pb-24" data-testid="liability-profile-page">
      {/* Hero — matches asset profile header layout */}
      <div className="px-4 md:px-6 pt-4 pb-6" style={{ background: "linear-gradient(135deg, hsl(0 72% 28%), hsl(25 75% 28%))" }}>
        {/* Top bar: back arrow left, owner picker + edit/delete right */}
        <div className="flex items-center justify-between mb-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground"
            onClick={() => navigate("/profiles")}
            data-testid="liability-back"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <div className="flex items-center gap-1.5">
            {/* Owner picker removed from header — the single source of truth
                for owners is the Linked People / Linked Profiles section. */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 bg-background/60 backdrop-blur-sm"
              onClick={() => {
                setEditName(profile.name || "");
                setEditNotes((profile as any).notes || "");
                setShowEditDialog(true);
              }}
              data-testid="button-header-edit-profile"
            >
              <Edit className="h-3 w-3" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 text-destructive hover:text-destructive bg-background/60 backdrop-blur-sm"
              onClick={() => setShowDeleteProfileDialog(true)}
              data-testid="button-delete-profile"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 bg-background/60 backdrop-blur-sm"
              onClick={() => openPaymentDialog("minimum")}
              data-testid="quick-pay-min"
            >
              <Plus className="w-3 h-3" /> Pay
            </Button>
          </div>
        </div>

        {/* Icon + name + badge row */}
        <div className="flex items-start gap-4">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
            data-testid="input-avatar-upload"
          />
          <button
            className="relative rounded-2xl bg-rose-500/10 text-rose-600 flex items-center justify-center overflow-hidden group cursor-pointer shrink-0"
            style={{ width: 56, height: 56 }}
            onClick={() => avatarInputRef.current?.click()}
            disabled={avatarMutation.isPending}
            title="Change profile picture"
            data-testid="button-avatar-upload"
          >
            {(profile as any).avatar ? (
              <img src={(profile as any).avatar} alt={profile.name} className="w-full h-full object-cover" />
            ) : (
              <Wallet className="w-7 h-7" />
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Camera className="h-4 w-4 text-white" />
            </div>
            {avatarMutation.isPending && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <RefreshCw className="h-4 w-4 text-white animate-spin" />
              </div>
            )}
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold" data-testid="liability-title">
              {profile.name || subtypeLabel}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Badge variant="secondary" className="text-xs" data-testid="liability-subtype-badge">
                Liability
              </Badge>
              {subtypeLabel !== "Liability" && (
                <Badge variant="outline" className="text-xs">{subtypeLabel}</Badge>
              )}
            </div>
            {terms.lender ? (
              <div className="text-sm text-muted-foreground mt-0.5">
                {terms.lender}
                {terms.accountNumberLast4 ? ` · ····${terms.accountNumberLast4}` : ""}
              </div>
            ) : null}
          </div>
        </div>

        {/* Quick stats — Docs + Payments count, matching asset stat cards */}
        <div className="grid grid-cols-2 gap-2 mt-4">
          <div className="text-center py-2 rounded-lg bg-background/60 backdrop-blur-sm">
            <p className="text-lg font-semibold tabular-nums">{payments.length}</p>
            <p className="text-xs text-muted-foreground">Payments</p>
          </div>
          <div className="text-center py-2 rounded-lg bg-background/60 backdrop-blur-sm">
            <p className="text-lg font-semibold tabular-nums">
              {recurringBill
                ? (seriesComplete ? "Complete" : BILL_STATUS_META[billStatusEff].label)
                : summary.remainingMonths > 0 ? `${summary.remainingMonths} mo` : "Paid"}
            </p>
            <p className="text-xs text-muted-foreground">{recurringBill ? "Status" : "Remaining"}</p>
          </div>
        </div>

        {/* KPI strip — type-aware. Amortizing/revolving loans show payoff math;
            recurring bills show monthly + due + status; one-time debt shows the
            balance owed. Recurring bills NEVER show APR/payoff (the $0.17 bug). */}
        {recurringBill ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
            <KpiTile label={`${cap(billFrequencyLabel)} amount`} value={fmtUSDShort(schedule?.amount ?? billMonthly)} icon={<DollarSign className="w-4 h-4" />} testid="kpi-bill-monthly" />
            <KpiTile
              label={seriesComplete ? "Ended" : "Next due"}
              value={seriesComplete ? "Complete" : (billNextDueEff ? fmtDate(billNextDueEff) : "—")}
              sub={billStatusEff === "due_today" ? "today" : undefined}
              icon={<CalendarIcon className="w-4 h-4" />}
              testid="kpi-bill-due"
            />
            <KpiTile
              label="Remaining"
              value={billRemainingTerm != null ? `${billRemainingTerm} of ${billTotalTerm}` : "Ongoing"}
              sub={billRemainingTerm != null ? "payments" : "no end date"}
              icon={<TrendingDown className="w-4 h-4" />}
              testid="kpi-bill-remaining"
            />
            <KpiTile label="Autopay" value={(f2.autopay || f2.autoRenew) ? "On" : "Off"} icon={<Percent className="w-4 h-4" />} testid="kpi-bill-autopay" />
          </div>
        ) : family === "revolving" ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
            <KpiTile label="Balance" value={fmtUSDShort(summary.currentBalance)} icon={<DollarSign className="w-4 h-4" />} testid="kpi-balance" />
            <KpiTile label="Available" value={creditLimit > 0 ? fmtUSDShort(Math.max(0, creditLimit - summary.currentBalance)) : "—"} icon={<CalendarIcon className="w-4 h-4" />} testid="kpi-available" />
            <KpiTile label="Utilization" value={creditLimit > 0 ? `${utilizationPct}%` : "—"} icon={<Percent className="w-4 h-4" />} testid="kpi-utilization" />
            <KpiTile label="Min payment" value={fmtUSDShort(terms.minimumPayment || summary.monthlyPayment)} icon={<TrendingDown className="w-4 h-4" />} testid="kpi-min-payment" />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
            <KpiTile
              label={family === "one_time" ? "Amount owed" : "Current balance"}
              value={fmtUSDShort(summary.currentBalance)}
              icon={<DollarSign className="w-4 h-4" />}
              testid="kpi-balance"
            />
            <KpiTile
              label="Monthly payment"
              value={amortize && summary.monthlyPayment > 0 ? fmtUSDShort(summary.monthlyPayment) : "—"}
              icon={<CalendarIcon className="w-4 h-4" />}
              testid="kpi-monthly"
            />
            <KpiTile label="APR" value={summary.annualRate > 0 ? fmtPct(summary.annualRate) : "—"} icon={<Percent className="w-4 h-4" />} testid="kpi-apr" />
            <KpiTile
              label="Payoff"
              value={amortize && summary.remainingMonths > 0 ? `${summary.remainingMonths} mo` : "—"}
              sub={amortize && summary.remainingMonths > 0 ? fmtDate(summary.payoffDate) : undefined}
              icon={<TrendingDown className="w-4 h-4" />}
              testid="kpi-payoff"
            />
          </div>
        )}
        {!recurringBill && summary.originalBalance > 0 && (
          <div className="mt-3" data-testid="liability-progress">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Paid down</span>
              <span>{summary.payoffProgressPct.toFixed(1)}%</span>
            </div>
            <Progress value={summary.payoffProgressPct} className="h-2" />
          </div>
        )}
        {/* Recurring bill with a finite term — show progress toward completion
            (paid of total), never amortizing payoff. Open-ended bills omit it. */}
        {recurringBill && billTotalTerm != null && billTotalTerm > 0 && (
          <div className="mt-3" data-testid="bill-term-progress">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>{billPaidCount} of {billTotalTerm} payments{missedCount > 0 ? ` · ${missedCount} missed` : ""}</span>
              <span>{billProgressPct}%</span>
            </div>
            <Progress value={billProgressPct} className="h-2" />
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="px-4 md:px-6 pt-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} data-testid="liability-tabs">
          <div className="overflow-x-auto pb-1 border-b border-border/50 -mx-1 px-1" style={{ WebkitOverflowScrolling: "touch" as any }}>
            <TabsList className="inline-flex h-8 w-max gap-0.5 p-0.5 bg-muted/50">
              <TabsTrigger value="overview" className="text-xs px-3 whitespace-nowrap" data-testid="tab-overview">Overview</TabsTrigger>
              <TabsTrigger value="details" className="text-xs px-3 whitespace-nowrap" data-testid="tab-details">Details</TabsTrigger>
              <TabsTrigger value="payments" className="text-xs px-3 whitespace-nowrap" data-testid="tab-payments">Payments</TabsTrigger>
              <TabsTrigger value="documents" className="text-xs px-3 whitespace-nowrap" data-testid="tab-documents">Docs</TabsTrigger>
              <TabsTrigger value="activity" className="text-xs px-3 whitespace-nowrap" data-testid="tab-activity">Activity</TabsTrigger>
              <TabsTrigger value="history" className="text-xs px-3 whitespace-nowrap" data-testid="tab-history">History</TabsTrigger>
            </TabsList>
          </div>

          {/* OVERVIEW */}
          <TabsContent value="overview" className="mt-4 space-y-4">
            {/* AI insights card */}
            <AISummaryCard profileId={profile.id} />

            {/* Linked assets — surfaced near the top for parity with asset profiles */}
            <section data-testid="overview-linked-assets">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Linked assets</p>
              <LinkedAssetsCard liabilityId={profile.id} />
            </section>

            {/* Ownership — fractional owner shares, atomic + validated. Same
                slider-based editor as the asset overview, pointed at the
                liability junction table. The previous "Add Linked Person"
                modal incrementally inserted rows that tripped the DB-side
                >100 guard the moment a co-owner was added on top of an
                existing 100% link. PUT /api/profiles/:id/liability-owners
                replaces the whole set atomically, validates total=100, and
                writes phases that never grow the running sum past the
                guardrail. */}
            <section data-testid="overview-ownership">
              <OwnershipEditor
                profile={profile as any}
                allProfiles={(ownerCandidates || []) as any}
                onSaved={() => { /* React Query invalidations handled inside OwnershipEditor */ }}
                kind="liability"
              />
            </section>

            {/* Linked people — non-owner roles (co_signer, guarantor, etc.)
                still live here. Ownership shares are managed by the editor
                above; this section shows everyone else attached to the
                liability (and on a fresh liability, it's how you add the
                first owner since the dialog also surfaces the role). */}
            <section data-testid="overview-linked-people">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Linked people</p>
              <LinkedPeopleTab
                profileId={profile.id}
                profileType={profile.type}
                onChanged={() => { /* React Query invalidations handled inside */ }}
              />
            </section>

            {/* Subtype-specific overview */}
            <SubtypeOverview
              subtype={subtypeRaw}
              terms={terms}
              liabilityId={profile.id}
              onJumpLinked={() => setTab("payments")}
            />

            {/* Payment mechanics + payoff math belong to DEBT (amortizing /
                one-time), not recurring bills. A bill pays through its Schedule &
                Calendar (below) and has no interest / payoff / amortization, so
                hide this whole block for recurring bills — it must never show
                Cost-of-borrowing, "360 months remaining", or a Recent-payments
                card on a subscription. */}
            {!recurringBill && (<>
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

            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Cost of borrowing</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Remaining interest"
                    value={fmtUSD(summary.totalRemainingInterest)} />
                  <Row label="Interest paid (history)"
                    value={fmtUSD(interestPaidToDate)} />
                  <Row label="Total payments made"
                    value={fmtUSD(paymentsTotal)} />
                  <Row label="Original balance"
                    value={summary.originalBalance ? fmtUSD(summary.originalBalance) : "—"} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Schedule</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Next payment due"
                    value={summary.remainingMonths > 0 ? fmtDate(amortization.rows[0]?.dueDate) : "—"} />
                  <Row label="Payoff date"
                    value={summary.remainingMonths > 0 ? fmtDate(summary.payoffDate) : "Paid off"} />
                  <Row label="Months remaining"
                    value={summary.remainingMonths > 0 ? `${summary.remainingMonths}` : "0"} />
                  <Row label="Lender" value={terms.lender || "—"} />
                </CardContent>
              </Card>
            </div>

            {/* Recent payments preview */}
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-base">Recent payments</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setTab("payments")}>
                  See all
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </CardHeader>
              <CardContent>
                {paymentsQuery.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : payments.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-3" data-testid="no-payments">
                    No payments recorded yet. Use a quick action above to log one.
                  </div>
                ) : (
                  <div className="divide-y">
                    {payments.slice(0, 5).map((p) => (
                      <PaymentRow key={p.id} p={p} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            </>)}

            {/* Nested sections — mirroring asset Overview layout (Linked Assets is now surfaced near the top) */}
            <section className="mt-6">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Nested Liabilities</p>
              <NestedLiabilitiesCard liabilityId={profile.id} />
            </section>

            {/* EVERY liability gets a Schedule & Calendar (bills, loans, cards
                all look the same) — payment dates on a month calendar plus the
                per-payment list. Placed at the bottom, below the AI summary. */}
            <BillScheduleSection liabilityId={profile.id} />
          </TabsContent>

          {/* DETAILS */}
          <TabsContent value="details" className="mt-4">
            {recurringBill ? (
              <Card data-testid="bill-details-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Bill details</CardTitle>
                </CardHeader>
                <CardContent className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <Row label="Type" value={subtypeLabel} />
                  <Row label="Recurring amount" value={fmtUSD(schedule?.amount ?? billMonthly)} />
                  <Row label="Frequency" value={cap(billFrequencyLabel)} />
                  <Row label="Next scheduled due" value={seriesComplete ? "Complete" : fmtDate(billNextDueEff)} />
                  <Row label="Payment status" value={seriesComplete ? "Complete" : BILL_STATUS_META[billStatusEff].label} />
                  <Row label="First payment" value={fmtDate(schedule?.firstPayment ?? terms.firstPaymentDate)} />
                  {/* Total obligation term + remaining, so the duration is always
                      explicit and consistent with the header + schedule. Recurring
                      bills NEVER show amortizing months / projected payoff. */}
                  <Row label="Total term" value={billTotalTerm != null ? `${billTotalTerm} payment${billTotalTerm === 1 ? "" : "s"}` : "Ongoing (no end date)"} />
                  <Row label="Remaining" value={billRemainingTerm != null ? `${billRemainingTerm} of ${billTotalTerm} payments` : "Ongoing"} />
                  <Row label="Payments made" value={String(billPaidCount)} />
                  {missedCount > 0 && <Row label="Missed" value={`${missedCount}`} />}
                  <Row label="Annual total" value={schedule?.annualTotal != null ? fmtUSD(schedule.annualTotal) : "—"} />
                  <Row label="Reminder" value={billReminderLead != null ? `${billReminderLead} day${billReminderLead === 1 ? "" : "s"} before` : "None"} />
                  <Row label="Ends" value={schedule?.recurrenceEnd ? fmtDate(schedule.recurrenceEnd) : "No end date"} />
                  <Row label="Autopay" value={(f2.autopay || f2.autoRenew) ? "On" : "Off"} />
                </CardContent>
              </Card>
            ) : editingTerms ? (
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Edit loan terms</CardTitle>
                  <Button size="sm" variant="ghost" onClick={() => setEditingTerms(false)} data-testid="button-cancel-terms-edit">
                    Cancel
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid md:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Lender / creditor</Label>
                      <Input value={tLender} onChange={(e) => setTLender(e.target.value)} placeholder="e.g. Chase Auto" data-testid="input-terms-lender" />
                    </div>
                    <div>
                      <Label className="text-xs">Current balance ($)</Label>
                      <Input type="number" inputMode="decimal" step="0.01" value={tBalance} onChange={(e) => setTBalance(e.target.value)} placeholder="e.g. 25000" data-testid="input-terms-balance" />
                    </div>
                    <div>
                      <Label className="text-xs">Original balance ($)</Label>
                      <Input type="number" inputMode="decimal" step="0.01" value={tOriginal} onChange={(e) => setTOriginal(e.target.value)} placeholder="e.g. 35000" data-testid="input-terms-original" />
                    </div>
                    <div>
                      <Label className="text-xs">Annual interest rate (%)</Label>
                      <Input type="number" inputMode="decimal" step="0.01" value={tRate} onChange={(e) => setTRate(e.target.value)} placeholder="e.g. 6.5" data-testid="input-terms-rate" />
                    </div>
                    <div>
                      <Label className="text-xs">Monthly payment ($)</Label>
                      <Input type="number" inputMode="decimal" step="0.01" value={tMonthly} onChange={(e) => setTMonthly(e.target.value)} placeholder="e.g. 1000" data-testid="input-terms-monthly" />
                    </div>
                    <div>
                      <Label className="text-xs">Remaining term (months)</Label>
                      <Input type="number" inputMode="numeric" value={tTerm} onChange={(e) => setTTerm(e.target.value)} placeholder="e.g. 60" data-testid="input-terms-term" />
                    </div>
                    <div>
                      <Label className="text-xs">Due day of month (1–31)</Label>
                      <Input type="number" inputMode="numeric" min={1} max={31} value={tDueDay} onChange={(e) => setTDueDay(e.target.value)} placeholder="e.g. 15" data-testid="input-terms-due-day" />
                    </div>
                    <div>
                      <Label className="text-xs">First payment date</Label>
                      <Input type="date" value={tFirstPayment} onChange={(e) => setTFirstPayment(e.target.value)} data-testid="input-terms-first-payment" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Setting a monthly payment and due day creates a recurring bill that lands on your calendar each month.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => saveTermsMutation.mutate()}
                      disabled={saveTermsMutation.isPending}
                      data-testid="button-save-terms"
                    >
                      {saveTermsMutation.isPending ? "Saving…" : "Save terms"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingTerms(false)} data-testid="button-cancel-terms-edit-2">
                      Cancel
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Loan terms</CardTitle>
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={openTermsEditor} data-testid="button-edit-terms">
                    <Edit className="h-3 w-3" /> Edit
                  </Button>
                </CardHeader>
                <CardContent className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <Row label="Subtype" value={subtypeLabel} />
                  <Row label="Lender / creditor" value={terms.lender || "—"} />
                  <Row label="Account ····" value={terms.accountNumberLast4 || "—"} />
                  <Row label="Original balance" value={terms.originalBalance ? fmtUSD(terms.originalBalance) : "—"} />
                  <Row label="Current balance" value={fmtUSD(terms.currentBalance)} />
                  <Row label="Annual interest rate" value={fmtPct(terms.annualRate)} />
                  <Row label="Monthly payment" value={fmtUSD(terms.monthlyPayment || summary.monthlyPayment)} />
                  {/* BUG-L01: split the single "Remaining term" row into two
                      labelled values so the user can tell which is the contract
                      term they entered vs which is the calculated payoff. The
                      old single row showed "50 mo" while the header KPI showed
                      "58 mo" with no explanation. */}
                  <Row label="Original term (contract)"
                    value={terms.remainingTermMonths ? `${terms.remainingTermMonths} mo` : "—"} />
                  <Row label="Projected payoff (calculated)"
                    value={summary.remainingMonths ? `${summary.remainingMonths} mo` : "—"} />
                  <Row label="First payment date" value={fmtDate(terms.firstPaymentDate)} />
                  <Row label="Due day of month"
                    value={terms.dueDay ? `Day ${terms.dueDay}` : "—"} />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* PAYMENTS — unified tab: payment history + payoff calculator + amortization schedule */}
          <TabsContent value="payments" className="mt-4 space-y-6">
            {/* Section 1: Payment history */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-0.5">Payment History</p>
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

            {/* Section 2: Payoff Calculator — only for amortizing/revolving debt.
                Recurring bills + generic one-time debt don't have a payoff
                schedule; showing one produced the $0.17/360-month nonsense. */}
            {amortize && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Payoff Calculator</p>
              <PayoffCalculator terms={terms} baseSummary={summary} />
            </div>
            )}

            {/* Section 3: Amortization Schedule (amortizing debt only) */}
            {amortize && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Amortization Schedule</p>
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Amortization schedule</CardTitle>
                  <div className="text-xs text-muted-foreground">
                    {amortization.rows.length} period{amortization.rows.length === 1 ? "" : "s"} ·
                    total interest {fmtUSD(amortization.totalInterest)}
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

          {/* DOCUMENTS */}
          <TabsContent value="documents" className="mt-4">
            <LiabilityDocumentsCard liabilityId={profile.id} liabilityName={profile.name} />
          </TabsContent>

          {/* ACTIVITY */}
          <TabsContent value="activity" className="mt-4">
            <ActivityTimelineCard
              profileId={profile.id}
              payments={payments}
            />
          </TabsContent>

          {/* HISTORY */}
          <TabsContent value="history" className="mt-4 px-1 sm:px-0">
            <HistoryTab profileId={profile.id} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Quick payment dialog */}
      {/* U3: when the dialog closes, reset state to defaults so the next open
         doesn't show stale amount/date/notes from the previous attempt. We
         keep the preset stable across closes since it's set by the opener. */}
      <Dialog open={paymentDialog.open} onOpenChange={(o) => setPaymentDialog((s) => o ? { ...s, open: o } : {
        open: false,
        preset: s.preset,
        amount: "",
        paymentDate: new Date().toISOString().slice(0, 10),
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
                  const split = allocatePayment(amt, terms.currentBalance, terms.annualRate, 0);
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

      {/* Edit profile dialog — name + notes only; deeper field edits live on the Details tab */}
      {/* U8: re-seed the form from the current profile every time the dialog
         opens. Without this, opening the dialog after the profile mutated
         elsewhere (e.g. an AI update) would show the old name/notes. */}
      <Dialog open={showEditDialog} onOpenChange={(o) => {
        if (o) {
          setEditName(profile.name || "");
          setEditNotes((profile as any).notes || "");
        }
        setShowEditDialog(o);
      }}>
        <DialogContent data-testid="dialog-edit-liability-profile">
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>Update the liability name and notes.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="liability-edit-name" className="text-xs">Name</Label>
              <Input
                id="liability-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                data-testid="input-edit-name"
              />
            </div>
            <div>
              <Label htmlFor="liability-edit-notes" className="text-xs">Notes</Label>
              <Textarea
                id="liability-edit-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={4}
                data-testid="input-edit-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowEditDialog(false)}>Cancel</Button>
            <Button
              onClick={() => editProfileMutation.mutate({ name: editName.trim() || profile.name, notes: editNotes })}
              disabled={editProfileMutation.isPending || !editName.trim()}
              data-testid="button-save-edit-profile"
            >
              {editProfileMutation.isPending ? "Saving…" : "Save"}
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
              This will permanently delete this liability and all its data. This action cannot be undone.
            </AlertDialogDescription>
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

function KpiTile({
  label,
  value,
  sub,
  icon,
  testid,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="rounded-xl border border-card-border p-3 bg-card card-lift transition-all" data-testid={testid}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="metric-value text-lg mt-1 leading-tight">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground mt-0.5">{sub}</div> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value}</span>
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
  return (
    <div className="px-3 py-2 flex items-center justify-between gap-3" data-testid={`payment-row-${p.id}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{fmtUSD(Number(p.amount) || 0)}</div>
        <div className="text-xs text-muted-foreground">{fmtDate(p.paymentDate)}</div>
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
        {expanded && onReverse ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onReverse}
            disabled={reversing}
            title="Reverse this payment"
            data-testid={`reverse-payment-${p.id}`}
          >
            {reversing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
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
          <div className="grid md:grid-cols-2 gap-3">
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
      <div className="grid md:grid-cols-2 gap-3">
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
    <div className="rounded-lg border p-3 bg-card" data-testid={testid}>
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

function LinkedAssetsCard({ liabilityId }: { liabilityId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
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
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)}>
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
        <Button size="icon" variant="ghost" onClick={onDelete} data-testid="asset-link-delete" aria-label="Unlink asset">
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
      invalidateDomains("liabilities", "people");
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
      invalidateDomains("liabilities", "people");
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
              className="ml-2 text-[10px]"
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
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)}>
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
        <Button size="icon" variant="ghost" onClick={onDelete} data-testid="party-link-delete">
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
  const nestedLiabilities = useMemo(() => {
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
    return (data.nodes || []).filter((n) => {
      if (!reachable.has(n.id)) return false;
      const tk = (n.typeKey || n.type || "").toLowerCase();
      return liabTypes.has(tk);
    });
  }, [graphQuery.data, liabilityId]);

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
      invalidateDomains("profiles"); // covers the relationships graph + profiles list
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
        <div className="text-sm text-muted-foreground py-4 text-center" data-testid="nested-liabilities-empty">
          No nested liabilities yet.
        </div>
      ) : (
        <div className="flex flex-wrap gap-3" data-testid="nested-liabilities-list">
          {nestedLiabilities.map((node) => {
            const tk = (node.typeKey || node.type || "").toLowerCase();
            const typeLabel = SUBTYPE_LABELS_LOCAL[tk] || "Liability";
            return (
              <div
                key={node.id}
                style={{ height: 160 }}
                className="w-40 shrink-0 rounded-xl border bg-card p-3 flex flex-col justify-between cursor-pointer hover:bg-accent transition-colors"
                onClick={() => navigate(`/profiles/${node.id}`)}
                data-testid={`nested-liability-${node.id}`}
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-rose-500/10 text-rose-600">
                  <Wallet className="w-5 h-5" />
                </div>
                <div className="mt-2 min-w-0">
                  <div className="font-medium text-sm truncate">{node.name}</div>
                  <Badge variant="secondary" className="text-[10px] mt-1">{typeLabel}</Badge>
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

function LiabilityDocumentsCard({ liabilityId, liabilityName }: { liabilityId: string; liabilityName: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onSuccess: () => {
      toast({ title: "Document deleted" });
      invalidateDomains("documents", "profiles");
    },
    onError: (err: Error) =>
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" }),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    e.target.value = "";
  }

  const docs = docsQuery.data || [];

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
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  data-testid={`liability-doc-view-${doc.id}`}
                >
                  <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noopener noreferrer">
                    View
                  </a>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => deleteMutation.mutate(doc.id)}
                  data-testid={`liability-doc-delete-${doc.id}`}
                >
                  <Trash2 className="w-4 h-4 text-rose-500" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
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
}

function AISummaryCard({ profileId }: { profileId: string }) {
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
            Generated {fmtTimeAgo(new Date(aiSummary.generatedAt))}
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

// ─── Phase 5: Subtype-specific overview blocks ───────────────────────────────

interface SubtypeOverviewProps {
  subtype: string;
  terms: ReturnType<typeof readTerms>;
  liabilityId: string;
  onJumpLinked: () => void;
}

function SubtypeOverview({
  subtype,
  terms,
  liabilityId,
  onJumpLinked,
}: SubtypeOverviewProps) {
  if (subtype === "credit_card") {
    return <CreditCardOverview terms={terms} />;
  }
  if (subtype === "mortgage") {
    return <MortgageOverview terms={terms} liabilityId={liabilityId} onJumpLinked={onJumpLinked} />;
  }
  if (subtype === "auto_loan") {
    return <AutoLoanOverview terms={terms} liabilityId={liabilityId} onJumpLinked={onJumpLinked} />;
  }
  if (subtype === "student_loan") {
    return <StudentLoanOverview terms={terms} />;
  }
  return null;
}

// Credit card: utilization gauge + minimum payment + no fixed term
function CreditCardOverview({ terms }: { terms: ReturnType<typeof readTerms> }) {
  const utilizationPct =
    terms.creditLimit > 0
      ? Math.min(100, (terms.currentBalance / terms.creditLimit) * 100)
      : 0;
  const utilizationStatus =
    utilizationPct >= 80
      ? { label: "Very high", color: "text-red-500", bg: "bg-red-500" }
      : utilizationPct >= 30
      ? { label: "Watch out", color: "text-orange-500", bg: "bg-orange-500" }
      : { label: "Healthy", color: "text-emerald-500", bg: "bg-emerald-500" };
  const availableCredit = Math.max(0, terms.creditLimit - terms.currentBalance);
  const minPayment = terms.minimumPayment || (terms.currentBalance * 0.02);

  return (
    <Card data-testid="subtype-credit-card">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-rose-600" />
          <CardTitle className="text-base">Credit card snapshot</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {terms.creditLimit > 0 ? (
          <div data-testid="cc-utilization">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="font-medium">Credit utilization</span>
              <span className={`font-semibold ${utilizationStatus.color}`}>
                {utilizationPct.toFixed(1)}% · {utilizationStatus.label}
              </span>
            </div>
            <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full ${utilizationStatus.bg} transition-all`}
                style={{ width: `${utilizationPct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>{fmtUSD(terms.currentBalance)} used</span>
              <span>{fmtUSD(terms.creditLimit)} limit</span>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-xs text-muted-foreground rounded-md border border-dashed p-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <span>Add a credit limit in Details to see utilization.</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <KpiTile
            label="Available"
            value={terms.creditLimit > 0 ? fmtUSDShort(availableCredit) : "—"}
            testid="cc-available"
          />
          <KpiTile
            label="Min payment"
            value={fmtUSDShort(minPayment)}
            testid="cc-min-payment"
          />
          <KpiTile
            label="APR"
            value={fmtPct(terms.annualRate)}
            testid="cc-apr"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Credit cards are revolving — no fixed term. Pay above the minimum to avoid compounding interest.
        </p>
      </CardContent>
    </Card>
  );
}

// Mortgage: property + escrow fields
function MortgageOverview({
  terms,
  liabilityId,
  onJumpLinked,
}: {
  terms: ReturnType<typeof readTerms>;
  liabilityId: string;
  onJumpLinked: () => void;
}) {
  const linkedAssetsQuery = useQuery<any[]>({
    queryKey: [`/api/liabilities/${liabilityId}/assets`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/liabilities/${liabilityId}/assets`);
      return res.json();
    },
    enabled: !!liabilityId,
  });
  const property = (linkedAssetsQuery.data || []).find(
    (a: any) => a.profile?.type === "property" || a.profile?.type === "real_estate",
  );

  return (
    <Card data-testid="subtype-mortgage">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Home className="w-4 h-4 text-rose-600" />
          <CardTitle className="text-base">Mortgage snapshot</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {property ? (
          <button
            type="button"
            onClick={onJumpLinked}
            className="w-full text-left rounded-lg border bg-muted/30 px-3 py-2 hover:bg-muted/50 transition"
            data-testid="mortgage-property-tile"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted-foreground">Linked property</div>
                <div className="font-medium">{property.profile?.name || "Property"}</div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={onJumpLinked}
            className="w-full text-left rounded-lg border border-dashed px-3 py-2 hover:bg-muted/30 transition"
            data-testid="mortgage-property-tile-empty"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <Link2 className="w-4 h-4" />
              <span className="text-xs">Link the property this mortgage finances →</span>
            </div>
          </button>
        )}
        <div className="grid md:grid-cols-2 gap-x-6 gap-y-1">
          <Row label="Property address" value={terms.propertyAddress || "—"} />
          <Row label="Escrow / month" value={terms.escrowMonthly ? fmtUSD(terms.escrowMonthly) : "—"} />
          <Row label="Property taxes (yr)" value={terms.propertyTaxes ? fmtUSD(terms.propertyTaxes) : "—"} />
          <Row label="Homeowners insurance" value={terms.homeownersInsurance ? fmtUSD(terms.homeownersInsurance) : "—"} />
        </div>
      </CardContent>
    </Card>
  );
}

// Auto loan: vehicle tile prominent
function AutoLoanOverview({
  terms,
  liabilityId,
  onJumpLinked,
}: {
  terms: ReturnType<typeof readTerms>;
  liabilityId: string;
  onJumpLinked: () => void;
}) {
  const linkedAssetsQuery = useQuery<any[]>({
    queryKey: [`/api/liabilities/${liabilityId}/assets`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/liabilities/${liabilityId}/assets`);
      return res.json();
    },
    enabled: !!liabilityId,
  });
  const vehicle = (linkedAssetsQuery.data || []).find(
    (a: any) => a.profile?.type === "vehicle",
  );
  const vehicleSummary = [terms.vehicleYear, terms.vehicleMake, terms.vehicleModel]
    .filter(Boolean)
    .join(" ");

  return (
    <Card data-testid="subtype-auto-loan">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Car className="w-4 h-4 text-rose-600" />
          <CardTitle className="text-base">Auto loan snapshot</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {vehicle ? (
          <button
            type="button"
            onClick={onJumpLinked}
            className="w-full text-left rounded-lg border bg-muted/30 px-3 py-2 hover:bg-muted/50 transition"
            data-testid="auto-vehicle-tile"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted-foreground">Linked vehicle</div>
                <div className="font-medium">{vehicle.profile?.name || vehicleSummary || "Vehicle"}</div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={onJumpLinked}
            className="w-full text-left rounded-lg border border-dashed px-3 py-2 hover:bg-muted/30 transition"
            data-testid="auto-vehicle-tile-empty"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <Link2 className="w-4 h-4" />
              <span className="text-xs">Link the vehicle this loan financed →</span>
            </div>
          </button>
        )}
        <div className="grid md:grid-cols-2 gap-x-6 gap-y-1">
          <Row label="Vehicle" value={vehicleSummary || "—"} />
          <Row label="VIN" value={terms.vehicleVin || "—"} />
        </div>
      </CardContent>
    </Card>
  );
}

// Student loan: forgiveness fields
function StudentLoanOverview({ terms }: { terms: ReturnType<typeof readTerms> }) {
  return (
    <Card data-testid="subtype-student-loan">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <GraduationCap className="w-4 h-4 text-rose-600" />
          <CardTitle className="text-base">Student loan snapshot</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid md:grid-cols-2 gap-x-6 gap-y-1">
          <Row
            label="PSLF eligible"
            value={
              terms.pslfEligible ? (
                <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600">
                  Yes
                </Badge>
              ) : (
                "No"
              )
            }
          />
          <Row label="IDR plan" value={terms.idrPlan || "—"} />
          <Row label="Forgiveness date" value={terms.forgivenessDate ? fmtDate(terms.forgivenessDate) : "—"} />
        </div>
        <p className="text-xs text-muted-foreground">
          PSLF (Public Service Loan Forgiveness) and income-driven repayment plans can dramatically alter your payoff timeline. Track eligibility here.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Phase 5: Activity timeline tab ──────────────────────────────────────────

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
        timestamp: new Date(ts).toISOString(),
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
          timestamp: new Date(d.createdAt || d.uploadedAt || Date.now()).toISOString(),
        });
      }
      for (const e of detail.relatedEvents || []) {
        out.push({
          id: `evt-${e.id}`,
          type: "event",
          title: e.title || "Event",
          description: e.description || undefined,
          timestamp: new Date(e.startTime || e.start || e.createdAt || Date.now()).toISOString(),
        });
      }
      for (const t of detail.relatedTasks || []) {
        out.push({
          id: `task-${t.id}`,
          type: "task",
          title: t.title || "Task",
          description: t.description || undefined,
          timestamp: new Date(t.dueDate || t.createdAt || Date.now()).toISOString(),
        });
      }
      for (const o of detail.relatedObligations || []) {
        out.push({
          id: `obl-${o.id}`,
          type: "obligation",
          title: o.title || "Obligation",
          description: o.description || undefined,
          timestamp: new Date(o.dueDate || o.createdAt || Date.now()).toISOString(),
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

  // Group by Today / Yesterday / This Week / Earlier
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).getTime();
  const groups: { label: string; items: ActivityEntry[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const e of entries.slice(0, 100)) {
    const d = e.timestamp.slice(0, 10);
    const t = new Date(e.timestamp).getTime();
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
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
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
          {new Date(entry.timestamp).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
      <Badge variant="secondary" className="text-xs capitalize shrink-0 h-fit">
        {entry.type}
      </Badge>
    </div>
  );
}

export default LiabilityProfilePage;
