// The AI Builder behind the Wellness tab's "describe a widget" box
// (owner request 2026-11-23).
//
// A sentence — "my weekly sleep average", "whether I exercise more after
// sleeping eight hours", "what I spend on healthcare" — becomes a widget
// description (shared/wellness-widgets). The model only CHOOSES among the
// sources, calculations and displays the tab can draw: its answer is held to
// `sanitizeWellnessWidget`, so it cannot emit a query, a formula or markup,
// and it cannot reach a record the widget sources do not already read.
//
// The model is told what the user HAS (tracker names, which measurements have
// data) but never the readings themselves: no health value leaves the server
// to build a widget.
//
// The builder always answers: no key, a slow model or an answer that does not
// validate falls back to the fixed rules (`inferWellnessWidgetFromText`). It
// writes nothing — the widget is saved only when the user presses Save.
import { getAnthropicClient } from "./anthropic-client";
import { extractJsonObject } from "./exec-widget-builder";
import {
  WELLNESS_CALCS, WELLNESS_DISPLAYS, WELLNESS_WIDGET_ICONS, inferWellnessWidgetFromText, sanitizeWellnessWidget,
  type WellnessWidget,
} from "@shared/wellness-widgets";
import { WELLNESS_RANGES } from "@shared/wellness-period";
import { CANONICAL_METRICS } from "@shared/wellness-canon";

const BUDGET_MS = 8_000;

export interface WellnessBuildContext {
  /** Names of the user's trackers, so a source can name a real one. */
  trackerNames?: string[];
  /** Canonical metric ids that have at least one reading. */
  metricIds?: string[];
}

export interface WellnessBuildResult {
  widget: WellnessWidget;
  /** Who read the sentence: the model, or the fixed rules. */
  by: "ai" | "rules";
}

export async function buildWellnessWidgetFromPrompt(prompt: string, ctx: WellnessBuildContext = {}, id = "widget"): Promise<WellnessBuildResult> {
  const said = String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const byRules = (): WellnessBuildResult => ({ widget: inferWellnessWidgetFromText(said, { trackerNames: ctx.trackerNames }, id), by: "rules" });
  if (said.length < 3 || !process.env.ANTHROPIC_API_KEY) return byRules();
  try {
    const list = (xs: string[] | undefined) => (xs && xs.length ? xs.slice(0, 60).join(", ") : "(none)");
    const metrics = CANONICAL_METRICS.map((m) => `${m.id} (${m.label})`).join(", ");
    const source =
      `{"kind":"metric","key":<metric id>} | {"kind":"tracker","key":<tracker name>,"field":<optional number field>} | ` +
      `{"kind":"workouts","key":<optional word the workout's name contains>} | {"kind":"mood"} | {"kind":"spending","key":<optional word>}`;
    const call = getAnthropicClient("standard").messages.create({
      model: process.env.ANTHROPIC_TITLE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content:
          `A user wants a card on their personal health dashboard. Turn the request into ONE JSON object and reply with the JSON only.\n\n` +
          `A SOURCE is one of: ${source}.\n` +
          `Metric ids: ${metrics}.\n\n` +
          `Pick ONE kind of card:\n` +
          `1. {"kind":"metric","title","icon","source":SOURCE,"calc":one of ${WELLNESS_CALCS.join("|")},"display":one of ${WELLNESS_DISPLAYS.join("|")}} — one series, one calculation.\n` +
          `2. {"kind":"compare","title","icon","source":SOURCE (the condition the days are grouped by),"other":SOURCE (what is compared),"threshold":optional number for the condition,"lag":0 same day or 1 the day after} — e.g. "do I exercise more after sleeping 8 hours" = source sleep_hours, threshold 8, other workouts.\n` +
          `3. {"kind":"score","title","icon","parts":[{"source":SOURCE,"weight":1-10,"target":number that earns full marks per day,"better":"higher"|"lower"}]} — a weighted score.\n\n` +
          `"title": 2-4 words, Title Case, in the user's language. "icon": one of ${WELLNESS_WIDGET_ICONS.join(", ")}.\n` +
          `Optional "range": one of ${WELLNESS_RANGES.join("|")} — only when the request names a period.\n` +
          `Use "count" for how often something was logged, "total" for sums (water, spending), "average" for readings.\n\n` +
          `What this user has — trackers: ${list(ctx.trackerNames)}. Measurements with data: ${list(ctx.metricIds)}.\n` +
          `Prefer a metric id over a tracker when the request is about that measurement. Name a tracker exactly as listed.\n\n` +
          `Request: ${said}`,
      }],
    });
    const response: any = await Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error("widget build timeout")), BUDGET_MS)),
    ]);
    const block = response?.content?.find?.((b: any) => b?.type === "text");
    const widget = sanitizeWellnessWidget({ ...(extractJsonObject(block?.text) || {}), id, by: "ai" }, id);
    return widget ? { widget, by: "ai" } : byRules();
  } catch {
    return byRules();
  }
}
