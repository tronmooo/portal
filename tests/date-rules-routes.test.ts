// tests/date-rules-routes.test.ts
//
// The Date Rule work through the REAL Express app.
//
// tests/date-rules.test.ts proves the engine is right and
// tests/date-rules-persistence.test.ts proves storage keeps what the engine can
// read. Neither proves the ROUTES do the right thing — and the routes are where
// the reported bug actually lived: confirm-extraction saved a printed date
// verbatim and then wrote a standalone event beside it, and the document delete
// left that event behind.
//
// So these boot server/routes.ts (tests/helpers/route-harness) and speak HTTP.

import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";

const YEAR = new Date().getFullYear();
const RANGE = `start=${YEAR}-01-01&end=${YEAR + 20}-12-31`;

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const JANE = { id: "jane-1", name: "Jane Doe", type: "person", fields: {}, tags: [], documents: [] };

async function boot(seed: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness({ profiles: [JSON.parse(JSON.stringify(JANE))], ...seed });
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/chat/confirm-extraction", () => {
  const licenceDoc = () => ({
    id: "doc-1", name: "Sample Driver License", type: "drivers_license",
    mimeType: "image/jpeg", fileData: "", extractedData: {}, linkedProfiles: ["jane-1"], tags: [],
  });

  it("stores the printed dates in the one form every reader can parse", async () => {
    const { api, db } = await boot({ documents: [licenceDoc()] });
    const r = await api("POST", "/api/chat/confirm-extraction", {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [
        { key: "dateOfBirth", value: "07/10/1994" },
        { key: "expiration_date", value: "07/18/2034" },
        { key: "licenseNumber", value: "D1234567" },
      ],
    });
    expect(r.status).toBe(200);

    // On the document — its own dates.
    expect(db.documents[0].extractedData.expiration_date).toBe("2034-07-18");
    // Not a date, untouched.
    expect(db.documents[0].extractedData.licenseNumber).toBe("D1234567");
    // On the person — the date the person owns. The routing writes both
    // spellings and retires one so the profile does not show the date twice;
    // the rule engine reads whichever survives.
    expect(db.profiles[0].fields.birthday).toBe("1994-07-10");
    // …and saying so is not reported as a failure (it used to be).
    expect(r.data.success).toBe(true);
    expect(r.data.failures).toEqual([]);
  });

  it("does not write a standalone event for a date the record owns", async () => {
    const { api, db } = await boot({ documents: [licenceDoc()] });
    await api("POST", "/api/chat/confirm-extraction", {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [{ key: "expiration_date", value: "07/18/2034" }],
      // Exactly what the review UI used to send for an expiration.
      createCalendarEvents: [
        { field: "expiration_date", date: "07/18/2034", title: "⚠️ Expiration Date", category: "finance" },
      ],
    });
    // The copy that used to drift from the field and outlive the document.
    expect(db.events).toHaveLength(0);
  });

  it("still writes an event for a date nothing else can carry", async () => {
    const { api, db } = await boot({ documents: [licenceDoc()] });
    await api("POST", "/api/chat/confirm-extraction", {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [{ key: "openHouse", value: "2026-09-02" }],
      createCalendarEvents: [
        { field: "openHouse", date: "2026-09-02", title: "House Viewing", category: "other" },
      ],
    });
    expect(db.events).toHaveLength(1);
    expect(db.events[0].title).toBe("House Viewing");
  });

  it("puts both extracted dates on the calendar, each exactly once", async () => {
    const { api } = await boot({ documents: [licenceDoc()] });
    await api("POST", "/api/chat/confirm-extraction", {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [
        { key: "dateOfBirth", value: "07/10/1994" },
        { key: "expiration_date", value: "07/18/2034" },
        { key: "issueDate", value: "07/18/2026" },
      ],
    });
    const cal = await api("GET", `/api/calendar/timeline?${RANGE}`);
    expect(cal.status).toBe(200);
    const titles = cal.data.map((i: any) => i.title);
    expect(titles).toContain("Jane Doe's Birthday");
    expect(titles.filter((t: string) => t === "Sample Driver License — Expiration")).toHaveLength(1);
    // Metadata stays off the calendar.
    expect(titles.some((t: string) => /issue/i.test(t))).toBe(false);
  });

  it("run twice, changes nothing and duplicates nothing", async () => {
    const { api, db } = await boot({ documents: [licenceDoc()] });
    const body = {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [{ key: "expiration_date", value: "07/18/2034" }],
    };
    await api("POST", "/api/chat/confirm-extraction", body);
    const first = await api("GET", `/api/date-rules`);
    await api("POST", "/api/chat/confirm-extraction", body);
    const second = await api("GET", `/api/date-rules`);

    expect(second.data.map((r: any) => r.id)).toEqual(first.data.map((r: any) => r.id));
    expect(db.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/date-rules", () => {
  it("answers with the rules, traceable to the field they came from", async () => {
    const { api } = await boot({
      profiles: [{ ...JANE, fields: { dateOfBirth: "1994-07-10" } }],
      documents: [{
        id: "doc-1", name: "Sample Driver License", type: "drivers_license",
        extractedData: { expiration_date: "2034-07-18" }, linkedProfiles: ["jane-1"], tags: [],
      }],
    });
    const r = await api("GET", "/api/date-rules");
    expect(r.status).toBe(200);

    const birthday = r.data.find((x: any) => x.ruleType === "birthday");
    expect(birthday).toMatchObject({
      id: "profile:jane-1:dateofbirth:birthday",
      occurrenceType: "recurring", recurrence: "yearly",
      sourceEntityType: "profile", sourceEntityId: "jane-1", sourceField: "dateOfBirth",
      date: "1994-07-10", countdownEnabled: false,
    });

    const expiration = r.data.find((x: any) => x.ruleType === "expiration");
    expect(expiration).toMatchObject({
      id: "document:doc-1:expirationdate:expiration",
      // The distinction the whole exercise turns on.
      occurrenceType: "one_time", recurrence: "none",
      ruleSubtype: "drivers_license",
      sourceEntityType: "document", sourceEntityId: "doc-1", sourceField: "expiration_date",
      date: "2034-07-18", countdownEnabled: true, importantVisible: true,
    });
  });

  it("scopes to the requested profiles", async () => {
    const { api } = await boot({
      profiles: [
        { ...JANE, fields: { dateOfBirth: "1994-07-10" } },
        { id: "bob-1", name: "Bob", type: "person", fields: { dateOfBirth: "1980-02-02" }, tags: [], documents: [] },
      ],
    });
    const r = await api("GET", "/api/date-rules?profileIds=bob-1");
    expect(r.data.map((x: any) => x.sourceEntityId)).toEqual(["bob-1"]);
  });

  it("returns an empty list rather than an error for an empty account", async () => {
    const { api } = await boot({ profiles: [] });
    const r = await api("GET", "/api/date-rules");
    expect(r.status).toBe(200);
    expect(r.data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/profiles/:id", () => {
  it("normalizes a hand-typed date, so manual entry matches every other door", async () => {
    const { api, db } = await boot();
    const r = await api("PATCH", "/api/profiles/jane-1", {
      fields: { dateOfBirth: "7/10/1994", passportExpiration: "March 2, 2030" },
    });
    expect(r.status).toBe(200);
    expect(db.profiles[0].fields.dateOfBirth).toBe("1994-07-10");
    expect(db.profiles[0].fields.passportExpiration).toBe("2030-03-02");
  });

  it("moves the birthday everywhere when the DOB is corrected", async () => {
    const { api } = await boot();
    await api("PATCH", "/api/profiles/jane-1", { fields: { dateOfBirth: "1994-07-10" } });
    await api("PATCH", "/api/profiles/jane-1", { fields: { dateOfBirth: "1994-07-11" } });

    const rules = await api("GET", "/api/date-rules");
    const birthdays = rules.data.filter((x: any) => x.ruleType === "birthday");
    expect(birthdays).toHaveLength(1);          // moved, not duplicated
    expect(birthdays[0].date).toBe("1994-07-11");

    const cal = await api("GET", `/api/calendar/timeline?${RANGE}`);
    const days = new Set(cal.data.filter((i: any) => i.title === "Jane Doe's Birthday")
      .map((i: any) => i.date.slice(5)));
    expect(days).toEqual(new Set(["07-11"]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/documents/:id", () => {
  it("takes the derived date and the legacy copy of it with the document", async () => {
    const { api, db } = await boot({
      documents: [{
        id: "doc-1", name: "Sample Driver License", type: "drivers_license",
        extractedData: { expiration_date: "2034-07-18" }, linkedProfiles: ["jane-1"], tags: [],
      }],
      // The standalone event an older extraction wrote beside the field.
      events: [{
        id: "ev-legacy", title: "⚠️ Expiration Date", date: "2034-07-18",
        recurrence: "none", linkedProfiles: ["jane-1"], linkedDocuments: ["doc-1"],
        tags: ["document-extraction"],
      }],
    });

    const before = await api("GET", `/api/calendar/timeline?${RANGE}`);
    expect(before.data.map((i: any) => i.title)).toContain("Sample Driver License — Expiration");

    const del = await api("DELETE", "/api/documents/doc-1");
    expect(del.status).toBe(200);

    expect(db.documents).toHaveLength(0);
    // No orphan left on the calendar, from either system.
    expect(db.events).toHaveLength(0);
    const after = await api("GET", `/api/calendar/timeline?${RANGE}`);
    expect(after.data).toHaveLength(0);
    const rules = await api("GET", "/api/date-rules");
    expect(rules.data).toEqual([]);
  });

  it("leaves an event the user made themselves alone", async () => {
    const { api, db } = await boot({
      documents: [{ id: "doc-1", name: "License", type: "drivers_license", extractedData: {}, linkedProfiles: [], tags: [] }],
      events: [{
        id: "ev-mine", title: "Renew my licence at the DMV", date: "2034-06-01",
        recurrence: "none", linkedProfiles: ["jane-1"], linkedDocuments: ["doc-1"], tags: [],
      }],
    });
    await api("DELETE", "/api/documents/doc-1");
    // Linked to the document, but not written by the extractor — not ours to delete.
    expect(db.events.map((e: any) => e.id)).toEqual(["ev-mine"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("dates already past are still on the calendar", () => {
  it("shows an expiration that has already come and gone", async () => {
    // Generating from today with no lookback returned nothing for these, so an
    // expired licence and a lease that ended left a month the user was looking
    // at — the pass this replaced rendered anything inside the range.
    const { api } = await boot({
      documents: [{
        id: "doc-old", name: "Old License", type: "drivers_license",
        extractedData: { expiration_date: `${YEAR - 1}-02-02` }, linkedProfiles: ["jane-1"], tags: [],
      }],
    });
    const cal = await api("GET", `/api/calendar/timeline?start=${YEAR - 2}-01-01&end=${YEAR + 5}-12-31`);
    const hit = cal.data.find((i: any) => i.title === "Old License — Expiration");
    expect(hit).toBeTruthy();
    expect(hit.date).toBe(`${YEAR - 1}-02-02`);
  });

  it("shows a birthday earlier in the current year", async () => {
    const { api } = await boot({
      profiles: [{ ...JANE, fields: { dateOfBirth: "1994-01-05" } }],
    });
    const cal = await api("GET", `/api/calendar/timeline?start=${YEAR}-01-01&end=${YEAR}-12-31`);
    expect(cal.data.map((i: any) => i.date)).toContain(`${YEAR}-01-05`);
  });
});

describe("GET /api/date-rules does not double-count a legacy copy", () => {
  it("returns one rule for a date that also has an extraction event beside it", async () => {
    const { api } = await boot({
      documents: [{
        id: "doc-1", name: "Sample Driver License", type: "drivers_license",
        extractedData: { expiration_date: "2034-07-18" }, linkedProfiles: ["jane-1"], tags: [],
      }],
      events: [{
        id: "ev-legacy", title: "⚠️ Expiration Date", date: "2034-07-18",
        recurrence: "none", linkedProfiles: ["jane-1"], linkedDocuments: ["doc-1"],
        tags: ["document-extraction"],
      }],
    });
    const r = await api("GET", "/api/date-rules");
    const onThatDay = r.data.filter((x: any) => x.date === "2034-07-18");
    expect(onThatDay).toHaveLength(1);
    expect(onThatDay[0].sourceEntityType).toBe("document");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("shadowing a legacy copy does not sweep away a real event", () => {
  it("keeps an extraction event for a date no rule covers", async () => {
    const { api } = await boot({
      documents: [{
        id: "doc-1", name: "Sample Driver License", type: "drivers_license",
        extractedData: { expiration_date: "2034-07-18" }, linkedProfiles: ["jane-1"], tags: [],
      }],
      events: [
        // A copy of the expiration — same document, SAME DAY. A shadow.
        { id: "ev-copy", title: "⚠️ Expiration Date", date: "2034-07-18", recurrence: "none",
          linkedProfiles: ["jane-1"], linkedDocuments: ["doc-1"], tags: ["document-extraction"] },
        // A real date the extractor found on the same document that no rule
        // covers — routes.ts deliberately still creates these.
        { id: "ev-real", title: "House Viewing", date: `${YEAR}-09-02`, recurrence: "none",
          linkedProfiles: ["jane-1"], linkedDocuments: ["doc-1"], tags: ["document-extraction"] },
      ],
    });
    const titles = (await api("GET", `/api/calendar/timeline?${RANGE}`)).data.map((i: any) => i.title);
    expect(titles).toContain("House Viewing");
    expect(titles).toContain("Sample Driver License — Expiration");
    expect(titles).not.toContain("⚠️ Expiration Date");
  });
});

describe("a nested record's dates stay in scope with its owner", () => {
  it("keeps a vehicle's warranty when filtering by the person it belongs to", async () => {
    // The virtual-event ladder this replaced scoped on (profile, parent); the
    // replacement matched the child id alone, so a subscription or vehicle
    // nested under a person lost its dates the moment that person was selected.
    const { api } = await boot({
      profiles: [
        { id: "jane-1", name: "Jane Doe", type: "self", fields: {}, tags: [], documents: [] },
        { id: "car-1", name: "Honda", type: "vehicle", parentProfileId: "jane-1",
          fields: { warrantyExpiration: `${YEAR + 2}-05-01` }, tags: [], documents: [] },
      ],
    });
    const scoped = await api("GET", `/api/calendar/timeline?${RANGE}&profileIds=jane-1`);
    expect(scoped.data.map((i: any) => i.title)).toContain("Honda — Warranty Expiration");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a date ticked for the calendar alone is not dropped", () => {
  it("creates the event when no field behind it was saved", async () => {
    // createCalendarEvents arrives independently of confirmedFields. Skipping
    // on classification alone dropped the date entirely while the response
    // still reported success.
    const { api, db } = await boot({
      documents: [{ id: "doc-1", name: "Policy", type: "insurance", extractedData: {}, linkedProfiles: ["jane-1"], tags: [] }],
    });
    await api("POST", "/api/chat/confirm-extraction", {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [],
      createCalendarEvents: [
        { field: "renewalDate", date: "2027-04-01", title: "Policy renewal", category: "finance" },
      ],
    });
    expect(db.events.map((e: any) => e.title)).toEqual(["Policy renewal"]);
  });

  it("still skips it when the field IS being saved and will be derived", async () => {
    const { api, db } = await boot({
      documents: [{ id: "doc-1", name: "Policy", type: "insurance", extractedData: {}, linkedProfiles: ["jane-1"], tags: [] }],
    });
    await api("POST", "/api/chat/confirm-extraction", {
      extractionId: "doc-1",
      targetProfileId: "jane-1",
      confirmedFields: [{ key: "renewalDate", value: "2027-04-01" }],
      createCalendarEvents: [
        { field: "renewalDate", date: "2027-04-01", title: "Policy renewal", category: "finance" },
      ],
    });
    expect(db.events).toHaveLength(0);
    const titles = (await api("GET", `/api/calendar/timeline?${RANGE}`)).data.map((i: any) => i.title);
    expect(titles).toContain("Policy — Renewal");
  });
});
