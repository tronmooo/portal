// The AI Mode library: modes people published for others to install
// (migrations/20261127_ai_mode_library.sql; shared/ai-modes.ts).
//
//  - What is published is the mode's SETUP (`exportModeTemplate`) built from
//    the STORED mode — never what the client sends, never a conversation,
//    memory, record or the journal switch.
//  - The author is kept to let them unpublish, and is never returned: a card
//    says only whether it is yours.
//  - Installing hands back a template that becomes a PROPOSAL on the
//    person's side (`importModeTemplate`); it is saved only by their Save.
//  - Three reports from different people hide an entry.
//  - A missing table is "not available yet", never an empty library (Rule 7).
import { exportModeTemplate, importModeTemplate, sanitizeAiMode, type AiMode } from "@shared/ai-modes";
import { isMissingSchemaError } from "@shared/schema-expectations";
import { fail, type AssistFailure } from "./workspace-ai";
import { readModes } from "./ai-modes";

export const LIBRARY_TABLE = "ai_mode_library";
export const MAX_PUBLISHED_PER_PERSON = 20;
export const HIDE_AT_REPORTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let client: any = null;
/** Tests hand in a double; production builds the service-role client once. */
export function setLibraryClientForTests(c: any) { client = c; }
async function db(): Promise<any> {
  if (client) return client;
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase admin env vars missing");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

const UNAVAILABLE = "The mode library isn't available yet. Please try again later.";
const check = (error: any): AssistFailure | null => (error ? (isMissingSchemaError(error) ? fail(503, UNAVAILABLE) : fail(500, "Couldn't reach the mode library.")) : null);

export interface LibraryCard {
  id: string; name: string; tagline: string; icon: string; color: string;
  tabs: string[]; installs: number; publishedAt: string; mine: boolean;
}

function card(row: any, userId: string): LibraryCard | null {
  const mode = importModeTemplate(row.template, [], new Date());
  if (!mode) return null;
  return {
    id: String(row.id), name: mode.name, tagline: mode.tagline, icon: mode.icon, color: mode.color,
    tabs: mode.tabs.map((t) => t.title), installs: Number(row.installs) || 0,
    publishedAt: String(row.created_at), mine: row.author_id === userId,
  };
}

export async function listLibrary(userId: string, opts: { q?: string; sort?: string; mine?: boolean }): Promise<{ ok: true; items: LibraryCard[] } | AssistFailure> {
  const c = await db();
  let q = c.from(LIBRARY_TABLE).select("id,author_id,name,tagline,icon,color,template,installs,created_at,reports").lt("reports", HIDE_AT_REPORTS);
  if (opts.mine) q = c.from(LIBRARY_TABLE).select("id,author_id,name,tagline,icon,color,template,installs,created_at,reports").eq("author_id", userId);
  const term = String(opts.q || "").replace(/[%_,()]/g, " ").trim().slice(0, 60);
  if (term) q = q.or(`name.ilike.%${term}%,tagline.ilike.%${term}%`);
  q = opts.sort === "new" ? q.order("created_at", { ascending: false }) : q.order("installs", { ascending: false }).order("created_at", { ascending: false });
  const { data, error } = await q.limit(60);
  const bad = check(error);
  if (bad) return bad;
  return { ok: true, items: ((data || []) as any[]).map((r) => card(r, userId)).filter((x): x is LibraryCard => !!x) };
}

/** Publish one of the person's own modes (as stored). */
export async function publishMode(userId: string, modeId: string): Promise<{ ok: true; item: LibraryCard } | AssistFailure> {
  const mode = (await readModes()).find((m) => m.id === modeId);
  if (!mode) return fail(404, "That mode no longer exists.");
  const c = await db();
  const { count, error: countErr } = await c.from(LIBRARY_TABLE).select("id", { count: "exact", head: true }).eq("author_id", userId);
  const bad = check(countErr);
  if (bad) return bad;
  if ((count ?? 0) >= MAX_PUBLISHED_PER_PERSON) return fail(409, `You have published ${MAX_PUBLISHED_PER_PERSON} modes — unpublish one first.`);
  const template = exportModeTemplate(mode);
  const { data, error } = await c.from(LIBRARY_TABLE)
    .insert({ author_id: userId, name: mode.name, tagline: mode.tagline, icon: mode.icon, color: mode.color, template })
    .select("id,author_id,name,tagline,icon,color,template,installs,created_at").single();
  const bad2 = check(error);
  if (bad2) return bad2;
  const item = card(data, userId);
  return item ? { ok: true, item } : fail(500, "Couldn't publish that mode.");
}

export async function unpublishMode(userId: string, id: string): Promise<{ ok: true } | AssistFailure> {
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const c = await db();
  const { data, error } = await c.from(LIBRARY_TABLE).delete().eq("id", id).eq("author_id", userId).select("id");
  const bad = check(error);
  if (bad) return bad;
  return (data || []).length ? { ok: true } : fail(404, "That isn't one of your published modes.");
}

/** The template to review before saving (counted as an install). */
export async function installMode(id: string): Promise<{ ok: true; mode: AiMode } | AssistFailure> {
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const c = await db();
  const { data, error } = await c.from(LIBRARY_TABLE).select("id,template,reports").eq("id", id).maybeSingle();
  const bad = check(error);
  if (bad) return bad;
  if (!data || Number(data.reports) >= HIDE_AT_REPORTS) return fail(404, "That mode is no longer in the library.");
  const mode = importModeTemplate(data.template, await readModes(), new Date());
  if (!mode) return fail(500, "That mode couldn't be read.");
  await c.rpc("ai_mode_library_installed", { p_id: id }).then(() => undefined, () => undefined);
  // What comes back is a fresh proposal: its journal switch is off, and it is
  // the person's Save that makes it theirs.
  return { ok: true, mode: sanitizeAiMode(mode, { id: mode.id, keepJournal: false })! };
}

export async function reportMode(userId: string, id: string): Promise<{ ok: true; hidden: boolean } | AssistFailure> {
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const c = await db();
  const { data, error } = await c.rpc("ai_mode_library_report", { p_id: id, p_reporter: userId });
  const bad = check(error);
  if (bad) return bad;
  return { ok: true, hidden: Number(data) >= HIDE_AT_REPORTS };
}
