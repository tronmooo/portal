// shared/domain/format.ts — the formatting layer every internal value passes
// through before a person sees it.
//
// `home_insurance_declarations` rendered as a chip, a parking-ticket due date
// showed as `2026-09-25`, and nothing scrubbed a UUID out of an assistant
// reply. Three humanizers existed (field-label, field-display, a page-local
// `prettify`). This module is the one door: labels, enum values, dates in
// the user's preferred format, and an id scrubber for prose.
//
// Pure. Pinned by tests/consistency-layer-format.test.ts.

import { humanizeFieldName, humanizeEnumValue } from "../field-label";

/** "home_insurance_declarations" → "Home Insurance Declarations". */
export function humanizeLabel(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // Known enum values keep their curated label ("Estimated by Portol").
  const curated = humanizeEnumValue(s);
  const derived = humanizeFieldName(s);
  // humanizeEnumValue sentence-cases unknown tokens; prefer the title-cased
  // derivation unless the value was in the curated table.
  return curated.toLowerCase() === derived.toLowerCase() ? derived : curated;
}

export type DateFormatPreference = "MDY" | "DMY" | "YMD" | "long";

export const DEFAULT_DATE_FORMAT: DateFormatPreference = "long";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-25" → "Sep 25, 2026" (long) · "09/25/2026" (MDY) · "25/09/2026" (DMY) · "2026-09-25" (YMD). */
export function formatUserDate(value: unknown, pref: DateFormatPreference = DEFAULT_DATE_FORMAT): string {
  const m = DAY_RE.exec(String(value ?? ""));
  if (!m) return value == null ? "" : String(value);
  const [y, mo, d] = [m[1], m[2], m[3]];
  switch (pref) {
    case "MDY": return `${mo}/${d}/${y}`;
    case "DMY": return `${d}/${mo}/${y}`;
    case "YMD": return `${y}-${mo}-${d}`;
    default: return `${MONTHS_SHORT[Number(mo) - 1] ?? mo} ${Number(d)}, ${y}`;
  }
}

/** A value that came from storage, rendered for a person. */
export function formatFieldValue(key: unknown, value: unknown, pref: DateFormatPreference = DEFAULT_DATE_FORMAT): string {
  if (value == null || value === "") return "";
  const k = String(key ?? "");
  if (/(date|asof|as_of|expir|due|birthday|dob)$/i.test(k) || DAY_RE.test(String(value))) {
    if (DAY_RE.test(String(value))) return formatUserDate(value, pref);
  }
  if (typeof value === "string" && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value)) return humanizeLabel(value);
  return String(value);
}

// ─── Internal identifiers ───────────────────────────────────────────────────

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ID_TOKEN_RE = /\b(?:id|ID|Id)\s*[:=]\s*[0-9a-f-]{8,}\b/g;
const HASH_TAG_RE = /\bsha(?:1|256|512):[0-9a-f]{6,}\b/gi;
const BRACKET_ID_RE = /\s*\[id:[^\]]*\]/g;
const PAREN_ID_RE = /\s*\((?:id|ID):\s*[0-9a-f-]{6,}\)/g;

/** True when the text carries something that reads as a database id. */
export function containsInternalId(text: unknown): boolean {
  const s = String(text ?? "");
  return UUID_RE.test(s) || ID_TOKEN_RE.test(s) || HASH_TAG_RE.test(s) || BRACKET_ID_RE.test(s) || PAREN_ID_RE.test(s);
}

/** Remove database ids from prose meant for a person. */
export function stripInternalIds(text: unknown): string {
  return String(text ?? "")
    .replace(BRACKET_ID_RE, "")
    .replace(PAREN_ID_RE, "")
    .replace(ID_TOKEN_RE, "")
    .replace(HASH_TAG_RE, "")
    .replace(UUID_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:])/g, "$1")
    .trim();
}

/** True when a string is itself an id rather than a name. */
export function looksLikeInternalId(value: unknown): boolean {
  const s = String(value ?? "").trim();
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[a-z0-9]{20,}$/i.test(s) || /^sha(1|256|512):/i.test(s);
}

/** A display name for a record: its name, never its id. */
export function displayName(record: { name?: unknown; title?: unknown; description?: unknown; id?: unknown } | null | undefined, fallback = "Untitled"): string {
  for (const v of [record?.name, record?.title, record?.description]) {
    const s = String(v ?? "").trim();
    if (s && !looksLikeInternalId(s)) return s;
  }
  return fallback;
}

// ─── Assistant reply polish ─────────────────────────────────────────────────

const FILLER_SENTENCE = /^(?:(?:okay|ok|sure|alright|got it|certainly|of course)[,!.]?\s*)?(?:let me|i'?ll|i will|i am going to|i'm going to|one moment|just a moment|hold on|give me a (?:second|moment|sec))\b[^.!?…\n]*(?:look(?:ing)? (?:that|this|it) up|check(?:ing)?|pull(?:ing)?|fetch(?:ing)?|find(?:ing)?|search(?:ing)?|retriev(?:e|ing)|gather(?:ing)?|simultaneously|now|first)[^.!?…\n]*[.!?…]?\s*/i;

/** Drop "Let me look that up simultaneously." and friends from the front of a reply. */
export function stripFillerPreamble(text: unknown): string {
  let s = String(text ?? "");
  for (let i = 0; i < 3; i++) {
    const next = s.replace(FILLER_SENTENCE, "");
    if (next === s) break;
    s = next.trimStart();
  }
  return s;
}

/** The one door an assistant reply passes through before a person reads it. */
export function polishAssistantReply(text: unknown): string {
  return stripInternalIds(stripFillerPreamble(text));
}
