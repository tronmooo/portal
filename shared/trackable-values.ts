// shared/trackable-values.ts — is this number worth a chart?
// =============================================================================
//
// USER DIRECTIVE (2026-08-26):
//
//   "The middle table is the authority for what factual data is saved; the
//    Suggested Actions panel is the authority for what becomes tracked. The AI
//    determines whether a piece of extracted data is longitudinal/trackable,
//    identifies an existing compatible tracker when possible, and otherwise
//    proposes creating one. Completely dynamic — no hard-coded list of medical
//    trackers or document types."
//
// Before this module, a tracker action existed if and only if the reasoning
// model happened to write "measurement" into a fact's roles, and the only
// deterministic fallback was a 21-entry medical registry gated to people and
// pets. An odometer reading, a property valuation, a loan balance and an annual
// premium — all obviously values-over-time — had no route to a tracker at all.
//
// This module answers the question from the SHAPE of the data instead:
//
//   Does the value parse as a quantity, and is the field something that CHANGES
//   rather than something that IDENTIFIES?
//
// It names no document type and hardcodes no metric. The medical registry is
// still consulted first — when it hits, we get a canonical name and unit for
// free — but it is an optimisation, never a gate.
//
// Pure and deterministic. Pinned by tests/trackable-values.test.ts.

import {
  matchHealthMetric, parseMeasurement, humanizeTrackerName,
  DOC_METADATA_KEYS, isProseValue,
} from "./extraction-destinations";
import { trackerIdentityKey } from "./tracker-identity";
import { resolveTrackerUnit } from "./tracker-units";
import { bareDateOf } from "./date-rules";

/** Why a value earned a chart — diagnostics, and how confident we are. */
export type TrackableBasis = "health_metric" | "measured" | "money" | "numeric";

/** Why a value did NOT. Returned so a refusal can be explained, not just made. */
export type NotTrackableReason =
  | "metadata" | "date" | "identifier" | "count" | "year"
  | "text" | "prose" | "no_number";

export interface TrackableInput {
  key: string;
  label: string;
  value: unknown;
  /** Set when the row IS a date — a date is never a measurement of itself. */
  date?: string | null;
  /** Reasoner roles, when the row was read into a fact. */
  roles?: readonly string[];
  /** The unit the fact declared, when it declared one. */
  unit?: string | null;
  financialKind?: string | null;
  /** A tracker name the extractor already supplied for this row. */
  trackerName?: string | null;
}

export interface TrackableCandidate {
  /** The tracker this value belongs on ("Weight", "Odometer", "Annual Premium"). */
  name: string;
  identityKey: string;
  /** {value} for a scalar, {systolic,diastolic} for a compound reading. */
  values: Record<string, number>;
  unit: string;
  /**
   * NEVER a hidden category (shared/hidden-tracker-categories): `finance` and
   * its siblings are rejected by POST /api/trackers and filtered out of every
   * tracker list, so a money tracker filed under `finance` would be created and
   * then be invisible. Money goes to `custom` and stays visible.
   */
  category: "health" | "custom";
  basis: TrackableBasis;
  /** Set when the metric registry says this is also a profile characteristic. */
  profileField?: string;
}

// ─── The exclusions ──────────────────────────────────────────────────────────
// Two vocabularies, and the interplay between them is the whole design. IDENT
// names things that IDENTIFY; QUANTITY names things that VARY. A field matching
// both is a quantity — which is why "Account Balance" and "Group Number" land
// on opposite sides without either list naming a document type.

const IDENT =
  /(number|num\b|no\.?$|#|\bids?\b|identifier|\bcode\b|vin|serial|policy|account|routing|licen[cs]e|plate|barcode|sku|upc|isbn|npi|zip|postal|phone|fax|ssn|ein|tin|member|group|claim|case|invoice|receipt|confirmation|reference|tracking|\bpin\b|apn|parcel|cashier|register|approval|authorization|last\s?-?(4|four)|ending\s?in|card\s?ending)/i;

const QUANTITY =
  /(balance|amount|total|premium|payment|value|price|cost|\bfees?\b|rate|percent|mileage|odometer|weight|height|pressure|temperature|level|reading|score|limit|deductible|coverage|salary|income|distance|duration|capacity|volume|usage|consumption)/i;

const COUNT = /(quantity|qty|\bcount\b|number of|# of|\bunits?\b|\bitems?\b|\bpcs\b)/i;

const YEARISH = /(year|built|manufactured|model year|vintage)/i;

const DATEISH = /(date|expir|renew|issued|effective|maturity|birth|\bdue\b|deadline)/i;

/** A value that identifies rather than measures, judged on its own shape. */
function looksLikeIdentifier(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  // Letters and digits interleaved: "SPI-24-87654321", "2HKRW2H85MH512345".
  if (/[A-Za-z]/.test(s) && /\d/.test(s) && !/\s/.test(s) && s.length >= 6) return true;
  // A long unbroken run of digits with no decimal point and no unit — an id,
  // not a reading. Money and measurements are shorter or carry a separator.
  if (/^\d{7,}$/.test(s)) return true;
  // Leading zeros are never arithmetic: "00483".
  if (/^0\d+$/.test(s)) return true;
  return false;
}

/** The single reason this value must not become a tracker, or null. */
export function notTrackableReason(input: TrackableInput): NotTrackableReason | null {
  const key = String(input.key ?? "");
  const label = String(input.label ?? "");
  const both = `${key} ${label}`;
  const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  const raw = input.value === null || input.value === undefined ? "" : String(input.value).trim();
  const roles = input.roles ?? [];

  if (roles.includes("reference_only") || roles.includes("document_metadata")) return "metadata";
  if (DOC_METADATA_KEYS.has(normKey) || DOC_METADATA_KEYS.has(normLabel)) return "metadata";

  // A date describes WHEN, never HOW MUCH.
  if (input.date) return "date";
  if (roles.includes("actionable_date")) return "date";
  if (bareDateOf(raw)) return "date";
  if (DATEISH.test(both) && !QUANTITY.test(both)) return "date";

  if (COUNT.test(both)) return "count";
  if (YEARISH.test(both) && /^\d{4}$/.test(raw) && Number(raw) >= 1000 && Number(raw) <= 2999) {
    return "year";
  }
  // Identifier by NAME — unless the name also says it is a quantity.
  if (IDENT.test(both) && !QUANTITY.test(both)) return "identifier";
  // Identifier by SHAPE — regardless of what it is called.
  if (looksLikeIdentifier(raw)) return "identifier";
  if (isProseValue(input.value)) return "prose";
  // A value that carries real WORDS describes something; it does not measure
  // it. "123 Evergreen Lane, Springfield, CO 80501" begins with a number and is
  // an address. Unit words are exempt, so "5 ft 7 in (170 cm)" and "90 days"
  // survive — the test is for prose the number is embedded in.
  const words = raw.match(/[A-Za-z]{3,}/g) ?? [];
  if (words.filter((w) => !UNIT_WORDS.has(w.toLowerCase())).length >= 2) return "text";

  return null;
}

/** Words that are units, not description — exempt from the residue rule above. */
const UNIT_WORDS: ReadonlySet<string> = new Set([
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "hour", "hours", "min", "mins", "minute", "minutes", "sec", "seconds",
  "mile", "miles", "kilometer", "kilometers", "meter", "meters",
  "inch", "inches", "feet", "foot", "pound", "pounds", "kilogram", "kilograms",
  "gram", "grams", "ounce", "ounces", "liter", "liters", "gallon", "gallons",
  "percent", "degrees", "celsius", "fahrenheit", "each", "per", "and",
  "usd", "eur", "gbp", "cad", "aud", "dollars", "cents",
]);

/**
 * A canonical tracker name from a field's own label.
 *
 * Strips the unit the label often carries ("Weight [lbs]", "LDL (mg/dL)") and
 * the auto-numbering the app appends to duplicates, so the name that comes out
 * is the one `trackerIdentityKey` can match against an existing tracker.
 */
export function canonicalTrackerName(label: string, key?: string): string {
  const base = String(label || key || "").trim()
    .replace(/\s*[\[(][^\])]*[\])]\s*$/, "")   // trailing "[lbs]" / "(mg/dL)"
    .replace(/\s*\(\d+\)\s*$/, "")              // trailing "(2)"
    .replace(/[:：]\s*$/, "")
    .trim();
  return humanizeTrackerName(base || String(key || ""));
}

/**
 * The tracker this value belongs on, or null when it is not a measurement.
 *
 * Order matters: the metric registry first (a free canonical name and unit),
 * then the extractor's own tracker name, then pure shape. Every path runs the
 * value through `parseMeasurement`, which is the ONE parser in the app that
 * reads "138/86" as two components and "5 ft 7 in (170 cm)" as 67 inches — and
 * which, by its own contract, never invents a unit.
 */
export function detectTrackable(input: TrackableInput): TrackableCandidate | null {
  if (notTrackableReason(input)) return null;

  const metric = matchHealthMetric(input.key) ?? matchHealthMetric(input.label);
  // Strip grouping separators BEFORE parsing — "43,120 mi" read as 43 turned a
  // vehicle's odometer into a two-digit reading, and "$612,000" into $612.
  // Only commas BETWEEN digits go; a comma separating words is left alone so
  // the residue rule above still sees an address for what it is.
  const scalar = typeof input.value === "string"
    ? input.value.replace(/(\d),(?=\d{3}\b)/g, "$1")
    : input.value;
  const parsed = parseMeasurement(scalar, metric);
  if (!parsed || Object.keys(parsed.values).length === 0) return null;
  if (!Object.values(parsed.values).every((n) => typeof n === "number" && isFinite(n))) return null;

  const name = metric?.trackerName
    ?? (input.trackerName ? humanizeTrackerName(input.trackerName) : canonicalTrackerName(input.label, input.key));
  if (!name) return null;

  const roles = input.roles ?? [];
  const isMoney = roles.includes("financial")
    || (input.financialKind ? input.financialKind !== "rate" : false)
    || /^[$€£]/.test(String(input.value ?? "").trim());

  // Unit precedence: what the fact declared, what the value printed, what the
  // registry says, and only then the shared resolver's name-based fallback.
  const unit = String(input.unit || "").trim()
    || parsed.unit
    || metric?.unit
    || (isMoney ? "$" : "")
    || resolveTrackerUnit({
      name,
      unit: "",
      fields: [{ name: Object.keys(parsed.values)[0], type: "number", isPrimary: true }],
    });

  const basis: TrackableBasis = metric
    ? "health_metric"
    : roles.includes("measurement")
      ? "measured"
      : isMoney
        ? "money"
        : "numeric";

  return {
    name,
    identityKey: trackerIdentityKey(name),
    values: parsed.values,
    unit,
    category: metric ? "health" : "custom",
    basis,
    profileField: metric?.profileField,
  };
}

/**
 * Did the AI actually judge this longitudinal, or did we infer it from shape?
 *
 * Drives whether a "start tracking this" proposal arrives ticked: a metric the
 * registry knows, or one the reasoner explicitly called a measurement, is worth
 * pre-selecting. A number that merely looks trackable is proposed and left for
 * the user to opt into — otherwise one receipt mints five charts.
 */
export function isConfidentlyTrackable(candidate: TrackableCandidate): boolean {
  return candidate.basis === "health_metric" || candidate.basis === "measured";
}
