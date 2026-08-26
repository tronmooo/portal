// tests/semantic-envelope.test.ts — the border between a model and the database.
//
// `validateSemanticDocument` is the only thing standing between a reasoner's
// answer and real writes to a user's records. Its contract is DROP, NEVER
// REPAIR: a fact citing an entity that was never declared is not a near-miss to
// patch up, it is evidence the reasoner was writing fiction about that fact, and
// repairing it would put a fabricated subject on a real write.
//
// Every test here is a specific way a plausible-looking envelope could put a
// wrong record in someone's data.

import { describe, it, expect } from "vitest";
import {
  validateSemanticDocument,
  confidenceTier,
  recurrenceAmounts,
  emptySemanticDocument,
  isEmptySemanticDocument,
  entityByRef,
  factsWithRole,
  subjectRefs,
  OCCURRENCES_PER_YEAR,
} from "../shared/semantic-document";
import { MAX_TRANSACTION_AMOUNT } from "../shared/schema";

const entity = (ref: string, over: Record<string, any> = {}) => ({
  ref, kind: "person", name: `Name ${ref}`, identifiers: {}, confidence: 0.9, ...over,
});
const fact = (id: string, over: Record<string, any> = {}) => ({
  id, itemIds: [`field-${id}`], label: `Label ${id}`, value: "v",
  roles: ["profile_data"], subject: { entityRef: "e1", confidence: 0.9 },
  volatility: "stable", confidence: 0.9, ...over,
});
const envelope = (over: Record<string, any> = {}) => ({
  documentType: "Test Document",
  primarySubject: "e1",
  entities: [entity("e1")],
  relationships: [],
  facts: [fact("f1")],
  recurrences: [],
  narrative: [],
  confidence: 0.9,
  summary: "A document.",
  ...over,
});

describe("shape", () => {
  it("refuses anything that is not an object", () => {
    for (const junk of [null, undefined, "text", 42, []]) {
      const { doc, report } = validateSemanticDocument(junk);
      expect(report.ok).toBe(false);
      expect(isEmptySemanticDocument(doc)).toBe(true);
    }
  });

  it("accepts a well-formed envelope whole", () => {
    const { doc, report } = validateSemanticDocument(envelope());
    expect(report.ok).toBe(true);
    expect(doc.facts).toHaveLength(1);
    expect(doc.entities).toHaveLength(1);
    expect(doc.primarySubject).toBe("e1");
  });

  it("clamps confidence into 0..1 instead of trusting it", () => {
    const { doc } = validateSemanticDocument(envelope({
      confidence: 7,
      facts: [fact("f1", { confidence: -3 })],
    }));
    expect(doc.confidence).toBe(1);
    expect(doc.facts[0].confidence).toBe(0);
  });
});

describe("entities", () => {
  it("drops an entity of a kind we do not model", () => {
    const { doc, report } = validateSemanticDocument(envelope({
      entities: [entity("e1"), entity("e2", { kind: "spaceship" })],
    }));
    expect(doc.entities.map((e) => e.ref)).toEqual(["e1"]);
    expect(report.droppedEntities).toContain("e2");
    expect(report.ok).toBe(false);
  });

  it("drops a duplicate ref rather than letting the second shadow the first", () => {
    const { doc, report } = validateSemanticDocument(envelope({
      entities: [entity("e1", { name: "Real" }), entity("e1", { name: "Impostor" })],
    }));
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].name).toBe("Real");
    expect(report.droppedEntities).toContain("e1");
  });

  it("keeps only identifiers that are real key/value pairs", () => {
    const { doc } = validateSemanticDocument(envelope({
      entities: [entity("e1", { identifiers: { vin: "1HG", blank: "", "": "x", n: null } })],
    }));
    expect(doc.entities[0].identifiers).toEqual({ vin: "1HG" });
  });
});

describe("facts", () => {
  it("drops a fact whose subject was never declared", () => {
    // The failure this prevents: a fabricated subject reaching a real write.
    const { doc, report } = validateSemanticDocument(envelope({
      facts: [fact("f1"), fact("f2", { subject: { entityRef: "ghost", confidence: 0.9 } })],
    }));
    expect(doc.facts.map((f) => f.id)).toEqual(["f1"]);
    expect(report.droppedFacts).toContain("f2");
  });

  it("drops a fact that cites no extraction row that exists", () => {
    const known = new Set(["field-f1"]);
    const { doc, report } = validateSemanticDocument(
      envelope({ facts: [fact("f1"), fact("f2", { itemIds: ["field-invented"] })] }),
      { knownItemIds: known },
    );
    expect(doc.facts.map((f) => f.id)).toEqual(["f1"]);
    expect(report.droppedFacts).toContain("f2");
  });

  it("keeps only the cited rows that exist, when a fact cites several", () => {
    const { doc } = validateSemanticDocument(
      envelope({ facts: [fact("f1", { itemIds: ["field-f1", "field-nope"] })] }),
      { knownItemIds: new Set(["field-f1"]) },
    );
    expect(doc.facts[0].itemIds).toEqual(["field-f1"]);
  });

  it("drops a fact with no recognised role — an unclassified fact routes nowhere", () => {
    const { doc, report } = validateSemanticDocument(envelope({
      facts: [fact("f1"), fact("f2", { roles: ["vibes"] })],
    }));
    expect(doc.facts.map((f) => f.id)).toEqual(["f1"]);
    expect(report.droppedFacts).toContain("f2");
  });

  it("drops a fact with an unknown volatility — we would not know what a new value means", () => {
    const { doc } = validateSemanticDocument(envelope({
      facts: [fact("f1", { volatility: "sometimes" })],
    }));
    expect(doc.facts).toHaveLength(0);
  });

  it("refuses a financial value that is not a bounded number", () => {
    for (const bad of [Infinity, NaN, MAX_TRANSACTION_AMOUNT * 10]) {
      const { doc } = validateSemanticDocument(envelope({
        facts: [fact("f1", { roles: ["financial"], value: bad })],
      }));
      expect(doc.facts).toHaveLength(0);
    }
  });

  it("coerces a numeric-looking financial value to a number", () => {
    const { doc } = validateSemanticDocument(envelope({
      facts: [fact("f1", { roles: ["financial"], value: 1428.0 })],
    }));
    expect(doc.facts[0].value).toBe(1428);
  });

  it("drops a derivation that rests on a fact which did not survive", () => {
    const { doc, report } = validateSemanticDocument(envelope({
      facts: [
        fact("f1"),
        fact("f-bad", { roles: ["nonsense"] }),
        fact("f-derived", { derivedFrom: { factIds: ["f-bad"], formula: "f-bad × 12" } }),
      ],
    }));
    expect(doc.facts.map((f) => f.id)).toEqual(["f1"]);
    expect(report.droppedFacts).toContain("f-derived");
  });

  it("keeps a derivation whose sources all survived, with its formula", () => {
    const { doc } = validateSemanticDocument(envelope({
      facts: [fact("f1"), fact("f2", { derivedFrom: { factIds: ["f1"], formula: "f1 × 12" } })],
    }));
    expect(doc.facts[1].derivedFrom).toEqual({ factIds: ["f1"], formula: "f1 × 12" });
  });
});

describe("relationships", () => {
  it("drops an edge pointing at an entity that does not exist", () => {
    const { doc, report } = validateSemanticDocument(envelope({
      entities: [entity("e1"), entity("e2", { kind: "property" })],
      relationships: [
        { from: "e1", to: "e2", type: "owns", confidence: 0.9 },
        { from: "e1", to: "ghost", type: "owns", confidence: 0.9 },
      ],
    }));
    expect(doc.relationships).toHaveLength(1);
    expect(report.droppedRelationships).toContain("e1→ghost");
  });

  it("drops an unknown relationship type", () => {
    const { doc } = validateSemanticDocument(envelope({
      entities: [entity("e1"), entity("e2", { kind: "property" })],
      relationships: [{ from: "e1", to: "e2", type: "haunts", confidence: 0.9 }],
    }));
    expect(doc.relationships).toHaveLength(0);
  });

  it("drops a self-edge", () => {
    const { doc } = validateSemanticDocument(envelope({
      relationships: [{ from: "e1", to: "e1", type: "owns", confidence: 0.9 }],
    }));
    expect(doc.relationships).toHaveLength(0);
  });
});

describe("recurrences — where fabrication would actually cost money", () => {
  const base = {
    id: "r1", factIds: ["f1"], label: "Premium", cadence: "monthly",
    stated: "per_occurrence", amountPerOccurrence: 80, confidence: 0.9,
  };

  it("keeps a well-formed pattern", () => {
    const { doc } = validateSemanticDocument(envelope({ recurrences: [base] }));
    expect(doc.recurrences).toHaveLength(1);
    expect(doc.recurrences[0].amountPerOccurrence).toBe(80);
  });

  it("REFUSES an instalment invented from an annual-only figure", () => {
    // Rule 16. A bill that says "$960/year" with no frequency does not
    // authorise "$80/month" — that is a payment schedule the user never agreed
    // to, presented as if the document had printed it.
    const { doc, report } = validateSemanticDocument(envelope({
      recurrences: [{ ...base, stated: "annual", annualizedTotal: 960, amountPerOccurrence: 80 }],
    }));
    expect(doc.recurrences[0].amountPerOccurrence).toBeUndefined();
    expect(doc.recurrences[0].annualizedTotal).toBe(960);
    expect(report.reasons.join(" ")).toMatch(/invented/);
  });

  it("refuses an annual total that does not match its own arithmetic", () => {
    const { doc } = validateSemanticDocument(envelope({
      recurrences: [{ ...base, annualizedTotal: 5000 }],   // 80 × 12 is not 5000
    }));
    expect(doc.recurrences[0].annualizedTotal).toBeUndefined();
    expect(doc.recurrences[0].amountPerOccurrence).toBe(80);
  });

  it("accepts an annual total that does match, within rounding", () => {
    const { doc } = validateSemanticDocument(envelope({
      recurrences: [{ ...base, annualizedTotal: 960 }],
    }));
    expect(doc.recurrences[0].annualizedTotal).toBe(960);
  });

  it("drops an unknown cadence rather than guessing one", () => {
    const { doc } = validateSemanticDocument(envelope({
      recurrences: [{ ...base, cadence: "fortnightly-ish" }],
    }));
    expect(doc.recurrences).toHaveLength(0);
  });

  it("drops a pattern resting on no surviving fact", () => {
    const { doc, report } = validateSemanticDocument(envelope({
      recurrences: [{ ...base, factIds: ["f-ghost"] }],
    }));
    expect(doc.recurrences).toHaveLength(0);
    expect(report.droppedRecurrences).toContain("r1");
  });

  it("drops a pattern with no usable amount at all", () => {
    const { doc } = validateSemanticDocument(envelope({
      recurrences: [{ ...base, amountPerOccurrence: undefined, annualizedTotal: undefined }],
    }));
    expect(doc.recurrences).toHaveLength(0);
  });
});

describe("recurrenceAmounts", () => {
  it("derives the annual total from an instalment and says it derived it", () => {
    const a = recurrenceAmounts({
      id: "r", factIds: [], label: "", cadence: "quarterly",
      amountPerOccurrence: 310, stated: "per_occurrence", confidence: 1,
    });
    expect(a.annual).toBe(1240);
    expect(a.annualDerived).toBe(true);
    expect(a.perOccurrenceDerived).toBe(false);
  });

  it("never derives an instalment when the page stated only an annual figure", () => {
    const a = recurrenceAmounts({
      id: "r", factIds: [], label: "", cadence: "monthly",
      annualizedTotal: 960, stated: "annual", confidence: 1,
    });
    expect(a.perOccurrence).toBeNull();
  });

  it("leaves an unknowable cadence alone rather than inventing a divisor", () => {
    expect(OCCURRENCES_PER_YEAR.per_installment).toBeNull();
    const a = recurrenceAmounts({
      id: "r", factIds: [], label: "", cadence: "per_installment",
      amountPerOccurrence: 50, stated: "per_occurrence", confidence: 1,
    });
    expect(a.annual).toBeNull();
  });
});

describe("confidence tiers", () => {
  it("splits automation three ways", () => {
    expect(confidenceTier(0.95)).toBe("high");
    expect(confidenceTier(0.7)).toBe("medium");
    expect(confidenceTier(0.2)).toBe("low");
  });

  it("treats a missing or broken confidence as low, never as certain", () => {
    expect(confidenceTier(undefined)).toBe("low");
    expect(confidenceTier(NaN)).toBe("low");
  });
});

describe("reading helpers", () => {
  const { doc } = validateSemanticDocument(envelope({
    entities: [entity("e1"), entity("e2", { kind: "property" })],
    facts: [fact("f1"), fact("f2", { subject: { entityRef: "e2", confidence: 0.9 }, roles: ["entity_data"] })],
  }));

  it("finds an entity by ref and reports a miss as null", () => {
    expect(entityByRef(doc, "e2")?.kind).toBe("property");
    expect(entityByRef(doc, "nope")).toBeNull();
  });

  it("selects facts by role", () => {
    expect(factsWithRole(doc, "entity_data").map((f) => f.id)).toEqual(["f2"]);
  });

  it("lists the subjects a document writes about, primary first", () => {
    expect(subjectRefs(doc)).toEqual(["e1", "e2"]);
  });

  it("recognises an envelope with nothing in it", () => {
    expect(isEmptySemanticDocument(emptySemanticDocument())).toBe(true);
    expect(isEmptySemanticDocument(doc)).toBe(false);
  });
});
