// End-to-end walk of the seven flows from the 2026-08-11 report, driven
// through the real storage implementation (MemStorage — the same IStorage
// contract SupabaseStorage implements, and the same cascade rules) plus the
// real routing gate. No network, no API key: every rule these flows depend on
// is deterministic code.
//
//   1. create a normal person profile
//   2. create an asset profile — and NO person alongside it
//   3. create a nested asset under the right parent
//   4. delete a secondary person, and take their data with them
//   5. the primary account owner cannot be deleted
//   6. re-read storage: deleted profiles do not come back
//   7. no orphaned records, no duplicate entities, correct counts
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { parseTurnPlan } from "@shared/ai-intent";
import {
  checkToolAgainstIntent,
  findDuplicateCreateInTurn,
  recordTurnCreate,
  type TurnCreate,
} from "@shared/ai-tool-routing";
import { looksLikeThingNotPerson } from "@shared/entity-naming";
import { isPrimaryProfile } from "@shared/profile-protection";

/**
 * The chat turn loop's three refusals, in the order server/ai-engine.ts
 * applies them. Returns the reason a call was refused, or null when it runs.
 */
function gate(
  message: string,
  tool: string,
  input: Record<string, any>,
  turnCreates: TurnCreate[],
): string | null {
  const dup = findDuplicateCreateInTurn(tool, input, turnCreates);
  if (dup) return "duplicate_create_in_turn";
  const violation = checkToolAgainstIntent(tool, parseTurnPlan(message), input);
  if (violation) return violation.mismatchType;
  // The executor's own last-resort guard (server/ai-engine.ts create_profile).
  if (
    tool === "create_profile" &&
    ["person", "self"].includes(String(input.type)) &&
    looksLikeThingNotPerson(String(input.name || ""))
  ) {
    return "PERSON_TYPE_FOR_THING";
  }
  return null;
}

describe("profile lifecycle, end to end", () => {
  let storage: MemStorage;
  let selfId: string;

  beforeEach(async () => {
    storage = new MemStorage();
    const me = await storage.createProfile({ type: "self", name: "Poop", fields: {}, tags: [], notes: "" } as any);
    selfId = me.id;
  });

  // ── 1 ──────────────────────────────────────────────────────────────────────
  it("1. creates a normal person profile", async () => {
    const msg = "Create a person profile for John Hancock";
    const input = { type: "person", name: "John Hancock" };
    expect(gate(msg, "create_profile", input, [])).toBeNull();

    const john = await storage.createProfile({ ...input, fields: {}, tags: [], notes: "" } as any);
    expect(john.type).toBe("person");

    const people = (await storage.getProfiles()).filter(p => p.type === "person");
    expect(people.map(p => p.name)).toEqual(["John Hancock"]);
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────
  it("2. creates an asset profile and NO person alongside it", async () => {
    const msg = "Create an asset profile for tires for my Dodge Ram 2025, $1200";
    const truck = await storage.createProfile({ type: "vehicle", name: "Dodge Ram 2025", parentProfileId: selfId, fields: {}, tags: [], notes: "" } as any);

    const turnCreates: TurnCreate[] = [];

    // The call the user actually asked for.
    const assetInput = { type: "asset", name: "Tires", forProfile: "Dodge Ram 2025", fields: { currentValue: 1200 } };
    expect(gate(msg, "create_profile", assetInput, turnCreates)).toBeNull();
    await storage.createProfile({ type: "asset", name: "Tires", parentProfileId: truck.id, fields: { currentValue: 1200 }, tags: [], notes: "" } as any);
    turnCreates.push(recordTurnCreate("create_profile", assetInput)!);

    // The call production ALSO made. All three layers refuse it — the
    // same-turn shadow rule is simply the first one the engine reaches.
    const personInput = { type: "person", name: "my tires for my Dodge ram" };
    expect(gate(msg, "create_profile", personInput, turnCreates)).toBe("duplicate_create_in_turn");
    // …and the intent gate refuses it independently, with no turn history.
    expect(gate(msg, "create_profile", personInput, [])).toBe("entity_mismatch");

    // Nothing was written for it.
    const all = await storage.getProfiles();
    expect(all.filter(p => p.type === "person")).toHaveLength(0);
    expect(all).toHaveLength(3); // self + truck + tires
  });

  it("2b. refuses the phantom person even when the message never says 'asset'", async () => {
    // Without the word "asset" the intent is not confident enough to gate on,
    // so the same-turn shadow rule is what has to catch it.
    const msg = "Add tires for my Dodge Ram 2025 worth $1200";
    const turnCreates: TurnCreate[] = [];
    const assetInput = { type: "asset", name: "Tires", forProfile: "Dodge Ram 2025" };
    expect(gate(msg, "create_profile", assetInput, turnCreates)).toBeNull();
    turnCreates.push(recordTurnCreate("create_profile", assetInput)!);

    expect(gate(msg, "create_profile", { type: "person", name: "my tires for my Dodge ram" }, turnCreates))
      .toBe("duplicate_create_in_turn");
  });

  it("2c. refuses a thing-shaped person even with no prior create to compare to", async () => {
    // The executor guard standing alone — this is what protects create_profile
    // when it is reached from outside the chat turn loop.
    const msg = "Add tires";
    expect(gate(msg, "create_profile", { type: "person", name: "tires for my Dodge ram" }, []))
      .toBe("PERSON_TYPE_FOR_THING");
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────
  it("3. nests an asset under the correct parent asset", async () => {
    const laptop = await storage.createProfile({ type: "asset", name: "MacBook Pro M4", parentProfileId: selfId, fields: {}, tags: [], notes: "" } as any);
    const msg = "Add an asset for my MacBook screen cover";
    expect(gate(msg, "create_profile", { type: "asset", name: "MacBook Screen Cover", forProfile: "MacBook Pro M4" }, [])).toBeNull();

    const cover = await storage.createProfile({ type: "asset", name: "MacBook Screen Cover", parentProfileId: laptop.id, fields: {}, tags: [], notes: "" } as any);

    expect(cover.parentProfileId).toBe(laptop.id);
    const detail = await storage.getProfileDetail(laptop.id);
    expect((detail as any).childProfiles.map((c: any) => c.name)).toEqual(["MacBook Screen Cover"]);
    // …and no person was invented for the parent.
    expect((await storage.getProfiles()).filter(p => p.type === "person")).toHaveLength(0);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────
  it("4. deletes a secondary person and everything linked to them", async () => {
    const bob = await storage.createProfile({ type: "person", name: "Bob", fields: {}, tags: [], notes: "" } as any);
    const bobsCar = await storage.createProfile({ type: "vehicle", name: "Civic", parentProfileId: bob.id, fields: {}, tags: [], notes: "" } as any);

    // Several MemStorage constructors initialise linkedProfiles to [] and
    // ignore the value passed in, so set the links explicitly through the
    // update path — that is the state the cascade actually reads.
    const link = async (
      update: (id: string, patch: any) => Promise<any>,
      row: { id: string },
      profiles: string[],
    ) => { await update(row.id, { linkedProfiles: profiles }); };

    const task = await storage.createTask({ title: "Bob's oil change" } as any);
    await link(storage.updateTask.bind(storage), task, [bob.id]);
    const habit = await storage.createHabit({ name: "Bob's walk" } as any);
    await link(storage.updateHabit.bind(storage), habit, [bob.id]);
    const event = await storage.createEvent({ title: "Bob's dentist", date: "2026-08-20" } as any);
    await link(storage.updateEvent.bind(storage), event, [bob.id]);
    await storage.createExpense({ description: "Bob's fuel", amount: 40, category: "vehicle", date: "2026-08-11", linkedProfiles: [bob.id] } as any);
    const tracker = await storage.createTracker({ name: "Bob's weight", category: "health" } as any);
    await link(storage.updateTracker.bind(storage), tracker, [bob.id]);
    const doc = await storage.createDocument({ name: "Bob's insurance", type: "pdf" } as any);
    await link(storage.updateDocument.bind(storage), doc, [bob.id]);
    const goal = await storage.createGoal({ title: "Bob's savings" } as any);
    await link(storage.updateGoal.bind(storage), goal, [bob.id]);
    const entry = await storage.createJournalEntry({ content: "Bob had a good day", date: "2026-08-11" } as any);
    await link(storage.updateJournalEntry.bind(storage), entry, [bob.id]);

    // A record Bob CO-owns with the account holder must survive, minus Bob.
    const shared = await storage.createTask({ title: "Shared chore" } as any);
    await link(storage.updateTask.bind(storage), shared, [bob.id, selfId]);

    expect(await storage.deleteProfile(bob.id)).toBe(true);

    expect(await storage.getProfile(bob.id)).toBeUndefined();
    // The child asset goes with its owner.
    expect(await storage.getProfile(bobsCar.id)).toBeUndefined();

    const nameOf = (rows: any[]) => rows.map(r => r.title || r.name || r.description || r.content);
    expect(nameOf(await storage.getTasks())).toEqual(["Shared chore"]);
    expect(await storage.getHabits()).toHaveLength(0);
    expect(await storage.getEvents()).toHaveLength(0);
    expect(await storage.getExpenses()).toHaveLength(0);
    expect(await storage.getTrackers()).toHaveLength(0);
    expect(await storage.getDocuments()).toHaveLength(0);
    expect(await storage.getGoals()).toHaveLength(0);
    expect(await storage.getJournalEntries()).toHaveLength(0);

    // The co-owned row kept its other owner and lost only Bob.
    const survivor = (await storage.getTasks()).find(t => t.id === shared.id)!;
    expect(survivor.linkedProfiles).toEqual([selfId]);
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────
  it("5. refuses to delete the primary account owner", async () => {
    const me = (await storage.getProfile(selfId))!;
    expect(isPrimaryProfile(me)).toBe(true);

    expect(await storage.deleteProfile(selfId)).toBe(false);
    expect(await storage.getProfile(selfId)).toBeDefined();
  });

  it("5b. leaves the owner's data alone when the delete is refused", async () => {
    await storage.createTask({ title: "My task", linkedProfiles: [selfId] } as any);
    await storage.deleteProfile(selfId);
    expect(await storage.getTasks()).toHaveLength(1);
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────
  it("6. a deleted profile stays deleted on a fresh read", async () => {
    const bob = await storage.createProfile({ type: "person", name: "Bob", fields: {}, tags: [], notes: "" } as any);
    await storage.deleteProfile(bob.id);

    // Every read path, as a reload would hit them.
    expect((await storage.getProfiles()).some(p => p.id === bob.id)).toBe(false);
    expect(await storage.getProfile(bob.id)).toBeUndefined();
    expect(await storage.getProfileDetail(bob.id)).toBeUndefined();
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────
  it("7. leaves no orphans, no duplicates and correct counts", async () => {
    const bob = await storage.createProfile({ type: "person", name: "Bob", fields: {}, tags: [], notes: "" } as any);
    const car = await storage.createProfile({ type: "vehicle", name: "Civic", parentProfileId: bob.id, fields: {}, tags: [], notes: "" } as any);
    await storage.createProfile({ type: "asset", name: "Roof Rack", parentProfileId: car.id, fields: {}, tags: [], notes: "" } as any);
    await storage.createTask({ title: "Rotate tyres", linkedProfiles: [car.id] } as any);
    await storage.createProfile({ type: "person", name: "Dana", fields: {}, tags: [], notes: "" } as any);

    expect(await storage.deleteProfile(bob.id)).toBe(true);

    const remaining = await storage.getProfiles();
    // Self + Dana. Bob, his car and the rack nested under it are all gone.
    expect(remaining.map(p => p.name).sort()).toEqual(["Dana", "Poop"]);

    // No profile points at a parent that no longer exists.
    const ids = new Set(remaining.map(p => p.id));
    for (const p of remaining) {
      if (p.parentProfileId) expect(ids.has(p.parentProfileId)).toBe(true);
    }

    // No linked_profiles entry points at a deleted profile, anywhere.
    const linkedRows: any[] = [
      ...(await storage.getTasks()), ...(await storage.getHabits()),
      ...(await storage.getEvents()), ...(await storage.getExpenses()),
      ...(await storage.getTrackers()), ...(await storage.getDocuments()),
      ...(await storage.getGoals()), ...(await storage.getJournalEntries()),
    ];
    for (const row of linkedRows) {
      for (const pid of (row.linkedProfiles || [])) expect(ids.has(pid)).toBe(true);
    }

    // Exactly one row per name — the deletion did not leave a shadow behind.
    const names = remaining.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
