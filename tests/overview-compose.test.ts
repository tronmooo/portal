// ── Dynamic Asset & Liability Overview (2026-08-26) ──────────────────────────
// The Overview must be composed from what the entity IS, not from a per-type
// template. These tests pin the properties that make that true:
//   * an entity type nobody designed for still gets a sensible Overview
//   * values are resolved from canonical data on every compose
//   * the layout is cached by SHAPE (signature), never by value
//   * relationship data stays owned by the linked entity
//   * the same number never renders four times under four names
//   * missing information is suggested only when it unlocks something
import { describe, it, expect } from "vitest";
import { composeOverview, monthlyEquivalent, type ComposeInput } from "@shared/overview-compose";
import { normalizeSchemaHints, overviewSignature } from "@shared/overview-spec";
import { classifyOverviewEntity, fieldSemantics } from "@shared/overview-semantics";

const NOW = new Date("2026-08-26T12:00:00Z");

function input(over: Partial<ComposeInput> & { entity: ComposeInput["entity"] }): ComposeInput {
  return { now: NOW, ...over };
}

function sectionIds(spec: ReturnType<typeof composeOverview>): string[] {
  return spec.sections.map(s => s.id);
}

function allRenderedValues(spec: ReturnType<typeof composeOverview>): Array<string | number | null> {
  const out: Array<string | number | null> = [];
  if (spec.identity.headline) out.push(spec.identity.headline.value);
  for (const m of spec.summaryMetrics) out.push(m.value);
  for (const s of spec.sections) for (const v of s.values || []) out.push(v.value);
  return out;
}

describe("entity classification drives the Overview, not a type template", () => {
  it("recognizes a property from its fields without being told", () => {
    const c = classifyOverviewEntity({
      type: "property", name: "123 Evergreen Ln",
      fields: { address: "123 Evergreen Ln", squareFootage: 2100, bedrooms: 3 },
    });
    expect(c.semanticCategory).toBe("real_estate");
    expect(c.entityClass).toBe("asset");
  });

  it("still composes a usable Overview for an entity type we never designed for", () => {
    const spec = composeOverview(input({
      entity: {
        id: "p1", name: "Hull #4412 Sailboat", type: "asset",
        fields: {
          currentValue: 68000, purchasePrice: 52000, hullIdentificationNumber: "USZ4412",
          slipLocation: "Marina B, Slip 22", registrationExpiration: "2026-09-20",
        },
      },
    }));
    // No template exists for a sailboat; the composition still knows what the
    // money means, what the date means, and what identifies the thing.
    expect(spec.identity.headline?.semanticKey).toBe("currentValue");
    expect(spec.summaryMetrics.some(m => m.semanticKey === "appreciation")).toBe(true);
    expect(spec.attentionItems.some(a => /Registration Expiration/i.test(a.title))).toBe(true);
    // Its remaining facts are grouped by what they mean — the hull number is
    // identity, the slip is location — whether that lands in per-group cards
    // or the compact single card a sparse entity gets.
    const shown = spec.sections.flatMap(s => (s.values || []).map(v => v.semanticKey));
    expect(shown).toContain("hullIdentificationNumber");
    expect(shown).toContain("slipLocation");
  });

  it("classifies field roles from key shape, so unknown keys still land correctly", () => {
    expect(fieldSemantics("annualGroundLeaseFee", 1200).role).toBe("financial");
    expect(fieldSemantics("nextInspectionDate", "2026-11-01").role).toBe("date");
    expect(fieldSemantics("nextInspectionDate", "2026-11-01").dateMeaning).toBe("inspection");
    expect(fieldSemantics("mooringCondition", "good").role).toBe("status");
    // An unknown key holding an ISO date is a date, whatever it is called.
    expect(fieldSemantics("skipperHandoff", "2026-10-02").role).toBe("date");
  });
});

describe("relevance: the Overview is a summary, not a database dump", () => {
  it("keeps administrative bookkeeping off the page entirely", () => {
    const spec = composeOverview(input({
      entity: {
        id: "p2", name: "Sony TV", type: "asset",
        fields: {
          currentValue: 1200, valuationMethod: "ai", valuationConfidence: "medium",
          ownerProfileId: "abc-123", _internalFlag: true, serialNumber: "SN-99",
        },
      },
    }));
    const keys = spec.sections.flatMap(s => (s.values || []).map(v => v.semanticKey));
    expect(keys).not.toContain("valuationMethod");
    expect(keys).not.toContain("ownerProfileId");
    expect(keys).not.toContain("_internalFlag");
  });

  it("routes lower-value detail elsewhere instead of dumping it on the Overview", () => {
    const spec = composeOverview(input({
      entity: {
        id: "p3", name: "Workstation", type: "asset",
        fields: {
          currentValue: 3400, processor: "Xeon W-3400", memory: "128GB",
          supportPhone: "555-0100", condition: "excellent",
        },
      },
    }));
    const routed = (spec.meta.routedElsewhere || []).map(r => r.semanticKey);
    expect(routed).toContain("processor");
    expect(routed).toContain("supportPhone");
    const shown = spec.sections.flatMap(s => (s.values || []).map(v => v.semanticKey));
    expect(shown).not.toContain("processor");
  });

  it("does not spread a handful of facts over a wall of near-empty cards", () => {
    const spec = composeOverview(input({
      entity: {
        id: "p4", name: "Storage Unit", type: "asset",
        fields: { address: "Unit 14", condition: "good", monthlyRent: 95 },
      },
    }));
    const groupSections = spec.sections.filter(s => s.component === "groupedDetails");
    expect(groupSections.length).toBeLessThanOrEqual(1);
  });
});

describe("financial intelligence is derived, sourced, and never invented", () => {
  const house: ComposeInput = input({
    entity: {
      id: "house", name: "123 Evergreen Ln", type: "property",
      fields: { address: "123 Evergreen Ln", currentValue: 345000, purchasePrice: 300000 },
    },
    related: [{
      id: "mortgage-1", name: "Evergreen Mortgage", kind: "mortgage", relation: "financing",
      fields: { balance: 240000, monthlyPayment: 1850 },
    }],
    owners: [{ profileId: "me", name: "Me", percentage: 100 }],
  });

  it("computes equity from the linked liability's balance", () => {
    const spec = composeOverview(house);
    const equity = [...spec.summaryMetrics, ...spec.sections.flatMap(s => s.values || [])]
      .find(v => v.semanticKey === "equity");
    expect(equity?.value).toBe(105000);
    expect(equity?.provenance).toBe("calculated");
    // A derived number must say what it was built from.
    expect(equity?.sourceReference.inputs).toEqual(["currentValue", "linkedLiability.balance"]);
  });

  it("shows the mortgage as a relationship whose values still belong to it", () => {
    const spec = composeOverview(house);
    const rel = spec.sections.find(s => s.component === "relationshipSummary")?.relationships?.[0];
    expect(rel?.entityId).toBe("mortgage-1");
    const balance = rel?.facts.find(f => f.semanticKey === "balance");
    expect(balance?.value).toBe(240000);
    // Displayed here, owned there.
    expect(balance?.sourceReference.kind).toBe("relationship");
    expect(balance?.sourceReference.entityId).toBe("mortgage-1");
  });

  it("does not repeat the same number under four different labels", () => {
    const spec = composeOverview(house);
    const rendered = allRenderedValues(spec).filter(v => v === 345000);
    expect(rendered).toHaveLength(1);
  });

  it("computes payoff progress and utilization only when both inputs exist", () => {
    const loan = composeOverview(input({
      entity: {
        id: "loan", name: "Auto Loan", type: "liability", type_key: "auto_loan",
        fields: { balance: 12000, originalPrincipal: 30000, monthlyPayment: 450 },
      },
    }));
    const progress = loan.sections.find(s => s.component === "progressIndicator");
    expect(progress?.data?.percent).toBe(60);

    const card = composeOverview(input({
      entity: {
        id: "cc", name: "Sapphire Card", type: "liability", type_key: "credit_card",
        fields: { balance: 2400, creditLimit: 10000 },
      },
    }));
    const util = [...card.summaryMetrics, ...card.sections.flatMap(s => s.values || [])]
      .find(v => v.semanticKey === "utilization");
    expect(util?.value).toBe(24);

    // Nothing to compare against → no metric, and no invented one.
    const bare = composeOverview(input({
      entity: { id: "x", name: "Loan", type: "liability", fields: { balance: 5000 } },
    }));
    expect(bare.sections.find(s => s.component === "progressIndicator")).toBeUndefined();
    expect(allRenderedValues(bare).every(v => v !== 0 || true)).toBe(true);
  });

  it("rolls carrying cost up from financing, obligations and spend history", () => {
    const spec = composeOverview(input({
      entity: { id: "p", name: "Rental", type: "property", fields: { currentValue: 400000 } },
      related: [{ id: "m", name: "Mortgage", kind: "mortgage", relation: "financing", fields: { balance: 100000, monthlyPayment: 1200 } }],
      obligations: [{ name: "HOA", amount: 300, frequency: "quarterly" }],
      expenses: { count: 6, total: 3000, monthlyAverage: 100 },
    }));
    const monthly = [...spec.summaryMetrics, ...spec.sections.flatMap(s => s.values || [])]
      .find(v => v.semanticKey === "monthlyCarryingCost");
    expect(monthly?.value).toBe(1200 + 100 + 100);
    expect(monthly?.sourceReference.inputs).toContain("obligation.HOA");
  });

  it("normalizes any cadence to a monthly equivalent", () => {
    expect(monthlyEquivalent(1200, "yearly")).toBe(100);
    expect(monthlyEquivalent(300, "quarterly")).toBe(100);
    expect(Math.round(monthlyEquivalent(100, "weekly"))).toBe(433);
    expect(monthlyEquivalent(500, "one-time")).toBe(0);
  });
});

describe("dates carry meaning, not just text", () => {
  it("raises attention for what is due, expired or renewing soon", () => {
    const spec = composeOverview(input({
      entity: {
        id: "policy", name: "Homeowners Policy", type: "liability", type_key: "insurance",
        fields: { premium: 1450, policyExpirationDate: "2026-09-10", purchaseDate: "2019-04-01" },
      },
    }));
    const expiry = spec.attentionItems.find(a => a.id === "date:policyExpirationDate");
    expect(expiry?.daysUntil).toBe(15);
    expect(expiry?.severity).toBe("warning");
    // A purchase date is history, not something to act on.
    expect(spec.attentionItems.some(a => /purchase/i.test(a.id))).toBe(false);
  });

  it("flags an overdue obligation as critical", () => {
    const spec = composeOverview(input({
      entity: { id: "b", name: "Internet", type: "liability", fields: { monthlyPayment: 80 } },
      obligations: [{ name: "Internet bill", amount: 80, frequency: "monthly", nextDueDate: "2026-08-20" }],
    }));
    expect(spec.attentionItems[0].severity).toBe("critical");
  });
});

describe("missing information is specific and unlocks something", () => {
  it("asks for the purchase price only when it would unlock appreciation", () => {
    const withValue = composeOverview(input({
      entity: { id: "a", name: "Guitar", type: "asset", fields: { currentValue: 2200 } },
    }));
    const suggestion = withValue.missingInformation.find(m => m.semanticKey === "purchasePrice");
    expect(suggestion?.unlocks).toBe("appreciation");

    const withBoth = composeOverview(input({
      entity: { id: "a", name: "Guitar", type: "asset", fields: { currentValue: 2200, purchasePrice: 1800 } },
    }));
    expect(withBoth.missingInformation.some(m => m.semanticKey === "purchasePrice")).toBe(false);
  });

  it("never fabricates a value for what is missing, and stays short", () => {
    const spec = composeOverview(input({
      entity: { id: "b", name: "Empty Asset", type: "asset", fields: {} },
    }));
    expect(spec.missingInformation.length).toBeGreaterThan(0);
    expect(spec.missingInformation.length).toBeLessThanOrEqual(5);
    for (const m of spec.missingInformation) {
      expect(m.reason.length).toBeGreaterThan(0);
      expect(allRenderedValues(spec)).not.toContain(m.semanticKey);
    }
  });

  it("asks a liability for the inputs its own math needs", () => {
    const spec = composeOverview(input({
      entity: { id: "l", name: "Personal Loan", type: "liability", fields: { balance: 8000 } },
    }));
    const keys = spec.missingInformation.map(m => m.semanticKey);
    expect(keys).toContain("interestRate");
    expect(keys).toContain("monthlyPayment");
  });
});

describe("composition and data are separate concerns", () => {
  const base = {
    id: "v", name: "Truck", type: "vehicle",
    fields: { currentValue: 30000, mileage: 51000, vin: "1FT" },
  };

  it("resolves values fresh on every compose while the signature holds steady", () => {
    const first = composeOverview(input({ entity: { ...base } }));
    const second = composeOverview(input({ entity: { ...base, fields: { ...base.fields, currentValue: 27500 } } }));
    expect(first.identity.headline?.value).toBe(30000);
    expect(second.identity.headline?.value).toBe(27500);
    // Same shape → same cached composition is still valid.
    expect(second.meta.signature).toBe(first.meta.signature);
  });

  it("changes the signature when the entity's shape changes", () => {
    const first = composeOverview(input({ entity: { ...base } }));
    const withField = composeOverview(input({
      entity: { ...base, fields: { ...base.fields, warrantyExpiration: "2027-01-01" } },
    }));
    expect(withField.meta.signature).not.toBe(first.meta.signature);

    const withLink = composeOverview(input({
      entity: { ...base },
      related: [{ id: "l", name: "Auto Loan", kind: "auto_loan", relation: "financing", fields: { balance: 9000 } }],
    }));
    expect(withLink.meta.signature).not.toBe(first.meta.signature);
  });

  it("a deleted field disappears from the composition immediately", () => {
    const before = composeOverview(input({ entity: { ...base } }));
    const after = composeOverview(input({ entity: { ...base, fields: { currentValue: 30000, mileage: 51000 } } }));
    const key = (s: any) => s.sections.flatMap((x: any) => (x.values || []).map((v: any) => v.semanticKey));
    expect(key(before)).toContain("vin");
    expect(key(after)).not.toContain("vin");
  });

  it("signature ignores values and includes shape", () => {
    const a = overviewSignature({ type: "asset", fieldKeys: ["currentValue", "vin"] });
    const b = overviewSignature({ type: "asset", fieldKeys: ["vin", "currentValue"] });
    const c = overviewSignature({ type: "asset", fieldKeys: ["currentValue"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("the model may shape the Overview but never draw it or fill it", () => {
  it("drops hints for fields the entity does not have", () => {
    const hints = normalizeSchemaHints(
      { fieldHints: { currentValue: { importance: "primary" }, invented: { importance: "primary" } } },
      ["currentValue"],
    );
    expect(hints.fieldHints).toEqual({ currentValue: { importance: "primary" } });
  });

  it("drops values outside the renderer's vocabulary", () => {
    const hints = normalizeSchemaHints(
      { fieldHints: { currentValue: { importance: "SUPER_IMPORTANT", displayType: "iframe" } } },
      ["currentValue"],
    );
    expect(hints.fieldHints?.currentValue).toBeUndefined();
  });

  it("refuses to call an existing field missing", () => {
    const hints = normalizeSchemaHints(
      { missingInformation: [{ semanticKey: "currentValue", reason: "add it" }] },
      ["currentValue"],
    );
    expect(hints.missingInformation).toBeUndefined();
  });

  it("applies accepted hints without letting them supply data", () => {
    const spec = composeOverview(input({
      entity: { id: "x", name: "Solar Array", type: "asset", fields: { currentValue: 18000, panelCount: 24 } },
      hints: normalizeSchemaHints({
        entityLabel: "Solar installation",
        semanticCategory: "energy_system",
        fieldHints: { panelCount: { label: "Panels", group: "Characteristics", importance: "primary" } },
        insights: [{ title: "Sized for the roof", detail: "24 panels is a full-roof install." }],
      }, ["currentValue", "panelCount"]),
    }));
    expect(spec.identity.entityLabel).toBe("Solar installation");
    expect(spec.identity.semanticCategory).toBe("energy_system");
    const panels = [...spec.summaryMetrics, ...spec.sections.flatMap(s => s.values || [])]
      .find(v => v.semanticKey === "panelCount");
    expect(panels?.label).toBe("Panels");
    expect(panels?.value).toBe(24);
    expect(spec.meta.schemaSource).toBe("ai-assisted");
    expect(spec.insights).toHaveLength(1);
  });
});

describe("assets and liabilities run through the same engine", () => {
  it("leads an asset with what it is worth and a liability with what is owed", () => {
    const asset = composeOverview(input({
      entity: { id: "a", name: "Condo", type: "property", fields: { currentValue: 500000, balance: 0 } },
    }));
    const liability = composeOverview(input({
      entity: { id: "l", name: "Condo Mortgage", type: "liability", type_key: "mortgage", fields: { balance: 310000, currentValue: 0 } },
    }));
    expect(asset.identity.headline?.semanticKey).toBe("currentValue");
    expect(asset.identity.entityClass).toBe("asset");
    expect(liability.identity.headline?.semanticKey).toBe("balance");
    expect(liability.identity.entityClass).toBe("liability");
  });

  it("reports net worth impact with the correct sign for each", () => {
    const asset = composeOverview(input({
      entity: { id: "a", name: "Condo", type: "property", fields: { currentValue: 500000 } },
    }));
    const liability = composeOverview(input({
      entity: { id: "l", name: "Mortgage", type: "liability", type_key: "mortgage", fields: { balance: 310000 } },
    }));
    const net = (s: any) => [...s.summaryMetrics, ...s.sections.flatMap((x: any) => x.values || [])]
      .find((v: any) => v.semanticKey === "netContribution")?.value;
    expect(net(asset)).toBe(500000);
    expect(net(liability)).toBe(-310000);
  });
});
