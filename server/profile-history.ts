// A profile's edit history: recorded when a person edits a profile by hand,
// read back (together with the edits the chat made) for the History tab.
//
// Storage, with no schema change:
//   • a manual edit → one `audit_log` row (action "update", entity_type
//     "profile", entity_id = the profile, details.changes = the diff). The
//     table is append-only and already written on every create.
//   • a chat edit → already in `ai_action_log` with the row before and after
//     (server/ai-envelope recordActionLog). It is read from there, so a chat
//     edit is never recorded twice.
//
// The diff is shared/profile-edit-history `diffProfileEdit`.

import { diffProfileEdit, type ProfileEditEntry, type ProfileFieldChange } from "@shared/profile-edit-history";

type AnyStorage = any;

const clientOf = (storage: AnyStorage): any => {
  try { return storage?.supabase ?? null; } catch { return null; }
};

/**
 * Record what a manual edit changed. Never throws and never blocks the edit:
 * the profile write has already landed, and a missing history row must not
 * turn a saved edit into an error.
 */
export async function recordManualProfileEdit(
  storage: AnyStorage,
  userId: string | undefined,
  before: { id?: string; name?: unknown; notes?: unknown; fields?: unknown } | null | undefined,
  after: { id?: string; name?: unknown; notes?: unknown; fields?: unknown } | null | undefined,
): Promise<ProfileFieldChange[]> {
  const changes = diffProfileEdit(before, after);
  const profileId = String(after?.id || before?.id || "");
  const sb = clientOf(storage);
  if (changes.length === 0 || !profileId || !userId || !sb) return changes;
  try {
    const write = Promise.resolve(sb.from("audit_log").insert({
      user_id: userId,
      action: "update",
      entity_type: "profile",
      entity_id: profileId,
      entity_name: String(after?.name ?? before?.name ?? "").slice(0, 500),
      details: { changes },
      source: "manual",
    }));
    const { error } = (await Promise.race([write, new Promise((r) => setTimeout(() => r({ error: null }), 1500))])) as any;
    if (error) console.warn(`[profile-history] edit of ${profileId} was saved but not logged: ${error.message || error}`);
  } catch (e: any) {
    console.warn(`[profile-history] edit of ${profileId} was saved but not logged: ${e?.message || e}`);
  }
  return changes;
}

const validChanges = (raw: unknown): ProfileFieldChange[] =>
  (Array.isArray(raw) ? raw : []).filter((c: any) =>
    c && typeof c.field === "string" && typeof c.label === "string"
    && (c.from === null || typeof c.from === "string") && (c.to === null || typeof c.to === "string"));

/** Chat tools whose ledger row is an edit of the profile itself. */
const CHAT_EDIT_ACTIONS = /update|edit|rename|set_/i;

/**
 * Every recorded edit of one profile, newest first: manual edits from the
 * audit log and chat edits from the action ledger. A failed read of either
 * source THROWS (Rule 7: a failed request is not an empty history).
 */
export async function readProfileEditHistory(
  storage: AnyStorage,
  userId: string | undefined,
  profileId: string,
  limit = 100,
): Promise<ProfileEditEntry[]> {
  const out: ProfileEditEntry[] = [];
  const sb = clientOf(storage);
  if (sb && userId) {
    const { data, error } = await sb.from("audit_log")
      .select("id, details, source, created_at")
      .eq("user_id", userId).eq("entity_type", "profile").eq("entity_id", profileId).eq("action", "update")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(`Could not load the edit history: ${error.message || error}`);
    for (const r of data || []) {
      const changes = validChanges(r?.details?.changes);
      if (changes.length === 0 || !r.created_at) continue;
      out.push({ id: `edit-${r.id}`, kind: "edit", action: "update", changedBy: r.source === "chat" ? "ai" : "user", changedAt: r.created_at, changes });
    }
  }
  if (typeof storage?.listAiActionLog === "function") {
    const rows: any[] = await storage.listAiActionLog({ entityId: profileId, limit: Math.min(limit, 100), includeUndone: false });
    for (const r of rows || []) {
      if (!r?.createdAt || r.source === "undo") continue;
      if (!CHAT_EDIT_ACTIONS.test(`${r.tool || ""} ${r.actionType || ""}`)) continue;
      const changes = diffProfileEdit(r.before, r.after);
      // An edit whose snapshots carry no field detail is still an edit: say
      // so, rather than leave a gap in the history.
      const note = changes.length === 0 ? "Edited in chat" : null;
      out.push({ id: `chat-${r.id}`, kind: "edit", action: "update", changedBy: "ai", changedAt: r.createdAt, changes, note });
    }
  }
  return out.sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1)).slice(0, limit);
}
