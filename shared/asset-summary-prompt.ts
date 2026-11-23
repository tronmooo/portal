// The shape of an owned thing's AI summary (owner, 2026-11-23: "too much …
// redundancy"; "the AI summary should show when's a good time to get
// rid of it"). Appended to the type prompt for
// assets, vehicles, properties and investments in GET /api/profiles/:id/ai-summary.
// The page shows the summary text alone, so what needs attention goes IN it.

export const ASSET_SUMMARY_TYPES = new Set(["asset", "vehicle", "property", "investment"]);

export const ASSET_SUMMARY_SHAPE = [
  "Write the `summary` as AT MOST three short sentences, in this order:",
  "(1) what it is estimated to be worth now;",
  "(2) how much it has depreciated (or gained) against the recorded purchase price — only when a purchase price is on file, otherwise leave this sentence out;",
  "(3) when it would make sense to sell, trade in or replace it: a specific time frame with the reason, drawn from the data (its age, how fast it is losing value, a warranty ending or a major cost coming up, its salvage value when one is on file). If there is not enough on file to say when, name the one fact that would let you.",
  "Do not list its characteristics, do not restate the fields, no preamble, no closing remark. This is guidance from the record, not a professional appraisal — do not claim certainty.",
].join(" ");

/** The type prompt with the asset shape appended, for the types it applies to. */
export function withAssetSummaryShape(type: string | null | undefined, typePrompt: string): string {
  return ASSET_SUMMARY_TYPES.has(String(type ?? "")) ? `${typePrompt}\n\n${ASSET_SUMMARY_SHAPE}` : typePrompt;
}
