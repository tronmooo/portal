// NOTE: This component is part of the Profile Type Registry system.
// It was built but not yet integrated into the main UI.
// The legacy tab system in profile-detail.tsx is the active system.
// Integration planned for a future release.

/**
 * DynamicProfileDetail
 *
 * Reads a profile's TypeDefinition and renders tabs driven by tab_config.
 * - Null engine → overview with key-value field display + inline edit
 * - String engine → EngineRenderer with the tab's field_map
 * - Always includes Documents sub-section and Activity/Timeline section
 */

import React, { useRef, useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Edit,
  FileText,
  Activity,
  Upload,
  Eye,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  AlertCircle,
  ArrowLeft,
  Pencil,
  Check,
  X,
  Trash2,
  Clock,
  DollarSign,
  ListTodo,
  Calendar,
  Heart,
  CreditCard,
  ExternalLink,
  Plus,
  Wrench,
  Navigation,
  Home,
  Building,
  Users,
  PawPrint,
  TrendingUp,
  Shield,
  RefreshCw,
  Car,
  MapPin,
  Stethoscope,
  Pill,
  BarChart2,
  Landmark,
  BadgeCheck,
  AlertTriangle,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import DynamicProfileForm from "./DynamicProfileForm";
import type { FieldDef } from "./DynamicProfileForm";
import type { TypeDefinition } from "./ProfileTypeSelector";
import { EngineRenderer } from "@/components/engines";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface DynamicProfileDetailProps {
  profile: any; // ProfileDetail from the API
  typeDef: TypeDefinition;
  onChanged: () => void;
}

interface TabConfig {
  key: string;
  label: string;
  engine: string | null;
  field_map?: Record<string, string>;
  icon?: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function formatValue(val: any, fieldDef?: FieldDef): string {
  if (val == null || val === "") return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (fieldDef?.type === "currency") {
    const num = Number(val);
    if (!isNaN(num)) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
  }
  if (fieldDef?.type === "percentage") {
    return `${val}%`;
  }
  if (fieldDef?.type === "date" && val) {
    try {
      return new Date(val).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch { return String(val); }
  }
  return String(val);
}

function timelineIcon(type: string) {
  const map: Record<string, React.ElementType> = {
    tracker: Activity,
    expense: DollarSign,
    task: ListTodo,
    event: Calendar,
    document: FileText,
    note: FileText,
    habit: Heart,
    obligation: CreditCard,
  };
  const Icon = map[type] || Clock;
  return <Icon className="h-3.5 w-3.5" />;
}

function getExpirationStatus(doc: any): "expired" | "soon" | "ok" | null {
  const expField = doc.extractedData?.expirationDate || doc.extractedData?.expiry || doc.extractedData?.expiration;
  if (!expField) return null;
  const exp = new Date(expField as string);
  if (isNaN(exp.getTime())) return null;
  const diffDays = (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return "expired";
  if (diffDays <= 30) return "soon";
  return "ok";
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ─────────────────────────────────────────────
// Category detection
// ─────────────────────────────────────────────

function getTypeCategory(typeDef: TypeDefinition): string {
  const typeKey = (typeDef.type_key ?? "").toLowerCase();
  const label = (typeDef.label ?? "").toLowerCase();
  const category = (typeDef.category ?? "").toLowerCase();
  const combined = `${typeKey} ${label} ${category}`;
  if (combined.includes("vehicle") || combined.includes("car") || combined.includes("truck") || combined.includes("motorcycle") || combined.includes("boat")) return "vehicle";
  if (combined.includes("property") || combined.includes("home") || combined.includes("real estate") || combined.includes("house") || combined.includes("apartment") || combined.includes("condo")) return "property";
  if (combined.includes("pet") || combined.includes("dog") || combined.includes("cat") || combined.includes("animal")) return "pet";
  if (combined.includes("person") || combined.includes("contact") || combined.includes("self") || combined.includes("family") || combined.includes("friend")) return "person";
  if (combined.includes("liabilit") || combined.includes("loan") || combined.includes("debt") || combined.includes("mortgage") || combined.includes("credit")) return "liability";
  if (combined.includes("subscription") || combined.includes("service") || combined.includes("saas")) return "subscription";
  if (combined.includes("insurance") || combined.includes("policy")) return "insurance";
  if (combined.includes("investment") || combined.includes("stock") || combined.includes("brokerage") || combined.includes("portfolio") || combined.includes("crypto")) return "investment";
  return "generic";
}

// ─────────────────────────────────────────────
// Computed field helpers
// ─────────────────────────────────────────────

function computeFields(profile: any): Record<string, any> {
  const docs: any[] = profile.relatedDocuments ?? profile.documents ?? [];
  const expenses: any[] = profile.relatedExpenses ?? profile.expenses ?? [];
  const tasks: any[] = profile.relatedTasks ?? profile.tasks ?? [];
  const timeline: any[] = profile.timeline ?? profile.recentActivity ?? [];
  const fields = profile.fields ?? {};

  const now = Date.now();
  const oneDay = 1000 * 60 * 60 * 24;

  // Documents
  const docCount = docs.length;
  const expiringDocs = docs.filter((d) => {
    const exp = d.extractedData?.expirationDate || d.extractedData?.expiry || d.extractedData?.expiration;
    if (!exp) return false;
    const expDate = new Date(exp as string);
    if (isNaN(expDate.getTime())) return false;
    const diff = (expDate.getTime() - now) / oneDay;
    return diff >= 0 && diff <= 30;
  }).length;
  const recentUploads = docs.filter((d) => {
    const created = new Date(d.createdAt);
    return (now - created.getTime()) / oneDay <= 7;
  }).length;

  // Expenses
  const totalSpent = expenses.reduce((sum: number, e: any) => {
    const amt = parseFloat(e.amount ?? e.value ?? 0);
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);
  const fuelCosts = expenses
    .filter((e: any) => {
      const desc = ((e.description ?? e.category ?? e.title ?? "") as string).toLowerCase();
      return desc.includes("fuel") || desc.includes("gas") || desc.includes("petrol");
    })
    .reduce((sum: number, e: any) => sum + parseFloat(e.amount ?? e.value ?? 0), 0);

  // Equity
  const marketValue = parseFloat(fields.market_value ?? fields.current_value ?? fields.value ?? 0);
  const loanBalance = parseFloat(fields.loan_balance ?? fields.balance ?? 0);
  const equity = marketValue - loanBalance;

  // Mileage-based cost per mile
  const mileage = parseFloat(fields.mileage ?? fields.odometer ?? 0);
  const costPerMile = mileage > 0 ? totalSpent / mileage : null;

  // Tasks / Maintenance
  const maintenanceTasks = tasks.filter((t: any) => {
    const title = ((t.title ?? t.name ?? "") as string).toLowerCase();
    return title.includes("service") || title.includes("oil") || title.includes("maintenan") || title.includes("inspect") || title.includes("repair") || title.includes("check");
  });
  const lastServiceTask = maintenanceTasks
    .filter((t: any) => t.completedAt || t.dueDate)
    .sort((a: any, b: any) => new Date(b.completedAt ?? b.dueDate).getTime() - new Date(a.completedAt ?? a.dueDate).getTime())[0];
  const nextDueTask = tasks
    .filter((t: any) => !t.completedAt && t.dueDate && new Date(t.dueDate).getTime() > now)
    .sort((a: any, b: any) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0];

  const lastServiceDate = lastServiceTask
    ? new Date(lastServiceTask.completedAt ?? lastServiceTask.dueDate)
    : null;

  // Trips this week
  const oneWeekAgo = now - 7 * oneDay;
  const tripsThisWeek = timeline.filter((e: any) => {
    const ts = new Date(e.timestamp ?? e.date ?? 0).getTime();
    const type = (e.type ?? "").toLowerCase();
    return ts >= oneWeekAgo && (type.includes("trip") || type.includes("drive") || type.includes("travel"));
  }).length;

  // Service visits
  const serviceVisits = timeline.filter((e: any) => {
    const type = ((e.type ?? e.title ?? "") as string).toLowerCase();
    return type.includes("service") || type.includes("maintenan") || type.includes("inspect");
  }).length;

  // Upcoming events
  const upcomingEvents = tasks.filter((t: any) => !t.completedAt && t.dueDate && new Date(t.dueDate).getTime() > now).length;

  // Last active
  const lastActive = timeline.length > 0
    ? new Date(timeline.reduce((latest: any, e: any) => {
        const ts = new Date(e.timestamp ?? e.date ?? 0).getTime();
        return ts > new Date(latest.timestamp ?? latest.date ?? 0).getTime() ? e : latest;
      }, timeline[0]).timestamp ?? timeline[0].date)
    : null;

  // Rental income
  const rentalIncome = expenses
    .filter((e: any) => {
      const desc = ((e.description ?? e.category ?? e.title ?? "") as string).toLowerCase();
      return desc.includes("rent") || desc.includes("income") || desc.includes("revenue");
    })
    .reduce((sum: number, e: any) => sum + parseFloat(e.amount ?? e.value ?? 0), 0);

  // Vet / health visits
  const vetVisits = timeline.filter((e: any) => {
    const type = ((e.type ?? e.title ?? "") as string).toLowerCase();
    return type.includes("vet") || type.includes("health") || type.includes("doctor") || type.includes("medical");
  }).length;

  // Loan payments
  const monthlyPayment = parseFloat(fields.monthly_payment ?? fields.payment ?? 0);
  const totalLoan = parseFloat(fields.loan_amount ?? fields.original_amount ?? fields.principal ?? 0);
  const paidOff = totalLoan > 0 && loanBalance >= 0 ? Math.round(((totalLoan - loanBalance) / totalLoan) * 100) : null;

  // Next billing
  const nextBilling = fields.next_billing_date ?? fields.renewal_date ?? fields.next_payment_date ?? null;

  // Claims
  const claims = expenses.filter((e: any) => {
    const desc = ((e.description ?? e.category ?? e.title ?? "") as string).toLowerCase();
    return desc.includes("claim");
  }).length;

  return {
    _docCount: docCount,
    _expiringDocs: expiringDocs > 0 ? `${expiringDocs} expiring soon` : "None",
    _recentUploads: recentUploads,
    _totalSpent: totalSpent,
    _fuelCosts: fuelCosts,
    _equity: equity,
    _costPerMile: costPerMile,
    _tripsThisWeek: tripsThisWeek,
    _lastService: lastServiceDate,
    _nextDue: nextDueTask ? (nextDueTask.title ?? "Task due") + " · " + new Date(nextDueTask.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null,
    _serviceVisits: serviceVisits,
    _upcomingEvents: upcomingEvents,
    _lastActive: lastActive,
    _rentalIncome: rentalIncome,
    _vetVisits: vetVisits,
    _paidOffPct: paidOff !== null ? `${paidOff}%` : null,
    _monthlyPayment: monthlyPayment || null,
    _loanBalance: loanBalance || null,
    _nextBilling: nextBilling,
    _claims: claims,
    _taskCount: tasks.length,
  };
}

// ─────────────────────────────────────────────
// Widget field formatters
// ─────────────────────────────────────────────

type FieldFormat = "currency" | "number" | "relative" | "date" | "percent" | "text";

interface WidgetField {
  label: string;
  key: string;
  format?: FieldFormat;
  status?: (val: any) => "ok" | "warn" | "error" | null;
}

interface WidgetDef {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  color: string; // Tailwind color class for icon bg
  tab?: string; // tab key to navigate to
  fields: WidgetField[];
}

function formatWidgetValue(val: any, format?: FieldFormat): string {
  if (val == null || val === "" || val === 0 && format === "currency") return "—";
  if (format === "currency") {
    const num = Number(val);
    if (!isNaN(num) && num !== 0) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
    return "—";
  }
  if (format === "number") {
    const num = Number(val);
    if (!isNaN(num)) return new Intl.NumberFormat("en-US").format(num);
    return String(val);
  }
  if (format === "relative" && val instanceof Date) {
    if (isNaN(val.getTime())) return "—";
    const diffDays = Math.floor((Date.now() - val.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}yr ago`;
  }
  if (format === "date" && val) {
    try {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch { /* */ }
  }
  if (format === "percent") return `${val}%`;
  if (val === null || val === undefined) return "—";
  return String(val) || "—";
}

// ─────────────────────────────────────────────
// WIDGET_CONFIGS
// ─────────────────────────────────────────────

const WIDGET_CONFIGS: Record<string, WidgetDef[]> = {
  vehicle: [
    {
      title: "Service & Condition",
      subtitle: "Maintenance, inspections, repairs",
      icon: Wrench,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "maintenance",
      fields: [
        { label: "Mileage", key: "mileage", format: "number" },
        { label: "Condition", key: "condition" },
        { label: "Last service", key: "_lastService", format: "relative" },
        { label: "Next due", key: "_nextDue" },
      ],
    },
    {
      title: "Finance & Loans",
      subtitle: "Payments, equity, cost/mile",
      icon: DollarSign,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "finance",
      fields: [
        { label: "Total spent", key: "_totalSpent", format: "currency" },
        { label: "Equity", key: "_equity", format: "currency" },
        { label: "Cost / mile", key: "_costPerMile", format: "currency" },
        { label: "Fuel costs", key: "_fuelCosts", format: "currency" },
      ],
    },
    {
      title: "Title & Docs",
      subtitle: "Registration, insurance, title",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Usage & Trips",
      subtitle: "Mileage, fuel, trips",
      icon: Navigation,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Trips this week", key: "_tripsThisWeek", format: "number" },
        { label: "Total miles", key: "total_miles", format: "number" },
        { label: "Odometer", key: "odometer", format: "number" },
      ],
    },
  ],
  property: [
    {
      title: "Maintenance",
      subtitle: "Condition, inspections, systems",
      icon: Wrench,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "maintenance",
      fields: [
        { label: "Condition", key: "condition" },
        { label: "Last inspection", key: "last_inspection_date", format: "date" },
        { label: "Open tasks", key: "_taskCount", format: "number" },
        { label: "Service visits", key: "_serviceVisits", format: "number" },
      ],
    },
    {
      title: "Mortgage & Equity",
      subtitle: "Payments, equity, rental income",
      icon: Landmark,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "finance",
      fields: [
        { label: "Current value", key: "market_value", format: "currency" },
        { label: "Equity", key: "_equity", format: "currency" },
        { label: "Total spent", key: "_totalSpent", format: "currency" },
        { label: "Rental income", key: "_rentalIncome", format: "currency" },
      ],
    },
    {
      title: "Deeds & Contracts",
      subtitle: "Documents, title, permits",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Property Activity",
      subtitle: "Service visits, upcoming, last active",
      icon: Activity,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Service visits", key: "_serviceVisits", format: "number" },
        { label: "Upcoming tasks", key: "_upcomingEvents", format: "number" },
        { label: "Last active", key: "_lastActive", format: "relative" },
      ],
    },
  ],
  person: [
    {
      title: "Health Summary",
      subtitle: "Medical, conditions, medications",
      icon: Stethoscope,
      color: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      tab: "health",
      fields: [
        { label: "Blood type", key: "blood_type" },
        { label: "Allergies", key: "allergies" },
        { label: "Primary care", key: "primary_physician" },
        { label: "Last checkup", key: "last_checkup_date", format: "date" },
      ],
    },
    {
      title: "Finance",
      subtitle: "Income, expenses, accounts",
      icon: DollarSign,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "finance",
      fields: [
        { label: "Total spent", key: "_totalSpent", format: "currency" },
        { label: "Documents", key: "_docCount", format: "number" },
      ],
    },
    {
      title: "Documents",
      subtitle: "IDs, records, certificates",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Activity",
      subtitle: "Events, notes, interactions",
      icon: Activity,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "activity",
      fields: [
        { label: "Upcoming events", key: "_upcomingEvents", format: "number" },
        { label: "Last active", key: "_lastActive", format: "relative" },
      ],
    },
  ],
  pet: [
    {
      title: "Health & Vet",
      subtitle: "Checkups, vaccinations, meds",
      icon: Stethoscope,
      color: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      tab: "health",
      fields: [
        { label: "Species", key: "species" },
        { label: "Breed", key: "breed" },
        { label: "Vet visits", key: "_vetVisits", format: "number" },
        { label: "Last vet visit", key: "last_vet_date", format: "date" },
      ],
    },
    {
      title: "Care Schedule",
      subtitle: "Feeding, grooming, exercise",
      icon: Calendar,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "care",
      fields: [
        { label: "Open tasks", key: "_taskCount", format: "number" },
        { label: "Upcoming", key: "_upcomingEvents", format: "number" },
        { label: "Next due", key: "_nextDue" },
      ],
    },
    {
      title: "Documents",
      subtitle: "Records, vaccination, license",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Activity",
      subtitle: "Walks, events, interactions",
      icon: Activity,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Last active", key: "_lastActive", format: "relative" },
        { label: "Total expenses", key: "_totalSpent", format: "currency" },
      ],
    },
  ],
  liability: [
    {
      title: "Payment Schedule",
      subtitle: "Monthly payments, due dates",
      icon: Calendar,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "payments",
      fields: [
        { label: "Monthly payment", key: "monthly_payment", format: "currency" },
        { label: "Interest rate", key: "interest_rate", format: "percent" },
        { label: "Next due", key: "_nextDue" },
        { label: "Next billing", key: "_nextBilling", format: "date" },
      ],
    },
    {
      title: "Payoff Progress",
      subtitle: "Balance, equity, paid off",
      icon: TrendingUp,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "finance",
      fields: [
        { label: "Current balance", key: "balance", format: "currency" },
        { label: "Original amount", key: "loan_amount", format: "currency" },
        { label: "Paid off", key: "_paidOffPct" },
        { label: "Total paid", key: "_totalSpent", format: "currency" },
      ],
    },
    {
      title: "Documents",
      subtitle: "Agreements, statements, notices",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "History",
      subtitle: "Payment history, activity",
      icon: Activity,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Last active", key: "_lastActive", format: "relative" },
        { label: "Upcoming tasks", key: "_upcomingEvents", format: "number" },
      ],
    },
  ],
  subscription: [
    {
      title: "Billing",
      subtitle: "Cost, cycle, next payment",
      icon: CreditCard,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "billing",
      fields: [
        { label: "Amount", key: "amount", format: "currency" },
        { label: "Frequency", key: "billing_cycle" },
        { label: "Next billing", key: "_nextBilling", format: "date" },
        { label: "Total paid", key: "_totalSpent", format: "currency" },
      ],
    },
    {
      title: "Plan Details",
      subtitle: "Tier, features, limits",
      icon: BadgeCheck,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "details",
      fields: [
        { label: "Plan", key: "plan" },
        { label: "Status", key: "status" },
        { label: "Category", key: "category" },
        { label: "Provider", key: "provider" },
      ],
    },
    {
      title: "Documents",
      subtitle: "Receipts, contracts, invoices",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "History",
      subtitle: "Renewals, changes, activity",
      icon: RefreshCw,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Last active", key: "_lastActive", format: "relative" },
        { label: "Upcoming", key: "_upcomingEvents", format: "number" },
      ],
    },
  ],
  insurance: [
    {
      title: "Coverage",
      subtitle: "Limits, deductible, premium",
      icon: Shield,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "coverage",
      fields: [
        { label: "Premium", key: "premium", format: "currency" },
        { label: "Deductible", key: "deductible", format: "currency" },
        { label: "Coverage limit", key: "coverage_limit", format: "currency" },
        { label: "Policy type", key: "policy_type" },
      ],
    },
    {
      title: "Claims",
      subtitle: "Filed claims, status, amounts",
      icon: AlertTriangle,
      color: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      tab: "claims",
      fields: [
        { label: "Claims filed", key: "_claims", format: "number" },
        { label: "Total claimed", key: "_totalSpent", format: "currency" },
      ],
    },
    {
      title: "Documents",
      subtitle: "Policy, cards, correspondence",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Renewal",
      subtitle: "Dates, changes, history",
      icon: RefreshCw,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "activity",
      fields: [
        { label: "Next renewal", key: "renewal_date", format: "date" },
        { label: "Last active", key: "_lastActive", format: "relative" },
      ],
    },
  ],
  investment: [
    {
      title: "Performance",
      subtitle: "Value, returns, gains",
      icon: TrendingUp,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "performance",
      fields: [
        { label: "Current value", key: "current_value", format: "currency" },
        { label: "Cost basis", key: "cost_basis", format: "currency" },
        { label: "Return %", key: "return_pct", format: "percent" },
        { label: "Equity", key: "_equity", format: "currency" },
      ],
    },
    {
      title: "Holdings",
      subtitle: "Positions, allocation, type",
      icon: BarChart2,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "holdings",
      fields: [
        { label: "Account type", key: "account_type" },
        { label: "Institution", key: "institution" },
        { label: "Ticker", key: "ticker" },
        { label: "Shares", key: "shares" },
      ],
    },
    {
      title: "Documents",
      subtitle: "Statements, tax docs, agreements",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Activity",
      subtitle: "Transactions, events, notes",
      icon: Activity,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Last active", key: "_lastActive", format: "relative" },
        { label: "Total invested", key: "_totalSpent", format: "currency" },
      ],
    },
  ],
  generic: [
    {
      title: "Details",
      subtitle: "Key information",
      icon: FileText,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      tab: "overview",
      fields: [
        { label: "Status", key: "status" },
        { label: "Category", key: "category" },
        { label: "Created", key: "created_at", format: "date" },
      ],
    },
    {
      title: "Finance",
      subtitle: "Costs, payments, expenses",
      icon: DollarSign,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tab: "finance",
      fields: [
        { label: "Total spent", key: "_totalSpent", format: "currency" },
      ],
    },
    {
      title: "Documents",
      subtitle: "Files, records, uploads",
      icon: FileText,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      tab: "documents",
      fields: [
        { label: "Total documents", key: "_docCount", format: "number" },
        { label: "Expiring soon", key: "_expiringDocs" },
        { label: "Recent uploads", key: "_recentUploads", format: "number" },
      ],
    },
    {
      title: "Activity",
      subtitle: "Events, notes, timeline",
      icon: Activity,
      color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tab: "activity",
      fields: [
        { label: "Last active", key: "_lastActive", format: "relative" },
        { label: "Upcoming tasks", key: "_upcomingEvents", format: "number" },
      ],
    },
  ],
};

// ─────────────────────────────────────────────
// ProfileOverviewHeader
// ─────────────────────────────────────────────

function getHeaderConfig(typeDef: TypeDefinition, category: string): {
  primaryField: string | null;
  primaryLabel: string;
  secondaryField: string | null;
  secondaryLabel: string;
  valueField: string | null;
  valueLabel: string;
  valueFormat: FieldFormat;
  badgeField: string | null;
  badgeLabel: string;
} {
  switch (category) {
    case "vehicle":
      return {
        primaryField: "make", primaryLabel: "Make",
        secondaryField: "model", secondaryLabel: "Model",
        valueField: "current_value", valueLabel: "Current Value", valueFormat: "currency",
        badgeField: "year", badgeLabel: "Year",
      };
    case "property":
      return {
        primaryField: "address", primaryLabel: "Address",
        secondaryField: "property_type", secondaryLabel: "Type",
        valueField: "market_value", valueLabel: "Market Value", valueFormat: "currency",
        badgeField: "property_type", badgeLabel: "Type",
      };
    case "person":
      return {
        primaryField: "relationship", primaryLabel: "Relationship",
        secondaryField: "email", secondaryLabel: "Email",
        valueField: null, valueLabel: "", valueFormat: "text",
        badgeField: "relationship", badgeLabel: "Relationship",
      };
    case "pet":
      return {
        primaryField: "species", primaryLabel: "Species",
        secondaryField: "breed", secondaryLabel: "Breed",
        valueField: null, valueLabel: "", valueFormat: "text",
        badgeField: "species", badgeLabel: "Species",
      };
    case "liability":
      return {
        primaryField: "lender", primaryLabel: "Lender",
        secondaryField: "loan_type", secondaryLabel: "Type",
        valueField: "balance", valueLabel: "Balance", valueFormat: "currency",
        badgeField: "loan_type", badgeLabel: "Type",
      };
    case "subscription":
      return {
        primaryField: "provider", primaryLabel: "Provider",
        secondaryField: "billing_cycle", secondaryLabel: "Cycle",
        valueField: "amount", valueLabel: "Amount", valueFormat: "currency",
        badgeField: "billing_cycle", badgeLabel: "Cycle",
      };
    case "insurance":
      return {
        primaryField: "insurer", primaryLabel: "Insurer",
        secondaryField: "policy_type", secondaryLabel: "Policy Type",
        valueField: "premium", valueLabel: "Premium", valueFormat: "currency",
        badgeField: "policy_type", badgeLabel: "Policy",
      };
    case "investment":
      return {
        primaryField: "institution", primaryLabel: "Institution",
        secondaryField: "account_type", secondaryLabel: "Account Type",
        valueField: "current_value", valueLabel: "Current Value", valueFormat: "currency",
        badgeField: "account_type", badgeLabel: "Account",
      };
    default:
      return {
        primaryField: "type", primaryLabel: "Type",
        secondaryField: "category", secondaryLabel: "Category",
        valueField: null, valueLabel: "", valueFormat: "text",
        badgeField: "status", badgeLabel: "Status",
      };
  }
}

function getCategoryIcon(category: string): React.ElementType {
  const icons: Record<string, React.ElementType> = {
    vehicle: Car,
    property: Home,
    person: Users,
    pet: PawPrint,
    liability: Landmark,
    subscription: RefreshCw,
    insurance: Shield,
    investment: TrendingUp,
    generic: FileText,
  };
  return icons[category] ?? FileText;
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    vehicle: "Asset · Vehicle",
    property: "Asset · Property",
    person: "Contact · Person",
    pet: "Asset · Pet",
    liability: "Liability",
    subscription: "Subscription",
    insurance: "Insurance",
    investment: "Investment",
    generic: "Profile",
  };
  return labels[category] ?? "Profile";
}

function getConditionBadgeClass(condition: string | undefined): string {
  if (!condition) return "";
  const c = condition.toLowerCase();
  if (c.includes("excel") || c.includes("new") || c.includes("great")) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (c.includes("good")) return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
  if (c.includes("fair") || c.includes("ok")) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  if (c.includes("poor") || c.includes("bad")) return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
  return "bg-secondary text-secondary-foreground";
}

function ProfileOverviewHeader({
  profile,
  typeDef,
  onEdit,
}: {
  profile: any;
  typeDef: TypeDefinition;
  onEdit: () => void;
}) {
  const fields = profile.fields ?? {};
  const category = getTypeCategory(typeDef);
  const config = getHeaderConfig(typeDef, category);
  const CategoryIcon = getCategoryIcon(category);
  const categoryLabel = getCategoryLabel(category);

  const primaryVal = config.primaryField ? (fields[config.primaryField] ?? null) : null;
  const secondaryVal = config.secondaryField ? (fields[config.secondaryField] ?? null) : null;
  const valueVal = config.valueField ? (fields[config.valueField] ?? null) : null;
  const badgeVal = config.badgeField ? (fields[config.badgeField] ?? null) : null;
  const condition = fields.condition ?? null;

  const subtitle = [primaryVal, secondaryVal].filter(Boolean).join(" · ") || typeDef.label;

  return (
    <Card className="overflow-hidden">
      <div className="h-1.5 w-full bg-gradient-to-r from-primary/60 via-primary/30 to-transparent" />
      <CardContent className="p-4">
        <div className="flex items-start gap-4">
          {/* Icon */}
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <CategoryIcon className="h-6 w-6 text-primary" />
          </div>

          {/* Main info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold leading-tight truncate">{profile.name}</h2>
                {subtitle && subtitle !== typeDef.label && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>
                )}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <Badge variant="secondary" className="text-xs font-medium">
                    {categoryLabel}
                  </Badge>
                  {badgeVal && badgeVal !== secondaryVal && (
                    <Badge variant="outline" className="text-xs">
                      {String(badgeVal)}
                    </Badge>
                  )}
                  {condition && (
                    <Badge variant="outline" className={`text-xs ${getConditionBadgeClass(condition)}`}>
                      {condition}
                    </Badge>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 shrink-0"
                onClick={onEdit}
              >
                <Edit className="h-3 w-3" />
                Edit
              </Button>
            </div>

            {/* Key value + parent link */}
            {(valueVal || profile.parentProfile) && (
              <div className="mt-3 flex items-center gap-4 flex-wrap">
                {valueVal && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">{config.valueLabel}</p>
                    <p className="text-sm font-semibold tabular-nums">
                      {formatWidgetValue(valueVal, config.valueFormat)}
                    </p>
                  </div>
                )}
                {profile.parentProfile && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Linked Profile</p>
                    <Link href={`/profiles/${profile.parentProfile.id}`}>
                      <a className="text-xs text-primary hover:underline flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" />
                        {profile.parentProfile.name}
                      </a>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Notes snippet */}
        {profile.notes && (
          <p className="mt-3 text-xs text-muted-foreground line-clamp-2 border-t border-border pt-3">
            {profile.notes}
          </p>
        )}

        {/* Tags */}
        {profile.tags && profile.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {profile.tags.map((tag: string) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────
// SummaryWidgetGrid
// ─────────────────────────────────────────────

function SummaryWidgetGrid({
  profile,
  typeDef,
  onNavigateTab,
  availableTabs,
}: {
  profile: any;
  typeDef: TypeDefinition;
  onNavigateTab: (tab: string) => void;
  availableTabs: string[];
}) {
  const category = getTypeCategory(typeDef);
  const widgets = WIDGET_CONFIGS[category] ?? WIDGET_CONFIGS["generic"];
  const computed = React.useMemo(() => computeFields(profile), [profile]);
  const fields = { ...(profile.fields ?? {}), ...computed };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {widgets.map((widget) => {
        const Icon = widget.icon;
        // Resolve the target tab: find a tab whose key or label matches
        const targetTab = widget.tab
          ? availableTabs.find((t) =>
              t === widget.tab ||
              t.toLowerCase().includes((widget.tab ?? "").toLowerCase()) ||
              (widget.tab ?? "").toLowerCase().includes(t.toLowerCase())
            ) ?? null
          : null;

        return (
          <div
            key={widget.title}
            className="rounded-xl border bg-card p-4 cursor-pointer hover:bg-muted/30 transition-colors relative group"
            onClick={() => targetTab && onNavigateTab(targetTab)}
            role={targetTab ? "button" : undefined}
            tabIndex={targetTab ? 0 : undefined}
            onKeyDown={(e) => {
              if (targetTab && (e.key === "Enter" || e.key === " ")) onNavigateTab(targetTab);
            }}
          >
            {/* Top row: icon + title + chevron */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${widget.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold leading-tight">{widget.title}</p>
                  <p className="text-xs text-muted-foreground leading-tight mt-0.5">{widget.subtitle}</p>
                </div>
              </div>
              {targetTab && (
                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0 mt-0.5" />
              )}
            </div>

            {/* Key-value rows */}
            <div className="space-y-0">
              {widget.fields.map((field, i) => {
                const rawVal = fields[field.key];
                const displayVal = formatWidgetValue(rawVal, field.format);
                const isEmpty = displayVal === "—";
                return (
                  <div
                    key={field.key}
                    className={`flex items-center justify-between py-1.5 ${
                      i < widget.fields.length - 1 ? "border-b border-border/60" : ""
                    }`}
                  >
                    <span className="text-xs text-muted-foreground">{field.label}</span>
                    <span className={`text-xs font-medium tabular-nums ${
                      isEmpty ? "text-muted-foreground/50" : ""
                    }`}>
                      {displayVal}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// InlineEditField
// ─────────────────────────────────────────────

function InlineEditField({
  profileId,
  fieldKey,
  fieldValue,
  allFields,
  onSaved,
}: {
  profileId: string;
  fieldKey: string;
  fieldValue: string;
  allFields: Record<string, any>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fieldValue);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: async (newVal: string) => {
      const num = Number(newVal);
      const parsed =
        newVal !== "" && !isNaN(num) && newVal.trim() !== "" ? num : newVal;
      const res = await apiRequest("PATCH", `/api/profiles/${profileId}`, {
        fields: { ...allFields, [fieldKey]: parsed },
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      setEditing(false);
      onSaved();
    },
    onError: () => {
      toast({ title: "Failed to update", variant: "destructive" });
      setValue(fieldValue);
      setEditing(false);
    },
  });

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSave = () => {
    if (value.trim() === fieldValue) { setEditing(false); return; }
    mutation.mutate(value.trim());
  };

  if (editing) {
    return (
      <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 gap-2">
        <span className="text-xs text-muted-foreground shrink-0">{formatKey(fieldKey)}</span>
        <div className="flex items-center gap-1 flex-1 justify-end">
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") { setValue(fieldValue); setEditing(false); }
            }}
            className="h-7 text-xs text-right max-w-[200px]"
          />
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleSave} disabled={mutation.isPending}>
            <Check className="h-3 w-3 text-green-500" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { setValue(fieldValue); setEditing(false); }}>
            <X className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors group">
      <span className="text-xs text-muted-foreground shrink-0 min-w-[80px] cursor-pointer" onClick={() => setEditing(true)}>
        {formatKey(fieldKey)}
      </span>
      <div className="flex items-center gap-1.5 min-w-0 justify-end">
        <span className="text-sm font-medium text-right break-words cursor-pointer" onClick={() => setEditing(true)}>
          {fieldValue}
        </span>
        <Pencil className="h-2.5 w-2.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 cursor-pointer" onClick={() => setEditing(true)} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// InlineField — lightweight per-field inline edit
// ─────────────────────────────────────────────

function InlineField({
  label,
  value,
  fieldKey,
  profileId,
  allFields,
  onSaved,
}: {
  label: string;
  value: string;
  fieldKey: string;
  profileId: string;
  allFields: Record<string, any>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const { toast } = useToast();

  const save = async () => {
    const trimmed = draft.trim();
    if (trimmed === (value || "")) { setEditing(false); return; }
    try {
      const num = Number(trimmed);
      const parsed = trimmed !== "" && !isNaN(num) ? num : trimmed;
      await apiRequest("PATCH", `/api/profiles/${profileId}`, {
        fields: { ...allFields, [fieldKey]: parsed },
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      setEditing(false);
      onSaved();
    } catch {
      toast({ title: "Failed to update field", variant: "destructive" });
      setDraft(value || "");
      setEditing(false);
    }
  };

  React.useEffect(() => { setDraft(value || ""); }, [value]);

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-1 border-b border-border/50 last:border-0">
        <span className="text-xs text-muted-foreground shrink-0 min-w-[90px]">{label}</span>
        <Input
          className="h-6 text-xs flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
          }}
          autoFocus
        />
        <Button size="sm" className="h-6 text-xs px-2" onClick={save}>Save</Button>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { setDraft(value || ""); setEditing(false); }}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0 group cursor-pointer hover:bg-muted/30 -mx-2 px-2 rounded transition-colors"
      onClick={() => setEditing(true)}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums group-hover:text-primary transition-colors">
        {value || <span className="text-muted-foreground/40">—</span>}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────
// ExpandableSection
// ─────────────────────────────────────────────

interface ExpandableSectionProps {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  iconColor: string;
  badge?: { label: string; color: string };
  summaryItems: { label: string; value: string }[];
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function ExpandableSection({
  title,
  subtitle,
  icon: Icon,
  iconColor,
  badge,
  summaryItems,
  children,
  defaultOpen = false,
}: ExpandableSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {/* Icon */}
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconColor}`}>
          <Icon className="h-4 w-4" />
        </div>

        {/* Title + subtitle */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold leading-tight">{title}</p>
            {badge && (
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${badge.color}`}>
                {badge.label}
              </span>
            )}
          </div>
          <p className="text-xs-loose text-muted-foreground leading-tight mt-0.5 truncate">{subtitle}</p>
        </div>

        {/* Summary pills — shown when collapsed */}
        {!open && summaryItems.length > 0 && (
          <div className="hidden sm:flex items-center gap-3 shrink-0">
            {summaryItems.slice(0, 3).map((item) => (
              <div key={item.label} className="text-right">
                <p className="text-xs text-muted-foreground leading-tight">{item.label}</p>
                <p className="text-xs font-semibold tabular-nums leading-tight">{item.value || "—"}</p>
              </div>
            ))}
          </div>
        )}

        {/* Chevron */}
        <div className="shrink-0 ml-1">
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-border">
          <div className="px-4 py-3 space-y-1">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// QuickActionBar — ghost buttons shown at bottom of expanded section
// ─────────────────────────────────────────────

function QuickActionBar({ actions }: { actions: { label: string; icon: React.ElementType; onClick: () => void }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-2 mt-1 border-t border-border/50">
      {actions.map((action) => {
        const ActionIcon = action.icon;
        return (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1 text-xs-loose text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-dashed border-border hover:border-border/80 hover:bg-muted/40 transition-colors"
          >
            <ActionIcon className="h-3 w-3" />
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// ExpandableProfileSections
// ─────────────────────────────────────────────

function ExpandableProfileSections({
  profile,
  typeDef,
  onChanged,
}: {
  profile: any;
  typeDef: TypeDefinition;
  onChanged: () => void;
}) {
  const category = getTypeCategory(typeDef);
  const computed = React.useMemo(() => computeFields(profile), [profile]);
  const fields: Record<string, any> = { ...(profile.fields ?? {}), ...computed };
  const allProfileFields = profile.fields ?? {};
  const profileId = String(profile.id);

  const docs: any[] = profile.relatedDocuments ?? profile.documents ?? [];
  const expenses: any[] = profile.relatedExpenses ?? profile.expenses ?? [];
  const tasks: any[] = profile.relatedTasks ?? profile.tasks ?? [];
  const trackers: any[] = profile.relatedTrackers ?? profile.trackers ?? [];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(f);
        });
      const fileData = await toBase64(file);
      const res = await apiRequest("POST", "/api/upload", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onChanged();
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const fmt = (key: string, format?: FieldFormat): string => {
    const val = fields[key];
    return formatWidgetValue(val, format);
  };

  // Helper: age from birthday
  const computeAge = (birthdayField: string): string => {
    const bday = fields[birthdayField];
    if (!bday) return "—";
    try {
      const d = new Date(bday as string);
      if (isNaN(d.getTime())) return "—";
      const ageDiff = Date.now() - d.getTime();
      const ageDate = new Date(ageDiff);
      return String(Math.abs(ageDate.getUTCFullYear() - 1970));
    } catch { return "—"; }
  };

  const openTaskCount = tasks.filter((t: any) => !t.completedAt).length;
  const overdueTaskCount = tasks.filter((t: any) => !t.completedAt && t.dueDate && new Date(t.dueDate).getTime() < Date.now()).length;
  const expiringDocCount = docs.filter((d: any) => {
    const exp = d.extractedData?.expirationDate || d.extractedData?.expiry || d.extractedData?.expiration;
    if (!exp) return false;
    const expDate = new Date(exp as string);
    if (isNaN(expDate.getTime())) return false;
    const diff = (expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 30;
  }).length;

  const monthlyExpenses = expenses.length > 0
    ? computed._totalSpent / Math.max(1, Math.ceil((Date.now() - Math.min(...expenses.map((e: any) => new Date(e.date ?? e.createdAt ?? Date.now()).getTime()))) / (1000 * 60 * 60 * 24 * 30)))
    : 0;

  // ── section builder helpers ──

  function fieldsBlock(fieldList: { key: string; label: string }[]) {
    return (
      <div>
        {fieldList.map(({ key, label }) => (
          <InlineField
            key={key}
            label={label}
            value={formatValue(allProfileFields[key])}
            fieldKey={key}
            profileId={profileId}
            allFields={allProfileFields}
            onSaved={onChanged}
          />
        ))}
      </div>
    );
  }

  function expensesList() {
    if (expenses.length === 0) {
      return <p className="text-xs text-muted-foreground py-2">No expenses recorded.</p>;
    }
    return (
      <div className="space-y-1">
        {expenses.slice(0, 8).map((e: any, i: number) => {
          const amt = parseFloat(e.amount ?? e.value ?? 0);
          return (
            <div key={e.id ?? i} className="flex items-center justify-between py-1 border-b border-border/50 last:border-0">
              <span className="text-xs truncate flex-1">{e.description ?? e.title ?? e.category ?? "Expense"}</span>
              <span className="text-xs font-semibold tabular-nums ml-3 shrink-0">
                {isNaN(amt) ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amt)}
              </span>
            </div>
          );
        })}
        {expenses.length > 8 && (
          <p className="text-xs text-muted-foreground pt-1">+{expenses.length - 8} more</p>
        )}
      </div>
    );
  }

  function tasksList() {
    const open = tasks.filter((t: any) => !t.completedAt);
    if (open.length === 0) {
      return <p className="text-xs text-muted-foreground py-2">No open tasks.</p>;
    }
    return (
      <div className="space-y-1">
        {open.slice(0, 6).map((t: any, i: number) => (
          <div key={t.id ?? i} className="flex items-center gap-2 py-1 border-b border-border/50 last:border-0">
            <div className="w-3 h-3 rounded-full border border-muted-foreground/50 shrink-0" />
            <span className="text-xs flex-1 truncate">{t.title ?? t.name ?? "Task"}</span>
            {t.dueDate && (
              <span className={`text-xs shrink-0 ${
                new Date(t.dueDate).getTime() < Date.now() ? "text-destructive" : "text-muted-foreground"
              }`}>
                {new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
        ))}
        {open.length > 6 && (
          <p className="text-xs text-muted-foreground pt-1">+{open.length - 6} more</p>
        )}
      </div>
    );
  }

  function docsList() {
    if (docs.length === 0) {
      return <p className="text-xs text-muted-foreground py-2">No documents attached.</p>;
    }
    return (
      <div className="space-y-1">
        {docs.slice(0, 6).map((d: any, i: number) => (
          <div key={d.id ?? i} className="flex items-center gap-2 py-1 border-b border-border/50 last:border-0">
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs flex-1 truncate">{d.name ?? "Document"}</span>
            {d.type && (
              <Badge variant="secondary" className="text-xs capitalize shrink-0">{d.type}</Badge>
            )}
          </div>
        ))}
        {docs.length > 6 && (
          <p className="text-xs text-muted-foreground pt-1">+{docs.length - 6} more</p>
        )}
      </div>
    );
  }

  function trackersList() {
    if (trackers.length === 0) {
      return <p className="text-xs text-muted-foreground py-2">No health trackers.</p>;
    }
    return (
      <div className="space-y-1">
        {trackers.slice(0, 5).map((t: any, i: number) => (
          <div key={t.id ?? i} className="flex items-center justify-between py-1 border-b border-border/50 last:border-0">
            <span className="text-xs flex-1 truncate">{t.name ?? t.type ?? "Tracker"}</span>
            <span className="text-xs font-semibold tabular-nums ml-3 shrink-0">
              {t.latestValue ?? t.value ?? "—"}
              {t.unit ? ` ${t.unit}` : ""}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // ── upload trigger ──
  const uploadAction = { label: "Upload Document", icon: Upload, onClick: () => fileInputRef.current?.click() };

  // ── build sections by category ──
  let sections: React.ReactNode = null;

  if (category === "vehicle") {
    const vinLast4 = (fields.vin as string)?.slice(-4);
    sections = (
      <>
        <ExpandableSection
          title="Identity & Details"
          subtitle="Make, model, year, VIN, specifications"
          icon={Car}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Make / Model", value: [fields.make, fields.model].filter(Boolean).join(" ") },
            { label: "Year", value: fmt("year") },
            { label: "VIN (last 4)", value: vinLast4 ?? "—" },
          ]}
        >
          {fieldsBlock([
            { key: "make", label: "Make" },
            { key: "model", label: "Model" },
            { key: "year", label: "Year" },
            { key: "trim", label: "Trim" },
            { key: "vin", label: "VIN" },
            { key: "license_plate", label: "License Plate" },
            { key: "mileage", label: "Mileage" },
            { key: "color", label: "Color" },
            { key: "location", label: "Location" },
            { key: "purchase_date", label: "Purchase Date" },
            { key: "purchase_price", label: "Purchase Price" },
            { key: "current_value", label: "Current Value" },
            { key: "condition", label: "Condition" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Service & Maintenance"
          subtitle="Service history, repairs, next due"
          icon={Wrench}
          iconColor="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          summaryItems={[
            { label: "Condition", value: fmt("condition") },
            { label: "Last Service", value: computed._lastService ? formatWidgetValue(computed._lastService, "relative") : "—" },
            { label: "Next Due", value: computed._nextDue ?? "—" },
          ]}
        >
          {tasksList()}
          <QuickActionBar actions={[
            { label: "Add Service Record", icon: Plus, onClick: () => {} },
            uploadAction,
          ]} />
        </ExpandableSection>

        <ExpandableSection
          title="Finance & Costs"
          subtitle="Expenses, fuel, equity"
          icon={DollarSign}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Total Spent", value: formatWidgetValue(computed._totalSpent, "currency") },
            { label: "Monthly Avg", value: formatWidgetValue(monthlyExpenses, "currency") },
            { label: "Fuel Costs", value: formatWidgetValue(computed._fuelCosts, "currency") },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[
            { label: "Add Expense", icon: Plus, onClick: () => {} },
          ]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents"
          subtitle="Registration, insurance, title"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
            { label: "Expiring Soon", value: expiringDocCount > 0 ? String(expiringDocCount) : "None" },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>

        <ExpandableSection
          title="Insurance & Registration"
          subtitle="Policy details, registration status"
          icon={Shield}
          iconColor="bg-rose-500/10 text-rose-600 dark:text-rose-400"
          summaryItems={[
            { label: "Insured", value: fields.insurance_policy ? "Yes" : "—" },
            { label: "Registered", value: fields.registration_exp ? fmt("registration_exp") : "—" },
          ]}
        >
          {fieldsBlock([
            { key: "insurance_policy", label: "Policy Number" },
            { key: "insurance_provider", label: "Insurer" },
            { key: "registration_exp", label: "Registration Exp" },
            { key: "insurance_exp", label: "Insurance Exp" },
          ])}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "person") {
    const age = computeAge("birthday");
    const contact = [fields.phone, fields.email].filter(Boolean).join(" · ") || "—";
    sections = (
      <>
        <ExpandableSection
          title="Personal Info"
          subtitle="Contact, relationship, identification"
          icon={Users}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Relationship", value: fmt("relationship") },
            { label: "Age", value: age },
            { label: "Contact", value: contact },
          ]}
        >
          {fieldsBlock([
            { key: "birthday", label: "Birthday" },
            { key: "phone", label: "Phone" },
            { key: "email", label: "Email" },
            { key: "address", label: "Address" },
            { key: "blood_type", label: "Blood Type" },
            { key: "height", label: "Height" },
            { key: "weight", label: "Weight" },
            { key: "relationship", label: "Relationship" },
            { key: "emergency_contact", label: "Emergency Contact" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Health & Wellness"
          subtitle="Trackers, checkups, medications"
          icon={Stethoscope}
          iconColor="bg-rose-500/10 text-rose-600 dark:text-rose-400"
          summaryItems={[
            { label: "Trackers", value: String(trackers.length) },
            { label: "Last Checkup", value: fmt("last_checkup_date") },
            { label: "Medications", value: fields.medications ? "Yes" : "—" },
          ]}
        >
          {trackersList()}
          <QuickActionBar actions={[
            { label: "Add Tracker", icon: Plus, onClick: () => {} },
            { label: "Log Entry", icon: Activity, onClick: () => {} },
          ]} />
        </ExpandableSection>

        <ExpandableSection
          title="Finance"
          subtitle="Shared expenses, debts, spending"
          icon={DollarSign}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Total Spent", value: formatWidgetValue(computed._totalSpent, "currency") },
            { label: "Expenses", value: String(expenses.length) },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Add Expense", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents & IDs"
          subtitle="Passports, licenses, records"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
            { label: "Expiring Soon", value: expiringDocCount > 0 ? String(expiringDocCount) : "None" },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>

        <ExpandableSection
          title="Tasks & Reminders"
          subtitle="Open tasks, due dates, overdue"
          icon={ListTodo}
          iconColor="bg-orange-500/10 text-orange-600 dark:text-orange-400"
          summaryItems={[
            { label: "Open Tasks", value: String(openTaskCount) },
            { label: "Overdue", value: overdueTaskCount > 0 ? String(overdueTaskCount) : "None" },
          ]}
        >
          {tasksList()}
          <QuickActionBar actions={[{ label: "Add Task", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "pet") {
    const age = computeAge("birthday");
    sections = (
      <>
        <ExpandableSection
          title="Pet Info"
          subtitle="Species, breed, identification"
          icon={PawPrint}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Species", value: fmt("species") },
            { label: "Breed", value: fmt("breed") },
            { label: "Age", value: age !== "—" ? `${age} yrs` : "—" },
          ]}
        >
          {fieldsBlock([
            { key: "species", label: "Species" },
            { key: "breed", label: "Breed" },
            { key: "birthday", label: "Birthday" },
            { key: "weight", label: "Weight" },
            { key: "color", label: "Color" },
            { key: "microchip", label: "Microchip ID" },
            { key: "vet_name", label: "Vet Name" },
            { key: "vet_phone", label: "Vet Phone" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Health & Vet"
          subtitle="Visits, vaccinations, medications"
          icon={Stethoscope}
          iconColor="bg-rose-500/10 text-rose-600 dark:text-rose-400"
          summaryItems={[
            { label: "Last Vet Visit", value: fmt("last_vet_date") },
            { label: "Vaccinations", value: fields.vaccinations ? "Up to date" : "—" },
            { label: "Weight", value: fields.weight ? `${fields.weight}` : "—" },
          ]}
        >
          {trackersList()}
          <QuickActionBar actions={[
            { label: "Log Vet Visit", icon: Plus, onClick: () => {} },
            { label: "Log Entry", icon: Activity, onClick: () => {} },
          ]} />
        </ExpandableSection>

        <ExpandableSection
          title="Care & Costs"
          subtitle="Food, grooming, supplies"
          icon={DollarSign}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Monthly Cost", value: formatWidgetValue(monthlyExpenses, "currency") },
            { label: "Total Spent", value: formatWidgetValue(computed._totalSpent, "currency") },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Add Expense", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents"
          subtitle="Vaccination records, vet records"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "property") {
    sections = (
      <>
        <ExpandableSection
          title="Property Details"
          subtitle="Address, type, size, financials"
          icon={Home}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Address", value: fmt("address") },
            { label: "Type", value: fmt("property_type") },
            { label: "Sq Ft", value: fmt("sq_ft") },
          ]}
        >
          {fieldsBlock([
            { key: "address", label: "Address" },
            { key: "property_type", label: "Property Type" },
            { key: "bedrooms", label: "Bedrooms" },
            { key: "bathrooms", label: "Bathrooms" },
            { key: "sq_ft", label: "Sq Ft" },
            { key: "year_built", label: "Year Built" },
            { key: "lot_size", label: "Lot Size" },
            { key: "purchase_price", label: "Purchase Price" },
            { key: "current_value", label: "Current Value" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Maintenance"
          subtitle="Condition, inspections, open items"
          icon={Wrench}
          iconColor="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          summaryItems={[
            { label: "Condition", value: fmt("condition") },
            { label: "Last Inspection", value: fmt("last_inspection_date") },
            { label: "Open Items", value: String(openTaskCount) },
          ]}
        >
          {tasksList()}
          <QuickActionBar actions={[
            { label: "Add Maintenance", icon: Plus, onClick: () => {} },
          ]} />
        </ExpandableSection>

        <ExpandableSection
          title="Mortgage & Finance"
          subtitle="Equity, payments, expenses"
          icon={Landmark}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Equity", value: formatWidgetValue(computed._equity, "currency") },
            { label: "Monthly Payment", value: formatWidgetValue(computed._monthlyPayment, "currency") },
            { label: "Total Spent", value: formatWidgetValue(computed._totalSpent, "currency") },
          ]}
        >
          {fieldsBlock([
            { key: "loan_balance", label: "Loan Balance" },
            { key: "monthly_payment", label: "Monthly Payment" },
            { key: "interest_rate", label: "Interest Rate" },
            { key: "lender", label: "Lender" },
          ])}
          <div className="mt-2">
            {expensesList()}
          </div>
          <QuickActionBar actions={[{ label: "Add Expense", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents & Contracts"
          subtitle="Deed, permits, insurance, title"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
            { label: "Expiring Soon", value: expiringDocCount > 0 ? String(expiringDocCount) : "None" },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "liability") {
    const balance = parseFloat(fields.balance ?? fields.loan_balance ?? 0);
    const rate = fields.interest_rate;
    const payment = fields.monthly_payment;
    sections = (
      <>
        <ExpandableSection
          title="Loan Details"
          subtitle="Balance, rate, payment schedule"
          icon={Landmark}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Balance", value: formatWidgetValue(balance, "currency") },
            { label: "Rate", value: rate ? `${rate}%` : "—" },
            { label: "Monthly Payment", value: formatWidgetValue(payment, "currency") },
          ]}
        >
          {fieldsBlock([
            { key: "lender", label: "Lender" },
            { key: "loan_type", label: "Loan Type" },
            { key: "loan_amount", label: "Original Amount" },
            { key: "balance", label: "Current Balance" },
            { key: "interest_rate", label: "Interest Rate" },
            { key: "monthly_payment", label: "Monthly Payment" },
            { key: "start_date", label: "Start Date" },
            { key: "end_date", label: "End Date" },
            { key: "next_payment_date", label: "Next Payment" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Payment History"
          subtitle="Payments made, months remaining"
          icon={CreditCard}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Total Paid", value: formatWidgetValue(computed._totalSpent, "currency") },
            { label: "Paid Off", value: computed._paidOffPct ?? "—" },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Add Payment", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents"
          subtitle="Loan agreements, statements"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "subscription") {
    sections = (
      <>
        <ExpandableSection
          title="Plan Details"
          subtitle="Provider, cost, billing cycle"
          icon={RefreshCw}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Cost / Cycle", value: [formatWidgetValue(fields.amount, "currency"), fields.billing_cycle].filter(Boolean).join(" / ") || "—" },
            { label: "Next Billing", value: computed._nextBilling ? formatWidgetValue(computed._nextBilling, "date") : "—" },
            { label: "Status", value: fmt("status") },
          ]}
        >
          {fieldsBlock([
            { key: "provider", label: "Provider" },
            { key: "plan", label: "Plan" },
            { key: "amount", label: "Amount" },
            { key: "billing_cycle", label: "Billing Cycle" },
            { key: "status", label: "Status" },
            { key: "category", label: "Category" },
            { key: "start_date", label: "Start Date" },
            { key: "next_billing_date", label: "Next Billing" },
            { key: "website", label: "Website" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Billing History"
          subtitle="Past payments, total spent"
          icon={DollarSign}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Total Spent", value: formatWidgetValue(computed._totalSpent, "currency") },
            { label: "Payments", value: String(expenses.length) },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Add Expense", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "insurance") {
    sections = (
      <>
        <ExpandableSection
          title="Policy Details"
          subtitle="Coverage, premium, deductible"
          icon={Shield}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Premium", value: formatWidgetValue(fields.premium, "currency") },
            { label: "Deductible", value: formatWidgetValue(fields.deductible, "currency") },
            { label: "Coverage Limit", value: formatWidgetValue(fields.coverage_limit, "currency") },
          ]}
        >
          {fieldsBlock([
            { key: "insurer", label: "Insurer" },
            { key: "policy_type", label: "Policy Type" },
            { key: "policy_number", label: "Policy Number" },
            { key: "premium", label: "Premium" },
            { key: "deductible", label: "Deductible" },
            { key: "coverage_limit", label: "Coverage Limit" },
            { key: "start_date", label: "Start Date" },
            { key: "renewal_date", label: "Renewal Date" },
            { key: "status", label: "Status" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Claims & History"
          subtitle="Filed claims, amounts, status"
          icon={AlertTriangle}
          iconColor="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          summaryItems={[
            { label: "Claims Filed", value: String(computed._claims) },
            { label: "Total Claimed", value: formatWidgetValue(computed._totalSpent, "currency") },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Log Claim", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents"
          subtitle="Policy documents, cards"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>
      </>
    );
  } else if (category === "investment") {
    const currentValue = parseFloat(fields.current_value ?? fields.value ?? 0);
    const costBasis = parseFloat(fields.cost_basis ?? fields.purchase_price ?? 0);
    const returnAmt = currentValue - costBasis;
    const returnPct = costBasis > 0 ? ((returnAmt / costBasis) * 100).toFixed(1) : null;
    sections = (
      <>
        <ExpandableSection
          title="Account Details"
          subtitle="Institution, account type, positions"
          icon={TrendingUp}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          defaultOpen
          summaryItems={[
            { label: "Current Value", value: formatWidgetValue(currentValue, "currency") },
            { label: "Return", value: returnPct ? `${returnPct}%` : "—" },
            { label: "Total Return", value: returnAmt ? formatWidgetValue(returnAmt, "currency") : "—" },
          ]}
        >
          {fieldsBlock([
            { key: "institution", label: "Institution" },
            { key: "account_type", label: "Account Type" },
            { key: "ticker", label: "Ticker" },
            { key: "shares", label: "Shares" },
            { key: "cost_basis", label: "Cost Basis" },
            { key: "current_value", label: "Current Value" },
            { key: "return_pct", label: "Return %" },
            { key: "open_date", label: "Open Date" },
          ])}
        </ExpandableSection>

        <ExpandableSection
          title="Performance"
          subtitle="Total return, contributions, history"
          icon={BarChart2}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          summaryItems={[
            { label: "Total Return", value: returnAmt ? formatWidgetValue(returnAmt, "currency") : "—" },
            { label: "Contributions", value: formatWidgetValue(computed._totalSpent, "currency") },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Add Contribution", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents"
          subtitle="Statements, tax docs, agreements"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>
      </>
    );
  } else {
    // generic
    sections = (
      <>
        <ExpandableSection
          title="Details"
          subtitle="Key information and fields"
          icon={FileText}
          iconColor="bg-blue-500/10 text-blue-600 dark:text-blue-400"
          defaultOpen
          summaryItems={[
            { label: "Status", value: fmt("status") },
            { label: "Category", value: fmt("category") },
          ]}
        >
          {Object.keys(allProfileFields).length > 0 ? (
            fieldsBlock(
              Object.keys(allProfileFields).map((key) => ({ key, label: formatKey(key) }))
            )
          ) : (
            <p className="text-xs text-muted-foreground py-2">No fields configured for this profile type.</p>
          )}
        </ExpandableSection>

        <ExpandableSection
          title="Finance"
          subtitle="Expenses, costs, payments"
          icon={DollarSign}
          iconColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          summaryItems={[
            { label: "Total Spent", value: formatWidgetValue(computed._totalSpent, "currency") },
          ]}
        >
          {expensesList()}
          <QuickActionBar actions={[{ label: "Add Expense", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>

        <ExpandableSection
          title="Documents"
          subtitle="Files, records, uploads"
          icon={FileText}
          iconColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          summaryItems={[
            { label: "Total Docs", value: String(docs.length) },
          ]}
        >
          {docsList()}
          <QuickActionBar actions={[uploadAction]} />
        </ExpandableSection>

        <ExpandableSection
          title="Tasks & Reminders"
          subtitle="Open tasks, due dates"
          icon={ListTodo}
          iconColor="bg-orange-500/10 text-orange-600 dark:text-orange-400"
          summaryItems={[
            { label: "Open Tasks", value: String(openTaskCount) },
            { label: "Overdue", value: overdueTaskCount > 0 ? String(overdueTaskCount) : "None" },
          ]}
        >
          {tasksList()}
          <QuickActionBar actions={[{ label: "Add Task", icon: Plus, onClick: () => {} }]} />
        </ExpandableSection>
      </>
    );
  }

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/*,application/pdf,.doc,.docx,.txt"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadMutation.mutate(file);
          e.target.value = "";
        }}
      />
      {sections}
    </div>
  );
}

// ─────────────────────────────────────────────
// OverviewTab
// ─────────────────────────────────────────────

function OverviewTab({
  profile,
  typeDef,
  onChanged,
  onNavigateTab,
  availableTabs,
}: {
  profile: any;
  typeDef: TypeDefinition;
  onChanged: () => void;
  onNavigateTab: (tab: string) => void;
  availableTabs: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, any>>(profile.fields ?? {});
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const fieldSchema: FieldDef[] = typeDef.field_schema ?? [];

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields: editValues });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      toast({ title: "Profile updated" });
      setEditing(false);
      onChanged();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditValues(profile.fields ?? {});
    setEditing(false);
  };

  return (
    <div className="space-y-4">
      {/* Hero header card */}
      <ProfileOverviewHeader
        profile={profile}
        typeDef={typeDef}
        onEdit={() => { setEditValues(profile.fields ?? {}); setEditing(true); }}
      />

      {/* Edit form — shown inline when editing */}
      {editing && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Edit Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <DynamicProfileForm
              fieldSchema={fieldSchema}
              values={editValues}
              onChange={setEditValues}
              disabled={saving}
            />
            <div className="flex gap-2 justify-end mt-4 pt-4 border-t">
              <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Expandable profile sections — shown when not editing */}
      {!editing && (
        <ExpandableProfileSections
          profile={profile}
          typeDef={typeDef}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// DocumentsSection
// ─────────────────────────────────────────────

function DocumentsSection({
  documents,
  profileId,
  onUploaded,
}: {
  documents: any[];
  profileId: string;
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewingDoc, setViewingDoc] = useState<any | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docSearch, setDocSearch] = useState("");

  const filteredDocs = docSearch
    ? documents.filter((d) => {
        const q = docSearch.toLowerCase();
        return (
          d.name?.toLowerCase().includes(q) ||
          d.type?.toLowerCase().includes(q)
        );
      })
    : documents;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(f);
        });
      const fileData = await toBase64(file);
      const res = await apiRequest("POST", "/api/upload", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onSuccess: () => {
      toast({ title: "Document deleted" });
      setDeletingDocId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <input
          type="text"
          placeholder="Search documents…"
          value={docSearch}
          onChange={(e) => setDocSearch(e.target.value)}
          className="flex-1 h-8 px-3 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,application/pdf,.doc,.docx,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadMutation.mutate(file);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          className="gap-1.5 text-xs h-8 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          <Upload className="h-3.5 w-3.5" />
          {uploadMutation.isPending ? "Uploading…" : "Upload"}
        </Button>
      </div>

      {/* Document list */}
      {filteredDocs.length === 0 && documents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No linked documents</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a file to get started</p>
          </CardContent>
        </Card>
      ) : filteredDocs.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center">
            <p className="text-sm text-muted-foreground">No documents match your search</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredDocs.map((doc) => {
            const expStatus = getExpirationStatus(doc);
            const expDate =
              doc.extractedData?.expirationDate ||
              doc.extractedData?.expiry ||
              doc.extractedData?.expiration;
            return (
              <Card
                key={doc.id}
                className={
                  expStatus === "expired"
                    ? "border-red-500/50 bg-red-500/5"
                    : expStatus === "soon"
                    ? "border-yellow-500/50 bg-yellow-500/5"
                    : ""
                }
              >
                <CardContent className="p-0">
                  <div className="p-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
                      {doc.mimeType?.startsWith("image/") ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{doc.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {doc.type && (
                          <Badge variant="secondary" className="text-xs capitalize">
                            {doc.type}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                        {expStatus === "expired" && expDate && (
                          <Badge variant="destructive" className="text-xs gap-0.5">
                            <AlertCircle className="h-2.5 w-2.5" />
                            Expired
                          </Badge>
                        )}
                        {expStatus === "soon" && expDate && (
                          <Badge className="text-xs gap-0.5 bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 border-yellow-500/30">
                            <AlertCircle className="h-2.5 w-2.5" />
                            Expiring soon
                          </Badge>
                        )}
                      </div>

                      {/* Expanded extracted data */}
                      {expandedDocId === doc.id && doc.extractedData && (
                        <div className="mt-2 space-y-0.5">
                          {Object.entries(doc.extractedData).map(([k, v]) => (
                            <div key={k} className="flex justify-between text-xs">
                              <span className="text-muted-foreground">{formatKey(k)}</span>
                              <span className="font-medium">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {doc.extractedData && Object.keys(doc.extractedData).length > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setExpandedDocId(expandedDocId === doc.id ? null : doc.id)
                          }
                        >
                          {expandedDocId === doc.id ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeletingDocId(doc.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deletingDocId} onOpenChange={(open) => !open && setDeletingDocId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={() => deletingDocId && deleteMutation.mutate(deletingDocId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────
// ActivitySection
// ─────────────────────────────────────────────

function ActivitySection({ timeline }: { timeline: any[] }) {
  const timelineColors: Record<string, string> = {
    tracker: "bg-chart-1/10 text-chart-1",
    expense: "bg-chart-4/10 text-chart-4",
    task: "bg-chart-3/10 text-chart-3",
    event: "bg-chart-2/10 text-chart-2",
    document: "bg-primary/10 text-primary",
    habit: "bg-rose-500/10 text-rose-500",
    obligation: "bg-orange-500/10 text-orange-500",
  };

  if (!timeline || timeline.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {timeline.map((entry, i) => {
        const color = timelineColors[entry.type] || "bg-muted text-muted-foreground";
        return (
          <div key={`${entry.type}-${i}`} className="flex gap-3 py-3">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${color}`}
            >
              {timelineIcon(entry.type)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{entry.title}</p>
              {entry.description && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {entry.description}
                </p>
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
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// EngineTab — wraps EngineRenderer with field_map
// ─────────────────────────────────────────────

function EngineTab({
  profile,
  tab,
  onChanged,
}: {
  profile: any;
  tab: TabConfig;
  onChanged: () => void;
}) {
  if (!tab.engine) return null;

  return (
    <div className="space-y-4">
      <EngineRenderer
        engineName={tab.engine}
        fields={profile.fields ?? {}}
        fieldMap={tab.field_map ?? {}}
        profileName={profile.name}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// DynamicProfileDetail (main export)
// ─────────────────────────────────────────────

export default function DynamicProfileDetail({
  profile,
  typeDef,
  onChanged,
}: DynamicProfileDetailProps) {
  const tabConfig: TabConfig[] = typeDef.tab_config ?? [];

  // Always ensure we have an overview tab
  const hasOverview = tabConfig.some(
    (t) => t.engine === null || t.key === "overview" || t.key === "info"
  );

  const allTabs: TabConfig[] = hasOverview
    ? tabConfig
    : [
        { key: "overview", label: "Overview", engine: null },
        ...tabConfig,
      ];

  const defaultTab = allTabs[0]?.key ?? "overview";
  const [activeTab, setActiveTab] = useState(defaultTab);

  const documents = profile.relatedDocuments ?? profile.documents ?? [];
  const timeline = profile.timeline ?? profile.recentActivity ?? [];

  const tabKeys = allTabs.map((t) => t.key);

  const handleNavigateTab = (targetTab: string) => {
    if (tabKeys.includes(targetTab)) {
      setActiveTab(targetTab);
    }
  };

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="flex flex-wrap h-auto gap-1 mb-4">
        {allTabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} className="text-xs">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {allTabs.map((tab) => (
        <TabsContent key={tab.key} value={tab.key} className="mt-0">
          <div className="space-y-6">
            {/* Main tab content */}
            {tab.engine === null ? (
              <OverviewTab
                profile={profile}
                typeDef={typeDef}
                onChanged={onChanged}
                onNavigateTab={handleNavigateTab}
                availableTabs={tabKeys}
              />
            ) : (
              <EngineTab profile={profile} tab={tab} onChanged={onChanged} />
            )}

            {/* Documents sub-section (always present) */}
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Documents
              </h3>
              <DocumentsSection
                documents={documents}
                profileId={profile.id}
                onUploaded={onChanged}
              />
            </section>

            {/* Activity / Timeline section (always present) */}
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Activity
              </h3>
              <Card>
                <CardContent className="p-4">
                  <ActivitySection timeline={timeline} />
                </CardContent>
              </Card>
            </section>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export { DynamicProfileDetail };
