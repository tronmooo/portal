/**
 * Rule 6 — the selected profile is a hard data boundary.
 *
 * shared/owner-resolution.ts is the ONE decision table every create path
 * (storage, AI tools, REST routes, client dialogs) shares. These pin it.
 */
import { describe, it, expect } from "vitest";
import {
  resolveOwnerForNewRecord,
  isOwnerQuestion,
  OwnerRequiredError,
  OWNER_REASONS,
  OWNER_REQUIRED_MESSAGE,
} from "../shared/owner-resolution";

const SELF = "11111111-1111-4111-8111-111111111111";
const AVERY = "22222222-2222-4222-8222-222222222222";
const MORGAN = "33333333-3333-4333-8333-333333333333";
const VALID = new Set([SELF, AVERY, MORGAN]);

describe("resolveOwnerForNewRecord — the decision table", () => {
  it("an explicit owner wins over the active profile and self", () => {
    const r = resolveOwnerForNewRecord({ explicitOwnerIds: [MORGAN], activeProfileIds: [AVERY], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r).toEqual({ ownerIds: [MORGAN], source: "explicit", reason: OWNER_REASONS.explicit });
  });

  it("nothing named + exactly one active profile → that profile (Avery, not self)", () => {
    const r = resolveOwnerForNewRecord({ explicitOwnerIds: [], activeProfileIds: [AVERY], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r.ownerIds).toEqual([AVERY]);
    expect(r.source).toBe("active_profile");
  });

  it("nothing named + empty scope (Everyone) → self: the speaker is the user", () => {
    const r = resolveOwnerForNewRecord({ activeProfileIds: [], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r.ownerIds).toEqual([SELF]);
    expect(r.source).toBe("self");
  });

  it("nothing named + two or more active → unresolved, ownerIds [] (never guess)", () => {
    const r = resolveOwnerForNewRecord({ activeProfileIds: [AVERY, MORGAN], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r).toEqual({ ownerIds: [], source: "unresolved", reason: OWNER_REASONS.ambiguous });
    expect(isOwnerQuestion(r)).toBe(true);
  });

  it("an explicit id that is not one of the user's profiles is dropped — and never replaced by self", () => {
    const r = resolveOwnerForNewRecord({ explicitOwnerIds: ["not-a-real-profile"], activeProfileIds: [AVERY], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r.ownerIds).toEqual([]);
    expect(r.source).toBe("unresolved");
    expect(r.reason).toBe(OWNER_REASONS.unknownExplicit);
    expect(isOwnerQuestion(r)).toBe(true);
  });

  it("known explicit ids survive while unknown ones are filtered out", () => {
    const r = resolveOwnerForNewRecord({ explicitOwnerIds: [MORGAN, "ghost"], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r.ownerIds).toEqual([MORGAN]);
    expect(r.source).toBe("explicit");
  });

  it("explicit ids are trusted when no valid set is supplied; blanks, duplicates and non-strings are dropped", () => {
    const r = resolveOwnerForNewRecord({ explicitOwnerIds: [" a ", "a", "", null as any, 7 as any], ownerRequired: false });
    expect(r.ownerIds).toEqual(["a"]);
  });

  it("an active id that is not the user's profile is ignored (stale header) and self applies", () => {
    const r = resolveOwnerForNewRecord({ activeProfileIds: ["someone-elses"], selfProfileId: SELF, ownerRequired: true, validProfileIds: VALID });
    expect(r.ownerIds).toEqual([SELF]);
    expect(r.source).toBe("self");
  });

  it("no self, no active, nothing named → unresolved; a question only when an owner is required", () => {
    const r = resolveOwnerForNewRecord({ ownerRequired: false, validProfileIds: new Set() });
    expect(r).toEqual({ ownerIds: [], source: "unresolved", reason: OWNER_REASONS.none });
    expect(isOwnerQuestion(r)).toBe(false);
    expect(isOwnerQuestion(r, true)).toBe(true);
  });
});

describe("OwnerRequiredError", () => {
  it("is a 409 with the OWNER_REQUIRED code and the one user-facing message", () => {
    const e = new OwnerRequiredError();
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("OWNER_REQUIRED");
    expect(e.message).toBe(OWNER_REQUIRED_MESSAGE);
    expect(e).toBeInstanceOf(Error);
  });
  it("an unknown named owner gets the 'which profile' wording", () => {
    expect(new OwnerRequiredError(OWNER_REASONS.unknownExplicit).message).toMatch(/which profile should this belong to/i);
  });
});
