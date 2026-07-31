// ── Concept → component ──────────────────────────────────────────────────────
// The client-side half of shared/icon-vocabulary.ts. That file names the icon
// for each concept (it lives under shared/ and must not import lucide-react);
// this one resolves the name to the component.
//
// Use `conceptIcon("habits")` rather than reaching for a Flame yourself, and a
// habit is a flame on every screen it appears on.

import {
  HeartPulse, Wallet, CalendarDays, FileText, Bell, CheckCircle2, Flame,
  Car, TrendingDown, Users, Activity, BookOpen, Sparkles, Target, Moon,
  Footprints, Pill, Brain, type LucideIcon,
} from "lucide-react";
import {
  ICON_VOCABULARY, CONCEPT_ACCENT, type ConceptIcon,
} from "@shared/icon-vocabulary";

const BY_NAME: Record<string, LucideIcon> = {
  HeartPulse, Wallet, CalendarDays, FileText, Bell, CheckCircle2, Flame,
  Car, TrendingDown, Users, Activity, BookOpen, Sparkles, Target, Moon,
  Footprints, Pill, Brain,
};

export function conceptIcon(concept: ConceptIcon): LucideIcon {
  return BY_NAME[ICON_VOCABULARY[concept]] ?? Activity;
}

export function conceptAccent(concept: ConceptIcon): string {
  return CONCEPT_ACCENT[concept];
}

export type { ConceptIcon };
