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
    // Mirrors the Supabase merge semantics (mergeAndApplyDeletes): incoming
    // null/undefined is a deletion intent; other keys overwrite.
    async updateProfile(id: string, patch: any) {
      const cur = state.profiles.get(id);
      if (!cur) return undefined;
      const fields: Record<string, any> = { ...(cur.fields || {}) };
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v === null || v === undefined) delete fields[k];
        else fields[k] = v;
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
