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
    await api("DELETE", `/profiles/${p.id}`);
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
