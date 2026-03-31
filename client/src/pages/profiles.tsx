import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Link } from "wouter";
import {
  User,
  PawPrint,
  Car,
  Building2,
  Home,
  CreditCard,
  Stethoscope,
  Users,
  ChevronRight,
  Tag,
  Plus,
  Trash2,
  TrendingUp,
  Landmark,
  Package,
  ArrowLeft,
} from "lucide-react";
import type { Profile, ProfileType, InsertProfile } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROFILE_TYPES: ProfileType[] = [
  "person",
  "pet",
  "vehicle",
  "asset",
  "loan",
  "investment",
  "subscription",
];

const TYPE_LABELS: Record<string, string> = {
  person: "Person",
  pet: "Pet",
  vehicle: "Vehicle",
  asset: "Asset",
  loan: "Loan",
  investment: "Investment",
  subscription: "Subscription",
  account: "Account",
  property: "Property",
  medical: "Medical",
  self: "Self",
};

function profileIcon(type: string) {
  const icons: Record<string, any> = {
    person: User,
    pet: PawPrint,
    vehicle: Car,
    asset: Package,
    loan: Landmark,
    investment: TrendingUp,
    subscription: CreditCard,
    account: Building2,
    property: Home,
    medical: Stethoscope,
    self: User,
  };
  const Icon = icons[type] || User;
  return <Icon className="h-4 w-4" />;
}

function profileColor(type: string) {
  const colors: Record<string, string> = {
    person: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    pet: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    vehicle: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
    asset: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    loan: "bg-red-500/10 text-red-600 dark:text-red-400",
    investment: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    subscription: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
    account: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    property: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
    medical: "bg-red-500/10 text-red-600 dark:text-red-400",
    self: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  };
  return colors[type] || "bg-muted text-muted-foreground";
}

// ─── Type-specific field components ─────────────────────────────────────────

function FieldRow({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function PersonFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Relationship" id="relationship">
        <Input
          id="relationship"
          data-testid="input-field-relationship"
          value={fields.relationship || ""}
          onChange={(e) => onChange("relationship", e.target.value)}
          placeholder="e.g. Spouse, Parent, Friend"
        />
      </FieldRow>
      <FieldRow label="Phone" id="phone">
        <Input
          id="phone"
          data-testid="input-field-phone"
          value={fields.phone || ""}
          onChange={(e) => onChange("phone", e.target.value)}
          placeholder="+1 (555) 000-0000"
        />
      </FieldRow>
      <FieldRow label="Email" id="email">
        <Input
          id="email"
          type="email"
          data-testid="input-field-email"
          value={fields.email || ""}
          onChange={(e) => onChange("email", e.target.value)}
          placeholder="name@example.com"
        />
      </FieldRow>
      <FieldRow label="Birthday" id="birthday">
        <Input
          id="birthday"
          type="date"
          data-testid="input-field-birthday"
          value={fields.birthday || ""}
          onChange={(e) => onChange("birthday", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Address" id="address">
        <Input
          id="address"
          data-testid="input-field-address"
          value={fields.address || ""}
          onChange={(e) => onChange("address", e.target.value)}
          placeholder="123 Main St, City, State"
        />
      </FieldRow>
      <FieldRow label="Blood Type" id="bloodType">
        <Select value={fields.bloodType || ""} onValueChange={(v) => onChange("bloodType", v)}>
          <SelectTrigger id="bloodType" data-testid="input-field-bloodType">
            <SelectValue placeholder="Select blood type" />
          </SelectTrigger>
          <SelectContent>
            {["A+","A-","B+","B-","AB+","AB-","O+","O-"].map(bt => (
              <SelectItem key={bt} value={bt}>{bt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Height" id="height">
        <Input
          id="height"
          data-testid="input-field-height"
          value={fields.height || ""}
          onChange={(e) => onChange("height", e.target.value)}
          placeholder="e.g. 5ft 10in"
        />
      </FieldRow>
      <FieldRow label="Allergies" id="allergies">
        <Input
          id="allergies"
          data-testid="input-field-allergies"
          value={fields.allergies || ""}
          onChange={(e) => onChange("allergies", e.target.value)}
          placeholder="e.g. Penicillin, Peanuts"
        />
      </FieldRow>
    </>
  );
}

function PetFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Species" id="species">
        <Select
          value={fields.species || ""}
          onValueChange={(v) => onChange("species", v)}
        >
          <SelectTrigger id="species" data-testid="select-field-species">
            <SelectValue placeholder="Select species" />
          </SelectTrigger>
          <SelectContent>
            {["dog", "cat", "bird", "fish", "reptile", "other"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Breed" id="breed">
        <Input
          id="breed"
          data-testid="input-field-breed"
          value={fields.breed || ""}
          onChange={(e) => onChange("breed", e.target.value)}
          placeholder="e.g. Golden Retriever"
        />
      </FieldRow>
      <FieldRow label="Birthday" id="birthday">
        <Input
          id="birthday"
          type="date"
          data-testid="input-field-birthday"
          value={fields.birthday || ""}
          onChange={(e) => onChange("birthday", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Weight" id="weight">
        <Input
          id="weight"
          data-testid="input-field-weight"
          value={fields.weight || ""}
          onChange={(e) => onChange("weight", e.target.value)}
          placeholder="e.g. 65 lbs"
        />
      </FieldRow>
      <FieldRow label="Color" id="color">
        <Input
          id="color"
          data-testid="input-field-color"
          value={fields.color || ""}
          onChange={(e) => onChange("color", e.target.value)}
          placeholder="e.g. Golden"
        />
      </FieldRow>
      <FieldRow label="Microchip Number" id="microchipNumber">
        <Input
          id="microchipNumber"
          data-testid="input-field-microchipNumber"
          value={fields.microchipNumber || ""}
          onChange={(e) => onChange("microchipNumber", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Vet Name" id="vetName">
        <Input
          id="vetName"
          data-testid="input-field-vetName"
          value={fields.vetName || ""}
          onChange={(e) => onChange("vetName", e.target.value)}
          placeholder="Dr. Smith"
        />
      </FieldRow>
      <FieldRow label="Vet Phone" id="vetPhone">
        <Input
          id="vetPhone"
          data-testid="input-field-vetPhone"
          value={fields.vetPhone || ""}
          onChange={(e) => onChange("vetPhone", e.target.value)}
          placeholder="+1 (555) 000-0000"
        />
      </FieldRow>
    </>
  );
}

function VehicleFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Year" id="year">
        <Input
          id="year"
          data-testid="input-field-year"
          value={fields.year || ""}
          onChange={(e) => onChange("year", e.target.value)}
          placeholder="e.g. 2022"
        />
      </FieldRow>
      <FieldRow label="Make" id="make">
        <Input
          id="make"
          data-testid="input-field-make"
          value={fields.make || ""}
          onChange={(e) => onChange("make", e.target.value)}
          placeholder="e.g. Toyota"
        />
      </FieldRow>
      <FieldRow label="Model" id="model">
        <Input
          id="model"
          data-testid="input-field-model"
          value={fields.model || ""}
          onChange={(e) => onChange("model", e.target.value)}
          placeholder="e.g. Camry"
        />
      </FieldRow>
      <FieldRow label="Color" id="color">
        <Input
          id="color"
          data-testid="input-field-color"
          value={fields.color || ""}
          onChange={(e) => onChange("color", e.target.value)}
          placeholder="e.g. Silver"
        />
      </FieldRow>
      <FieldRow label="VIN" id="vin">
        <Input
          id="vin"
          data-testid="input-field-vin"
          value={fields.vin || ""}
          onChange={(e) => onChange("vin", e.target.value)}
          placeholder="17-character VIN"
        />
      </FieldRow>
      <FieldRow label="License Plate" id="licensePlate">
        <Input
          id="licensePlate"
          data-testid="input-field-licensePlate"
          value={fields.licensePlate || ""}
          onChange={(e) => onChange("licensePlate", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Mileage" id="mileage">
        <Input
          id="mileage"
          data-testid="input-field-mileage"
          value={fields.mileage || ""}
          onChange={(e) => onChange("mileage", e.target.value)}
          placeholder="e.g. 45000"
        />
      </FieldRow>
    </>
  );
}

function AssetFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Asset Type" id="assetType">
        <Select
          value={fields.assetType || ""}
          onValueChange={(v) => onChange("assetType", v)}
        >
          <SelectTrigger id="assetType" data-testid="select-field-assetType">
            <SelectValue placeholder="Select type" />
          </SelectTrigger>
          <SelectContent>
            {["electronics", "appliance", "furniture", "jewelry", "other"].map(
              (t) => (
                <SelectItem key={t} value={t} className="capitalize">
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Brand" id="brand">
        <Input
          id="brand"
          data-testid="input-field-brand"
          value={fields.brand || ""}
          onChange={(e) => onChange("brand", e.target.value)}
          placeholder="e.g. Apple"
        />
      </FieldRow>
      <FieldRow label="Model" id="model">
        <Input
          id="model"
          data-testid="input-field-model"
          value={fields.model || ""}
          onChange={(e) => onChange("model", e.target.value)}
          placeholder="e.g. MacBook Pro"
        />
      </FieldRow>
      <FieldRow label="Serial Number" id="serialNumber">
        <Input
          id="serialNumber"
          data-testid="input-field-serialNumber"
          value={fields.serialNumber || ""}
          onChange={(e) => onChange("serialNumber", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Purchase Date" id="purchaseDate">
        <Input
          id="purchaseDate"
          type="date"
          data-testid="input-field-purchaseDate"
          value={fields.purchaseDate || ""}
          onChange={(e) => onChange("purchaseDate", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Purchase Price" id="purchasePrice">
        <Input
          id="purchasePrice"
          data-testid="input-field-purchasePrice"
          value={fields.purchasePrice || ""}
          onChange={(e) => onChange("purchasePrice", e.target.value)}
          placeholder="e.g. 1299.00"
        />
      </FieldRow>
    </>
  );
}

function LoanFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Lender" id="lender">
        <Input
          id="lender"
          data-testid="input-field-lender"
          value={fields.lender || ""}
          onChange={(e) => onChange("lender", e.target.value)}
          placeholder="e.g. Chase Bank"
        />
      </FieldRow>
      <FieldRow label="Original Amount" id="originalAmount">
        <Input
          id="originalAmount"
          data-testid="input-field-originalAmount"
          value={fields.originalAmount || ""}
          onChange={(e) => onChange("originalAmount", e.target.value)}
          placeholder="e.g. 250000"
        />
      </FieldRow>
      <FieldRow label="Remaining Balance" id="remainingBalance">
        <Input
          id="remainingBalance"
          data-testid="input-field-remainingBalance"
          value={fields.remainingBalance || ""}
          onChange={(e) => onChange("remainingBalance", e.target.value)}
          placeholder="e.g. 198000"
        />
      </FieldRow>
      <FieldRow label="Interest Rate (%)" id="interestRate">
        <Input
          id="interestRate"
          data-testid="input-field-interestRate"
          value={fields.interestRate || ""}
          onChange={(e) => onChange("interestRate", e.target.value)}
          placeholder="e.g. 6.5"
        />
      </FieldRow>
      <FieldRow label="Monthly Payment" id="monthlyPayment">
        <Input
          id="monthlyPayment"
          data-testid="input-field-monthlyPayment"
          value={fields.monthlyPayment || ""}
          onChange={(e) => onChange("monthlyPayment", e.target.value)}
          placeholder="e.g. 1500"
        />
      </FieldRow>
      <FieldRow label="Term (months)" id="term">
        <Input
          id="term"
          data-testid="input-field-term"
          value={fields.term || ""}
          onChange={(e) => onChange("term", e.target.value)}
          placeholder="e.g. 360"
        />
      </FieldRow>
      <FieldRow label="Start Date" id="startDate">
        <Input
          id="startDate"
          type="date"
          data-testid="input-field-startDate"
          value={fields.startDate || ""}
          onChange={(e) => onChange("startDate", e.target.value)}
        />
      </FieldRow>
    </>
  );
}

function InvestmentFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Broker" id="broker">
        <Input
          id="broker"
          data-testid="input-field-broker"
          value={fields.broker || ""}
          onChange={(e) => onChange("broker", e.target.value)}
          placeholder="e.g. Fidelity"
        />
      </FieldRow>
      <FieldRow label="Account Type" id="accountType">
        <Select
          value={fields.accountType || ""}
          onValueChange={(v) => onChange("accountType", v)}
        >
          <SelectTrigger id="accountType" data-testid="select-field-accountType">
            <SelectValue placeholder="Select account type" />
          </SelectTrigger>
          <SelectContent>
            {["brokerage", "IRA", "401k", "Roth IRA", "HSA"].map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Balance" id="balance">
        <Input
          id="balance"
          data-testid="input-field-balance"
          value={fields.balance || ""}
          onChange={(e) => onChange("balance", e.target.value)}
          placeholder="e.g. 45000"
        />
      </FieldRow>
      <FieldRow label="2026 Contributions" id="contributions2026">
        <Input
          id="contributions2026"
          data-testid="input-field-contributions2026"
          value={fields.contributions2026 || ""}
          onChange={(e) => onChange("contributions2026", e.target.value)}
          placeholder="e.g. 6000"
        />
      </FieldRow>
    </>
  );
}

function SubscriptionFields({
  fields,
  onChange,
}: {
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <>
      <FieldRow label="Service" id="service">
        <Input
          id="service"
          data-testid="input-field-service"
          value={fields.service || ""}
          onChange={(e) => onChange("service", e.target.value)}
          placeholder="e.g. Netflix"
        />
      </FieldRow>
      <FieldRow label="Plan" id="plan">
        <Input
          id="plan"
          data-testid="input-field-plan"
          value={fields.plan || ""}
          onChange={(e) => onChange("plan", e.target.value)}
          placeholder="e.g. Premium"
        />
      </FieldRow>
      <FieldRow label="Cost" id="cost">
        <Input
          id="cost"
          data-testid="input-field-cost"
          value={fields.cost || ""}
          onChange={(e) => onChange("cost", e.target.value)}
          placeholder="e.g. 15.99"
        />
      </FieldRow>
      <FieldRow label="Frequency" id="frequency">
        <Select
          value={fields.frequency || ""}
          onValueChange={(v) => onChange("frequency", v)}
        >
          <SelectTrigger id="frequency" data-testid="select-field-frequency">
            <SelectValue placeholder="Select frequency" />
          </SelectTrigger>
          <SelectContent>
            {["weekly", "monthly", "quarterly", "annually"].map((f) => (
              <SelectItem key={f} value={f} className="capitalize">
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Next Billing Date" id="nextBillingDate">
        <Input
          id="nextBillingDate"
          type="date"
          data-testid="input-field-nextBillingDate"
          value={fields.nextBillingDate || ""}
          onChange={(e) => onChange("nextBillingDate", e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Login Email" id="loginEmail">
        <Input
          id="loginEmail"
          type="email"
          data-testid="input-field-loginEmail"
          value={fields.loginEmail || ""}
          onChange={(e) => onChange("loginEmail", e.target.value)}
          placeholder="account@example.com"
        />
      </FieldRow>
      <div className="flex items-center justify-between">
        <Label htmlFor="autoRenew">Auto-Renew</Label>
        <Switch
          id="autoRenew"
          data-testid="switch-field-autoRenew"
          checked={!!fields.autoRenew}
          onCheckedChange={(v) => onChange("autoRenew", v)}
        />
      </div>
    </>
  );
}

function TypeSpecificFields({
  type,
  fields,
  onChange,
}: {
  type: ProfileType;
  fields: Record<string, any>;
  onChange: (k: string, v: any) => void;
}) {
  switch (type) {
    case "person":
      return <PersonFields fields={fields} onChange={onChange} />;
    case "pet":
      return <PetFields fields={fields} onChange={onChange} />;
    case "vehicle":
      return <VehicleFields fields={fields} onChange={onChange} />;
    case "asset":
      return <AssetFields fields={fields} onChange={onChange} />;
    case "loan":
      return <LoanFields fields={fields} onChange={onChange} />;
    case "investment":
      return <InvestmentFields fields={fields} onChange={onChange} />;
    case "subscription":
      return <SubscriptionFields fields={fields} onChange={onChange} />;
    default:
      return null;
  }
}

// ─── Create Profile Dialog ───────────────────────────────────────────────────

const EMPTY_FIELDS: Record<string, any> = {};

function CreateProfileDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState<ProfileType>("person");
  const [fields, setFields] = useState<Record<string, any>>({});
  const [tagsInput, setTagsInput] = useState("");
  const [notes, setNotes] = useState("");

  const handleFieldChange = (k: string, v: any) => {
    setFields((prev) => ({ ...prev, [k]: v }));
  };

  const handleTypeChange = (newType: ProfileType) => {
    setType(newType);
    setFields({});
  };

  const createMutation = useMutation({
    mutationFn: async (payload: InsertProfile) => {
      const res = await apiRequest("POST", "/api/profiles", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Profile created" });
      handleClose();
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to create profile",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleClose = () => {
    setName("");
    setType("person");
    setFields({});
    setTagsInput("");
    setNotes("");
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    // Email validation
    const emailFields = ["email", "loginEmail"];
    for (const key of emailFields) {
      if (fields[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[key])) {
        toast({ title: "Invalid email", description: `Enter a valid email address for ${key}`, variant: "destructive" });
        return;
      }
    }
    // Phone validation
    const phoneFields = ["phone", "vetPhone"];
    for (const key of phoneFields) {
      if (fields[key] && !/^\+?[\d\s()-]{7,15}$/.test(fields[key])) {
        toast({ title: "Invalid phone", description: `Enter a valid phone number for ${key}`, variant: "destructive" });
        return;
      }
    }
    // Blood type validation
    if (fields.bloodType && !["A+","A-","B+","B-","AB+","AB-","O+","O-"].includes(fields.bloodType)) {
      toast({ title: "Invalid blood type", description: "Use A+, A-, B+, B-, AB+, AB-, O+, or O-", variant: "destructive" });
      return;
    }
    // Birthday validation
    if (fields.birthday) {
      const d = new Date(fields.birthday);
      if (isNaN(d.getTime()) || d > new Date()) {
        toast({ title: "Invalid date", description: "Enter a valid date that is not in the future", variant: "destructive" });
        return;
      }
    }
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const cleanFields = Object.fromEntries(
      Object.entries(fields).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
    );
    createMutation.mutate({ type, name: name.trim(), fields: cleanFields, tags, notes });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        className="max-w-lg max-h-[90vh] flex flex-col p-0"
        data-testid="dialog-create-profile"
      >
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle>Create Profile</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
         <div className="flex-1 overflow-y-auto px-6 space-y-4 pb-4" style={{WebkitOverflowScrolling: 'touch'}}>
          {/* Name */}
          <FieldRow label="Name *" id="profile-name">
            <Input
              id="profile-name"
              data-testid="input-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter name"
              autoFocus
            />
          </FieldRow>

          {/* Type selector */}
          <FieldRow label="Type" id="profile-type">
            <Select
              value={type}
              onValueChange={(v) => handleTypeChange(v as ProfileType)}
            >
              <SelectTrigger id="profile-type" data-testid="select-profile-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROFILE_TYPES.map((t) => (
                  <SelectItem key={t} value={t} data-testid={`option-type-${t}`}>
                    {TYPE_LABELS[t] || t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          {/* Divider */}
          {PROFILE_TYPES.includes(type) && (
            <div className="border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                {TYPE_LABELS[type]} Details
              </p>
              <div className="space-y-3">
                <TypeSpecificFields
                  type={type}
                  fields={fields}
                  onChange={handleFieldChange}
                />
              </div>
            </div>
          )}

          {/* Tags */}
          <div className="border-t pt-3 space-y-3">
            <FieldRow label="Tags" id="profile-tags">
              <Input
                id="profile-tags"
                data-testid="input-profile-tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="family, important, review (comma-separated)"
              />
            </FieldRow>

            {/* Notes */}
            <FieldRow label="Notes" id="profile-notes">
              <Textarea
                id="profile-notes"
                data-testid="textarea-profile-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any additional notes..."
                rows={3}
              />
            </FieldRow>
          </div>

          </div>{/* end scroll area */}
          <DialogFooter className="px-6 py-3 border-t shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              data-testid="btn-cancel-create-profile"
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="btn-submit-create-profile"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create Profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Profile Card ────────────────────────────────────────────────────────────

const HIDDEN_FIELDS = ["class", "donor", "provider", "patientId", "property"];

const formatFieldValue = (key: string, value: any): string => {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return String(value);
};

const AVATAR_COLORS: Record<string, string> = {
  self: "bg-primary/20 text-primary",
  person: "bg-blue-500/20 text-blue-500",
  pet: "bg-amber-500/20 text-amber-500",
  vehicle: "bg-slate-500/20 text-slate-500",
  subscription: "bg-green-500/20 text-green-500",
  asset: "bg-purple-500/20 text-purple-500",
  loan: "bg-red-500/20 text-red-500",
};

function ProfileCard({
  profile,
  onDelete,
}: {
  profile: Profile;
  onDelete: (id: string) => void;
}) {
  const fields = Object.entries(profile.fields).filter(
    ([key, v]) => v !== null && v !== undefined && v !== "" && !HIDDEN_FIELDS.includes(key)
  );

  const initials = profile.name
    .split(" ")
    .map((w: string) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const avatarColorClass = AVATAR_COLORS[profile.type] || "bg-muted text-muted-foreground";
  const linkedCount =
    (profile.linkedTrackers?.length || 0) +
    (profile.linkedExpenses?.length || 0) +
    (profile.linkedTasks?.length || 0) +
    (profile.linkedEvents?.length || 0) +
    (profile.documents?.length || 0);

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete(profile.id);
  };

  return (
    <Link href={`/profiles/${profile.id}`}>
      <Card
        data-testid={`card-profile-${profile.id}`}
        className="hover:bg-accent/50 transition-colors cursor-pointer group"
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Avatar className={`h-10 w-10 ${avatarColorClass}`}>
              <AvatarFallback className={`${avatarColorClass} text-xs font-bold`}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3
                  className="text-sm font-semibold line-clamp-2"
                  title={profile.name}
                  data-testid={`text-profile-name-${profile.id}`}
                >
                  {profile.name}
                </h3>
                <Badge variant="secondary" className="text-xs capitalize shrink-0">
                  {TYPE_LABELS[profile.type] || profile.type}
                </Badge>
              </div>
              {fields.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {fields.slice(0, 3).map(([key, val]) => (
                    <div key={key} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground capitalize">{key}:</span>
                      <span className="truncate">{formatFieldValue(key, val)}</span>
                    </div>
                  ))}
                </div>
              )}
              {(profile.tags?.length > 0 || linkedCount > 0) && (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  {profile.tags?.slice(0, 3).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-[10px]">
                      <Tag className="h-2 w-2 mr-0.5" />
                      {tag}
                    </Badge>
                  ))}
                  {linkedCount > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {linkedCount} linked items
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0 mt-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                data-testid={`btn-delete-profile-${profile.id}`}
                onClick={handleDeleteClick}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function ProfilesPage() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: profiles, isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    staleTime: 0, // Always fetch fresh — profiles change via chat and must be up to date
    refetchOnMount: "always",
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      // Cascade: profile delete also removes linked obligations, events, expenses, etc.
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      toast({ title: "Profile deleted" });
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to delete profile",
        description: err.message,
        variant: "destructive",
      });
      setDeleteId(null);
    },
  });

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 rounded-lg skeleton-shimmer" />
          ))}
        </div>
      </div>
    );
  }

  // Only show primary profiles (people, pets, self) on the Profiles page
  // Everything else (vehicles, subscriptions, assets, loans) lives under Linked tab of the parent profile
  const primaryTypes = new Set(["person", "pet", "self", "medical"]);
  const primaryProfiles = (profiles || []).filter(p => primaryTypes.has(p.type));

  // Filter by search query
  const filteredProfiles = searchQuery.trim()
    ? primaryProfiles.filter(p => {
        const q = searchQuery.toLowerCase();
        if (p.name.toLowerCase().includes(q)) return true;
        if (p.type.toLowerCase().includes(q)) return true;
        if (p.fields) {
          return Object.values(p.fields).some(v =>
            v !== null && v !== undefined && String(v).toLowerCase().includes(q)
          );
        }
        return false;
      })
    : primaryProfiles;

  // Group by type
  const grouped = filteredProfiles.reduce((acc: Record<string, Profile[]>, p) => {
    (acc[p.type] = acc[p.type] || []).push(p);
    return acc;
  }, {});

  const typeOrder = [
    "self",
    "person",
    "pet",
    "medical",
  ];
  const sortedTypes = Object.keys(grouped).sort(
    (a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b)
  );

  const typeGroupLabel = (type: string) => {
    if (type === "medical") return "Medical Providers";
    const label = TYPE_LABELS[type] || type;
    return `${label}s`;
  };

  const profileToDelete = deleteId ? (profiles || []).find((p) => p.id === deleteId) : null;

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-32" data-testid="page-profiles">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back to Dashboard">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-xl font-semibold" data-testid="text-profiles-title">Profiles</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {(profiles || []).length === 0
              ? "You haven't added any profiles yet"
              : `${(profiles || []).length} total — people, pets, vehicles, subscriptions, and more`}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="btn-open-create-profile"
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      {/* Search bar */}
      {profiles && profiles.length > 0 && (
        <input
          type="text"
          placeholder="Search profiles..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full h-8 px-3 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary mb-3"
          data-testid="input-search-profiles"
        />
      )}

      {/* Empty state */}
      {(!profiles || profiles.length === 0) ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
            <Users className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm text-muted-foreground">Add people, pets, vehicles, and more</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} data-testid="button-add-profile-empty">
            <Plus className="w-4 h-4 mr-1" /> Add First Profile
          </Button>
        </div>
      ) : (
        sortedTypes.map((type) => (
          <div key={type}>
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 capitalize">
              {typeGroupLabel(type)} ({grouped[type].length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {grouped[type].map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  onDelete={(id) => setDeleteId(id)}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {/* Create Dialog */}
      <CreateProfileDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      {/* Delete AlertDialog */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
      >
        <AlertDialogContent data-testid="dialog-confirm-delete-profile">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Profile</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <strong>{profileToDelete?.name ?? "this profile"}</strong>? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="btn-cancel-delete-profile"
              disabled={deleteMutation.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="btn-confirm-delete-profile"
              disabled={deleteMutation.isPending}
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
