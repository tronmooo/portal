// ── Canonical tracker category groups + health score ─────────────────────────
// Extracted from pages/trackers.tsx (2026-07-08) so lightweight, eagerly-loaded
// UI (the hub KPI strip) can classify trackers and compute the health score
// WITHOUT importing the ~8k-line trackers page chunk. trackers.tsx re-imports
// these — there is exactly one copy of the logic.
//
// NOTE: the icon/accent group metadata (CANONICAL_GROUPS) deliberately stays in
// trackers.tsx — it drags lucide icons along and is presentation-only.

import type { Tracker } from "@shared/schema";

// Map raw DB categories → canonical display groups
export const CANONICAL_GROUP_MAP: Record<string, string> = {
  // Health (body vitals, medical, sleep, nutrition, mental, lab work)
  health:       "Health",
  sleep:        "Health",
  nutrition:    "Health",
  mental:       "Mental & Wellness",
  medical:      "Health",
  vitals:       "Health",
  hydration:    "Health",
  diet:         "Health",
  mood:         "Mental & Wellness",
  physical:     "Health",
  // Lab panels / blood work / clinical results all roll up into Health
  "metabolic panel":      "Health",
  "complete blood count": "Health",
  "lipid panel":          "Health",
  "lipid profile":        "Health",
  "thyroid panel":        "Health",
  "liver panel":          "Health",
  "kidney panel":         "Health",
  "basic metabolic":      "Health",
  "comprehensive metabolic": "Health",
  "cbc":                  "Health",
  "bmp":                  "Health",
  "cmp":                  "Health",
  "lab":                  "Health",
  "labs":                 "Health",
  "lab results":          "Health",
  "lab work":             "Health",
  "blood":                "Health",
  "blood work":           "Health",
  "cholesterol":          "Health",
  "glucose":              "Health",
  "hormone":              "Health",
  "hormones":             "Health",
  "hormone panel":        "Health",
  "vitamin":              "Health",
  "vitamins":             "Health",
  "urinalysis":           "Health",
  "endocrine":            "Health",
  "immunology":           "Health",
  "hematology":           "Health",
  "chemistry":            "Health",
  // Fitness (movement, exercise, performance)
  fitness:      "Fitness",
  exercise:     "Fitness",
  workout:      "Fitness",
  sport:        "Fitness",
  running:      "Fitness",
  cardio:       "Fitness",
  strength:     "Fitness",
  steps:        "Fitness",
  activity:     "Fitness",
  weight:       "Fitness",
  // Finance
  finance:      "Finance",
  budget:       "Finance",
  savings:      "Finance",
  investment:   "Finance",
  // Habits & Routines
  habit:        "Habits & Routines",
  routine:      "Habits & Routines",
  daily:        "Habits & Routines",
  // Productivity
  productivity: "Productivity",
  work:         "Productivity",
  education:    "Productivity",
  // Medication
  medication:   "Medication",
  prescription: "Medication",
  supplement:   "Medication",
  drug:         "Medication",
  // Mental & Wellness
  meditation:   "Mental & Wellness",
  mindfulness:  "Mental & Wellness",
  anxiety:      "Mental & Wellness",
  stress:       "Mental & Wellness",
  journal:      "Mental & Wellness",
  // Lifestyle
  lifestyle:    "Lifestyle",
  pet:          "Lifestyle",
  plant:        "Lifestyle",
  social:       "Lifestyle",
  screen:       "Lifestyle",
  reading:      "Lifestyle",
  // Gaming/entertainment exact-match (added 2026-05-21 — see PR for Gaming
  // tracker mis-bucketing bug).
  gaming:       "Lifestyle",
  game:         "Lifestyle",
  entertainment:"Lifestyle",
  leisure:      "Lifestyle",
  hobby:        "Lifestyle",
  // Other
  custom:       "Other",
  general:      "Other",
};

export function getCanonicalGroup(category: string): string {
  const c = (category || "").toLowerCase().trim();
  if (!c) return "Other";
  // Exact match first
  const exact = CANONICAL_GROUP_MAP[c];
  if (exact) return exact;
  // Keyword fallback — categories like "Metabolic Panel - Fasting" or
  // "Vitals (morning)" should still land in Health.
  const healthKw = ["panel", "blood", "lab", "vital", "metabolic", "cbc", "bmp", "cmp", "glucose", "cholesterol", "hormone", "thyroid", "vitamin", "medical", "clinical", "health", "diet", "nutrition", "sleep", "hydration"];
  if (healthKw.some(k => c.includes(k))) return "Health";
  const fitnessKw = ["workout", "exercise", "run", "cardio", "strength", "sport", "steps", "gym", "yoga", "hike"];
  if (fitnessKw.some(k => c.includes(k))) return "Fitness";
  const financeKw = ["finance", "money", "budget", "saving", "invest", "spend", "income"];
  if (financeKw.some(k => c.includes(k))) return "Finance";
  const medKw = ["med", "prescription", "supplement", "drug", "dose"];
  if (medKw.some(k => c.includes(k))) return "Medication";
  const mentalKw = ["mood", "anxiety", "stress", "meditation", "journal", "therapy"];
  if (mentalKw.some(k => c.includes(k))) return "Mental & Wellness";
  const habitKw = ["habit", "routine", "daily"];
  if (habitKw.some(k => c.includes(k))) return "Habits & Routines";
  // Lifestyle keyword fallback — gaming/leisure/entertainment trackers
  // were silently bucketed into "Other" before this branch was added
  // (reported 2026-05-21: AI logged a Gaming tracker the user couldn’t find).
  const lifestyleKw = ["gaming","game","console","playstation","xbox","nintendo","steam","leisure","entertainment","hobby","screen","reading","book","social","tv","movie","streaming","netflix","pet ","plant"];
  if (lifestyleKw.some(k => c.includes(k))) return "Lifestyle";
  return "Other";
}

export function computeHealthScore(trackers: Tracker[]): number | null {
  const healthTrackers = trackers.filter((t) => getCanonicalGroup(t.category) === "Health" || getCanonicalGroup(t.category) === "Fitness");
  if (healthTrackers.length === 0) return null;

  let score = 0;
  let factors = 0;

  for (const t of healthTrackers) {
    if (t.entries.length === 0) continue;
    const last = t.entries[t.entries.length - 1];

    // BMI score
    if (last.computed?.bmi) {
      const bmi = last.computed.bmi;
      const bmiScore = bmi >= 18.5 && bmi <= 25 ? 100
        : bmi > 25 && bmi <= 30 ? 70
        : bmi > 30 ? 40
        : 50; // underweight
      score += bmiScore;
      factors++;
    }

    // Sleep quality
    if (last.computed?.sleepQuality) {
      const q = last.computed.sleepQuality;
      const qScore = q === "excellent" ? 100 : q === "good" ? 80 : q === "fair" ? 55 : 30;
      score += qScore;
      factors++;
    }

    // Blood pressure
    if (last.computed?.bloodPressureCategory) {
      const c = last.computed.bloodPressureCategory;
      const bpScore = c === "normal" ? 100 : c === "elevated" ? 70 : c === "high_stage1" ? 45 : c === "high_stage2" ? 25 : 10;
      score += bpScore;
      factors++;
    }

    // Activity (any entry in last 3 days = bonus)
    const threeDaysAgo = Date.now() - 3 * 86400000;
    const recentEntry = t.entries.some((e) => new Date(e.timestamp).getTime() > threeDaysAgo);
    if (recentEntry) {
      score += 75;
      factors++;
    }
  }

  return factors > 0 ? Math.round(score / factors) : null;
}
