// The icon and color of a custom AI Mode: a fixed set (shared/ai-modes.ts),
// so a mode can never ask for markup or a picture from elsewhere.
import {
  Apple, BarChart3, Book, Brain, Briefcase, CalendarDays, Car, Compass, Dumbbell, GraduationCap, Heart, Home, Leaf, Moon, PawPrint,
  Plane, Search, Sparkles, Target, Wallet, type LucideIcon,
} from "lucide-react";
import { MODE_COLORS, type ModeColor, type ModeIcon } from "@shared/ai-modes";

export const MODE_ICON_COMPONENTS: Record<ModeIcon, LucideIcon> = {
  sparkles: Sparkles, heart: Heart, dumbbell: Dumbbell, apple: Apple, wallet: Wallet, briefcase: Briefcase, car: Car,
  graduation: GraduationCap, plane: Plane, search: Search, brain: Brain, target: Target, book: Book, home: Home,
  paw: PawPrint, leaf: Leaf, moon: Moon, chart: BarChart3, calendar: CalendarDays, compass: Compass,
};

export const modeHsl = (color: ModeColor) => MODE_COLORS[color] ?? MODE_COLORS.violet;

export function ModeGlyph({ icon, color, size = "md" }: { icon: ModeIcon; color: ModeColor; size?: "sm" | "md" | "lg" }) {
  const Icon = MODE_ICON_COMPONENTS[icon] ?? Sparkles;
  const box = size === "lg" ? "h-11 w-11 rounded-2xl" : size === "sm" ? "h-7 w-7 rounded-lg" : "h-9 w-9 rounded-xl";
  const glyph = size === "lg" ? "h-6 w-6" : size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const hsl = modeHsl(color);
  return (
    <span className={`${box} shrink-0 flex items-center justify-center`} style={{ background: `hsl(${hsl} / 0.16)`, color: `hsl(${hsl})`, boxShadow: `inset 0 0 0 1px hsl(${hsl} / 0.35)` }} aria-hidden="true">
      <Icon className={glyph} />
    </span>
  );
}
