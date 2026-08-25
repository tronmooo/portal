// ─── Which domains each server cache prefix depends on ──────────────────────
//
// The server caches responses under `<prefix>:<userId>@v<stamp>:<scope>`. The
// stamp used to be ONE per-user counter, bumped on every write. That made a
// write correct by making it total: saving a tracker entry changed the cache
// key of the dashboard, the expense list, the calendar and the document list
// too, on every instance and in the shared Postgres cache at once. Nothing was
// stale — everything was simply gone, so the next read of anything recomputed
// from scratch. That is where "several seconds after any change" came from.
//
// A prefix now names the domains its payload actually reads, and its stamp is
// built from those domains' versions. Recording a payment still invalidates
// everything a payment feeds; it stops invalidating the habit list.
//
// The direction of failure matters here and is the reason for `"all"`. Under
// the old scheme an unlisted dependency cost time. Under this one it costs
// CORRECTNESS: a payload that reads a domain it didn't declare can be served
// stale for its whole TTL. So anything that aggregates across the whole account
// declares "all" — those are the expensive ones, but they legitimately depend
// on everything, and no cleverness here would make them cheaper. Only the cheap
// single-table list caches are narrowed, and an unknown prefix means "all".
import type { Domain } from "./entity-domains";

/** `"all"` = depends on every domain; any write changes this prefix's stamp. */
export type PrefixDependency = Domain[] | "all";

/**
 * Assets, liabilities, people and accounts are all rows in the profiles table
 * discriminated by `type`, so any profile-shaped read depends on all four.
 */
const PROFILE_DEPS: Domain[] = ["profiles", "assets", "liabilities", "people"];

export const CACHE_PREFIX_DOMAINS: Record<string, PrefixDependency> = {
  // ── Account-wide aggregates: they read nearly every table, and the ones
  // they don't read today they will tomorrow. "all" keeps them honest.
  "stats:": "all",
  "enhanced:": "all",
  "bootstrap:": "all",
  "bootstrap-raw:": "all",
  "profile-bootstrap:": "all",
  "insights:": "all",
  "insights-data:": "all",
  "ai-digest:": "all",
  "activity:": "all",
  "cashflow:": "all",
  "notifications:": "all",
  "caltimeline:": "all",
  // A profile's detail payload embeds its documents, expenses, habits,
  // trackers, tasks and activity timeline — it is an aggregate wearing a
  // single-entity name, and treating it as one was how a deleted document kept
  // its card on the Info tab.
  "profile-detail:": "all",

  // ── Single-table list caches: narrow, and the whole point of the exercise.
  "profiles:": PROFILE_DEPS,
  "profiles-lite:": PROFILE_DEPS,   // the same rows, fewer columns
  "trackers:": ["trackers", "habits"],
  "tasks:": ["tasks"],
  "expenses:": ["expenses"],
  "incomes:": ["incomes"],
  "paychecks:": ["incomes"],
  "events:": ["events"],
  "habits:": ["habits", "trackers"],
  "obligations:": ["obligations", "liabilities"],
  "journal:": ["journal"],
  "documents:": ["documents"],
  "goals:": ["goals", "trackers"],
  "artifacts:": ["artifacts"],
  "budgets:": ["budgets", "expenses"],
  "calendar:": ["events", "tasks", "obligations", "incomes"],
};

/** What a prefix depends on. Anything unlisted depends on everything. */
export function dependenciesForPrefix(prefix: string): PrefixDependency {
  return CACHE_PREFIX_DOMAINS[prefix] ?? "all";
}

/** The key under which the account-wide epoch lives in the version map. */
export const EPOCH_KEY = "epoch";

/**
 * Build the cache-key stamp for a prefix from a domain→version map.
 *
 * The epoch is always part of it, so `bump(["everything"])` — and any write an
 * old instance made through the legacy RPC — still invalidates every prefix.
 * The literal "v" prefix is load-bearing: the shared Postgres cache only stores
 * keys containing "@v", which is how it knows a key is version-stamped and
 * therefore safe to share across instances.
 */
export function versionStamp(prefix: string, versions: Record<string, number> | undefined): string {
  const map = versions || {};
  const epoch = Number(map[EPOCH_KEY]) || 0;
  const deps = dependenciesForPrefix(prefix);
  // "all" means every domain in the map, NOT the epoch alone. The epoch only
  // moves for a write that could not be classified, so stamping an aggregate
  // with the epoch by itself would make the dashboard immune to ordinary
  // writes — stale for its whole TTL, which is the one failure this scheme can
  // produce and the one it must not.
  const names = deps === "all"
    ? Object.keys(map).filter((k) => k !== EPOCH_KEY)
    : [...deps];
  // Sorted so the stamp doesn't depend on declaration or insertion order.
  const parts = names.sort().map((d) => `${d}${Number(map[d]) || 0}`);
  return parts.length > 0 ? `v${epoch}.${parts.join(".")}` : `v${epoch}`;
}

/** Serialize a version map for the client's read-your-writes token. */
export function encodeVersionMap(versions: Record<string, number>): string {
  return Object.entries(versions)
    .filter(([, v]) => Number.isFinite(v))
    .map(([k, v]) => `${k}:${Math.floor(Number(v))}`)
    .join(",");
}

/**
 * Parse the client's token. Accepts the legacy bare integer, which an older
 * client still sends mid-deploy, and reads it as the epoch.
 */
export function decodeVersionMap(raw: unknown): Record<string, number> {
  const text = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).trim();
  if (!text) return {};
  if (/^\d+$/.test(text)) return { [EPOCH_KEY]: Number(text) };
  const out: Record<string, number> = {};
  for (const part of text.split(",")) {
    const [k, v] = part.split(":");
    const n = Number(v);
    if (k && Number.isFinite(n) && n >= 0) out[k.trim()] = Math.floor(n);
  }
  return out;
}

/**
 * Merge a client token into this instance's own view, taking the max per
 * domain. A client that was just told "saved" carries the post-write versions,
 * so an instance whose memo is still pre-write computes the post-write key
 * anyway and cannot answer it with pre-write data.
 *
 * Clamped: a token can only move a version FORWARD, and only within a sane
 * distance, so a stale or hostile value costs that one user some cache misses
 * and nothing else. Keys are per-user, so no other account is reachable.
 */
export const MAX_VERSION_LOOKAHEAD = 1000;

export function mergeVersionMaps(
  own: Record<string, number>,
  token: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...own };
  for (const [k, v] of Object.entries(token)) {
    const mine = Number(merged[k]) || 0;
    if (!Number.isFinite(v) || v <= mine) continue;
    merged[k] = Math.min(Math.floor(v), mine + MAX_VERSION_LOOKAHEAD);
  }
  return merged;
}
