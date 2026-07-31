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
  Building2, CreditCard, Stethoscope, Wallet, Shield, Gem, type LucideIcon,
} from "lucide-react";

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

export function profileVisual(type: string | null | undefined): ProfileVisual {
  return VISUALS[String(type || "").toLowerCase()] ?? FALLBACK;
}

export function profileAccentHsl(type: string | null | undefined): string {
  return profileVisual(type).accent;
}
