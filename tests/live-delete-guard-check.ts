// Live check (production, smoke account): the assistant deletes only what the
// user asked it to delete (shared/destructive-intent.ts). Takes the gate lock
// (CLAUDE.md), creates two tasks, then:
//   1. asks the chat a question that is NOT a delete -> both tasks survive;
//   2. asks the chat to delete one by name          -> that one is gone, the
//      other survives.
// Cleans up whatever is left.
//   npx tsx tests/live-delete-guard-check.ts
import { api, expectOk } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";

const stamp = Date.now().toString(36);
const KEEP = `Guard keep ${stamp}`;
const DROP = `Guard drop ${stamp}`;

async function taskIds(): Promise<Map<string, string>> {
  const tasks = expectOk(await api("GET", "/tasks"), "tasks") as any[];
  if (!Array.isArray(tasks)) throw new Error("tasks is not a list");
  return new Map(tasks.map((t) => [String(t.title), String(t.id)]));
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-delete-guard-check" });
  let failed = false;
  const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed = true; };
  try {
    for (const title of [KEEP, DROP]) expectOk(await api("POST", "/tasks", { title, __allowDuplicate: true }), `create ${title}`);
    let ids = await taskIds();
    check(ids.has(KEEP) && ids.has(DROP), "both tasks created");

    const q: any = expectOk(await api("POST", "/chat", { message: `How many tasks do I have with "Guard" in the title?`, history: [] }), "chat question");
    console.log(`  reply: ${String(q.reply ?? q.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    ids = await taskIds();
    check(ids.has(KEEP) && ids.has(DROP), "a question deletes nothing");

    const d: any = expectOk(await api("POST", "/chat", { message: `Delete my task called "${DROP}"`, history: [] }), "chat delete");
    console.log(`  reply: ${String(d.reply ?? d.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    ids = await taskIds();
    check(!ids.has(DROP), "an explicit delete request still deletes the named task");
    check(ids.has(KEEP), "and only that task");
  } finally {
    const ids = await taskIds().catch(() => new Map<string, string>());
    for (const title of [KEEP, DROP]) {
      const id = ids.get(title);
      if (id) await api("DELETE", `/tasks/${id}`).catch(() => undefined);
    }
    await release();
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
