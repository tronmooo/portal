// shared/distribution.ts — who gets how much of a shared quantity?
//
// "Sarah and I each ran 3 miles", "we both took our vitamins", "together we
// drove 400 miles", "Bob and Jane ran 2 and 3 miles respectively" — the words
// each / both / all / together / total / respectively change how one stated
// quantity is assigned across several subjects, and getting them wrong either
// drops a person's record or doubles a shared amount.
//
// Like the referent resolver, this module reads the sentence DETERMINISTICALLY,
// before the model sees the turn, and hands the model its reading as a
// [DISTRIBUTION] line appended to the user turn (never the system prompt —
// that block is prompt-cached and must stay byte-identical across turns).
//
// Deliberately conservative. It emits a reading only when:
//   · a sentence coordinates two or more subjects ("Sarah and I", "Bob, Jane
//     and Max") or uses "we each/both/all", AND
//   · the distribution word's arithmetic is unambiguous (one shared value for
//     each/both/all, exactly N values for N subjects with "respectively").
// Anything else returns nothing and the model's ordinary judgement stands —
// a hint the router only half understood is worse than no hint.
//
// Pure, no I/O. Pinned by tests/distribution.test.ts.

export type DistributionShape = "each" | "shared_total" | "respective";

export interface DistributionReading {
  shape: DistributionShape;
  /**
   * Subjects as written, in order. "I"/"me" is normalized to "the user";
   * a bare "we" (membership unknown) is kept as "we".
   */
  subjects: string[];
  /** For "each" and "shared_total": the single stated quantity ("3 miles"). */
  value?: string;
  /** For "respective": values[i] belongs to subjects[i]. */
  values?: string[];
  /** The sentence the reading came from, for the directive text. */
  source: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

// A quantity: "$20", "2.5", "3,100", or a small number word — optionally
// followed by a unit word ("miles", "oz", "%"). Function words never count as
// a unit, so "2 and 3 miles" yields "2" and "3 miles" and "$60 in total"
// yields "$60", not "$60 in".
const NON_UNIT_WORDS = "and|or|respectively|each|both|all|in|on|at|of|for|to|with|from|by|per|the|a|an|total|combined|apiece|yesterday|today|tomorrow";
const QTY_CORE = String.raw`\d(?:[\d,]*\d)?(?:\.\d+)?|${Object.keys(NUMBER_WORDS).join("|")}`;
// The "$" sits outside the \b — a word boundary can't precede a symbol.
const QTY_RE = new RegExp(
  String.raw`(\$\s*)?\b(${QTY_CORE})(?:\s+(?!(?:${NON_UNIT_WORDS})\b)([\p{L}%]+))?`,
  "giu",
);

// A coordinated subject list: "Sarah and I", "Bob, Jane and Max", "me & Sarah".
// Items are "I"/"me" or capitalized names (one or two words), so mid-sentence
// lowercase nouns ("mac and cheese") never read as subjects. Capitalized
// sentence-lead words that are grammar rather than names ("Together Sarah and
// I…") are excluded so they don't glue onto the first name.
const NON_NAME_WORDS = "Together|Both|All|Each|We|They|And|Then|Also|But|So|Or|Yesterday|Today|Tomorrow|Last|Next|This|That|Remind|Log|Add|Create|Make|Have|Had";
const CAPWORD = String.raw`(?!(?:${NON_NAME_WORDS})\b)[A-Z][\p{L}'’.-]*`;
const ITEM = String.raw`(?:I|me|${CAPWORD}(?:\s+${CAPWORD})?)`;
const SUBJECT_LIST_RE = new RegExp(
  String.raw`\b(${ITEM}(?:\s*,\s*${ITEM})*\s*,?\s*(?:and|&)\s+${ITEM})\b`,
  "u",
);

const NEGATION_RE = /\b(?:didn'?t|don'?t|doesn'?t|never|haven'?t|hasn'?t|won'?t|not)\b/i;
const SHARED_RE = /\b(?:together|combined|in total|a total of|total of|between (?:us|them)|split)\b/i;
const EACH_RE = /\b(?:each|apiece|per person)\b/i;
const BOTH_ALL_RE = /\b(?:both|all)\b/i;

function normalizeSubject(raw: string): string {
  const t = raw.trim();
  return /^(i|me)$/i.test(t) ? "the user" : t;
}

function splitSubjects(list: string): string[] {
  return list
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeSubject);
}

function quantities(sentence: string): string[] {
  const out: string[] = [];
  QTY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QTY_RE.exec(sentence)) !== null) {
    const amount = `${m[1] ? "$" : ""}${m[2]}`;
    out.push([amount, m[3]].filter(Boolean).join(" ").trim());
  }
  return out;
}

/**
 * Read the distribution shapes in a message, one reading per sentence at most.
 * Questions and negated sentences never produce a reading — "did Sarah and I
 * both run?" is a query and "Sarah and I didn't run" logs nothing.
 */
export function readDistribution(message: string): DistributionReading[] {
  const text = String(message || "");
  if (!text.trim()) return [];
  const readings: DistributionReading[] = [];

  // Keep the trailing delimiter so questions stay recognizable per-sentence.
  const sentences = text.split(/(?<=[.!?;])\s+/);
  for (const sentence of sentences) {
    if (!sentence.trim() || sentence.trim().endsWith("?")) continue;
    if (NEGATION_RE.test(sentence)) continue;

    const listMatch = sentence.match(SUBJECT_LIST_RE);
    // "we each ran…" / "together we spent…": the group's membership is
    // opaque, but the distribution semantics are not.
    const weGroup = !listMatch
      && (/\bwe\s+(?:each|both|all)\b/i.test(sentence)
        || (/\bwe\b/i.test(sentence) && SHARED_RE.test(sentence)));
    if (!listMatch && !weGroup) continue;
    const subjects = listMatch ? splitSubjects(listMatch[1]) : ["we"];
    if (listMatch && subjects.length < 2) continue;

    const qtys = quantities(sentence);

    if (/\brespectively\b/i.test(sentence)) {
      // Ordered pairing needs exactly one value per subject; anything else is
      // ambiguous and the model should ask, not this module guess.
      if (listMatch && qtys.length === subjects.length && qtys.length >= 2) {
        readings.push({ shape: "respective", subjects, values: qtys, source: sentence.trim() });
      }
      continue;
    }

    if (SHARED_RE.test(sentence)) {
      if (qtys.length === 1) {
        readings.push({ shape: "shared_total", subjects, value: qtys[0], source: sentence.trim() });
      }
      continue;
    }

    if (EACH_RE.test(sentence) || BOTH_ALL_RE.test(sentence)) {
      // "each"/"both"/"all" with one stated value: that value applies to every
      // subject. More than one value in the sentence → too ambiguous to hint.
      if (qtys.length === 1) {
        readings.push({ shape: "each", subjects, value: qtys[0], source: sentence.trim() });
      }
      continue;
    }
  }
  return readings;
}

function subjectPhrase(subjects: string[]): string {
  return subjects.join(", ");
}

/**
 * The [DISTRIBUTION] line(s) appended to the user turn. Written as an
 * instruction because the two failure modes it prevents — collapsing two
 * people's identical logs into one, and multiplying a shared total across
 * everyone — both look reasonable to a model that only has the raw sentence.
 */
export function buildDistributionDirective(readings: DistributionReading[]): string | null {
  if (!readings || readings.length === 0) return null;
  const lines = readings.map((r) => {
    if (r.shape === "respective") {
      const pairs = r.subjects.map((s, i) => `${s} = ${r.values?.[i]}`).join(", ");
      return `[DISTRIBUTION] "respectively" pairs values to subjects IN ORDER: ${pairs}. `
        + `Emit one write per pairing, each with its own value and its own forProfile `
        + `(omit forProfile for the user themself). Do NOT swap the order or give any subject another subject's value.`;
    }
    if (r.shape === "shared_total") {
      return `[DISTRIBUTION] The quantity (${r.value}) is a SHARED TOTAL across ${subjectPhrase(r.subjects)}, `
        + `NOT a per-person amount. Do NOT log the full ${r.value} once per subject — that double-counts it. `
        + `If the user said how it splits, use that; otherwise record it ONCE (attributed to the user, noting it was shared) `
        + `or ask one short question if the split genuinely matters.`;
    }
    const who = r.subjects.length === 1 && r.subjects[0] === "we"
      ? `every person included in "we"`
      : subjectPhrase(r.subjects);
    return `[DISTRIBUTION] The quantity (${r.value}) applies PER SUBJECT: ${who}. `
      + `Emit one write per subject with the SAME value — ${r.subjects.length === 1 ? "one call per person" : `${r.subjects.length} subjects = ${r.subjects.length} tool calls`}, `
      + `each with its own forProfile (omit forProfile for the user themself). `
      + `Do NOT merge them into one entry, and do NOT skip one as a duplicate — same value, different owner is two records.`;
  });
  return lines.join("\n");
}
