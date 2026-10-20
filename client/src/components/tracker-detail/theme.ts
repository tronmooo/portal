// Visual identity for the tracker detail popup.
//
// Every tracker shares one layout and one set of components, but each KIND of
// tracker gets its own palette and icon so Nutrition doesn't look like Sleep
// doesn't look like Finance. Colors are stored as "H S%" pairs and rendered
// through `tone()`, which takes lightness from --td-l: darker in light mode,
// brighter in dark mode (index.css `.td-scope`), so the same palette reads
// well on both backgrounds.

import {
  Apple, Activity, Moon, Scale, HeartPulse, Droplets, Wallet, Flame, Smile, Pill,
  Target, Sparkles, type LucideIcon,
} from "lucide-react";

export type TrackerIdentity =
  | "nutrition" | "fitness" | "sleep" | "body" | "heart" | "hydration"
  | "finance" | "habit" | "mood" | "medication" | "productivity" | "custom";

export interface TrackerTheme {
  identity: TrackerIdentity;
  /** Main accent, "H S%". */
  hs: string;
  /** Gradient partner, "H S%". */
  hs2: string;
  /** Series palette for categories/fields, "H S%" each. */
  palette: string[];
  icon: LucideIcon;
}

/** A theme color as CSS, adapting its lightness to light/dark mode. */
export function tone(hs: string, alpha?: number): string {
  return alpha == null ? `hsl(${hs} var(--td-l, 55%))` : `hsl(${hs} var(--td-l, 55%) / ${alpha})`;
}

/** A theme color as a full "H S% L%" triple, for `--accent-hsl` consumers (.bubble, .medallion). */
export function accentTriple(hs: string): string {
  return `${hs} 52%`;
}

const THEMES: Record<TrackerIdentity, Omit<TrackerTheme, "identity">> = {
  nutrition:    { hs: "24 92%",  hs2: "350 82%", icon: Apple,      palette: ["199 85%", "38 92%", "346 80%", "152 62%", "275 65%", "24 92%"] },
  fitness:      { hs: "152 68%", hs2: "190 80%", icon: Activity,   palette: ["152 68%", "190 80%", "84 65%", "38 92%", "262 70%", "330 70%"] },
  sleep:        { hs: "248 75%", hs2: "280 70%", icon: Moon,       palette: ["248 75%", "280 70%", "205 80%", "320 60%", "190 70%", "40 85%"] },
  body:         { hs: "198 88%", hs2: "225 82%", icon: Scale,      palette: ["198 88%", "225 82%", "170 65%", "260 70%", "38 90%", "340 75%"] },
  heart:        { hs: "350 82%", hs2: "15 88%",  icon: HeartPulse, palette: ["350 82%", "205 80%", "38 90%", "15 88%", "152 60%", "270 65%"] },
  hydration:    { hs: "200 92%", hs2: "182 80%", icon: Droplets,   palette: ["200 92%", "182 80%", "220 80%", "160 60%", "250 70%", "38 90%"] },
  finance:      { hs: "155 62%", hs2: "178 70%", icon: Wallet,     palette: ["155 62%", "205 80%", "38 90%", "275 65%", "350 75%", "178 70%"] },
  habit:        { hs: "265 75%", hs2: "300 68%", icon: Flame,      palette: ["265 75%", "300 68%", "200 80%", "38 90%", "152 60%", "350 75%"] },
  mood:         { hs: "35 92%",  hs2: "320 72%", icon: Smile,      palette: ["35 92%", "320 72%", "200 80%", "152 60%", "265 70%", "0 75%"] },
  medication:   { hs: "330 72%", hs2: "280 62%", icon: Pill,       palette: ["330 72%", "280 62%", "200 80%", "152 60%", "38 90%", "15 85%"] },
  productivity: { hs: "215 82%", hs2: "190 78%", icon: Target,     palette: ["215 82%", "190 78%", "265 70%", "38 90%", "152 60%", "340 70%"] },
  custom:       { hs: "190 75%", hs2: "245 70%", icon: Sparkles,   palette: ["190 75%", "245 70%", "330 70%", "38 90%", "152 60%", "15 85%"] },
};

interface ThemeInput {
  name?: string;
  category?: string;
  fields?: Array<{ name: string }>;
}

export function trackerIdentity(t: ThemeInput): TrackerIdentity {
  const name = String(t.name || "").toLowerCase();
  const cat = String(t.category || "").toLowerCase();
  const fields = (t.fields || []).map((f) => String(f.name).toLowerCase());
  const has = (re: RegExp) => fields.some((f) => re.test(f));

  if (/medication|prescription|supplement|drug/.test(cat) || (has(/^dos(e|age)$/) && has(/taken|adherence/))) return "medication";
  if (cat === "nutrition" || /nutrition|food|diet|meal|calori|macro/.test(name)) return "nutrition";
  if (/water|hydrat/.test(name)) return "hydration";
  if (cat === "sleep" || /sleep|\bnap\b/.test(name)) return "sleep";
  if (/blood\s*pressure|heart|pulse|\bbp\b|\bhr\b/.test(name) || (has(/^systolic$/) && has(/^diastolic$/))) return "heart";
  if (/weight|body\s*fat|bmi|waist|measurement/.test(name)) return "body";
  if (cat === "finance" || cat === "budget" || cat === "savings" || /spend|expense|budget|income|savings|money/.test(name)) return "finance";
  if (/fitness|exercise|workout|running/.test(cat) || /run|walk|cycl|bike|swim|workout|gym|lift|yoga|steps|push.?ups?|squat/.test(name)) return "fitness";
  if (cat === "habit" || cat === "routine") return "habit";
  if (/mood|mental|anxiety/.test(cat) || /mood|stress|anxiety|journal|gratitude|meditat/.test(name)) return "mood";
  if (cat === "productivity" || cat === "work" || cat === "education" || /focus|study|reading|pomodoro/.test(name)) return "productivity";
  return "custom";
}

export function trackerTheme(t: ThemeInput): TrackerTheme {
  const identity = trackerIdentity(t);
  return { identity, ...THEMES[identity] };
}

/** Fixed macro colors, so Protein is the same blue on every nutrition view. */
export const MACRO_HS = {
  protein: "199 85%",
  carbs: "38 92%",
  fat: "346 80%",
  fiber: "152 62%",
  sugar: "290 65%",
} as const;

/** CSS custom properties that scope a theme to a subtree. */
export function themeVars(theme: TrackerTheme): React.CSSProperties {
  return {
    ["--td-hs" as any]: theme.hs,
    ["--td-hs2" as any]: theme.hs2,
    ["--accent-hsl" as any]: accentTriple(theme.hs),
  };
}
