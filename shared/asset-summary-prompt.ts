// The shape of an owned thing's AI summary (owner, 2026-11-23: "too much …
// redundancy"; the mock-up's three sentences). Appended to the type prompt for
// assets, vehicles, properties and investments in GET /api/profiles/:id/ai-summary.
// The page shows the summary text alone, so what needs attention goes IN it.

export const ASSET_SUMMARY_TYPES = new Set(["asset", "vehicle", "property", "investment"]);

export const ASSET_SUMMARY_SHAPE = [
  "Write the `summary` as AT MOST three short sentences, in this order:",
  "(1) what it is estimated to be worth now;",
  "(2) how that compares with the recorded purchase price — only when a purchase price is on file, otherwise leave this sentence out;",
  "(3) the one or two things that need attention next (a date coming up, something missing) — or leave it out when nothing does.",
  "Do not list its characteristics, do not restate the fields, no preamble, no closing remark.",
].join(" ");

/** The type prompt with the asset shape appended, for the types it applies to. */
export function withAssetSummaryShape(type: string | null | undefined, typePrompt: string): string {
  return ASSET_SUMMARY_TYPES.has(String(type ?? "")) ? `${typePrompt}\n\n${ASSET_SUMMARY_SHAPE}` : typePrompt;
}
