import { describe, it, expect } from "vitest";
import {
  stripTrackerOwnerSuffix, stripOwnerPossessivePrefix,
  extractOwnerPossessive, detectPossessiveOwner,
} from "../shared/entity-naming";
import { MemStorage } from "../server/storage";

describe("stripTrackerOwnerSuffix", () => {
  it("strips a trailing '- Owner' when it matches an owner name", () => {
    expect(stripTrackerOwnerSuffix("Calories - Craig", ["Craig"])).toBe("Calories");
    expect(stripTrackerOwnerSuffix("Running - Craig", ["Craig"])).toBe("Running");
  });

  it("is case-insensitive and handles en/em dashes", () => {
    expect(stripTrackerOwnerSuffix("Running - craig", ["Craig"])).toBe("Running");
    expect(stripTrackerOwnerSuffix("Running – Craig", ["Craig"])).toBe("Running"); // en dash
    expect(stripTrackerOwnerSuffix("Running — Craig", ["Craig"])).toBe("Running"); // em dash
  });

  it("does NOT strip a suffix that isn't an owner name", () => {
    expect(stripTrackerOwnerSuffix("Blood Pressure - Morning", ["Craig"])).toBe("Blood Pressure - Morning");
    expect(stripTrackerOwnerSuffix("Weight - Left Arm", ["Craig", "Bob"])).toBe("Weight - Left Arm");
  });

  it("leaves clean names untouched and tolerates empty owners", () => {
    expect(stripTrackerOwnerSuffix("Calories", ["Craig"])).toBe("Calories");
    expect(stripTrackerOwnerSuffix("Calories - Craig", [null, undefined, ""])).toBe("Calories - Craig");
  });

  it("never returns an empty string even if the name was only the owner", () => {
    // Degenerate input — keep the original rather than blanking the name.
    expect(stripTrackerOwnerSuffix("Craig", ["Craig"])).toBe("Craig");
  });
});

describe("stripOwnerPossessivePrefix", () => {
  it("strips a possessive owner prefix", () => {
    expect(stripOwnerPossessivePrefix("Craig's Ford F250 2025", ["Craig"])).toBe("Ford F250 2025");
    expect(stripOwnerPossessivePrefix("craig's Honda", ["Craig"])).toBe("Honda");
  });

  it("accepts curly/modifier apostrophes and no-apostrophe forms", () => {
    expect(stripOwnerPossessivePrefix("Craig’s Tesla", ["Craig"])).toBe("Tesla");
    expect(stripOwnerPossessivePrefix("Craigs Tesla", ["Craig"])).toBe("Tesla");
    expect(stripOwnerPossessivePrefix("Chris' Boat", ["Chris"])).toBe("Boat");
  });

  it("does NOT strip a non-possessive prefix or an unrelated brand", () => {
    expect(stripOwnerPossessivePrefix("Craig Ford F250", ["Craig"])).toBe("Craig Ford F250");
    expect(stripOwnerPossessivePrefix("Levi's 501 Jeans", ["Craig"])).toBe("Levi's 501 Jeans");
    expect(stripOwnerPossessivePrefix("McDonald's Franchise", ["Craig"])).toBe("McDonald's Franchise");
  });

  it("leaves clean names untouched and tolerates empty owners", () => {
    expect(stripOwnerPossessivePrefix("Ford F250 2025", ["Craig"])).toBe("Ford F250 2025");
    expect(stripOwnerPossessivePrefix("Craig's Ford", [null, undefined, ""])).toBe("Craig's Ford");
  });
});

// Read-time self-heal wired through storage — pins that legacy owner-stamped
// names get cleaned on read (using each entity's own owner), not just by the
// pure helpers. MemStorage mirrors SupabaseStorage's heal logic.
describe("storage read-time name heal (MemStorage parity)", () => {
  it("strips a legacy '<Name> - <Owner>' tracker suffix using its linked profile", async () => {
    const store = new MemStorage();
    const craig = await store.createProfile({ name: "Craig", type: "person" } as any);
    const t = await store.createTracker({ name: "Calories - Craig", category: "nutrition", fields: [{ name: "calories", type: "number" }] } as any);
    await store.updateTracker(t.id, { linkedProfiles: [craig.id] } as any);

    const trackers = await store.getTrackers();
    expect(trackers.find(x => /calor/i.test(x.name))?.name).toBe("Calories");
  });

  it("leaves a tracker suffix that is NOT an owner name intact", async () => {
    const store = new MemStorage();
    const craig = await store.createProfile({ name: "Craig", type: "person" } as any);
    const t = await store.createTracker({ name: "Blood Pressure - Morning", category: "health", fields: [{ name: "systolic", type: "number" }] } as any);
    await store.updateTracker(t.id, { linkedProfiles: [craig.id] } as any);

    const trackers = await store.getTrackers();
    expect(trackers.find(x => /pressure/i.test(x.name))?.name).toBe("Blood Pressure - Morning");
  });

  it("strips a legacy possessive owner prefix from a child/asset profile", async () => {
    const store = new MemStorage();
    const craig = await store.createProfile({ name: "Craig", type: "person" } as any);
    await store.createProfile({ name: "Craig's Ford F250 2025", type: "vehicle", parentProfileId: craig.id } as any);

    const profiles = await store.getProfiles();
    expect(profiles.find(p => /ford/i.test(p.name))?.name).toBe("Ford F250 2025");
  });

  it("does not touch a person/pet profile name", async () => {
    const store = new MemStorage();
    await store.createProfile({ name: "Craig", type: "person" } as any);
    const profiles = await store.getProfiles();
    expect(profiles.find(p => p.type === "person")?.name).toBe("Craig");
  });
});


// ── Possessive ownership (2026-08-09 user report) ───────────────────────────
// "This is Bob's MacBook" had its possessive stripped to "MacBook" and was
// then parented to SELF, because the strip threw away the only evidence of who
// owned it — so the laptop counted toward the user's net worth instead of
// Bob's. The owner is in the sentence; losing it during cleanup is what put
// the asset on the wrong balance sheet.
describe("extractOwnerPossessive", () => {
  it("keeps the owner it stripped", () => {
    expect(extractOwnerPossessive("Bob's MacBook", ["Bob"]))
      .toEqual({ name: "MacBook", owner: "Bob" });
    expect(extractOwnerPossessive("Robert's Ford F250 2025", ["Robert", "Bob"]))
      .toEqual({ name: "Ford F250 2025", owner: "Robert" });
  });

  it("returns the caller's spelling so it resolves straight back to the profile", () => {
    expect(extractOwnerPossessive("bob's macbook", ["Bob"]).owner).toBe("Bob");
  });

  it("leaves brands and unknown owners alone", () => {
    expect(extractOwnerPossessive("Levi's 501 Jeans", ["Bob"]))
      .toEqual({ name: "Levi's 501 Jeans", owner: null });
    expect(extractOwnerPossessive("Steve's MacBook", ["Bob"]))
      .toEqual({ name: "Steve's MacBook", owner: null });
  });

  it("stays byte-identical to the old strip-only helper", () => {
    for (const [name, owners] of [
      ["Craig's Ford F250 2025", ["Craig"]],
      ["Levi's 501 Jeans", ["Craig"]],
      ["Ford F250", ["Craig"]],
    ] as Array<[string, string[]]>) {
      expect(stripOwnerPossessivePrefix(name, owners)).toBe(extractOwnerPossessive(name, owners).name);
    }
  });
});

describe("detectPossessiveOwner", () => {
  it("finds an owner with no profile list to check against", () => {
    expect(detectPossessiveOwner("Bob's MacBook")).toEqual({ name: "MacBook", owner: "Bob" });
    expect(detectPossessiveOwner("Robert's truck")).toEqual({ name: "truck", owner: "Robert" });
  });

  it("understands relationship words", () => {
    expect(detectPossessiveOwner("wife's car")).toEqual({ name: "car", owner: "wife" });
    expect(detectPossessiveOwner("Mom's iPad")).toEqual({ name: "iPad", owner: "Mom" });
  });

  it("does not treat a lowercase common noun as an owner", () => {
    expect(detectPossessiveOwner("today's total")).toBeNull();
    expect(detectPossessiveOwner("the car's battery")).toBeNull();
  });

  it("does not fire on a name with no possessive", () => {
    expect(detectPossessiveOwner("MacBook Pro M4")).toBeNull();
    expect(detectPossessiveOwner("my MacBook Pro M4")).toBeNull();
    expect(detectPossessiveOwner("")).toBeNull();
  });

  it("does not mistake a brand possessive for a person", () => {
    for (const name of ["Levi's 501 Jeans", "McDonald's gift card", "Lowe's credit card", "Sam's Club membership"]) {
      expect(detectPossessiveOwner(name), name).toBeNull();
    }
  });

  it("does not fire when nothing is left after the possessive", () => {
    expect(detectPossessiveOwner("Bob's")).toBeNull();
    expect(detectPossessiveOwner("Bob's a")).toBeNull();
  });
});
