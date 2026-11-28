// AI Modes through the API (AM1–AM2): create, edit, duplicate and delete are
// each applied to the ONE stored preference row (`ai_modes`), read back here
// straight from Postgres. The mode body is a literal — what the builder sends
// — not built with the app's own helpers; expectations are this file's own.
import { scenario, must, type Ctx } from "../framework";
import { fetchWithRateLimitRetry, getSmokeToken } from "../../smoke/fixture/api";
import { SB_URL, SB_ANON, SMOKE_USER_ID } from "../../smoke/fixture/account";

const enc = encodeURIComponent;
const mine = `user_id=eq.${SMOKE_USER_ID}`;
async function dbWrite(method: "POST" | "PATCH" | "DELETE", q: string, body?: unknown): Promise<any[]> {
  const { response } = await fetchWithRateLimitRetry(`${SB_URL}/rest/v1/${q}`, {
    method,
    headers: { apikey: SB_ANON, Authorization: `Bearer ${await getSmokeToken()}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${q} → ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}
const prefRow = async (ctx: Ctx, key: string) => (await ctx.db.rows("preferences", `key=eq.${enc(key)}`))[0] ?? null;
async function restorePref(key: string, before: any | null) {
  if (before) {
    const upd = await dbWrite("PATCH", `preferences?key=eq.${enc(key)}&${mine}`, { value: before.value });
    if (upd.length === 0) await dbWrite("POST", "preferences", { user_id: SMOKE_USER_ID, key, value: before.value });
  } else await dbWrite("DELETE", `preferences?key=eq.${enc(key)}&${mine}`);
}
const storedModes = async (ctx: Ctx): Promise<any[]> => {
  const r = await prefRow(ctx, "ai_modes");
  if (!r) return [];
  const v = JSON.parse(r.value);
  return Array.isArray(v) ? v : Array.isArray(v?.modes) ? v.modes : [];
};

scenario({
  id: "api-rest.ai-modes",
  title: "An AI Mode created, renamed and pinned, duplicated and deleted: each change lands on the one stored row, the id and creation date never move, and deleting forgets its memory",
  area: "AI Modes",
  covers: ["aiMode.create.api", "aiMode.edit.api", "aiMode.duplicate.api", "aiMode.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const slug = ctx.tag.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = `${slug}-coach`;
    const memKey = `ai_memory:mode-${id}`;
    const [modes0Row, mem0] = [await prefRow(ctx, "ai_modes"), await prefRow(ctx, memKey)];
    ctx.cleanup(async () => { await restorePref("ai_modes", modes0Row); await restorePref(memKey, mem0); });
    const before = await storedModes(ctx);
    const created = "2026-11-01T10:00:00.000Z";
    const mode = {
      id, name: `${ctx.tag} Coach`, icon: "compass", color: "violet", tagline: "Patterns and goals",
      personality: "Warm and direct", instructions: "Help me set one small goal at a time.",
      access: ["tasks", "goals"], remember: true,
      tabs: [
        { id: "overview", title: "Overview", kind: "overview", widgets: [{ id: "my-goals", title: "My Goals", icon: "target", source: "goals", limit: 4 }] },
        { id: "chat", title: "Chat", kind: "chat" },
      ],
      prompts: ["What should I focus on this week?"], reminders: [], checkins: [],
      pinned: false, createdAt: created, updatedAt: created,
    };

    // ── create ──
    const c = must(await ctx.api("POST", "/workspace/modes", { mode }), "create the mode");
    ctx.check("action", c?.mode?.id === id && c?.mode?.name === mode.name, "the route answers with the mode it saved", JSON.stringify(c?.mode ?? c).slice(0, 200));
    let rows = await storedModes(ctx);
    const mine1 = rows.find((m) => m.id === id);
    ctx.check("db", !!mine1 && mine1.name === mode.name && JSON.stringify(mine1.access) === JSON.stringify(["tasks", "goals"]), "the stored row holds the mode as sent (name, what it may read)", JSON.stringify(mine1 ?? null).slice(0, 200));
    ctx.same("derived", rows.length, before.length + 1, "the stored list grew by one; every other mode is still there");
    ctx.check("db", before.every((b) => rows.some((r) => r.id === b.id && r.name === b.name)), "no other mode was changed");
    // The creation date is the server's own stamp (the body's is not taken);
    // what AM2 forbids is a later PATCH moving it.
    const createdAt = mine1?.createdAt;
    ctx.check("db", typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)), "the stored mode has a creation date", String(createdAt));
    const listed = must(await ctx.api("GET", "/workspace/modes"), "list");
    ctx.check("action", (listed?.modes ?? []).some((m: any) => m.id === id), "the list route shows it");

    // ── edit: rename, pin, and a smuggled id change ──
    const newName = `${ctx.tag} Coach Kim`;
    must(await ctx.api("PATCH", `/workspace/modes/${id}`, { patch: { name: newName, pinned: true, id: "hijack", createdAt: "2001-01-01T00:00:00.000Z" } }), "edit the mode");
    rows = await storedModes(ctx);
    const edited = rows.find((m) => m.id === id);
    ctx.check("db", !!edited && edited.name === newName && edited.pinned === true, "the stored mode is renamed and pinned", JSON.stringify(edited ?? null).slice(0, 200));
    ctx.check("db", !rows.some((m) => m.id === "hijack"), "a PATCH never changes the id (AM2)");
    ctx.same("db", edited?.createdAt, createdAt, "a PATCH never changes the creation date (AM2), even when the body names another");
    ctx.same("derived", rows.length, before.length + 1, "an edit adds nothing");

    // ── duplicate ──
    const d = must(await ctx.api("POST", `/workspace/modes/${id}/duplicate`), "duplicate the mode");
    const copyId = d?.mode?.id;
    ctx.check("action", !!copyId && copyId !== id && /\(copy\)/.test(String(d?.mode?.name)), "the copy has its own id and says it is a copy", JSON.stringify(d?.mode ?? d).slice(0, 200));
    rows = await storedModes(ctx);
    const copy = rows.find((m) => m.id === copyId);
    ctx.check("db", !!copy && copy.pinned === false && copy.instructions === mode.instructions, "the stored copy carries the setup, not the pin", JSON.stringify(copy ?? null).slice(0, 200));
    ctx.check("db", rows.find((m) => m.id === id)?.name === newName, "the original is unchanged by the copy");
    ctx.same("derived", rows.length, before.length + 2, "the stored list now holds both");

    // ── delete (the original, with a memory to forget) ──
    await dbWrite("POST", "preferences", { user_id: SMOKE_USER_ID, key: memKey, value: JSON.stringify({ memories: [{ id: "m1", text: `${ctx.tag} is training for a 10k`, at: "2026-11-20T00:00:00Z", by: "ai" }], turns: [], lastTalked: null }) })
      .catch(async () => dbWrite("PATCH", `preferences?key=eq.${enc(memKey)}&${mine}`, { value: JSON.stringify({ memories: [{ id: "m1", text: "x", at: "2026-11-20T00:00:00Z", by: "ai" }], turns: [], lastTalked: null }) }));
    must(await ctx.api("DELETE", `/workspace/modes/${id}`), "delete the mode");
    rows = await storedModes(ctx);
    ctx.check("db", !rows.some((m) => m.id === id), "the stored row no longer holds the deleted mode");
    ctx.check("db", rows.some((m) => m.id === copyId), "its copy is kept");
    ctx.same("derived", rows.length, before.length + 1, "only the deleted mode left the list");
    const mem = await prefRow(ctx, memKey);
    const memories = mem ? (JSON.parse(mem.value).memories ?? []) : [];
    ctx.same("db", memories.length, 0, "deleting the mode forgot its memories (AM2)");
    const again = await ctx.api("DELETE", `/workspace/modes/${id}`);
    ctx.same("action", again.status, 404, "deleting it again finds nothing");
    must(await ctx.api("DELETE", `/workspace/modes/${copyId}`), "remove the copy");
  },
});
