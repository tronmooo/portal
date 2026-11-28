// "No AI provider is configured" is a state, not a server fault.
//
// Every AI call goes through getAnthropicClient (server/anthropic-client.ts),
// which throws when ANTHROPIC_API_KEY is unset. A route that let that reach its
// generic catch answered 500 — on an environment without the key (the isolated
// test stack, a developer machine) every dashboard visit logged a server error
// for the briefing, and a monitor could not tell "no AI here" from a crash
// (integrity run, 2026-11-28). A route answers 503 AI_UNAVAILABLE instead,
// marked with X-AI-Unavailable so a page shows nothing rather than an error.
export const AI_UNAVAILABLE_HEADER = "X-AI-Unavailable";

export function isAiUnavailableError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return /ANTHROPIC_API_KEY environment variable is not set/.test(msg);
}

/** Answers 503 when `err` means no AI provider; returns whether it did. */
export function answeredAiUnavailable(err: unknown, res: { headersSent?: boolean; setHeader: (k: string, v: string) => unknown; status: (n: number) => { json: (b: unknown) => unknown } }): boolean {
  if (!isAiUnavailableError(err) || res.headersSent) return false;
  res.setHeader(AI_UNAVAILABLE_HEADER, "1");
  res.status(503).json({ error: "AI is not available in this environment", code: "AI_UNAVAILABLE" });
  return true;
}
