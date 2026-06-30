/**
 * Wipe-only helper that exposes the same behaviour as
 * `npx tsx tests/smoke/fixture/seed.ts --reset` for programmatic use from
 * contract suites that want a clean slate without a full seed.
 *
 * Kept as a thin re-export so the implementation lives in one place.
 */
import { api } from "./api";

export async function reset(): Promise<void> {
  const entityEndpoints = [
    "/expenses", "/obligations", "/events", "/tasks", "/trackers",
    "/documents", "/habits", "/journal", "/artifacts", "/goals", "/incomes",
  ];
  for (const path of entityEndpoints) {
    const r = await api<any[]>("GET", path);
    const items: any[] = Array.isArray(r.data) ? r.data : (r.data?.items || []);
    for (const item of items) {
      if (!item.id) continue;
      await api("DELETE", `${path}/${item.id}`);
    }
  }
  const profRes = await api<any[]>("GET", "/profiles");
  const profiles: any[] = Array.isArray(profRes.data) ? profRes.data : [];
  const sorted = [...profiles].sort((a, b) => {
    const aDepth = a.parentProfileId ? 1 : 0;
    const bDepth = b.parentProfileId ? 1 : 0;
    return bDepth - aDepth;
  });
  for (const p of sorted) {
    if (p.type === "self") continue;
    const del = await api("DELETE", `/profiles/${p.id}`);
    // Surface real delete failures instead of silently moving on. A 404 is fine
    // (already cascade-deleted via its parent); anything else (e.g. a 500 from a
    // failed cascade) must fail loudly — otherwise "wipe done" lies and the next
    // seed hits a duplicate. This is exactly how the net_worth_snapshots FK bug
    // stayed hidden.
    if (!del.ok && del.status !== 404) {
      const detail = typeof del.data === "string" ? del.data : JSON.stringify(del.data);
      throw new Error(`[smoke-reset] failed to delete ${p.type} "${p.name}" (${p.id}): ${del.status} ${detail}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reset()
    .then(() => console.log("[smoke-reset] done."))
    .catch(err => {
      console.error("[smoke-reset] FAILED:", err);
      process.exit(1);
    });
}
