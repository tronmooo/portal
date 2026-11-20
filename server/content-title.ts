// A short title for a journal entry or a note, written by the model from the
// text (owner request 2026-11-20: "a title will be created with AI based on
// the context of what it is, same with the notes").
//
// Used where no model is already in the loop: the chat's Journal / Note
// buttons and the manual forms. In the ordinary chat path the model passes the
// title in its tool call, so no second call is made there.
//
// A title must never cost the save: a missing key, a slow model or a strange
// answer falls back to the first clause of the text (fallbackTitle).
import { getAnthropicClient } from "./anthropic-client";
import { fallbackTitle, type CaptureKind } from "@shared/capture-target";

const TITLE_BUDGET_MS = 6_000;

/** One line, no quotes, no trailing period, capped. Null when unusable. */
export function cleanTitle(raw: unknown): string | null {
  let t = String(raw ?? "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  t = t.replace(/^(?:title\s*:\s*)/i, "").replace(/^["'“”‘’*#\s]+|["'“”‘’*\s]+$/g, "").replace(/[.]+$/, "").trim();
  if (t.length < 2 || t.length > 80) return null;
  return t;
}

export async function generateTitle(content: string, kind: CaptureKind): Promise<string> {
  const text = String(content ?? "").trim();
  const fallback = fallbackTitle(text, kind === "note" ? "Note" : "Journal entry");
  // Too short to need a model: the text is its own title.
  if (text.length < 25 || !process.env.ANTHROPIC_API_KEY) return fallback;
  try {
    const call = getAnthropicClient("standard").messages.create({
      model: process.env.ANTHROPIC_TITLE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 30,
      messages: [{
        role: "user",
        content:
          `Write a title for this ${kind === "note" ? "note" : "journal entry"}: 3 to 7 words, specific to what it says, ` +
          `in the writer's language, Title Case, no quotes, no period, no emoji. Reply with the title only.\n\n---\n${text.slice(0, 2000)}`,
      }],
    });
    const response: any = await Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error("title timeout")), TITLE_BUDGET_MS)),
    ]);
    const block = response?.content?.find?.((b: any) => b?.type === "text");
    return cleanTitle(block?.text) ?? fallback;
  } catch {
    return fallback;
  }
}
