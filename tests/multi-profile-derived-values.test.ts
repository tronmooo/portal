// End-to-end: two people, one activity, independent derived values.
//
// User report (screenshot): "Both Sarah Miller and I both played basketball for
// 20 minutes" logged two entries — correct — but stamped the SAME ~140 cal on
// both cards, because sport calories came from the model's flat cal/min table
// and nothing in the write path knew who was logging.
//
// The rule these tests pin:
//   value = calculate(explicit ?? THIS entity's stored data ?? standard default)
// Primary facts (basketball, 20 minutes) are shared because the user said so.
// Derived facts are resolved per entity, always — and a missing characteristic
// falls back to the app's standard estimate, never to the other person's data
// and never to a refusal or a follow-up question.
//
// Runs against MemStorage through the real log_tracker_entry handler: no
// network, no Anthropic call, no Supabase.
import { describe, it, expect } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";
import { enrichActivityEntry, parseWeightToKg } from "@shared/estimation-engine";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

const MESSAGE = "Sarah Miller and I both played basketball for 20 minutes";
const BALL = { activityType: "basketball", duration: 20 };

/** Set up the two people, optionally with stored weights. */
async function seed(storage: MemStorage, opts: { userWeight?: string; sarahWeight?: string }) {
  await storage.createProfile({
    name: "Me", type: "self",
    fields: opts.userWeight ? { weight: opts.userWeight } : {},
  } as any);
  await storage.createProfile({
    name: "Sarah Miller", type: "person",
    fields: opts.sarahWeight ? { weight: opts.sarahWeight } : {},
  } as any);
}

/** Log basketball for one person exactly as the chat turn would. */
function logBasketball(storage: MemStorage, forProfile?: string, values: Record<string, any> = BALL) {
  return run(storage, () => executeTool("log_tracker_entry", {
    trackerName: "Basketball",
    values: { ...values },
    ...(forProfile ? { forProfile } : {}),
    __userMessage: MESSAGE,
  } as any, "user-1")) as Promise<any>;
}

/** Every basketball entry that actually landed, across per-person trackers. */
async function basketballEntries(storage: MemStorage) {
  const trackers = await storage.getTrackers();
  return trackers
    .filter((t: any) => /basketball/i.test(t.name))
    .flatMap((t: any) => t.entries || []);
}

const caloriesOf = (e: any) => Number(e?.values?.caloriesBurned);

// What the engine produces for a person with no stored weight — the standard
// default estimate, computed here the same way the server computes it.
const DEFAULT_ESTIMATE = enrichActivityEntry("basketball", BALL, {}).estimated.caloriesBurned!.value;
const USER_ESTIMATE = enrichActivityEntry("basketball", BALL, {
  weightKg: parseWeightToKg("150 lbs")!,
}).estimated.caloriesBurned!.value;

describe("QA (a) — both weights stored: two entries, two different calorie numbers", () => {
  it("logs both people with the shared facts and independent derived values", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs", sarahWeight: "300 lbs" });

    const mine: any = await logBasketball(storage);
    const hers: any = await logBasketball(storage, "Sarah Miller");

    expect(mine?.error).toBeUndefined();
    expect(hers?.error).toBeUndefined();

    const entries = await basketballEntries(storage);
    expect(entries).toHaveLength(2);

    // Primary facts are shared — the user said so.
    for (const e of entries) {
      expect(e.values.activityType).toBe("basketball");
      expect(Number(e.values.duration)).toBe(20);
    }

    // Derived facts are not.
    const [a, b] = entries.map(caloriesOf).sort((x, y) => x - y);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    // 300 lb burns about twice what 150 lb burns over the same game.
    expect(b / a).toBeGreaterThan(1.8);
    expect(b / a).toBeLessThan(2.2);
  });

  it("records which weight each estimate used", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs", sarahWeight: "300 lbs" });
    await logBasketball(storage);
    await logBasketball(storage, "Sarah Miller");

    const entries = await basketballEntries(storage);
    for (const e of entries) {
      const assumptions = e.computed?.enrichment?.assumptions || [];
      expect(assumptions.map((a: any) => a.assumption)).toContain("Used profile weight");
    }
    const methods = entries.map((e: any) => e.computed?.enrichment?.estimated?.caloriesBurned?.method);
    expect(methods.some((m: string) => m?.includes("68kg"))).toBe(true);
    expect(methods.some((m: string) => m?.includes("136kg"))).toBe(true);
  });
});

describe("QA (b) — Sarah has no stored weight", () => {
  it("personalizes the user, gives Sarah the standard default, and logs both", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs" }); // Sarah: no weight

    const mine: any = await logBasketball(storage);
    const hers: any = await logBasketball(storage, "Sarah Miller");
    expect(mine?.error).toBeUndefined();
    expect(hers?.error).toBeUndefined();

    const entries = await basketballEntries(storage);
    expect(entries).toHaveLength(2);
    const values = entries.map(caloriesOf);

    // The user keeps their personalized number.
    expect(values).toContain(USER_ESTIMATE);
    // Sarah gets the app's standard estimate...
    expect(values).toContain(DEFAULT_ESTIMATE);
    // ...and specifically NOT the user's 150 lb number.
    expect(DEFAULT_ESTIMATE).not.toBe(USER_ESTIMATE);
  });

  it("labels Sarah's estimate as the population default, not a profile weight", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs" });
    await logBasketball(storage, "Sarah Miller");

    const [entry] = await basketballEntries(storage);
    const enrichment = entry.computed?.enrichment;
    expect(enrichment?.estimated?.caloriesBurned?.method).toContain("default weight 70kg");
    expect(enrichment?.assumptions.map((a: any) => a.assumption))
      .toContain("Used population default weight");
    // Never the other person's weight.
    expect(enrichment?.estimated?.caloriesBurned?.method).not.toContain("68kg");
  });
});

describe("QA (c) — neither weight stored", () => {
  it("still creates two independent entries, both on the standard estimate", async () => {
    const storage = new MemStorage();
    await seed(storage, {});

    await logBasketball(storage);
    await logBasketball(storage, "Sarah Miller");

    const entries = await basketballEntries(storage);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(caloriesOf(e)).toBe(DEFAULT_ESTIMATE);
      expect(Number(e.values.duration)).toBe(20);
      // No characteristics invented for anyone.
      expect(e.values.weight).toBeUndefined();
      expect(e.values.height).toBeUndefined();
    }
  });
});

describe("the model's copied number never survives", () => {
  it("replaces an invented caloriesBurned with per-person estimates", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs", sarahWeight: "300 lbs" });

    // Exactly what the screenshot showed: the model computed 140 once and
    // passed the same figure for both people.
    await logBasketball(storage, undefined, { ...BALL, caloriesBurned: 140 });
    await logBasketball(storage, "Sarah Miller", { ...BALL, caloriesBurned: 140 });

    const values = (await basketballEntries(storage)).map(caloriesOf);
    expect(values).toHaveLength(2);
    expect(values).not.toContain(140);
    expect(values[0]).not.toBe(values[1]);
  });

  it("keeps a calorie count the user actually stated for that person", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs" });
    await run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Basketball",
      values: { ...BALL, caloriesBurned: 300 },
      __userMessage: "I played basketball for 20 minutes and burned 300 calories",
    } as any, "user-1"));

    const [entry] = await basketballEntries(storage);
    expect(caloriesOf(entry)).toBe(300);
  });

  it("does not credit one person's stated calories to the other", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs", sarahWeight: "300 lbs" });
    const msg = "Sarah Miller and I both played basketball for 20 minutes, I burned 300 calories";

    await run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Basketball", values: { ...BALL, caloriesBurned: 300 }, __userMessage: msg,
    } as any, "user-1"));
    await run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Basketball", values: { ...BALL, caloriesBurned: 300 },
      forProfile: "Sarah Miller", __userMessage: msg,
    } as any, "user-1"));

    const values = (await basketballEntries(storage)).map(caloriesOf);
    expect(values).toContain(300);              // the user's own claim stands
    expect(values.filter((v) => v === 300)).toHaveLength(1); // Sarah's does not
  });
});

describe("neither person's entry depends on the other going first", () => {
  it("logs the named person's activity even when no tracker exists yet", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs", sarahWeight: "300 lbs" });

    // Sarah's call lands first — the model emits them in whatever order it
    // likes. This used to be refused with "which tracker did you mean?",
    // making the whole two-person flow order-dependent.
    const hers: any = await logBasketball(storage, "Sarah Miller");
    expect(hers?.error).toBeUndefined();

    const mine: any = await logBasketball(storage);
    expect(mine?.error).toBeUndefined();

    const entries = await basketballEntries(storage);
    expect(entries).toHaveLength(2);
    expect(entries.map(caloriesOf).sort((a, b) => a - b)[0])
      .not.toBe(entries.map(caloriesOf).sort((a, b) => a - b)[1]);
  });

  it("still asks rather than inventing a tracker from an unrecognized name", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "150 lbs", sarahWeight: "300 lbs" });
    const res: any = await run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Zorbleflug", values: { count: 1 },
      forProfile: "Sarah Miller", __userMessage: "log Zorbleflug for Sarah Miller",
    } as any, "user-1"));
    expect(res?.error).toMatch(/couldn't find a tracker/i);
  });
});

describe("derived values reach the rollups", () => {
  it("mirrors the personalized calories into computed for the daily totals", async () => {
    const storage = new MemStorage();
    await seed(storage, { userWeight: "300 lbs" });
    await logBasketball(storage);

    const [entry] = await basketballEntries(storage);
    expect(entry.computed?.caloriesBurned).toBe(caloriesOf(entry));
  });
});
