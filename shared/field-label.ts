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

// ── Internal enum values shown to a person ──────────────────────────────────
// Profile fields carry machine tokens the app itself writes: an asset's
// `assetSubtype` is "high_value_item", the valuation engine stamps
// `currentValueSource: "estimate"`. The edit dialog rendered those tokens
// verbatim in a free-text box (QA 2026-09-18, F-55). These are the
// human-facing labels, and the option lists a Select offers for each key.

const ENUM_LABELS: Record<string, string> = {
  high_value_item: "High-value item",
  bank_account: "Bank account",
  credit_card: "Credit card",
  digital_asset: "Digital asset",
  loan_receivable: "Loan receivable",
  estimate: "Estimated by Portol",
  user: "Entered by you",
  manual: "Off — you set the value yourself",
  auto: "On — Portol tracks the value",
};

/** Keys whose derived name reads wrong — "Valuation Mode" says nothing. */
const FIELD_LABEL_OVERRIDES: Record<string, string> = {
  valuationMode: "Automatic value tracking",
  valuation_mode: "Automatic value tracking",
};

/** The human label for a stored profile field key. */
export function fieldKeyLabel(key: string): string {
  return FIELD_LABEL_OVERRIDES[key] ?? humanizeFieldName(key);
}

/** "high_value_item" → "High-value item"; "estimate" → "Estimated by Portol". */
export function humanizeEnumValue(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const known = ENUM_LABELS[raw.toLowerCase()];
  if (known) return known;
  const words = raw.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface EnumOption { value: string; label: string }

/** Keys whose value is one of a fixed set — rendered as a Select, never typed. */
export const FIELD_ENUM_OPTIONS: Record<string, EnumOption[]> = {
  assetSubtype: ["high_value_item", "bank_account", "credit_card", "digital_asset", "business", "collectible", "loan_receivable"]
    .map((v) => ({ value: v, label: humanizeEnumValue(v) })),
  currentValueSource: [
    { value: "user", label: humanizeEnumValue("user") },
    { value: "estimate", label: humanizeEnumValue("estimate") },
  ],
  valuationConfidence: ["high", "medium", "low", "none"].map((v) => ({ value: v, label: humanizeEnumValue(v) })),
  // The per-asset switch: absent means "auto", so "auto" is only ever written
  // by someone turning tracking back on.
  valuationMode: [
    { value: "auto", label: humanizeEnumValue("auto") },
    { value: "manual", label: humanizeEnumValue("manual") },
  ],
};

/**
 * The Select options for a field key, or null for free text. A stored value
 * outside the known set (a legacy token) is appended so the current value is
 * never silently dropped from the control.
 */
export function enumOptionsForField(key: string, current?: unknown): EnumOption[] | null {
  const base = FIELD_ENUM_OPTIONS[key] ?? FIELD_ENUM_OPTIONS[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  if (!base) return null;
  const cur = String(current ?? "").trim();
  if (cur && !base.some((o) => o.value === cur)) return [...base, { value: cur, label: humanizeEnumValue(cur) }];
  return base;
}

/** Field keys that hold a calendar date or an as-of instant. */
export function isDateFieldKey(key: string): boolean {
  return /(date|asof|as_of)$/i.test(key) || /^(dob|birthday|birthdate)$/i.test(key);
}

/**
 * The `YYYY-MM-DD` a `<input type="date">` needs, from anything the field
 * might hold: a bare day, or the full ISO instant the valuation engine writes
 * ("2026-09-16T14:55:48.412Z"). Anything else comes back unchanged.
 */
export function toDateInputValue(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s;
}

// ── Counting a field ────────────────────────────────────────────────────────
// A tracker entry's activity line was `${value} ${key}` — "1 completions",
// "1 steps". The key is the plural noun the field was named with; one of a
// thing gets the singular.
const IRREGULAR_SINGULAR: Record<string, string> = {
  calories: "calorie", entries: "entry", series: "series", species: "species", news: "news",
  oz: "oz", lbs: "lb", mins: "min", hrs: "hr", reps: "rep", sets: "set",
};

/** "completions" → "completion"; "glasses" → "glass"; "oz" → "oz". */
export function singularNoun(noun: string): string {
  const n = noun.trim();
  const lower = n.toLowerCase();
  if (IRREGULAR_SINGULAR[lower]) return IRREGULAR_SINGULAR[lower];
  if (/ies$/.test(lower)) return n.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(lower)) return n;
  if (/(ss|sh|ch|x|z)es$/.test(lower)) return n.slice(0, -2);
  if (/s$/.test(lower) && lower.length > 2) return n.slice(0, -1);
  return n;
}

/** "1 completion", "2 completions", "64 oz" — the noun agrees with the count. */
export function describeCount(count: number, noun: string): string {
  const label = humanizeFieldName(noun).toLowerCase();
  return `${count} ${count === 1 ? singularNoun(label) : label}`;
}

// ── Document field keys ─────────────────────────────────────────────────────
// Extraction writes keys like "LAST4", "dob", "ssn" that title-casing alone
// leaves cryptic ("Last4"). These spell out what a person would call them;
// everything else goes through the same humaniser tracker fields use.
const DOCUMENT_KEY_LABELS: Record<string, string> = {
  last4: "Last 4 digits",
  accountnumberlast4: "Account last 4 digits",
  cardlast4: "Card last 4 digits",
  dob: "Date of birth",
  ssn: "SSN",
  ein: "EIN",
  vin: "VIN",
  exp: "Expiration date",
  expiry: "Expiration date",
  expirationdate: "Expiration date",
  issuedate: "Issue date",
  policyno: "Policy number",
  docno: "Document number",
};

/** "LAST4" → "Last 4 digits"; "policyNumber" → "Policy Number". */
export function humanizeDocumentFieldKey(key: string): string {
  const norm = key.replace(/[\s_-]+/g, "").toLowerCase();
  if (DOCUMENT_KEY_LABELS[norm]) return DOCUMENT_KEY_LABELS[norm];
  // "LAST4"-style all-caps keys read as one word; humanizeFieldName would
  // shout them back. Lower-case first so they title-case like any other key.
  const src = /^[A-Z0-9_]+$/.test(key) ? key.toLowerCase() : key;
  return humanizeFieldName(src);
}
