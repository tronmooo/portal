// The AI Builder behind "Create Your Own Widget" (owner request 2026-11-22).
//
// A sentence — "my dog's vet visits", "how much I spend on groceries",
// "journal entries about work" — becomes a widget description
// (shared/exec-widgets). The model only CHOOSES among the sources and filters
// the dashboard can render; whatever it answers is held to `sanitizeWidget`,
// so it cannot invent a card the app cannot draw or reach data it should not.
//
// The builder always answers: no key, a slow model or a malformed reply falls
// back to the fixed rules (`inferWidgetFromText`). It writes nothing — the
// widget is saved only when the user presses Save in the Customize dialog.
import { getAnthropicClient } from "./anthropic-client";
import {
  WIDGET_ICONS, WIDGET_PROFILE_TYPES, WIDGET_SOURCES, WIDGET_SOURCE_LABELS,
  inferWidgetFromText, sanitizeWidget, type ExecWidget,
} from "@shared/exec-widgets";

const BUDGET_MS = 8_000;

export interface WidgetBuildContext {
  /** Names of the user's trackers, so a filter can name a real one. */
  trackerNames?: string[];
  /** Expense categories in use. */
  expenseCategories?: string[];
  /** Kinds of record the user has (pet, vehicle, …). */
  profileTypes?: string[];
}

export interface WidgetBuildResult {
  widget: ExecWidget;
  /** Who read the sentence: the model, or the fixed rules. */
  by: "ai" | "rules";
}

/** The first {...} in a model reply, parsed; null when there is none. */
export function extractJsonObject(text: unknown): Record<string, unknown> | null {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function buildWidgetFromPrompt(prompt: string, ctx: WidgetBuildContext = {}, id = "widget"): Promise<WidgetBuildResult> {
  const said = String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const byRules = (): WidgetBuildResult => ({ widget: inferWidgetFromText(said, id), by: "rules" });
  if (said.length < 3 || !process.env.ANTHROPIC_API_KEY) return byRules();
  try {
    const list = (xs: string[] | undefined) => (xs && xs.length ? xs.slice(0, 40).join(", ") : "(none)");
    const call = getAnthropicClient("standard").messages.create({
      model: process.env.ANTHROPIC_TITLE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content:
          `A user wants a card on their personal dashboard. Turn their request into ONE JSON object and reply with the JSON only.\n\n` +
          `Fields:\n` +
          `- "title": 2-4 words, Title Case, in the user's language.\n` +
          `- "source": one of ${WIDGET_SOURCES.map((s) => `"${s}" (${WIDGET_SOURCE_LABELS[s]})`).join("; ")}.\n` +
          `- "types": only for source "profiles": any of ${WIDGET_PROFILE_TYPES.join(", ")}. Omit for every kind.\n` +
          `- "match": optional short text the rows must contain (a tracker name, an expense category, a word in a journal entry). Omit when the request names no subject.\n` +
          `- "days": optional number of days back, for expenses, journal or notes. Omit for "this month" / "recent".\n` +
          `- "limit": rows to show, 1-8 (default 4).\n` +
          `- "icon": one of ${WIDGET_ICONS.join(", ")}.\n\n` +
          `What this user has — trackers: ${list(ctx.trackerNames)}. Expense categories: ${list(ctx.expenseCategories)}. Record kinds: ${list(ctx.profileTypes)}.\n` +
          `Prefer a "match" that is one of those exact names when the request refers to it.\n\n` +
          `Request: ${said}`,
      }],
    });
    const response: any = await Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error("widget build timeout")), BUDGET_MS)),
    ]);
    const block = response?.content?.find?.((b: any) => b?.type === "text");
    const widget = sanitizeWidget({ ...(extractJsonObject(block?.text) || {}), id }, id);
    return widget ? { widget, by: "ai" } : byRules();
  } catch {
    return byRules();
  }
}
