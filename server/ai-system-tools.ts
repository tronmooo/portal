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

// ── Misclassified profiles: objects filed as people ─────────────────────────
//
// Cleanup for damage the create_profile type fallback did before it was fixed
// (2026-08-09). An absent/invalid `type` on create_profile silently defaulted
// to "person", so "Create a profile for my MacBook Pro m4" left a PERSON row
// named "my MacBook Pro m4" sitting in the profile picker next to real people,
// in owner badges, and in ownership attribution.
//
// The guard stops new ones. These two functions clean up the rows already
// written — no user should have to hand-delete them.
//
// DETECTION IS DELIBERATELY NARROW. The only signal used is a leading
// first-person determiner ("my ", "our ") on a person/pet-typed profile. No
// human is named "my MacBook Pro m4", so this cannot mistake a real person for
// an object — which is the failure that would actually hurt. Objects filed as
// people under an ordinary name are NOT touched; guessing which names are
// people is exactly the kind of inference that caused this mess.

const DETERMINER_PREFIX = /^(?:my|our)['’ʼ]?\s+/i;

/** Identity types an object should never carry. "self" is excluded from the
 *  scan entirely — the user's own profile is never touched. */
const MISFILED_AS = new Set(["person", "pet"]);

/** Fields that only ever belong to a real human — a safety brake. */
const HUMAN_FIELD_KEYS = ["phone", "email", "relationship", "birthday", "dateOfBirth", "ssn"];

export interface MisclassifiedProfile {
  id: string;
  name: string;
  type: string;
  /** Name with the determiner removed — what it should have been called. */
  suggestedName: string;
  /** "delete_duplicate" when the real asset already exists; "retype" otherwise. */
  action: "delete_duplicate" | "retype";
  duplicateOfId?: string;
  duplicateOfName?: string;
}

function scanMisclassified(profiles: any[]): MisclassifiedProfile[] {
  const out: MisclassifiedProfile[] = [];
  const byName = new Map<string, any>();
  for (const p of profiles) {
    if (MISFILED_AS.has(String(p.type)) || String(p.type) === "self") continue;
    byName.set(norm(p.name), p);
  }

  for (const p of profiles) {
    const type = String(p.type || "");
    // Only person/pet rows can be this bug, and never the self profile.
    if (!MISFILED_AS.has(type)) continue;
    const name = String(p.name || "");
    if (!DETERMINER_PREFIX.test(name)) continue;

    // Safety brake: a row carrying real human fields is a person the user
    // named oddly, not an object. Leave it alone.
    const fields = (p.fields && typeof p.fields === "object") ? p.fields : {};
    if (HUMAN_FIELD_KEYS.some((k) => fields[k] != null && fields[k] !== "")) continue;

    const suggestedName = name.replace(DETERMINER_PREFIX, "").trim();
    if (suggestedName.length < 2) continue;

    // Is the real asset already there? Then this row is the twin the fan-out
    // bug created, and the right repair is to remove it, not rename it.
    const twin = byName.get(norm(suggestedName));
    // A row with children can't be deleted without orphaning them — retype it.
    const hasChildren = profiles.some((c: any) => c.parentProfileId === p.id);

    out.push(
      twin && !hasChildren
        ? {
            id: p.id, name, type, suggestedName,
            action: "delete_duplicate", duplicateOfId: twin.id, duplicateOfName: String(twin.name),
          }
        : { id: p.id, name, type, suggestedName, action: "retype" },
    );
  }
  return out;
}

/** Read-only report. Safe to run at any time. */
export async function findMisclassifiedProfiles(storage: IStorage): Promise<any> {
  const profiles = await storage.getProfiles();
  const issues = scanMisclassified(profiles);
  return {
    scanned: profiles.length,
    issue_count: issues.length,
    issues: issues.slice(0, 25),
    message: issues.length === 0
      ? "No misclassified profiles — nothing of yours is filed as a person by mistake."
      : `Found ${issues.length} profile${issues.length === 1 ? "" : "s"} filed as a person that ${issues.length === 1 ? "is" : "are"} actually ${issues.length === 1 ? "an object" : "objects"}: ${issues.slice(0, 5).map((i) => `"${i.name}"`).join(", ")}. Say "fix them" and I'll ${issues.some((i) => i.action === "delete_duplicate") ? "remove the duplicates and retype the rest" : "retype them as assets"}.`,
  };
}

/**
 * Execute the repair. Deletes are SOFT (profiles are in SOFT_DELETE_TYPES), so
 * every change here is recoverable if the scan got something wrong.
 */
export async function repairMisclassifiedProfiles(storage: IStorage): Promise<any> {
  const profiles = await storage.getProfiles();
  const issues = scanMisclassified(profiles);
  const repaired: Array<{ name: string; action: string; detail: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const issue of issues) {
    try {
      if (issue.action === "delete_duplicate") {
        await storage.deleteProfile(issue.id);
        repaired.push({
          name: issue.name,
          action: "removed duplicate",
          detail: `merged into the existing "${issue.duplicateOfName}"`,
        });
      } else {
        await storage.updateProfile(issue.id, { type: "asset", name: issue.suggestedName } as any);
        repaired.push({
          name: issue.name,
          action: "retyped as asset",
          detail: `renamed to "${issue.suggestedName}"`,
        });
      }
    } catch (e: any) {
      failed.push({ name: issue.name, error: e?.message || "unknown error" });
    }
  }

  return {
    scanned: profiles.length,
    repaired_count: repaired.length,
    repaired,
    ...(failed.length > 0 ? { failed } : {}),
    message: repaired.length === 0
      ? (failed.length > 0
          ? `Couldn't repair ${failed.length} profile(s).`
          : "Nothing to repair — no profiles are misclassified.")
      : `Cleaned up ${repaired.length} profile${repaired.length === 1 ? "" : "s"}: ${repaired.map((r) => `"${r.name}" ${r.action}`).join(", ")}. Deletes are recoverable if any of that was wrong.`,
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
