// Integration test for POST /api/chat/confirm-extraction — the "save selected
// checklist fields to an asset profile" flow.
//
// Bug report 2026-07-27 (oil-change receipt): the user uploaded a receipt, the
// AI extracted it correctly and showed the review checklist, the user picked
// the vehicle profile and ticked specific fields, pressed save — and the fields
// never appeared on the vehicle. Root causes covered here:
//
//  1. The AI "field-destination-route" classifier silently vetoed the user's
//     explicit selections as "doc_only" — with a caller-supplied profile the
//     classifier must not run at all.
//  2. No key canonicalization on this path: `currentMileage` was written as a
//     brand-new key next to the existing `mileage`, so the profile showed
//     "Mileage 80000" AND "Current Mileage 69063" as two rows.
//  3. The route reported success without verifying the write.
//
// Scenario pinned by this test (per the report): extract a receipt, select
// EXACTLY THREE fields from the checklist, save to a vehicle asset, reload the
// profile, and verify exactly those three fields were saved — with mileage
// REPLACING every prior spelling (mileage / currentMileage / vehicles.mileage)
// instead of duplicating, and the replaced readings kept in _mileageHistory.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

import { deleteProfileFields } from "../shared/profile-field-identity";

const { stubState, stubStorage, aiTasks } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    documents: new Map<string, any>(),
    expenses: [] as any[],
  };
  const tasks: string[] = [];
  // Minimal storage stub: the methods confirm-extraction uses are real;
  // everything else is a permissive async no-op so unrelated route
  // registration code doesn't crash.
  const impl: any = {
    async getProfile(id: string) { return state.profiles.get(id); },
    async getProfiles() { return [...state.profiles.values()]; },
    async getProfilesLite() { return [...state.profiles.values()]; },
    async getAssetPartyLinks() { return []; },
    // Mirrors the Supabase merge semantics (mergeAndApplyDeletes): incoming
    // null/undefined is a deletion intent; other keys overwrite. Then the
    // explicit `fieldsToDelete` signal is applied through the SAME shared
    // resolver production uses, so a key removed here also loses its nested
    // twins — a fake that ignored `fieldsToDelete` (as this one used to) makes a
    // route look broken when only the fake is.
    async updateProfile(id: string, patch: any) {
      const cur = state.profiles.get(id);
      if (!cur) return undefined;
      let fields: Record<string, any> = { ...(cur.fields || {}) };
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v === null || v === undefined) delete fields[k];
        else fields[k] = v;
      }
      if (Array.isArray(patch.fieldsToDelete) && patch.fieldsToDelete.length > 0) {
        fields = deleteProfileFields(fields, patch.fieldsToDelete).fields;
      }
      const updated = { ...cur, ...patch, fields };
      state.profiles.set(id, updated);
      return updated;
    },
    async getDocument(id: string) { return state.documents.get(id); },
    async updateDocument(id: string, patch: any) {
      const cur = state.documents.get(id);
      if (!cur) return undefined;
      const updated = { ...cur, ...patch };
      state.documents.set(id, updated);
      return updated;
    },
    async getExpenses() { return state.expenses; },
    async createExpense(data: any) {
      const row = { id: `exp-${state.expenses.length + 1}`, ...data };
      state.expenses.push(row);
      return row;
    },
    async linkProfileTo() { return undefined; },
    async propagateDocumentToAncestors() { return []; },
  };
  const storage = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  });
  return { stubState: state, stubStorage: storage, aiTasks: tasks };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: stubStorage };
});

// Record every AI decision task so the test can assert the field-destination
// classifier is NOT consulted when the user explicitly picked the profile.
vi.mock("../server/ai-decide", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aiDecide: vi.fn(async (opts: any) => {
      aiTasks.push(opts.task);
      return { value: opts.fallback(), source: "fallback", durationMs: 0 };
    }),
    aiPickIndex: vi.fn(async (opts: any) => {
      aiTasks.push(opts.task);
      return { value: { index: -1, confidence: 0, reason: "" }, source: "fallback", durationMs: 0 };
    }),
  };
});

import { registerRoutes } from "../server/routes";

const vehicleProfile = () => ({
  id: "profile-crv",
  name: "Robert's Honda CR-V",
  type: "vehicle",
  fields: {
    make: "Honda", model: "CR-V", year: 2021, vin: "7FARW2H70ME032834",
    // The redundancy the bug report shows: three spellings of one odometer.
    mileage: 80000,
    currentMileage: 64442,
    vehicles: { mileage: 80000, licensePlate: "8YPJ480" },
    currentValue: 21400,
    // Legacy JSONB ownership pointer — the only ownership edge this fixture
    // carries (no parentProfileId, no asset_party_links), mirroring profiles
    // that predate the relational link table.
    ownerProfileId: "profile-self",
  },
  tags: [], notes: "",
});

const receiptDoc = () => ({
  id: "doc-receipt",
  name: "Oil Change Service Receipt",
  type: "vehicle_service_receipt",
  mimeType: "image/png",
  extractedData: {},
  linkedProfiles: [],
  tags: [],
});

describe("POST /api/chat/confirm-extraction", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.expenses.length = 0;
    aiTasks.length = 0;
    stubState.profiles.set("profile-crv", vehicleProfile());
    stubState.profiles.set("profile-self", { id: "profile-self", name: "Robert", type: "self", fields: {}, tags: [] });
    stubState.documents.set("doc-receipt", receiptDoc());

    const app = express();
    app.use(express.json());
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it("saves exactly the three selected checklist fields to the chosen vehicle, replacing mileage instead of duplicating it", async () => {
    const before = vehicleProfile().fields;

    const res = await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        targetProfileId: "profile-crv",
        // Three fields ticked in the checklist — one wrapped {value,confidence}
        // to exercise unwrapping, one alias spelling to exercise canon.
        confirmedFields: [
          { key: "currentMileage", value: { value: 69063, confidence: 0.98 } },
          { key: "serviceDate", value: "2026-07-22" },
          { key: "oilType", value: "Kendall 0W20 GT-1 MAX Full Synthetic" },
        ],
        createCalendarEvents: [],
        trackerEntries: [],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.failures).toEqual([]);
    expect(data.saved.join("; ")).toContain("3 fields to Robert's Honda CR-V");

    // Reload the profile — the deliverable the user actually sees.
    const after = stubState.profiles.get("profile-crv").fields;

    // 1. Mileage REPLACED under the one canonical key…
    expect(after.mileage).toBe(69063);
    // …with every other spelling of the same field gone (no duplicate rows).
    expect(after).not.toHaveProperty("currentMileage");
    expect(after).not.toHaveProperty("odometer");
    expect(after.vehicles).not.toHaveProperty("mileage");
    // Untouched nested keys survive the group rewrite.
    expect(after.vehicles.licensePlate).toBe("8YPJ480");

    // 2. The other two selected fields are on the profile verbatim.
    expect(after.serviceDate).toBe("2026-07-22");
    expect(after.oilType).toBe("Kendall 0W20 GT-1 MAX Full Synthetic");

    // 3. EXACTLY those three fields changed — nothing else was added.
    const addedOrChanged = Object.keys(after).filter(
      (k) => !k.startsWith("_") && JSON.stringify(after[k]) !== JSON.stringify((before as any)[k])
    );
    expect(addedOrChanged.sort()).toEqual(["mileage", "oilType", "serviceDate", "vehicles"].sort());

    // 4. Replaced odometer readings are kept as history, not lost.
    const historyValues = (after._mileageHistory || []).map((h: any) => h.value);
    expect(historyValues).toContain(80000);
    expect(historyValues).toContain(64442);

    // 5. The document keeps all confirmed fields as source of truth.
    const doc = stubState.documents.get("doc-receipt");
    expect(doc.extractedData.currentMileage).toBe(69063);
    expect(doc.extractedData.serviceDate).toBe("2026-07-22");

    // 6. The user's explicit selection is authoritative: the AI field-
    //    destination classifier must never run (it used to silently veto
    //    receipt fields as "doc_only" and drop them from the save).
    expect(aiTasks).not.toContain("field-destination-route");

    // 7. Provenance: the profile records which document saved which fields,
    //    so deleting the document can remove exactly its contribution.
    const provenance = after._docFields?.["doc-receipt"];
    expect(provenance).toBeTruthy();
    expect(provenance.mileage).toBe(69063);
    expect(provenance.serviceDate).toBe("2026-07-22");
  });

  it("deleting the document removes the fields it saved — but keeps values the user edited since", async () => {
    // Save three fields from the receipt.
    await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        targetProfileId: "profile-crv",
        confirmedFields: [
          { key: "currentMileage", value: 69063 },
          { key: "serviceDate", value: "2026-07-22" },
          { key: "oilType", value: "Kendall 0W20" },
        ],
        createCalendarEvents: [],
        trackerEntries: [],
      }),
    });
    // The user then hand-edits one of them.
    const crv = stubState.profiles.get("profile-crv");
    crv.fields.oilType = "Mobil 1 5W30 (user corrected)";

    const res = await fetch(`${base}/api/documents/doc-receipt`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const after = stubState.profiles.get("profile-crv").fields;
    // Document-sourced values are gone…
    expect(after).not.toHaveProperty("mileage");
    expect(after).not.toHaveProperty("serviceDate");
    // …the user's own edit survives…
    expect(after.oilType).toBe("Mobil 1 5W30 (user corrected)");
    // …unrelated fields are untouched, and the provenance entry is cleared.
    expect(after.make).toBe("Honda");
    expect(after._docFields ?? {}).not.toHaveProperty("doc-receipt");
  });

  // ── The user's answer to "remove the data too?" ──────────────────────────────
  //
  // User, 2026-08-05: "When you delete a document, you should delete all the data
  // that comes with it… there should be an option when you delete the document it
  // should say are you sure? Do you want to remove all the data in the info?"
  //
  // The confirmation dialog previews the fields, then sends the answer as
  // ?purgeFields=1|0. These pin that the answer is actually honored — a checkbox
  // the server ignores is worse than no checkbox, because the user believes it.
  describe("the delete honors what the user chose in the confirmation", () => {
    async function saveThreeFields() {
      await fetch(`${base}/api/chat/confirm-extraction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extractionId: "doc-receipt",
          targetProfileId: "profile-crv",
          confirmedFields: [
            { key: "currentMileage", value: 69063 },
            { key: "serviceDate", value: "2026-07-22" },
            { key: "oilType", value: "Kendall 0W20" },
          ],
          createCalendarEvents: [],
          trackerEntries: [],
        }),
      });
    }

    it("previews the fields the document put on the profile", async () => {
      await saveThreeFields();
      const preview = await fetch(`${base}/api/documents/doc-receipt/derived-fields`).then((r) => r.json());
      expect(preview.documentName).toBe("Oil Change Service Receipt");
      expect(preview.total).toBeGreaterThan(0);
      const listed = preview.profiles.flatMap((p: any) => p.fields.map((f: any) => f.path));
      expect(listed).toContain("mileage");
      expect(listed).toContain("serviceDate");
      expect(listed).toContain("oilType");
      // Never anything the receipt had nothing to do with.
      expect(listed).not.toContain("make");
      expect(listed).not.toContain("vin");
    });

    it("purgeFields=1 removes everything the preview listed, edited values included", async () => {
      await saveThreeFields();
      // The user hand-edited one of them — the dialog warns, and the purge still
      // takes it, because that is what was previewed and agreed to.
      stubState.profiles.get("profile-crv").fields.oilType = "Mobil 1 5W30 (user corrected)";

      const preview = await fetch(`${base}/api/documents/doc-receipt/derived-fields`).then((r) => r.json());
      expect(preview.editedCount).toBeGreaterThan(0);
      const listed: string[] = preview.profiles.flatMap((p: any) => p.fields.map((f: any) => f.path));

      const res = await fetch(`${base}/api/documents/doc-receipt?purgeFields=1`, { method: "DELETE" });
      expect(res.status).toBe(200);

      const after = stubState.profiles.get("profile-crv").fields;
      // EXACTLY what was listed is gone — the preview is the consent.
      for (const p of listed) {
        const [head, leaf] = p.split(".");
        if (leaf) expect(after[head]?.[leaf]).toBeUndefined();
        else expect(after).not.toHaveProperty(head);
      }
      expect(after).not.toHaveProperty("oilType");
      // Nothing else touched.
      expect(after.make).toBe("Honda");
      expect(after.vin).toBe("7FARW2H70ME032834");
      expect(after.vehicles.licensePlate).toBe("8YPJ480");
    });

    it("purgeFields=0 keeps the data and deletes only the file", async () => {
      await saveThreeFields();
      const res = await fetch(`${base}/api/documents/doc-receipt?purgeFields=0`, { method: "DELETE" });
      expect(res.status).toBe(200);

      const after = stubState.profiles.get("profile-crv").fields;
      expect(after.mileage).toBe(69063);
      expect(after.serviceDate).toBe("2026-07-22");
      expect(after.oilType).toBe("Kendall 0W20");
      // The provenance record goes regardless — the document it pointed at is gone.
      expect(after._docFields ?? {}).not.toHaveProperty("doc-receipt");
    });
  });

  it("links a confirm-created expense to the ASSET only — the owner sees it by derivation, counted once", async () => {
    const res = await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        targetProfileId: "profile-crv",
        confirmedFields: [{ key: "serviceDate", value: "2026-07-22" }],
        createCalendarEvents: [],
        trackerEntries: [],
        createExpense: {
          description: "Oil Change Service Receipt",
          amount: 118.14,
          category: "vehicle",
          date: "2026-07-22",
        },
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(stubState.expenses).toHaveLength(1);
    // ONE row, ONE link (shared/cost-of-ownership.ts model): the expense
    // belongs to the Honda. Linking it to the owner as well is how costs get
    // double-attributed.
    expect(stubState.expenses[0].linkedProfiles).toEqual(["profile-crv"]);

    // The OWNER still sees it: /api/expenses?profileIds=<self> widens the
    // scope with the assets that person owns. The Honda's ownership here is
    // recorded only via the legacy fields.ownerProfileId pointer — the edge
    // real profiles carry when they predate the relational link table.
    const feed = await fetch(`${base}/api/expenses?profileIds=profile-self`).then((r) => r.json());
    const ids = (Array.isArray(feed) ? feed : []).map((e: any) => e.id);
    expect(ids).toContain(stubState.expenses[0].id);
    // Counted once — the widened feed returns the single row exactly once.
    expect(ids.filter((id: string) => id === stubState.expenses[0].id)).toHaveLength(1);
  });

  it("saves every ticked field even when no profile was explicitly chosen (auto-resolves, never AI-vetoes)", async () => {
    const res = await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        // No targetProfileId — the server falls back to the self profile.
        confirmedFields: [
          { key: "insurer", value: "Progressive" },
          { key: "coverageType", value: "Full Coverage" },
        ],
        createCalendarEvents: [],
        trackerEntries: [],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const self = stubState.profiles.get("profile-self").fields;
    expect(self.insurer).toBe("Progressive");
    expect(self.coverageType).toBe("Full Coverage");
    // The field-destination AI classifier is gone from this path entirely —
    // ticked fields are saved deterministically on EVERY path.
    expect(aiTasks).not.toContain("field-destination-route");
  });

  it("folds alias spellings into the canonical key for any field, replacing instead of duplicating", async () => {
    const res = await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        targetProfileId: "profile-crv",
        confirmedFields: [
          { key: "vehicleMake", value: "HONDA" },
          { key: "licensePlateNumber", value: "8YPJ480" },
        ],
        createCalendarEvents: [],
        trackerEntries: [],
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const after = stubState.profiles.get("profile-crv").fields;
    // vehicleMake folded into the existing canonical `make` — one make field.
    expect(after.make).toBe("HONDA");
    expect(after).not.toHaveProperty("vehicleMake");
    // licensePlateNumber folded into `licensePlate`; the nested-group copy
    // (vehicles.licensePlate) was swept so exactly ONE plate remains.
    expect(after.licensePlate).toBe("8YPJ480");
    expect(after.vehicles).not.toHaveProperty("licensePlate");
  });

  it("reports a failure when fields were ticked but no profile could be resolved", async () => {
    stubState.profiles.delete("profile-self"); // no fallback available
    const res = await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        confirmedFields: [{ key: "serviceDate", value: "2026-07-22" }],
        createCalendarEvents: [],
        trackerEntries: [],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Not silent success: the response says the fields reached the document only.
    expect(data.success).toBe(false);
    expect(data.failures.join("; ")).toContain("document only");
  });

  it("names the specific fields that failed instead of claiming the whole save succeeded", async () => {
    // Wedge the verification: updates to THIS profile silently drop oilType,
    // simulating a backend that acknowledged the write but didn't persist it.
    const realUpdate = (stubStorage as any).updateProfile;
    (stubStorage as any).updateProfile = async (id: string, patch: any) => {
      if (patch?.fields) delete patch.fields.oilType;
      return realUpdate.call(stubStorage, id, patch);
    };
    try {
      const res = await fetch(`${base}/api/chat/confirm-extraction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extractionId: "doc-receipt",
          targetProfileId: "profile-crv",
          confirmedFields: [
            { key: "serviceDate", value: "2026-07-22" },
            { key: "oilType", value: "Kendall 0W20" },
          ],
          createCalendarEvents: [],
          trackerEntries: [],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.failures.join("; ")).toContain("oilType");
      expect(data.failures.join("; ")).not.toContain("serviceDate");
      // The field that DID persist is still reported saved.
      expect(stubState.profiles.get("profile-crv").fields.serviceDate).toBe("2026-07-22");
    } finally {
      (stubStorage as any).updateProfile = realUpdate;
    }
  });

  it("does not create a duplicate expense when one with the same date and amount already exists", async () => {
    stubState.expenses.push({
      id: "exp-existing",
      description: "Oil Change Service Receipt - Oil Changers / Lube N Go",
      amount: 118.14,
      date: "2026-07-26",
      category: "vehicle",
    });
    const res = await fetch(`${base}/api/chat/confirm-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractionId: "doc-receipt",
        targetProfileId: "profile-crv",
        confirmedFields: [{ key: "serviceDate", value: "2026-07-22" }],
        createCalendarEvents: [],
        trackerEntries: [],
        createExpense: {
          description: "Oil change service receipt - transportation",
          amount: 118.14,
          category: "transportation",
          date: "2026-07-26",
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Still exactly one expense — the confirm did not mint a twin.
    expect(stubState.expenses).toHaveLength(1);
    expect(data.saved.join("; ")).toContain("skipped duplicate");
  });
});
