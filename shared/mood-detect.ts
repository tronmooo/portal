// Mood auto-detection from journal text — pure, keyword-based, no I/O.
// Single source of truth for chat's journal fast-path, the journal page's
// free-write composer, and the POST /api/journal fallback, so a passage like
// "I'm really pissed off today" is stamped with the same mood everywhere.
// Pinned by tests/mood-detect.test.ts.
import type { MoodLevel } from "./schema";

// Ordered strongest-negative → strongest-positive; first match wins within
// each band, and negative bands are checked before positive ones so mixed
// passages ("great... until everything went horribly wrong") lean on the
// stronger negative signal.
const RULES: Array<{ mood: MoodLevel; re: RegExp }> = [
  { mood: "terrible", re: /\b(terrible|miserable|worst|devastat|hopeless|unbearable)\w*/i },
  { mood: "awful", re: /\b(awful|horrible|dreadful|depress|crying|cried|heartbroken|grie(f|ving)|panic)\w*/i },
  { mood: "bad", re: /\b(bad|rough|sore|tired|exhaust|down|upset|stress|pissed|angry|furious|frustrat|annoy|irritat|anxious|worried|overwhelm|mad|sad|lonely|sick)\w*/i },
  { mood: "amazing", re: /\b(amazing|incredible|fantastic|best day|phenomenal|euphoric|ecstatic)\w*/i },
  { mood: "great", re: /\b(great|wonderful|excellent|energized|motivated|awesome|thrilled|excited|proud|grateful|blessed)\w*/i },
  { mood: "good", re: /\b(good|fine|nice|happy|pleasant|calm|peaceful|relaxed|content)\w*/i },
  { mood: "okay", re: /\b(okay|ok|alright|decent|meh|so-so)\b/i },
];

/** Detect a mood from free text. Returns "neutral" when nothing matches. */
export function detectMoodFromText(text: string): MoodLevel {
  const t = String(text || "");
  if (!t.trim()) return "neutral";
  for (const { mood, re } of RULES) {
    if (re.test(t)) return mood;
  }
  return "neutral";
}
