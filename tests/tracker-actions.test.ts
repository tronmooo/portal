// tests/tracker-actions.test.ts
//
// THE RULE (user directive, 2026-08-26):
//
//   "Facts get saved; actions get performed. A single extracted fact can do
//    both. Never use Tracker as the storage destination of an extracted fact.
//    The middle table is the authority for what factual data is saved; the
//    Suggested Actions panel is the authority for what becomes tracked."
//
// Two failures this pins. First, selecting "Append 185 lb → Weight tracker"
// used to DELETE `weight` from the profile: the row was withheld from the data
// path because an action claimed it, and the tracker executor writes no fields.
// Second, a tracker action existed only when the reasoner happened to tag a
// fact `measurement`, so an odometer reading produced nothing at all.

import { describe, it, expect } from "vitest";
import {
  planExtractionActions, itemsClaimedByActions, actionStoresItem,
  type EntityIndex,
} from "../shared/extraction-actions";
import type { ExtractionItem } from "../shared/extraction-destinations";
import { emptySemanticDocument } from "../shared/semantic-document";
import { medicalReport, insuranceDeclarations } from "./document-fixtures";

const plan = (fixture: any, over: any = {}) => planExtractionActions({
  semantic: fixture.semantic,
  items: fixture.items,
  index: fixture.index,
  primaryProfileId: fixture.primaryProfileId,
  documentId: "doc-1",
  documentName: "doc",
  today: "2026-08-26",
  ...over,
});

describe("an action never swallows the fact it acts on", () => {
  it("a tracker action leaves its row in the data path", () => {
    const p = plan(medicalReport);
    const trackerActions = p.actions.filter((a) => a.destination === "tracker");
    expect(trackerActions.length).toBeGreaterThan(0);
    const claimed = itemsClaimedByActions(p.actions, p.items);
    for (const a of trackerActions) {
      for (const id of a.itemIds) expect(claimed.has(id)).toBe(false);
    }
  });

  it("but a field-writing action DOES claim its row — no fact written twice", () => {
    const p = plan(insuranceDeclarations);
    const fieldAction = p.actions.find(
      (a) => a.selected && (a.destination === "entity_field" || a.destination === "entity_record")
        && a.itemIds.length > 0);
    expect(fieldAction).toBeTruthy();
    const claimed = itemsClaimedByActions(p.actions, p.items);
    expect(claimed.has(fieldAction!.itemIds[0])).toBe(true);
  });

  it("deselecting an action releases its row back to the data path", () => {
    const p = plan(insuranceDeclarations);
    const fieldAction = p.actions.find(
      (a) => a.selected && a.destination === "entity_field" && a.itemIds.length > 0)!;
    const released = p.actions.map((a) => a.id === fieldAction.id ? { ...a, selected: false } : a);
    const claimed = itemsClaimedByActions(released, p.items);
    for (const id of fieldAction.itemIds) expect(claimed.has(id)).toBe(false);
  });

  it("actionStoresItem says which destinations are storage", () => {
    const at = (destination: any, payload: any = {}) =>
      actionStoresItem({ destination, operation: "CREATE", payload });
    expect(at("profile")).toBe(true);
    expect(at("entity_field")).toBe(true);
    expect(at("entity_record")).toBe(true);
    // Consequences of a fact, never its home.
    expect(at("tracker")).toBe(false);
    expect(at("expense")).toBe(false);
    expect(at("obligation")).toBe(false);
    expect(at("task")).toBe(false);
    // These two only when the payload really carries the fields.
    expect(at("calendar")).toBe(false);
    expect(at("calendar", { fields: { x: 1 }, profileId: "p1" })).toBe(true);
    expect(at("profile_tracker", { fields: { x: 1 }, profileId: "p1" })).toBe(true);
    // Nothing is claimed by an action that does nothing.
    expect(actionStoresItem({ destination: "profile", operation: "NO_ACTION", payload: {} })).toBe(false);
  });
});

describe("the middle table is data, never a verb", () => {
  it("no row an action covers keeps an action destination", () => {
    const forbidden = new Set([
      "tracker", "profile_tracker", "calendar", "task", "expense", "income",
      "obligation", "liability_payment", "relationship_link", "document_attach",
    ]);
    for (const fixture of [medicalReport, insuranceDeclarations]) {
      for (const item of plan(fixture).items) {
        if (!item.actionIds?.length) continue;
        expect(forbidden.has(item.destination)).toBe(false);
      }
    }
  });

  it("a row buildExtractionItems routed to a tracker is demoted to its data home", () => {
    // What the real item builder produces for a weight reading on a person:
    // destination `profile_tracker`, i.e. the row itself claimed to be both a
    // fact and a verb. The plan path keeps the fact and moves the verb.
    const fixture = {
      ...medicalReport,
      items: medicalReport.items.map((i: ExtractionItem) => i.id === "field-weight"
        ? { ...i, destination: "profile_tracker" as const,
            destinationOptions: ["profile_tracker", "tracker", "profile", "ignore"] as const,
            trackerName: "Weight", values: { value: 300 }, unit: "lbs" }
        : i),
    };
    const demoted = plan(fixture).items.find((i) => i.id === "field-weight")!;
    expect(demoted.destination).toBe("profile");
    // Its data home leads the list, and routing it back by hand is still offered.
    expect(demoted.destinationOptions[0]).toBe("profile");
    expect(demoted.destinationOptions).toContain("tracker");
  });
});

// ─── The dynamic detector, end to end through the planner ────────────────────

const item = (id: string, key: string, label: string, value: any): ExtractionItem => ({
  id, key, label, value,
  destination: "entity_field",
  destinationOptions: ["entity_field", "note", "ignore"],
  selected: true,
  source: "field",
});

const emptyIndex = (): EntityIndex =>
  ({ profiles: [], obligations: [], expenses: [], trackers: [], links: [] });

/** A service invoice on a vehicle — nothing here is a medical metric, and the
 *  reasoner tags nothing a measurement. */
const vehicleDoc = (trackers: any[] = []) => ({
  items: [
    item("field-odometer", "odometer", "Odometer", "43,120 mi"),
    item("field-invoicenumber", "invoiceNumber", "Invoice Number", "INV-99201"),
    item("field-servicedate", "serviceDate", "Service Date", "2026-08-01"),
  ],
  index: {
    ...emptyIndex(),
    profiles: [{ id: "veh-1", type: "vehicle", name: "Honda HR-V", fields: {} }],
    trackers,
  },
  semantic: {
    documentType: "Vehicle Service Invoice",
    primarySubject: "e-veh",
    confidence: 0.9,
    summary: "Service invoice.",
    entities: [{ ref: "e-veh", kind: "vehicle", name: "Honda HR-V", identifiers: {}, confidence: 0.9 }],
    relationships: [],
    facts: [{
      id: "f-odo", itemIds: ["field-odometer"], label: "Odometer", value: "43,120 mi",
      roles: ["entity_data"], subject: { entityRef: "e-veh", confidence: 0.9 },
      volatility: "changeable", confidence: 0.9,
    }],
    recurrences: [],
    narrative: [],
  } as any,
  primaryProfileId: "veh-1",
});

describe("tracker suggestions are generated from the document, not from a tag", () => {
  it("an odometer the reasoner never called a measurement still gets a tracker action", () => {
    const p = plan(vehicleDoc());
    const track = p.actions.find((a) => a.destination === "tracker");
    expect(track).toBeTruthy();
    expect(track!.operation).toBe("CREATE");
    expect(track!.payload.values).toEqual({ value: 43120 });
    expect(track!.payload.unit).toBe("mi");
    // Never filed under health, and never under a hidden category.
    expect(track!.payload.category).toBe("custom");
  });

  it("an existing compatible tracker turns it into an APPEND, ticked", () => {
    const p = plan(vehicleDoc([
      { id: "trk-odo", name: "Odometer", unit: "mi", category: "custom", linkedProfiles: ["veh-1"] },
    ]));
    const track = p.actions.find((a) => a.destination === "tracker")!;
    expect(track.operation).toBe("APPEND");
    expect(track.target.id).toBe("trk-odo");
    expect(track.selected).toBe(true);
  });

  it("a tracker whose unit measures something else is not adopted", () => {
    const p = plan(vehicleDoc([
      { id: "trk-cost", name: "Odometer", unit: "$", category: "custom", linkedProfiles: ["veh-1"] },
    ]));
    const track = p.actions.find((a) => a.destination === "tracker")!;
    expect(track.operation).toBe("CREATE");
    expect(track.target.id).toBeNull();
  });

  it("someone else's tracker is never adopted", () => {
    const p = plan(vehicleDoc([
      { id: "trk-other", name: "Odometer", unit: "mi", category: "custom", linkedProfiles: ["veh-9"] },
    ]));
    expect(p.actions.find((a) => a.destination === "tracker")!.operation).toBe("CREATE");
  });

  it("identifiers and dates get no tracker action", () => {
    const ids = plan(vehicleDoc()).actions
      .filter((a) => a.destination === "tracker")
      .flatMap((a) => a.itemIds);
    expect(ids).not.toContain("field-invoicenumber");
    expect(ids).not.toContain("field-servicedate");
  });

  it("a suggestion cites its ROW and no fact — the fact invariants are untouched", () => {
    for (const fixture of [medicalReport, insuranceDeclarations, vehicleDoc()]) {
      for (const a of plan(fixture).actions.filter((x) => x.id.startsWith("act-track-"))) {
        expect(a.factIds).toEqual([]);
        expect(a.itemIds.length).toBe(1);
      }
    }
  });

  it("a new chart is only pre-ticked when the app really understands the value", () => {
    // Shape alone ⇒ proposed, unticked. The user opts in.
    expect(plan(vehicleDoc()).actions.find((a) => a.destination === "tracker")!.selected).toBe(false);
    // A recognised health metric ⇒ pre-ticked.
    const med = plan(medicalReport).actions.filter(
      (a) => a.destination === "tracker" && a.operation === "CREATE");
    expect(med.some((a) => a.selected)).toBe(true);
  });

  it("never proposes two trackers for one row", () => {
    for (const fixture of [medicalReport, insuranceDeclarations, vehicleDoc()]) {
      const byItem = new Map<string, number>();
      for (const a of plan(fixture).actions.filter((x) => x.destination === "tracker")) {
        for (const id of a.itemIds) byItem.set(id, (byItem.get(id) ?? 0) + 1);
      }
      for (const n of byItem.values()) expect(n).toBe(1);
    }
  });
});

// ─── When the reasoner produced nothing at all ───────────────────────────────
//
// USER REPORT (2026-08-26): a 63-field biometric report arrived with "Actions 0"
// and a blank rail. Planning was gated on the reasoner having succeeded, so a
// timeout or a truncated JSON reply took the DETERMINISTIC passes down with it
// — the tracker and deadline passes read the extracted ROWS and never needed
// the reasoner at all, and filing the document under the profile the user
// picked by hand needed it least of any.

describe("a document the AI could not interpret still produces actions", () => {
  const bare = {
    semantic: emptySemanticDocument("wellness_report", ""),
    items: [
      item("field-weight", "weight", "Weight", "185 lb"),
      item("field-restingheartrate", "restingHeartRate", "Resting Heart Rate", "58 bpm"),
      item("field-facilityphone", "facilityPhone", "Facility Phone", "(555) 019-8273"),
      item("field-reportdate", "reportDate", "Report Date", "2026-08-01"),
    ],
    index: {
      ...emptyIndex(),
      profiles: [{ id: "person-1", type: "self", name: "John Doe", fields: {} }],
    },
    primaryProfileId: "person-1",
  };

  it("does not throw on an empty semantic envelope", () => {
    expect(() => plan(bare)).not.toThrow();
  });

  it("still proposes trackers, read straight off the rows", () => {
    const trackers = plan(bare).actions.filter((a) => a.destination === "tracker");
    const named = trackers.map((a) => a.payload.trackerName).sort();
    expect(named).toContain("Weight");
    // Canonicalised: a "Resting Heart Rate" reading joins the one Heart Rate
    // series rather than starting a second chart beside it.
    expect(named).toContain("Heart Rate");
    // …and still refuses the phone number and the date.
    expect(trackers.flatMap((a) => a.itemIds)).not.toContain("field-facilityphone");
    expect(trackers.flatMap((a) => a.itemIds)).not.toContain("field-reportdate");
  });

  it("still files the document under the profile the user picked", () => {
    const attach = plan(bare).actions.find((a) => a.destination === "document_attach");
    expect(attach).toBeTruthy();
    expect(attach!.payload.profileId).toBe("person-1");
    expect(attach!.title).toContain("John Doe");
    expect(attach!.selected).toBe(true);
  });

  it("the rail is therefore not empty", () => {
    const proposable = plan(bare).actions.filter((a) => a.operation !== "NO_ACTION");
    expect(proposable.length).toBeGreaterThan(0);
  });
});
