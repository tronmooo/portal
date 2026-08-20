// tests/date-rules-persistence.test.ts
//
// The pure-engine contract lives in tests/date-rules.test.ts. This file asks
// the harder question the user insisted on: does it hold through the actual
// PERSISTENCE layer — write a row, read it back through the real storage
// methods the routes call, and check what the calendar and the dashboard
// actually return.
//
// MemStorage is exercised rather than mocked. Its getCalendarTimeline and
// getDashboardEnhanced now run the same Date Rule pass SupabaseStorage does
// (that parity is itself the point — this storage previously derived no
// profile or document dates at all, so a test here could pass while production
// showed nothing).

import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { normalizeEntityDateFields } from "../shared/date-rules";
import { canonicalizeProfileFields } from "../shared/profile-field-canon";

const YEAR = new Date().getFullYear();
const WINDOW_START = `${YEAR}-01-01`;
const WINDOW_END = `${YEAR + 20}-12-31`;

let storage: MemStorage;
let janeId: string;

/** What POST/PATCH /api/profiles does to `fields` before storage sees them. */
const asManualEntry = (fields: Record<string, any>) => normalizeEntityDateFields(fields).fields;
/** What confirm-extraction and the chat tools do to `fields`. */
const asExtraction = (fields: Record<string, any>, existing?: Record<string, any>) =>
  canonicalizeProfileFields(fields, existing).fields;

beforeEach(async () => {
  storage = new MemStorage();
  const jane = await storage.createProfile({ name: "Jane Doe", type: "person" } as any);
  janeId = jane.id;
});

async function timelineTitles(): Promise<string[]> {
  const items = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
  return items.map((i: any) => i.title);
}

describe("a licence, from upload to deletion, through storage", () => {
  const licence = (expiration: string) => ({
    name: "Sample Driver License",
    type: "drivers_license",
    mimeType: "image/jpeg",
    fileData: "",
    extractedData: normalizeEntityDateFields(
      { expiration_date: expiration, issueDate: "07/18/2026", licenseNumber: "D1234567" },
      { contextKey: "drivers_license" },
    ).fields,
    linkedProfiles: [janeId],
    tags: [],
  });

  it("stores the printed date in canonical form", async () => {
    const doc = await storage.createDocument(licence("07/18/2034"));
    const back = await storage.getDocument(doc.id);
    expect(back!.extractedData.expiration_date).toBe("2034-07-18");
    // Not a date, not touched.
    expect(back!.extractedData.licenseNumber).toBe("D1234567");
  });

  it("puts the expiration on the calendar and leaves the issue date off it", async () => {
    await storage.createDocument(licence("07/18/2034"));
    const titles = await timelineTitles();
    expect(titles).toContain("Sample Driver License — Expiration");
    expect(titles.some(t => /issue/i.test(t))).toBe(false);
  });

  it("shows it exactly once, on its real day", async () => {
    await storage.createDocument(licence("07/18/2034"));
    const items = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
    const hits = items.filter((i: any) => i.title === "Sample Driver License — Expiration");
    expect(hits).toHaveLength(1);
    expect(hits[0].date).toBe("2034-07-18");
    // Traceable back to the rule, and through it to the document + field.
    expect((hits[0] as any).meta.ruleId).toBe("document:" + hits[0].sourceId + ":expirationdate:expiration");
  });

  it("moves every view when the expiration is edited, without duplicating", async () => {
    const doc = await storage.createDocument(licence("07/18/2034"));
    await storage.updateDocument(doc.id, {
      extractedData: { ...(await storage.getDocument(doc.id))!.extractedData, expiration_date: "2036-07-18" },
    });
    const items = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
    const hits = items.filter((i: any) => i.title === "Sample Driver License — Expiration");
    expect(hits).toHaveLength(1);
    expect(hits[0].date).toBe("2036-07-18");
  });

  it("leaves nothing behind when the document is deleted", async () => {
    const doc = await storage.createDocument(licence("07/18/2034"));
    expect(await timelineTitles()).toContain("Sample Driver License — Expiration");
    await storage.deleteDocument(doc.id);
    expect(await timelineTitles()).not.toContain("Sample Driver License — Expiration");
  });

  it("surfaces it on the dashboard's expirations with a live day count", async () => {
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await storage.createDocument(licence(soon));
    const enhanced: any = await storage.getDashboardEnhanced();
    const row = (enhanced.expiringDocuments || [])
      .find((d: any) => d.fieldName === "expiration_date");
    expect(row).toBeTruthy();
    expect(row.expirationDate).toBe(soon);
    expect(row.daysUntil).toBe(20);
    expect(row.status).toBe("expiring_soon");
  });
});

describe("a date of birth, through storage", () => {
  it("produces a yearly birthday on the calendar", async () => {
    await storage.updateProfile(janeId, { fields: asExtraction({ dateOfBirth: "07/10/1994", birthday: "07/10/1994" }) } as any);
    const items = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
    const birthdays = items.filter((i: any) => i.title === "Jane Doe's Birthday");
    expect(birthdays.length).toBeGreaterThanOrEqual(5);
    // Once per year, always on July 10, and never twice in one year.
    expect(new Set(birthdays.map((b: any) => b.date.slice(5)))).toEqual(new Set(["07-10"]));
    expect(new Set(birthdays.map((b: any) => b.date)).size).toBe(birthdays.length);
  });

  it("moves the recurrence when the DOB is corrected", async () => {
    await storage.updateProfile(janeId, { fields: asExtraction({ dateOfBirth: "1994-07-10" }) } as any);
    const existing = (await storage.getProfile(janeId))!.fields as any;
    await storage.updateProfile(janeId, { fields: asExtraction({ dateOfBirth: "1994-07-11" }, existing) } as any);
    const items = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
    const days = new Set(items.filter((i: any) => i.title === "Jane Doe's Birthday").map((b: any) => b.date.slice(5)));
    expect(days).toEqual(new Set(["07-11"]));
  });

  it("gives the same calendar whether the DOB came from a form or an extraction", async () => {
    await storage.updateProfile(janeId, { fields: asManualEntry({ dateOfBirth: "7/10/1994" }) } as any);
    const manual = (await storage.getCalendarTimeline(WINDOW_START, WINDOW_END))
      .filter((i: any) => i.title === "Jane Doe's Birthday").map((i: any) => i.date);

    const other = new MemStorage();
    const jane2 = await other.createProfile({ name: "Jane Doe", type: "person" } as any);
    await other.updateProfile(jane2.id, { fields: asExtraction({ dateOfBirth: "07/10/1994", birthday: "07/10/1994" }) } as any);
    const extracted = (await other.getCalendarTimeline(WINDOW_START, WINDOW_END))
      .filter((i: any) => i.title === "Jane Doe's Birthday").map((i: any) => i.date);

    expect(extracted).toEqual(manual);
    expect(manual.length).toBeGreaterThan(0);
  });
});

describe("the two halves of the same account do not collide", () => {
  it("keeps the birthday when only the licence is deleted", async () => {
    await storage.updateProfile(janeId, { fields: asExtraction({ dateOfBirth: "1994-07-10" }) } as any);
    const doc = await storage.createDocument({
      name: "License", type: "drivers_license", mimeType: "image/jpeg", fileData: "",
      extractedData: { expiration_date: "2034-07-18" }, linkedProfiles: [janeId], tags: [],
    } as any);
    await storage.deleteDocument(doc.id);
    const titles = await timelineTitles();
    expect(titles).toContain("Jane Doe's Birthday");
    expect(titles).not.toContain("License — Expiration");
  });

  it("does not leak one profile's dates into another", async () => {
    const bob = await storage.createProfile({ name: "Bob", type: "person" } as any);
    await storage.updateProfile(janeId, { fields: asExtraction({ dateOfBirth: "1994-07-10" }) } as any);
    const items = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
    const birthday = items.find((i: any) => i.title === "Jane Doe's Birthday")!;
    expect(birthday.linkedProfiles).toEqual([janeId]);
    expect(birthday.linkedProfiles).not.toContain(bob.id);
  });
});

describe("no write path can save an actionable date in a form the rules cannot read", () => {
  // The routes and the AI tools normalize before calling storage. This asks
  // whether a caller that skipped all of them — a script, a migration, a tool
  // added next month — could still get a raw date into the database.
  it("normalizes a profile date even when the caller did not", async () => {
    const p = await storage.createProfile({
      name: "Raw Writer", type: "person", fields: { dateOfBirth: "07/10/1994" },
    } as any);
    expect((await storage.getProfile(p.id))!.fields.dateOfBirth).toBe("1994-07-10");

    await storage.updateProfile(p.id, { fields: { passportExpiration: "3/2/2030" } } as any);
    expect((await storage.getProfile(p.id))!.fields.passportExpiration).toBe("2030-03-02");
  });

  it("normalizes a document date even when the caller did not", async () => {
    const d = await storage.createDocument({
      name: "Passport", type: "passport", mimeType: "image/jpeg", fileData: "",
      extractedData: { expiration_date: "March 2, 2030" }, linkedProfiles: [janeId], tags: [],
    } as any);
    expect((await storage.getDocument(d.id))!.extractedData.expiration_date).toBe("2030-03-02");

    await storage.updateDocument(d.id, { extractedData: { expiration_date: "3/2/2032" } } as any);
    expect((await storage.getDocument(d.id))!.extractedData.expiration_date).toBe("2032-03-02");
  });

  it("puts the raw-written dates on the calendar like any other", async () => {
    await storage.createProfile({ name: "Raw Writer", type: "person", fields: { dateOfBirth: "07/10/1994" } } as any);
    expect(await timelineTitles()).toContain("Raw Writer's Birthday");
  });
});

describe("the dashboard's expirations link to the record that holds them", () => {
  it("sends a document expiration to the document", async () => {
    await storage.createDocument({
      name: "Passport", type: "passport", mimeType: "image/jpeg", fileData: "",
      extractedData: { expiration_date: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10) },
      linkedProfiles: [janeId], tags: [],
    } as any);
    const enhanced: any = await storage.getDashboardEnhanced();
    const row = enhanced.expiringDocuments.find((d: any) => d.sourceEntityType === "document");
    expect(row.href).toMatch(/^#\/documents\//);
  });

  it("sends a profile-carried expiration to the profile, not to a document id", async () => {
    // A passport expiration typed onto a person. `/documents/<profileId>` is
    // not a page, and this row used to be built with exactly that link.
    await storage.updateProfile(janeId, {
      fields: { passportExpiration: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10) },
    } as any);
    const enhanced: any = await storage.getDashboardEnhanced();
    const row = enhanced.expiringDocuments.find((d: any) => d.sourceEntityType === "profile");
    expect(row).toBeTruthy();
    expect(row.href).toBe(`#/profiles/${janeId}`);
    expect(row.relatedProfileId).toBe(janeId);
  });
});

describe("a liability whose payment date is spelled nextPayment", () => {
  it("still lands on the calendar", async () => {
    // This spelling used to be reached only by the server timeline's per-type
    // virtual-event ladder, which the Date Rule pass replaced.
    const soon = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
    await storage.createProfile({
      name: "Car Loan", type: "liability", parentProfileId: janeId,
      fields: { nextPayment: soon, monthlyPayment: 415, frequency: "monthly" },
    } as any);
    const { seriesFromAll } = await import("../shared/calendar-adapters");
    const series = seriesFromAll({ profiles: await storage.getProfiles() });
    const payment = series.find((s: any) => s.source.system === "liability");
    expect(payment).toBeTruthy();
    expect(payment!.baseDate).toBe(soon);
  });
});

describe("a typed-in birthday does not render beside the profile's", () => {
  it("suppresses the event copy, in this storage as in the other", async () => {
    await storage.updateProfile(janeId, { fields: { dateOfBirth: "1994-07-10" } } as any);
    await storage.createEvent({
      title: "Jane Doe's Birthday", date: "2026-07-10", recurrence: "yearly",
      linkedProfiles: [janeId], category: "family", tags: ["rdate", "rd:kind:birthday"],
    } as any);
    const titles = await timelineTitles();
    // One birthday per year, from the profile — not two.
    const inThisYear = (await storage.getCalendarTimeline(`${YEAR}-01-01`, `${YEAR}-12-31`))
      .filter((i: any) => /birthday/i.test(i.title));
    expect(inThisYear).toHaveLength(1);
    expect(titles).toContain("Jane Doe's Birthday");
  });
});

describe("removing one date leaves the record whole", () => {
  it("clears exactly that field, in this storage as in the other", async () => {
    // MemStorage ignored the delete hints entirely, so the calendar's "remove
    // this date" was a no-op here AND the hint arrays were spread onto the
    // profile as if they were data.
    await storage.updateProfile(janeId, {
      fields: { dateOfBirth: "1994-07-10", passportExpiration: "2030-03-02" },
    } as any);
    await storage.updateProfile(janeId, { fieldPathsToDelete: ["passportExpiration"] } as any);

    const after = (await storage.getProfile(janeId))!.fields as any;
    expect(after.passportExpiration).toBeUndefined();
    expect(after.dateOfBirth).toBe("1994-07-10");
    expect(after.fieldPathsToDelete).toBeUndefined();
    expect(await timelineTitles()).toContain("Jane Doe's Birthday");
  });
});
