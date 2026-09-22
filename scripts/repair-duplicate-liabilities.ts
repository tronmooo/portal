#!/usr/bin/env npx tsx
/**
 * repair-duplicate-liabilities.ts — duplicate-liability report 2026-09-22, data repair.
 *
 * The report: the Liabilities tab showed "Dodge Ram 2025 Auto Loan" under
 * FIXED and "Dodge Ram 2025 Auto Loan payment" under VARIABLE — one debt, two
 * profiles, disagreeing about the very payment they both described. The code
 * halves are fixed: `create_liability` no longer writes a companion
 * "<name> payment" record, and identity now runs at the storage chokepoint
 * (`storage.createProfile` → shared/liability-identity), so no door can mint
 * the pair again. This script is the third half: the rows ALREADY stored.
 *
 * ── THE RULE LIVES IN shared/, NOT HERE ──────────────────────────────────────
 * Which rows are the same liability is `sameLiability` / `findCanonicalLiability`
 * in shared/liability-identity.ts, and what the survivor keeps is
 * `mergeLiabilityRecords` from the same file. This script only reads the rows,
 * applies that answer, and repoints what pointed at the loser. Do not
 * re-implement the rule here or in SQL — one rule, pinned by
 * tests/liability-identity.test.ts.
 *
 * ── WHY THERE IS NO .sql MIGRATION ───────────────────────────────────────────
 * Identity reads account/loan/policy numbers out of a jsonb blob under a dozen
 * spellings and one level of nesting, compares them loosely (a masked "****4417"
 * against a full card number), and vetoes a match on a disagreeing creditor. A
 * SQL transcription would be a SECOND copy of that rule, free to drift from the
 * shared one — and a half-faithful copy here does not leave a duplicate behind,
 * it MERGES TWO REAL DEBTS into one. This script is the supported path; it is
 * idempotent and safe to re-run.
 *
 * ── WHAT IT CHANGES ──────────────────────────────────────────────────────────
 * For each duplicate group, the most specific record survives (a named debt
 * instrument outranks a bill shell — classificationRank):
 *   · survivor's name / type / type_key / fields ← mergeLiabilityRecords
 *   · liability_payments, liability_asset_links, liability_profile_links →
 *     repointed from the loser to the survivor
 *   · profiles.parent_profile_id → children of the loser reparented
 *   · profiles.fields.linkedLiabilityId → rewritten to the survivor
 *   · linked_profiles arrays (expenses, trackers, documents, tasks, events,
 *     habits, journal entries) → the loser's id swapped for the survivor's
 *   · the loser is SOFT-deleted (deleted_at), never hard-deleted, so a bad
 *     merge is recoverable from the row itself as well as from the backup.
 *
 * Nothing else is touched. Payment history is moved, never rewritten.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   # Dry run — the DEFAULT. Prints every group it would merge and writes nothing:
 *   npx tsx scripts/repair-duplicate-liabilities.ts
 *
 *   # Same, one user only:
 *   npx tsx scripts/repair-duplicate-liabilities.ts --user=<uuid>
 *
 *   # Apply (writes a JSON backup of every affected row first):
 *   npx tsx scripts/repair-duplicate-liabilities.ts --apply
 *
 * Credentials come from the environment (see scripts/supabase-credentials.ts):
 * VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Never hardcode or print a key.
 */

import { writeFileSync } from "fs";

import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./supabase-credentials";
import {
  sameLiability, mergeLiabilityRecords, classificationRank,
  type LiabilityRecord,
} from "../shared/liability-identity";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const USER_ID = (args.find((a) => a.startsWith("--user=")) || "").slice("--user=".length);

const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** Paginated GET via PostgREST that returns every row matching a filter. */
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

async function patch(table: string, filter: string, body: Record<string, any>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  // A table this deployment does not have is not an error: the repair must run
  // against a schema that predates a junction table as readily as one that has it.
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`PATCH ${table} failed (${res.status}): ${await res.text()}`);
}

interface ProfileRow {
  id: string;
  user_id: string;
  name: string | null;
  type: string | null;
  type_key: string | null;
  parent_profile_id: string | null;
  fields: Record<string, any> | null;
  created_at: string | null;
}

const asRecord = (r: ProfileRow): LiabilityRecord => ({
  id: r.id, name: r.name, type: r.type, type_key: r.type_key,
  parentProfileId: r.parent_profile_id, fields: r.fields || {},
});

interface Group {
  userId: string;
  survivor: ProfileRow;
  losers: ProfileRow[];
  /** What the survivor's row becomes once every loser is folded in. */
  patch: { name: string; type: string; type_key?: string; fields: Record<string, any> };
}

/**
 * Duplicate groups, one per real liability.
 *
 * Grouped per user (identity never reaches across accounts) and transitively:
 * a loan, its "… payment" bill and a third import of the same statement are
 * ONE group, not two overlapping pairs. The survivor is the most specific
 * record — a named debt instrument over a bill shell — and, at equal
 * specificity, the oldest, so the id every other table already points at is
 * the one that stays.
 */
function groupDuplicates(rows: ProfileRow[]): Group[] {
  const byUser = new Map<string, ProfileRow[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r]);

  const groups: Group[] = [];
  for (const [userId, profiles] of byUser) {
    const selfProfileId = profiles.find((p) => p.type === "self")?.id ?? null;
    const scope = { selfProfileId };
    const claimed = new Set<string>();
    for (const seed of profiles) {
      if (claimed.has(seed.id)) continue;
      const members = [seed];
      claimed.add(seed.id);
      // Transitive closure: a row that matches ANY member joins the group.
      for (let i = 0; i < members.length; i++) {
        for (const other of profiles) {
          if (claimed.has(other.id)) continue;
          if (!sameLiability(asRecord(members[i]), asRecord(other), scope)) continue;
          claimed.add(other.id);
          members.push(other);
        }
      }
      if (members.length < 2) continue;

      const ranked = members.slice().sort((a, b) => {
        const byRank = classificationRank(asRecord(b)) - classificationRank(asRecord(a));
        if (byRank !== 0) return byRank;
        return String(a.created_at || "").localeCompare(String(b.created_at || ""));
      });
      const [survivor, ...losers] = ranked;
      // Fold the losers in oldest-first, so the newest figures land last and win.
      let merged = asRecord(survivor);
      for (const loser of losers.slice().sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))) {
        const out = mergeLiabilityRecords(merged, asRecord(loser));
        merged = { ...merged, name: out.name, type: out.type, type_key: out.type_key, fields: out.fields };
      }
      groups.push({
        userId,
        survivor,
        losers,
        patch: {
          name: merged.name || survivor.name || "",
          type: merged.type || "liability",
          ...(merged.type_key ? { type_key: merged.type_key } : {}),
          fields: merged.fields || {},
        },
      });
    }
  }
  return groups;
}

async function audit(): Promise<{ groups: Group[]; scanned: number }> {
  const filter = USER_ID ? `&user_id=eq.${USER_ID}` : "";
  const rows = await selectAll<ProfileRow>(
    "profiles",
    `select=id,user_id,name,type,type_key,parent_profile_id,fields,created_at`
    + `&type=in.(liability,loan,subscription)&deleted_at=is.null${filter}`,
  );
  return { groups: groupDuplicates(rows), scanned: rows.length };
}

function printReport(r: { groups: Group[]; scanned: number }) {
  const line = "─".repeat(78);
  console.log(line);
  console.log("duplicate liabilities  (one debt stored as two or more profiles)");
  console.log(line);
  console.log(`  liability-namespace profiles scanned : ${r.scanned}`);
  console.log(`  duplicate groups found               : ${r.groups.length}`);
  console.log(`  profiles that would be retired       : ${r.groups.reduce((n, g) => n + g.losers.length, 0)}`);
  console.log(line);
  for (const g of r.groups) {
    console.log(`  KEEP   ${g.survivor.id}  "${g.patch.name}"  [${g.patch.type_key || "no subtype"}]`);
    for (const l of g.losers) {
      console.log(`  RETIRE ${l.id}  "${l.name}"  [${l.type_key || "no subtype"}]`);
    }
    console.log("");
  }
  if (r.groups.length === 0) console.log("  clean — every liability is stored exactly once.");
  console.log(line);
}

/** Tables whose `linked_profiles` is JSONB, and the one where it is a PG text[]. */
const JSONB_LINK_TABLES = ["expenses", "trackers", "documents", "tasks", "events", "habits", "incomes"];
const ARRAY_LINK_TABLES = ["journal_entries"];

const jsonbLink = (id: string) => `linked_profiles=cs.${encodeURIComponent(JSON.stringify([id]))}`;
const arrayLink = (id: string) => `linked_profiles=cs.${encodeURIComponent(`{${id}}`)}`;

/** Swap `from` for `to` in every linked_profiles array that names it. */
async function repointLinkedProfiles(userId: string, from: string, to: string): Promise<number> {
  let moved = 0;
  for (const table of JSONB_LINK_TABLES) {
    let rows: Array<{ id: string; linked_profiles: string[] | null }> = [];
    try {
      rows = await selectAll(table, `select=id,linked_profiles&user_id=eq.${userId}&${jsonbLink(from)}`);
    } catch { continue; }                       // table absent in this deployment
    for (const row of rows) {
      const next = Array.from(new Set((row.linked_profiles || []).map((v) => (v === from ? to : v))));
      await patch(table, `id=eq.${row.id}`, { linked_profiles: next });
      moved++;
    }
  }
  for (const table of ARRAY_LINK_TABLES) {
    let rows: Array<{ id: string; linked_profiles: string[] | null }> = [];
    try {
      rows = await selectAll(table, `select=id,linked_profiles&user_id=eq.${userId}&${arrayLink(from)}`);
    } catch { continue; }
    for (const row of rows) {
      const next = Array.from(new Set((row.linked_profiles || []).map((v) => (v === from ? to : v))));
      await patch(table, `id=eq.${row.id}`, { linked_profiles: next });
      moved++;
    }
  }
  return moved;
}

async function applyGroup(g: Group): Promise<void> {
  for (const loser of g.losers) {
    // Payment history and ownership move BEFORE the row is retired, so a run
    // interrupted halfway leaves the records attached to a live profile.
    await patch("liability_payments", `liability_profile_id=eq.${loser.id}`, { liability_profile_id: g.survivor.id });
    await patch("liability_asset_links", `liability_profile_id=eq.${loser.id}`, { liability_profile_id: g.survivor.id });
    await patch("profiles", `parent_profile_id=eq.${loser.id}`, { parent_profile_id: g.survivor.id });

    // Ownership links are re-pointed one at a time and only when the survivor
    // does not already carry that party: the SUM-100 ownership trigger rejects
    // a second 100% owner row, and a duplicate pair almost always carries the
    // same owner twice.
    const survivorParties = await selectAll<{ party_profile_id: string }>(
      "liability_profile_links",
      `select=party_profile_id&liability_profile_id=eq.${g.survivor.id}`,
    ).catch(() => []);
    const held = new Set(survivorParties.map((l) => l.party_profile_id));
    const loserParties = await selectAll<{ id: string; party_profile_id: string }>(
      "liability_profile_links",
      `select=id,party_profile_id&liability_profile_id=eq.${loser.id}`,
    ).catch(() => []);
    for (const link of loserParties) {
      if (held.has(link.party_profile_id)) continue;
      await patch("liability_profile_links", `id=eq.${link.id}`, { liability_profile_id: g.survivor.id });
      held.add(link.party_profile_id);
    }

    // Bills that recorded which debt they pay now point at the survivor.
    const pointers = await selectAll<{ id: string; fields: Record<string, any> | null }>(
      "profiles",
      `select=id,fields&user_id=eq.${g.userId}&fields->>linkedLiabilityId=eq.${loser.id}`,
    ).catch(() => []);
    for (const p of pointers) {
      if (p.id === g.survivor.id) continue;
      await patch("profiles", `id=eq.${p.id}`, { fields: { ...(p.fields || {}), linkedLiabilityId: g.survivor.id } });
    }

    await repointLinkedProfiles(g.userId, loser.id, g.survivor.id);

    // Soft delete, never hard: a merge this script got wrong must be
    // recoverable from the row itself, not only from the backup file.
    await patch("profiles", `id=eq.${loser.id}&deleted_at=is.null`, { deleted_at: new Date().toISOString() });
    console.log(`  retired ${loser.id} "${loser.name}" → ${g.survivor.id}`);
  }

  // The survivor last: if anything above failed, the run stops with the twin
  // still intact rather than with a half-merged survivor and a live duplicate.
  await patch("profiles", `id=eq.${g.survivor.id}`, {
    name: g.patch.name,
    type: g.patch.type,
    ...(g.patch.type_key ? { type_key: g.patch.type_key } : {}),
    fields: g.patch.fields,
  });
  console.log(`  kept    ${g.survivor.id} "${g.patch.name}" [${g.patch.type_key || "no subtype"}]`);
}

async function apply(groups: Group[]) {
  if (groups.length === 0) {
    console.log("nothing to apply — every liability is already stored exactly once.");
    return;
  }
  const backupPath = `/tmp/repair-duplicate-liabilities-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify({ timestamp: new Date().toISOString(), groups }, null, 2));
  console.log(`backup written: ${backupPath}`);

  for (const g of groups) await applyGroup(g);

  console.log("");
  console.log("re-running audit (expect 0 groups — the repair is idempotent):");
  printReport(await audit());
}

async function main() {
  const result = await audit();
  printReport(result);
  if (APPLY) {
    await apply(result.groups);
  } else {
    console.log("");
    console.log("(dry run — the default; nothing was written. Pass --apply to merge the groups above.)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
