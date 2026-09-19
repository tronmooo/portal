#!/usr/bin/env npx tsx
/**
 * repair-mistyped-person-profiles.ts — QA 2026-09-18 finding F-04, data repair.
 *
 * The report: the profile switcher listed "tires for my Dodge ram" and "my
 * MacBook Pro m4" as people, so they were offered in the loan's "+ Add owner…"
 * dropdown and in New Event → "Link to Profiles". Two halves were fixed in the
 * code: the AI create path now coerces an asset-shaped name away from a person
 * type (`coerceProfileType`), and every people picker filters through
 * `isOfferablePerson`. This script is the third half: the rows ALREADY stored
 * with `type = 'person'`.
 *
 * ── THE RULE LIVES IN shared/, NOT HERE ──────────────────────────────────────
 * The decision is `isSafeToRetypeAsThing(profile, evidence)` in
 * shared/entity-classify.ts, next to `coerceProfileType`, and this script only
 * gathers the evidence and applies the answer. Do not re-implement the
 * heuristic here or in SQL — one rule, pinned by
 * tests/qa-2026-09-19-profile-retype.test.ts.
 *
 * ── WHY THERE IS NO .sql MIGRATION ───────────────────────────────────────────
 * A migration under migrations/ was considered and deliberately NOT written.
 * The safe rule is not expressible in faithful SQL:
 *
 *   · `looksLikeAssetName` is a multi-branch TypeScript matcher over hundreds of
 *     make/model/product words plus model-number shapes. A SQL transcription is
 *     a SECOND copy of the heuristic that will drift from the shared one — the
 *     exact failure mode ARCHITECTURE.md §1 forbids.
 *   · The exclusion side needs `fieldIdentity` normalization over the jsonb
 *     blob INCLUDING its nested display groups (`personal`, `identity`,
 *     `health`, `contact`…), so `date_of_birth`, `dob` and `birthDate` all read
 *     as one field. In SQL that is an unreadable lateral over jsonb_each with a
 *     hand-maintained alias table.
 *   · The record side spans five tables with two different link column TYPES
 *     (`linked_profiles` is jsonb on trackers/habits/documents, text[] on
 *     journal_entries) plus `isHealthDocument`, itself a shared classifier.
 *
 * A half-faithful SQL rule would retype real people. This script is the
 * supported path; it is idempotent and safe to re-run.
 *
 * ── WHAT IT CHANGES ──────────────────────────────────────────────────────────
 * `profiles.type`: 'person' → 'vehicle' | 'asset', for rows the shared rule
 * clears. `profiles.type_key` is cleared only when it holds a people key
 * ('person' / 'self' / 'pet'), which would otherwise keep rendering the person
 * registry form on a thing. Nothing else is touched — no name, no fields, no
 * links, no deletes.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   # Dry run — the DEFAULT. Prints every row it would retype and every row it
 *   # skipped with the reason, and writes nothing:
 *   npx tsx scripts/repair-mistyped-person-profiles.ts
 *
 *   # Same, one user only:
 *   npx tsx scripts/repair-mistyped-person-profiles.ts --user=<uuid>
 *
 *   # Apply (writes a JSON backup of every affected row first):
 *   npx tsx scripts/repair-mistyped-person-profiles.ts --apply
 *
 * Credentials come from the environment (see scripts/supabase-credentials.ts):
 * VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Never hardcode or print a key.
 */

import { writeFileSync } from "fs";

import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./supabase-credentials";
import {
  coerceProfileType,
  isSafeToRetypeAsThing,
  personFieldEvidence,
  type HumanRecordEvidence,
  type ThingProfileType,
} from "../shared/entity-classify";
import { isHealthDocument } from "../shared/health-documents";

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

interface ProfileRow {
  id: string;
  user_id: string;
  name: string | null;
  type: string | null;
  type_key: string | null;
  fields: Record<string, any> | null;
}

interface TrackerRow { id: string; category: string | null }
interface DocumentRow { id: string; name: string | null; type: string | null; tags: string[] | null }

// linked_profiles is JSONB on trackers/habits/documents → `cs.["<id>"]`, but a
// PG text[] on journal_entries → `cs.{<id>}`. Getting this wrong silently
// returns zero rows (see the note in server/supabase-storage.ts), which here
// would read as "no evidence" and retype a person. Both spellings are explicit.
const jsonbLink = (id: string) => `linked_profiles=cs.${encodeURIComponent(JSON.stringify([id]))}`;
const arrayLink = (id: string) => `linked_profiles=cs.${encodeURIComponent(`{${id}}`)}`;

const scope = (userId: string) => `user_id=eq.${userId}&deleted_at=is.null`;

/**
 * The human-only records attributed to one profile.
 *
 * Counted (any of them blocks a retype): trackers linked to the row and the
 * entries under them, habits, journal entries, medication trackers, and linked
 * documents that `isHealthDocument` accepts.
 *
 * NOT counted, deliberately: tasks, events, expenses and ordinary documents. A
 * car has a registration task, a renewal event, a fuel expense and a title
 * document, so they carry no signal about being a person — blocking on them
 * would make the repair a no-op on exactly the rows F-04 is about.
 *
 * A linked tracker counts even with zero entries. That is stricter than
 * "tracker entries": it means a mistyped vehicle carrying a mileage tracker is
 * left alone for a human to judge. A missed repair costs nothing (the people
 * pickers already filter the row out); a wrong retype is silent corruption.
 */
async function gatherEvidence(p: ProfileRow): Promise<HumanRecordEvidence> {
  const [trackers, habits, journal, documents] = await Promise.all([
    selectAll<TrackerRow>("trackers", `select=id,category&${scope(p.user_id)}&${jsonbLink(p.id)}`),
    selectAll<{ id: string }>("habits", `select=id&${scope(p.user_id)}&${jsonbLink(p.id)}`),
    selectAll<{ id: string }>("journal_entries", `select=id&${scope(p.user_id)}&${arrayLink(p.id)}`),
    selectAll<DocumentRow>("documents", `select=id,name,type,tags&${scope(p.user_id)}&${jsonbLink(p.id)}`),
  ]);

  let trackerEntries = 0;
  if (trackers.length > 0) {
    const ids = trackers.map((t) => t.id).join(",");
    const rows = await selectAll<{ id: string }>(
      "tracker_entries",
      `select=id&${scope(p.user_id)}&tracker_id=in.(${ids})`,
    );
    trackerEntries = rows.length;
  }

  return {
    trackers: trackers.length,
    trackerEntries,
    habits: habits.length,
    journalEntries: journal.length,
    medications: trackers.filter((t) => String(t.category || "").toLowerCase() === "medication").length,
    healthDocuments: documents.filter((d) => isHealthDocument(d)).length,
  };
}

const evidenceNotes = (e: HumanRecordEvidence): string[] =>
  Object.entries(e)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([k, n]) => `${k}=${n}`);

interface Verdict {
  profile: ProfileRow;
  target: ThingProfileType | null;
  why: string;
}

async function audit(): Promise<{ retype: Verdict[]; skipped: Verdict[]; scanned: number }> {
  const filter = USER_ID ? `&user_id=eq.${USER_ID}` : "";
  const people = await selectAll<ProfileRow>(
    "profiles",
    `select=id,user_id,name,type,type_key,fields&type=eq.person&deleted_at=is.null${filter}`,
  );

  // Only rows whose NAME is asset-shaped are worth a round trip for evidence;
  // the shared rule re-checks the name itself, this is just the cheap prefilter.
  const candidates = people.filter((p) => coerceProfileType(p.name, "person") !== "person");

  const retype: Verdict[] = [];
  const skipped: Verdict[] = [];
  for (const p of candidates) {
    const fieldHits = personFieldEvidence(p.fields);
    const evidence = await gatherEvidence(p);
    const target = isSafeToRetypeAsThing(p, evidence);
    if (target) {
      retype.push({
        profile: p,
        target,
        why: `asset-shaped name; no person field; no human-only record`,
      });
    } else {
      const reasons = [
        ...(fieldHits.length ? [`person fields: ${fieldHits.join(", ")}`] : []),
        ...evidenceNotes(evidence),
      ];
      skipped.push({ profile: p, target: null, why: reasons.join("; ") || "shared rule declined" });
    }
  }
  return { retype, skipped, scanned: people.length };
}

function printReport(r: { retype: Verdict[]; skipped: Verdict[]; scanned: number }) {
  const line = "─".repeat(78);
  console.log(line);
  console.log("mistyped person profiles  (F-04: assets stored as people)");
  console.log(line);
  console.log(`  profiles typed 'person' scanned            : ${r.scanned}`);
  console.log(`  asset-shaped AND clear of person evidence  : ${r.retype.length}`);
  console.log(`  asset-shaped but LEFT ALONE (has evidence) : ${r.skipped.length}`);
  console.log(line);
  if (r.retype.length) {
    console.log("WOULD RETYPE:");
    for (const v of r.retype) {
      console.log(`  ${v.profile.id}  "${v.profile.name}"  ${v.profile.type} → ${v.target}`);
      console.log(`      why: ${v.why}`);
    }
  }
  if (r.skipped.length) {
    console.log("LEFT AS person (evidence of a human — human review only):");
    for (const v of r.skipped) {
      console.log(`  ${v.profile.id}  "${v.profile.name}"`);
      console.log(`      why: ${v.why}`);
    }
  }
  if (!r.retype.length && !r.skipped.length) console.log("  clean — no person row has an asset-shaped name.");
  console.log(line);
}

const PEOPLE_TYPE_KEYS = new Set(["person", "self", "pet"]);

async function apply(retype: Verdict[]) {
  if (retype.length === 0) {
    console.log("nothing to apply — no row met the safe-retype rule.");
    return;
  }
  const backupPath = `/tmp/repair-mistyped-person-profiles-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify({ timestamp: new Date().toISOString(), rows: retype }, null, 2));
  console.log(`backup written: ${backupPath}`);

  let patched = 0;
  for (const v of retype) {
    const body: Record<string, any> = { type: v.target };
    // A leftover people type_key would keep drawing the person registry form on
    // a thing; anything else (a real subtype) is left exactly as stored.
    if (PEOPLE_TYPE_KEYS.has(String(v.profile.type_key || "").toLowerCase())) body.type_key = null;
    // Guarded on type=eq.person: a row someone fixed since the audit read is
    // not re-typed, which is what keeps a concurrent re-run harmless.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${v.profile.id}&type=eq.person`,
      { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`PATCH profiles ${v.profile.id} failed (${res.status}): ${await res.text()}`);
    console.log(`  retyped ${v.profile.id} "${v.profile.name}" → ${v.target}`);
    patched++;
  }
  console.log(`profiles retyped: ${patched}`);
  console.log("re-running audit (expect 0 to retype — the repair is idempotent):");
  printReport(await audit());
}

async function main() {
  const result = await audit();
  printReport(result);
  if (APPLY) {
    await apply(result.retype);
  } else {
    console.log("");
    console.log("(dry run — the default; nothing was written. Pass --apply to retype the rows above.)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
