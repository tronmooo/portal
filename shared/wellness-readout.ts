// ── Wellness readout ─────────────────────────────────────────────────────────
// Turns the shared `["/api/trackers", …]` array into the five things the
// Wellness tab shows: Today, the weekly brief, Labs, Care and Activity history.
//
// The old tab derived each number by regex-matching tracker NAMES at the point
// of use, once per card, and rendered one card per tracker — which is why the
// same measurement appeared three times (HDL, "HDL Cholesterol", "Lipid Panel
// HDL"), impossible values sat next to real ones (HbA1c 179 %, BMI 47 beside
// 26.4), and "Video games" had a card on a health page.
//
// Here every reading is resolved through shared/wellness-canon.ts FIRST:
//
//   * one canonical id per metric, so duplicates merge into one series;
//   * one canonical unit, so a kg weigh-in and an lb weigh-in are one trend;
//   * a plausible range, so a value that cannot exist is dropped on read the
//     same way it is now rejected on write — old bad rows stop poisoning
//     averages without needing a migration;
//   * anything that is not a health metric resolves to null and simply does
//     not appear.
//
// Pure, no React, and shared: the Wellness tab renders it and the AI brief
// endpoint reasons over the SAME readout, so the page and the narrative can't
// describe different data. Unit-tested in tests/wellness-readout.test.ts.
import type { Tracker, TrackerEntry } from "./schema";
import { localDayOf, addDays, zonedTimeToUTC } from "./timezone";
import { isHealthDocument, type HealthDocLike } from "./health-documents";
import { normalizeDateString } from "./extraction-normalize";
import {
  resolveCanonicalMetric, validateCanonicalValue, flagAgainstReference,
  formatReference, getCanonicalMetric, LAB_PANELS, PANEL_LABELS,
  flagLabelFor, flagIsConcern, isRestingHeartRateReading,
  type CanonicalMetric, type MetricPanel, type RangeFlag,
} from "./wellness-canon";
import { classifyBloodPressure, bloodPressureFlag, BLOOD_PRESSURE_REFERENCE } from "./blood-pressure";

export interface Reading {
  /** Canonical-unit value. */
  value: number;
  at: string;
  trackerId: string;
  trackerName: string;
}

export interface MetricSeries {
  metric: CanonicalMetric;
  /** Oldest → newest, canonical unit, impossible values already removed. */
  readings: Reading[];
  latest: Reading | null;
  /**
   * The latest reading INSIDE the metric's freshness window — today for an
   * activity or recovery signal, last night (today or yesterday) for sleep —
   * or null. "Today" tiles and the score read this, never `latest`: a sleep
   * entry from Aug 22 was being shown as "6h 45m last night" on Sep 17.
   */
  latestFresh: Reading | null;
  previous: Reading | null;
  /** Mean of the readings in the last 30 days (excluding today's), or null. */
  avg30: number | null;
  /** Trackers this series was merged from — the duplicates, made visible. */
  sources: Array<{ id: string; name: string }>;
  /** The local calendar day (YYYY-MM-DD) the series was finalized against —
   *  what "today" means for a daily total such as water intake. */
  today: string;
  timezone?: string;
}

const DAY = 86400000;

function num(v: any): number {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function fieldUnit(t: Tracker, field: string): string {
  return (t.fields || []).find((f: any) => f?.name === field)?.unit || (t as any).unit || "";
}

/** Keys that are metadata, never a measurement. */
const META_KEY = /^_|^(notes|note|timestamp|source|mood|tags)$/i;

/**
 * Every plausible reading in the tracker array, keyed by canonical metric id.
 *
 * A tracker contributes one series PER FIELD that resolves — a Blood Pressure
 * tracker feeds both bp_systolic and bp_diastolic, a lab-report tracker feeds
 * every value on the report — and several trackers that resolve to the same id
 * merge into a single series ordered by time.
 */
/** Days back a reading still counts as "today's" for the signal it feeds. */
function freshWindowDays(metricId: string): number {
  return metricId === "sleep_hours" ? 1 : 0; // last night = today or yesterday
}

export interface CollectOptions {
  now?: Date;
  timezone?: string;
  /**
   * Documents whose extractedData holds readings — a lab report the Photo AI
   * pipeline read. Their values merge into the same series as the trackers'
   * (see collectDocumentMetrics), so a Vitamin D result that only ever lived
   * on the document no longer leaves Labs saying "No lab values".
   */
  documents?: HealthDocumentLike[] | null;
}

/** Appends a reading to its series in `byId`, creating the series on first use. */
function seriesBuilder(byId: Map<string, MetricSeries>) {
  return (metric: CanonicalMetric, r: Reading) => {
    let s = byId.get(metric.id);
    if (!s) {
      s = { metric, readings: [], latest: null, latestFresh: null, previous: null, avg30: null, sources: [], today: "" };
      byId.set(metric.id, s);
    }
    s.readings.push(r);
    if (!s.sources.some((x) => x.id === r.trackerId)) s.sources.push({ id: r.trackerId, name: r.trackerName });
  };
}

/** Order each series and derive latest / fresh / previous / 30-day mean. */
function finalizeSeries(byId: Map<string, MetricSeries>, now: number, timezone?: string): Map<string, MetricSeries> {
  const todayISO = localDayOf(new Date(now), timezone) || new Date(now).toISOString().slice(0, 10);
  for (const s of byId.values()) {
    s.today = todayISO;
    s.timezone = timezone;
    s.readings.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    s.latest = s.readings[s.readings.length - 1] || null;
    const freshFrom = addDays(todayISO, -freshWindowDays(s.metric.id));
    const latestDay = s.latest ? localDayOf(s.latest.at, timezone) : null;
    s.latestFresh = s.latest && latestDay && latestDay >= freshFrom ? s.latest : null;
    s.previous = s.readings.length > 1 ? s.readings[s.readings.length - 2] : null;
    const window = s.readings.filter((r) => {
      const age = now - new Date(r.at).getTime();
      return age > 0 && age <= 30 * DAY && r !== s.latest;
    });
    s.avg30 = window.length > 0 ? window.reduce((a, r) => a + r.value, 0) / window.length : null;
  }
  return byId;
}

export function collectMetrics(
  trackers: Tracker[] | undefined | null,
  opts: CollectOptions = {},
): Map<string, MetricSeries> {
  const now = opts.now ? opts.now.getTime() : Date.now();
  const byId = new Map<string, MetricSeries>();
  const push = seriesBuilder(byId);

  for (const t of trackers || []) {
    if (!t) continue;
    const name = t.name || "";
    const category = (t as any).category || "";
    for (const e of (t.entries || []) as TrackerEntry[]) {
      if (!e?.timestamp) continue;
      const at = new Date(e.timestamp);
      if (isNaN(at.getTime())) continue;
      // A future-dated reading is a typo, not a measurement (tolerate a day of
      // timezone slack).
      if (at.getTime() > now + DAY) continue;
      for (const [field, raw] of Object.entries(e.values || {})) {
        if (META_KEY.test(field)) continue;
        const v = num(raw);
        if (!Number.isFinite(v)) continue;
        // The field name decides first ("systolic" on a tracker called
        // "Vitals"), the tracker's own name second ("HbA1c" whose only field
        // is "value"). Either way the tracker's own name can veto the match:
        // "temperature" on a tracker called Weather is not a body temperature.
        const byField = resolveCanonicalMetric(field);
        const hay = `${name} ${category} ${field}`;
        const metric =
          byField && !(byField.exclude && byField.exclude.test(hay))
            ? byField
            : resolveCanonicalMetric(name, category, field);
        if (!metric) continue;
        // A heart rate logged mid-workout is not a resting reading; it would
        // only drag the average toward a number that describes nothing.
        if ((metric.id === "heart_rate" || metric.id === "resting_hr") && !isRestingHeartRateReading(e.values)) continue;
        const check = validateCanonicalValue(metric, v, fieldUnit(t, field));
        if (!check.ok) continue; // impossible value — see module header
        push(metric, { value: check.canonical, at: at.toISOString(), trackerId: t.id, trackerName: name });
      }
    }
  }

  finalizeSeries(byId, now, opts.timezone);
  if (opts.documents && opts.documents.length > 0) {
    return mergeMetrics(byId, collectDocumentMetrics(opts.documents, opts), opts);
  }
  return byId;
}

// ── Documents ────────────────────────────────────────────────────────────────
// A lab report the Photo AI pipeline read keeps its values on the document's
// extractedData (the source of truth for that upload). The extraction MAY also
// have logged them into trackers, but only when the user confirmed that step —
// and a report whose values were saved to the document alone left Labs saying
// "No lab values" while the numbers sat one tab over. So the readout reads
// documents too, resolving each value through the same canon as a tracker
// field, dated from the report itself, and merged into the same series.

export interface HealthDocumentLike extends HealthDocLike {
  id: string;
  extractedData?: Record<string, any> | null;
  createdAt?: string | null;
}

/** Reading.trackerId of a value read from a document: `doc:<documentId>`. */
export const DOC_SOURCE_PREFIX = "doc:";

/** The document id behind a reading's source, or null when it is a tracker. */
export function documentIdOfSource(trackerId: string | null | undefined): string | null {
  const id = String(trackerId ?? "");
  return id.startsWith(DOC_SOURCE_PREFIX) && id.length > DOC_SOURCE_PREFIX.length ? id.slice(DOC_SOURCE_PREFIX.length) : null;
}

/**
 * Keys of a report that are ABOUT the report, never a result: who, where,
 * when, reference ranges, flags. `date` matters most — "2026-09-01" parses as
 * the number 2026, and "collectionDate" is not a metric.
 */
const DOC_META_KEY =
  /date|\bdob\b|birth|name$|patient|provider|facility|clinic|physician|doctor|ordered|address|phone|fax|account|accession|\bmrn\b|number|status|page|signed|reference|range|flag|method|comment|interpretation|summary|notes?$|^_|calendar/i;

/** Keys that hold a reading's number inside a row / envelope object. */
const VALUE_KEY = /^(value|result|resultValue|reading|measurement|level|amount)$/i;
/** Keys that hold the reading's unit inside a row / envelope object. */
const UNIT_KEY = /^(unit|units|uom)$/i;
/** Keys that name the test inside a row object. */
const ROW_NAME_KEY = /^(name|test|testName|analyte|marker|parameter|item|label|component|measure|metric)$/i;
/** Keys that date a single row (a panel drawn on a different day). */
const ROW_DATE_KEY = /^(date|collectionDate|collected|dateCollected|reportDate|resultDate|drawn|testDate)$/i;
/** Top-level keys so generic that only the document's title can say what they measure. */
const GENERIC_VALUE_KEY = /^(value|result|results?|level|reading|measurement)$/i;

const BP_KEY = /blood\s*pressure|\bbp\b/i;

/**
 * "HemoglobinA1C" → "Hemoglobin A1C", "LDLCholesterol" → "LDL Cholesterol",
 * "vitamin_b12" → "vitamin b12". The canon's patterns are written for the
 * words a report prints, with word boundaries; extraction keys are camelCase
 * and would never reach `\ba1c\b` otherwise.
 */
function wordsOf(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const BP_VALUE = /^\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/;

/** "32 ng/mL", "< 5", 32, "5.8%" → the number and whatever unit rode with it. */
function parseMeasure(raw: unknown): { value: number; unit: string } | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, unit: "" } : null;
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\s*(?:[<>≤≥]=?\s*)?([-+]?\d+(?:[.,]\d+)?)\s*([a-zA-Zµμ%][a-zA-Zµμ%/0-9.^²³]*)?/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(value) ? { value, unit: m[2] || "" } : null;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** { value: 32, unit: "ng/mL", referenceRange: "30-100" } — one datum in an envelope. */
function envelopeMeasure(obj: Record<string, any>): { value: number; unit: string } | null {
  const valueKey = Object.keys(obj).find((k) => VALUE_KEY.test(k));
  if (valueKey == null) return null;
  const inner = obj[valueKey];
  const parsed = isPlainObject(inner) ? envelopeMeasure(inner) : parseMeasure(inner);
  if (!parsed) return null;
  const unitKey = Object.keys(obj).find((k) => UNIT_KEY.test(k));
  const unit = unitKey != null && typeof obj[unitKey] === "string" ? obj[unitKey] : parsed.unit;
  return { value: parsed.value, unit };
}

function rowName(obj: Record<string, any>): string | null {
  const k = Object.keys(obj).find((key) => ROW_NAME_KEY.test(key) && typeof obj[key] === "string" && obj[key].trim());
  return k != null ? String(obj[k]).trim() : null;
}

function rowDay(obj: Record<string, any>): string | null {
  const k = Object.keys(obj).find((key) => ROW_DATE_KEY.test(key));
  return k != null ? normalizeDateString(obj[k]) : null;
}

/**
 * The day the report's values were TRUE — the collection / draw date first,
 * then the report or result date, then a service, visit or test date, then a
 * bare "date". Never a birth date, an expiry, a due date or an issue date.
 * Falls back to the upload day (createdAt) when the report printed none.
 */
export function documentReportDay(doc: HealthDocumentLike, timezone?: string): string | null {
  const data = isPlainObject(doc.extractedData) ? doc.extractedData : {};
  let best: { rank: number; day: string } | null = null;
  for (const [key, raw] of Object.entries(data)) {
    if (!/date|collected$|reported$|drawn$/i.test(key)) continue;
    if (/birth|\bdob\b|expir|due|issue|print|next|follow|upload|creat|receiv|calendar|^_/i.test(key)) continue;
    const day = typeof raw === "string" || typeof raw === "number" ? normalizeDateString(raw) : null;
    if (!day) continue;
    const rank = /collect|specimen|draw/i.test(key) ? 0
      : /report|result/i.test(key) ? 1
      : /test|service|visit|exam|encounter|lab|order/i.test(key) ? 2
      : /^date$/i.test(key) ? 3 : 4;
    if (!best || rank < best.rank) best = { rank, day };
  }
  if (best) return best.day;
  return doc.createdAt ? localDayOf(doc.createdAt, timezone) : null;
}

/**
 * Every plausible reading in the health documents, keyed by canonical metric
 * id — the same shape collectMetrics returns, so the two merge.
 *
 * extractedData has no fixed schema. The shapes the pipeline produces, and
 * each is handled:
 *   * a flat key:            { vitaminD: "32 ng/mL" }, { VitaminD: "27" }
 *   * an envelope:           { vitaminD: { value: 32, unit: "ng/mL" } }
 *   * a nested panel:        { cholesterol: { hdl: 50, ldl: 100, total: 180 } }
 *   * rows:                  { labResults: [{ test: "Vitamin D", value: 32, unit: "ng/mL" }] }
 *   * blood pressure:        { bloodPressure: "138/86" }
 * A key resolves the way a tracker field does: its own name first (with the
 * metric's exclude veto over the surrounding keys), then with its parent key.
 * Each reading is dated from the report (documentReportDay) at local noon —
 * exactly where confirm-extraction places the tracker entry it may also have
 * logged, so the two dedupe on merge.
 */
export function collectDocumentMetrics(
  documents: HealthDocumentLike[] | undefined | null,
  opts: { now?: Date; timezone?: string } = {},
): Map<string, MetricSeries> {
  const now = opts.now ? opts.now.getTime() : Date.now();
  const byId = new Map<string, MetricSeries>();
  const push = seriesBuilder(byId);

  for (const doc of documents || []) {
    if (!doc || !doc.id || !isHealthDocument(doc)) continue;
    const data = isPlainObject(doc.extractedData) ? doc.extractedData : null;
    if (!data) continue;
    const day = documentReportDay(doc, opts.timezone);
    if (!day) continue;
    const trackerId = `${DOC_SOURCE_PREFIX}${doc.id}`;
    const title = String(doc.title || doc.name || "").trim();
    const trackerName = title || "Document";

    const atFor = (d: string): string | null => {
      const at = zonedTimeToUTC(d, 12, 0, opts.timezone);
      if (isNaN(at.getTime()) || at.getTime() > now + DAY) return null;
      return at.toISOString();
    };

    const emit = (rawKey: string, rawParent: string, measure: { value: number; unit: string }, d: string, topLevel: boolean) => {
      const key = wordsOf(rawKey);
      const parent = wordsOf(rawParent);
      const byKey = resolveCanonicalMetric(key);
      const hay = `${parent} ${key}`;
      let metric = byKey && !(byKey.exclude && byKey.exclude.test(hay)) ? byKey : resolveCanonicalMetric(parent, key);
      // A top-level "result" says nothing on its own; the document's title
      // does ("Vitamin D results"). Only for a generic key — a title never
      // gets to rename a key that has a meaning of its own.
      if (!metric && topLevel && GENERIC_VALUE_KEY.test(key)) metric = resolveCanonicalMetric(title, key);
      if (!metric) return;
      const check = validateCanonicalValue(metric, measure.value, measure.unit);
      if (!check.ok) return; // impossible value — same rule as a tracker
      const at = atFor(d);
      if (!at) return;
      push(metric, { value: check.canonical, at, trackerId, trackerName });
    };

    const emitRow = (row: Record<string, any>, parent: string, d: string) => {
      const name = rowName(row);
      const measure = envelopeMeasure(row);
      if (!name || !measure) return;
      emit(name, parent, measure, rowDay(row) || d, false);
    };

    const walk = (key: string, raw: any, parent: string, d: string, depth: number) => {
      if (depth > 4 || raw == null) return;
      if (META_KEY.test(key) || DOC_META_KEY.test(key)) return;
      if (Array.isArray(raw)) {
        for (const el of raw) if (isPlainObject(el)) emitRow(el, key, d);
        return;
      }
      if (isPlainObject(raw)) {
        if (rowName(raw) && envelopeMeasure(raw)) { emitRow(raw, parent, d); return; }
        const env = envelopeMeasure(raw);
        if (env) { emit(key, parent, env, rowDay(raw) || d, depth === 0); return; }
        const nextParent = `${parent} ${key}`.trim();
        for (const [k, v] of Object.entries(raw)) walk(k, v, nextParent, d, depth + 1);
        return;
      }
      if (typeof raw === "string" && BP_KEY.test(wordsOf(`${parent} ${key}`))) {
        const bp = raw.match(BP_VALUE);
        if (bp) {
          emit("systolic", key, { value: +bp[1], unit: "mmHg" }, d, false);
          emit("diastolic", key, { value: +bp[2], unit: "mmHg" }, d, false);
          return;
        }
      }
      const measure = parseMeasure(raw);
      if (measure) emit(key, parent, measure, d, depth === 0);
    };

    for (const [key, raw] of Object.entries(data)) walk(key, raw, "", day, 0);
  }

  return finalizeSeries(byId, now, opts.timezone);
}

/** Identity of a reading for dedupe: same local day, same canonical value. */
function readingKey(r: Reading, timezone?: string): string {
  return `${localDayOf(r.at, timezone) || r.at.slice(0, 10)}|${Math.round(r.value * 1000) / 1000}`;
}

/**
 * One map from two: `b`'s readings join `a`'s series (creating a series when
 * `a` has none). A reading in `b` that repeats one already in `a` — same
 * metric, same local day, same value — is dropped: the extraction that saved
 * a lab value to the document may ALSO have logged it into a tracker, and
 * that is one measurement, not a trend from 32 to 32.
 */
export function mergeMetrics(
  a: Map<string, MetricSeries>,
  b: Map<string, MetricSeries>,
  opts: { now?: Date; timezone?: string } = {},
): Map<string, MetricSeries> {
  const now = opts.now ? opts.now.getTime() : Date.now();
  const byId = new Map<string, MetricSeries>();
  const push = seriesBuilder(byId);
  const seen = new Map<string, Set<string>>();
  for (const s of a.values()) {
    const keys = new Set<string>();
    for (const r of s.readings) { push(s.metric, r); keys.add(readingKey(r, opts.timezone)); }
    seen.set(s.metric.id, keys);
  }
  for (const s of b.values()) {
    const keys = seen.get(s.metric.id) || new Set<string>();
    for (const r of s.readings) {
      const k = readingKey(r, opts.timezone);
      if (keys.has(k)) continue;
      push(s.metric, r);
      keys.add(k);
    }
    seen.set(s.metric.id, keys);
  }
  return finalizeSeries(byId, now, opts.timezone);
}

// ── Today ────────────────────────────────────────────────────────────────────
// Three signals, each of which a connected Health source fills in on its own.
// A signal with no data says so — it never shows a goal ring the user is
// failing to fill, because nothing here is something they have to log.

export interface TodaySignal {
  key: "sleep" | "activity" | "recovery" | "hydration";
  label: string;
  /** Today's value (last night's for sleep), canonical unit. Null when nothing
   *  is connected yet OR nothing was recorded inside the window. */
  value: number | null;
  unit: string;
  /** What the value is (e.g. "Resting HR"), when the signal has variants. */
  caption: string | null;
  /** Mean of the last 30 days, for the "vs. average" read. */
  avg30: number | null;
  /** Last ~30 values oldest→newest for the trend line. */
  series: number[];
  at: string | null;
  /** When the newest reading of ANY age was taken — so an empty tile can say
   *  "last logged Aug 22" instead of pretending nothing was ever connected. */
  lastAt: string | null;
  /** Higher is better for this signal? Drives the delta's tone. */
  higherBetter: boolean;
  /** The metric id behind the value, so the UI can deep-link its tracker. */
  metricId: string | null;
  trackerId: string | null;
}

function signalFrom(
  m: MetricSeries | undefined,
  key: TodaySignal["key"],
  label: string,
  caption: string | null,
  higherBetter: boolean,
): TodaySignal {
  return {
    key, label, caption,
    value: m?.latestFresh?.value ?? null,
    unit: m?.metric.unit ?? "",
    avg30: m?.avg30 ?? null,
    series: (m?.readings || []).slice(-30).map((r) => r.value),
    at: m?.latestFresh?.at ?? null,
    lastAt: m?.latest?.at ?? null,
    higherBetter,
    metricId: m?.metric.id ?? null,
    trackerId: (m?.latestFresh ?? m?.latest)?.trackerId ?? null,
  };
}

export function todaySignals(metrics: Map<string, MetricSeries>): TodaySignal[] {
  const sleep = metrics.get("sleep_hours");
  // Activity prefers steps, then exercise minutes, then distance — whichever
  // the connected source actually reports.
  const steps = metrics.get("steps");
  const mins = metrics.get("exercise_minutes");
  const dist = metrics.get("distance");
  const act = steps?.latestFresh ? steps : mins?.latestFresh ? mins : dist?.latestFresh ? dist
    : steps?.latest ? steps : mins?.latest ? mins : dist?.latest ? dist : steps || mins || dist;
  // Recovery prefers HRV (the better signal) but resting HR is what most
  // people have.
  const hrv = metrics.get("hrv");
  const rhr = metrics.get("resting_hr");
  const rec = hrv?.latestFresh ? hrv : rhr?.latestFresh ? rhr : hrv?.latest ? hrv : rhr;
  return [
    signalFrom(sleep, "sleep", "Sleep", null, true),
    signalFrom(act, "activity", "Activity", act?.metric.label ?? null, true),
    signalFrom(rec, "recovery", "Recovery", rec?.metric.label ?? null, rec?.metric.id === "hrv"),
    hydrationSignal(metrics.get("hydration")),
  ];
}

/** Sum of a series' readings per local day, oldest → newest. */
function dailyTotals(s: MetricSeries): Array<{ day: string; total: number }> {
  const byDay = new Map<string, number>();
  for (const r of s.readings) {
    const day = localDayOf(r.at, s.timezone) || r.at.slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + r.value);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, total]) => ({ day, total }));
}

/**
 * Water is a daily TOTAL, not a reading: "40 oz so far today" is every entry
 * logged today added up, and the 30-day baseline is the mean of the days that
 * have any — the same sum the dashboard's Water tile shows.
 */
function hydrationSignal(s: MetricSeries | undefined): TodaySignal {
  const empty = signalFrom(undefined, "hydration", "Water", null, true);
  if (!s || s.readings.length === 0) return { ...empty, unit: "oz" };
  const days = dailyTotals(s);
  const todayRow = days.find((d) => d.day === s.today) || null;
  const baseline = days.filter((d) => d.day !== s.today && d.day >= addDays(s.today, -30));
  const todaysReadings = s.readings.filter((r) => (localDayOf(r.at, s.timezone) || r.at.slice(0, 10)) === s.today);
  return {
    key: "hydration", label: "Water", caption: null,
    value: todayRow ? Math.round(todayRow.total * 10) / 10 : null,
    unit: s.metric.unit,
    avg30: baseline.length > 0 ? baseline.reduce((a, d) => a + d.total, 0) / baseline.length : null,
    series: days.slice(-30).map((d) => Math.round(d.total * 10) / 10),
    at: todaysReadings.length > 0 ? todaysReadings[todaysReadings.length - 1].at : null,
    lastAt: s.latest?.at ?? null,
    higherBetter: true,
    metricId: s.metric.id,
    trackerId: (s.latest)?.trackerId ?? null,
  };
}

/** One conversion for every "N min below your average" line: hours → whole minutes. */
export function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

// ── Labs ─────────────────────────────────────────────────────────────────────

export interface LabRow {
  metricId: string;
  label: string;
  value: number;
  unit: string;
  at: string;
  flag: RangeFlag;
  /** Pill text for the flag ("High", "Elevated", "Athletic"); null when nothing to show. */
  flagLabel: string | null;
  reference?: string;
  /** Immediately previous report's value, for the "128 → 138" trend. */
  previous: number | null;
  trackerId: string;
  /** Number of trackers this row was merged from (>1 ⇒ duplicates collapsed). */
  mergedFrom: number;
}

export interface LabPanel {
  panel: MetricPanel;
  label: string;
  rows: LabRow[];
  outOfRange: number;
}

export function labPanels(metrics: Map<string, MetricSeries>): LabPanel[] {
  return panelsFor(metrics, LAB_PANELS);
}

/**
 * Body and vitals — weight, BMI, body fat, blood pressure, temperature, SpO2.
 *
 * Kept OUT of Labs (they are not lab work) but rendered in the same row shape,
 * because they answer the same question: what is the number, is it in range,
 * and which way is it moving. Browser-testing the rebuilt tab caught them
 * missing from the page entirely — collected, scored against, and shown
 * nowhere, which lost the old tab's Vitals card.
 */
export function bodyVitals(metrics: Map<string, MetricSeries>): LabPanel[] {
  return panelsFor(metrics, ["vitals", "body"]);
}

function panelsFor(metrics: Map<string, MetricSeries>, wanted: MetricPanel[]): LabPanel[] {
  const panels: LabPanel[] = [];
  // Blood pressure is judged as a PAIR (shared/blood-pressure.ts): both rows
  // carry the verdict for the latest systolic/diastolic together, so 121/76
  // reads "Elevated" here exactly as it does on the tracker card.
  const sys = metrics.get("bp_systolic")?.latest;
  const dia = metrics.get("bp_diastolic")?.latest;
  const bp = sys && dia ? classifyBloodPressure(sys.value, dia.value) : null;
  for (const panel of wanted) {
    const rows: LabRow[] = [];
    for (const s of metrics.values()) {
      if (s.metric.panel !== panel || !s.latest) continue;
      const isBp = s.metric.id === "bp_systolic" || s.metric.id === "bp_diastolic";
      const flag: RangeFlag = isBp && bp ? bloodPressureFlag(bp.category) : flagAgainstReference(s.metric, s.latest.value);
      const flagLabel = isBp && bp
        ? (bp.category === "normal" ? null : bp.label)
        : flagLabelFor(s.metric, flag);
      const reference = isBp
        ? BLOOD_PRESSURE_REFERENCE[s.metric.id === "bp_systolic" ? "systolic" : "diastolic"]
        : formatReference(s.metric);
      rows.push({
        metricId: s.metric.id,
        label: s.metric.label,
        value: s.latest.value,
        unit: s.metric.unit,
        at: s.latest.at,
        flag,
        flagLabel,
        reference,
        previous: s.previous?.value ?? null,
        trackerId: s.latest.trackerId,
        mergedFrom: s.sources.length,
      });
    }
    if (rows.length === 0) continue;
    const concern = (r: LabRow) => {
      const m = getCanonicalMetric(r.metricId);
      return m ? flagIsConcern(m, r.flag) : r.flag === "low" || r.flag === "high";
    };
    // Out-of-range first, then alphabetical — the reason you opened the panel.
    rows.sort((a, b) => (concern(a) ? 0 : 1) - (concern(b) ? 0 : 1) || a.label.localeCompare(b.label));
    panels.push({
      panel, label: PANEL_LABELS[panel], rows,
      // "elevated" and "high"/"low" count; a good-side label ("Athletic") does not.
      outOfRange: rows.filter(concern).length,
    });
  }
  return panels;
}

// ── Activity history ─────────────────────────────────────────────────────────
// Workouts grouped by type. Fed by whatever records sessions today; when Health
// is connected its workouts land in the same shape.

const ACTIVITY_NAME =
  /\b(?:exercis|workout|work\s?out|train|fitness|gym|cardio|walk|step|run|jog|hik|cycl|bik|swim|row|elliptic|treadmill|yoga|pilates|stretch|strength|lift|weights|sport|tennis|basketball|soccer|golf|climb|ski|skat|danc|peloton|marathon|cross\s?fit|push\s?up|pull\s?up|bench|squat|dead\s?lift|plank|sit\s?up)/i;

const DURATION_FIELD = /(duration|minutes?|\bmins?\b|\btime\b|active)/i;
const DISTANCE_FIELD = /(distance|miles?|\bmi\b|kilometers?|\bkm\b|meters?|laps?)/i;
// Reps and sets are different things: 8 reps × 4 sets is 32 reps, not 12.
// One regex used to add both into a single "reps" number ("24 reps" for a
// session logged as 8 × 4 — sets ignored, then summed in as if reps).
const REPS_FIELD = /\breps?\b|repetitions?/i;
const SETS_FIELD = /\bsets?\b/i;

export interface WorkoutGroup {
  type: string;
  sessions: number;
  minutes: number | null;
  distance: number | null;
  /** Total repetitions across the window — reps × sets per session. */
  reps: number | null;
  /** Total sets across the window, when the tracker records them. */
  sets: number | null;
  lastAt: string | null;
  trackerId: string;
}

export function activityHistory(
  trackers: Tracker[] | undefined | null,
  opts: { now?: Date; days?: number } = {},
): WorkoutGroup[] {
  const now = opts.now ? opts.now.getTime() : Date.now();
  const cutoff = now - (opts.days ?? 90) * DAY;
  const groups: WorkoutGroup[] = [];
  for (const t of trackers || []) {
    if (!t) continue;
    const hay = `${t.name || ""} ${(t as any).category || ""}`;
    // A name that reads like a workout, or a tracker shaped like one.
    //
    // A DURATION field deliberately does not qualify on its own: "Guitar
    // practice" and "Studying" both record minutes, and browser-testing the
    // rebuilt tab found them filed as workouts — with the weekly brief then
    // reporting "you trained 9 times this week — mostly steps and guitar
    // practice". A distance field is a real movement signal; minutes are not.
    const shaped = (t.fields || []).some((f: any) => DISTANCE_FIELD.test(f?.name || ""));
    if (!ACTIVITY_NAME.test(hay) && !shaped) continue;
    // A tracker that IS a canonical metric is a SIGNAL, not a workout type:
    // "Steps" belongs in Today, not in the list of things you trained at.
    if (resolveCanonicalMetric(t.name, (t as any).category)) continue;
    let sessions = 0, minutes = 0, distance = 0, reps = 0, sets = 0;
    let sawMin = false, sawDist = false, sawReps = false, sawSets = false;
    let lastAt: string | null = null;
    for (const e of t.entries || []) {
      const ts = e?.timestamp ? new Date(e.timestamp).getTime() : NaN;
      if (!Number.isFinite(ts) || ts < cutoff || ts > now + DAY) continue;
      sessions++;
      if (!lastAt || ts > new Date(lastAt).getTime()) lastAt = new Date(ts).toISOString();
      const computed: any = (e as any).computed || {};
      // ONE duration and ONE distance per session. An entry carries the same
      // number several ways — `duration` as logged, `durationMinutes` mirrored
      // by the estimation engine, `computed.durationMinutes` — and adding
      // every copy turned a 19-minute run into 57 ("13 sessions · 709 min"
      // for runs logged at 2 mi in 19 min, QA 2026-09-18 F-37). A clock or
      // pace string ("7:30", "9:30/mi") is not a duration either; parsed as a
      // number it read as 730 minutes.
      let entryMinutes: number | null = null, entryDistance: number | null = null;
      const cd = num(computed.durationMinutes);
      if (Number.isFinite(cd) && cd > 0) entryMinutes = cd;
      let entryReps: number | null = null, entrySets: number | null = null;
      for (const [field, raw] of Object.entries(e.values || {})) {
        if (META_KEY.test(field)) continue;
        if (typeof raw === "string" && /\d:\d/.test(raw)) continue; // clock time / pace, never a quantity
        const v = num(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (DURATION_FIELD.test(field)) { if (entryMinutes == null) entryMinutes = v; continue; }
        if (DISTANCE_FIELD.test(field)) { if (entryDistance == null) entryDistance = v; continue; }
        if (SETS_FIELD.test(field)) { entrySets = (entrySets ?? 0) + v; continue; }
        if (REPS_FIELD.test(field)) { entryReps = (entryReps ?? 0) + v; continue; }
      }
      if (entryMinutes != null) { minutes += entryMinutes; sawMin = true; }
      if (entryDistance != null) { distance += entryDistance; sawDist = true; }
      if (entryReps != null) { reps += entryReps * (entrySets ?? 1); sawReps = true; }
      if (entrySets != null) { sets += entrySets; sawSets = true; }
    }
    if (sessions === 0) continue;
    groups.push({
      type: t.name || "Activity", sessions,
      minutes: sawMin ? Math.round(minutes) : null,
      distance: sawDist ? Math.round(distance * 10) / 10 : null,
      reps: sawReps ? reps : null,
      sets: sawSets ? sets : null,
      lastAt, trackerId: t.id,
    });
  }
  return groups.sort((a, b) => {
    const ta = a.lastAt ? new Date(a.lastAt).getTime() : 0;
    const tb = b.lastAt ? new Date(b.lastAt).getTime() : 0;
    return tb - ta || b.sessions - a.sessions;
  });
}

// ── Score ────────────────────────────────────────────────────────────────────
// A number nobody can explain is worse than no number. This one shows its
// working: which components exist, what each scored, and what it is worth.
// A component with no connected source is NOT counted as a zero — it is left
// out and the remaining weights are renormalised.

export interface ScoreComponent {
  key: "sleep" | "activity" | "recovery";
  label: string;
  /** 0–100 for this component, or null when nothing feeds it. */
  score: number | null;
  /** Share of the total, renormalised over the components that have data. */
  weight: number;
  detail: string;
}

export interface WellnessScore {
  value: number | null;
  components: ScoreComponent[];
  /**
   * True when at least one scored source has EVER reported (any reading, of
   * any age). Separates "nothing logged today" from "nothing connected":
   * the empty score used to say "no connected source" beside a Sources block
   * saying every source was receiving data (QA 2026-09-18 F-32).
   */
  connected?: boolean;
}

const BASE_WEIGHTS: Record<ScoreComponent["key"], number> = { sleep: 0.4, activity: 0.3, recovery: 0.3 };

/** Score a value inside a band: full marks in range, tapering outside it. */
function bandScore(v: number, low: number, high: number, tolerance: number): number {
  if (v >= low && v <= high) return 100;
  const d = v < low ? low - v : v - high;
  return Math.max(0, Math.round(100 - (d / tolerance) * 100));
}

export function wellnessScore(metrics: Map<string, MetricSeries>): WellnessScore {
  const parts: Array<{ key: ScoreComponent["key"]; label: string; score: number | null; detail: string }> = [];

  // FRESH readings only. The score said 70 from a sleep entry three weeks
  // old and a step count from a day nothing was logged; a component with no
  // reading inside its window is not counted, and its detail says why.
  const sleepSeries = metrics.get("sleep_hours");
  const sleep = sleepSeries?.latestFresh?.value ?? null;
  parts.push({
    key: "sleep", label: "Sleep",
    score: sleep == null ? null : bandScore(sleep, 7, 9, 4),
    detail: sleep != null ? `${round1(sleep)} h last night`
      : sleepSeries?.latest ? "No sleep recorded last night"
      : "No sleep source connected",
  });

  const stepsSeries = metrics.get("steps");
  const minsSeries = metrics.get("exercise_minutes");
  const steps = stepsSeries?.latestFresh?.value ?? null;
  const mins = minsSeries?.latestFresh?.value ?? null;
  const activityScore = steps != null ? Math.min(100, Math.round((steps / 8000) * 100))
    : mins != null ? Math.min(100, Math.round((mins / 30) * 100))
    : null;
  parts.push({
    key: "activity", label: "Activity",
    score: activityScore,
    detail: steps != null ? `${Math.round(steps).toLocaleString()} steps`
      : mins != null ? `${Math.round(mins)} active min`
      : stepsSeries?.latest || minsSeries?.latest ? "No activity recorded today"
      : "No activity source connected",
  });

  const hrv = metrics.get("hrv");
  const rhr = metrics.get("resting_hr");
  let recovery: number | null = null;
  let recoveryDetail = hrv?.latest || rhr?.latest ? "No recovery reading today" : "No recovery source connected";
  if (hrv?.latestFresh && hrv.avg30) {
    // HRV is meaningful only against your own baseline.
    const ratio = hrv.latestFresh.value / hrv.avg30;
    recovery = Math.max(0, Math.min(100, Math.round(ratio * 80)));
    recoveryDetail = `HRV ${Math.round(hrv.latestFresh.value)} ms vs ${Math.round(hrv.avg30)} ms avg`;
  } else if (rhr?.latestFresh) {
    recovery = bandScore(rhr.latestFresh.value, 40, 65, 30);
    recoveryDetail = `Resting HR ${Math.round(rhr.latestFresh.value)} bpm`;
  }
  parts.push({ key: "recovery", label: "Recovery", score: recovery, detail: recoveryDetail });

  const live = parts.filter((p) => p.score != null);
  const totalWeight = live.reduce((a, p) => a + BASE_WEIGHTS[p.key], 0);
  const components: ScoreComponent[] = parts.map((p) => ({
    key: p.key, label: p.label, score: p.score, detail: p.detail,
    weight: p.score == null || totalWeight === 0 ? 0 : BASE_WEIGHTS[p.key] / totalWeight,
  }));
  // Weighted mean over the COUNTED components only: one component scored 100
  // is a score of 100, never diluted by the ones that are not counted.
  const value = live.length === 0 ? null
    : Math.round(components.reduce((a, c) => a + (c.score ?? 0) * c.weight, 0));
  const connected = !!(sleepSeries?.latest || stepsSeries?.latest || minsSeries?.latest || hrv?.latest || rhr?.latest);
  return { value, components, connected };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

// ── Weekly brief ─────────────────────────────────────────────────────────────
// Sentences about data that EXISTS. Never "you haven't logged X in 24 days" —
// nothing here is the user's job to log, so an absent source is a setup gap,
// not a failure, and it is reported once in the connect prompt instead.

export interface BriefInput {
  metrics: Map<string, MetricSeries>;
  workouts: WorkoutGroup[];
  labs: LabPanel[];
  now?: Date;
}

export function weeklyBrief(input: BriefInput): string[] {
  const { metrics, workouts, labs } = input;
  const now = input.now ? input.now.getTime() : Date.now();
  const out: string[] = [];

  const weekMean = (id: string): number | null => {
    const s = metrics.get(id);
    if (!s) return null;
    const rows = s.readings.filter((r) => now - new Date(r.at).getTime() <= 7 * DAY);
    return rows.length > 0 ? rows.reduce((a, r) => a + r.value, 0) / rows.length : null;
  };

  const sleep = metrics.get("sleep_hours");
  const sleepWeek = weekMean("sleep_hours");
  if (sleep && sleepWeek != null && sleep.avg30 != null) {
    const deltaMin = hoursToMinutes(sleepWeek - sleep.avg30);
    if (Math.abs(deltaMin) >= 15) {
      out.push(`Sleep is ${Math.abs(deltaMin)} min ${deltaMin < 0 ? "down" : "up"} this week vs. your 30-day average (${round1(sleepWeek)} h vs ${round1(sleep.avg30)} h).`);
    } else {
      out.push(`Sleep is steady at ${round1(sleepWeek)} h a night, in line with your 30-day average.`);
    }
  } else if (sleepWeek != null) {
    out.push(`You averaged ${round1(sleepWeek)} h of sleep this week.`);
  }

  const rhr = metrics.get("resting_hr");
  const rhrWeek = weekMean("resting_hr");
  if (rhr && rhrWeek != null && rhr.avg30 != null) {
    const d = Math.round(rhrWeek - rhr.avg30);
    if (Math.abs(d) >= 2) out.push(`Resting heart rate is ${Math.abs(d)} bpm ${d > 0 ? "up" : "down"}, at ${Math.round(rhrWeek)} bpm.`);
  }

  const weekWorkouts = workouts.filter((w) => w.lastAt && now - new Date(w.lastAt).getTime() <= 7 * DAY);
  if (weekWorkouts.length > 0) {
    const sessions = weekWorkouts.reduce((a, w) => a + w.sessions, 0);
    const types = weekWorkouts.slice(0, 2).map((w) => w.type.toLowerCase()).join(" and ");
    out.push(`You trained ${sessions} time${sessions === 1 ? "" : "s"} this week — mostly ${types}.`);
  }

  const flagged = labs.flatMap((p) => p.rows.filter((r) => r.flag === "low" || r.flag === "high" || r.flag === "elevated"));
  if (flagged.length > 0) {
    const first = flagged[0];
    const dir = first.flag === "high" || first.flag === "elevated" ? "above" : "below";
    out.push(
      flagged.length === 1
        ? `One lab value is out of range: ${first.label} at ${round1(first.value)} ${first.unit}, ${dir} the reference range.`
        : `${flagged.length} lab values are out of range, including ${first.label} at ${round1(first.value)} ${first.unit}.`,
    );
  }

  const weight = metrics.get("weight");
  if (weight?.latest && weight.avg30 != null) {
    const d = weight.latest.value - weight.avg30;
    if (Math.abs(d) >= 1) out.push(`Weight is ${round1(Math.abs(d))} ${weight.metric.unit} ${d > 0 ? "above" : "below"} your 30-day average.`);
  }

  return out.slice(0, 4);
}

// ── Connection state ─────────────────────────────────────────────────────────
// What is feeding the tab. Drives the one honest nudge on the page: connect a
// source, rather than "log this yourself".

export interface SourceState {
  sleep: boolean;
  activity: boolean;
  recovery: boolean;
  labs: boolean;
  body: boolean;
  hydration?: boolean;
}

export function sourceState(metrics: Map<string, MetricSeries>): SourceState {
  const has = (id: string) => !!metrics.get(id)?.latest;
  return {
    sleep: has("sleep_hours"),
    activity: has("steps") || has("exercise_minutes") || has("distance"),
    recovery: has("hrv") || has("resting_hr"),
    labs: [...metrics.values()].some((s) => LAB_PANELS.includes(s.metric.panel) && !!s.latest),
    body: has("weight") || has("bmi") || has("body_fat"),
    hydration: has("hydration"),
  };
}

/** Has any tracked health source ever reported? Drives the difference between
 *  "nothing logged today" and "connect a source" on every empty state. */
export function anySourceConnected(sources: SourceState): boolean {
  return !!(sources.sleep || sources.activity || sources.recovery || sources.labs || sources.body || sources.hydration);
}

/** Every duplicate the canon collapsed: one entry per metric logged into more
 *  than one tracker, so the user can see WHY two cards became one. */
export function mergedDuplicates(metrics: Map<string, MetricSeries>): Array<{ label: string; sources: string[] }> {
  return [...metrics.values()]
    .filter((s) => s.sources.length > 1)
    .map((s) => ({ label: s.metric.label, sources: s.sources.map((x) => x.name) }));
}

export { getCanonicalMetric, formatReference };

// ── One subject ──────────────────────────────────────────────────────────────
// "Everyone" is a fine filter for bills. For a body it is not: under it the
// tab mixed two people's records and showed two heights (70 in and 67 in),
// which is what produced a BMI of 47 next to one of 26.4. Health data is read
// for exactly ONE person, and both the page and the AI brief resolve that
// person here so they can never disagree about whose data they are describing.

export interface SubjectLike {
  id: string;
  type?: string | null;
  name?: string | null;
}

export interface SubjectResolution<T extends SubjectLike> {
  subject: T | null;
  /** True when the subject is the account owner (or there is no profile yet). */
  isSelf: boolean;
}

/** The selected person if one is selected, else "me". */
export function resolveWellnessSubject<T extends SubjectLike>(
  profiles: T[] | null | undefined,
  selectedIds: string[] | null | undefined,
): SubjectResolution<T> {
  const people = (profiles || []).filter((p) => p && (p.type === "person" || p.type === "self"));
  const selfProfile = people.find((p) => p.type === "self") || null;
  const ids = (selectedIds || []).filter(Boolean);
  const subject = (ids.length > 0 ? people.find((p) => ids.includes(p.id)) : null) || selfProfile || null;
  return { subject, isSelf: !subject || subject.type === "self" };
}

/**
 * Does a record belong to the subject? A record with no profile link predates
 * profile linking and belongs to "me", so it passes for the self profile only
 * — never for someone else, which is how another person's readings stop
 * leaking into this page.
 */
export function belongsToSubject(
  linkedProfiles: string[] | null | undefined,
  subject: SubjectLike | null,
  isSelf: boolean,
): boolean {
  const ids = Array.isArray(linkedProfiles) ? linkedProfiles.filter(Boolean) : [];
  if (ids.length === 0) return isSelf;
  return subject ? ids.includes(subject.id) : false;
}
