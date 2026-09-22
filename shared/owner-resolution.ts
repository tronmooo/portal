// shared/owner-resolution.ts
//
// Rule 6 — the selected profile is a hard data boundary.
//
// ONE answer to "who owns the record being created?", shared by the storage
// layer (REST + AI + imports all end there), the AI engine's create tools and
// the client's create dialogs. The decision table:
//
//   explicit owner(s) named, all known      → those owners          ("explicit")
//   explicit owner(s) named, none known     → STOP and ask          ("unresolved")
//   nothing named, exactly ONE active       → the active profile    ("active_profile")
//   nothing named, no active (Everyone)     → the self profile      ("self")
//   nothing named, TWO OR MORE active       → STOP and ask          ("unresolved")
//   nothing named, no active, no self       → nobody                ("unresolved", not an ask)
//
// The regression this exists for: assets and ledger rows created while Avery
// was the selected profile landed on the household owner because every create
// path had its own "default to self / first / last-used / cached" fallback.
// None of those may be used here: the speaker is the user, so an EMPTY scope
// ("Everyone") is the only case that resolves to self, and an ambiguous scope
// is a question, never a guess. A named owner that does not exist is likewise
// a question — substituting self for "Morgan" is how rows end up on the wrong
// person.

export type OwnerResolution = {
  ownerIds: string[];
  source: "explicit" | "active_profile" | "self" | "unresolved";
  /** Stable, machine-readable reason (see REASONS) plus nothing else. */
  reason: string;
};

/** The reasons an OwnerResolution can carry. Stable strings; branch on these. */
export const OWNER_REASONS = {
  explicit: "explicit_owner",
  active: "single_active_profile",
  self: "everyone_scope_defaults_to_self",
  ambiguous: "ambiguous_active_scope",
  unknownExplicit: "unknown_explicit_owner",
  none: "no_owner_available",
} as const;

export interface ResolveOwnerInput {
  /** Owner ids the caller named (a picker, "for Morgan" in chat). */
  explicitOwnerIds?: readonly (string | null | undefined)[] | null;
  /** The caller's active profile selection (X-Active-Profile-Ids). */
  activeProfileIds?: readonly (string | null | undefined)[] | null;
  /** The self profile, when the account has one. */
  selfProfileId?: string | null;
  /** Whether the record must carry an owner. */
  ownerRequired: boolean;
  /** Every profile id the user owns. When given, unknown ids are dropped. */
  validProfileIds?: ReadonlySet<string> | null;
}

function cleanIds(list: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list || []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolve the owner(s) of a record about to be created. Pure.
 *
 * `source === "unresolved"` with reason `ambiguous_active_scope` or
 * `unknown_explicit_owner` means "stop and ask the user" (see
 * `isOwnerQuestion`). Reason `no_owner_available` means the account has no
 * self profile yet and nothing was selected — the caller decides whether an
 * unowned row is acceptable (readers treat unowned rows as the primary
 * user's), which is why `ownerRequired` is part of the input.
 */
export function resolveOwnerForNewRecord(input: ResolveOwnerInput): OwnerResolution {
  const valid = input.validProfileIds ?? null;
  const explicitRaw = cleanIds(input.explicitOwnerIds);
  if (explicitRaw.length > 0) {
    const known = valid ? explicitRaw.filter(id => valid.has(id)) : explicitRaw;
    if (known.length > 0) {
      return { ownerIds: known, source: "explicit", reason: OWNER_REASONS.explicit };
    }
    // Every named owner is unknown. Never swap in self for a name we could
    // not resolve — that is exactly the wrong-person bug.
    return { ownerIds: [], source: "unresolved", reason: OWNER_REASONS.unknownExplicit };
  }

  const active = cleanIds(input.activeProfileIds).filter(id => (valid ? valid.has(id) : true));
  if (active.length === 1) {
    return { ownerIds: [active[0]], source: "active_profile", reason: OWNER_REASONS.active };
  }
  if (active.length > 1) {
    return { ownerIds: [], source: "unresolved", reason: OWNER_REASONS.ambiguous };
  }

  const self = typeof input.selfProfileId === "string" ? input.selfProfileId.trim() : "";
  if (self && (!valid || valid.has(self))) {
    return { ownerIds: [self], source: "self", reason: OWNER_REASONS.self };
  }
  // No self profile and nothing selected. With `ownerRequired` the caller
  // must treat this as a question too; without it, an unowned row is allowed.
  return { ownerIds: [], source: "unresolved", reason: OWNER_REASONS.none };
}

/** True when the resolution means "ask the user which profile" rather than "nobody". */
export function isOwnerQuestion(r: OwnerResolution, ownerRequired = false): boolean {
  if (r.source !== "unresolved") return false;
  if (r.reason === OWNER_REASONS.ambiguous || r.reason === OWNER_REASONS.unknownExplicit) return true;
  return ownerRequired && r.reason === OWNER_REASONS.none;
}

/** The one user-facing message every surface shows when an owner is needed. */
export const OWNER_REQUIRED_MESSAGE = "Which profile should this belong to? More than one is selected.";
export const OWNER_UNKNOWN_MESSAGE = (name?: string | null) =>
  name && String(name).trim()
    ? `I don't have a profile named ${String(name).trim()} — which profile should this belong to?`
    : "I couldn't find that profile — which profile should this belong to?";

/**
 * Thrown by a writer that cannot resolve an owner. Carries HTTP 409 and the
 * `OWNER_REQUIRED` code so the API error handler answers "choose an owner"
 * instead of a generic 500 — and so no writer is tempted to guess.
 */
export class OwnerRequiredError extends Error {
  readonly statusCode = 409;
  readonly code = "OWNER_REQUIRED";
  readonly reason: string;
  constructor(reason: string = OWNER_REASONS.ambiguous, message?: string) {
    super(message || (reason === OWNER_REASONS.unknownExplicit ? OWNER_UNKNOWN_MESSAGE() : OWNER_REQUIRED_MESSAGE));
    this.name = "OwnerRequiredError";
    this.reason = reason;
  }
}
