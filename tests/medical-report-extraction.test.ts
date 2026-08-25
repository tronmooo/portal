// End-to-end test for POST /api/chat/confirm-extraction driven by the review
// list — the "34 pieces of data" flow.
//
// Bug report 2026-08-25 (Riverdale Health Clinic annual physical). Uploading one
// medical report produced:
//   - a Height tracker whose only entry read "5 in" (the page says 5 ft 7 in)
//   - a full lab panel flattened into loose profile strings, because only 25
//     hard-coded keys were even allowed to become a tracker
//   - a penicillin allergy, an appendectomy and "Lungs clear bilaterally" filed
//     as sibling profile fields
//   - nothing at all for the physical exam narrative or the 2027 annual visit
//   - and no way to say where any of it should go
//
// This test drives the whole report through the route the way the review pane
// now does — one `items` list, each row carrying the destination — and asserts
// each destination actually received what it should, that nothing duplicates on
// a second upload, and that a re-routed row lands where the USER said.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

import { mergeFieldWrite } from "../shared/profile-field-identity";
import { trackerNamesMatch } from "../shared/tracker-identity";
import type { ExtractionItem, ExtractionDestination } from "../shared/extraction-destinations";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    documents: new Map<string, any>(),
    trackers: [] as any[],
    entries: [] as any[],
    artifacts: [] as any[],
    tasks: [] as any[],
    events: [] as any[],
  };
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;

  const impl: any = {
    async getProfile(pid: string) { return state.profiles.get(pid); },
    async getProfiles() { return [...state.profiles.values()]; },
    async getProfilesLite() { return [...state.profiles.values()]; },
    async getAssetPartyLinks() { return []; },
    async updateProfile(pid: string, patch: any) {
      const cur = state.profiles.get(pid);
      if (!cur) return undefined;
      const incoming: Record<string, any> = {};
      const deletions: string[] = [];
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v === null || v === undefined) deletions.push(k); else incoming[k] = v;
      }
      const write = mergeFieldWrite(cur.fields || {}, incoming);
      const fields: Record<string, any> = { ...write.fields };
      for (const k of write.superseded) delete fields[k];
      for (const k of deletions) delete fields[k];
      const updated = { ...cur, ...patch, fields };
      state.profiles.set(pid, updated);
      return updated;
    },
    async getDocument(did: string) { return state.documents.get(did); },
    async updateDocument(did: string, patch: any) {
      const cur = state.documents.get(did);
      if (!cur) return undefined;
      const updated = { ...cur, ...patch };
      state.documents.set(did, updated);
      return updated;
    },

    // Trackers — mirrors SupabaseStorage.createTracker's STRICT identity dedupe
    // (deliberately not the looser containment match, so this suite would fail
    // if the route stopped doing the containment lookup itself).
    async getTrackers() { return state.trackers; },
    async createTracker(data: any) {
      const row = {
        id: id("trk"),
        name: data.name,
        unit: data.unit ?? "",
        category: data.category ?? "custom",
        fields: data.fields ?? [],
        entries: [],
        linkedProfiles: data.linkedProfiles ?? [],
      };
      state.trackers.push(row);
      return row;
    },
    async updateTracker(tid: string, patch: any) {
      const t = state.trackers.find((x) => x.id === tid);
      if (t) Object.assign(t, patch);
      return t;
    },
    async logEntry(data: any) {
      const row = { id: id("ent"), ...data };
      state.entries.push(row);
      const t = state.trackers.find((x) => x.id === data.trackerId);
      if (t) t.entries.push(row);
      return row;
    },

    // Notes are artifacts of type "note" (server/content-service).
    async getArtifacts() { return state.artifacts; },
    async listArtifacts() { return state.artifacts; },
    async createArtifact(data: any) {
      const row = { id: id("art"), ...data };
      state.artifacts.push(row);
      return row;
    },

    async createTask(data: any) {
      const row = { id: id("task"), ...data };
      state.tasks.push(row);
      return row;
    },
    async getTasks() { return state.tasks; },
    async createEvent(data: any) {
      const row = { id: id("evt"), ...data };
      state.events.push(row);
      return row;
    },
    async getEvents() { return state.events; },
    async getExpenses() { return []; },
    async linkProfileTo() { return undefined; },
    async propagateDocumentToAncestors() { return []; },
  };

  const storage = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  });
  return { stubState: state, stubStorage: storage };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: stubStorage };
});

vi.mock("../server/ai-decide", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aiDecide: vi.fn(async (opts: any) => ({ value: opts.fallback(), source: "fallback", durationMs: 0 })),
    aiPickIndex: vi.fn(async () => ({ value: { index: -1, confidence: 0, reason: "" }, source: "fallback", durationMs: 0 })),
  };
});

import { registerRoutes } from "../server/routes";

// ── The Riverdale report, as the review pane would send it ──────────────────
let itemSeq = 0;
const item = (
  destination: ExtractionDestination,
  label: string,
  value: any,
  extra: Partial<ExtractionItem> = {},
): ExtractionItem => ({
  id: `i${++itemSeq}`,
  key: extra.key ?? label.replace(/\s+/g, ""),
  label,
  value,
  destination,
  destinationOptions: ["profile", "tracker", "note", "ignore"],
  selected: true,
  source: extra.source ?? "field",
  ...extra,
});

const measure = (label: string, trackerName: string, values: Record<string, number>, unit: string) =>
  item("tracker", label, Object.values(values).join("/"), {
    source: "tracker", trackerName, values, unit, category: "health",
  });

function reportItems(): ExtractionItem[] {
  itemSeq = 0;
  return [
    // Profile identity.
    item("profile", "Date of Birth", "1988-03-14", { key: "dateOfBirth" }),
    item("profile", "Gender", "Female", { key: "gender" }),
    item("profile", "Blood Type", "O+", { key: "bloodType" }),

    // Body characteristics — profile AND tracker, one tick.
    item("profile_tracker", "Height", "5 ft 7 in (170 cm)", {
      key: "height", trackerName: "Height", values: { value: 67 }, unit: "in", category: "health",
    }),
    item("profile_tracker", "Weight", "300 lb (136.1 kg)", {
      key: "weight", trackerName: "Weight", values: { value: 300 }, unit: "lbs", category: "health",
    }),
    item("profile_tracker", "BMI", "47.0", {
      key: "bmi", trackerName: "BMI", values: { value: 47 }, unit: "kg/m²", category: "health",
    }),

    // Vitals.
    measure("Blood Pressure", "Blood Pressure", { systolic: 138, diastolic: 86 }, "mmHg"),
    measure("Heart Rate", "Heart Rate", { value: 82 }, "bpm"),
    measure("Respiratory Rate", "Respiratory Rate", { value: 17 }, "breaths/min"),
    measure("Temperature", "Temperature", { value: 98.4 }, "°F"),
    measure("Oxygen Saturation", "Oxygen Saturation", { value: 97 }, "%"),

    // Labs — the ones the old allowlist could never track.
    measure("Blood Glucose", "Blood Glucose", { value: 104 }, "mg/dL"),
    measure("Creatinine", "Creatinine", { value: 0.81 }, "mg/dL"),
    measure("Sodium", "Sodium", { value: 140 }, "mmol/L"),
    measure("Potassium", "Potassium", { value: 4.2 }, "mmol/L"),
    measure("Total Cholesterol", "Total Cholesterol", { value: 204 }, "mg/dL"),
    measure("LDL Cholesterol", "LDL Cholesterol", { value: 128 }, "mg/dL"),
    measure("HDL Cholesterol", "HDL Cholesterol", { value: 48 }, "mg/dL"),
    measure("Triglycerides", "Triglycerides", { value: 142 }, "mg/dL"),
    measure("Hemoglobin A1C", "Hemoglobin A1C", { value: 5.8 }, "%"),
    measure("TSH", "TSH", { value: 2.1 }, "mIU/L"),
    measure("Vitamin D", "Vitamin D", { value: 27 }, "ng/mL"),

    // Allergies.
    item("allergy", "Penicillin", "Penicillin", { source: "allergy", detail: "Rash", payload: { substance: "Penicillin", reaction: "Rash", type: "medication" } }),
    item("allergy", "Pollen", "Pollen", { source: "allergy", payload: { substance: "Pollen", type: "environmental" } }),
    item("allergy", "Dust", "Dust", { source: "allergy", payload: { substance: "Dust", type: "environmental" } }),

    // Medications and supplements.
    item("medication", "Cetirizine", "Cetirizine", { source: "medication", trackerName: "Cetirizine", payload: { name: "Cetirizine", dose: "10 mg", frequency: "once daily as needed", asNeeded: true, kind: "medication" } }),
    item("medication", "Omeprazole", "Omeprazole", { source: "medication", trackerName: "Omeprazole", payload: { name: "Omeprazole", dose: "20 mg", frequency: "once daily as needed", asNeeded: true, kind: "medication" } }),
    item("medication", "Vitamin D3", "Vitamin D3", { source: "medication", trackerName: "Vitamin D3", payload: { name: "Vitamin D3", dose: "2,000 IU", frequency: "once daily", kind: "supplement" } }),
    item("medication", "Multivitamin", "Multivitamin", { source: "medication", trackerName: "Multivitamin", payload: { name: "Multivitamin", frequency: "once daily", kind: "supplement" } }),

    // Conditions and surgical history.
    item("medical_history", "Obesity", "Obesity", { source: "condition", payload: { name: "Obesity", status: "active" } }),
    item("medical_history", "GERD", "GERD", { source: "condition", payload: { name: "Gastroesophageal reflux disease (GERD)", status: "active" } }),
    item("medical_history", "Seasonal allergic rhinitis", "Seasonal allergic rhinitis", { source: "condition", payload: { name: "Mild seasonal allergic rhinitis", status: "active" } }),
    item("medical_history", "Vitamin D deficiency", "Vitamin D deficiency", { source: "condition", payload: { name: "History of vitamin D deficiency", status: "history" } }),
    item("medical_history", "Appendectomy", "Appendectomy", { source: "surgery", payload: { procedure: "Appendectomy", year: 2012 } }),
    item("medical_history", "Wisdom teeth extraction", "Wisdom teeth extraction", { source: "surgery", payload: { procedure: "Wisdom teeth extraction", year: 2007 } }),

    // Narrative.
    item("note", "Physical Examination Summary", "Alert, oriented, no acute distress. Regular rate and rhythm. Lungs clear bilaterally. Abdomen soft, non-tender. No focal deficits. No edema, normal range of motion.", {
      source: "note", payload: { title: "Physical Examination Summary", body: "Alert, oriented, no acute distress. Regular rate and rhythm. Lungs clear bilaterally. Abdomen soft, non-tender. No focal deficits. No edema, normal range of motion." },
    }),

    // Follow-ups.
    item("task", "Repeat labs", "2027-02-25", { source: "followup", date: "2027-02-25", payload: { title: "Repeat labs", date: "2027-02-25" } }),
    item("calendar", "Annual visit", "2027-08-25", { source: "followup", date: "2027-08-25", payload: { title: "Annual visit", date: "2027-08-25" } }),

    // Document metadata — proposed as Ignore, never written.
    item("ignore", "Electronically Signed By", "Robert James, MD", { key: "electronicallySignedBy", selected: false }),
  ];
}

const post = (base: string, body: any) =>
  fetch(`${base}/api/chat/confirm-extraction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("medical report extraction — one report, many destinations", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.trackers.length = 0;
    stubState.entries.length = 0;
    stubState.artifacts.length = 0;
    stubState.tasks.length = 0;
    stubState.events.length = 0;

    stubState.profiles.set("profile-sarah", {
      id: "profile-sarah", name: "Sarah Miller", type: "person", fields: {}, tags: [], notes: "",
    });
    stubState.profiles.set("profile-self", {
      id: "profile-self", name: "Robert", type: "self", fields: {}, tags: [], notes: "",
    });
    stubState.documents.set("doc-report", {
      id: "doc-report", name: "Riverdale Health Clinic — Annual Physical",
      type: "medical_report", mimeType: "image/png", extractedData: {}, linkedProfiles: [], tags: [],
    });

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

  const confirm = (items: ExtractionItem[]) =>
    post(base, { extractionId: "doc-report", targetProfileId: "profile-sarah", items });

  it("routes every piece of the report to its own destination", async () => {
    const res = await confirm(reportItems());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.failures).toEqual([]);

    const fields = stubState.profiles.get("profile-sarah").fields;

    // ── Profile data ──
    expect(fields.dateOfBirth).toBe("1988-03-14");
    expect(fields.gender).toBe("Female");
    expect(fields.bloodType).toBe("O+");
    expect(String(fields.height)).toContain("5 ft 7 in");
    expect(String(fields.weight)).toContain("300 lb");

    // ── Height is 67 inches, NOT 5 ──
    const height = stubState.trackers.find((t) => t.name === "Height");
    expect(height, "a Height tracker was created").toBeTruthy();
    expect(height.entries).toHaveLength(1);
    expect(height.entries[0].values.value).toBe(67);
    expect(height.unit).toBe("in");

    // ── Blood pressure is ONE reading with two components ──
    const bp = stubState.trackers.find((t) => t.name === "Blood Pressure");
    expect(bp.entries[0].values).toMatchObject({ systolic: 138, diastolic: 86 });

    // ── Every lab the old allowlist could not track now has a tracker ──
    for (const name of [
      "Weight", "BMI", "Heart Rate", "Respiratory Rate", "Temperature",
      "Oxygen Saturation", "Blood Glucose", "Creatinine", "Sodium", "Potassium",
      "Total Cholesterol", "LDL Cholesterol", "HDL Cholesterol", "Triglycerides",
      "Hemoglobin A1C", "TSH", "Vitamin D",
    ]) {
      const t = stubState.trackers.find((x) => x.name === name);
      expect(t, `${name} tracker`).toBeTruthy();
      expect(t.entries, `${name} entry`).toHaveLength(1);
      expect(t.linkedProfiles).toEqual(["profile-sarah"]);
    }

    // ── Allergies are structured records, not one concatenated string ──
    expect(fields.allergies).toEqual([
      { substance: "Penicillin", reaction: "Rash", type: "medication", source: "doc-report" },
      { substance: "Pollen", type: "environmental", source: "doc-report" },
      { substance: "Dust", type: "environmental", source: "doc-report" },
    ]);

    // ── Conditions and surgical history ──
    expect(fields.conditions.map((c: any) => c.name)).toEqual([
      "Obesity",
      "Gastroesophageal reflux disease (GERD)",
      "Mild seasonal allergic rhinitis",
      "History of vitamin D deficiency",
    ]);
    expect(fields.surgicalHistory).toEqual([
      { procedure: "Appendectomy", year: 2012, source: "doc-report" },
      { procedure: "Wisdom teeth extraction", year: 2007, source: "doc-report" },
    ]);

    // ── Medications: a record AND a tracker, and NO dose logged ──
    expect(fields.medications.map((m: any) => m.name)).toEqual([
      "Cetirizine", "Omeprazole", "Vitamin D3", "Multivitamin",
    ]);
    expect(fields.medications[0]).toMatchObject({ dose: "10 mg", asNeeded: true });
    for (const drug of ["Cetirizine", "Omeprazole", "Multivitamin"]) {
      const t = stubState.trackers.find((x) => x.name === drug);
      expect(t, `${drug} tracker`).toBeTruthy();
      expect(t.category).toBe("medication");
      // The report says she is PRESCRIBED it. It does not say she took one today.
      expect(t.entries, `${drug} must have no dose entry`).toHaveLength(0);
    }
    // No medication entry reached the ledger at all.
    expect(stubState.entries.some((e) => /adherence|taken/.test(JSON.stringify(e.values)))).toBe(false);

    // ── The narrative is a note, attached to Sarah ──
    const notes = stubState.artifacts.filter((a) => a.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Physical Examination Summary");
    expect(notes[0].content).toContain("Lungs clear bilaterally");
    expect(notes[0].linkedProfiles).toEqual(["profile-sarah"]);

    // ── Follow-ups ──
    expect(stubState.tasks).toHaveLength(1);
    expect(stubState.tasks[0]).toMatchObject({ title: "Repeat labs", dueDate: "2027-02-25" });
    expect(stubState.tasks[0].linkedProfiles).toEqual(["profile-sarah"]);
    expect(stubState.events.map((e: any) => e.date)).toContain("2027-08-25");

    // ── The ignored row went nowhere ──
    expect(fields.electronicallySignedBy).toBeUndefined();
    expect(data.skipped).toContain("Electronically Signed By");
  });

  it("appends to the tracker the user already has instead of minting a twin", async () => {
    // Sarah already logs her weight under a different wording. The old lookup
    // compared lowercased-and-space-stripped names, so "Weight" and "Body
    // Weight" were unequal and the document created a second tracker.
    stubState.trackers.push({
      id: "trk-existing", name: "Body Weight", unit: "lbs", category: "health",
      fields: [{ name: "value", type: "number", unit: "lbs", isPrimary: true }],
      entries: [], linkedProfiles: ["profile-sarah"],
    });
    expect(trackerNamesMatch("Body Weight", "Weight")).toBe(true);

    await confirm(reportItems());

    const weightTrackers = stubState.trackers.filter((t) => /weight/i.test(t.name));
    expect(weightTrackers.map((t) => t.name)).toEqual(["Body Weight"]);
    expect(weightTrackers[0].entries).toHaveLength(1);
    expect(weightTrackers[0].entries[0].values.value).toBe(300);
  });

  it("never adopts a tracker that belongs to somebody else", async () => {
    stubState.trackers.push({
      id: "trk-roberts", name: "Weight", unit: "lbs", category: "health",
      fields: [{ name: "value", type: "number", unit: "lbs", isPrimary: true }],
      entries: [], linkedProfiles: ["profile-self"],
    });

    await confirm(reportItems().filter((i) => i.label === "Weight"));

    const roberts = stubState.trackers.find((t) => t.id === "trk-roberts");
    expect(roberts.entries, "Robert's tracker is untouched").toHaveLength(0);
    const sarahs = stubState.trackers.find((t) => t.id !== "trk-roberts" && /weight/i.test(t.name));
    expect(sarahs.linkedProfiles).toEqual(["profile-sarah"]);
    expect(sarahs.entries[0].values.value).toBe(300);
  });

  it("obeys a destination the user changed", async () => {
    // The user decides the blood type reads better as a note.
    const items = reportItems().map((i) =>
      i.label === "Blood Type" ? { ...i, destination: "note" as ExtractionDestination } : i,
    );
    await confirm(items);

    const fields = stubState.profiles.get("profile-sarah").fields;
    expect(fields.bloodType, "the user moved it off the profile").toBeUndefined();
    expect(stubState.artifacts.some((a) => a.content === "O+")).toBe(true);
  });

  it("writes nothing for a row the user unticked", async () => {
    const items = reportItems().map((i) =>
      i.label === "Penicillin" ? { ...i, selected: false } : i,
    );
    await confirm(items);

    const fields = stubState.profiles.get("profile-sarah").fields;
    expect(fields.allergies.map((a: any) => a.substance)).toEqual(["Pollen", "Dust"]);
  });

  it("is idempotent — uploading the same report twice changes nothing", async () => {
    await confirm(reportItems());
    const trackersAfterFirst = stubState.trackers.length;
    const entriesAfterFirst = stubState.entries.length;

    await confirm(reportItems());

    expect(stubState.trackers).toHaveLength(trackersAfterFirst);
    const fields = stubState.profiles.get("profile-sarah").fields;
    expect(fields.allergies).toHaveLength(3);
    expect(fields.medications).toHaveLength(4);
    expect(fields.conditions).toHaveLength(4);
    expect(fields.surgicalHistory).toHaveLength(2);
    // The narrative is one note, not two.
    expect(stubState.artifacts.filter((a) => a.type === "note")).toHaveLength(1);
    // A second reading on the same day IS a second entry — that is a real
    // measurement, not a duplicate record — so entries grow while records do not.
    expect(stubState.entries.length).toBeGreaterThanOrEqual(entriesAfterFirst);
  });

  it("keeps the legacy free-text allergies a user typed before the arrays existed", async () => {
    stubState.profiles.get("profile-sarah").fields.allergies = "Shellfish, Latex";

    await confirm(reportItems().filter((i) => i.destination === "allergy"));

    const fields = stubState.profiles.get("profile-sarah").fields;
    expect(fields.allergies.map((a: any) => a.substance)).toEqual([
      "Shellfish", "Latex", "Penicillin", "Pollen", "Dust",
    ]);
  });
});

describe("secondary characteristics — the profile half of a measurement", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.trackers.length = 0;
    stubState.entries.length = 0;
    stubState.profiles.set("profile-sarah", {
      id: "profile-sarah", name: "Sarah Miller", type: "person", fields: {}, tags: [], notes: "",
    });
    stubState.documents.set("doc-report", {
      id: "doc-report", name: "report", type: "medical_report", mimeType: "image/png",
      extractedData: {}, linkedProfiles: [], tags: [],
    });
    const app = express();
    app.use(express.json());
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("writes weight to the profile even when it arrived only as a tracker row", async () => {
    // shared/estimation-engine sizes a person's calorie estimate from
    // fields.weight on THAT profile. A weight that reaches only the tracker
    // leaves the estimate on a population default.
    itemSeq = 0;
    const weightRow = item("profile_tracker", "Weight", "300 lbs", {
      key: "weight", source: "tracker", trackerName: "Weight",
      values: { value: 300 }, unit: "lbs", category: "health",
    });
    const res = await post(base, {
      extractionId: "doc-report", targetProfileId: "profile-sarah", items: [weightRow],
    });
    expect(res.status).toBe(200);

    const fields = stubState.profiles.get("profile-sarah").fields;
    expect(fields.weight).toBe("300 lbs");
    expect(stubState.trackers.find((t) => t.name === "Weight").entries[0].values.value).toBe(300);
  });
});

// ── The merge point (2026-08-25) ────────────────────────────────────────────
// Two extraction features landed within hours of each other: the destination
// review list (`items`, each row saying where it goes) and the Calendar section
// (`calendarDates`, one add-or-not decision per recognised date). Both can carry
// the SAME date to the confirm route on one request. The route folds them into a
// single candidate list deduped on the normalized field key — this pins that,
// because the failure mode is silent: two calendar events for one printed date.
describe("items and calendarDates carrying one date", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.events.length = 0;
    stubState.trackers.length = 0;
    stubState.entries.length = 0;
    stubState.profiles.set("profile-sarah", {
      id: "profile-sarah", name: "Sarah Miller", type: "person", fields: {}, tags: [], notes: "",
    });
    stubState.documents.set("doc-report", {
      id: "doc-report", name: "report", type: "medical_report", mimeType: "image/png",
      extractedData: {}, linkedProfiles: [], tags: [],
    });
    const app = express();
    app.use(express.json());
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("creates ONE event when both payloads carry the same date", async () => {
    itemSeq = 0;
    const res = await post(base, {
      extractionId: "doc-report",
      targetProfileId: "profile-sarah",
      items: [
        item("calendar", "House Viewing", "2027-03-01", {
          key: "houseViewing", source: "followup", date: "2027-03-01",
          payload: { title: "House Viewing", date: "2027-03-01" },
        }),
      ],
      calendarDates: [
        { field: "houseViewing", date: "2027-03-01", title: "House Viewing", addToCalendar: true, derived: false },
      ],
    });
    expect(res.status).toBe(200);

    const forThatDay = stubState.events.filter((e: any) => e.date === "2027-03-01");
    expect(forThatDay, "one printed date is one event").toHaveLength(1);
  });

  it("still creates the event when only the review list carries it", async () => {
    itemSeq = 0;
    await post(base, {
      extractionId: "doc-report",
      targetProfileId: "profile-sarah",
      items: [
        item("calendar", "House Viewing", "2027-03-01", {
          key: "houseViewing", source: "followup", date: "2027-03-01",
          payload: { title: "House Viewing", date: "2027-03-01" },
        }),
      ],
    });
    expect(stubState.events.filter((e: any) => e.date === "2027-03-01")).toHaveLength(1);
  });

  it("creates nothing for a date the user unticked in the Calendar section", async () => {
    itemSeq = 0;
    await post(base, {
      extractionId: "doc-report",
      targetProfileId: "profile-sarah",
      items: [],
      calendarDates: [
        { field: "houseViewing", date: "2027-03-01", title: "House Viewing", addToCalendar: false, derived: false },
      ],
    });
    expect(stubState.events.filter((e: any) => e.date === "2027-03-01")).toHaveLength(0);
  });
});
