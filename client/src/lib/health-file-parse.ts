// client/src/lib/health-file-parse.ts
// =============================================================================
// Parse an Apple Health export (or a generic CSV) into daily health rows.
// =============================================================================
//
// This runs in the BROWSER, on purpose. An Apple Health `export.xml` routinely
// weighs 50-500 MB — orders of magnitude past the 10mb request-body cap, and
// far past what a 60s serverless function could chew through. So the file never
// leaves the device: we stream it, extract the handful of attributes we care
// about, bucket everything into daily aggregates, and upload only those. A
// decade of history collapses to a few hundred KB of totals.
//
// Everything here is written against an AsyncIterable<string> rather than a
// File, so the same code path is driven by File.stream() in the app and by a
// plain generator in tests — no DOM, no fixtures on disk.
// =============================================================================

import {
  HEALTHKIT_TYPE_MAP,
  HEALTHKIT_DIASTOLIC_TYPE,
  aggregateDaily,
  getHealthMetric,
  type HealthSample,
  type DailyRow,
} from "@shared/health-metrics";

// -----------------------------------------------------------------------------
// Apple's unit spellings
// -----------------------------------------------------------------------------
// HealthKit writes units in its own vocabulary ("degC", "fl_oz_us",
// "mmol<180.156>/L"). Translate to the spellings shared/health-metrics
// understands; anything unrecognised passes through and is treated as already
// canonical.
const APPLE_UNIT_ALIASES: Record<string, string> = {
  lb: "lbs",
  degc: "C",
  degf: "F",
  fl_oz_us: "oz",
  cal: "kcal",       // Apple writes dietary/active energy as "Cal" = kilocalories
  "count/min": "",
  count: "",
  "ml/min·kg": "",
  "ml/min*kg": "",
};

export function normalizeAppleUnit(unit: string | null | undefined): string {
  const raw = String(unit || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  // "mmol<180.1558800000541>/L" — the molar mass rides inside angle brackets.
  if (lower.startsWith("mmol<") || lower === "mmol/l") return "mmol/L";
  if (Object.prototype.hasOwnProperty.call(APPLE_UNIT_ALIASES, lower)) {
    return APPLE_UNIT_ALIASES[lower];
  }
  return raw;
}

// -----------------------------------------------------------------------------
// Record scanning
// -----------------------------------------------------------------------------

/** Matches one <Record …> element's opening tag. Attribute order varies. */
const RECORD_RE = /<Record\s+([^>]*?)\/?>/g;
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;

export function parseAttributes(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(fragment))) out[m[1]] = m[2];
  return out;
}

/**
 * The calendar day an Apple record belongs to.
 *
 * Apple writes local wall-clock plus offset ("2026-03-01 07:15:22 -0800"), so
 * the first 10 characters ARE the user's local date — no timezone maths needed,
 * and re-deriving one would actively introduce error.
 */
export function dayOf(dateAttr: string | undefined): string | null {
  if (!dateAttr) return null;
  const day = dateAttr.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Hours between two Apple timestamps, or 0 when either is unparseable. */
export function hoursBetween(start: string | undefined, end: string | undefined): number {
  if (!start || !end) return 0;
  const a = Date.parse(start.replace(" ", "T").replace(/\s([+-]\d{2})(\d{2})$/, "$1:$2"));
  const b = Date.parse(end.replace(" ", "T").replace(/\s([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / 3600000;
}

/** Sleep records count only when the value says the user was actually asleep —
 *  "InBed" and "Awake" would otherwise inflate the night by hours. */
export function isAsleepValue(value: string | undefined): boolean {
  return /asleep/i.test(String(value || ""));
}

export interface ParsedHealthFile {
  rows: DailyRow[];
  /** Records that mapped to a metric we model. */
  recordsUsed: number;
  /** Records skipped because we don't model that HealthKit type. */
  recordsIgnored: number;
}

interface ScanState {
  samples: HealthSample[];
  /** Diastolic readings by day — folded into the systolic sample at the end. */
  diastolicByDay: Map<string, number>;
  used: number;
  ignored: number;
}

function newState(): ScanState {
  return { samples: [], diastolicByDay: new Map(), used: 0, ignored: 0 };
}

/** Fold one <Record> element into the running scan state. */
export function consumeRecord(state: ScanState, attrs: Record<string, string>): void {
  const type = attrs.type;
  if (!type) return;

  if (type === HEALTHKIT_DIASTOLIC_TYPE) {
    const day = dayOf(attrs.startDate);
    const value = Number(attrs.value);
    if (day && Number.isFinite(value)) {
      state.diastolicByDay.set(day, value);
      state.used++;
    }
    return;
  }

  const metricId = HEALTHKIT_TYPE_MAP[type];
  if (!metricId) { state.ignored++; return; }

  const unit = normalizeAppleUnit(attrs.unit);

  // Sleep and mindfulness are category records: the payload is the interval,
  // not the `value` attribute.
  if (metricId === "sleep") {
    if (!isAsleepValue(attrs.value)) { state.ignored++; return; }
    // Bucket by the WAKE day — a night starting 23:40 Monday belongs to
    // Tuesday, which is both Apple's convention and how people describe it.
    const day = dayOf(attrs.endDate) || dayOf(attrs.startDate);
    const hours = hoursBetween(attrs.startDate, attrs.endDate);
    if (day && hours > 0) { state.samples.push({ metric: "sleep", day, value: hours }); state.used++; }
    else state.ignored++;
    return;
  }

  if (metricId === "mindful_minutes") {
    const day = dayOf(attrs.startDate);
    const minutes = hoursBetween(attrs.startDate, attrs.endDate) * 60;
    if (day && minutes > 0) { state.samples.push({ metric: "mindful_minutes", day, value: minutes }); state.used++; }
    else state.ignored++;
    return;
  }

  const day = dayOf(attrs.startDate);
  let value = Number(attrs.value);
  if (!day || !Number.isFinite(value)) { state.ignored++; return; }

  // SpO2 and body fat arrive as a 0-1 fraction on some OS versions and as a
  // percentage on others. A blood-oxygen reading of 0.97 is unambiguous.
  const def = getHealthMetric(metricId);
  if (def?.unit === "%" && value > 0 && value <= 1) value *= 100;

  state.samples.push({ metric: metricId, day, value, unit });
  state.used++;
}

/**
 * Stream an Apple Health export.xml and return daily rows.
 *
 * `chunks` yields decoded text of any size; records split across a chunk
 * boundary are held in a carry buffer until the rest arrives. Only the tail
 * after the last complete record is retained, so memory stays flat regardless
 * of file size.
 */
export async function parseAppleHealthXml(
  chunks: AsyncIterable<string>,
  onProgress?: (bytesRead: number) => void,
): Promise<ParsedHealthFile> {
  const state = newState();
  let carry = "";
  let bytesRead = 0;

  for await (const chunk of chunks) {
    bytesRead += chunk.length;
    const text = carry + chunk;
    let lastEnd = 0;
    RECORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RECORD_RE.exec(text))) {
      consumeRecord(state, parseAttributes(m[1]));
      lastEnd = RECORD_RE.lastIndex;
    }
    // Keep only what might be the start of a record we haven't finished
    // reading. Anything before the last complete match is done with.
    const tail = text.slice(lastEnd);
    const openIdx = tail.lastIndexOf("<Record");
    carry = openIdx === -1 ? tail.slice(-16) : tail.slice(openIdx);
    onProgress?.(bytesRead);
  }

  return finalize(state);
}

function finalize(state: ScanState): ParsedHealthFile {
  // Attach diastolic to the matching systolic sample so blood pressure lands as
  // one two-valued entry rather than two half-readings.
  for (const s of state.samples) {
    if (s.metric === "blood_pressure") {
      const dia = state.diastolicByDay.get(s.day);
      if (dia != null) s.value2 = dia;
    }
  }
  return {
    rows: aggregateDaily(state.samples),
    recordsUsed: state.used,
    recordsIgnored: state.ignored,
  };
}

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
export function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse a generic CSV export from any other health app.
 *
 * Long form:  date,metric,value[,unit]
 * Wide form:  date,steps,heart_rate,sleep,…   (one column per registry metric)
 *
 * The header decides which; anything whose column name isn't a registry metric
 * id is ignored rather than guessed at.
 */
export function parseHealthCsv(text: string): ParsedHealthFile {
  const state = newState();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return finalize(state);

  const header = parseCsvRow(lines[0]).map((h) => h.toLowerCase());
  const dateIdx = header.findIndex((h) => h === "date" || h === "day");
  if (dateIdx === -1) return finalize(state);

  const metricIdx = header.findIndex((h) => h === "metric");
  const valueIdx = header.findIndex((h) => h === "value");
  const unitIdx = header.findIndex((h) => h === "unit");
  const isLongForm = metricIdx !== -1 && valueIdx !== -1;

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i]);
    const day = dayOf(cells[dateIdx]);
    if (!day) { state.ignored++; continue; }

    if (isLongForm) {
      const metricId = cells[metricIdx];
      const value = Number(cells[valueIdx]);
      if (!getHealthMetric(metricId) || !Number.isFinite(value)) { state.ignored++; continue; }
      state.samples.push({ metric: metricId, day, value, unit: unitIdx === -1 ? "" : cells[unitIdx] });
      state.used++;
      continue;
    }

    for (let c = 0; c < header.length; c++) {
      if (c === dateIdx) continue;
      const metricId = header[c];
      if (!getHealthMetric(metricId)) continue;
      const value = Number(cells[c]);
      if (!Number.isFinite(value) || cells[c] === "") continue;
      state.samples.push({ metric: metricId, day, value });
      state.used++;
    }
  }

  return finalize(state);
}

// -----------------------------------------------------------------------------
// Browser entry point
// -----------------------------------------------------------------------------

/** Adapt a File into the AsyncIterable<string> the parsers consume. */
async function* streamText(file: Blob): AsyncGenerator<string> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export type UnsupportedReason = "zip" | "unknown";

export class UnsupportedHealthFile extends Error {
  reason: UnsupportedReason;
  constructor(reason: UnsupportedReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "UnsupportedHealthFile";
  }
}

/**
 * Parse a user-selected health file.
 *
 * `.zip` is rejected with an actionable message rather than a parse error: no
 * zip reader is bundled (DecompressionStream handles gzip/deflate, but a zip is
 * a container format it cannot open), so the honest answer is to ask for the
 * `export.xml` inside.
 */
export async function parseHealthFile(
  file: File,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
): Promise<ParsedHealthFile> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".zip")) {
    throw new UnsupportedHealthFile(
      "zip",
      "Unzip the export first, then choose the export.xml file inside it.",
    );
  }
  if (name.endsWith(".csv")) {
    return parseHealthCsv(await file.text());
  }
  if (name.endsWith(".xml")) {
    return parseAppleHealthXml(streamText(file), (read) => onProgress?.(read, file.size));
  }
  throw new UnsupportedHealthFile(
    "unknown",
    "Choose an export.xml from Apple Health, or a CSV with a date column.",
  );
}
