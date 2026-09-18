// NOTE: This component is part of the Profile Type Registry system.
// It was built but not yet integrated into the main UI.
// The legacy tab system in profile-detail.tsx is the active system.
// Integration planned for a future release.

/**
 * ProfileTypeSelector
 *
 * A categorized type picker that fetches profile type definitions from
 * /api/profile-types and renders them as clickable cards grouped by category.
 * Includes a search/filter input and dynamic lucide-react icon resolution.
 */

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Car,
  Home,
  CreditCard,
  Shield,
  DollarSign,
  Building2,
  PiggyBank,
  Wallet,
  Heart,
  User,
  PawPrint,
  Star,
  Briefcase,
  Phone,
  Monitor,
  Gem,
  Palette,
  Music,
  Dumbbell,
  Wrench,
  Tractor,
  Brain,
  Globe,
  Bitcoin,
  Wine,
  Target,
  Flame,
  Zap,
  Cloud,
  Package,
  Key,
  Landmark,
  Search,
  HelpCircle,
  // QA 2026-09-18 (asset type picker): Motorcycle, Boat, RV, Aircraft,
  // Electronics, Fine Art, HSA, 529 and Savings Account all fell through
  // to the generic "?" — their registry icon names were not in this map.
  Bike,
  Ship,
  Sailboat,
  Plane,
  Caravan,
  Laptop,
  Cpu,
  Smartphone,
  Tablet,
  Camera,
  Watch,
  Sofa,
  GraduationCap,
  HeartPulse,
  Coins,
  Banknote,
  Truck,
  TrendingUp,
  BarChart3,
  Building,
} from "lucide-react";
import type { FieldDef } from "./DynamicProfileForm";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface TypeDefinition {
  type_key: string;
  label: string;
  category: string;
  description: string;
  icon: string;
  field_schema: FieldDef[];
  tab_config: any[];
  default_parent_type?: string;
}

export interface ProfileTypeSelectorProps {
  onSelect: (typeKey: string, typeDef: TypeDefinition) => void;
  selectedKey?: string;
  /**
   * If set, only show types whose normalized category matches.
   * e.g. "assets" → hides liabilities/subscriptions/people.
   * Pass an array to allow multiple categories.
   */
  categoryFilter?: string | string[];
}

// ─────────────────────────────────────────────
// Icon Registry
// ─────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  Car,
  Home,
  CreditCard,
  Shield,
  DollarSign,
  Building2,
  PiggyBank,
  Wallet,
  Heart,
  User,
  PawPrint,
  Star,
  Briefcase,
  Phone,
  Monitor,
  Gem,
  Palette,
  Music,
  Dumbbell,
  Wrench,
  Tractor,
  Brain,
  Globe,
  Bitcoin,
  Wine,
  Target,
  Flame,
  Zap,
  Cloud,
  Package,
  Key,
  Landmark,
  Bike,
  Ship,
  Sailboat,
  Plane,
  Caravan,
  Laptop,
  Cpu,
  Smartphone,
  Tablet,
  Camera,
  Watch,
  Sofa,
  GraduationCap,
  HeartPulse,
  Coins,
  Banknote,
  Truck,
  TrendingUp,
  BarChart3,
  Building,
};

// Registry icon names arrive in several spellings ("PiggyBank",
// "piggy-bank", "piggy_bank"); compare on letters only.
const iconKeyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const ICON_BY_KEY: Record<string, React.ElementType> = Object.fromEntries(
  Object.entries(ICON_MAP).map(([k, v]) => [iconKeyOf(k), v]),
);

// When the registry names no icon we know, pick one from what the TYPE is
// (its key and label), so a new type never shows the "?" placeholder.
const TYPE_ICON_RULES: Array<[RegExp, React.ElementType]> = [
  [/motorcycle|motorbike|scooter|bicycle|\bbike\b/i, Bike],
  [/\brv\b|camper|caravan|motorhome|trailer/i, Caravan],
  [/aircraft|airplane|plane|jet|helicopter/i, Plane],
  [/sailboat|yacht/i, Sailboat],
  [/\bboat|vessel|watercraft|jet\s*ski/i, Ship],
  [/electronic|computer|laptop|gadget|device/i, Laptop],
  [/phone|mobile/i, Smartphone],
  [/tablet|ipad/i, Tablet],
  [/camera|photo/i, Camera],
  [/watch|jewel|jewellery|jewelry/i, Gem],
  [/fine\s*art|artwork|painting|sculpture|collectible/i, Palette],
  [/furniture|sofa|couch/i, Sofa],
  [/\bhsa\b|health\s*savings|fsa|medical\s*savings/i, HeartPulse],
  [/529|college|education|tuition/i, GraduationCap],
  [/savings|checking|bank\s*account|cash/i, PiggyBank],
  [/401|ira\b|retirement|pension|brokerage|invest|stock|fund|portfolio/i, TrendingUp],
  [/crypto|bitcoin/i, Bitcoin],
  [/truck|van\b/i, Truck],
  [/car\b|vehicle|auto/i, Car],
  [/house|home|condo|apartment|property|real\s*estate|land\b/i, Home],
  [/loan|mortgage|debt|credit/i, CreditCard],
  [/insurance|policy|warranty/i, Shield],
  [/business|company|llc/i, Briefcase],
  [/pet|dog|cat/i, PawPrint],
  [/person|people|family|contact/i, User],
];

function resolveIcon(iconName: string, typeKey?: string, label?: string): React.ElementType {
  if (iconName) {
    // Exact, then case-insensitive, then spelling-insensitive.
    if (ICON_MAP[iconName]) return ICON_MAP[iconName];
    const byKey = ICON_BY_KEY[iconKeyOf(iconName)];
    if (byKey) return byKey;
  }
  const hint = `${typeKey || ""} ${label || ""}`.replace(/_/g, " ");
  for (const [re, icon] of TYPE_ICON_RULES) if (re.test(hint)) return icon;
  return HelpCircle;
}

// ─────────────────────────────────────────────
// Category ordering
// ─────────────────────────────────────────────

const CATEGORY_ORDER: string[] = [
  "people",
  "assets",
  "liabilities",
  "subscriptions",
  "insurance",
  "investments",
  "property",
];

const CATEGORY_LABELS: Record<string, string> = {
  people: "People",
  assets: "Assets",
  liabilities: "Liabilities",
  subscriptions: "Subscriptions & Recurring",
  insurance: "Insurance",
  investments: "Investments",
  property: "Property",
};

function normalizeCategory(raw: string): string {
  const lower = raw.toLowerCase();
  // Handle common aliases
  if (lower.includes("subscript") || lower.includes("recurring")) return "subscriptions";
  if (lower.includes("invest")) return "investments";
  if (lower.includes("liab") || lower.includes("debt") || lower.includes("loan")) return "liabilities";
  if (lower.includes("insur")) return "insurance";
  if (lower.includes("asset")) return "assets";
  if (lower.includes("propert") || lower.includes("real estate")) return "property";
  if (lower.includes("people") || lower.includes("person") || lower.includes("contact")) return "people";
  return lower;
}

function sortCategories(categories: string[]): string[] {
  const ordered = CATEGORY_ORDER.filter((c) => categories.includes(c));
  const rest = categories.filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...ordered, ...rest];
}

// ─────────────────────────────────────────────
// TypeCard
// ─────────────────────────────────────────────

interface TypeCardProps {
  typeDef: TypeDefinition;
  selected: boolean;
  onSelect: () => void;
}

function TypeCard({ typeDef, selected, onSelect }: TypeCardProps) {
  const Icon = resolveIcon(typeDef.icon, typeDef.type_key, typeDef.label);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left flex items-start gap-3 p-3 rounded-lg border transition-all duration-150",
        "hover:bg-accent/60 hover:border-primary/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        selected
          ? "border-primary bg-primary/5 ring-2 ring-primary/30"
          : "border-border bg-card"
      )}
      aria-pressed={selected}
    >
      <span
        className={cn(
          "mt-0.5 flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center",
          selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="w-4 h-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium leading-tight", selected && "text-primary")}>
          {typeDef.label}
        </p>
        {typeDef.description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {typeDef.description}
          </p>
        )}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────
// ProfileTypeSelector
// ─────────────────────────────────────────────

export default function ProfileTypeSelector({
  onSelect,
  selectedKey,
  categoryFilter,
}: ProfileTypeSelectorProps) {
  const [search, setSearch] = useState("");

  const { data: typeDefs, isLoading, isError } = useQuery<TypeDefinition[]>({
    queryKey: ["/api/profile-types"],
  });

  // Group and filter
  const grouped = useMemo(() => {
    if (!typeDefs) return new Map<string, TypeDefinition[]>();

    const allowedCategories = categoryFilter
      ? new Set((Array.isArray(categoryFilter) ? categoryFilter : [categoryFilter]).map((c) => c.toLowerCase()))
      : null;

    const q = search.trim().toLowerCase();
    const filtered = typeDefs.filter((t) => {
      // Category gate
      if (allowedCategories) {
        const norm = normalizeCategory(t.category ?? "assets");
        if (!allowedCategories.has(norm)) return false;
      }
      // Search gate
      if (!q) return true;
      return (
        t.label.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.category?.toLowerCase().includes(q) ||
        t.type_key.toLowerCase().includes(q)
      );
    });

    const map = new Map<string, TypeDefinition[]>();
    for (const t of filtered) {
      const cat = normalizeCategory(t.category ?? "assets");
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(t);
    }
    return map;
  }, [typeDefs, search, categoryFilter]);

  const sortedCategories = useMemo(
    () => sortCategories(Array.from(grouped.keys())),
    [grouped]
  );

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-full" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[1, 2, 3, 4].map((j) => (
                <Skeleton key={j} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── Error state ──
  if (isError) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Failed to load profile types. Please try again.
      </div>
    );
  }

  // ── Empty search result ──
  const hasResults = sortedCategories.length > 0;

  return (
    <div className="space-y-5">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          placeholder="Search profile types…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {!hasResults && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No profile types match &quot;{search}&quot;.
        </p>
      )}

      {/* Category sections */}
      {sortedCategories.map((cat) => {
        const types = grouped.get(cat) ?? [];
        const label = CATEGORY_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
        return (
          <section key={cat}>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="micro-label text-muted-foreground">
                {label}
              </h3>
              <Badge variant="secondary" className="text-xs px-1.5 py-0">
                {types.length}
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {types.map((t) => (
                <TypeCard
                  key={t.type_key}
                  typeDef={t}
                  selected={selectedKey === t.type_key}
                  onSelect={() => onSelect(t.type_key, t)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export { ProfileTypeSelector };
