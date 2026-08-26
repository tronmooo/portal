// ── Overview engine: canonical gathering + schema caching ────────────────────
// The engine's contract: read canonical data, consult the model about SHAPE
// only, and never let a cached layout carry a cached value.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildOverviewInput, buildOverviewSpec, getSchemaHints, isOverviewEntity } from "../server/overview-engine";
import { overviewSignature } from "@shared/overview-spec";

function fakeStorage(overrides: Record<string, any> = {}) {
  const prefs = new Map<string, string>();
  const base = {
    getProfileDetail: vi.fn(async () => ({
      id: "house", name: "123 Evergreen Ln", type: "property",
      fields: { address: "123 Evergreen Ln", currentValue: 345000 },
      tags: [], notes: "", updatedAt: "2026-08-01T00:00:00Z",
      relatedDocuments: [{ id: "d1", name: "Deed.pdf", type: "deed", createdAt: "2024-01-01" }],
      relatedExpenses: [], relatedObligations: [], relatedTasks: [],
      childProfiles: [], timeline: [],
    })),
    getProfile: vi.fn(async (id: string) => ({
      id, name: "Evergreen Mortgage", type: "liability", type_key: "mortgage",
      fields: { balance: 240000, monthlyPayment: 1850 },
    })),
    getLiabilityAssetLinksForAsset: vi.fn(async () => [
      { id: "l1", liabilityProfileId: "mortgage-1", assetProfileId: "house", ownershipPercentage: 100, role: "collateral" },
    ]),
    getLiabilityAssetLinks: vi.fn(async () => []),
    getAssetPartyLinks: vi.fn(async () => []),
    getLiabilityProfileLinks: vi.fn(async () => []),
    getPreference: vi.fn(async (k: string) => prefs.get(k) ?? null),
    setPreference: vi.fn(async (k: string, v: string) => { prefs.set(k, v); }),
  };
  return { ...base, ...overrides } as any;
}

describe("which profiles the dynamic Overview drives", () => {
  it("claims assets and liabilities, and leaves people alone", () => {
    expect(isOverviewEntity({ type: "property" })).toBe(true);
    expect(isOverviewEntity({ type: "liability" })).toBe(true);
    expect(isOverviewEntity({ type: "person" })).toBe(false);
    expect(isOverviewEntity({ type: "pet" })).toBe(false);
  });
});

describe("canonical gathering", () => {
  it("pulls the linked mortgage in as financing without copying its data over", async () => {
    const storage = fakeStorage();
    const input = await buildOverviewInput(storage, "house");
    expect(input?.related).toHaveLength(1);
    expect(input?.related?.[0]).toMatchObject({ id: "mortgage-1", relation: "financing" });
    // The asset's own fields are untouched by what its liability knows.
    expect(input?.entity.fields?.balance).toBeUndefined();
  });

  it("returns null for a profile that does not exist", async () => {
    const storage = fakeStorage({ getProfileDetail: vi.fn(async () => undefined) });
    expect(await buildOverviewInput(storage, "nope")).toBeNull();
  });

  it("degrades instead of failing when a link table is unavailable", async () => {
    const storage = fakeStorage({
      getLiabilityAssetLinksForAsset: vi.fn(async () => { throw new Error("no such table"); }),
    });
    const input = await buildOverviewInput(storage, "house");
    expect(input).not.toBeNull();
    expect(input?.related).toEqual([]);
  });
});

describe("schema hints are cached by shape, values never are", () => {
  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });

  it("makes no model call when the caller forbids it", async () => {
    const storage = fakeStorage();
    process.env.ANTHROPIC_API_KEY = "test-key";
    const input = await buildOverviewInput(storage, "house");
    const hints = await getSchemaHints(storage, "house", input!, { allowModel: false });
    expect(hints).toBeNull();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("reuses a cached composition for an unchanged shape and discards it when the shape changes", async () => {
    const storage = fakeStorage();
    const input = await buildOverviewInput(storage, "house");
    const signature = overviewSignature({
      type: "property", typeKey: undefined,
      fieldKeys: Object.keys(input!.entity.fields || {}),
      relationKinds: ["financing"], hasDocuments: true,
    });
    await storage.setPreference("overview_schema_house", JSON.stringify({
      signature, generatedAt: new Date().toISOString(),
      hints: { entityLabel: "Single-family home", fieldHints: { currentValue: { importance: "primary" } } },
    }));

    const hit = await getSchemaHints(storage, "house", input!, {});
    expect(hit?.entityLabel).toBe("Single-family home");

    // Same profile, one more stored field → the layout is stale even though
    // the numbers are always fresh, so the cache must not be reused.
    const changed = { ...input!, entity: { ...input!.entity, fields: { ...input!.entity.fields, yearBuilt: 1974 } } };
    const miss = await getSchemaHints(storage, "house", changed, { allowModel: false });
    expect(miss).toBeNull();
  });

  it("composes a full spec with values read from storage on this call", async () => {
    const storage = fakeStorage();
    const spec = await buildOverviewSpec(storage, "house", { allowModel: false });
    expect(spec?.identity.headline?.value).toBe(345000);
    expect(spec?.meta.schemaSource).toBe("deterministic");
    const equity = [...(spec?.summaryMetrics || []), ...(spec?.sections.flatMap(s => s.values || []) || [])]
      .find(v => v.semanticKey === "equity");
    expect(equity?.value).toBe(105000);

    // Change the stored value; the same composition returns the new number.
    storage.getProfileDetail = vi.fn(async () => ({
      id: "house", name: "123 Evergreen Ln", type: "property",
      fields: { address: "123 Evergreen Ln", currentValue: 360000 },
      tags: [], notes: "", relatedDocuments: [], relatedExpenses: [],
      relatedObligations: [], relatedTasks: [], childProfiles: [], timeline: [],
    }));
    const after = await buildOverviewSpec(storage, "house", { allowModel: false });
    expect(after?.identity.headline?.value).toBe(360000);
  });
});
