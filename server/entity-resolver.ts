// ── The one place the server answers "does a thing by this name exist?" ─────
//
// Reads through `storage`, which is the SAME user-scoped data access layer the
// dashboard, the habits page, the executive tab and the calendar read through
// (getHabits/getTasks/getGoals/getEvents each filter on `user_id` and exclude
// soft-deleted rows). So if a surface can see a record, chat can resolve it —
// there is no second query with different ownership rules.
//
// Why this file exists: `complete_task` used to answer "not found" for a name
// that was sitting on the dashboard as a HABIT, because it only ever looked at
// tasks (user report 2026-08-17, habit "Clean my room"). Existence is now
// decided across every actionable type, once, here.

import {
  rankByName, explicitKind, ACTIONABLE_KINDS,
  type ActionableKind, type ResolvedCandidate, type ResolutionResult,
} from "@shared/entity-resolution";
import { normalizeHabitText } from "@shared/habit-match";
import { passesProfileFilter } from "@shared/profile-filter";
import { selfIdsFrom } from "@shared/scope";

/** The subset of storage this resolver needs — keeps it unit-testable. */
export interface ResolverStorage {
  getHabits(): Promise<any[]>;
  getTasks(): Promise<any[]>;
  getGoals?(): Promise<any[]>;
  getEvents?(): Promise<any[]>;
  getProfiles(): Promise<any[]>;
  /** Co-ownership tables — "Linda's car insurance" reaches the car she half-owns. */
  getAssetPartyLinks?(): Promise<any[]>;
  getLiabilityProfileLinks?(): Promise<any[]>;
}

export interface ResolveOptions {
  /** The name the model extracted, e.g. "Clean my room". */
  name: string;
  /** The user's raw message — used ONLY to detect an explicit kind word. */
  userMessage?: string;
  /** Restrict to these kinds regardless of the message (a caller's own rule). */
  only?: ActionableKind[];
  /** Profile name the user named ("mark Joe's run done"). */
  forProfile?: string;
  /** When true, already-completed records are still candidates. */
  includeCompleted?: boolean;
}

/** Match a profile by name the way the AI engine does elsewhere. */
function matchProfile(profiles: any[], name: string): any | undefined {
  const n = normalizeHabitText(name);
  if (!n) return undefined;
  return profiles.find(p => normalizeHabitText(p.name) === n)
    || profiles.find(p => normalizeHabitText(p.name).includes(n));
}

/**
 * Scope a set of records to the profile the command is about.
 *
 * Delegates to `passesProfileFilter` — the SAME rule the dashboard, finance,
 * calendar and the server list endpoints use. Deliberately not re-implemented
 * here: a hand-rolled `linked.some(id => …)` is how the four divergent copies
 * that predate shared/profile-filter.ts came about, and a resolver that
 * disagrees with the UI about ownership is the bug this file exists to close.
 *
 * With no profile named, the scope is EVERY self profile (not the first one
 * found — an account with two self rows had half its habits invisible to chat
 * while the dashboard showed them all), and orphan records fall through to
 * "me", exactly as they do on screen.
 */
function scopeToProfile(
  records: any[],
  profiles: any[],
  forProfile?: string,
  links?: { assetPartyLinks: any[]; liabilityProfileLinks: any[] },
): any[] {
  let selectedIds: string[];
  if (forProfile) {
    const prof = matchProfile(profiles, forProfile);
    if (!prof) return [];              // named someone we don't know — no guessing
    selectedIds = [prof.id];
  } else {
    selectedIds = [...selfIdsFrom(profiles)];
  }
  if (selectedIds.length === 0) return records;   // no profiles at all — no filter to apply
  return records.filter(r => passesProfileFilter(r?.linkedProfiles, { selectedIds, allProfiles: profiles, ...(links || {}) }));
}

const isDoneTask = (t: any) => String(t?.status || "").trim().toLowerCase() === "done";
const isClosedGoal = (g: any) => ["completed", "abandoned"].includes(String(g?.status || "").toLowerCase());

/**
 * Resolve a name across the actionable entity types.
 *
 * Never throws for a missing table — a storage without goals/events simply
 * contributes no candidates of that kind.
 */
export async function resolveActionable(
  storage: ResolverStorage,
  opts: ResolveOptions,
): Promise<ResolutionResult> {
  const queryName = normalizeHabitText(opts.name);
  const explicit = opts.only && opts.only.length === 1
    ? opts.only[0]
    : explicitKind(opts.userMessage);

  // An explicit kind is a hard constraint; `only` narrows further.
  let searched: ActionableKind[] = explicit ? [explicit] : [...ACTIONABLE_KINDS];
  if (opts.only?.length) searched = searched.filter(k => opts.only!.includes(k));
  if (searched.length === 0) searched = opts.only?.length ? [...opts.only] : [...ACTIONABLE_KINDS];

  if (!queryName) return { candidates: [], explicit, searched, queryName };

  const profiles = await storage.getProfiles().catch(() => []);
  // Only a named person needs the link tables (self scope reaches its own
  // assets through the parent chain already).
  const links = opts.forProfile
    ? {
        assetPartyLinks: await (storage.getAssetPartyLinks?.() ?? Promise.resolve([])).catch(() => [] as any[]),
        liabilityProfileLinks: await (storage.getLiabilityProfileLinks?.() ?? Promise.resolve([])).catch(() => [] as any[]),
      }
    : undefined;
  const candidates: ResolvedCandidate[] = [];

  const collect = async (
    kind: ActionableKind,
    load: (() => Promise<any[]>) | undefined,
    getName: (r: any) => string,
    isClosed: (r: any) => boolean,
  ) => {
    if (!searched.includes(kind) || !load) return;
    const rows = await load().catch(() => []);
    const scoped = scopeToProfile(rows || [], profiles, opts.forProfile, links);
    const open = opts.includeCompleted ? scoped : scoped.filter(r => !isClosed(r));
    for (const r of rankByName(open, opts.name, getName)) {
      candidates.push({ kind, id: r.id, name: getName(r), record: r });
    }
  };

  // Habits first so a same-named habit/task pair reports the habit first; the
  // caller still decides, and exact-name equality outranks order anyway.
  await collect("habit", storage.getHabits?.bind(storage), r => r.name || "", () => false);
  await collect("task", storage.getTasks?.bind(storage), r => r.title || "", isDoneTask);
  await collect("goal", storage.getGoals?.bind(storage), r => r.title || r.name || "", isClosedGoal);
  await collect("event", storage.getEvents?.bind(storage), r => r.title || "", r => !!r?.completed);

  return { candidates, explicit, searched, queryName };
}

/** Candidates of one kind, in rank order. */
export function ofKind(res: ResolutionResult, kind: ActionableKind): ResolvedCandidate[] {
  return res.candidates.filter(c => c.kind === kind);
}

/**
 * The message a handler returns when the name resolved to a DIFFERENT kind
 * than the tool it landed in. Phrased for the model: it states what the
 * database found, so the model reports a fact instead of inventing one.
 */
export function crossKindHint(res: ResolutionResult, attempted: ActionableKind): string | null {
  const others = res.candidates.filter(c => c.kind !== attempted);
  if (others.length === 0) return null;
  const c = others[0];
  return `No ${attempted} named "${res.queryName}" exists, but a ${c.kind} named "${c.name}" does.`;
}
