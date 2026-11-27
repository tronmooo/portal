// The tracker the person asked for BY NAME.
//
// Owner, 2026-11-27: "The user's explicit instruction takes priority. If the
// user requests a new tracker with a specific name, create that tracker. If
// the user simply logs an activity, use the appropriate existing tracker.
// Never confirm that a tracker was created under a particular name unless
// that tracker actually exists."
//
// Before: "Log to a new tracker called 'Jog QQ7Z': I ran 1.25 miles" went into
// the existing Running tracker (one canonical tracker per activity) and the
// reply read "Logged Jog QQ7Z running…" — a tracker that did not exist.
//
// This only answers "did the message name a NEW tracker, and what is it
// called". "I ran 2 miles" names none, so the activity's own tracker is used
// exactly as before.

const QUOTED = /["“”'‘’`]/;
const VERB = "(?:new|another|separate|create|start|make|add|set\\s+up|begin)";

/** The name of the new tracker the message asks for, or null. */
export function explicitNewTrackerName(message: unknown): string | null {
  const text = String(message ?? "");
  if (!/tracker/i.test(text)) return null;
  // "… a new tracker called "X" …" / "create a tracker named X: …"
  const called = new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,40}?\\btracker\\b\\s*(?:that\\s+is\\s+|that'?s\\s+)?(?:called|named|titled|labell?ed)\\s+(.+)`, "i").exec(text);
  // "create a "X" tracker" / "start a new X tracker" (quoted names only: the
  // bare form is how people say "start a sleep tracker", which names a kind)
  const quotedBefore = new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,24}?(["“'‘\`])([^"”'’\`\\n]{1,60})["”'’\`]\\s+tracker\\b`, "i").exec(text);
  let raw: string | null = null;
  if (called) {
    const rest = called[1].trim();
    if (QUOTED.test(rest[0] ?? "")) {
      const m = /^["“'‘`]([^"”'’`\n]{1,60})["”'’`]/.exec(rest);
      raw = m ? m[1] : null;
    } else {
      // unquoted: up to the first clause break
      raw = rest.split(/\s*(?:[:;,.!?\n]|\s+(?:and|that|which|to|for|with|then|so)\s+)/i)[0] ?? null;
    }
  } else if (quotedBefore) {
    raw = quotedBefore[2];
  }
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 60) return null;
  if (/^(it|this|that|one|something|anything)$/i.test(name)) return null;
  return name;
}

const fold = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Is `name` the tracker the person named (case, quotes and punctuation aside)? */
export function isTheNamedTracker(name: unknown, asked: string | null): boolean {
  return !!asked && fold(name) !== "" && fold(name) === fold(asked);
}
