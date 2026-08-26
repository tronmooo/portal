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
  autoLoanStatement,
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

    it("one recurrence produces exactly one action, whatever its destination", () => {
      // The DESTINATION varies — an existing bill is updated, a moneyless duty
      // becomes a repeating task, a new recurring payment has nowhere to go —
      // but the count never does. Two actions for one commitment is how one
      // premium becomes both a bill and a charge.
      for (const r of fixture.semantic.recurrences) {
        const owning = p.actions.filter((a) => r.factIds.some((f) => a.factIds.includes(f)));
        expect(owning, `recurrence ${r.id}`).toHaveLength(1);
      }
    });

    it("a fact claimed by a recurrence is never also written as a separate record", () => {
      const claimed = new Set(fixture.semantic.recurrences.flatMap((r) => r.factIds));
      if (claimed.size === 0) return;
      const recurrenceActionIds = new Set(
        p.actions
          .filter((a) => fixture.semantic.recurrences.some((r) => r.factIds.some((f) => a.factIds.includes(f))))
          .map((a) => a.id),
      );
      for (const a of p.actions) {
        if (recurrenceActionIds.has(a.id)) continue;
        for (const fid of a.factIds) expect(claimed.has(fid)).toBe(false);
      }
    });

    it("RULE 1 — never creates a profile, asset or liability", () => {
      // The single most important invariant in the engine. The selected record
      // already exists; nothing in any document may mint another.
      for (const a of p.actions) {
        if (a.operation !== "CREATE") continue;
        expect(["profile", "obligation"], `${a.id} would create an entity`)
          .not.toContain(a.target.kind);
      }
      // And if one is ever proposed anyway, it must be unsavable.
      for (const a of p.actions) {
        if (a.operation === "CREATE" && ["profile", "obligation"].includes(a.target.kind)) {
          expect(a.savable).toBe(false);
        }
      }
    });

    it("an unsavable action is never ticked, and says why", () => {
      for (const a of p.actions) {
        if (a.savable) continue;
        expect(a.selected, `${a.id} is unsavable but ticked`).toBe(false);
        expect(a.unsupportedReason, `${a.id} gives no reason`).toBeTruthy();
      }
    });

    it("every action says what it will write before it is saved", () => {
      for (const a of p.actions) {
        expect(a.writesLabel, `${a.id} has no writesLabel`).toBeTruthy();
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
      if (e.recurrenceDestination !== undefined) {
        const r = fixture.semantic.recurrences[0];
        const owning = p.actions.find((a) => r.factIds.some((f) => a.factIds.includes(f)));
        expect(owning?.destination, "recurrence landed somewhere unexpected")
          .toBe(e.recurrenceDestination);
      }
      if (e.savableActions !== undefined) {
        expect(p.actions.filter((a) => a.savable && a.operation !== "NO_ACTION").length)
          .toBe(e.savableActions);
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

  it("premium + payment plan + due date become ONE inferred commitment", () => {
    // Three fields, one commitment — the relationship is what the engine is
    // for, and the action cites all three as its evidence.
    const owning = p.actions.filter((a) =>
      ["f-due", "f-plan", "f-premium"].some((f) => a.factIds.includes(f)));
    expect(owning).toHaveLength(1);
    const o = owning[0];
    expect(o.factIds.sort()).toEqual(["f-due", "f-plan", "f-premium"]);
    expect(o.payload.frequency).toBe("yearly");
    expect(o.payload.amount).toBe(1428);
    expect(o.payload.nextDueDate).toBe("2024-06-01");
  });

  it("but it cannot be saved, because a new bill would be a new liability", () => {
    // The reasoning is right and there is nowhere to put it. Saying so is the
    // honest answer; quietly creating a liability profile beside the house
    // would be rule 1 broken by the very feature meant to respect it.
    const o = p.actions.find((a) => a.factIds.includes("f-premium"))!;
    expect(o.savable).toBe(false);
    expect(o.destination).toBe("unsupported");
    expect(o.unsupportedCode).toBe("would_create_entity");
    expect(o.selected).toBe(false);
    expect(o.unsupportedReason).toMatch(/liability/i);
    expect(o.writesLabel).toMatch(/Nothing/i);
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
  it("a cost already bundled into a related liability is flagged, not silently added", () => {
    const p = plan({
      ...insuranceDeclarations,
      index: {
        ...insuranceDeclarations.index,
        profiles: insuranceDeclarations.index.profiles.map((x) =>
          x.id === "liab-1" ? { ...x, fields: { ...x.fields, escrowMonthly: 340 } } : x,
        ),
      },
    });
    const o = p.actions.find((a) => a.factIds.includes("f-premium"))!;
    const w = o.warnings.find((x) => x.code === "double_count");
    expect(w).toBeTruthy();
    expect(w!.blocking).toBe(true);
    expect(o.selected).toBe(false);
  });

  it("a bill that already tracks this is UPDATED — rule 2, prefer updating", () => {
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
    expect(o.savable).toBe(true);
    expect(o.warnings.some((w) => w.code === "duplicate_record")).toBe(true);
  });

  it("a statement filed under a loan updates THAT loan's terms — never a second one", () => {
    const p = plan(loanStatement);
    const a = p.actions.find((x) => x.factIds.includes("f-payment"))!;
    expect(a.destination).toBe("entity_field");
    expect(a.operation).toBe("UPDATE");
    expect(a.target.id).toBe("liab-2");
    expect(a.savable).toBe(true);
    expect(a.payload.fields.monthlyPayment).toBe(412.9);
    expect(a.payload.fields.nextDueDate).toBe("2026-09-15");
    // And no second liability, and no stray expense for the same money.
    expect(p.actions.some((x) => x.operation === "CREATE" && x.target.kind === "profile")).toBe(false);
    expect(p.actions.filter((x) => x.destination === "expense")).toHaveLength(0);
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
    const o = p.actions.find((a) => a.factIds.includes("f-dues"))!;
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
    expect(destinations.has("calendar")).toBe(true);
    expect(destinations.has("reference")).toBe(true);
    // The whole document is not one profile blob.
    expect(destinations.size).toBeGreaterThan(2);
  });

  it("still works out the quarterly commitment, even with nowhere to file it", () => {
    // "Not savable" is a statement about this app's records, not about the
    // reasoning. The cadence, the amount and the end date were all understood.
    const o = p.actions.find((a) => a.factIds.includes("f-dues"))!;
    expect(o.payload.frequency).toBe("quarterly");
    expect(o.payload.amount).toBe(310);
    expect(o.payload.recurrenceEnd).toBe("2027-04-01");
    expect(o.savable).toBe(false);
    expect(o.unsupportedReason).toBeTruthy();
  });
});

describe("the worked example — seven consequences, nothing created", () => {
  const p = plan(autoLoanStatement);
  const byFact = (id: string) => p.actions.find((a) => a.factIds.includes(id))!;

  it("updates the balance AND appends it to the tracker — one fact, two jobs", () => {
    const a = byFact("f-balance");
    expect(a.destination).toBe("profile_tracker");
    expect(a.payload.fields.currentBalance).toBe(24820);
    expect(a.payload.trackerId).toBe("trk-bal");
    expect(a.savable).toBe(true);
    expect(a.writesLabel).toMatch(/field.*and adds an entry/i);
  });

  it("finds the loan's existing balance tracker despite the different name", () => {
    // RULE 2. The statement says "Current Balance", the tracker is called
    // "Loan Balance" — the same metric under two names. Matching on the name
    // alone would give this loan a second balance chart.
    const a = byFact("f-balance");
    expect(a.operation).toBe("APPEND");
    expect(a.target.id).toBe("trk-bal");
  });

  it("records the $612 payment against the loan, not as an expense", () => {
    const a = byFact("f-paid");
    expect(a.destination).toBe("liability_payment");
    expect(a.operation).toBe("RECORD");
    expect(a.target.id).toBe("liab-ram");
    expect(a.payload.amount).toBe(612);
    expect(a.payload.date).toBe("2026-08-08");
    expect(p.actions.filter((x) => x.destination === "expense")).toHaveLength(0);
  });

  it("puts the payment terms and the next due date on the loan we already have", () => {
    const a = byFact("f-monthly");
    expect(a.destination).toBe("entity_field");
    expect(a.target.id).toBe("liab-ram");
    expect(a.payload.fields.monthlyPayment).toBe(612);
    expect(a.payload.fields.nextDueDate).toBe("2026-09-08");
    expect(a.payload.fields.maturityDate).toBe("2030-06-08");
  });

  it("sets ONE lead time rather than a pile of reminder rows", () => {
    // The app escalates every date through a single attention ladder, so this
    // is the one genuinely per-record knob: how far out it starts mattering.
    const a = byFact("f-monthly");
    expect(a.payload.leadTimeDays).toBe(5);
    expect(p.actions.filter((x) => x.destination === "task")).toHaveLength(0);
  });

  it("keeps the statement date as reference and creates no event for it", () => {
    const a = byFact("f-stmt");
    expect(a.destination).toBe("reference");
    expect(a.operation).toBe("NO_ACTION");
  });

  it("creates NOTHING — not a loan, not a bill, not a second anything", () => {
    // The richest document in the corpus, and it mints no entity at all.
    for (const a of p.actions) {
      if (a.operation !== "CREATE") continue;
      expect(["profile", "obligation"]).not.toContain(a.target.kind);
    }
    expect(p.actions.every((a) => a.savable)).toBe(true);
  });
});

describe("money is routed by what KIND it is", () => {
  const withKind = (kind: string, extraRoles: string[] = []) => plan({
    ...autoLoanStatement,
    semantic: {
      ...autoLoanStatement.semantic,
      recurrences: [],
      facts: [{
        id: "f-x", itemIds: ["field-paymentreceived"], label: "Amount", value: 500,
        roles: ["financial", ...extraRoles] as any,
        subject: { entityRef: "e-loan", confidence: 0.9 },
        volatility: "historical", financialKind: kind as any, confidence: 0.9,
      }],
    },
  });

  it("a payment against a debt is a payment, never an expense", () => {
    const a = withKind("payment").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("liability_payment");
  });

  it("a charge is an expense", () => {
    const a = withKind("charge").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("expense");
  });

  it("a fee is an expense, and says it is a fee", () => {
    const a = withKind("fee").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("expense");
    expect(a.title).toMatch(/fee/i);
  });

  it("a refund is NOT income, and has nowhere to go", () => {
    // The failure this prevents: a refund filed as income, inflating earnings
    // by exactly the amount that came back.
    const a = withKind("refund").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("unsupported");
    expect(a.savable).toBe(false);
    expect(a.unsupportedCode).toBe("no_record_type");
    expect(a.unsupportedReason).toMatch(/not income/i);
  });

  it("a credit and a transfer are neither income nor expense", () => {
    for (const kind of ["credit", "transfer"]) {
      const a = withKind(kind).actions.find((x) => x.factIds.includes("f-x"))!;
      expect(a.destination, kind).toBe("unsupported");
      expect(a.savable, kind).toBe(false);
    }
  });

  it("an estimate never enters the ledger", () => {
    const a = withKind("estimate").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("unsupported");
    expect(a.unsupportedCode).toBe("not_a_ledger_event");
  });

  it("income is income", () => {
    const a = withKind("income").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("income");
  });

  it("a rate is a field on the record, not a transaction", () => {
    const a = withKind("rate").actions.find((x) => x.factIds.includes("f-x"))!;
    expect(a.destination).toBe("entity_field");
  });
});

describe("a status the document proves", () => {
  it("marks the record, and only a record that exists", () => {
    const p = plan({
      ...autoLoanStatement,
      semantic: {
        ...autoLoanStatement.semantic,
        recurrences: [],
        facts: [{
          id: "f-status", itemIds: ["field-statementdate"], label: "Account Status",
          value: "PAID", roles: ["status_change"] as any,
          subject: { entityRef: "e-loan", confidence: 0.92 },
          volatility: "changeable", status: "paid" as any, confidence: 0.92,
        }],
      },
    });
    const a = p.actions.find((x) => x.factIds.includes("f-status"))!;
    expect(a.destination).toBe("entity_field");
    expect(a.payload.fields.status).toBe("paid");
    expect(a.target.id).toBe("liab-ram");
  });
});

describe("proof that something happened", () => {
  it("is kept and explained rather than filed as a diary entry", () => {
    // JournalEntry requires a MoodLevel — it is a mood journal, not a history
    // log. Filing a service record there would be the wrong record type, which
    // is worse than saying there isn't one.
    const p = plan({
      ...autoLoanStatement,
      semantic: {
        ...autoLoanStatement.semantic,
        recurrences: [],
        facts: [{
          id: "f-event", itemIds: ["field-statementdate"], label: "Inspection Completed",
          value: "Passed", roles: ["event_occurred"] as any,
          subject: { entityRef: "e-loan", confidence: 0.9 },
          volatility: "historical", date: "2026-08-01", confidence: 0.9,
        }],
      },
    });
    const a = p.actions.find((x) => x.factIds.includes("f-event"))!;
    expect(a.destination).toBe("unsupported");
    expect(a.unsupportedCode).toBe("no_record_type");
    expect(a.detail).toMatch(/already happened/);
  });
});

describe("summarizeActions", () => {
  it("says what will happen, in counts", () => {
    const s = summarizeActions(plan(insuranceDeclarations).actions);
    expect(s).toMatch(/Entity field update/);
    expect(s).toMatch(/kept as reference only/);
  });

  it("counts what cannot be saved separately from what will happen", () => {
    const s = summarizeActions(plan(insuranceDeclarations).actions);
    expect(s).toMatch(/understood but not savable/);
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
