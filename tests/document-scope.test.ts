// tests/document-scope.test.ts
//
// ONE rule for "which documents are this profile's" (shared/document-scope),
// read by the Info tab's count and the Documents tab's list.
//
// User report 2026-09-17: a person's Info tab said "Documents 3" while the
// Documents tab under the same person listed 2. Info counted the server embed
// (`profile.relatedDocuments`), which the memory store builds from the
// document's `linkedProfiles` OR the profile's `documents` id list — the list
// propagateDocumentToAncestors files a child asset's document into. The
// Documents tab kept only rows whose `linkedProfiles` contain the profile.
// Two rules, two numbers. Now both call documentsForProfile on the same rows.

import { describe, it, expect } from "vitest";
import { MemStorage } from "../server/storage";
import { documentsForProfile, isDocumentOfProfile } from "../shared/document-scope";

const doc = (id: string, linkedProfiles: string[] | null | undefined, extra: Record<string, any> = {}) =>
  ({ id, name: id, type: "other", linkedProfiles, ...extra }) as any;

describe("isDocumentOfProfile — the document's own link decides", () => {
  it("is true only when linkedProfiles names the profile", () => {
    expect(isDocumentOfProfile(doc("a", ["alex"]), "alex")).toBe(true);
    expect(isDocumentOfProfile(doc("a", ["alex", "sarah"]), "sarah")).toBe(true);
    expect(isDocumentOfProfile(doc("a", ["sarah"]), "alex")).toBe(false);
  });

  it("is false for a legacy row with no links, and for missing input", () => {
    expect(isDocumentOfProfile(doc("a", null), "alex")).toBe(false);
    expect(isDocumentOfProfile(doc("a", undefined), "alex")).toBe(false);
    expect(isDocumentOfProfile(doc("a", []), "alex")).toBe(false);
    expect(isDocumentOfProfile(null, "alex")).toBe(false);
    expect(isDocumentOfProfile(doc("a", ["alex"]), "")).toBe(false);
  });
});

describe("documentsForProfile — direct links, deduplicated, latest copy wins", () => {
  it("keeps direct links only, in first-seen order", () => {
    const rows = [doc("a", ["alex"]), doc("b", ["honda"]), doc("c", ["sarah", "alex"])];
    expect(documentsForProfile(rows, "alex").map((d) => d.id)).toEqual(["a", "c"]);
  });

  it("merges the same document from two sources into one row", () => {
    const embed = doc("a", ["alex"], { name: "Cached name" });
    const live = doc("a", ["alex"], { name: "Live name", tags: ["fresh"] });
    const out = documentsForProfile([embed, live], "alex");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Live name");
    expect(out[0].tags).toEqual(["fresh"]);
  });

  it("drops a document the live list says was unlinked since the embed was cached", () => {
    const stale = doc("a", ["alex"]);
    const live = doc("a", ["sarah"]);
    expect(documentsForProfile([stale, live], "alex")).toEqual([]);
  });

  it("includes a descendant's document only when asked to", () => {
    const rows = [doc("a", ["alex"]), doc("reg", ["honda"])];
    expect(documentsForProfile(rows, "alex").map((d) => d.id)).toEqual(["a"]);
    expect(documentsForProfile(rows, "alex", { includeDescendants: ["honda"] }).map((d) => d.id))
      .toEqual(["a", "reg"]);
  });

  it("tolerates junk rows and an empty input", () => {
    expect(documentsForProfile(null, "alex")).toEqual([]);
    expect(documentsForProfile([null, undefined, {} as any, doc("a", ["alex"])], "alex").map((d) => d.id)).toEqual(["a"]);
  });
});

describe("the Info count and the Documents tab list are the same number", () => {
  it("one propagated document: the embed says 3, both surfaces say 2", async () => {
    const store = new MemStorage();
    const alex = await store.createProfile({ name: "Alex", type: "self", fields: {} } as any);
    const honda = await store.createProfile({ name: "Honda", type: "vehicle", fields: {}, parentProfileId: alex.id } as any);

    // Two documents of Alex's own…
    const license = await store.createDocument({ name: "License", type: "identification", linkedProfiles: [alex.id], fileData: "" });
    const passport = await store.createDocument({ name: "Passport", type: "identification", linkedProfiles: [alex.id], fileData: "" });
    // …and the Honda's registration, filed under the car and PROPAGATED up
    // into Alex's `documents` id list — the link the embed also reads.
    const registration = await store.createDocument({ name: "Registration", type: "vehicle_registration", linkedProfiles: [honda.id], fileData: "" });
    await store.linkProfileTo(alex.id, "document", registration.id);

    // What each surface fetches.
    const detail = await store.getProfileDetail(alex.id);
    const embed = detail!.relatedDocuments;
    const list = (await store.getDocumentsPage({ profileIds: [alex.id] })).rows;

    // The old Info count — the reported "3".
    expect(embed).toHaveLength(3);

    // Both surfaces now read the same union by the same rule.
    const rows = [...embed, ...list];
    const infoCount = documentsForProfile(rows, alex.id).length;
    const documentsTabList = documentsForProfile(rows, alex.id);
    expect(infoCount).toBe(documentsTabList.length);
    expect(documentsTabList.map((d) => d.name).sort()).toEqual(["License", "Passport"]);
    expect(documentsTabList.map((d) => d.id)).toEqual(expect.arrayContaining([license.id, passport.id]));
    expect(documentsTabList.map((d) => d.id)).not.toContain(registration.id);

    // The registration is still reachable — under the car, where the
    // Documents tab lists descendants' documents.
    const underAssets = documentsForProfile(rows, alex.id, { includeDescendants: [honda.id] });
    expect(underAssets.map((d) => d.name).sort()).toEqual(["License", "Passport", "Registration"]);
  });
});
