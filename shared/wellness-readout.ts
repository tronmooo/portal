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
import {
  resolveCanonicalMetric, validateCanonicalValue, flagAgainstReference,
  formatReference, getCanonicalMetric, LAB_PANELS, PANEL_LABELS,
  type CanonicalMetric, type MetricPanel, type RangeFlag,
} from "./wellness-canon";

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
  previous: Reading | null;
  /** Mean of the readings in the last 30 days (excluding today's), or null. */
  avg30: number | null;
  /** Trackers this series was merged from — the duplicates, made visible. */
  sources: Array<{ id: string; name: string }>;
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
export function collectMetrics(
  trackers: Tracker[] | undefined | null,
  opts: { now?: Date } = {},
): Map<string, MetricSeries> {
  const now = opts.now ? opts.now.getTime() : Date.now();
  const byId = new Map<string, MetricSeries>();
  const push = (metric: CanonicalMetric, r: Reading) => {
    let s = byId.get(metric.id);
    if (!s) {
      s = { metric, readings: [], latest: null, previous: null, avg30: null, sources: [] };
      byId.set(metric.id, s);
    }
    s.readings.push(r);
    if (!s.sources.some((x) => x.id === r.trackerId)) s.sources.push({ id: r.trackerId, name: r.trackerName });
  };

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
        const check = validateCanonicalValue(metric, v, fieldUnit(t, field));
        if (!check.ok) continue; // impossible value — see module header
        push(metric, { value: check.canonical, at: at.toISOString(), trackerId: t.id, trackerName: name });
      }
    }
  }

  for (const s of byId.values()) {
    s.readings.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    s.latest = s.readings[s.readings.length - 1] || null;
    s.previous = s.readings.length > 1 ? s.readings[s.readings.length - 2] : null;
    const window = s.readings.filter((r) => {
      const age = now - new Date(r.at).getTime();
      return age > 0 && age <= 30 * DAY && r !== s.latest;
    });
    s.avg30 = window.length > 0 ? window.reduce((a, r) => a + r.value, 0) / window.length : null;
  }
  return byId;
}

// ── Today ────────────────────────────────────────────────────────────────────
// Three signals, each of which a connected Health source fills in on its own.
// A signal with no data says so — it never shows a goal ring the user is
// failing to fill, because nothing here is something they have to log.

export interface TodaySignal {
  key: "sleep" | "activity" | "recovery";
  label: string;
  /** Latest value, canonical unit. Null when nothing is connected yet. */
  value: number | null;
  unit: string;
  /** What the value is (e.g. "Resting HR"), when the signal has variants. */
  caption: string | null;
  /** Mean of the last 30 days, for the "vs. average" read. */
  avg30: number | null;
  /** Last ~30 values oldest→newest for the trend line. */
  series: number[];
  at: string | null;
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
    value: m?.latest?.value ?? null,
    unit: m?.metric.unit ?? "",
    avg30: m?.avg30 ?? null,
    series: (m?.readings || []).slice(-30).map((r) => r.value),
    at: m?.latest?.at ?? null,
    higherBetter,
    metricId: m?.metric.id ?? null,
    trackerId: m?.latest?.trackerId ?? null,
  };
}

export function todaySignals(metrics: Map<string, MetricSeries>): TodaySignal[] {
  const sleep = metrics.get("sleep_hours");
  // Activity prefers steps, then exercise minutes, then distance — whichever
  // the connected source actually reports.
  const steps = metrics.get("steps");
  const mins = metrics.get("exercise_minutes");
  const dist = metrics.get("distance");
  const act = steps?.latest ? steps : mins?.latest ? mins : dist?.latest ? dist : steps || mins || dist;
  // Recovery prefers HRV (the better signal) but resting HR is what most
  // people have.
  const hrv = metrics.get("hrv");
  const rhr = metrics.get("resting_hr");
  const rec = hrv?.latest ? hrv : rhr;
  return [
    signalFrom(sleep, "sleep", "Sleep", null, true),
    signalFrom(act, "activity", "Activity", act?.metric.label ?? null, true),
    signalFrom(rec, "recovery", "Recovery", rec?.metric.label ?? null, rec?.metric.id === "hrv"),
  ];
}

// ── Labs ─────────────────────────────────────────────────────────────────────

export interface LabRow {
  metricId: string;
  label: string;
  value: number;
  unit: string;
  at: string;
  flag: RangeFlag;
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
  const panels: LabPanel[] = [];
  for (const panel of LAB_PANELS) {
    const rows: LabRow[] = [];
    for (const s of metrics.values()) {
      if (s.metric.panel !== panel || !s.latest) continue;
      rows.push({
        metricId: s.metric.id,
        label: s.metric.label,
        value: s.latest.value,
        unit: s.metric.unit,
        at: s.latest.at,
        flag: flagAgainstReference(s.metric, s.latest.value),
        reference: formatReference(s.metric),
        previous: s.previous?.value ?? null,
        trackerId: s.latest.trackerId,
        mergedFrom: s.sources.length,
      });
    }
    if (rows.length === 0) continue;
    // Out-of-range first, then alphabetical — the reason you opened the panel.
    rows.sort((a, b) => {
      const oa = a.flag === "normal" || a.flag === "unknown" ? 1 : 0;
      const ob = b.flag === "normal" || b.flag === "unknown" ? 1 : 0;
      return oa - ob || a.label.localeCompare(b.label);
    });
    panels.push({
      panel, label: PANEL_LABELS[panel], rows,
      outOfRange: rows.filter((r) => r.flag === "low" || r.flag === "high").length,
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
const REP_FIELD = /(reps?|sets?|count|quantity|amount)/i;

export interface WorkoutGroup {
  type: string;
  sessions: number;
  minutes: number | null;
  distance: number | null;
  reps: number | null;
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
    const shaped = (t.fields || []).some((f: any) => DISTANCE_FIELD.test(f?.name || "") || DURATION_FIELD.test(f?.name || ""));
    if (!ACTIVITY_NAME.test(hay) && !shaped) continue;
    let sessions = 0, minutes = 0, distance = 0, reps = 0;
    let sawMin = false, sawDist = false, sawReps = false;
    let lastAt: string | null = null;
    for (const e of t.entries || []) {
      const ts = e?.timestamp ? new Date(e.timestamp).getTime() : NaN;
      if (!Number.isFinite(ts) || ts < cutoff || ts > now + DAY) continue;
      sessions++;
      if (!lastAt || ts > new Date(lastAt).getTime()) lastAt = new Date(ts).toISOString();
      const computed: any = (e as any).computed || {};
      const cd = num(computed.durationMinutes);
      if (Number.isFinite(cd) && cd > 0) { minutes += cd; sawMin = true; }
      for (const [field, raw] of Object.entries(e.values || {})) {
        if (META_KEY.test(field)) continue;
        const v = num(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (DURATION_FIELD.test(field)) { minutes += v; sawMin = true; continue; }
        if (DISTANCE_FIELD.test(field)) { distance += v; sawDist = true; continue; }
        if (REP_FIELD.test(field)) { reps += v; sawReps = true; continue; }
      }
    }
    if (sessions === 0) continue;
    groups.push({
      type: t.name || "Activity", sessions,
      minutes: sawMin ? Math.round(minutes) : null,
      distance: sawDist ? Math.round(distance * 10) / 10 : null,
      reps: sawReps ? reps : null,
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

  const sleep = metrics.get("sleep_hours")?.latest?.value ?? null;
  parts.push({
    key: "sleep", label: "Sleep",
    score: sleep == null ? null : bandScore(sleep, 7, 9, 4),
    detail: sleep == null ? "No sleep source connected" : `${round1(sleep)} h last night`,
  });

  const steps = metrics.get("steps")?.latest?.value ?? null;
  const mins = metrics.get("exercise_minutes")?.latest?.value ?? null;
  const activityScore = steps != null ? Math.min(100, Math.round((steps / 8000) * 100))
    : mins != null ? Math.min(100, Math.round((mins / 30) * 100))
    : null;
  parts.push({
    key: "activity", label: "Activity",
    score: activityScore,
    detail: steps != null ? `${Math.round(steps).toLocaleString()} steps`
      : mins != null ? `${Math.round(mins)} active min`
      : "No activity source connected",
  });

  const hrv = metrics.get("hrv");
  const rhr = metrics.get("resting_hr");
  let recovery: number | null = null;
  let recoveryDetail = "No recovery source connected";
  if (hrv?.latest && hrv.avg30) {
    // HRV is meaningful only against your own baseline.
    const ratio = hrv.latest.value / hrv.avg30;
    recovery = Math.max(0, Math.min(100, Math.round(ratio * 80)));
    recoveryDetail = `HRV ${Math.round(hrv.latest.value)} ms vs ${Math.round(hrv.avg30)} ms avg`;
  } else if (rhr?.latest) {
    recovery = bandScore(rhr.latest.value, 40, 65, 30);
    recoveryDetail = `Resting HR ${Math.round(rhr.latest.value)} bpm`;
  }
  parts.push({ key: "recovery", label: "Recovery", score: recovery, detail: recoveryDetail });

  const live = parts.filter((p) => p.score != null);
  const totalWeight = live.reduce((a, p) => a + BASE_WEIGHTS[p.key], 0);
  const components: ScoreComponent[] = parts.map((p) => ({
    key: p.key, label: p.label, score: p.score, detail: p.detail,
    weight: p.score == null || totalWeight === 0 ? 0 : BASE_WEIGHTS[p.key] / totalWeight,
  }));
  const value = live.length === 0 ? null
    : Math.round(components.reduce((a, c) => a + (c.score ?? 0) * c.weight, 0));
  return { value, components };
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
    const deltaMin = Math.round((sleepWeek - sleep.avg30) * 60);
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

  const flagged = labs.flatMap((p) => p.rows.filter((r) => r.flag === "low" || r.flag === "high"));
  if (flagged.length > 0) {
    const first = flagged[0];
    const dir = first.flag === "high" ? "above" : "below";
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
}

export function sourceState(metrics: Map<string, MetricSeries>): SourceState {
  const has = (id: string) => !!metrics.get(id)?.latest;
  return {
    sleep: has("sleep_hours"),
    activity: has("steps") || has("exercise_minutes") || has("distance"),
    recovery: has("hrv") || has("resting_hr"),
    labs: [...metrics.values()].some((s) => LAB_PANELS.includes(s.metric.panel) && !!s.latest),
    body: has("weight") || has("bmi") || has("body_fat"),
  };
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
