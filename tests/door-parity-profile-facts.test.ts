// ─── Door parity: profile facts ─────────────────────────────────────────────
//
// The canonical case for the whole orchestration layer: "Sam's birthday is
// July 10 1990" through the chat door, the fact service (what extraction
// confirm calls), or a REST field PATCH must produce IDENTICAL state — the
// date on the profile's own field, NO separate calendar event, and exactly
// ONE derived date rule with a deterministic identity. Fixing birthday
// behavior in the service fixes it everywhere; restating the fact can never
// duplicate it.
import { describe, it, expect } from "vitest";
import { executeTool } from "../server/ai-engine";
import { setProfileFact, fieldForFact } from "../server/actions/profile-fact-service";
import { canonicalizeProfileFields } from "@shared/profile-field-canon";
import { deriveDateRulesForRecord } from "@shared/temporal-rules";
import { MemStorage, withStorage } from "./door-parity/harness";

let seq = 0;
const nextUser = () => `door-parity-pf-${++seq}`;

const DOB = "1990-07-10";

async function birthdayRules(store: MemStorage, profileId: string, userId: string) {
  const profile = await store.getProfile(profileId);
  return deriveDateRulesForRecord(userId, "profile", profile).filter((r) => r.ruleType === "birthday");
}

describe("door parity — birthday fact", () => {
  it("chat, the fact service, and a REST-style field patch land on identical state", async () => {
    const doors: Array<{ door: string; run: (store: MemStorage, samId: string, userId: string) => Promise<any> }> = [
      {
        door: "chat",
        // "Sam's Birthday" with a past year is a fact about Sam, not an event
        // — the chat door redirects into the fact service.
        run: (store, _samId, userId) =>
          withStorage(store, () =>
            executeTool("create_event", { title: "Sam's Birthday", date: DOB, forProfile: "Sam" }, userId)),
      },
      {
        door: "extraction",
        run: (store, _samId, userId) =>
          setProfileFact(store, { profileRef: "Sam", kind: "birthday", value: "July 10, 1990", userId }),
      },
      {
        door: "rest",
        // What PATCH /api/profiles/:id does with a dateOfBirth field.
        run: async (store, samId) => {
          const existing = (await store.getProfile(samId))!.fields || {};
          return store.updateProfile(samId, {
            fields: { ...existing, ...canonicalizeProfileFields({ dateOfBirth: DOB }, existing).fields },
          } as any);
        },
      },
    ];

    const outcomes: Array<{ door: string; dob: any; ruleKeys: string[] }> = [];
    for (const d of doors) {
      const store = new MemStorage();
      const userId = nextUser();
      const sam = await store.createProfile({ name: "Sam", type: "person" } as any);
      const result = await d.run(store, sam.id, userId);
      expect(result?.error, `${d.door}: no error`).toBeUndefined();

      // The fact lives on the profile's own field…
      const profile = await store.getProfile(sam.id);
      expect(profile?.fields?.dateOfBirth, `${d.door}: DOB on profile`).toBe(DOB);
      // …no separate calendar event was minted…
      expect(await store.getEvents(), `${d.door}: no event row`).toHaveLength(0);
      // …and exactly one birthday rule derives from it.
      const rules = await birthdayRules(store, sam.id, userId);
      expect(rules, `${d.door}: one derived rule`).toHaveLength(1);
      expect(rules[0].recurrence, `${d.door}: yearly`).toBe("yearly");
      outcomes.push({
        door: d.door,
        dob: profile?.fields?.dateOfBirth,
        // The key sans user must be identical across doors (same record id
        // differs per store, so compare field+type tail).
        ruleKeys: rules.map((r) => r.key.split("|").slice(3).join("|")),
      });
    }
    expect(outcomes[0].ruleKeys).toEqual(outcomes[1].ruleKeys);
    expect(outcomes[1].ruleKeys).toEqual(outcomes[2].ruleKeys);
  });

  it("restating the fact updates the one field — never a second rule", async () => {
    const store = new MemStorage();
    const userId = nextUser();
    await store.createProfile({ name: "Sam", type: "person" } as any);
    const first = await setProfileFact(store, { profileRef: "Sam", kind: "birthday", value: DOB, userId });
    expect(first.error).toBeUndefined();
    const again = await setProfileFact(store, { profileRef: "Sam", kind: "birthday", value: "1990-07-10", userId });
    expect(again.error).toBeUndefined();
    const sam = (await store.getProfiles())[0];
    expect(await birthdayRules(store, sam.id, userId)).toHaveLength(1);
  });
});

describe("door parity — expiration fact", () => {
  it("names the field for what expires and derives the important date from it", async () => {
    const store = new MemStorage();
    const userId = nextUser();
    const me = await store.createProfile({ name: "Me", type: "self" } as any);
    const result = await setProfileFact(store, {
      profileId: me.id, kind: "expiration", subject: "driver's license", value: "2034-07-18", userId,
    });
    expect(result.error).toBeUndefined();
    expect(result.field).toBe("driversLicenseExpiration");
    const profile = await store.getProfile(me.id);
    expect(profile?.fields?.driversLicenseExpiration).toBe("2034-07-18");
    const rules = deriveDateRulesForRecord(userId, "profile", profile);
    const expiry = rules.filter((r) => r.ruleType === "expiration" || r.ruleType === "renewal");
    expect(expiry.length).toBeGreaterThanOrEqual(1);
    expect(await store.getEvents()).toHaveLength(0);
  });
});

describe("fact guards", () => {
  it("never guesses an owner: ambiguity is surfaced, not resolved silently", async () => {
    const store = new MemStorage();
    await store.createProfile({ name: "Sam Hill", type: "person" } as any);
    await store.createProfile({ name: "Sam Pool", type: "person" } as any);
    const result = await setProfileFact(store, {
      profileRef: "Sam", kind: "birthday", value: DOB, userId: nextUser(),
    });
    expect(result.error).toMatch(/which one/i);
    expect(result.candidates).toHaveLength(2);
    for (const p of await store.getProfiles()) {
      expect(p.fields?.dateOfBirth).toBeUndefined();
    }
  });

  it("kind → field mapping is the single source", () => {
    expect(fieldForFact("birthday")).toBe("dateOfBirth");
    expect(fieldForFact("anniversary")).toBe("anniversary");
    expect(fieldForFact("email")).toBe("email");
    expect(fieldForFact("expiration", "passport")).toMatch(/Expiration$/);
  });
});
