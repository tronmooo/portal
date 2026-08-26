// shared/tracker-units.ts
// =============================================================================
// THE single source of truth for "what unit does this tracker/field display in?"
// =============================================================================
//
// WHY THIS FILE EXISTS
// Units used to be guessed independently in ≥5 places — inferUnit + UNIT_BY_FIELD
// (client trackers page), guessUnit (tracker-presentation), a DIFFERENT guessUnit
// (ai-engine), an inline `f.type === "duration" ? "min"` (profile detail), etc.
// Each used slightly different rules ("lb" vs "lbs", "cal" vs "kcal", water→oz in
// one and nothing in another), so the SAME tracker could show one unit in the
// history tab, another on its card, and another on the dashboard. That is the
// root cause of "the unit isn't the same every time" — not any single tracker.
//
// THE RULE
// Every view — history, tracker card, chart, overview, dashboard, profile
// detail, AI-generated chart — MUST get its unit from resolveTrackerUnit() and
// from NOWHERE else. There is exactly one precedence ladder and one lookup
// table. A contract test (tests/smoke/contracts/no-inline-unit-guessing.test.ts)
// fails the build if any other file reintroduces unit guessing, so units can
// never silently diverge again across views or over time.
//
// Pure + unit-tested.
// =============================================================================

export interface UnitTrackerLike {
  name?: string | null;
  category?: string | null;
  unit?: string | null;
  fields?: Array<{ name: string; type?: string; unit?: string | null; isPrimary?: boolean }>;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Supplement/medication name detector — the ONLY copy in the codebase.
const SUPPLEMENT_NAME =
  /(fishoil|omega|multivitamin|vitamin|creatine|magnesium|zinc|melatonin|probiotic|biotin|collagen|glucosamine|turmeric|ashwagandha|supplement|softgel|capsule|lozenge|gummy)/;

/**
 * Is this a medication/supplement (adherence) tracker? Adherence trackers track
 * "did I take it?", not a physical quantity, so they must NEVER carry a guessed
 * unit. This is the single definition; tracker-presentation imports it.
 */
export function isAdherenceTracker(t: UnitTrackerLike): boolean {
  const cat = norm(t.category);
  if (["medication", "prescription", "supplement"].includes(cat)) return true;
  const fns = (t.fields || []).map((f) => norm(f.name));
  const doseShaped =
    (fns.includes("dosage") || fns.includes("dose")) &&
    (fns.includes("taken") || fns.includes("adherence") || fns.includes("drug") || fns.includes("drugname"));
  if (doseShaped) return true;
  return SUPPLEMENT_NAME.test(norm(t.name));
}

// Canonical FIELD-NAME → unit. ONE table, with ONE chosen spelling per unit
// ("lbs" not "lb", "kcal" not "cal") so a field can never show two spellings in
// two views. Order matters: specific before generic.
const FIELD_UNIT: Array<[RegExp, string]> = [
  [/(systolic|diastolic|mmhg)/, "mmHg"],
  [/(heartrate|^hr$|bpm|pulse|restingheartrate)/, "bpm"],
  [/(glucose|bloodsugar|bloodglucose|a1c)/, "mg/dL"],
  [/(spo2|oxygen|saturation)/, "%"],
  [/(carb|protein|^fat$|sugar|fiber|sodium|cholesterol|caffeine)/, "g"],
  [/(calorie|kcal|^cal$|caloriesburned)/, "kcal"],
  [/(mile|distance)/, "mi"],
  [/(^km$|kilometer)/, "km"],
  [/(step)/, "steps"],
  [/(ounce|^oz$|water|hydrat|fluid)/, "oz"],
  [/(^cup$|^cups$)/, "cups"],
  [/(^ml$|millilit)/, "ml"],
  [/(weight|bodyweight|^lbs?$|^pounds?$)/, "lbs"],
  [/(^kg$|kilogram)/, "kg"],
  [/(^reps?$)/, "reps"],
  [/(^sets?$)/, "sets"],
  [/(^laps?$)/, "laps"],
  [/(pace)/, "min/mi"],
  [/(minute|duration|^mins?$|^time$)/, "min"],
  [/(hour|sleep|^hrs?$)/, "hr"],
  [/(page)/, "pages"],
  [/(percent|^pct$|bodyfat)/, "%"],
  [/(temperature|^temp$)/, "°F"],
];

function unitByFieldName(field: string): string {
  const f = norm(field);
  if (!f) return "";
  for (const [re, u] of FIELD_UNIT) if (re.test(f)) return u;
  return "";
}

// Last-resort fallback from the tracker NAME, used only when the field name is
// generic ("activity"/"value") and nothing else resolved. Health/fitness/
// lifestyle activities ONLY — strictly NO cross-domain guesses (a bare "oil"
// must never imply motor-oil quarts on a Fish Oil supplement).
const NAME_UNIT: Array<[RegExp, string]> = [
  [/(guitar|piano|instrument|meditat|yoga|mindful|gam(e|ing)?|practice|\bread\b|reading|book)/, "min"],
  [/(walk|step)/, "steps"],
  [/(hydrat|water|drink)/, "oz"],
  [/(\brun\b|running|jog|bike|biking|cycl)/, "mi"],
  [/(calorie)/, "kcal"],
  [/(sleep)/, "hr"],
  [/(bench ?press|shoulder ?press|leg ?press|chest ?press|overhead ?press|squat|deadlift|bodyweight|body weight|scale weight|^weight$)/, "lbs"],
  [/(tire ?pressure|\bpsi\b)/, "PSI"],
  [/(blood ?pressure)/, "mmHg"],
  [/(fuel|gas mileage|\bmpg\b)/, "mpg"],
  [/(charge|battery)/, "%"],
  [/(odometer|mileage)/, "mi"],
  [/(oil change|motor oil|engine oil)/, "qt"],
];

function unitByTrackerName(name: string): string {
  const n = String(name ?? "").toLowerCase();
  for (const [re, u] of NAME_UNIT) if (re.test(n)) return u;
  return "";
}

function primaryFieldName(t: UnitTrackerLike): string | null {
  const fs = t.fields || [];
  return fs.find((f) => f.isPrimary)?.name ?? fs.find((f) => f.type === "number")?.name ?? fs[0]?.name ?? null;
}

/**
 * Resolve the display unit for a tracker field. Deterministic precedence — the
 * SAME (tracker, field) always returns the SAME string, in every view:
 *
 *   1. the field's own declared unit (a stored fact — always wins)
 *   2. adherence tracker → "" (never a guessed physical unit)
 *   3. the tracker's declared unit (for its primary metric)
 *   4. canonical field-name → unit table
 *   5. tracker-name fallback (primary metric only; no cross-domain guesses)
 *   6. ""  (render the bare number rather than guess wrong)
 *
 * @param fieldName  which field's unit to resolve; omitted → the primary field.
 */
export function resolveTrackerUnit(t: UnitTrackerLike, fieldName?: string): string {
  const fields = t.fields || [];
  const primary = primaryFieldName(t);
  const targetName = fieldName ?? primary ?? "";
  const field = fields.find((f) => norm(f.name) === norm(targetName));
  const isPrimary = !targetName || !primary || norm(targetName) === norm(primary);

  // 1. Declared field unit — authoritative.
  const declared = (field?.unit ?? "").trim();
  if (declared) return declared;

  // 2. Adherence: no physical unit, ever.
  if (isAdherenceTracker(t)) return "";

  // 3. Declared tracker unit applies to the primary metric.
  const trackerUnit = String(t.unit ?? "").trim();
  if (trackerUnit && isPrimary) return trackerUnit;

  // 4. Canonical field-name → unit.
  const byField = unitByFieldName(targetName);
  if (byField) return byField;

  // 5. Primary metric: last-resort name fallback.
  if (isPrimary) {
    const byName = unitByTrackerName(t.name || "");
    if (byName) return byName;
    if (trackerUnit) return trackerUnit;
  }
  return "";
}

// ─── Dimensions: may two units describe the same metric? ─────────────────────
//
// Tracker matching has always compared NAMES. That is right as the primary
// gate — "Height" and "Weight" are different metrics however similar their
// numbers — but it is not sufficient: a value in miles must never be appended
// to a series kept in dollars just because both trackers happen to be called
// "Value". A dimension is the second gate, and only ever a VETO layered on top
// of name identity; it never matches two trackers that names kept apart.
//
// This table lives here because this is the one file allowed to know about
// units (see the contract test named at the top).

export type UnitDimension =
  | "mass" | "length" | "distance" | "temperature" | "pressure" | "rate"
  | "percent" | "money" | "volume" | "time" | "energy" | "concentration" | "count";

/** Longest-first, so "mg/dl" is read as a concentration before "mg" is read as a mass. */
const DIMENSION_TABLE: ReadonlyArray<readonly [RegExp, UnitDimension]> = [
  [/^(mg\/dl|mmol\/l|miu\/l|mcg\/dl|ng\/ml|g\/dl|meq\/l|iu\/l|mg\/l)$/, "concentration"],
  [/^(breaths?\/min|bpm|rpm|steps?\/min|\/min)$/, "rate"],
  [/^(mmhg|psi|bar|kpa)$/, "pressure"],
  [/^(kg|kgs|kilogram|kilograms|lb|lbs|pound|pounds|g|grams|oz|ounce|ounces|mg|mcg)$/, "mass"],
  [/^(cm|centimeter|centimeters|in|inch|inches|ft|feet|foot|m|meter|meters|mm)$/, "length"],
  [/^(mi|mile|miles|km|kilometer|kilometers|yd|yard|yards)$/, "distance"],
  [/^(f|c|°f|°c|fahrenheit|celsius)$/, "temperature"],
  [/^(%|percent|percentage|pct)$/, "percent"],
  [/^(\$|usd|eur|gbp|cad|aud|dollars?)$/, "money"],
  [/^(ml|l|liter|liters|fl oz|floz|gal|gallon|gallons|cup|cups|qt|quart)$/, "volume"],
  [/^(min|mins|minute|minutes|hr|hrs|hour|hours|sec|secs|second|seconds|days?)$/, "time"],
  [/^(cal|kcal|calorie|calories|kj)$/, "energy"],
  [/^(count|reps?|steps?|times?|x)$/, "count"],
];

/**
 * What KIND of quantity this unit measures, or null when the unit is absent or
 * one we have no dimension for. Never throws — an unknown unit is a reason to
 * stay permissive, not to block a legitimate append.
 */
export function unitDimension(unit: string | null | undefined): UnitDimension | null {
  const u = String(unit ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!u) return null;
  for (const [re, dim] of DIMENSION_TABLE) {
    if (re.test(u)) return dim;
  }
  return null;
}

/**
 * May a value recorded in unit `a` join a series kept in unit `b`?
 *
 * Permissive by default: when either side declares no unit, or carries one this
 * table does not know, the answer is yes — blocking an append because nobody
 * wrote down a unit would lose real data. Two KNOWN units must agree on
 * dimension: lbs ≡ kg (conversion happens at write time in
 * server/tracker-normalize), in ≢ lbs, mi ≢ $.
 */
export function unitsCompatible(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const da = unitDimension(a);
  const db = unitDimension(b);
  if (da === null || db === null) return true;
  return da === db;
}
