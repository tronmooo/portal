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

/**
 * The asset page prints the summary text and nothing else, so its request is
 * the small one (owner, 2026-11-23: "everything is just taking way too long"):
 * a fast model, no highlight tiles or to-do list to write, and a trimmed
 * record. Measured on production the full request took 8–10 s.
 */
export const ASSET_SUMMARY_FAST_MODEL = "claude-haiku-4-5-20251001";
export const ASSET_SUMMARY_MAX_TOKENS = 400;
export const ASSET_SUMMARY_OUTPUT_RULE =
  'Only the `summary` text is shown for this record: return "actionItems": [] and "highlights": [] and put anything that needs attention in the summary itself.';

const lastN = <T,>(list: T[] | undefined, n: number): T[] => (Array.isArray(list) ? list.slice(-n) : []);

/** The record the asset summary is written from: the recent part of each list. */
export function slimAssetSummaryData(data: Record<string, any>): Record<string, any> {
  return {
    ...data,
    documents: lastN(data.documents, 8),
    expenses: lastN(data.expenses, 20),
    trackers: lastN(data.trackers, 4).map((t: any) => ({ ...t, entries: lastN(t?.entries, 5) })),
    tasks: lastN(data.tasks, 10),
    events: lastN(data.events, 10),
    obligations: lastN(data.obligations, 10),
    timeline: lastN(data.timeline, 8),
  };
}

/** The type prompt with the asset shape appended, for the types it applies to. */
export function withAssetSummaryShape(type: string | null | undefined, typePrompt: string): string {
  return ASSET_SUMMARY_TYPES.has(String(type ?? "")) ? `${typePrompt}\n\n${ASSET_SUMMARY_SHAPE}` : typePrompt;
}
