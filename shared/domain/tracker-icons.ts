// shared/domain/tracker-icons.ts — category-driven icons for trackers and habits.
//
// Icons were picked three ways (a concept vocabulary, a client-only keyword
// palette, and a per-page `iconForKind` whose default was Activity but whose
// "bp" case returned Heart), and a heart glyph was the fallback on surfaces
// that had nothing better. This is the one resolver: semantic keyword first,
// then category, then a neutral fallback that is never a heart.
//
// Names only (lucide-react icon names) so server code and tests can import it.
// Pure. Pinned by tests/consistency-layer-trackers.test.ts.

export type TrackerIconCategory =
  | "strength" | "cardio" | "sport" | "flexibility" | "sleep" | "nutrition"
  | "hydration" | "caffeine" | "hygiene" | "vitals" | "medication" | "mental"
  | "productivity" | "finance" | "lifestyle" | "custom";

const SEMANTIC_RULES: Array<{ category: TrackerIconCategory; icon: string; match: RegExp }> = [
  { category: "vitals",       icon: "Heart",       match: /\b(heart\s*rate|pulse|\bhr\b|bpm|hrv)\b/i },
  { category: "vitals",       icon: "Gauge",       match: /\b(blood\s*pressure|\bbp\b|systolic|diastolic)\b/i },
  { category: "vitals",       icon: "Thermometer", match: /\b(temperature|fever)\b/i },
  { category: "vitals",       icon: "Scale",       match: /\b(weight|bmi|body\s*fat|waist)\b/i },
  { category: "strength",     icon: "Dumbbell",    match: /\b(strength|weights?\s*lift|lifting|bench|squat|deadlift|press|curl|pull[- ]?up|push[- ]?up|dumbbell|barbell|kettlebell|core\s*workout|workout)\b/i },
  { category: "cardio",       icon: "Footprints",  match: /\b(run|running|jog|walk|walking|steps?|hike|hiking|treadmill)\b/i },
  { category: "cardio",       icon: "Bike",        match: /\b(cycl|bike|biking|spin)\b/i },
  { category: "cardio",       icon: "Waves",       match: /\b(swim|laps?)\b/i },
  { category: "sport",        icon: "Trophy",      match: /\b(soccer|football|basketball|tennis|golf|pickleball|baseball|hockey|volleyball|climb)\b/i },
  { category: "flexibility",  icon: "StretchHorizontal", match: /\b(stretch|stretching|yoga|pilates|mobility)\b/i },
  { category: "mental",       icon: "Brain",       match: /\b(meditat|mindful|breath|journal|mood|anxiety|stress|energy)\b/i },
  { category: "sleep",        icon: "Moon",        match: /\b(sleep|nap|bedtime)\b/i },
  { category: "caffeine",     icon: "Coffee",      match: /\b(coffee|espresso|caffeine|tea|latte)\b/i },
  { category: "hydration",    icon: "Droplets",    match: /\b(water|hydrat)\b/i },
  { category: "nutrition",    icon: "Utensils",    match: /\b(meal|calories?|protein|carbs?|nutrition|diet|food|snack)\b/i },
  { category: "hygiene",      icon: "ShowerHead",  match: /\b(shower|bath|bathe)\b/i },
  { category: "hygiene",      icon: "Sparkles",    match: /\b(teeth|brush|floss|dental|skincare|hygiene)\b/i },
  { category: "hygiene",      icon: "Bath",        match: /\b(bathroom|toilet|restroom|pee|poop)\b/i },
  { category: "medication",   icon: "Pill",        match: /\b(medication|medicine|pill|dose|vitamin|supplement|mg\b)\b/i },
  { category: "finance",      icon: "Wallet",      match: /\b(spend|spending|budget|savings?|money|expense)\b/i },
  { category: "productivity", icon: "CheckCircle2", match: /\b(focus|pomodoro|deep\s*work|study|reading|read\b|pages)\b/i },
  { category: "lifestyle",    icon: "Cigarette",   match: /\b(smok|cigarette|vape|nicotine)\b/i },
  { category: "lifestyle",    icon: "Wine",        match: /\b(alcohol|drink|beer|wine)\b/i },
];

const CATEGORY_ICON: Record<string, { category: TrackerIconCategory; icon: string }> = {
  fitness:      { category: "strength",     icon: "Dumbbell" },
  strength:     { category: "strength",     icon: "Dumbbell" },
  cardio:       { category: "cardio",       icon: "Footprints" },
  sport:        { category: "sport",        icon: "Trophy" },
  flexibility:  { category: "flexibility",  icon: "StretchHorizontal" },
  health:       { category: "vitals",       icon: "HeartPulse" },
  vitals:       { category: "vitals",       icon: "HeartPulse" },
  sleep:        { category: "sleep",        icon: "Moon" },
  nutrition:    { category: "nutrition",    icon: "Utensils" },
  hydration:    { category: "hydration",    icon: "Droplets" },
  mental:       { category: "mental",       icon: "Brain" },
  mood:         { category: "mental",       icon: "Brain" },
  medication:   { category: "medication",   icon: "Pill" },
  productivity: { category: "productivity", icon: "CheckCircle2" },
  finance:      { category: "finance",      icon: "Wallet" },
  lifestyle:    { category: "lifestyle",    icon: "Sparkles" },
  habit:        { category: "lifestyle",    icon: "Flame" },
  hygiene:      { category: "hygiene",      icon: "ShowerHead" },
  weight:       { category: "vitals",       icon: "Scale" },
};

/** The fallback for anything unrecognised. Deliberately not a heart. */
export const FALLBACK_TRACKER_ICON = "Activity";

export interface TrackerIconResolution {
  icon: string;
  category: TrackerIconCategory;
  /** "semantic" — the name said what it is; "category" — the stored category; "fallback". */
  source: "explicit" | "semantic" | "category" | "fallback";
}

/**
 * Icon for a tracker or habit. An explicit, non-default icon on the record
 * wins; then the name's semantics; then the category; then a neutral glyph.
 */
export function resolveTrackerIcon(input: { name?: string | null; category?: string | null; icon?: string | null } | null | undefined): TrackerIconResolution {
  const name = String(input?.name ?? "");
  const category = String(input?.category ?? "").toLowerCase();
  const explicit = String(input?.icon ?? "").trim();
  // A stored icon that is not the generic default or an emoji placeholder is respected.
  if (explicit && /^[A-Z][A-Za-z0-9]+$/.test(explicit) && explicit !== "Heart" && explicit !== FALLBACK_TRACKER_ICON) {
    return { icon: explicit, category: CATEGORY_ICON[category]?.category ?? "custom", source: "explicit" };
  }
  for (const rule of SEMANTIC_RULES) {
    if (rule.match.test(name)) return { icon: rule.icon, category: rule.category, source: "semantic" };
  }
  const byCat = CATEGORY_ICON[category];
  if (byCat) return { icon: byCat.icon, category: byCat.category, source: "category" };
  return { icon: FALLBACK_TRACKER_ICON, category: "custom", source: "fallback" };
}

export function trackerIconName(input: Parameters<typeof resolveTrackerIcon>[0]): string {
  return resolveTrackerIcon(input).icon;
}
