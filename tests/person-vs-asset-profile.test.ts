// Regression pins for the 2026-08-11 production report:
//
//   "Tires asset profile created under your Dodge Ram 2025."
//     → TWO records. The asset "Tires" (correctly nested under the Dodge Ram)
//       AND a PERSON called "tires for my Dodge ram".
//
// The database showed it was not a one-off. The same user's profile table had
// three of these, each a person conjured beside a thing that had just been
// created correctly:
//
//   asset   "Tires"            + person "tires for my Dodge ram"
//   asset   "MacBook Pro M4"   + person "my MacBook Pro m4"
//   vehicle "Dodge Ram 2025"   + person "my 2025 Dodge ram"
//
// Root cause: nothing in the routing layer could tell the two apart.
// `create_profile` writes both people and assets, and TOOL_INTENT_ENTITY
// mapped the TOOL NAME to "asset" regardless of the `type` argument — so
// create_profile(type:"person") on an asset request matched the intent
// perfectly. The intent vocabulary had no "person" entity at all, and
// `asset`/`profile` were declared interchangeable.
//
// Three layers now stand between that call and the database, and each one is
// pinned here:
//   1. the intent gate      — person tool on an asset request is blocked;
//   2. the same-turn rule   — a person mirroring a thing created this turn;
//   3. the executor guard   — a "person" whose name describes an object.
import { describe, it, expect } from "vitest";
import {
  parseTurnIntent,
  parseTurnPlan,
  detectEntity,
  extractEntityName,
  personAssetAmbiguous,
  mentionsPerson,
} from "@shared/ai-intent";
import {
  checkToolAgainstIntent,
  toolIntentEntity,
  areEntitiesCompatible,
  findDuplicateCreateInTurn,
  recordTurnCreate,
  IDENTITY_PROFILE_TYPES,
} from "@shared/ai-tool-routing";
import { looksLikeThingNotPerson } from "@shared/entity-naming";
import {
  isPrimaryProfile,
  isDeletablePerson,
  PRIMARY_PROFILE_DELETE_ERROR,
} from "@shared/profile-protection";

// The three real messages, as close to the originals as the screenshots allow.
const TIRES_MSG = "Create an asset profile for tires for my Dodge Ram 2025, $1200";
const MACBOOK_MSG = "Create a profile for my MacBook Pro m4";
const RAM_MSG = "Create an asset for my 2025 Dodge ram";

describe("intent: person is its own entity", () => {
  it("reads an explicit person request as a person", () => {
    expect(detectEntity("Create a person profile for Dave").entity).toBe("person");
    expect(detectEntity("Add a new person named Sarah").entity).toBe("person");
    expect(detectEntity("Add my brother Dave").entity).toBe("person");
  });

  it("reads an asset-profile request as an asset, not a person and not a bare profile", () => {
    expect(detectEntity(TIRES_MSG).entity).toBe("asset");
    expect(detectEntity("create an asset profile for the tires").entity).toBe("asset");
    expect(detectEntity(RAM_MSG).entity).toBe("asset");
  });

  it("leaves a bare 'profile' ambiguous rather than guessing", () => {
    expect(detectEntity(MACBOOK_MSG).entity).toBe("profile");
    // …and ambiguous means compatible with BOTH, so neither is ever blocked.
    expect(areEntitiesCompatible("profile", "person")).toBe(true);
    expect(areEntitiesCompatible("profile", "asset")).toBe(true);
  });

  it("does not let person and asset stand in for each other", () => {
    expect(areEntitiesCompatible("person", "asset")).toBe(false);
    expect(areEntitiesCompatible("asset", "person")).toBe(false);
  });

  it("does not mistake an incidental person word for a person request", () => {
    // The entity noun that comes FIRST wins, so these stay what they are.
    expect(detectEntity("Add a task to call my brother").entity).toBe("task");
    expect(detectEntity("Create an asset for my wife's car").entity).toBe("asset");
  });

  it("strips stacked entity nouns out of the name", () => {
    expect(extractEntityName("Create an asset profile for tires")).toBe("tires");
    expect(extractEntityName("Create a person profile for Dave")).toBe("Dave");
  });
});

describe("tool entity is read from the arguments, not just the name", () => {
  it("maps create_profile by its type argument", () => {
    expect(toolIntentEntity("create_profile", { type: "asset", name: "Tires" })).toBe("asset");
    expect(toolIntentEntity("create_profile", { type: "vehicle", name: "Dodge Ram" })).toBe("asset");
    expect(toolIntentEntity("create_profile", { type: "person", name: "Dave" })).toBe("person");
    expect(toolIntentEntity("create_profile", { type: "self", name: "Me" })).toBe("person");
  });

  it("falls back to the tool-name reading when no type is given", () => {
    expect(toolIntentEntity("create_profile", {})).toBe("asset");
    expect(toolIntentEntity("create_profile", undefined)).toBe("asset");
  });

  it("leaves unmapped tools ungated", () => {
    expect(toolIntentEntity("get_summary", {})).toBeUndefined();
  });
});

describe("layer 1 — the intent gate blocks a person on an asset request", () => {
  it("blocks create_profile(type:person) for the tires request", () => {
    const plan = parseTurnPlan(TIRES_MSG);
    const violation = checkToolAgainstIntent("create_profile", plan, {
      type: "person",
      name: "my tires for my Dodge ram",
    });
    expect(violation).not.toBeNull();
    expect(violation!.mismatchType).toBe("entity_mismatch");
    expect(violation!.actualEntity).toBe("person");
    expect(violation!.expectedEntity).toBe("asset");
    // The directive has to name the fix, not just the refusal.
    expect(violation!.modelDirective).toMatch(/type:"asset"/);
    // Nothing shown to the user: the asset they asked for succeeded, and the
    // phantom person was never their doing.
    expect(violation!.userMessage).toBe("");
  });

  it("allows the asset call the same message DID ask for", () => {
    const plan = parseTurnPlan(TIRES_MSG);
    expect(checkToolAgainstIntent("create_profile", plan, { type: "asset", name: "Tires" })).toBeNull();
  });

  it("blocks a person for the Dodge Ram request too", () => {
    const plan = parseTurnPlan(RAM_MSG);
    const violation = checkToolAgainstIntent("create_profile", plan, {
      type: "person",
      name: "my 2025 Dodge ram",
    });
    expect(violation?.mismatchType).toBe("entity_mismatch");
  });

  it("still allows a genuine person request", () => {
    const plan = parseTurnPlan("Create a person profile for Dave Hancock");
    expect(checkToolAgainstIntent("create_profile", plan, { type: "person", name: "Dave Hancock" })).toBeNull();
  });

  it("does not gate a message that asks for BOTH a person and a thing", () => {
    // Clause splitting can't separate these (no write verb after "and"), so
    // gating either half would be a false positive.
    const msg = "Create a person profile for Bob and an asset profile for his truck";
    expect(personAssetAmbiguous(msg)).toBe(true);
    const plan = parseTurnPlan(msg);
    expect(checkToolAgainstIntent("create_profile", plan, { type: "person", name: "Bob" })).toBeNull();
    expect(checkToolAgainstIntent("create_profile", plan, { type: "asset", name: "Truck" })).toBeNull();
  });

  it("does not treat an asset-only message as ambiguous", () => {
    expect(mentionsPerson(TIRES_MSG)).toBe(false);
    expect(personAssetAmbiguous(TIRES_MSG)).toBe(false);
  });
});

describe("layer 2 — the same-turn person shadow", () => {
  const priorAsset = (name: string, type = "asset") =>
    [recordTurnCreate("create_profile", { type, name })!];

  it("catches the wordier shadow exact-key matching missed", () => {
    const prior = priorAsset("Tires");
    const dup = findDuplicateCreateInTurn(
      "create_profile",
      { type: "person", name: "my tires for my Dodge ram" },
      prior,
    );
    expect(dup).not.toBeNull();
    expect(dup!.identity).toBe(false);
  });

  it("catches the determiner-only shadow (the original MacBook case)", () => {
    const dup = findDuplicateCreateInTurn(
      "create_profile",
      { type: "person", name: "my MacBook Pro m4" },
      priorAsset("MacBook Pro M4"),
    );
    expect(dup).not.toBeNull();
  });

  it("catches a reordered shadow (2025 Dodge ram)", () => {
    const dup = findDuplicateCreateInTurn(
      "create_profile",
      { type: "person", name: "my 2025 Dodge ram" },
      priorAsset("Dodge Ram 2025", "vehicle"),
    );
    expect(dup).not.toBeNull();
  });

  it("catches the reverse order — asset shadowing a person", () => {
    const priorPerson = [recordTurnCreate("create_profile", { type: "person", name: "Dave Hancock" })!];
    expect(priorPerson[0].identity).toBe(true);
    const dup = findDuplicateCreateInTurn(
      "create_profile",
      { type: "asset", name: "Dave Hancock's spare" },
      priorPerson,
    );
    expect(dup).not.toBeNull();
  });

  it("leaves a person and their unrelated possession alone", () => {
    const priorPerson = [recordTurnCreate("create_profile", { type: "person", name: "Bob" })!];
    expect(findDuplicateCreateInTurn("create_profile", { type: "asset", name: "Truck" }, priorPerson)).toBeNull();
  });

  it("does not word-match two things of the same kind", () => {
    // Both non-identity: the boundary isn't crossed, so only the exact-key
    // rule applies and "Honda" ≠ "Honda Civic".
    const prior = priorAsset("Honda", "vehicle");
    expect(findDuplicateCreateInTurn("create_profile", { type: "vehicle", name: "Honda Civic" }, prior)).toBeNull();
  });

  it("does not word-match against a non-profile create", () => {
    const priorTask = [recordTurnCreate("create_task", { title: "Tires" })!];
    expect(findDuplicateCreateInTurn("create_profile", { type: "person", name: "tires for my Dodge ram" }, priorTask)).toBeNull();
  });

  it("still catches a plain same-name duplicate", () => {
    const prior = priorAsset("Tires");
    expect(findDuplicateCreateInTurn("create_profile", { type: "asset", name: "the Tires" }, prior)).not.toBeNull();
  });
});

describe("layer 3 — a person's name is not a description of a thing", () => {
  it("rejects the three names production actually wrote", () => {
    expect(looksLikeThingNotPerson("tires for my Dodge ram")).toBe(true);
    expect(looksLikeThingNotPerson("my MacBook Pro m4")).toBe(true);
    expect(looksLikeThingNotPerson("my 2025 Dodge ram")).toBe(true);
  });

  it("rejects other object descriptions", () => {
    expect(looksLikeThingNotPerson("Screen cover for the MacBook")).toBe(true);
    expect(looksLikeThingNotPerson("Fridge in my house")).toBe(true);
    expect(looksLikeThingNotPerson("a tracker for the tires on my truck that I bought")).toBe(true);
  });

  it("accepts real names, including long and unusual ones", () => {
    expect(looksLikeThingNotPerson("Dave")).toBe(false);
    expect(looksLikeThingNotPerson("John Hancock")).toBe(false);
    expect(looksLikeThingNotPerson("Maria del Carmen de la Cruz")).toBe(false);
    expect(looksLikeThingNotPerson("Mary-Beth O'Connor Jr.")).toBe(false);
    expect(looksLikeThingNotPerson("Nguyễn Thị Ánh")).toBe(false);
  });

  it("knows which profile types the guard applies to", () => {
    expect(IDENTITY_PROFILE_TYPES.has("person")).toBe(true);
    expect(IDENTITY_PROFILE_TYPES.has("self")).toBe(true);
    expect(IDENTITY_PROFILE_TYPES.has("asset")).toBe(false);
    expect(IDENTITY_PROFILE_TYPES.has("pet")).toBe(false);
  });
});

describe("nested assets keep working", () => {
  it("routes a nested-asset request to the asset system", () => {
    const intent = parseTurnIntent("Add an asset for my MacBook screen cover");
    expect(intent.entity).toBe("asset");
    expect(intent.operation).toBe("create");
    const plan = parseTurnPlan("Add an asset for my MacBook screen cover");
    expect(checkToolAgainstIntent("create_profile", plan, {
      type: "asset", name: "MacBook Screen Cover", forProfile: "MacBook Pro M4",
    })).toBeNull();
  });

  it("does not block a nested asset just because it came with a price", () => {
    // A dollar amount makes the message read as an expense, but a physical
    // item the user owns is an asset — the two overlap by design.
    const msg = "Add a screen cover for my MacBook Pro M4, $100";
    expect(parseTurnIntent(msg).entity).toBe("expense");
    expect(checkToolAgainstIntent("create_profile", parseTurnPlan(msg), {
      type: "asset", name: "MacBook Screen Cover", forProfile: "MacBook Pro M4",
    })).toBeNull();
  });

  it("blocks a person profile invented for the parent asset", () => {
    const plan = parseTurnPlan("Add an asset for my MacBook screen cover");
    const violation = checkToolAgainstIntent("create_profile", plan, {
      type: "person", name: "MacBook Pro M4",
    });
    expect(violation?.mismatchType).toBe("entity_mismatch");
  });
});

describe("the primary account owner is protected", () => {
  it("identifies the self profile and nothing else", () => {
    expect(isPrimaryProfile({ type: "self" })).toBe(true);
    expect(isPrimaryProfile({ type: "person" })).toBe(false);
    expect(isPrimaryProfile({ type: "asset" })).toBe(false);
    expect(isPrimaryProfile(null)).toBe(false);
    expect(isPrimaryProfile(undefined)).toBe(false);
  });

  it("treats an added person as deletable", () => {
    expect(isDeletablePerson({ type: "person" })).toBe(true);
    expect(isDeletablePerson({ type: "self" })).toBe(false);
  });

  it("states the refusal in one place", () => {
    expect(PRIMARY_PROFILE_DELETE_ERROR).toMatch(/primary account owner/i);
  });
});
