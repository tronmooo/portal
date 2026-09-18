// Deterministic parsers for the chat "quick log" lanes — the handful of
// one-line health/fitness reports that are so common and so regular that a
// model round-trip is pure latency: "ran 2 miles", "I slept 7 hours",
// "weight 183", "bp 120/80".
//
// Pure and I/O-free so they are unit-testable (tests/quick-log.test.ts). The
// engine calls them from tryFastPath and hands the parsed values to the SAME
// log_tracker_entry executor the model uses — tracker ownership, enrichment,
// normalization, dedup and habit sync are therefore identical whether the log
// came from a regex lane or from the model. (2026-09-01 report: the old run
// lane wrote straight to storage against the FIRST tracker named "Running",
// which was Sarah's, so the user's own run never appeared in their history.)
//
// Every lane is ANCHORED: the whole message must be the report (plus an
// optional harmless time word). Anything else — "ran 2 miles with Sarah",
// "slept 7 hours but woke up twice" — falls through to the model, which can
// resolve the extra context. Accuracy beats a fast wrong write.

const LEAD = "^(?:i\\s+)?(?:just\\s+)?(?:also\\s+)?";
// Trailing words that carry no data the tracker would lose.
const TAIL = "\\s*(?:today|this\\s+morning|this\\s+afternoon|this\\s+evening|tonight|last\\s+night|earlier)?\\s*[.!]*\\s*$";

export interface QuickRun {
  values: Record<string, number>;
  /** Human distance as typed, for the reply: "2 mi" / "5 km". */
  label: string;
}

/**
 * "ran 2 miles", "I ran 3.1 mi in 28:30", "jogged 5 km", "ran 2 miles in 20 min".
 * Distance in km is passed as distanceKm so the estimation engine converts it.
 */
export function parseQuickRun(message: string): QuickRun | null {
  const m = String(message || "").trim().toLowerCase().match(new RegExp(
    LEAD +
      "(?:ran|run|jogged|jog)\\s+(?:a\\s+|for\\s+)?(\\d+(?:\\.\\d+)?)\\s*(mi(?:les?)?|km|kilometers?|k)?" +
      "(?:\\s+(?:in|for)\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?|\\d+(?:\\.\\d+)?\\s*(?:min(?:ute)?s?|h(?:ou)?rs?)))?" +
      TAIL,
  ));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0 || n > 200) return null;
  const unit = m[2] || "";
  const values: Record<string, number> = {};
  const isKm = /^(km|kilometers?|k)$/.test(unit);
  if (isKm) values.distanceKm = n; else values.distance = n;
  if (m[3]) {
    const minutes = parseDurationMinutes(m[3]);
    if (minutes && minutes > 0) values.duration = minutes;
  }
  return { values, label: `${n} ${isKm ? "km" : "mi"}` };
}

/** "25:00" → 25, "1:05:30" → 65.5, "20 min" → 20, "1.5 hours" → 90. */
export function parseDurationMinutes(raw: string): number | null {
  const s = String(raw || "").trim().toLowerCase();
  const clock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const a = parseInt(clock[1], 10), b = parseInt(clock[2], 10), c = clock[3] ? parseInt(clock[3], 10) : null;
    // h:mm:ss → hours/minutes/seconds; mm:ss → minutes/seconds.
    const minutes = c !== null ? a * 60 + b + c / 60 : a + b / 60;
    return Math.round(minutes * 100) / 100;
  }
  const units = s.match(/^(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ou)?rs?)$/);
  if (units) {
    const n = parseFloat(units[1]);
    return /^h/.test(units[2]) ? n * 60 : n;
  }
  return null;
}

/** "slept 7 hours", "I slept 6.5 hrs last night", "sleep 8". Hours as a NUMBER. */
export function parseQuickSleep(message: string): { hours: number } | null {
  const m = String(message || "").trim().toLowerCase().match(new RegExp(
    LEAD + "(?:slept|sleep)\\s+(?:for\\s+|about\\s+|around\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:hours?|hrs?|h)?" + TAIL,
  ));
  if (!m) return null;
  const hours = parseFloat(m[1]);
  if (!isFinite(hours) || hours <= 0 || hours > 24) return null;
  return { hours };
}

/**
 * "weight 183", "183 lbs", "I weigh 182.5", "weighed 180 pounds". A bare
 * number ("183") counts only when `allowBare` — the engine passes true only
 * when a weight tracker already exists, so a stray number can't create one.
 */
export function parseQuickWeight(message: string, opts: { allowBare?: boolean } = {}): { weight: number; explicit: boolean } | null {
  const s = String(message || "").trim().toLowerCase();
  const explicit = s.match(new RegExp(
    LEAD + "(?:weight\\s*(?:is|was|:)?|weighed|weigh|weighing|my\\s+weight\\s+(?:is|was))\\s+(\\d{2,3}(?:\\.\\d{1,2})?)\\s*(?:lbs?|pounds?)?" + TAIL,
  ));
  const bare = !explicit && opts.allowBare
    ? s.match(/^(\d{2,3}(?:\.\d{1,2})?)\s*(?:lbs?|pounds?)?\s*$/)
    : null;
  const m = explicit || bare;
  if (!m) return null;
  const weight = parseFloat(m[1]);
  if (!(weight > 80 && weight < 500)) return null;
  return { weight, explicit: !!explicit };
}

// ─── Deterministic turn recap ─────────────────────────────────────────────────
//
// When every tool call in a turn is a successful write and the message is fully
// covered, the model's second round-trip exists only to say "Logged it." That
// sentence is cheaper — and can't hallucinate — when the server writes it from
// the operation outcomes.

export interface RecapOp {
  status: "ok" | "failed" | "skipped" | "deduped";
  tool: string;
  /** Tracker / title / description the tool was asked for. */
  label: string;
  /** Compact input summary ("distance 2, duration 20"). */
  detail?: string;
  /** Estimation-engine note attached to a tracker entry result. */
  estimateNote?: string;
  createdTrackerName?: string;
  error?: string;
}

const TOOL_VERB: Record<string, string> = {
  log_tracker_entry: "Logged",
  log_medication_dose: "Logged",
  create_expense: "Added expense",
  log_income: "Logged income",
  create_task: "Added task",
  create_event: "Added event",
  create_reminder: "Set reminder",
  checkin_habit: "Checked in",
  journal_entry: "Journaled",
  create_note: "Saved note",
};

function humanEstimate(note: string | undefined): string {
  if (!note) return "";
  // The executor prefixes the note with an instruction to the model; the user
  // only needs the values.
  return note.replace(/^derived\/estimated[^:]*:\s*/i, "").trim();
}

/** Tools whose recap line is the record itself ("Weight 181.2 lbs"), not a verb. */
const TRACKER_TOOLS = new Set(["log_tracker_entry", "log_medication_dose"]);

/**
 * One line per operation; a single successful log reads as one sentence.
 *
 * Several operations render as a header and a Markdown bullet list — the
 * chat renders replies as Markdown, where a bare newline is a space, so
 * "Logged 3 of 3: ✅Logged: Weight — weight 181.2 ✅Logged: Sleep …" was
 * one run-on line (QA 2026-09-18 F-43). A tracker entry reads as its record
 * with the unit ("Weight 181.2 lbs" — see summarizeOpDetail), with no
 * "Logged:" prefix repeated on every line.
 */
export function buildTurnRecap(ops: RecapOp[]): string {
  const ok = ops.filter((o) => o.status === "ok");
  const deduped = ops.filter((o) => o.status === "deduped");
  const failed = ops.filter((o) => o.status === "failed" || o.status === "skipped");
  const created = ops.map((o) => o.createdTrackerName).filter((n): n is string => !!n);

  const record = (o: RecapOp) => {
    const est = humanEstimate(o.estimateNote);
    if (TRACKER_TOOLS.has(o.tool)) {
      return `${o.label}${o.detail ? ` ${o.detail}` : ""}${est ? ` (${est})` : ""}`;
    }
    const verb = TOOL_VERB[o.tool] || "Done";
    const detail = o.detail ? ` — ${o.detail}` : "";
    return `${verb}: ${o.label}${detail}${est ? ` (${est})` : ""}`;
  };

  const blocks: string[] = [];
  if (ok.length === 1 && ops.length === 1) {
    const o = ok[0];
    blocks.push(TRACKER_TOOLS.has(o.tool) ? `Logged ${record(o)}` : record(o));
  } else if (ok.length > 0) {
    // QA 2026-09-18 BUG-33: "Logged 2 of 2:" read as a score, not a
    // sentence. When everything landed, say how many things were logged;
    // "N of M" is kept only for the partial case, where the ratio is the
    // point.
    const header = ok.length === ops.length
      ? `Logged ${ok.length} item${ok.length === 1 ? "" : "s"}:`
      : `Logged ${ok.length} of ${ops.length}:`;
    blocks.push([header, ...ok.map((o) => `- ${record(o)}`)].join("\n"));
  }
  for (const o of deduped) blocks.push(`↩️ ${o.label} — already logged just now, kept the existing entry`);
  if (created.length > 0) {
    blocks.push(`Created ${created.length === 1 ? "a new tracker" : `${created.length} new trackers`}: ${Array.from(new Set(created)).join(", ")}.`);
  }
  for (const o of failed) blocks.push(`⚠️ ${o.label} — ${o.error || "didn't save"}`);
  return blocks.join("\n\n");
}
