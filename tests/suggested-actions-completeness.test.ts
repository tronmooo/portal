// tests/suggested-actions-completeness.test.ts — "Exactly what will this
// document change in my app?"
//
// User report 2026-09-22: a Progressive auto insurance card (policy 907344659,
// Honda CR-V 2021, expires 04/05/2027) produced an expiration rule, but the
// Suggested Actions rail never showed it. The reasoner tagged the policy's
// dates as document metadata about a policy entity that matched no record, so
// the planner turned them into two "No record found … Pick where this should
// go" cards, and the dates pass then treated the rows as handled. The rule
// that appeared came from a side channel the rail never showed.
//
// The rule these tests pin: the rail IS the plan. Every date the date engine
// would act on becomes a visible action, with its downstream effects listed.
// Unticking it removes those effects, and no date takes effect unless its
// action is shown.

import { describe, it, expect } from "vitest";
import {
  planExtractionActions,
  documentDateOptOuts,
  type EntityIndex,
  type ProposedAction,
} from "../shared/extraction-actions";
import type { ExtractionItem } from "../shared/extraction-destinations";
import type { SemanticDocument } from "../shared/semantic-document";

const item = (key: string, label: string, value: any): ExtractionItem => ({
  id: `field-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  key,
  label,
  value,
  destination: "profile",
  destinationOptions: ["profile", "note", "ignore"],
  selected: true,
  source: "field",
});

function autoCard(opts: { roles?: SemanticDocument["facts"][number]["roles"]; storedExpiry?: string } = {}) {
  const roles = opts.roles ?? ["document_metadata"];
  const items = [
    item("insurer", "Insurer", "Progressive American Insurance Co"),
    item("policyNumber", "Policy Number", "907344659"),
    item("effectiveDate", "Effective Date", "10/05/2026"),
    item("expirationDate", "Expiration Date", "04/05/2027"),
    item("namedInsured", "Named Insured", "ROBERT SENNABAUM"),
    item("vin", "VIN", "7FARW2H70ME032834"),
  ];
  const index: EntityIndex = {
    profiles: [
      { id: "person-1", type: "self", name: "robert sennabaum", fields: {} },
      {
        id: "car-1", type: "vehicle", name: "Honda CR-V 2021",
        fields: opts.storedExpiry ? { vin: "7FARW2H70ME032834", expirationDate: opts.storedExpiry } : { vin: "7FARW2H70ME032834" },
      },
    ],
    obligations: [], expenses: [], trackers: [], links: [],
  };
  const semantic: SemanticDocument = {
    documentType: "Auto Insurance ID Card",
    primarySubject: "e-car",
    confidence: 0.93,
    summary: "Florida auto insurance ID card.",
    entities: [
      { ref: "e-car", kind: "vehicle", name: "Honda CR-V 2021", identifiers: { vin: "7FARW2H70ME032834" }, confidence: 0.95 },
      { ref: "e-person", kind: "person", name: "Robert Sennabaum", identifiers: {}, role: "insured", confidence: 0.93 },
      { ref: "e-policy", kind: "account", name: "Progressive Auto Policy 907344659", identifiers: { policyNumber: "907344659" }, confidence: 0.9 },
    ],
    relationships: [],
    facts: [
      { id: "f-eff", itemIds: ["field-effectivedate"], label: "Effective Date", value: "10/05/2026", roles, subject: { entityRef: "e-policy", confidence: 0.9 }, volatility: "changeable", confidence: 0.92 },
      { id: "f-exp", itemIds: ["field-expirationdate"], label: "Expiration Date", value: "04/05/2027", roles, subject: { entityRef: "e-policy", confidence: 0.9 }, volatility: "changeable", confidence: 0.92 },
    ],
    recurrences: [],
    narrative: [],
  };
  return { items, index, semantic };
}

function plan(opts: Parameters<typeof autoCard>[0] = {}, primaryProfileId?: string) {
  const f = autoCard(opts);
  return planExtractionActions({
    semantic: f.semantic, items: f.items, index: f.index, primaryProfileId,
    documentId: "doc-1", documentName: "IMG_1199.jpeg", today: "2026-09-22",
  });
}

const expiryActions = (actions: ProposedAction[]) =>
  actions.filter((a) => a.operation !== "NO_ACTION" && a.payload?.ruleType === "expiration"
    && a.itemIds.includes("field-expirationdate"));

describe("the expiration date on an auto insurance card", () => {
  for (const roles of [["document_metadata"], ["entity_data"], ["actionable_date"]] as const) {
    it(`is a visible suggested action when the reasoner tags it ${roles[0]} about an unmatched policy`, () => {
      const p = plan({ roles: [...roles] });
      const exp = expiryActions(p.actions);
      expect(exp).toHaveLength(1);
      expect(exp[0].selected).toBe(true);
      expect(exp[0].savable).toBe(true);
      expect(exp[0].detail).toContain("2027-04-05");
      // Not a "pick where this should go" card for a date the engine can act on.
      expect(p.actions.some((a) => a.id.startsWith("act-ask-") && a.itemIds.includes("field-expirationdate"))).toBe(false);
    });
  }

  it("lists every downstream effect it will cause", () => {
    const [exp] = expiryActions(plan().actions);
    const kinds = (exp.effects ?? []).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["save_date", "date_rule", "upcoming", "notification"]));
    // On the calendar, as a derived occurrence or as the event that is its home.
    expect(kinds.some((k) => k === "calendar" || k === "event")).toBe(true);
    const text = (exp.effects ?? []).map((e) => e.label).join(" | ");
    expect(text).toMatch(/Apr 5, 2027/);
    expect(text).toMatch(/expiration rule/i);
  });

  it("the effective date is kept on the document, not asked about", () => {
    const p = plan();
    const eff = p.actions.filter((a) => a.itemIds.includes("field-effectivedate"));
    expect(eff.length).toBeGreaterThan(0);
    expect(eff.every((a) => !a.warnings.some((w) => w.code === "unresolved_target"))).toBe(true);
  });

  it("says 'no change' when the record already holds that expiration", () => {
    const f = autoCard({ roles: ["actionable_date"], storedExpiry: "2027-04-05" });
    f.semantic.facts.forEach((x) => { x.subject.entityRef = "e-car"; });
    const p = planExtractionActions({
      semantic: f.semantic, items: f.items, index: f.index, primaryProfileId: "car-1",
      documentId: "doc-1", today: "2026-09-22",
    });
    const [exp] = expiryActions(p.actions);
    expect(exp.effects?.[0].kind).toBe("no_change");
    expect(exp.effects?.[0].label).toMatch(/already/i);
  });

  it("says 'update from → to' and flags the conflict when the record holds a different expiration", () => {
    const f = autoCard({ roles: ["actionable_date"], storedExpiry: "2026-04-05" });
    f.semantic.facts.forEach((x) => { x.subject.entityRef = "e-car"; });
    const p = planExtractionActions({
      semantic: f.semantic, items: f.items, index: f.index, primaryProfileId: "car-1",
      documentId: "doc-1", today: "2026-09-22",
    });
    const [exp] = expiryActions(p.actions);
    expect(exp.effects?.[0].kind).toBe("update_date");
    expect(exp.effects?.[0].label).toMatch(/Apr 5, 2026.*Apr 5, 2027/);
    expect(exp.warnings.some((w) => w.code === "value_conflict")).toBe(true);
  });
});

describe("no silent date writes", () => {
  const extractedData = {
    policyNumber: "907344659",
    effectiveDate: "2026-10-05",
    expirationDate: "2027-04-05",
  };

  it("a selected expiration action keeps the document's rule; nothing else is opted out that the plan shows", () => {
    const p = plan();
    const out = documentDateOptOuts(extractedData, p.actions, { documentId: "doc-1", contextKey: "Auto Insurance ID Card" });
    expect(out.optOut).not.toContain("expirationDate");
  });

  it("unticking the expiration action stops the document deriving the rule", () => {
    const p = plan();
    const actions = p.actions.map((a) => (expiryActions([a]).length ? { ...a, selected: false } : a));
    const out = documentDateOptOuts(extractedData, actions, { documentId: "doc-1", contextKey: "Auto Insurance ID Card" });
    expect(out.optOut).toContain("expirationDate");
  });

  it("re-ticking it clears an earlier opt-out", () => {
    const p = plan();
    const out = documentDateOptOuts(
      { ...extractedData, _calendarOptOut: ["expirationDate"] },
      p.actions,
      { documentId: "doc-1", contextKey: "Auto Insurance ID Card" },
    );
    expect(out.optOut).not.toContain("expirationDate");
  });
});
