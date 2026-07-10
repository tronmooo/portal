// ── System validate / repair / refresh tools ─────────────────────────────────
// Read-mostly diagnostics the chat exposes so the user can ask "is my data
// healthy?" without leaving the conversation:
//   findOrphans / repairRelations   → wrap the existing ownership-consistency
//                                     scan + repair (storage P0.5)
//   validateProfileIsolation        → every record's linkedProfiles ⊆ the
//                                     user's profile ids (orphans = self, valid)
//   findDuplicates                  → per-entity heuristics, candidates ONLY
//   refreshDashboard                → bust the per-user response caches + bump
//                                     the data version, return fresh counts
//   validateDashboardCounts         → recompute tile counts from raw lists and
//                                     diff against getStats
import type { IStorage } from "./storage";
import { getEntityList, getEntityName, BULK_ENTITY_TYPES } from "./ai-envelope";
import { bustAllUserCaches } from "./cache-bus";
import { normalizePersonName, PERSON_PROFILE_TYPES } from "../shared/profile-dedup";

const norm = (s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Content types scanned by the integrity tools (profiles handled separately).
const SCAN_TYPES = BULK_ENTITY_TYPES.filter((t) => t !== "profile" && t !== "obligation");

export async function findOrphans(storage: IStorage): Promise<any> {
  if (typeof (storage as any).getOwnershipConsistency !== "function") {
    return { error: "Orphan scan isn't available in this deployment." };
  }
  const result = await (storage as any).getOwnershipConsistency();
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  return {
    scanned: result?.scanned ?? undefined,
    issue_count: issues.length,
    issues: issues.slice(0, 25),
    message: issues.length === 0
      ? "No orphaned or inconsistent ownership records found — everything is linked to a valid profile."
      : `Found ${issues.length} ownership issue${issues.length === 1 ? "" : "s"} (showing up to 25). Say "repair my data" to fix them.`,
  };
}

export async function repairRelations(storage: IStorage): Promise<any> {
  if (typeof (storage as any).repairOwnershipConsistency !== "function") {
    return { error: "Ownership repair isn't available in this deployment." };
  }
  const summary = await (storage as any).repairOwnershipConsistency();
  return {
    ...summary,
    message: `Repair complete: ${summary.repaired} of ${summary.scanned} scanned record${summary.scanned === 1 ? "" : "s"} fixed.`,
  };
}

export async function validateProfileIsolation(storage: IStorage): Promise<any> {
  const profiles = await storage.getProfiles();
  const ids = new Set(profiles.map((p: any) => p.id));
  const violations: Array<{ type: string; id: string; name: string; unknown_profile_ids: string[] }> = [];
  let scanned = 0;
  for (const type of SCAN_TYPES) {
    const listP = getEntityList(storage, type);
    if (!listP) continue;
    let rows: any[] = [];
    try { rows = await listP; } catch { continue; }
    for (const r of rows) {
      scanned++;
      const linked: string[] = Array.isArray(r.linkedProfiles) ? r.linkedProfiles : [];
      // Empty linkage = belongs to self by the app-wide scope rule — valid.
      const unknown = linked.filter((id) => !ids.has(id));
      if (unknown.length > 0 && violations.length < 25) {
        violations.push({ type, id: r.id, name: getEntityName(type, r), unknown_profile_ids: unknown });
      }
    }
  }
  return {
    scanned,
    isolation_valid: violations.length === 0,
    violations,
    message: violations.length === 0
      ? `Profile isolation is intact — all ${scanned} records link only to your ${ids.size} profiles.`
      : `${violations.length} record(s) reference profile ids that aren't yours (stale links). Say "repair my data" to clean them up.`,
  };
}

export async function findDuplicates(storage: IStorage, entityType?: string): Promise<any> {
  const groups: Array<{ type: string; name: string; count: number; ids: string[] }> = [];

  const collect = (type: string, rows: any[], keyFn: (r: any) => string) => {
    const byKey = new Map<string, any[]>();
    for (const r of rows) {
      const k = keyFn(r);
      if (!k) continue;
      (byKey.get(k) || byKey.set(k, []).get(k)!).push(r);
    }
    for (const dup of byKey.values()) {
      if (dup.length > 1 && groups.length < 25) {
        groups.push({ type, name: getEntityName(type, dup[0]), count: dup.length, ids: dup.map((r) => r.id) });
      }
    }
  };

  const wanted = entityType ? [norm(entityType)] : ["profile", ...SCAN_TYPES];
  for (const type of wanted) {
    if (type === "profile") {
      const profiles = await storage.getProfiles();
      // Person-type profiles use the shared dedup normalizer; assets/etc.
      // match on normalized name + type (a "Honda" vehicle and a "Honda"
      // liability are NOT duplicates of each other).
      collect("profile", profiles, (p: any) =>
        PERSON_PROFILE_TYPES.has(p.type)
          ? `person:${normalizePersonName(p.name)}`
          : `${p.type}:${norm(p.name)}`);
      continue;
    }
    const listP = getEntityList(storage, type);
    if (!listP) continue;
    let rows: any[] = [];
    try { rows = await listP; } catch { continue; }
    if (type === "expense") {
      // Same normalized description + amount within 1% + date within 3 days.
      const seen: any[] = [];
      for (const r of rows) {
        const match = seen.find((s) =>
          norm(s.description) === norm(r.description)
          && Math.abs(Number(s.amount) - Number(r.amount)) <= Math.abs(Number(s.amount)) * 0.01
          && Math.abs(new Date(s.date || s.createdAt || 0).getTime() - new Date(r.date || r.createdAt || 0).getTime()) <= 3 * 86400000);
        if (match) {
          const g = groups.find((x) => x.type === "expense" && x.ids.includes(match.id));
          if (g) { g.count++; g.ids.push(r.id); }
          else if (groups.length < 25) groups.push({ type: "expense", name: getEntityName("expense", r), count: 2, ids: [match.id, r.id] });
        } else seen.push(r);
      }
      continue;
    }
    // Default heuristic: identical normalized name + identical profile links.
    collect(type, rows, (r: any) => {
      const n = norm(getEntityName(type, r));
      if (!n) return "";
      const links = Array.isArray(r.linkedProfiles) ? [...r.linkedProfiles].sort().join(",") : "";
      return `${n}|${links}`;
    });
  }

  return {
    duplicate_groups: groups,
    count: groups.length,
    message: groups.length === 0
      ? "No likely duplicates found."
      : `Found ${groups.length} likely duplicate group${groups.length === 1 ? "" : "s"} (candidates only — nothing was merged or deleted). Tell me which to clean up.`,
  };
}

export async function refreshDashboard(storage: IStorage, userId: string): Promise<any> {
  const busted = bustAllUserCaches(userId);
  try { await (storage as any).bumpDataVersion?.(); } catch { /* best effort */ }
  const stats = await storage.getStats();
  return {
    refreshed: true,
    caches_busted: busted > 0,
    counts: {
      profiles: stats.totalProfiles, trackers: stats.totalTrackers,
      tasks: stats.totalTasks, active_tasks: stats.activeTasks,
      expenses: stats.totalExpenses, events: stats.totalEvents,
      habits: stats.totalHabits, obligations: stats.totalObligations,
    },
    message: "Dashboard refreshed — caches cleared and counts recomputed from the database.",
  };
}

export async function validateDashboardCounts(storage: IStorage): Promise<any> {
  const [stats, profiles, trackers, tasks, expenses, events, habits, obligations] = await Promise.all([
    storage.getStats(), storage.getProfiles(), storage.getTrackers(), storage.getTasks(),
    storage.getExpenses(), storage.getEvents(), storage.getHabits(), storage.getObligations(),
  ]);
  const fresh: Record<string, number> = {
    profiles: profiles.length, trackers: trackers.length, tasks: tasks.length,
    expenses: expenses.length, events: events.length, habits: habits.length,
    obligations: obligations.length,
  };
  const reported: Record<string, number> = {
    profiles: stats.totalProfiles, trackers: stats.totalTrackers, tasks: stats.totalTasks,
    expenses: stats.totalExpenses, events: stats.totalEvents, habits: stats.totalHabits,
    obligations: stats.totalObligations,
  };
  const mismatches = Object.keys(fresh)
    .filter((k) => fresh[k] !== reported[k])
    .map((k) => ({ tile: k, dashboard_shows: reported[k], database_has: fresh[k] }));
  return {
    valid: mismatches.length === 0,
    counts: fresh,
    mismatches,
    message: mismatches.length === 0
      ? "Dashboard counts match the database exactly."
      : `${mismatches.length} tile count(s) disagree with the database — say "refresh my dashboard" to clear stale caches.`,
  };
}
