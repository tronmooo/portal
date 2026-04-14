import { formatApiError } from "@/lib/formatError";
import { EmptyState } from "@/components/EmptyState";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import ProfileTypeSelector from "@/components/registry/ProfileTypeSelector";
import type { TypeDefinition } from "@/components/registry/ProfileTypeSelector";
import DynamicProfileForm from "@/components/registry/DynamicProfileForm";
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
  Search,
} from "lucide-react";
import type { Profile, ProfileType, InsertProfile } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROFILE_TYPES: ProfileType[] = [
  "asset",
  "investment",
  "loan",
  "person",
  "pet",
  "subscription",
  "vehicle",
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

// ─── Helper: map registry category/type_key → legacy profile type ────────────

function mapTypeKeyToLegacyType(typeKey: string, category: string): ProfileType {
  // people category
  if (category === "people") {
    if (typeKey === "self") return "self" as ProfileType;
    if (typeKey === "pet") return "pet";
    return "person";
  }
  if (category === "liabilities") return "loan";
  if (category === "subscriptions") return "subscription";
  if (category === "investments") return "investment";
  if (category === "property") return "property" as ProfileType;
  // assets, insurance → asset
  return "asset";
}

// ─── Create Profile Dialog ───────────────────────────────────────────────────

function CreateProfileDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  // Step 1: pick a type; Step 2: fill details
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTypeKey, setSelectedTypeKey] = useState<string | undefined>(undefined);
  const [selectedTypeDef, setSelectedTypeDef] = useState<TypeDefinition | null>(null);

  // Step-2 state
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, any>>({});
  const [tagsInput, setTagsInput] = useState("");
  const [notes, setNotes] = useState("");

  const createMutation = useMutation({
    mutationFn: async (payload: InsertProfile & { type_key?: string }) => {
      // Check for duplicate name by querying current profiles
      const existing = await apiRequest("GET", "/api/profiles").then(r => r.json()) as any[];
      const dup = existing?.find((p: any) => p.name.toLowerCase() === payload.name.toLowerCase());
      if (dup) {
        const proceed = confirm(`A profile named "${dup.name}" already exists (${dup.type}). Create another?`);
        if (!proceed) throw new Error("Cancelled");
      }
      const res = await apiRequest("POST", "/api/profiles", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `"${name}" profile created`, description: selectedTypeDef?.label || selectedTypeKey });
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
    setStep(1);
    setSelectedTypeKey(undefined);
    setSelectedTypeDef(null);
    setName("");
    setFields({});
    setTagsInput("");
    setNotes("");
    onClose();
  };

  const handleTypeSelect = (typeKey: string, typeDef: TypeDefinition) => {
    setSelectedTypeKey(typeKey);
    setSelectedTypeDef(typeDef);
  };

  const handleNext = () => {
    if (!selectedTypeKey || !selectedTypeDef) {
      toast({ title: "Please select a profile type", variant: "destructive" });
      return;
    }
    setStep(2);
  };

  const handleBack = () => {
    setStep(1);
    setName("");
    setFields({});
    setTagsInput("");
    setNotes("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (!selectedTypeDef) {
      toast({ title: "Profile type is required", variant: "destructive" });
      return;
    }
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const cleanFields = Object.fromEntries(
      Object.entries(fields).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
    );
    const legacyType = mapTypeKeyToLegacyType(selectedTypeDef.type_key, selectedTypeDef.category);
    createMutation.mutate({
      type: legacyType,
      // @ts-ignore — type_key is stored as extra field on the profile
      type_key: selectedTypeDef.type_key,
      name: name.trim(),
      fields: cleanFields,
      tags,
      notes,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        className="max-w-lg max-h-[90vh] flex flex-col p-0"
        data-testid="dialog-create-profile"
      >
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle>
            {step === 1 ? "Choose Profile Type" : "Create Profile"}
          </DialogTitle>
          {step === 2 && selectedTypeDef && (
            <p className="text-sm text-muted-foreground">{selectedTypeDef.label}</p>
          )}
        </DialogHeader>

        {step === 1 ? (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4" style={{ WebkitOverflowScrolling: "touch" }}>
              <ProfileTypeSelector
                onSelect={handleTypeSelect}
                selectedKey={selectedTypeKey}
              />
            </div>
            <DialogFooter className="px-6 py-3 border-t shrink-0">
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                data-testid="btn-cancel-create-profile"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleNext}
                disabled={!selectedTypeKey}
                data-testid="btn-next-create-profile"
              >
                Next
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-6 space-y-4 pb-4" style={{ WebkitOverflowScrolling: "touch" }}>
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

              {/* Dynamic fields from schema */}
              {selectedTypeDef && selectedTypeDef.field_schema && selectedTypeDef.field_schema.length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                    {selectedTypeDef.label} Details
                  </p>
                  <DynamicProfileForm
                    fieldSchema={selectedTypeDef.field_schema}
                    values={fields}
                    onChange={setFields}
                    disabled={createMutation.isPending}
                  />
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
            </div>

            <DialogFooter className="px-6 py-3 border-t shrink-0">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                data-testid="btn-back-create-profile"
                disabled={createMutation.isPending}
              >
                Back
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
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Profile Card ────────────────────────────────────────────────────────────

const HIDDEN_FIELDS = ["class", "donor", "provider", "patientId", "property", "_parentProfileId", "ownerProfileId", "ownerName"];
// Vehicle/asset-specific fields that should not appear on person/pet profile cards
const VEHICLE_SPECIFIC_FIELDS = ["make", "model", "year", "vin", "mileage", "color_ext", "color_int", "trim", "transmission", "fuelType", "engineSize", "licenseplate", "odo"];

const formatFieldValue = (key: string, value: any): string => {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return String(value);
};

// Profile type accent colors (HSL)
const PROFILE_ACCENT: Record<string, string> = {
  self:         "188 65% 48%",
  person:       "215 70% 58%",
  pet:          "43  80% 54%",
  vehicle:      "262 60% 62%",
  asset:        "155 60% 44%",
  loan:         "0   68% 52%",
  subscription: "310 45% 58%",
  property:     "155 55% 44%",
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

function getProfileBanner(type: string): string {
  const banners: Record<string, string> = {
    self:         'linear-gradient(135deg, hsl(188 55% 30%), hsl(262 65% 35%))',
    person:       'linear-gradient(135deg, hsl(215 70% 30%), hsl(262 55% 35%))',
    pet:          'linear-gradient(135deg, hsl(43 85% 35%), hsl(25 80% 35%))',
    vehicle:      'linear-gradient(135deg, hsl(220 20% 20%), hsl(220 15% 28%))',
    asset:        'linear-gradient(135deg, hsl(43 75% 30%), hsl(155 55% 25%))',
    investment:   'linear-gradient(135deg, hsl(155 60% 25%), hsl(188 65% 25%))',
    subscription: 'linear-gradient(135deg, hsl(310 45% 25%), hsl(262 55% 28%))',
    medical:      'linear-gradient(135deg, hsl(0 70% 30%), hsl(25 75% 30%))',
    account:      'linear-gradient(135deg, hsl(188 65% 25%), hsl(155 55% 25%))',
    property:     'linear-gradient(135deg, hsl(262 55% 28%), hsl(215 65% 30%))',
    loan:         'linear-gradient(135deg, hsl(0 72% 28%), hsl(25 75% 28%))',
  };
  return banners[type] || 'linear-gradient(135deg, hsl(40 5% 20%), hsl(40 5% 28%))';
}

function ProfileCard({ profile, onDelete }: { profile: Profile; onDelete: (id: string) => void }) {
  const isPersonType = ["self", "person", "pet"].includes(profile.type);
  const fields = Object.entries(profile.fields).filter(
    ([key, v]) => v !== null && v !== undefined && v !== "" &&
      !HIDDEN_FIELDS.includes(key) &&
      !(isPersonType && VEHICLE_SPECIFIC_FIELDS.includes(key))
  );
  const initials = profile.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
  const accentHsl = PROFILE_ACCENT[profile.type] || '188 65% 48%';
  const ac = `hsl(${accentHsl})`;
  const linkedCount =
    (profile.linkedTrackers?.length || 0) +
    (profile.linkedExpenses?.length || 0) +
    (profile.linkedTasks?.length || 0) +
    (profile.linkedEvents?.length || 0) +
    (profile.documents?.length || 0);

  const TYPE_ICONS: Record<string, string> = { self: '\u{1F464}', person: '\u{1F465}', pet: '\u{1F43E}', vehicle: '\u{1F697}', asset: '\u2B50', loan: '\u{1F4B3}', subscription: '\u{1F504}', investment: '\u{1F4C8}', property: '\u{1F3E0}', medical: '\u{1FA7A}' };

  return (
    <Link href={`/profiles/${profile.id}`}>
      <div
        data-testid={`card-profile-${profile.id}`}
        className="rounded-xl overflow-hidden cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] flex flex-col group h-full"
        style={{
          background: `linear-gradient(160deg, hsl(${accentHsl} / 0.14) 0%, hsl(var(--card)) 45%)`,
          border: `1px solid hsl(${accentHsl} / 0.2)`,
          boxShadow: `0 2px 16px hsl(${accentHsl} / 0.07)`,
        }}
      >
        {/* Header: avatar + name + type */}
        <div className="px-2.5 pt-2 pb-1 flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-white text-[10px] font-bold" style={{ background: `linear-gradient(135deg, hsl(${accentHsl}), hsl(${accentHsl} / 0.7))` }}>
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold text-foreground truncate" data-testid={`text-profile-name-${profile.id}`}>{profile.name}</p>
            <span className="text-[8px] font-semibold capitalize px-1.5 py-0.5 rounded" style={{ backgroundColor: `hsl(${accentHsl} / 0.15)`, color: ac }}>{profile.type}</span>
          </div>
        </div>

        {/* KPI lines — show key fields */}
        <div className="px-2.5 pb-1 flex-1 flex flex-col gap-0.5">
          {fields.slice(0, 5).map(([key, val]) => (
            <div key={key} className="flex items-center justify-between gap-1">
              <span className="text-[9px] text-muted-foreground truncate">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}</span>
              <span className="text-[9px] font-bold tabular-nums text-foreground shrink-0">{formatFieldValue(key, String(val)).slice(0, 20)}</span>
            </div>
          ))}
          {linkedCount > 0 && (
            <div className="flex items-center justify-between gap-1">
              <span className="text-[9px] text-muted-foreground">Linked</span>
              <span className="text-[9px] font-bold text-foreground">{linkedCount} items</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-2.5 pb-2 pt-0.5 flex items-center justify-between">
          <span className="text-[7px] font-semibold capitalize px-1.5 py-0.5 rounded" style={{ backgroundColor: `hsl(${accentHsl} / 0.12)`, color: ac }}>
            {TYPE_ICONS[profile.type] || '\u{1F4CB}'} {profile.type}
          </span>
          <button
            className="h-8 w-8 flex items-center justify-center text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(profile.id); }}
            data-testid={`btn-delete-profile-${profile.id}`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </Link>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function ProfilesPage() {
  useEffect(() => { document.title = "Profiles — Portol"; }, []);
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: profiles, isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    refetchOnMount: true,
  });
  const [showProfileSkeleton, setShowProfileSkeleton] = useState(false);
  useEffect(() => {
    if (!isLoading) { setShowProfileSkeleton(false); return; }
    const pid = setTimeout(() => setShowProfileSkeleton(true), 200);
    return () => clearTimeout(pid);
  }, [isLoading]);

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
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      const delProfile = profiles?.find(p => p.id === deleteId);
      toast({ title: `"${delProfile?.name || "Profile"}" deleted`, description: "All linked data removed" });
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

  if (showProfileSkeleton && !profiles) {
    return (
      <div className="p-4 md:p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {[...Array(8)].map((_, i) => <div key={i} className="h-28 rounded-xl skeleton-shimmer" />)}
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

  const TYPE_GROUP_ICONS: Record<string, string> = { self: '\u{1F464}', person: '\u{1F465}', pet: '\u{1F43E}', vehicle: '\u{1F697}', asset: '\u2B50', loan: '\u{1F4B3}', subscription: '\u{1F504}', investment: '\u{1F4C8}', property: '\u{1F3E0}', medical: '\u{1FA7A}' };
  const typeGroupLabel = (type: string) => {
    const icon = TYPE_GROUP_ICONS[type] || '\u{1F4CB}';
    if (type === "medical") return `${icon} Medical Providers`;
    const label = TYPE_LABELS[type] || type;
    return `${icon} ${label}s`;
  };

  const profileToDelete = deleteId ? (profiles || []).find((p) => p.id === deleteId) : null;

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-32" data-testid="page-profiles">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back to Dashboard">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
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
      ) : filteredProfiles.length === 0 && searchQuery.trim() ? (
        <EmptyState icon={Search} title="No matching profiles" description="Try a different search term." />
      ) : (
        sortedTypes.map((type) => (
          <div key={type}>
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 capitalize">
              {typeGroupLabel(type)} ({grouped[type].length})
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {grouped[type].slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((profile) => (
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
