#!/usr/bin/env npx tsx
/**
 * migrate-ownership.ts  —  FIX 3 of the data-divergence elimination plan.
 *
 * Single source of truth for each piece of ownership:
 *
 *   profile → parent           : profiles.parent_profile_id          (column)
 *   entity  → owner profiles   : <entity>.linked_profiles            (JSONB)
 *                                + profile_<type> junction table     (mirror)
 *   asset/liability % ownership: asset_party_links / liability_profile_links
 *
 * Legacy JSON shadows that lived alongside these and caused the bug:
 *
 *   profiles.fields._parentProfileId      (parent shadow)
 *   profiles.fields.owners                (multi-owner shadow array)
 *   profiles.fields.ownerIds              (multi-owner shadow array, alt key)
 *   trackers.fields.linkedProfileIds      (entity-link shadow — only trackers
 *                                          carries a `fields` column today)
 *
 * As of the last application of this script (2026-05-29) all four counts
 * are zero. The script is IDEMPOTENT and a NO-OP on a clean DB.
 *
 * Ship reason (per Stage 0-6 + FIX 0-2 plan):
 *
 *   (a) auditable replay — a future operator can run --dry-run any time and
 *       verify the post-FIX-2 invariant ("exactly one source") still holds;
 *   (b) automated cleanup if a future data import, CSV upload, or third-
 *       party migration re-introduces a shadow;
 *   (c) the --report flag prints the divergence diagnostic that proves the
 *       data is in the post-FIX-2 shape we documented.
 *
 * Usage:
 *
 *   # Audit (default; safe; no writes):
 *   npx tsx scripts/migrate-ownership.ts            (== --dry-run)
 *   npx tsx scripts/migrate-ownership.ts --report
 *
 *   # Apply (only if --dry-run shows pending work):
 *   npx tsx scripts/migrate-ownership.ts --apply
 *
 * Safety:
 *   * --dry-run is the DEFAULT; --apply must be passed explicitly.
 *   * --apply writes a backup snapshot of every affected row to a JSON file
 *     in /tmp before issuing any UPDATE.
 *   * The script never touches rows whose canonical column is already
 *     non-null and disagrees with the shadow — that's a real divergence
 *     and requires human review (it is reported, not auto-fixed).
 */

import { writeFileSync } from "fs";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://uvaniovwrezzzlzmizyg.supabase.co";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const REPORT_ONLY = args.has("--report");

const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// Helper: paginated GET via PostgREST that returns every row matching a filter.
async function selectAll<T>(table: string, query: string): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GET ${table} failed (${res.status}): ${await res.text()}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

interface ProfileRow {
  id: string;
  parent_profile_id: string | null;
  fields: Record<string, any> | null;
}

interface TrackerRow {
  id: string;
  fields: Record<string, any> | null;
}

interface AuditResult {
  parent: {
    shadowsPresent: number;
    shadowMissingColumn: ProfileRow[];
    shadowDisagrees: ProfileRow[];   // HUMAN REVIEW
    columnSet: number;
    total: number;
  };
  ownersShadow: ProfileRow[];
  ownerIdsShadow: ProfileRow[];
  trackerLinkedShadow: TrackerRow[];
}

async function audit(): Promise<AuditResult> {
  // ── profiles ─────────────────────────────────────────────────────────
  // PostgREST: `fields=cs.{"_parentProfileId":null}` is awkward; we filter
  // server-side via the `?` operator using `fields=not.is.null` and then
  // partition in JS. The profiles table is small (~hundreds of rows).
  const allProfiles = await selectAll<ProfileRow>(
    "profiles",
    "select=id,parent_profile_id,fields",
  );
  const parentShadows = allProfiles.filter(p => p.fields && Object.prototype.hasOwnProperty.call(p.fields, "_parentProfileId"));
  const parentMissingColumn = parentShadows.filter(p => p.fields?._parentProfileId && !p.parent_profile_id);
  const parentDisagrees = parentShadows.filter(p =>
    p.fields?._parentProfileId && p.parent_profile_id && p.fields._parentProfileId !== p.parent_profile_id,
  );
  const columnSet = allProfiles.filter(p => p.parent_profile_id).length;

  const ownersShadow = allProfiles.filter(p => p.fields && Object.prototype.hasOwnProperty.call(p.fields, "owners"));
  const ownerIdsShadow = allProfiles.filter(p => p.fields && Object.prototype.hasOwnProperty.call(p.fields, "ownerIds"));

  // ── trackers (the only entity table with a `fields` column) ──────────
  const allTrackers = await selectAll<TrackerRow>("trackers", "select=id,fields");
  const trackerLinkedShadow = allTrackers.filter(t => t.fields && Object.prototype.hasOwnProperty.call(t.fields, "linkedProfileIds"));

  return {
    parent: {
      shadowsPresent: parentShadows.length,
      shadowMissingColumn: parentMissingColumn,
      shadowDisagrees: parentDisagrees,
      columnSet,
      total: allProfiles.length,
    },
    ownersShadow,
    ownerIdsShadow,
    trackerLinkedShadow,
  };
}

function printReport(a: AuditResult) {
  console.log("─".repeat(72));
  console.log("ownership audit  (canonical sources vs. legacy JSON shadows)");
  console.log("─".repeat(72));
  console.log(`  profiles total                                          : ${a.parent.total}`);
  console.log(`    parent_profile_id column set                          : ${a.parent.columnSet}`);
  console.log(`    fields._parentProfileId shadows present (any value)   : ${a.parent.shadowsPresent}`);
  console.log(`    column null but shadow set                            : ${a.parent.shadowMissingColumn.length}`);
  console.log(`    column SET but disagrees with shadow                  : ${a.parent.shadowDisagrees.length}  ${a.parent.shadowDisagrees.length ? "  ←  HUMAN REVIEW" : ""}`);
  console.log(`    profiles with stale fields.owners                     : ${a.ownersShadow.length}`);
  console.log(`    profiles with stale fields.ownerIds                   : ${a.ownerIdsShadow.length}`);
  console.log(`  trackers with stale fields.linkedProfileIds             : ${a.trackerLinkedShadow.length}`);
  console.log("─".repeat(72));
  const totalShadows =
    a.parent.shadowsPresent +
    a.ownersShadow.length +
    a.ownerIdsShadow.length +
    a.trackerLinkedShadow.length;
  if (a.parent.shadowDisagrees.length > 0) {
    console.log("  STATUS: divergence detected. --apply REFUSES to touch disagreeing rows.");
  } else if (totalShadows === 0) {
    console.log("  STATUS: clean — canonical sources are the only sources.");
  } else {
    console.log(`  STATUS: ${totalShadows} stale shadow keys can be safely stripped with --apply.`);
  }
}

async function patchProfileFields(id: string, newFields: Record<string, any>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ fields: newFields }),
  });
  if (!res.ok) throw new Error(`PATCH profiles ${id} failed (${res.status}): ${await res.text()}`);
}

async function patchProfileFieldsAndParent(
  id: string,
  newFields: Record<string, any>,
  parentProfileId: string,
): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ fields: newFields, parent_profile_id: parentProfileId }),
  });
  if (!res.ok) throw new Error(`PATCH profiles ${id} failed (${res.status}): ${await res.text()}`);
}

async function patchTrackerFields(id: string, newFields: Record<string, any>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trackers?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ fields: newFields }),
  });
  if (!res.ok) throw new Error(`PATCH trackers ${id} failed (${res.status}): ${await res.text()}`);
}

async function apply(a: AuditResult) {
  if (a.parent.shadowDisagrees.length > 0) {
    console.error(`REFUSING --apply: parent_profile_id disagrees with fields._parentProfileId on ${a.parent.shadowDisagrees.length} rows. Human review required.`);
    for (const r of a.parent.shadowDisagrees.slice(0, 5)) {
      console.error(`  ${r.id}: column=${r.parent_profile_id}  shadow=${r.fields?._parentProfileId}`);
    }
    process.exit(2);
  }

  const backup = {
    timestamp: new Date().toISOString(),
    parent_shadows: a.parent.shadowMissingColumn.concat(
      // shadows that agree with the column — strip-only:
      // we identify by "shadow present and either column matches or shadow is null"
      // For backup completeness, capture every shadowed row's pre-state.
    ),
    owners_shadows: a.ownersShadow,
    ownerIds_shadows: a.ownerIdsShadow,
    tracker_linked_shadows: a.trackerLinkedShadow,
  };
  // Full backup of every row with any shadow:
  const fullShadowProfiles = [
    ...a.parent.shadowMissingColumn,
    ...a.ownersShadow,
    ...a.ownerIdsShadow,
    // Note: rows with parent shadow that AGREE with column are not in any of
    // the above; capture them too:
  ];
  const seen = new Set(fullShadowProfiles.map(p => p.id));
  // We need all parent-shadow rows even if they agree; rebuild from the audit
  // by combining categories. The audit doesn't currently track "agreeing"
  // separately, but for safety we'll re-fetch the full set.
  if (a.parent.shadowsPresent > fullShadowProfiles.filter(p => p.fields?._parentProfileId).length) {
    const everyParentShadow = await selectAll<ProfileRow>(
      "profiles",
      "select=id,parent_profile_id,fields&fields=not.is.null",
    );
    for (const p of everyParentShadow) {
      if (p.fields && Object.prototype.hasOwnProperty.call(p.fields, "_parentProfileId") && !seen.has(p.id)) {
        fullShadowProfiles.push(p);
        seen.add(p.id);
      }
    }
  }
  backup.parent_shadows = fullShadowProfiles;

  if (
    a.parent.shadowsPresent === 0 &&
    a.ownersShadow.length === 0 &&
    a.ownerIdsShadow.length === 0 &&
    a.trackerLinkedShadow.length === 0
  ) {
    console.log("nothing to apply — DB is already clean.");
    return;
  }

  const backupPath = `/tmp/migrate-ownership-backup-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`backup written: ${backupPath}`);

  let patched = 0;

  // 1. Profiles with parent shadow missing column → backfill column, strip shadow.
  for (const p of a.parent.shadowMissingColumn) {
    const newFields = { ...(p.fields || {}) };
    const newParent = newFields._parentProfileId;
    delete newFields._parentProfileId;
    delete newFields.owners;
    delete newFields.ownerIds;
    await patchProfileFieldsAndParent(p.id, newFields, newParent);
    patched++;
  }

  // 2. Profiles with ANY shadow (parent agreeing, owners, ownerIds) → strip.
  const allShadowProfiles = new Map<string, ProfileRow>();
  for (const p of fullShadowProfiles) allShadowProfiles.set(p.id, p);
  for (const p of a.ownersShadow) allShadowProfiles.set(p.id, p);
  for (const p of a.ownerIdsShadow) allShadowProfiles.set(p.id, p);
  // Remove the ones we already handled (backfill + strip happened above).
  for (const p of a.parent.shadowMissingColumn) allShadowProfiles.delete(p.id);

  for (const p of allShadowProfiles.values()) {
    const newFields = { ...(p.fields || {}) };
    delete newFields._parentProfileId;
    delete newFields.owners;
    delete newFields.ownerIds;
    await patchProfileFields(p.id, newFields);
    patched++;
  }
  console.log(`  profiles patched: ${patched}`);

  // 3. Trackers: strip linkedProfileIds shadow.
  let trackerPatched = 0;
  for (const t of a.trackerLinkedShadow) {
    const newFields = { ...(t.fields || {}) };
    delete newFields.linkedProfileIds;
    await patchTrackerFields(t.id, newFields);
    trackerPatched++;
  }
  if (trackerPatched) console.log(`  trackers patched: ${trackerPatched}`);

  console.log("apply complete. Re-running audit:");
  const after = await audit();
  printReport(after);
}

async function main() {
  const result = await audit();
  printReport(result);
  if (REPORT_ONLY) return;
  if (APPLY) {
    await apply(result);
  } else {
    console.log("");
    console.log("(read-only audit; pass --apply to backfill + strip shadows)");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
