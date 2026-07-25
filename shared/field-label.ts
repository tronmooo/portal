// ── Human-readable field labels ──────────────────────────────────────────────
// Tracker fields are stored under machine keys. Hand-authored shapes use
// snake_case ("heart_rate"); AI-created trackers use camelCase
// ("caloriesBurned", "paceMinutesPerMile"). Rendering the raw key with a CSS
// `capitalize` produced "CaloriesBurned" / "PaceMinutesPerMile" in the entry
// form — this turns either convention into "Calories Burned" / "Heart Rate".
//
// A field may override the derived label with an explicit `label`.
// Unit-tested in tests/field-label.test.ts.

/** Acronyms and unit tokens that should not be title-cased into "Rpe"/"Bpm". */
const UPPERCASE_TOKENS = new Set(["bp", "hr", "rpe", "bmi", "bpm", "spo2", "hrv", "id", "url", "ml", "mg", "km", "kg", "lbs", "mph", "rem"]);

/** "caloriesBurned" | "calories_burned" | "SpeedMph" → "Calories Burned". */
export function humanizeFieldName(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPServer → HTTP Server
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map(w => {
      const lower = w.toLowerCase();
      if (UPPERCASE_TOKENS.has(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Display label for a tracker field: its explicit `label`, else derived. */
export function trackerFieldLabel(field: { name: string; label?: string }): string {
  return field.label?.trim() || humanizeFieldName(field.name);
}
