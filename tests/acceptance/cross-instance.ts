// Cross-instance staleness: the production shape of "I deleted it and it took
// time to disappear everywhere".
//
// Response-cache keys are stamped with a per-user data version, and each server
// instance memoizes that version for ~2s. A write lands on one instance; the
// refetch it triggers can land on another whose memo is still pre-write. That
// instance computes the OLD cache key, finds its own pre-write entry, and hands
// back the deleted row — after which React Query re-renders it and marks it
// fresh for a full staleTime.
//
// This runs each instance in its own PROCESS against a shared database, so the
// two genuinely have separate caches and separate version memos. Requests are
// pinned to a chosen instance so the sequence is deterministic rather than a
// race we hope to win.
import { startRig } from "./rig";

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name} — ${detail}`);
}

async function main() {
  const rig = await startRig({ instances: 2, separateProcesses: true });
  console.log("two instances, separate processes, one shared database\n");

  const jar: Record<string, string> = { "X-Timezone": "America/Los_Angeles" };
  let token: string | null = null;
  const api = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { ...jar };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Mirror the client: send the read-your-writes token once we have one.
    if (token) headers["X-Data-Version"] = token;
    const res = await fetch(`${rig.url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const seen = res.headers.get("X-Data-Version");
    if (seen && (!token || Number(seen) > Number(token))) token = seen;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, text, dataVersion: seen };
  };

  // ── A row that exists on both instances' caches ──────────────────────────
  const title = `XInst${Date.now().toString(36)}`;
  rig.pinInstance(0);
  const created = await api("POST", "/api/tasks", { title, priority: "medium" });
  const taskId = created.json?.id;
  if (!taskId) { console.error("could not create the task:", created.status, created.text.slice(0, 200)); process.exit(2); }

  // Warm BOTH instances so each holds a cached, pre-delete /api/tasks.
  rig.pinInstance(0); await api("GET", "/api/tasks");
  rig.pinInstance(1); await api("GET", "/api/tasks");

  // ── The write lands on instance 0 ────────────────────────────────────────
  rig.pinInstance(0);
  const del = await api("DELETE", `/api/tasks/${taskId}`);
  record(
    "the write response carries a read-your-writes token",
    !!del.dataVersion,
    del.dataVersion ? `X-Data-Version: ${del.dataVersion}` : "no X-Data-Version header — the client has nothing to send",
  );

  const gone = (await rig.storage.getTasks()).every((t: any) => t.id !== taskId || t.deletedAt);
  record("the row is actually deleted in the database", gone, gone ? "confirmed" : "still present — nothing else is meaningful");

  // ── The refetch lands on the OTHER instance, whose memo is still pre-write ─
  rig.pinInstance(1);
  const withToken = await api("GET", "/api/tasks");
  const stillThere = String(withToken.text).includes(title);
  record(
    "the other instance does NOT serve the deleted row back",
    !stillThere,
    stillThere ? "STALE: it returned the row the other instance just deleted" : "returned post-delete data",
  );

  // ── Control: the same read WITHOUT the token, which is what a client that
  //    never received one would send. This is the pre-fix behaviour. ─────────
  const bare = await fetch(`${rig.url}/api/tasks`, { headers: { "X-Timezone": "America/Los_Angeles" } });
  const bareText = await bare.text();
  const bareStale = bareText.includes(title);
  console.log(`\n  (control) same read with no token: deleted row returned = ${bareStale}`);
  console.log(bareStale
    ? "  → the token is what prevents it; without one this instance answers with pre-delete data."
    : "  → this instance is fresh on its own here, so the token was not the deciding factor in this run.");

  // ── The same question for an ADD and an EDIT ────────────────────────────
  // "when I add stuff it doesn't show up right away" and "when I edit stuff
  // there's still a delay" are the same mechanism pointed the other way: the
  // other instance answers without the new row, or with the pre-edit values.
  const addTitle = `XAdd${Date.now().toString(36)}`;
  rig.pinInstance(0); await api("GET", "/api/tasks");
  rig.pinInstance(1); await api("GET", "/api/tasks");
  rig.pinInstance(0);
  const addRes = await api("POST", "/api/tasks", { title: addTitle, priority: "medium" });
  const addedId = addRes.json?.id;
  rig.pinInstance(1);
  const afterAdd = await api("GET", "/api/tasks");
  record(
    "a row added on one instance is visible from the other",
    String(afterAdd.text).includes(addTitle),
    String(afterAdd.text).includes(addTitle) ? "returned the new row" : "STALE: the other instance still returns the old list",
  );

  const editedTitle = `XEdit${Date.now().toString(36)}`;
  rig.pinInstance(0); await api("GET", "/api/tasks");
  rig.pinInstance(1); await api("GET", "/api/tasks");
  rig.pinInstance(0);
  await api("PATCH", `/api/tasks/${addedId}`, { title: editedTitle });
  rig.pinInstance(1);
  const afterEdit = await api("GET", "/api/tasks");
  const hasNew = String(afterEdit.text).includes(editedTitle);
  const hasOld = String(afterEdit.text).includes(addTitle);
  record(
    "an edit made on one instance is visible from the other",
    hasNew && !hasOld,
    hasNew && !hasOld ? "returned the edited value" : `STALE: new=${hasNew} old-value-still-present=${hasOld}`,
  );

  rig.pinInstance(null);
  await rig.close();
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
