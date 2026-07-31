// ── Icon vocabulary ──────────────────────────────────────────────────────────
// One icon per concept, for the whole app.
//
// From the redesign brief: heart = health, dollar = finance, calendar = dates,
// folder = documents, bell = alerts, check = tasks, flame = habits.
//
// This exists because a concept picking up a different glyph on a different
// screen is the same failure as it picking up a different card shape — you stop
// recognising it. Habits were Flame on the Executive tab and CheckCircle2 in
// the wellness grid; documents were FileText in one place and Folder in
// another. Both read as different features.
//
// Deliberately *names*, not imported components: this file is under shared/ and
// is imported by server-side code paths and tests that must not pull lucide-react
// into their bundle. The client maps these names to components in
// client/src/lib/icon-map.ts.

export type ConceptIcon =
  | "health" | "finance" | "dates" | "documents" | "alerts" | "tasks" | "habits"
  | "assets" | "liabilities" | "people" | "trackers" | "journal" | "insights"
  | "goals" | "sleep" | "nutrition" | "activity" | "medication" | "mental";

/** Concept → the lucide icon name that always represents it. */
export const ICON_VOCABULARY: Record<ConceptIcon, string> = {
  // The seven from the brief.
  health:      "HeartPulse",
  finance:     "Wallet",
  dates:       "CalendarDays",
  documents:   "FileText",
  alerts:      "Bell",
  tasks:       "CheckCircle2",
  habits:      "Flame",

  // The rest of the app's nouns, fixed by the same rule.
  assets:      "Car",
  liabilities: "TrendingDown",
  people:      "Users",
  trackers:    "Activity",
  journal:     "BookOpen",
  insights:    "Sparkles",
  goals:       "Target",
  sleep:       "Moon",
  nutrition:   "Flame",
  activity:    "Footprints",
  medication:  "Pill",
  mental:      "Brain",
};

/** The accent each concept wears, so colour and icon never disagree. */
export const CONCEPT_ACCENT: Record<ConceptIcon, string> = {
  health:      "0 72% 58%",
  finance:     "155 65% 45%",
  dates:       "213 90% 62%",
  documents:   "25 80% 54%",
  alerts:      "43 96% 53%",
  tasks:       "262 70% 62%",
  habits:      "155 65% 45%",
  assets:      "262 60% 62%",
  liabilities: "0 72% 55%",
  people:      "213 90% 62%",
  trackers:    "173 60% 44%",
  journal:     "262 70% 62%",
  insights:    "280 75% 62%",
  goals:       "262 70% 62%",
  sleep:       "262 70% 62%",
  nutrition:   "25 90% 58%",
  activity:    "213 90% 62%",
  medication:  "330 75% 62%",
  mental:      "262 70% 62%",
};

export function iconFor(concept: ConceptIcon): string {
  return ICON_VOCABULARY[concept];
}

export function accentFor(concept: ConceptIcon): string {
  return CONCEPT_ACCENT[concept];
}
