#!/usr/bin/env npx tsx
/**
 * heal-per-set-lift-entries.ts — backfill for the 2026-08-02 "3 pounds" bug.
 *
 * The chat logged lifts with the load written per set as a STRING:
 *
 *   { sets: 3, reps: "10/8/6", weight: "70/80/80", totalVolume: 2100 }
 *
 * Nothing downstream could read those strings as numbers, so the tracker card
 * borrowed the only number it could find — the SET COUNT — and printed it with
 * a hardcoded "lbs": an Incline Dumbbell Press card read "3 lbs".
 *
 * The code fix (shared/strength-entry.ts + the normalizer) means no NEW entry
 * can be written this way. This script repairs the entries already stored, by
 * running them through the exact same expandStrengthSetLists() the normalizer
 * uses — so healed rows are byte-identical to what the fixed write path would
 * have produced:
 *
 *   weight "70/80/80" → weight 80 (top set) + weightPerSet "70/80/80"
 *   reps   "10/8/6"   → reps 8 (that set's reps) + repsPerSet "10/8/6"
 *   totalVolume       → Σ(weightᵢ × repsᵢ), correcting the model's arithmetic
 *
 * Nothing is dropped: every per-set value the user logged is preserved in the
 * *PerSet companion field, and notes are untouched. Entries whose load isn't a
 * clean numeric list (e.g. "+35/+45/bodyweight" on Weighted Pull-Ups) are left
 * exactly as they are and reported as skipped.
 *
 * Usage:
 *   npx tsx scripts/heal-per-set-lift-entries.ts             # dry run (default)
 *   npx tsx scripts/heal-per-set-lift-entries.ts --apply     # write
 *
 * Safety:
 *   * --dry-run is the DEFAULT; --apply must be passed explicitly.
 *   * --apply writes a backup of every affected row to /tmp before any UPDATE.
 *   * Idempotent: a healed row has no list left to expand, so a second run is
 *     a no-op.
 */

import { writeFileSync } from "fs";
import { expandStrengthSetLists } from "../shared/strength-entry";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://uvaniovwrezzzlzmizyg.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");

if (!SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required (export it, or run with the key in the environment).");
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

interface EntryRow {
  id: string;
  tracker_id: string;
  timestamp: string;
  entry_values: Record<string, any> | null;
}

async function selectAll<T>(table: string, query: string): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=${pageSize}&offset=${offset}`, { headers });
    if (!res.ok) throw new Error(`GET ${table} failed (${res.status}): ${await res.text()}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

/** Does this row still hold a per-set string in a numeric metric field? */
function needsHeal(values: Record<string, any> | null): boolean {
  if (!values) return false;
  const listLike = /^\s*\d+(\.\d+)?\s*[a-z]*\s*([/,]\s*\d+(\.\d+)?\s*[a-z]*\s*)+$/i;
  return Object.entries(values).some(([k, v]) =>
    /^(weight|weightlbs|weight_lbs|lbs|load|reps|sets)$/i.test(k) && typeof v === "string" && listLike.test(v));
}

async function main() {
  const trackers = await selectAll<{ id: string; name: string }>("trackers", "select=id,name");
  const trackerName = new Map(trackers.map((t) => [t.id, t.name]));

  const entries = await selectAll<EntryRow>(
    "tracker_entries",
    "select=id,tracker_id,timestamp,entry_values&deleted_at=is.null",
  );

  const candidates = entries.filter((e) => needsHeal(e.entry_values));
  const planned: Array<{ row: EntryRow; next: Record<string, any>; warnings: string[] }> = [];
  const skipped: EntryRow[] = [];

  for (const row of candidates) {
    const { values, warnings } = expandStrengthSetLists(row.entry_values || {});
    if (warnings.length === 0) { skipped.push(row); continue; }
    planned.push({ row, next: values, warnings });
  }

  console.log(`\nScanned ${entries.length} entries — ${candidates.length} carry a per-set string.\n`);
  for (const p of planned) {
    console.log(`• ${trackerName.get(p.row.tracker_id) || p.row.tracker_id} — ${p.row.timestamp.slice(0, 10)}`);
    console.log(`    before: ${JSON.stringify(p.row.entry_values)}`);
    console.log(`    after:  ${JSON.stringify(p.next)}`);
    for (const w of p.warnings) console.log(`    · ${w}`);
  }
  for (const s of skipped) {
    console.log(`• SKIP ${trackerName.get(s.tracker_id) || s.tracker_id} — ${s.timestamp.slice(0, 10)}: load isn't a clean numeric list, left untouched`);
    console.log(`    ${JSON.stringify(s.entry_values)}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. ${planned.length} entr${planned.length === 1 ? "y" : "ies"} would be healed. Re-run with --apply to write.\n`);
    return;
  }

  const backupPath = `/tmp/per-set-lift-entries-backup-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify(planned.map((p) => p.row), null, 2));
  console.log(`\nBackup of ${planned.length} rows written to ${backupPath}`);

  let ok = 0;
  for (const p of planned) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tracker_entries?id=eq.${p.row.id}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ entry_values: p.next }),
    });
    if (!res.ok) { console.error(`  FAILED ${p.row.id}: ${res.status} ${await res.text()}`); continue; }
    ok++;
  }
  console.log(`\nHealed ${ok}/${planned.length} entries.\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
