// Per-chat-turn collector of "would you like a profile for X?" offers.
//
// A tool that meets a person with no profile (create_profile refused for lack
// of an explicit request, an owner name that matches nobody) NOTES the name
// here instead of creating anyone. At the end of the turn the chat engine
// turns the notes into at most two offers, skipping names that already have
// a profile and names offered before (shared/profile-intent.ts). The offer is
// shown under the reply as Yes / No and never blocks the write.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ProfileSuggestion, suggestionKey,
} from "@shared/profile-intent";
import { profileIsNamedBy } from "@shared/birthday-event";

const bag = new AsyncLocalStorage<Map<string, ProfileSuggestion>>();

/** Start collecting for the current async context (one chat turn). */
export function beginProfileSuggestions(): void {
  bag.enterWith(new Map());
}

/** Note a person/pet the turn met that has no profile. No-op outside a turn. */
export function noteProfileSuggestion(name: unknown, type: ProfileSuggestion["type"] = "person"): void {
  const store = bag.getStore();
  const clean = String(name ?? "").replace(/^[^\p{L}]+/u, "").replace(/['’]s$/i, "").trim();
  const key = suggestionKey(clean);
  if (!store || !key || key.length < 2) return;
  if (/^(me|myself|i|self|my|mine|us|we|you)$/i.test(key)) return;
  if (!store.has(key)) store.set(key, { name: clean, type });
}

/** The preference that remembers every name already offered (never ask twice). */
export const OFFERED_PREF_KEY = "profile_suggestions_offered";

/**
 * The offers for this turn: noted names, minus any that already have a
 * profile, minus any offered before. Records the new ones as offered.
 */
export async function finishProfileSuggestions(deps: {
  profiles: ReadonlyArray<{ name: string; type?: string | null }>;
  getPreference: (key: string) => Promise<string | null>;
  setPreference: (key: string, value: string) => Promise<unknown>;
  max?: number;
}): Promise<ProfileSuggestion[]> {
  const store = bag.getStore();
  if (!store || store.size === 0) return [];
  let offered: string[] = [];
  try {
    const raw = await deps.getPreference(OFFERED_PREF_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) offered = parsed.map(String);
  } catch { /* a corrupt list only means we may offer again */ }
  const out: ProfileSuggestion[] = [];
  for (const [key, s] of store) {
    if (offered.includes(key)) continue;
    if (deps.profiles.some((p) => profileIsNamedBy(s.name, p.name))) continue;
    out.push(s);
    if (out.length >= (deps.max ?? 2)) break;
  }
  if (out.length > 0) {
    const next = [...offered, ...out.map((s) => suggestionKey(s.name))].slice(-500);
    await deps.setPreference(OFFERED_PREF_KEY, JSON.stringify(next)).catch(() => undefined);
  }
  return out;
}
