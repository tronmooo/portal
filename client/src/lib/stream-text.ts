// What a live (still streaming) chat reply may show.
//
// Tokens arrive mid-word: "$2,155/" and then "mo". Rendering each flush as it
// stood put a half-written figure on screen for a moment — a monthly payment
// that read "$2,155/" (2026-11-18). A number the user is checking must never
// be shown half-typed, so the live bubble holds the trailing, still-growing
// word back until whitespace closes it. The final message is the server's
// full text and is never passed through this.

/** The streamed text up to (and including) the last whitespace — whole words only. */
export function stableStreamText(text: string): string {
  const s = String(text ?? "");
  let i = s.length;
  while (i > 0 && !/\s/.test(s[i - 1])) i--;
  return s.slice(0, i);
}
