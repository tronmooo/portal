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
// The model is told what the user ACTUALLY TRACKS — each tracker's name, its
// number fields with their units and how many entries it holds, and which
// health measurements have readings — so a card names a real tracker and a
// real field. It is never told a reading: no health value leaves the server to
// build a widget. Its answer is then GROUNDED (`groundWellnessWidget`): a card
// pointing at a tracker the user does not have is refused.
//
// One description may ask for several cards ("a dashboard with my running
// distance, weekly sleep average and weight trend"): the answer is a list.
//
// The builder always answers: no key, a slow model or an answer that does not
// validate falls back to the fixed rules (`inferWellnessWidgetsFromText`). It
// writes nothing — a widget is saved only when the user presses Save.
import { getAnthropicClient } from "./anthropic-client";
import { extractJsonObject } from "./exec-widget-builder";
import {
  MAX_BUILD_WIDGETS, WELLNESS_CALCS, WELLNESS_DISPLAYS, WELLNESS_WIDGET_ICONS, groundWellnessWidget, inferWellnessWidgetsFromText,
  sanitizeWellnessWidget, trackerNumberFields,
  type WellnessWidget,
} from "@shared/wellness-widgets";
import { WELLNESS_RANGES } from "@shared/wellness-period";
import { CANONICAL_METRICS } from "@shared/wellness-canon";
import { isWorkoutTracker } from "@shared/wellness-readout";

const BUDGET_MS = 12_000;

/** What the model may know about one tracker: its shape and size, never a value. */
export interface TrackerOutline {
  name: string;
  fields: Array<{ name: string; unit?: string }>;
  entries: number;
  workout: boolean;
}

export interface WellnessBuildContext {
  /** The user's trackers, outlined. */
  trackers?: TrackerOutline[];
  /** Canonical metric ids that have at least one reading. */
  metricIds?: string[];
  /** The tracker rows themselves — used on the server only, to ground the answer. Never sent to the model. */
  rows?: any[];
}

/** Outline the user's trackers: names, number fields, units and entry counts. */
export function outlineTrackers(trackers: readonly any[]): TrackerOutline[] {
  return trackers
    .filter((t) => t?.name)
    .map((t) => ({
      name: String(t.name).slice(0, 60),
      fields: trackerNumberFields(t).slice(0, 8).map((f) => {
        const unit = (t.fields || []).find((x: any) => x?.name === f)?.unit;
        return { name: f, ...(unit ? { unit: String(unit).slice(0, 12) } : {}) };
      }),
      entries: Array.isArray(t.entries) ? t.entries.length : 0,
      workout: isWorkoutTracker(t),
    }))
    .sort((a, b) => b.entries - a.entries)
    .slice(0, 50);
}

export interface WellnessBuildResult {
  /** One card, or several when the description asked for several. */
  widgets: WellnessWidget[];
  /** The first card (callers that want exactly one). */
  widget: WellnessWidget;
  /** A name for a dashboard made of these cards, when the model offered one. */
  name?: string;
  /** Who read the description: the model, or the fixed rules. */
  by: "ai" | "rules";
}

const cleanName = (raw: unknown) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 24);

export async function buildWellnessWidgetsFromPrompt(prompt: string, ctx: WellnessBuildContext = {}): Promise<WellnessBuildResult> {
  const said = String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const outlines = ctx.trackers ?? [];
  const rows = ctx.rows ?? outlines.map((o) => ({ name: o.name, fields: o.fields.map((f) => ({ ...f, type: "number" })), entries: [] }));
  const result = (widgets: WellnessWidget[], by: "ai" | "rules", name?: string): WellnessBuildResult =>
    ({ widgets, widget: widgets[0], by, ...(name ? { name } : {}) });
  const byRules = (): WellnessBuildResult => {
    const inferred = inferWellnessWidgetsFromText(said, {
      trackerNames: outlines.map((o) => o.name),
      trackerFields: Object.fromEntries(outlines.map((o) => [o.name, o.fields.map((f) => f.name)])),
    });
    const grounded = inferred.map((w) => groundWellnessWidget(w, rows)).filter(Boolean) as WellnessWidget[];
    return result(grounded.length ? grounded : inferred.slice(0, 1), "rules");
  };
  if (said.length < 3 || !process.env.ANTHROPIC_API_KEY) return byRules();
  try {
    const metrics = CANONICAL_METRICS.map((m) => `${m.id} (${m.label})`).join(", ");
    const trackerLines = outlines.length
      ? outlines.map((o) => `- "${o.name}"${o.workout ? " [workout]" : ""}: ${o.entries} entries; number fields: ${o.fields.length ? o.fields.map((f) => `${f.name}${f.unit ? ` (${f.unit})` : ""}`).join(", ") : "none"}`).join("\n")
      : "(none)";
    const source =
      `{"kind":"metric","key":<metric id>} | {"kind":"tracker","key":<tracker name, exactly as listed>,"field":<one of that tracker's number fields, or omit to count its entries>} | ` +
      `{"kind":"workouts","key":<optional word the workout's name contains>} | {"kind":"mood"} | {"kind":"spending","key":<optional word>}`;
    const call = getAnthropicClient("standard").messages.create({
      model: process.env.ANTHROPIC_TITLE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content:
          `A user wants cards on their personal health dashboard. Turn the request into ONE JSON object and reply with the JSON only:\n` +
          `{"name": <2-3 word dashboard name, only when the request asks for several cards>, "widgets": [CARD, ...]}\n` +
          `Give one CARD per thing the request asks to see — usually 1, at most ${MAX_BUILD_WIDGETS}. Never add a card that was not asked for.\n\n` +
          `A SOURCE is one of: ${source}.\n` +
          `Metric ids: ${metrics}.\n\n` +
          `A CARD is one of:\n` +
          `1. {"kind":"metric","title","icon","source":SOURCE,"calc":one of ${WELLNESS_CALCS.join("|")},"display":one of ${WELLNESS_DISPLAYS.join("|")}} — one series, one calculation.\n` +
          `2. {"kind":"compare","title","icon","source":SOURCE (the condition the days are grouped by),"other":SOURCE (what is compared),"threshold":optional number for the condition,"lag":0 same day or 1 the day after} — e.g. "do I exercise more after sleeping 8 hours" = source sleep_hours, threshold 8, other workouts.\n` +
          `3. {"kind":"score","title","icon","parts":[{"source":SOURCE,"weight":1-10,"target":number that earns full marks per day,"better":"higher"|"lower"}]} — a weighted score.\n\n` +
          `"title": 2-4 words, Title Case, in the user's language; titles must differ. "icon": one of ${WELLNESS_WIDGET_ICONS.join(", ")}.\n` +
          `Optional "range" per card: one of ${WELLNESS_RANGES.join("|")} — only when the request names a period for it ("weekly" = 7d).\n` +
          `Use "count" for how often something was logged, "total" for sums (distance, water, spending), "average" for readings, "change" or "latest" with a "line" display for a trend.\n\n` +
          `What this user actually tracks:\n${trackerLines}\n` +
          `Health measurements with readings: ${ctx.metricIds?.length ? ctx.metricIds.join(", ") : "(none)"}.\n` +
          `Use ONLY trackers and fields from this list. Prefer a metric id when the request is about that measurement (sleep, weight, blood pressure, steps, water). ` +
          `For a tracker's distance, minutes or any other number, use its field. If the user has nothing matching, still answer with the closest metric id.\n\n` +
          `Request: ${said}`,
      }],
    });
    const response: any = await Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error("widget build timeout")), BUDGET_MS)),
    ]);
    const block = response?.content?.find?.((b: any) => b?.type === "text");
    const parsed = extractJsonObject(block?.text) || {};
    const raw: unknown[] = Array.isArray((parsed as any).widgets) ? (parsed as any).widgets : [parsed];
    const widgets: WellnessWidget[] = [];
    for (const r of raw.slice(0, MAX_BUILD_WIDGETS)) {
      const id = `widget-${widgets.length + 1}`;
      const clean = sanitizeWellnessWidget({ ...(r && typeof r === "object" ? r : {}), id, by: "ai" }, id);
      const grounded = clean ? groundWellnessWidget(clean, rows) : null;
      if (grounded && !widgets.some((w) => w.title === grounded.title)) widgets.push(grounded);
    }
    return widgets.length ? result(widgets, "ai", widgets.length > 1 ? cleanName((parsed as any).name) : undefined) : byRules();
  } catch {
    return byRules();
  }
}

/** One card from a sentence (the first, when the description asked for several). */
export async function buildWellnessWidgetFromPrompt(prompt: string, ctx: WellnessBuildContext = {}, id = "widget"): Promise<{ widget: WellnessWidget; by: "ai" | "rules" }> {
  const r = await buildWellnessWidgetsFromPrompt(prompt, ctx);
  return { widget: { ...r.widget, id }, by: r.by };
}
