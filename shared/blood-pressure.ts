// ── Blood pressure — ONE verdict for one reading ─────────────────────────────
// QA 2026-09-18 (F-33): the same 121/76 read "In range" on the Trackers card
// and "Systolic 121 — High against Ref 90–120" on the Wellness tab, because
// the card had its own thresholds and the Wellness readout flagged each number
// against a single-value reference range. A blood pressure is a PAIR, and the
// category is decided on both numbers together, by the standard table:
//
//   normal      < 120 and < 80
//   elevated    120–129 and < 80
//   stage 1     130–139 or 80–89
//   stage 2     ≥ 140 or ≥ 90
//   crisis      ≥ 180 or ≥ 120
//   low         < 90 or < 60
//
// Every surface — the tracker card badge, the server's computed category, the
// Wellness body panel — calls classifyBloodPressure and renders its label, so
// they cannot disagree. Pure and dependency-free.

export type BloodPressureCategory = "low" | "normal" | "elevated" | "high_stage1" | "high_stage2" | "crisis";

export interface BloodPressureVerdict {
  category: BloodPressureCategory;
  /** Badge text: "Normal", "Elevated", "Stage 1 high", … */
  label: string;
  /** How the number should be coloured. */
  tone: "good" | "warn" | "bad";
  /** One sentence for an insight line. */
  sentence: string;
}

const LABELS: Record<BloodPressureCategory, { label: string; tone: BloodPressureVerdict["tone"] }> = {
  low: { label: "Low", tone: "warn" },
  normal: { label: "Normal", tone: "good" },
  elevated: { label: "Elevated", tone: "warn" },
  high_stage1: { label: "Stage 1 high", tone: "bad" },
  high_stage2: { label: "Stage 2 high", tone: "bad" },
  crisis: { label: "Crisis", tone: "bad" },
};

export function bloodPressureCategory(systolic: number, diastolic: number): BloodPressureCategory {
  if (systolic >= 180 || diastolic >= 120) return "crisis";
  if (systolic >= 140 || diastolic >= 90) return "high_stage2";
  if (systolic >= 130 || diastolic >= 80) return "high_stage1";
  if (systolic < 90 || diastolic < 60) return "low";
  if (systolic >= 120) return "elevated";
  return "normal";
}

export function classifyBloodPressure(systolic: number, diastolic: number): BloodPressureVerdict {
  const category = bloodPressureCategory(systolic, diastolic);
  const { label, tone } = LABELS[category];
  const reading = `${Math.round(systolic)}/${Math.round(diastolic)}`;
  const sentence =
    category === "normal" ? `Blood pressure is ${reading} — within a normal range.`
    : category === "elevated" ? `Slightly elevated at ${reading}. Worth keeping an eye on.`
    : category === "low" ? `${reading} is on the low side.`
    : category === "crisis" ? `${reading} is very high — seek medical attention.`
    : `${reading} is high — consider talking to your doctor.`;
  return { category, label, tone, sentence };
}

/** The category a verdict maps to on the Wellness reference-range pill. */
export function bloodPressureFlag(category: BloodPressureCategory): "low" | "normal" | "elevated" | "high" {
  if (category === "low") return "low";
  if (category === "normal") return "normal";
  if (category === "elevated") return "elevated";
  return "high";
}

/** Human reference text for each half of the pair. */
export const BLOOD_PRESSURE_REFERENCE = { systolic: "< 120 mmHg", diastolic: "< 80 mmHg" } as const;
