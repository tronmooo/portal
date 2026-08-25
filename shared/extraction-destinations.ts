// shared/extraction-destinations.ts
// =============================================================================
// WHERE does an extracted piece of data go, and WHAT number is it?
// =============================================================================
//
// Why this file exists (user report, 2026-08-25, medical report + screenshot):
//
//   A clinic report printed  Height: 5 ft 7 in (170 cm)
//   and the app created a Height tracker whose only entry read  "5 in".
//
// Two independent failures produced that:
//
//   1. NO DESTINATION MODEL. Document extraction had exactly one destination —
//      "every ticked field becomes a key on profile.fields" — plus a hard-coded
//      25-key allowlist (chat.tsx TRACKABLE_PROFILE_KEYS) that decided which of
//      them could ALSO become a tracker. Creatinine, sodium, potassium, TSH,
//      respiratory rate and SpO2 were not on that list, so a full lab panel was
//      silently flattened into loose profile strings. A penicillin allergy, an
//      appendectomy and "Lungs clear bilaterally" landed the same way.
//
//   2. FOUR COMPETING VALUE PARSERS. The review UI carried its own anchored
//      regexes that understood "5'7\"" but not "5 ft 7 in", fell through to a
//      bare parseFloat (→ 5), and then GUESSED the unit from the field name
//      (→ "in"). Meanwhile shared/estimation-engine.ts already had a correct
//      ft/in/cm parser, and server/tracker-normalize.ts had a third one with no
//      inch unit at all.
//
// This module is the single answer to both. It is PURE (no I/O, no clock) so the
// server proposal, the review UI, and the confirm route all reach the same
// verdict, and so the behaviour is locked by tests/extraction-destinations.test.ts.
//
// It does NOT decide anything on its own authority: `suggestDestination` is a
// RECOMMENDATION. Every item carries `destinationOptions`, the user re-routes
// whatever they like in the review step, and the confirm route obeys the user.
// =============================================================================

import { parseHeightToCm, parseWeightToKg } from "./estimation-engine";

// ─── Destinations ────────────────────────────────────────────────────────────

/**
 * Every place a piece of extracted data can land. These are the choices the
 * review UI offers, in the order it offers them.
 *
 * `profile_tracker` is not a hedge — it is one fact with two jobs. A height or a
 * weight is BOTH a current characteristic of the person (used by
 * shared/estimation-engine to size that person's calorie estimates) AND a point
 * in a time series. Splitting it into two rows would make the user tick the same
 * fact twice.
 */
export type ExtractionDestination =
  | "profile"          // structured profile field (DOB, gender, blood type)
  | "profile_tracker"  // profile field AND a time-series tracker (height, weight, BMI)
  | "tracker"          // tracker entry only (vitals, labs)
  | "allergy"          // profile.fields.allergies[]
  | "medication"       // medication/supplement tracker + profile.fields.medications[]
  | "medical_history"  // profile.fields.conditions[] / surgicalHistory[]
  | "note"             // a note artifact linked to the profile
  | "calendar"         // a calendar event
  | "task"             // a to-do
  | "ignore";          // document metadata / junk — written nowhere

export const ALL_DESTINATIONS: readonly ExtractionDestination[] = [
  "profile", "profile_tracker", "tracker", "allergy", "medication",
  "medical_history", "note", "calendar", "task", "ignore",
] as const;

/** Human labels for the review UI's group headers and dropdown. */
export const DESTINATION_LABEL: Record<ExtractionDestination, string> = {
  profile: "Profile data",
  profile_tracker: "Profile + tracker",
  tracker: "Tracker",
  allergy: "Allergies",
  medication: "Medications",
  medical_history: "Medical history",
  note: "Notes",
  calendar: "Calendar",
  task: "Task",
  ignore: "Ignore",
};

/** Display order for the grouped review pane. */
export const DESTINATION_ORDER: readonly ExtractionDestination[] = [
  "profile", "profile_tracker", "tracker", "allergy", "medication",
  "medical_history", "note", "calendar", "task", "ignore",
] as const;

// ─── The unified review item ─────────────────────────────────────────────────

/**
 * One row in the review pane. The server proposes; the user disposes.
 *
 * `source` records WHERE the item came from so the confirm route can reconstruct
 * the right payload shape when the user leaves the destination alone — and so a
 * re-routed item (an allergy the user sends to Notes) is still writable.
 */
export interface ExtractionItem {
  /** Stable within one extraction; the UI keys rows on it. */
  id: string;
  /** Field key for profile writes ("dateOfBirth"), or a slug for prose items. */
  key: string;
  /** What the user reads ("Blood Pressure", "Penicillin"). */
  label: string;
  /** The value as printed, editable in the review pane. */
  value: any;
  /** Secondary line ("Rash", "10 mg — once daily as needed"). */
  detail?: string;
  destination: ExtractionDestination;
  /** Which destinations this item may be re-routed to. */
  destinationOptions: ExtractionDestination[];
  selected: boolean;
  source: "field" | "tracker" | "allergy" | "medication" | "condition" | "surgery" | "note" | "followup";
  /** Set for tracker-bound items: the canonical tracker to write to. */
  trackerName?: string;
  unit?: string;
  category?: string;
  /** Parsed numeric values, when the item is a measurement. */
  values?: Record<string, number>;
  /** Normalized YYYY-MM-DD, when the item is a date. */
  date?: string;
  /** Structured payload for allergy/medication/condition/surgery/note items. */
  payload?: Record<string, any>;
}

// ─── Health metric registry ──────────────────────────────────────────────────

export interface HealthMetric {
  id: string;
  /** Matched against the NORMALIZED key/label (lowercase, alphanumerics only). */
  match: RegExp;
  /** Canonical tracker name — "Hemoglobin A1C" and "A1C" resolve to one tracker. */
  trackerName: string;
  /** Canonical unit. Declared explicitly so shared/tracker-units.ts precedence #1
   *  (the field's own unit) wins — its FIELD_UNIT table would otherwise map
   *  sodium and cholesterol to grams. */
  unit: string;
  category: string;
  /** True when the value is ALSO a current characteristic of the person. */
  profileField?: string;
  /** Multi-component measurements (blood pressure) name their value keys. */
  components?: string[];
}

/**
 * ORDER MATTERS — specific before generic. "Total Cholesterol" must be tested
 * before "cholesterol", and "hemoglobinA1c" before any "hemoglobin".
 */
export const HEALTH_METRICS: readonly HealthMetric[] = [
  // Body characteristics — profile AND tracker.
  { id: "height", match: /^(height|heightinches|heightcm)$/, trackerName: "Height", unit: "in", category: "health", profileField: "height" },
  { id: "weight", match: /^(weight|bodyweight|weightlbs|weightkg)$/, trackerName: "Weight", unit: "lbs", category: "health", profileField: "weight" },
  { id: "bmi", match: /^(bmi|bodymassindex)$/, trackerName: "BMI", unit: "kg/m²", category: "health", profileField: "bmi" },

  // Vitals.
  { id: "bloodPressure", match: /(bloodpressure|^bp$|systolic|diastolic)/, trackerName: "Blood Pressure", unit: "mmHg", category: "health", components: ["systolic", "diastolic"] },
  { id: "heartRate", match: /(heartrate|^hr$|pulse|restingheartrate)/, trackerName: "Heart Rate", unit: "bpm", category: "health" },
  { id: "respiratoryRate", match: /(respiratoryrate|respirationrate|resprate|breathingrate|breathsperminute)/, trackerName: "Respiratory Rate", unit: "breaths/min", category: "health" },
  { id: "temperature", match: /(bodytemperature|^temperature$|^temp$)/, trackerName: "Temperature", unit: "°F", category: "health" },
  { id: "oxygenSaturation", match: /(oxygensaturation|^spo2$|o2saturation|o2sat|pulseox)/, trackerName: "Oxygen Saturation", unit: "%", category: "health" },

  // Labs — specific first.
  { id: "a1c", match: /(hemoglobina1c|glycatedhemoglobin|hba1c|^a1c$)/, trackerName: "Hemoglobin A1C", unit: "%", category: "health" },
  { id: "totalCholesterol", match: /(totalcholesterol|cholesteroltotal)/, trackerName: "Total Cholesterol", unit: "mg/dL", category: "health" },
  { id: "ldl", match: /(ldlcholesterol|^ldl$)/, trackerName: "LDL Cholesterol", unit: "mg/dL", category: "health" },
  { id: "hdl", match: /(hdlcholesterol|^hdl$)/, trackerName: "HDL Cholesterol", unit: "mg/dL", category: "health" },
  { id: "triglycerides", match: /(triglycerides?)/, trackerName: "Triglycerides", unit: "mg/dL", category: "health" },
  { id: "glucose", match: /(fastingglucose|bloodglucose|bloodsugar|^glucose$|glucosefasting)/, trackerName: "Blood Glucose", unit: "mg/dL", category: "health" },
  { id: "creatinine", match: /(creatinine)/, trackerName: "Creatinine", unit: "mg/dL", category: "health" },
  { id: "sodium", match: /(^sodium$|serumsodium)/, trackerName: "Sodium", unit: "mmol/L", category: "health" },
  { id: "potassium", match: /(^potassium$|serumpotassium)/, trackerName: "Potassium", unit: "mmol/L", category: "health" },
  { id: "tsh", match: /(^tsh$|thyroidstimulatinghormone)/, trackerName: "TSH", unit: "mIU/L", category: "health" },
  { id: "vitaminD", match: /(vitamind\b|vitamind25|hydroxyvitamind|^vitd$)/, trackerName: "Vitamin D", unit: "ng/mL", category: "health" },
  // Generic cholesterol LAST so it never steals LDL/HDL/Total.
  { id: "cholesterol", match: /(cholesterol)/, trackerName: "Total Cholesterol", unit: "mg/dL", category: "health" },
] as const;

const normKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which health metric (if any) does this field key/label name? */
export function matchHealthMetric(keyOrLabel: string | null | undefined): HealthMetric | null {
  const n = normKey(keyOrLabel);
  if (!n) return null;
  for (const m of HEALTH_METRICS) if (m.match.test(n)) return m;
  return null;
}

// ─── Measurement parsing ─────────────────────────────────────────────────────

export interface ParsedMeasurement {
  /** Field name → number, ready for a tracker entry. */
  values: Record<string, number>;
  /** The unit the numbers are in. */
  unit: string;
}

/**
 * A document that prints two forms of the same measurement prints the PRIMARY
 * one first and the conversion in parentheses: "5 ft 7 in (170 cm)",
 * "300 lb (136.1 kg)", "98.4 °F (36.9 °C)". Keep the primary; the parenthetical
 * is the same fact in another unit and re-parsing it only invites picking the
 * wrong one.
 */
function primaryForm(raw: string): string {
  const cut = raw.indexOf("(");
  return (cut > 0 ? raw.slice(0, cut) : raw).trim();
}

// Longest-first, and the tail is a NOT-A-LETTER lookahead rather than \b: a
// word boundary sits between the "kg" and the "/" of "kg/m²", so a trailing \b
// let the shorter alternative win and a BMI of 47.0 kg/m² came back as 47 kg.
const UNIT_TOKEN = /(kg\/m²|kg\/m2|mg\/dl|mmol\/l|miu\/l|mcg\/dl|ng\/ml|g\/dl|mmhg|breaths?\/min|bpm|lbs?|pounds?|kilograms?|kgs?|inches|inch|in|cm|feet|ft|°?f|°?c|%|iu|mg|mcg|ml)(?![a-z])/i;

/** Canonical spelling for a unit token as printed on a document. */
function canonMeasurementUnit(u: string | null | undefined): string {
  const t = String(u ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return "";
  if (t === "mg/dl") return "mg/dL";
  if (t === "mmol/l") return "mmol/L";
  if (t === "miu/l") return "mIU/L";
  if (t === "ng/ml") return "ng/mL";
  if (t === "g/dl") return "g/dL";
  if (t === "mcg/dl") return "mcg/dL";
  if (t === "mmhg") return "mmHg";
  if (t === "kg/m2" || t === "kg/m²") return "kg/m²";
  if (/^breaths?\/min$/.test(t)) return "breaths/min";
  if (t === "bpm") return "bpm";
  if (t === "lb" || t === "lbs" || t === "pound" || t === "pounds") return "lbs";
  if (t === "kg" || t === "kgs" || t === "kilogram" || t === "kilograms") return "kg";
  if (t === "in" || t === "inch" || t === "inches" || t === '"') return "in";
  if (t === "cm") return "cm";
  if (t === "ft" || t === "feet" || t === "'") return "ft";
  if (t === "f" || t === "°f") return "°F";
  if (t === "c" || t === "°c") return "°C";
  if (t === "%") return "%";
  return u ? String(u).trim() : "";
}

const CM_PER_IN = 2.54;

/**
 * Parse a printed measurement into numbers plus a unit, or null when there is no
 * number to be had.
 *
 * THE RULE THAT MATTERS: this function never invents a unit. If it cannot read a
 * unit off the value and the metric does not declare one, it returns the number
 * with an empty unit. The old code's "no unit? guess one from the field name"
 * step is exactly how 5 (from "5 ft 7 in") became "5 in".
 *
 *   "5 ft 7 in (170 cm)"  → { values: { value: 67 },                     unit: "in"   }
 *   "300 lb (136.1 kg)"   → { values: { value: 300 },                    unit: "lbs"  }
 *   "138/86 mmHg"         → { values: { systolic: 138, diastolic: 86 },  unit: "mmHg" }
 *   "98.4 °F (36.9 °C)"   → { values: { value: 98.4 },                   unit: "°F"   }
 *   "5.8%"                → { values: { value: 5.8 },                    unit: "%"    }
 */
export function parseMeasurement(raw: unknown, metric?: HealthMetric | null): ParsedMeasurement | null {
  if (raw === null || raw === undefined) return null;

  // Already-structured values (the model can emit {systolic, diastolic}).
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(v);
      if (isFinite(n)) values[k] = n;
    }
    return Object.keys(values).length ? { values, unit: metric?.unit ?? "" } : null;
  }

  if (typeof raw === "number") {
    return isFinite(raw) ? { values: { value: raw }, unit: metric?.unit ?? "" } : null;
  }

  const s = primaryForm(String(raw).trim());
  if (!s) return null;

  // ── Blood pressure: "138/86", "138 / 86 mmHg" ──
  const bp = s.match(/^(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bp && (!metric || metric.id === "bloodPressure")) {
    return { values: { systolic: Number(bp[1]), diastolic: Number(bp[2]) }, unit: "mmHg" };
  }

  // ── Height: delegate to the ONE correct ft/in/cm parser and report inches ──
  // parseHeightToCm understands 5'7", 5 ft 7, 5 feet 7 in, 67 in and 170 cm.
  if (metric?.id === "height" || /\d\s*(?:'|ft|feet|foot)/i.test(s)) {
    const cm = parseHeightToCm(s);
    if (cm != null && isFinite(cm)) {
      return { values: { value: Math.round((cm / CM_PER_IN) * 10) / 10 }, unit: "in" };
    }
  }

  // ── Weight: keep the printed unit, but let the shared parser read the number ──
  if (metric?.id === "weight") {
    const um = s.match(UNIT_TOKEN);
    const printed = canonMeasurementUnit(um?.[1]);
    if (printed === "kg") {
      const kg = parseWeightToKg(s);
      if (kg != null && isFinite(kg)) return { values: { value: Math.round(kg * 10) / 10 }, unit: "kg" };
    }
    const num = s.match(/-?\d+(?:\.\d+)?/);
    if (num) return { values: { value: Number(num[0]) }, unit: printed || metric.unit };
    return null;
  }

  // ── Everything else: leading number + optional printed unit ──
  const num = s.match(/-?\d+(?:\.\d+)?/);
  if (!num) return null;
  const value = Number(num[0]);
  if (!isFinite(value)) return null;

  // Look for a unit AFTER the number only — "Vitamin D 27 ng/mL" must not read
  // the "D" as a unit, and a leading "$" is not a measurement anyway.
  const after = s.slice((num.index ?? 0) + num[0].length);
  const um = after.match(UNIT_TOKEN);
  const unit = canonMeasurementUnit(um?.[1]) || metric?.unit || "";

  return { values: { value }, unit };
}

// ─── Destination suggestion ──────────────────────────────────────────────────

/**
 * Pure document metadata. These describe the FILE, not the person, and were
 * already excluded from profile writes by a duplicate list in
 * server/routes.ts and server/ai-engine.ts — this is now the one copy.
 */
export const DOC_METADATA_KEYS: ReadonlySet<string> = new Set([
  "filename", "barcode", "signaturetype", "documenttitle", "reporttitle",
  "signedby", "electronicsignature", "electronicallysignedby", "facilityaddress",
  "organizationname", "npi", "npinumber", "providerphone", "clinicphone",
]);

/** Keys that name a person's stable characteristics — profile, never a tracker. */
const PROFILE_KEYS =
  /^(name|fullname|firstname|middlename|lastname|patientname|dateofbirth|dob|birthday|age|sex|gender|bloodtype|bloodgroup|email|phone|phonenumber|address|streetaddress|addressline1|addressline2|city|state|zip|zipcode|postalcode|country|relationship|emergencycontact|maritalstatus|occupation|nationality|ethnicity|preferredlanguage|insuranceprovider|memberid|policynumber)$/;

/** Keys whose value is a follow-up commitment rather than a fact about today. */
const FOLLOWUP_KEYS = /(followup|nextvisit|nextappointment|returnvisit|repeatlabs|recheck|nextduedate)/;

/** Keys that name narrative clinical prose. */
const NARRATIVE_KEYS =
  /(physicalexam|examsummary|examination|assessment|impression|plan|recommendation|clinicalnote|findings|observations|interpretation|conclusion|comments|summary|history|chiefcomplaint|reviewofsystems)/;

const DATE_KEYS = /(date|expir|renew|due|valid|issued|birth|appoint|scheduled)/;

export interface SuggestInput {
  key: string;
  label?: string;
  value?: unknown;
  /** True when the value already parsed as a real calendar date. */
  isDate?: boolean;
}

/**
 * The RECOMMENDED destination for an extracted field. Deterministic, and
 * deliberately conservative: anything it cannot place confidently goes to
 * `profile`, which is where every field went before this module existed.
 */
export function suggestDestination(input: SuggestInput): ExtractionDestination {
  const key = normKey(input.key);
  const label = normKey(input.label ?? input.key);

  if (!key) return "ignore";
  if (DOC_METADATA_KEYS.has(key) || DOC_METADATA_KEYS.has(label)) return "ignore";

  // A person's own attributes beat every heuristic below: "bloodType: O+" is
  // profile data even though "blood" also appears in Blood Pressure.
  if (PROFILE_KEYS.test(key) || PROFILE_KEYS.test(label)) return "profile";

  const metric = matchHealthMetric(key) ?? matchHealthMetric(label);
  if (metric && parseMeasurement(input.value, metric)) {
    return metric.profileField ? "profile_tracker" : "tracker";
  }

  if (FOLLOWUP_KEYS.test(key) || FOLLOWUP_KEYS.test(label)) return "task";
  if (input.isDate || DATE_KEYS.test(key)) return "calendar";
  if (NARRATIVE_KEYS.test(key) || NARRATIVE_KEYS.test(label)) return "note";

  // Long prose is a note, not a profile field. A whole paragraph stored as
  // `fields.abdomen` is unreadable everywhere the profile is rendered.
  if (isProseValue(input.value)) return "note";

  return "profile";
}

/** True when a value reads as a sentence rather than a datum. */
export function isProseValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length < 60) return false;
  return /\s/.test(s) && s.split(/\s+/).length >= 10;
}

/**
 * Which destinations may this item be re-routed to? Every item can always go to
 * a Note or be Ignored — those are the universal escape hatches. Measurements
 * additionally offer the tracker destinations, and structured medical items
 * offer their own homes.
 */
export function destinationOptionsFor(suggested: ExtractionDestination, hasMeasurement: boolean, hasDate: boolean): ExtractionDestination[] {
  const opts = new Set<ExtractionDestination>([suggested, "profile", "note", "ignore"]);
  if (hasMeasurement) { opts.add("tracker"); opts.add("profile_tracker"); }
  if (hasDate) { opts.add("calendar"); opts.add("task"); }
  opts.add("allergy");
  opts.add("medication");
  opts.add("medical_history");
  return ALL_DESTINATIONS.filter((d) => opts.has(d));
}

// ─── Structured profile arrays ───────────────────────────────────────────────
//
// `profile.fields` is a JSONB blob, so these shapes are a convention rather than
// a table. They are declared here (not in schema.ts) because this module is what
// writes and dedupes them, and because every reader must agree on the key used
// for deduplication — a re-uploaded report must add nothing.

export interface ProfileAllergy {
  substance: string;
  reaction?: string;
  /** "medication" | "environmental" | "food" | "other" */
  type?: string;
  source?: string;
}

export interface ProfileMedication {
  name: string;
  dose?: string;
  frequency?: string;
  /** "as needed" prescriptions are NOT a daily schedule. */
  asNeeded?: boolean;
  /** "medication" | "supplement" */
  kind?: string;
  trackerId?: string;
  source?: string;
}

export interface ProfileCondition {
  name: string;
  /** "active" | "history" | "resolved" */
  status?: string;
  source?: string;
}

export interface ProfileSurgery {
  procedure: string;
  year?: number;
  source?: string;
}

const dedupeKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function allergyKey(a: Partial<ProfileAllergy>): string { return dedupeKey(a.substance); }
export function medicationKey(m: Partial<ProfileMedication>): string { return dedupeKey(m.name); }
export function conditionKey(c: Partial<ProfileCondition>): string { return dedupeKey(c.name); }
export function surgeryKey(s: Partial<ProfileSurgery>): string {
  return `${dedupeKey(s.procedure)}|${s.year ?? ""}`;
}

/**
 * Merge structured records into an existing profile array, idempotently.
 *
 * Back-compat: `profile.fields.allergies` and `.medications` were free-text
 * STRINGS before this change (rendered by profile-detail's Emergency group). A
 * string is converted to a one-element record on the first structured write so
 * nothing the user typed is lost.
 *
 * Existing records win on conflict — a value the user edited is never clobbered
 * by a re-upload — but blank slots on an existing record are filled in.
 */
export function mergeStructuredRecords<T extends Record<string, any>>(
  existing: unknown,
  incoming: T[],
  keyOf: (x: Partial<T>) => string,
  fromLegacyString: (s: string) => T,
): T[] {
  const out: T[] = [];
  const index = new Map<string, number>();

  const push = (rec: T) => {
    const k = keyOf(rec);
    if (!k) return;
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push(rec);
      return;
    }
    // Fill blanks on the record already there; never overwrite a real value.
    const prior = out[at];
    for (const [field, v] of Object.entries(rec)) {
      if (v === null || v === undefined || v === "") continue;
      const cur = (prior as any)[field];
      if (cur === null || cur === undefined || cur === "") (prior as any)[field] = v;
    }
  };

  if (Array.isArray(existing)) {
    for (const rec of existing) if (rec && typeof rec === "object") push(rec as T);
  } else if (typeof existing === "string" && existing.trim()) {
    // Legacy free text: "Penicillin, Pollen, Dust" → three records.
    for (const part of existing.split(/[,;]/)) {
      const t = part.trim();
      if (t) push(fromLegacyString(t));
    }
  }

  for (const rec of incoming) push(rec);
  return out;
}

// ─── Building the review list ────────────────────────────────────────────────

export interface RawExtractedField {
  key: string;
  label: string;
  value: any;
  selected?: boolean;
  isDate?: boolean;
  category?: string;
  suggestedEvent?: string;
}

export interface RawTrackerEntry {
  trackerName?: string;
  values?: Record<string, any>;
  unit?: string;
  category?: string;
}

export interface BuildItemsInput {
  extractedFields: RawExtractedField[];
  trackerEntries?: RawTrackerEntry[];
  allergies?: any[];
  medications?: any[];
  conditions?: any[];
  surgicalHistory?: any[];
  clinicalNotes?: any[];
  followUps?: any[];
  /** "<documentType> <label>" — context for date classification. */
  docContext?: string;
  /** Normalizer for printed dates. Injected so this module stays dependency-light. */
  normalizeDate?: (v: unknown) => string | null;
}

const slug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Turn everything the extractor produced into ONE ordered list of review items,
 * each with a proposed destination.
 *
 * The old payload had three parallel shapes the UI rendered in three different
 * places (`extractedFields` in a table, `trackerEntries` in a checkbox list,
 * `pendingFinancial` in a third panel), which is why there was nowhere to put a
 * destination: a row's destination was implied by WHICH LIST it was in. One list
 * plus an explicit destination is what makes re-routing possible at all.
 *
 * `extractedFields` and `trackerEntries` are still returned unchanged on the
 * payload alongside this, so older chat messages keep rendering.
 */
export function buildExtractionItems(input: BuildItemsInput): ExtractionItem[] {
  const items: ExtractionItem[] = [];
  const seenTracker = new Set<string>();
  const usedIds = new Set<string>();

  const takeId = (base: string) => {
    let id = base || "item";
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  // 1. Every extracted field.
  for (const f of input.extractedFields || []) {
    const metric = matchHealthMetric(f.key) ?? matchHealthMetric(f.label);
    const measurement = metric ? parseMeasurement(f.value, metric) : null;
    const destination = suggestDestination({ key: f.key, label: f.label, value: f.value, isDate: f.isDate });
    const date = f.isDate && input.normalizeDate ? input.normalizeDate(f.value) : null;

    const item: ExtractionItem = {
      id: takeId(`field-${slug(f.key)}`),
      key: f.key,
      label: f.label,
      value: f.value,
      destination,
      destinationOptions: destinationOptionsFor(destination, !!measurement, !!date),
      // A field the router sends to the bin is not ticked by default. Everything
      // else keeps the extractor's own selected flag.
      selected: destination === "ignore" ? false : (f.selected ?? true),
      source: "field",
    };
    if (measurement && metric) {
      item.trackerName = metric.trackerName;
      item.unit = measurement.unit || metric.unit;
      item.category = metric.category;
      item.values = measurement.values;
      seenTracker.add(trackerDedupeKey(metric.trackerName));
    }
    if (date) item.date = date;
    items.push(item);
  }

  // 2. Tracker entries the model proposed that no field already covers. A lab
  //    panel usually arrives BOTH ways; two rows for one measurement would mean
  //    two entries on the same tracker for the same reading.
  for (const t of input.trackerEntries || []) {
    const name = String(t.trackerName || "").trim();
    if (!name) continue;
    const metric = matchHealthMetric(name);
    const canonical = metric?.trackerName || humanizeTrackerName(name);
    if (seenTracker.has(trackerDedupeKey(canonical))) continue;
    seenTracker.add(trackerDedupeKey(canonical));

    const parsed = parseMeasurement(t.values, metric) ?? parseMeasurement((t.values || {}).value, metric);
    if (!parsed) continue;
    const unit = canonMeasurementUnit(t.unit) || parsed.unit || metric?.unit || "";
    items.push({
      id: takeId(`tracker-${slug(canonical)}`),
      key: slug(canonical),
      label: canonical,
      value: formatMeasurement(parsed.values, unit),
      destination: metric?.profileField ? "profile_tracker" : "tracker",
      destinationOptions: destinationOptionsFor("tracker", true, false),
      selected: true,
      source: "tracker",
      trackerName: canonical,
      unit,
      category: t.category || metric?.category || "health",
      values: parsed.values,
    });
  }

  // 3. Structured medical sections.
  for (const a of input.allergies || []) {
    const substance = String(a?.substance ?? a?.name ?? "").trim();
    if (!substance) continue;
    const reaction = String(a?.reaction ?? "").trim();
    items.push({
      id: takeId(`allergy-${slug(substance)}`),
      key: `allergy.${slug(substance)}`,
      label: substance,
      value: substance,
      detail: reaction || undefined,
      destination: "allergy",
      destinationOptions: destinationOptionsFor("allergy", false, false),
      selected: true,
      source: "allergy",
      payload: { substance, reaction: reaction || undefined, type: a?.type ? String(a.type) : undefined },
    });
  }

  for (const m of input.medications || []) {
    const name = String(m?.name ?? "").trim();
    if (!name) continue;
    const dose = String(m?.dose ?? m?.dosage ?? "").trim();
    const frequency = String(m?.frequency ?? "").trim();
    const asNeeded = m?.asNeeded === true || /as needed|\bprn\b/i.test(frequency);
    const detail = [dose, frequency].filter(Boolean).join(" — ") || undefined;
    items.push({
      id: takeId(`medication-${slug(name)}`),
      key: `medication.${slug(name)}`,
      label: name,
      value: name,
      detail,
      destination: "medication",
      destinationOptions: destinationOptionsFor("medication", false, false),
      selected: true,
      source: "medication",
      trackerName: name,
      category: "medication",
      payload: {
        name,
        dose: dose || undefined,
        frequency: frequency || undefined,
        asNeeded,
        kind: m?.kind ? String(m.kind) : undefined,
      },
    });
  }

  for (const c of input.conditions || []) {
    const name = String(c?.name ?? c?.condition ?? "").trim();
    if (!name) continue;
    const status = String(c?.status ?? "").trim();
    items.push({
      id: takeId(`condition-${slug(name)}`),
      key: `condition.${slug(name)}`,
      label: name,
      value: name,
      detail: status || undefined,
      destination: "medical_history",
      destinationOptions: destinationOptionsFor("medical_history", false, false),
      selected: true,
      source: "condition",
      payload: { name, status: status || undefined },
    });
  }

  for (const s of input.surgicalHistory || []) {
    const procedure = String(s?.procedure ?? s?.name ?? "").trim();
    if (!procedure) continue;
    const year = Number(s?.year);
    items.push({
      id: takeId(`surgery-${slug(procedure)}`),
      key: `surgery.${slug(procedure)}`,
      label: procedure,
      value: procedure,
      detail: isFinite(year) && year > 0 ? String(year) : undefined,
      destination: "medical_history",
      destinationOptions: destinationOptionsFor("medical_history", false, false),
      selected: true,
      source: "surgery",
      payload: { procedure, year: isFinite(year) && year > 0 ? year : undefined },
    });
  }

  for (const n of input.clinicalNotes || []) {
    const body = String(n?.body ?? n?.content ?? "").trim();
    if (!body) continue;
    const title = String(n?.title ?? "").trim() || "Clinical note";
    items.push({
      id: takeId(`note-${slug(title)}`),
      key: `note.${slug(title)}`,
      label: title,
      value: body,
      destination: "note",
      destinationOptions: destinationOptionsFor("note", false, false),
      selected: true,
      source: "note",
      payload: { title, body },
    });
  }

  for (const f of input.followUps || []) {
    const label = String(f?.label ?? f?.title ?? "").trim();
    if (!label) continue;
    const date = input.normalizeDate ? input.normalizeDate(f?.date) : (f?.date ? String(f.date) : null);
    if (!date) continue;
    const kind = String(f?.kind ?? "").toLowerCase();
    const destination: ExtractionDestination = kind === "appointment" ? "calendar" : "task";
    items.push({
      id: takeId(`followup-${slug(label)}`),
      key: `followup.${slug(label)}`,
      label,
      value: date,
      date,
      destination,
      destinationOptions: destinationOptionsFor(destination, false, true),
      selected: true,
      source: "followup",
      payload: { title: label, date },
    });
  }

  return items;
}

/** "blood_pressure" → "Blood Pressure". */
export function humanizeTrackerName(name: string): string {
  return String(name || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Loose key for "is this the same tracker?" within one extraction. */
function trackerDedupeKey(name: string): string {
  return normKey(name);
}

/** "138/86 mmHg", "67 in" — what the review row shows for a parsed measurement. */
export function formatMeasurement(values: Record<string, number>, unit?: string): string {
  const keys = Object.keys(values || {});
  if (keys.length === 0) return "";
  const u = unit ? ` ${unit}` : "";
  if ("systolic" in values && "diastolic" in values) {
    return `${values.systolic}/${values.diastolic}${u}`;
  }
  if (keys.length === 1) return `${values[keys[0]]}${u}`;
  return keys.map((k) => `${k} ${values[k]}`).join(", ") + u;
}
