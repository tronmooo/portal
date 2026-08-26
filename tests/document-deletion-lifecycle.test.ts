// tests/document-deletion-lifecycle.test.ts
//
// Deleting a document is a lifecycle, not a row removal. These tests pin the
// three promises server/document-deletion.ts makes, against real MemStorage
// rather than mocks:
//
//   1. Global — the document leaves the document list, the profile's own
//      `documents` array and the profile detail embed at once. The user's
//      report was the opposite: gone from Documents, still on the asset.
//   2. Provenance-aware — a field dies only if this document is its SOLE
//      source and the value is still what the document wrote.
//   3. The user's choice — "cascade" takes the derived data, "document-only"
//      keeps it and de-sources it.
//
// Plus the AI: the cached profile summary that quotes the deleted document is
// discarded, in both modes.

import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import {
  computeDocumentDeletionImpact,
  deleteDocumentEverywhere,
  repairOrphanedDocumentEvents,
  isDocumentDerivedEvent,
  aiSummaryCacheKey,
} from "../server/document-deletion";

let storage: MemStorage;
let houseId: string;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  storage = new MemStorage();
  const house = await storage.createProfile({ name: "123 Evergreen Ln", type: "property" } as any);
  houseId = house.id;
});

/** An insurance declaration the way confirm-extraction leaves the world. */
async function uploadPolicy(overrides: Record<string, any> = {}) {
  const doc = await storage.createDocument({
    name: "Homeowners Insurance Policy Declarations",
    type: "homeowners_insurance_declarations",
    mimeType: "image/jpeg",
    fileData: "",
    extractedData: { policyNumber: "PRP-25-8945621", annualPremium: "1737" },
    linkedProfiles: [houseId],
    tags: [],
    ...overrides,
  } as any);
  return doc;
}

/** Record what a document wrote onto the profile, as confirm-extraction does. */
async function recordProvenance(docId: string, saved: Record<string, any>) {
  const profile = await storage.getProfile(houseId);
  const fields = { ...(profile!.fields as Record<string, any>) };
  const sources = { ...((fields as any)._docFields || {}) };
  sources[docId] = saved;
  await storage.updateProfile(houseId, {
    fields: { ...fields, ...saved, _docFields: sources },
  } as any);
}

describe("deleting a document removes it from every surface", () => {
  it("leaves no trace on the profile that showed it", async () => {
    const doc = await uploadPolicy();
    await storage.linkProfileTo(houseId, "document", doc.id);
    expect((await storage.getProfile(houseId))!.documents).toContain(doc.id);

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    expect(await storage.getDocument(doc.id)).toBeUndefined();
    expect((await storage.getProfile(houseId))!.documents).not.toContain(doc.id);
    expect(await storage.getDocumentsForProfile(houseId)).toEqual([]);
    const detail = await storage.getProfileDetail(houseId);
    expect(detail!.relatedDocuments.map((d: any) => d.id)).not.toContain(doc.id);
  });

  it("clears a one-sided profile → document reference the document doesn't know about", async () => {
    // The asymmetry that outlived the old delete: the profile lists the
    // document, the document doesn't list the profile, so the document-side
    // cleanup never reached it.
    const doc = await uploadPolicy({ linkedProfiles: [] });
    const profile = await storage.getProfile(houseId);
    await storage.updateProfile(houseId, { documents: [...profile!.documents, doc.id] } as any);

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    expect((await storage.getProfile(houseId))!.documents).not.toContain(doc.id);
  });
});

describe("what happens to the data the document created", () => {
  it("cascade removes the fields this document is the sole source of", async () => {
    const doc = await uploadPolicy();
    await recordProvenance(doc.id, { policyNumber: "PRP-25-8945621", annualPremium: "1737" });

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    const fields = (await storage.getProfile(houseId))!.fields as Record<string, any>;
    expect(fields.policyNumber).toBeUndefined();
    expect(fields.annualPremium).toBeUndefined();
    expect(fields._docFields).toBeFalsy();
  });

  it("document-only keeps the data and stops it claiming a deleted source", async () => {
    const doc = await uploadPolicy();
    await recordProvenance(doc.id, { policyNumber: "PRP-25-8945621", annualPremium: "1737" });

    await deleteDocumentEverywhere(storage as any, doc.id, "document-only", silent);

    const fields = (await storage.getProfile(houseId))!.fields as Record<string, any>;
    expect(fields.policyNumber).toBe("PRP-25-8945621");
    expect(fields.annualPremium).toBe("1737");
    // The value survives; the claim that a now-deleted document is its source
    // does not — otherwise deleting a SECOND document later would think this
    // one still vouches for the value.
    expect((fields._docFields || {})[doc.id]).toBeUndefined();
    expect(await storage.getDocument(doc.id)).toBeUndefined();
  });

  it("keeps a value a second document also vouches for, and drops only this one's link", async () => {
    const policy = await uploadPolicy();
    const deed = await uploadPolicy({ name: "Property Deed", type: "deed" });
    await recordProvenance(policy.id, { propertyAddress: "123 Evergreen Ln", policyNumber: "PRP-25-8945621" });
    await recordProvenance(deed.id, { propertyAddress: "123 Evergreen Ln" });

    await deleteDocumentEverywhere(storage as any, policy.id, "cascade", silent);

    const fields = (await storage.getProfile(houseId))!.fields as Record<string, any>;
    expect(fields.propertyAddress).toBe("123 Evergreen Ln"); // the deed still holds it up
    expect(fields.policyNumber).toBeUndefined();             // the policy was its only source
    expect(Object.keys(fields._docFields || {})).toEqual([deed.id]);
  });

  it("leaves a field the user has since edited alone", async () => {
    const doc = await uploadPolicy();
    await recordProvenance(doc.id, { annualPremium: "1737" });
    await storage.updateProfile(houseId, { fields: { annualPremium: "1900" } } as any);

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    const fields = (await storage.getProfile(houseId))!.fields as Record<string, any>;
    expect(fields.annualPremium).toBe("1900");
  });
});

describe("derived calendar dates", () => {
  async function derivedEvent(docId: string, extra: Partial<any> = {}) {
    return storage.createEvent({
      title: "Insurance renewal",
      date: "2027-06-01",
      linkedProfiles: [houseId],
      linkedDocuments: [docId],
      tags: ["document-extraction"],
      ...extra,
    } as any);
  }

  it("cascade removes an event only this document feeds", async () => {
    const doc = await uploadPolicy();
    const ev = await derivedEvent(doc.id);

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    expect(await storage.getEvent(ev.id)).toBeUndefined();
  });

  it("only unlinks an event another document also feeds", async () => {
    const doc = await uploadPolicy();
    const other = await uploadPolicy({ name: "Renewal notice" });
    const ev = await derivedEvent(doc.id, { linkedDocuments: [doc.id, other.id] });

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    const after = await storage.getEvent(ev.id);
    expect(after).toBeDefined();
    expect(after!.linkedDocuments).toEqual([other.id]);
  });

  it("never touches an event the user created themselves", async () => {
    const doc = await uploadPolicy();
    const ev = await derivedEvent(doc.id, { tags: [] }); // no extraction tag

    await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

    expect(await storage.getEvent(ev.id)).toBeDefined();
  });

  it("document-only keeps the date but unlinks the deleted document", async () => {
    const doc = await uploadPolicy();
    const ev = await derivedEvent(doc.id);

    await deleteDocumentEverywhere(storage as any, doc.id, "document-only", silent);

    const after = await storage.getEvent(ev.id);
    expect(after).toBeDefined();
    expect(after!.linkedDocuments).toEqual([]);
  });
});

describe("AI retrieval", () => {
  it("discards the cached profile summary that quotes the document, in both modes", async () => {
    for (const mode of ["cascade", "document-only"] as const) {
      storage = new MemStorage();
      const house = await storage.createProfile({ name: "123 Evergreen Ln", type: "property" } as any);
      houseId = house.id;
      const doc = await uploadPolicy();
      await storage.setPreference(
        aiSummaryCacheKey(houseId),
        JSON.stringify({ summary: "Covered by policy PRP-25-8945621.", generatedAt: new Date().toISOString() }),
      );

      await deleteDocumentEverywhere(storage as any, doc.id, mode, silent);

      // "" is the miss marker the ai-summary read path already understands, so
      // the next read regenerates from the post-delete data.
      expect(await storage.getPreference(aiSummaryCacheKey(houseId))).toBe("");
    }
  });
});

describe("the impact preview the confirmation dialog shows", () => {
  it("counts what cascade would actually take, and what it would keep", async () => {
    const policy = await uploadPolicy();
    const deed = await uploadPolicy({ name: "Property Deed", type: "deed" });
    await storage.linkProfileTo(houseId, "document", policy.id);
    await recordProvenance(policy.id, { propertyAddress: "123 Evergreen Ln", policyNumber: "PRP-25-8945621" });
    await recordProvenance(deed.id, { propertyAddress: "123 Evergreen Ln" });
    await storage.createEvent({
      title: "Insurance renewal", date: "2027-06-01",
      linkedProfiles: [houseId], linkedDocuments: [policy.id], tags: ["document-extraction"],
    } as any);

    const impact = await computeDocumentDeletionImpact(storage as any, policy.id);

    expect(impact).toBeDefined();
    expect(impact!.documentName).toBe("Homeowners Insurance Policy Declarations");
    expect(impact!.derivedFieldCount).toBe(1);   // policyNumber only
    expect(impact!.sharedFieldCount).toBe(1);    // propertyAddress is the deed's too
    expect(impact!.derivedEventCount).toBe(1);
    expect(impact!.linkedProfiles.map((p) => p.id)).toContain(houseId);
    expect(impact!.aiSummaryProfileCount).toBeGreaterThan(0);
  });

  it("does not promise to remove a field the user has since edited", async () => {
    const doc = await uploadPolicy();
    await recordProvenance(doc.id, { annualPremium: "1737" });
    await storage.updateProfile(houseId, { fields: { annualPremium: "1900" } } as any);

    const impact = await computeDocumentDeletionImpact(storage as any, doc.id);

    expect(impact!.derivedFieldCount).toBe(0);
  });

  it("is undefined for a document that isn't there", async () => {
    expect(await computeDocumentDeletionImpact(storage as any, "nope")).toBeUndefined();
  });
});

// ─── The shapes extraction has actually written ─────────────────────────────
//
// Every row here was observed in a real account. The first fix matched only on
// the `document-extraction` tag, which left 28 of 69 document-linked events
// behind — the user's "I deleted the document and the calendar date is still
// there". Note the fourth: `source: "manual"` on an event whose description
// says it was auto-created, which is why `source` cannot be the discriminator.
describe("recognising an event this app derived from a document", () => {
  const SHAPES = [
    { name: "current extraction", tags: ["document-extraction"], description: "Auto-created from document extraction (expirationDate)" },
    { name: "uncovered extraction date", tags: ["document-extraction", "date-rule-uncovered"], description: "Auto-created from document extraction (plan Recommendations 4)" },
    { name: "legacy AI, untagged", tags: [], description: "Auto-created from document: CA Vehicle Registration – Honda 2021" },
    { name: "legacy auto-extraction", tags: ["auto-extraction"], description: "Auto-created from Driver License - Jane Doe (expirationDate)" },
    { name: "legacy from-document alert", tags: ["from-document", "expiration-alert"], description: "Auto-created from document: Florida Driver License - Expires 2024" },
    { name: "auto reminder", tags: ["auto-reminder"], description: "Reminder: ⚠️ Driver License — Expiration is in 1 days" },
  ];

  for (const shape of SHAPES) {
    it(`claims the ${shape.name} shape`, () => {
      expect(isDocumentDerivedEvent(shape)).toBe(true);
    });
  }

  it("never claims an event the user made and linked by hand", () => {
    // CalendarManagerPanel lets a user attach a document to their own event, so
    // a link is not evidence of anything. No auto tag, no auto description.
    expect(isDocumentDerivedEvent({ tags: [], description: "Dinner with Sam" })).toBe(false);
    expect(isDocumentDerivedEvent({ tags: ["reminder"], description: null })).toBe(false);
    expect(isDocumentDerivedEvent({})).toBe(false);
  });

  it("deletes every derived shape when its document goes", async () => {
    for (const shape of SHAPES) {
      storage = new MemStorage();
      const house = await storage.createProfile({ name: "123 Evergreen Ln", type: "property" } as any);
      houseId = house.id;
      const doc = await uploadPolicy();
      const ev = await storage.createEvent({
        title: "Derived date", date: "2027-06-01",
        linkedProfiles: [houseId], linkedDocuments: [doc.id],
        tags: shape.tags, description: shape.description,
      } as any);

      await deleteDocumentEverywhere(storage as any, doc.id, "cascade", silent);

      expect(await storage.getEvent(ev.id), shape.name).toBeUndefined();
    }
  });
});

describe("repairing orphans left by deletes that predate the cascade", () => {
  it("removes a derived event whose document is already gone", async () => {
    const doc = await uploadPolicy();
    const orphan = await storage.createEvent({
      title: "⚠️ Florida Driver's License — Expires", date: "2030-11-24",
      linkedProfiles: [houseId], linkedDocuments: [doc.id], tags: [],
      description: "Auto-created from document: Florida Driver's License",
    } as any);
    // Delete the document the way the OLD path did — the row only.
    await storage.deleteDocument(doc.id);
    expect(await storage.getEvent(orphan.id)).toBeDefined();

    const dry = await repairOrphanedDocumentEvents(storage as any, {}, silent);
    expect(dry.dryRun).toBe(true);
    expect(dry.orphaned.map((o) => o.eventId)).toEqual([orphan.id]);
    expect(dry.removed).toBe(0);
    expect(await storage.getEvent(orphan.id)).toBeDefined(); // a dry run touches nothing

    const applied = await repairOrphanedDocumentEvents(storage as any, { dryRun: false }, silent);
    expect(applied.removed).toBe(1);
    expect(await storage.getEvent(orphan.id)).toBeUndefined();
  });

  it("leaves an event alone while any of its documents is still alive", async () => {
    const dead = await uploadPolicy();
    const alive = await uploadPolicy({ name: "Renewal notice" });
    const ev = await storage.createEvent({
      title: "Insurance renewal", date: "2027-06-01",
      linkedProfiles: [houseId], linkedDocuments: [dead.id, alive.id],
      tags: ["document-extraction"], description: "Auto-created from document extraction (expirationDate)",
    } as any);
    await storage.deleteDocument(dead.id);

    const dry = await repairOrphanedDocumentEvents(storage as any, {}, silent);

    expect(dry.orphaned).toEqual([]);
    expect(await storage.getEvent(ev.id)).toBeDefined();
  });

  it("never removes a user's own event, even with a dead document attached", async () => {
    const doc = await uploadPolicy();
    const mine = await storage.createEvent({
      title: "Call the insurance agent", date: "2027-06-01",
      linkedProfiles: [houseId], linkedDocuments: [doc.id], tags: [],
      description: "Ask about the roof discount",
    } as any);
    await storage.deleteDocument(doc.id);

    const applied = await repairOrphanedDocumentEvents(storage as any, { dryRun: false }, silent);

    expect(applied.removed).toBe(0);
    expect(await storage.getEvent(mine.id)).toBeDefined();
  });
});
