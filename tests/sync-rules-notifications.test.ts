// BANK-STATEMENT NOTIFICATION REGRESSION (user report 2026-10-09: "I uploaded
// the bank statement however the notification is still there").
//
// The account's only bank statement carried `statementPeriod: { endDate:
// "2024-04-30" }`. The date engine read the leaf `endDate` as an "end" rule —
// "Bank Statement — expired 892 days ago" in the bell and "1 expired" on the
// Documents card — and no action could ever satisfy it: the "expiry" was the
// last day of April 2024. Rule 5 says an alert must resolve once its
// requirement is met, and must be derived from the record, not a stored flag.
//
// Two generic rules, tested here against the real notification builder and
// the real Executive Documents card (MemStorage):
//   1. a reporting period's boundaries are history, never an alert;
//   2. a newer document of the same kind, about the same subject, with the same
//      date further out, RESOLVES the older document's alert (renewed
//      registration, replacement passport) — on every read, so a reload or a
//      new session cannot bring it back.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { buildNotifications, readDismissedNotificationIds } from "../server/notification-service";
import {
  rulesFromAll, isAlertDateRule, isReportingPeriodBoundary, classifyDateField, documentNamesMatch,
} from "@shared/date-rules";
import { extractionDateRows } from "@shared/extraction-calendar";

const TZ = "America/Los_Angeles";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const shift = (days: number) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

let storage: MemStorage;
let self: any;
let honda: any;
let bmw: any;

beforeEach(async () => {
  storage = new MemStorage();
  self = (await storage.getProfiles()).find((p: any) => p.type === "self")
    || await storage.createProfile({ name: "Robert", type: "self", fields: {}, tags: [], notes: "" } as any);
  honda = await storage.createProfile({ name: "Honda CR-V 2021", type: "vehicle", fields: {}, tags: [], notes: "", parentProfileId: self.id } as any);
  bmw = await storage.createProfile({ name: "BMW X5", type: "vehicle", fields: {}, tags: [], notes: "", parentProfileId: self.id } as any);
});

const docAlerts = async () => (await buildNotifications(storage, TZ)).filter(n => n.entityType === "document");
const executiveDocsCard = async () => ((await storage.getDashboardEnhanced()) as any).expiringDocuments as any[];

describe("a statement's period is history, never an alert", () => {
  it("the exact stored shape from the report raises nothing in the bell or the Documents card", async () => {
    const doc = await storage.createDocument({
      name: "Bank Statement - Checking Account", type: "bank_statement",
      extractedData: {
        accountType: "CHECKING", institution: "THE GREAT WESTERN BANK", closingBalance: 1285, openingBalance: 1285,
        statementPeriod: { endDate: "2024-04-30", startDate: "2024-04-01" },
      },
      linkedProfiles: [self.id],
    });
    expect((await docAlerts()).filter(n => n.entityId === doc.id)).toEqual([]);
    expect((await executiveDocsCard()).filter((d: any) => d.documentId === doc.id || d.id === doc.id)).toEqual([]);
    expect(rulesFromAll({ documents: await storage.getDocuments() }).filter(r => r.sourceEntityId === doc.id && isAlertDateRule(r))).toEqual([]);
  });

  it("every spelling of a reporting-period boundary is history; real deadlines on the same statement still alert", async () => {
    for (const [key, path, ctx] of [
      ["endDate", "statementPeriod.endDate", "bank_statement"],
      ["end", "period.end", "bank_statement Checking"],
      ["statementEndDate", "statementEndDate", ""],
      ["statementPeriodEndDate", "statementPeriodEndDate", ""],
      ["billingPeriodEnd", "billingPeriodEnd", ""],
      ["payPeriodEnd", "payPeriodEnd", "pay stub"],
      ["statementDate", "statementDate", ""],
    ] as const) {
      expect(isReportingPeriodBoundary(key, path, ctx), `${path}`).toBe(true);
    }
    // NOT history: coverage really ends, a house closing really happens.
    expect(isReportingPeriodBoundary("endDate", "coveragePeriod.endDate", "insurance policy")).toBe(false);
    expect(isReportingPeriodBoundary("closingDate", "closingDate", "purchase agreement")).toBe(false);
    expect(isReportingPeriodBoundary("end", "period.end", "auto insurance policy")).toBe(false);
    expect(classifyDateField("paymentDueDate").actionable).toBe(true);

    const due = shift(5);
    const card = await storage.createDocument({
      name: "Visa Statement", type: "credit_card_statement",
      extractedData: { statementPeriod: { startDate: shift(-35), endDate: shift(-5) }, paymentDueDate: due, minimumPayment: 35 },
      linkedProfiles: [self.id],
    });
    const alerts = (await docAlerts()).filter(n => n.entityId === card.id);
    expect(alerts.length).toBe(1);
    expect(alerts[0].dueDate).toContain(due);
  });

  it("extraction review offers no calendar action for a statement period", () => {
    const items = extractionDateRows(
      [{ key: "endDate", path: "statementPeriod.endDate", value: "2024-04-30" }, { key: "startDate", path: "statementPeriod.startDate", value: "2024-04-01" }] as any,
      { documentContext: "bank_statement Bank Statement", today: TODAY } as any,
    );
    expect(items).toEqual([]);
  });
});

describe("completing the action resolves the alert (supersession)", () => {
  it("expired registration → upload the renewed one → the alert resolves, and stays resolved on the next read", async () => {
    const old = await storage.createDocument({
      name: "CA Vehicle Registration – Honda 2021", type: "vehicle_registration",
      extractedData: { expirationDate: shift(-3) }, linkedProfiles: [honda.id, self.id],
    });
    let alerts = await docAlerts();
    expect(alerts.some(n => n.entityId === old.id)).toBe(true);
    expect((await executiveDocsCard()).some((d: any) => (d.documentId || d.id) === old.id)).toBe(true);

    // The user does the real-world thing and uploads the proof.
    const renewed = await storage.createDocument({
      name: "CA Vehicle Registration - Honda 2021", type: "vehicle_registration",
      extractedData: { expirationDate: shift(362) }, linkedProfiles: [honda.id, self.id],
    });
    alerts = await docAlerts();
    expect(alerts.some(n => n.entityId === old.id)).toBe(false);
    expect(alerts.some(n => n.entityId === renewed.id)).toBe(false); // a year out: nothing to say yet
    expect((await executiveDocsCard()).some((d: any) => (d.documentId || d.id) === old.id)).toBe(false);

    // Derived, not dismissed: no flag was written, and a fresh read ("refresh /
    // relogin") computes the same answer from the records alone.
    expect((await readDismissedNotificationIds(storage)).size).toBe(0);
    expect((await docAlerts()).some(n => n.entityId === old.id)).toBe(false);
    // The old document is history, not deleted.
    expect((await storage.getDocuments()).some(d => d.id === old.id)).toBe(true);
  });

  it("does NOT resolve across different subjects or different policies", async () => {
    const hondaReg = await storage.createDocument({
      name: "CA Vehicle Registration – Honda", type: "vehicle_registration",
      extractedData: { expirationDate: shift(-3) }, linkedProfiles: [honda.id, self.id],
    });
    await storage.createDocument({
      name: "CA Vehicle Registration – BMW", type: "vehicle_registration",
      extractedData: { expirationDate: shift(300) }, linkedProfiles: [bmw.id, self.id],
    });
    const autoPolicy = await storage.createDocument({
      name: "Progressive Auto Insurance Policy", type: "insurance",
      extractedData: { expirationDate: shift(-2) }, linkedProfiles: [self.id],
    });
    await storage.createDocument({
      name: "State Farm Home Insurance Policy", type: "insurance",
      extractedData: { expirationDate: shift(200) }, linkedProfiles: [self.id],
    });
    const alerts = await docAlerts();
    expect(alerts.some(n => n.entityId === hondaReg.id)).toBe(true);
    expect(alerts.some(n => n.entityId === autoPolicy.id)).toBe(true);
    expect(documentNamesMatch("Progressive Auto Insurance Policy", "State Farm Home Insurance Policy")).toBe(false);
    expect(documentNamesMatch("Passport", "Passport (renewed 2026)")).toBe(true);
  });

  it("deleting the newer document brings the older alert back (nothing was stored)", async () => {
    const old = await storage.createDocument({
      name: "Passport", type: "passport", extractedData: { expirationDate: shift(-10) }, linkedProfiles: [self.id],
    });
    const renewed = await storage.createDocument({
      name: "Passport", type: "passport", extractedData: { expirationDate: shift(3600) }, linkedProfiles: [self.id],
    });
    expect((await docAlerts()).some(n => n.entityId === old.id)).toBe(false);
    await storage.deleteDocument(renewed.id);
    expect((await docAlerts()).some(n => n.entityId === old.id)).toBe(true);
  });
});
