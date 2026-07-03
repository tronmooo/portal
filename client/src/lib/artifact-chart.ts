// Chart-spec detection for artifacts.
//
// PERF-AUDIT (2026-07-03): some artifacts store a chart spec as their `content`
// (raw JSON like `{"type":"line","title":"Weight Trend","data":[...]}`) even
// when their `type` is "note". Those used to render as raw JSON text. This
// helper detects a chart spec so the renderer can draw an actual chart instead.

export const CHART_SPEC_TYPES = ["bar", "line", "area", "pie"] as const;
export type ChartSpecType = (typeof CHART_SPEC_TYPES)[number];

export interface ParsedChartSpec {
  type: ChartSpecType;
  title?: string;
  data?: any[];
  series?: any[];
  [k: string]: any;
}

/**
 * Parse `content` as a chart spec, or return null if it isn't one.
 *
 * Strict on purpose — requires a recognized chart `type` AND a `data`/`series`
 * array — so ordinary JSON notes (or plain text) are left alone and keep
 * rendering as text.
 */
export function parseChartSpec(content: string | undefined | null): ParsedChartSpec | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // not JSON — treat as plain content
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as any).type === "string" &&
    (CHART_SPEC_TYPES as readonly string[]).includes((parsed as any).type) &&
    (Array.isArray((parsed as any).data) || Array.isArray((parsed as any).series))
  ) {
    return parsed as ParsedChartSpec;
  }
  return null;
}
