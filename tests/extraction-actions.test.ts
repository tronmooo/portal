// tests/extraction-actions.test.ts — the invariants of the document engine.
//
// The engine's whole claim is that it is UNIVERSAL: insurance, medical reports,
// receipts, leases, deeds, prescriptions and a boat club certificate nobody
// wrote a rule for are fixtures, not code paths. This file makes that claim
// falsifiable by asserting one invariant suite against EVERY fixture, then
// pinning the specific behaviours that motivated the change.
//
// If a future change makes the engine work by recognising document types, one
// of the per-fixture assertions below will fail on the fixture nobody wrote a
// rule for. That is the point.

import { describe, it, expect } from "vitest";
import {
  planExtractionActions,
  summarizeActions,
  selectedActions,
  resolveEntity,
  type ActionPlan,
} from "../shared/extraction-actions";
import { validateSemanticDocument, recurrenceAmounts } from "../shared/semantic-document";
import {
  ALL_FIXTURES,
  insuranceDeclarations,
  medicalReport,
  loanStatement,
  parkingTicket,
  unrecognizedDocument,
  type DocumentFixture,
} from "./document-fixtures";

const TODAY = "2026-08-25";

function plan(f: DocumentFixture, overrides: Partial<Parameters<typeof planExtractionActions>[0]> = {}): ActionPlan {
  return planExtractionActions({
    semantic: f.semantic,
    items: f.items,
    index: f.index,
    primaryProfileId: f.primaryProfileId,
    documentId: "doc-1",
    documentName: f.name,
    today: TODAY,
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The universal invariants — asserted against every document type
// ═══════════════════════════════════════════════════════════════════════════

describe.each(ALL_FIXTURES.map((f) => [f.name, f] as const))(
  "universal invariants — %s",
  (_name, fixture) => {
    const p = plan(fixture);

    it("every fact has a subject that resolves to a declared entity", () => {
      // Rule 2: nothing is allowed to default to "whichever profile the user
      // happened to select". A fact with a dangling subject never reaches the
      // planner because validation drops it — so re-validating the fixture must
      // keep every fact it declares.
      const { doc, report } = validateSemanticDocument(fixture.semantic, {
        knownItemIds: new Set(fixture.items.map((i) => i.id)),
      });
      expect(report.droppedFacts).toEqual([]);
      expect(doc.facts.length).toBe(fixture.semantic.facts.length);
      for (const f of doc.facts) {
        expect(doc.entities.some((e) => e.ref === f.subject.entityRef)).toBe(true);
      }
    });

    it("no two actions would write the same thing twice", () => {
      // Rule 12. A dedupeKey collision means one real-world fact is about to
      // become two records — the failure that turns a single premium into a
      // bill AND a charge.
      const keys = p.actions.map((a) => a.dedupeKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("one recurrence produces exactly one financial record", () => {
      const financial = p.actions.filter(
        (a) => a.destination === "obligation" || a.destination === "expense" || a.destination === "income",
      );
      expect(financial.length).toBeLessThanOrEqual(fixture.semantic.recurrences.length + financial.filter((a) => a.destination !== "obligation").length);
      const obligations = p.actions.filter((a) => a.destination === "obligation");
      expect(obligations.length).toBe(fixture.semantic.recurrences.length);
    });

    it("a fact claimed by a recurrence is never also written as a separate record", () => {
      const claimed = new Set(fixture.semantic.recurrences.flatMap((r) => r.factIds));
      if (claimed.size === 0) return;
      for (const a of p.actions) {
        if (a.destination === "obligation") continue;
        for (const fid of a.factIds) expect(claimed.has(fid)).toBe(false);
      }
    });

    it("every fact reaches exactly one action — nothing is lost, nothing doubles", () => {
      // Rule 3 restated as arithmetic: the document is evidence, and every piece
      // of that evidence has to end up somewhere the user can see, exactly once.
      const seen = new Map<string, number>();
      for (const a of p.actions) {
        for (const fid of a.factIds) seen.set(fid, (seen.get(fid) ?? 0) + 1);
      }
      for (const f of fixture.semantic.facts) {
        expect(seen.get(f.id), `fact ${f.id} (${f.label})`).toBe(1);
      }
    });

    it("never invents a destination it is not confident about", () => {
      // Rule 15: low confidence keeps the value and ASKS. It must not be ticked
      // and quietly written somewhere.
      for (const a of p.actions) {
        if (a.confidence < 0.55 && a.operation !== "NO_ACTION") {
          expect(a.selected).toBe(false);
        }
      }
    });

    it("a blocking warning always leaves the action unticked", () => {
      for (const a of p.actions) {
        if (a.warnings.some((w) => w.blocking)) expect(a.selected).toBe(false);
      }
    });

    it("every write records the document it came from", () => {
      // Rule 3: the document is the source, not the destination, and every
      // record it produces must be able to say where it came from.
      for (const a of selectedActions(p)) {
        const src = a.payload?._source ?? a.payload?.documentId ?? a.payload?.source;
        expect(src, `action ${a.id} has no provenance`).toBeTruthy();
      }
    });

    it("is deterministic — the same document plans identically twice", () => {
      const again = plan(fixture);
      expect(again.actions.map((a) => a.id)).toEqual(p.actions.map((a) => a.id));
      expect(again.actions.map((a) => a.dedupeKey)).toEqual(p.actions.map((a) => a.dedupeKey));
    });

    it("produces an understanding, not just rows", () => {
      expect(p.understanding.documentType).toBeTruthy();
      expect(p.actions.length).toBeGreaterThan(0);
    });

    it("meets its own stated expectations", () => {
      const e = fixture.expectations;
      if (!e) return;
      if (e.obligations !== undefined) {
        expect(p.actions.filter((a) => a.destination === "obligation").length).toBe(e.obligations);
      }
      for (const itemId of e.referenceOnlyItemIds ?? []) {
        const owning = p.actions.filter((a) => a.itemIds.includes(itemId));
        expect(owning.length, `${itemId} should reach exactly one action`).toBe(1);
        expect(owning[0].destination, `${itemId} must be reference-only`).toBe("reference");
        expect(owning[0].operation).toBe("NO_ACTION");
      }
      for (const d of e.destinations ?? []) {
        expect(p.actions.some((a) => a.destination === d), `expected a ${d} action`).toBe(true);
      }
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// The specific failures that motivated the change
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-field reasoning — meaning comes from fields together", () => {
  const p = plan(insuranceDeclarations);

  it("premium + payment plan + due date become ONE recurring obligation", () => {
    const obligations = p.actions.filter((a) => a.destination === "obligation");
    expect(obligations).toHaveLength(1);
    const o = obligations[0];
    // The relationship is visible: the action cites all three facts as evidence.
    expect(o.factIds.sort()).toEqual(["f-due", "f-plan", "f-premium"]);
    expect(o.payload.frequency).toBe("yearly");
    expect(o.payload.amount).toBe(1428);
    expect(o.payload.nextDueDate).toBe("2024-06-01");
  });

  it("the property's attributes become ONE update, not four rows", () => {
    const updates = p.actions.filter((a) => a.destination === "entity_field");
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].payload.fields).length).toBeGreaterThanOrEqual(3);
    expect(updates[0].target.id).toBe("prop-1");
  });

  it("the carrier's policy details land on the PROPERTY, namespaced — not as a phantom profile", () => {
    // A carrier is a real entity in the document and not a record this app
    // keeps. Its facts follow the `insured_by` relationship onto the house.
    const rec = p.actions.find((a) => a.destination === "entity_record");
    expect(rec).toBeTruthy();
    expect(rec!.target.id).toBe("prop-1");
    expect(rec!.target.group).toBe("insurance");
    expect(rec!.payload.fields).toHaveProperty("policyNumber");
  });

  it("the mortgagee is LINKED to the existing loan, never re-created", () => {
    // The lender is named on the page only as "Pinnacle Home Loans, LLC" —
    // resolution finds the stored mortgage by its LOAN NUMBER, which is the
    // rung of the ladder that is not a guess.
    const link = p.actions.find(
      (a) => a.destination === "relationship_link" &&
        [a.payload.fromId, a.payload.toId].includes("liab-1"),
    );
    expect(link, "no link to the existing mortgage").toBeTruthy();
    expect(link!.operation).toBe("LINK");
    expect(link!.payload.type).toBe("financed_by");
    // And no action anywhere proposes creating a second mortgage record.
    expect(p.actions.some((a) => a.operation === "CREATE" && a.target.profileType === "liability")).toBe(false);
  });

  it("the signature date causes nothing at all", () => {
    const sig = p.actions.find((a) => a.factIds.includes("f-sig"));
    expect(sig!.destination).toBe("reference");
    expect(sig!.operation).toBe("NO_ACTION");
    expect(sig!.payload.calendarOptOut).toBe(true);
    // And no calendar action anywhere cites it.
    for (const a of p.actions.filter((x) => x.destination === "calendar")) {
      expect(a.factIds).not.toContain("f-sig");
    }
  });

  it("the expiration date rides the record instead of spawning a second copy", () => {
    const date = p.actions.find((a) => a.destination === "calendar" && a.factIds.includes("f-expiry"));
    expect(date).toBeTruthy();
    expect(date!.payload.derived).toBe(true);
    expect(date!.payload.profileId).toBe("prop-1");
  });
});

describe("field keys come off the row, not off the row's id", () => {
  it("writes yearBuilt, not yearbuilt", () => {
    // An item id is `field-${slug(key)}` and slugging LOWERCASES. Reading the
    // field key back out of the id produced `yearbuilt` and wrote a second,
    // differently-spelled copy of a field the profile already had. The row
    // carries the real key; the planner reads it from there.
    const p = plan(insuranceDeclarations);
    const fields = p.actions.find((a) => a.destination === "entity_field")!.payload.fields;
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(["yearBuilt", "squareFeet", "roofType"]),
    );
    expect(fields).not.toHaveProperty("yearbuilt");
  });

  it("keeps the printed spelling for a reference row too", () => {
    const p = plan(insuranceDeclarations);
    const sig = p.actions.find((a) => a.factIds.includes("f-sig"))!;
    expect(sig.payload.key).toBe("signatureDate");
  });

  it("camel-cases a label only when no row backs the fact", () => {
    const p = planExtractionActions({
      semantic: {
        ...medicalReport.semantic,
        facts: [{
          id: "f-orphan", itemIds: [], label: "Total Annual Cost", value: 960,
          roles: ["financial"], subject: { entityRef: "e-person", confidence: 0.9 },
          volatility: "changeable", confidence: 0.9,
        }],
      },
      items: [],
      index: medicalReport.index,
      primaryProfileId: medicalReport.primaryProfileId,
      documentId: "doc-1",
      today: TODAY,
    });
    const fields = p.actions.find((a) => a.payload?.fields)?.payload.fields;
    expect(Object.keys(fields ?? {})).toEqual(["totalAnnualCost"]);
  });
});

describe("resolution precedes creation", () => {
  it("an identifier match beats a name guess", () => {
    const { target } = resolveEntity(
      { ref: "e", kind: "liability", name: "Totally Different Name", identifiers: { loanNumber: "PHL-4471903" }, confidence: 0.9 },
      insuranceDeclarations.index,
    );
    expect(target.id).toBe("liab-1");
    expect(target.matchReason).toMatch(/exact/);
  });

  it("an unmatched entity is asked about, never invented", () => {
    const { target, matched } = resolveEntity(
      { ref: "e", kind: "liability", name: "Nobody's Bank", identifiers: {}, confidence: 0.9 },
      { ...insuranceDeclarations.index, profiles: [] },
    );
    expect(matched).toBe(false);
    expect(target.id).toBeFalsy();
  });

  it("a fact about an unresolvable subject stops and asks", () => {
    const bare = { ...insuranceDeclarations, index: { ...insuranceDeclarations.index, profiles: [] }, primaryProfileId: undefined };
    const p = plan(bare);
    const asks = p.actions.filter((a) => a.warnings.some((w) => w.code === "unresolved_target"));
    expect(asks.length).toBeGreaterThan(0);
    for (const a of asks) expect(a.selected).toBe(false);
    expect(p.unresolvedItemIds.length).toBeGreaterThan(0);
  });

  it("the profile the user filed the document under wins over any name match", () => {
    const p = plan({
      ...insuranceDeclarations,
      index: {
        ...insuranceDeclarations.index,
        profiles: [
          { id: "prop-9", type: "property", name: "Some Other House", fields: {} },
          ...insuranceDeclarations.index.profiles.filter((x) => x.id !== "prop-1"),
        ],
      },
      primaryProfileId: "prop-9",
    });
    const fields = p.actions.find((a) => a.destination === "entity_field");
    expect(fields!.target.id).toBe("prop-9");
    expect(fields!.target.matchReason).toMatch(/you filed/i);
  });
});

describe("conflicts are surfaced, not silently applied", () => {
  const p = plan(medicalReport);

  it("a weight that changed is just the new weight", () => {
    const t = p.actions.find((a) => a.destination === "tracker" && a.factIds.includes("f-weight"));
    expect(t).toBeTruthy();
    expect(t!.selected).toBe(true);
    expect(t!.warnings.filter((w) => w.blocking)).toHaveLength(0);
  });

  it("a blood type that changed is a conflict a human must settle", () => {
    const fields = p.actions.find((a) => a.factIds.includes("f-blood"))!;
    const conflict = fields.warnings.find((w) => w.code === "stable_field_conflict");
    expect(conflict).toBeTruthy();
    expect(conflict!.blocking).toBe(true);
    expect(conflict!.existing).toBe("O+");
    expect(conflict!.incoming).toBe("AB-");
    expect(fields.selected).toBe(false);
  });

  it("appends to the tracker that already exists instead of minting a second", () => {
    const t = p.actions.find((a) => a.destination === "tracker" && a.factIds.includes("f-weight"))!;
    expect(t.operation).toBe("APPEND");
    expect(t.target.id).toBe("trk-1");
  });
});

describe("never double-count", () => {
  it("a cost already bundled into a related liability is suppressed, not silently added", () => {
    const p = plan({
      ...insuranceDeclarations,
      index: {
        ...insuranceDeclarations.index,
        profiles: insuranceDeclarations.index.profiles.map((x) =>
          x.id === "liab-1" ? { ...x, fields: { ...x.fields, escrowMonthly: 340 } } : x,
        ),
      },
    });
    const o = p.actions.find((a) => a.destination === "obligation")!;
    const w = o.warnings.find((x) => x.code === "double_count");
    expect(w).toBeTruthy();
    expect(w!.blocking).toBe(true);
    expect(o.selected).toBe(false);
  });

  it("an obligation that already tracks this becomes an update, not a twin", () => {
    const p = plan({
      ...insuranceDeclarations,
      index: {
        ...insuranceDeclarations.index,
        obligations: [{ id: "obl-1", name: "Homeowners premium", amount: 1428, linkedAssetId: "prop-1" }],
      },
    });
    const o = p.actions.find((a) => a.destination === "obligation")!;
    expect(o.operation).toBe("UPDATE");
    expect(o.target.id).toBe("obl-1");
    expect(o.warnings.some((w) => w.code === "duplicate_record")).toBe(true);
  });

  it("the premium reaches carrying costs by a link, never by a second expense row", () => {
    const p = plan(insuranceDeclarations);
    const o = p.actions.find((a) => a.destination === "obligation")!;
    expect(o.payload.linkedAssetId).toBe("prop-1");
    expect(o.payload.autoLogExpense).toBe(true);
    expect(p.actions.filter((a) => a.destination === "expense")).toHaveLength(0);
  });
});

describe("annual cost is not annual payment", () => {
  it("keeps both figures without ever adding them together", () => {
    const a = recurrenceAmounts({
      id: "r", factIds: ["f"], label: "x", cadence: "monthly",
      amountPerOccurrence: 200, stated: "per_occurrence", confidence: 1,
    });
    expect(a.perOccurrence).toBe(200);
    expect(a.annual).toBe(2400);
    expect(a.annualDerived).toBe(true);
  });

  it("refuses to invent instalments from an annual-only figure", () => {
    const a = recurrenceAmounts({
      id: "r", factIds: ["f"], label: "x", cadence: "monthly",
      annualizedTotal: 960, stated: "annual", confidence: 1,
    });
    expect(a.annual).toBe(960);
    expect(a.perOccurrence).toBeNull();
  });

  it("labels a calculated instalment as calculated", () => {
    const p = plan({
      ...unrecognizedDocument,
      semantic: {
        ...unrecognizedDocument.semantic,
        recurrences: [{
          ...unrecognizedDocument.semantic.recurrences[0],
          amountPerOccurrence: undefined,
          annualizedTotal: 1240,
          stated: "both",
        }],
      },
    });
    const o = p.actions.find((a) => a.destination === "obligation")!;
    expect(o.warnings.some((w) => w.code === "derived_value")).toBe(true);
    expect(o.payload.amount).toBe(310);
  });
});

describe("dates: the rule engine has the last word", () => {
  it("an issue date is reference-only even when the reasoner called it a date", () => {
    const p = plan({
      ...parkingTicket,
      semantic: {
        ...parkingTicket.semantic,
        facts: parkingTicket.semantic.facts.map((f) =>
          f.id === "f-issued" ? { ...f, roles: ["actionable_date"] as const } : f,
        ) as typeof parkingTicket.semantic.facts,
      },
    });
    const issued = p.actions.find((a) => a.factIds.includes("f-issued"))!;
    expect(issued.destination).toBe("reference");
  });

  it("a genuine due date reaches the calendar", () => {
    const p = plan(parkingTicket);
    const due = p.actions.find((a) => a.destination === "calendar" && a.factIds.includes("f-due"));
    expect(due).toBeTruthy();
    expect(due!.payload.date).toBe("2026-09-25");
  });
});

describe("the unknown document still gets reasoned about", () => {
  const p = plan(unrecognizedDocument);

  it("does not fall back to dumping every field on a profile", () => {
    const destinations = new Set(p.actions.map((a) => a.destination));
    expect(destinations.has("obligation")).toBe(true);
    expect(destinations.has("calendar")).toBe(true);
    expect(destinations.has("reference")).toBe(true);
    // The whole document is not one profile blob.
    expect(destinations.size).toBeGreaterThan(2);
  });

  it("infers a quarterly obligation nobody wrote a rule for", () => {
    const o = p.actions.find((a) => a.destination === "obligation")!;
    expect(o.payload.frequency).toBe("quarterly");
    expect(o.payload.amount).toBe(310);
    expect(o.payload.recurrenceEnd).toBe("2027-04-01");
  });
});

describe("summarizeActions", () => {
  it("says what will happen, in counts", () => {
    const s = summarizeActions(plan(insuranceDeclarations).actions);
    expect(s).toMatch(/Recurring obligation/);
    expect(s).toMatch(/kept as reference only/);
  });

  it("says so plainly when nothing is selected", () => {
    expect(summarizeActions([])).toBe("Nothing to save");
  });
});

describe("the raw rows are annotated, never discarded", () => {
  it("every extracted row survives the plan", () => {
    for (const f of ALL_FIXTURES) {
      const p = plan(f);
      expect(p.items.map((i) => i.id).sort()).toEqual(f.items.map((i) => i.id).sort());
    }
  });

  it("a row that fed an action carries a link back to it", () => {
    const p = plan(loanStatement);
    const row = p.items.find((i) => i.id === "field-monthlypayment")!;
    expect(row.actionIds?.length).toBeGreaterThan(0);
    expect(row.actionLabel).toBeTruthy();
  });
});
