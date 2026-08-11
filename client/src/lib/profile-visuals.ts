// ── Profile type → icon + accent ─────────────────────────────────────────────
// One place that answers "what colour and glyph is an asset?".
//
// The values here are not new: they're the ones the Linked/Trackers grid already
// paints its cards with (pages/trackers.tsx — liabilities '0 72% 55%', assets
// '262 60% 62%', documents '25 80% 54%'), which in turn come from
// CONCEPT_ACCENT in shared/icon-vocabulary.ts. Tapping a purple asset card and
// landing on a purple asset page is the whole point; before this, the card was
// purple and the detail page opened under an olive-green gradient banner.

import {
  User, Users, PawPrint, Car, Home, Package, TrendingUp, TrendingDown,
  Building2, CreditCard, Stethoscope, Wallet, Shield, Gem, PiggyBank,
  Banknote, Landmark, type LucideIcon,
} from "lucide-react";
import { accountKindOf, type AccountKind } from "@shared/account-kinds";

export interface ProfileVisual {
  icon: LucideIcon;
  /** HSL triple `H S% L%`, no wrapper — feeds --accent-hsl. */
  accent: string;
}

const VISUALS: Record<string, ProfileVisual> = {
  self:         { icon: User,        accent: "213 90% 62%" },
  person:       { icon: Users,       accent: "213 90% 62%" },
  pet:          { icon: PawPrint,    accent: "25 85% 55%"  },

  // Things you own.
  asset:        { icon: Package,     accent: "262 60% 62%" },
  vehicle:      { icon: Car,         accent: "262 60% 62%" },
  property:     { icon: Home,        accent: "220 60% 55%" },
  investment:   { icon: TrendingUp,  accent: "142 60% 45%" },
  account:      { icon: Building2,   accent: "155 65% 45%" },
  collectible:  { icon: Gem,         accent: "280 60% 58%" },

  // Things you owe.
  liability:    { icon: TrendingDown, accent: "0 72% 55%"  },
  loan:         { icon: TrendingDown, accent: "0 72% 55%"  },
  subscription: { icon: CreditCard,   accent: "330 75% 60%" },

  medical:      { icon: Stethoscope, accent: "0 72% 58%"   },
  insurance:    { icon: Shield,      accent: "155 65% 45%" },
};

const FALLBACK: ProfileVisual = { icon: Wallet, accent: "240 20% 60%" };

/**
 * Accounts are all `type: "account"`, so the type alone would paint a checking
 * account, a brokerage and a credit card identically — three very different
 * things wearing one green bank icon. The KIND is what the user actually
 * distinguishes, so it picks the glyph, and the colour follows the balance
 * sheet: green for money held, red for money owed.
 */
const ACCOUNT_VISUALS: Record<AccountKind, ProfileVisual> = {
  checking:       { icon: Wallet,     accent: "155 65% 45%" },
  savings:        { icon: PiggyBank,  accent: "168 60% 42%" },
  cash:           { icon: Banknote,   accent: "142 60% 45%" },
  investment:     { icon: TrendingUp, accent: "142 60% 45%" },
  credit_card:    { icon: CreditCard, accent: "0 72% 55%"   },
  line_of_credit: { icon: CreditCard, accent: "12 75% 55%"  },
  loan:           { icon: Landmark,   accent: "0 72% 55%"   },
  other:          { icon: Building2,  accent: "213 90% 62%" },
};

/**
 * The icon + accent for a profile.
 *
 * Accepts either a bare type string (the original signature, still used by
 * grids that only know a type) or a whole profile — pass the profile whenever
 * you have one, so an account gets the visual for its kind rather than the
 * generic account visual.
 */
export function profileVisual(input: string | { type?: string | null } | null | undefined): ProfileVisual {
  const type = typeof input === "string" ? input : String(input?.type ?? "");
  const key = String(type || "").toLowerCase();
  if (key === "account" && input && typeof input !== "string") {
    return ACCOUNT_VISUALS[accountKindOf(input)] ?? VISUALS.account;
  }
  return VISUALS[key] ?? FALLBACK;
}

export function profileAccentHsl(input: string | { type?: string | null } | null | undefined): string {
  return profileVisual(input).accent;
}
