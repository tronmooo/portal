// The `navigate` chat tool ("go to the trackers page") answers with
// `{ navigateTo, profileId }` in the turn's results. The engine cannot move
// the browser, so the page that receives the reply does — the same division
// of labour as `scope` for set_dashboard_scope.
//
// Until 2026-11-09 nothing read this field: the assistant replied
// "Navigating to your Trackers page now!" and the user stayed on the chat.

/** Pages the tool's schema can name (server/ai-engine.ts, tool `navigate`). */
const PAGE_ROUTES: Record<string, string> = {
  dashboard: "/dashboard",
  trackers: "/trackers",
  profiles: "/profiles",
  ai_modes: "/workspace/modes",
};

/**
 * The route a chat turn asked the app to open, or null when it asked for
 * none. `chat` is null too: the user is already there.
 */
export function chatNavigationRoute(results: unknown): string | null {
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const page = (r as { navigateTo?: unknown }).navigateTo;
    if (typeof page !== "string") continue;
    if (page === "profile_detail") {
      const id = (r as { profileId?: unknown }).profileId;
      return typeof id === "string" && id ? `/profiles/${encodeURIComponent(id)}` : "/profiles";
    }
    // AI Modes (shared/ai-modes.ts): one mode by id; the builder with the words.
    if (page === "ai_mode") {
      const id = (r as { modeId?: unknown }).modeId;
      return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) ? `/workspace/mode/${id}` : "/workspace/modes";
    }
    if (page === "create_ai_mode") {
      const said = String((r as { description?: unknown }).description ?? "").trim().slice(0, 600);
      return said ? `/workspace/modes?new=1&describe=${encodeURIComponent(said)}` : "/workspace/modes?new=1";
    }
    if (PAGE_ROUTES[page]) return PAGE_ROUTES[page];
  }
  return null;
}
