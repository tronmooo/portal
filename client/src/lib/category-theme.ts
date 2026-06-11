// ─────────────────────────────────────────────────────────────────────────────
// Central category theme system.
//
// Every tracker / category in Portol.me runs through `categoryTheme()` to get
// a consistent accent hue, icon, and label. This is the single source of
// truth — do NOT add inline category color logic anywhere else. If a new
// category emerges, extend the PALETTE table below.
//
// HSL values are written `H S% L%` (space-separated, no `hsl()` wrapper) so
// they can be composed into Tailwind/CSS strings as `hsl(${hsl})` or
// `hsl(${hsl} / 0.20)` for alpha.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Activity,
  HeartPulse,
  Flame,
  Droplet,
  TrendingUp,
  Heart,
  Sparkles,
  DollarSign,
  Gamepad2,
  Music,
  Briefcase,
  GraduationCap,
  Plane,
  Star,
  Tag,
  PiggyBank,
  Book,
  Coffee,
  Smile,
  Palette,
  ShoppingBag,
  Home,
  Car,
  Dumbbell,
  type LucideIcon,
} from "lucide-react";

export interface CategoryTheme {
  /** HSL accent in `H S% L%` form (no `hsl()` wrapper). */
  hsl: string;
  /** Lucide icon component. */
  icon: LucideIcon;
  /** Lowercased canonical label for the category. */
  label: string;
}

// ── Palette table ──────────────────────────────────────────────────────────
// Match by keyword presence in either `category` or `name`. Order matters:
// earlier rules win. Keep specific keywords above generic ones.
interface PaletteRule {
  keywords: string[];
  hsl: string;
  icon: LucideIcon;
  label: string;
}

const PALETTE: PaletteRule[] = [
  // ── Health & body ──
  { keywords: ["nutrition", "diet", "calorie", "meal", "food", "eating"], hsl: "20 88% 55%", icon: Flame, label: "nutrition" },
  { keywords: ["hydration", "water"], hsl: "199 89% 48%", icon: Droplet, label: "hydration" },
  { keywords: ["fitness", "exercise", "workout", "run", "walk", "steps", "bench", "squat", "gym", "cardio"], hsl: "142 71% 45%", icon: Dumbbell, label: "fitness" },
  { keywords: ["sleep", "rest"], hsl: "260 60% 60%", icon: Sparkles, label: "sleep" },
  { keywords: ["weight", "bmi", "body"], hsl: "183 98% 32%", icon: TrendingUp, label: "weight" },
  { keywords: ["blood pressure", "bp", "heart rate", "pulse", "vitals", "medical", "health"], hsl: "0 75% 58%", icon: HeartPulse, label: "health" },
  { keywords: ["mood", "mental", "wellness", "meditation", "mindful"], hsl: "330 75% 60%", icon: Heart, label: "wellness" },

  // ── Money ──
  { keywords: ["savings", "saving"], hsl: "160 75% 42%", icon: PiggyBank, label: "savings" },
  { keywords: ["finance", "money", "budget", "expense", "spending", "income", "bills", "debt"], hsl: "38 92% 50%", icon: DollarSign, label: "finance" },

  // ── Hobby / leisure ──
  { keywords: ["gaming", "game", "videogame", "esport"], hsl: "280 70% 55%", icon: Gamepad2, label: "gaming" },
  { keywords: ["music", "guitar", "piano", "drum", "instrument", "song", "practice"], hsl: "190 80% 50%", icon: Music, label: "music" },
  { keywords: ["creative", "art", "draw", "paint", "design"], hsl: "295 75% 60%", icon: Palette, label: "creative" },
  { keywords: ["entertainment", "movie", "show", "tv", "film", "watch"], hsl: "310 70% 58%", icon: Star, label: "entertainment" },
  { keywords: ["reading", "book", "read"], hsl: "30 50% 50%", icon: Book, label: "reading" },
  { keywords: ["hobby"], hsl: "240 60% 60%", icon: Star, label: "hobby" },

  // ── Productivity / work / school ──
  { keywords: ["productivity", "work", "career", "job", "task"], hsl: "220 50% 55%", icon: Briefcase, label: "productivity" },
  { keywords: ["education", "study", "learn", "school", "course", "language"], hsl: "270 60% 55%", icon: GraduationCap, label: "education" },

  // ── Lifestyle ──
  { keywords: ["lifestyle", "social", "friend", "family", "date"], hsl: "340 70% 62%", icon: Smile, label: "lifestyle" },
  { keywords: ["travel", "trip", "vacation", "flight"], hsl: "205 85% 55%", icon: Plane, label: "travel" },
  { keywords: ["shopping", "purchase"], hsl: "350 70% 60%", icon: ShoppingBag, label: "shopping" },
  { keywords: ["home", "house", "chore"], hsl: "25 60% 50%", icon: Home, label: "home" },
  { keywords: ["car", "vehicle", "drive", "commute"], hsl: "215 30% 45%", icon: Car, label: "vehicle" },
  { keywords: ["coffee", "drink", "alcohol"], hsl: "25 45% 40%", icon: Coffee, label: "drink" },

  // ── Misc ──
  { keywords: ["custom"], hsl: "170 60% 50%", icon: Tag, label: "custom" },
];

// ── Deterministic-hash fallback palette ────────────────────────────────────
// When no keyword matches, hash the tracker name to one of these hues so
// different unknown categories don't all collapse to the same color.
const FALLBACK_HUES: { hsl: string; icon: LucideIcon }[] = [
  { hsl: "170 60% 50%", icon: Tag },       // mint
  { hsl: "210 70% 55%", icon: Activity },  // blue
  { hsl: "265 60% 60%", icon: Sparkles },  // violet
  { hsl: "320 65% 58%", icon: Star },      // pink
  { hsl: "45 80% 50%", icon: TrendingUp }, // amber
  { hsl: "175 65% 42%", icon: Activity },  // teal
  { hsl: "230 55% 60%", icon: Briefcase }, // indigo
  { hsl: "10 75% 58%", icon: Flame },      // coral
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// ── Public API ─────────────────────────────────────────────────────────────
export function categoryTheme(category?: string | null, name?: string | null): CategoryTheme {
  const cat = (category || "").toLowerCase();
  const nm = (name || "").toLowerCase();
  const haystack = `${cat} ${nm}`;

  for (const rule of PALETTE) {
    if (rule.keywords.some(k => haystack.includes(k))) {
      return { hsl: rule.hsl, icon: rule.icon, label: rule.label };
    }
  }

  // Deterministic fallback — pick a hue based on the hash of (category||name)
  // so the same tracker always gets the same color, but different unknown
  // trackers don't collide.
  const seed = cat || nm || "default";
  const pick = FALLBACK_HUES[hashString(seed) % FALLBACK_HUES.length];
  return { hsl: pick.hsl, icon: pick.icon, label: cat || "tracker" };
}

// Convenience: object-shaped (tracker object) overload used in most call sites.
export function trackerTheme(tracker: { category?: string | null; name?: string | null }): CategoryTheme {
  return categoryTheme(tracker?.category, tracker?.name);
}

// Helpers for building CSS color strings from a theme.
export function themeColor(t: CategoryTheme, alpha?: number): string {
  return alpha == null ? `hsl(${t.hsl})` : `hsl(${t.hsl} / ${alpha})`;
}
