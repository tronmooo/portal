// OWNER REPORT (2026-11-22): "things need to respond when I mark things done —
// they should disappear." A dismissed "Home Depot" expiration came back, and a
// "Bill due" task ticked done was created again.
//
// One expired document reaches the dashboard in two shapes (a document row and
// an "Expired: …" alert). These tests pin that ONE dismissal hides both, that
// the dismissal lives on the server and can be restored, and that a completed
// bill reminder is not raised again. Rules: shared/alert-ids,
// server/notification-service, shared/bill-reminders.
import { describe, it, expect, afterEach } from "vitest";
import { computeAttention } from "../shared/attention";
import { buildExecutiveSections } from "../shared/executive-sections";
import { selectAttentionRows } from "../shared/executive-attention";
import { alertIdOfDateRow, alertIdsOfDateRow, dateAlertId, isDateRowDismissed } from "../shared/alert-ids";
import { groupDocumentDates } from "../shared/document-dates";
import { rulesFromAll } from "../shared/date-rules";
import { isGeneratedBillReminderTask } from "../shared/bill-reminders";
import { startHarness, type Harness } from "./helpers/route-harness";

const TODAY = "2026-11-22";
const EXPIRED = "2026-11-02";

/** The Home Depot purchase as the dashboard receives it: a document row… */
const docRow = {
  documentId: "doc-hd", ruleId: "document:doc-hd:expirationdate:expiration",
  documentName: "Home Depot Purchase — Expiration", fieldName: "expirationDate", fieldPath: "expirationDate",
  sourceEntityType: "document", ruleType: "expiration",
  expirationDate: EXPIRED, daysUntil: -20, href: "#/documents/doc-hd",
};
/** …and the alert the notification service raises for the same date. */
const alertId = "doc-exp-doc-hd-expirationDate-2026-11-02";
const alert = {
  id: alertId, type: "document_expiring", entityType: "document", entityId: "doc-hd",
  severity: "warning", title: "Expired: Home Depot Purchase",
  message: "Home Depot Purchase expired 20 days ago (Nov 2, 2026)", dueDate: EXPIRED,
};

/** What the Needs Attention card lists for these inputs. */
function attentionRows(extra: Record<string, unknown>) {
  const sections = buildExecutiveSections({
    now: new Date(`${TODAY}T09:00:00`), today: TODAY,
    documents: [docRow], notifications: [alert], ...extra,
  } as any);
  const items = (id: string) => sections.find((s) => s.id === id)?.items ?? [];
  return selectAttentionRows(
    { immediate: items("immediate"), health: items("health"), documents: items("documents") }, "upcoming");
}

describe("one date, one id, whatever shape it takes", () => {
  it("a document row derives the id the notification service gives its alert", () => {
    expect(alertIdOfDateRow(docRow)).toBe(alertId);
    expect(dateAlertId({ sourceEntityType: "profile", sourceEntityId: "p1", path: "passportExpiration", date: "2027-01-01" }))
      .toBe("profile-exp-p1-passportExpiration-2027-01-01");
  });

  it("matches for every dated field the rule engine finds on a real document", () => {
    // The dashboard row is built from the SAME rule the notification is: the
    // fields the two builders read must spell one id.
    const documents = [{ id: "d9", name: "Policy", type: "insurance", extractedData: { coverage: { expirationDate: EXPIRED } } }];
    const rules = rulesFromAll({ profiles: [], documents } as any);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const fromNotification = dateAlertId({
        sourceEntityType: rule.sourceEntityType, sourceEntityId: rule.sourceEntityId,
        path: rule.sourcePath || rule.sourceField, date: rule.date,
      });
      const fromRow = alertIdOfDateRow({
        documentId: rule.sourceEntityId, fieldName: rule.sourceField, fieldPath: rule.sourcePath,
        expirationDate: rule.date, sourceEntityType: rule.sourceEntityType,
      });
      expect(fromRow).toBe(fromNotification);
      expect(fromRow).not.toBe("");
    }
  });

  it("a grouped card carries every id it stands for, and is dismissed only when all are", () => {
    const [card] = groupDocumentDates([
      docRow,
      { ...docRow, ruleId: "document:doc-hd:premiumdue:payment", fieldName: "premiumDue", fieldPath: "premiumDue", ruleType: "payment" },
    ]);
    expect(alertIdsOfDateRow(card)).toEqual([alertId, "doc-exp-doc-hd-premiumDue-2026-11-02"]);
    expect(isDateRowDismissed(card, [alertId])).toBe(false);
    expect(isDateRowDismissed(card, [alertId, "doc-exp-doc-hd-premiumDue-2026-11-02"])).toBe(true);
    // A row that cannot be identified is never treated as dismissed.
    expect(isDateRowDismissed({ documentName: "x" }, ["anything"])).toBe(false);
  });
});

describe("a dismissed expiration stays dismissed in both shapes", () => {
  it("shows the date once before anything is dismissed", () => {
    const rows = attentionRows({});
    expect(rows.map((r) => r.title)).toEqual(["Home Depot Purchase — Expiration"]);
    // …and that row says how to dismiss it.
    expect(rows[0].dismissIds).toEqual([alertId]);
  });

  it("dismissing it hides the document row AND its alert", () => {
    expect(attentionRows({ dismissedNotificationIds: [alertId] })).toEqual([]);
    // The engine underneath agrees (the Classic dashboard reads it directly).
    const items = computeAttention({
      now: new Date(`${TODAY}T09:00:00`), today: TODAY,
      documents: [docRow], notifications: [alert], dismissedNotificationIds: [alertId],
    } as any).items;
    expect(items).toEqual([]);
  });

  it("a snooze taken on this device no longer lets the alert appear in the row's place", () => {
    // The bug as the owner met it: the document row was snoozed (browser-only,
    // 30 days), nothing claimed the record, and "Expired: Home Depot Purchase"
    // filled the gap.
    const rows = attentionRows({ snoozedDocumentIds: [docRow.ruleId] });
    expect(rows.map((r) => r.title)).toEqual([]);
  });

  it("a renewed date is a new alert", () => {
    const renewed = { ...docRow, expirationDate: "2027-11-02", daysUntil: 345 };
    expect(isDateRowDismissed(renewed, [alertId])).toBe(false);
  });
});

describe("the dismissed list lives on the server and can be restored", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });

  const seed = () => ({
    documents: [{ id: "doc-hd", name: "Home Depot Purchase", type: "receipt", linkedProfiles: [], extractedData: { expirationDate: EXPIRED } }],
  });
  const storedIds = async (hh: Harness): Promise<string[]> => {
    const r = await hh.api("GET", "/api/preferences/dismissed_notifications");
    expect(r.status).toBe(200);
    const list = JSON.parse(String(r.data?.value ?? "null"));
    if (!Array.isArray(list)) throw new Error("dismissed_notifications is not a list");
    return list;
  };
  const dismissedList = async (hh: Harness): Promise<Array<{ id: string; title: string }>> => {
    const r = await hh.api("GET", "/api/notifications/dismissed");
    expect(r.status).toBe(200);
    if (!Array.isArray(r.data?.alerts)) throw new Error("no alerts array in the response");
    return r.data.alerts;
  };

  it("lists a dismissed date by name and gives it back on Restore", async () => {
    h = await startHarness(seed());
    // Find the real id the server gives this document's alert.
    const rule = rulesFromAll({ profiles: [], documents: h.db.documents } as any)[0];
    const id = dateAlertId({ sourceEntityType: rule.sourceEntityType, sourceEntityId: rule.sourceEntityId, path: rule.sourcePath || rule.sourceField, date: rule.date });
    expect(id).not.toBe("");

    expect(await dismissedList(h)).toEqual([]);
    expect((await h.api("POST", "/api/notifications/dismiss", { ids: [id] })).status).toBe(200);
    expect(await storedIds(h)).toEqual([id]);

    const listed = await dismissedList(h);
    expect(listed.map((a) => a.id)).toEqual([id]);
    expect(listed[0].title).toContain("Home Depot Purchase");

    const restored = await h.api("POST", "/api/notifications/restore", { ids: [id] });
    expect(restored.status).toBe(200);
    expect(restored.data.ids).toEqual([]);
    expect(await storedIds(h)).toEqual([]);
    expect(await dismissedList(h)).toEqual([]);
  });

  it("does not list an id whose date has since changed (nothing left to restore)", async () => {
    h = await startHarness(seed());
    await h.api("POST", "/api/notifications/dismiss", { ids: ["doc-exp-doc-hd-expirationDate-2025-01-01"] });
    expect(await dismissedList(h)).toEqual([]);
  });

  it("keeps both of two dismissals that arrive together", async () => {
    h = await startHarness(seed());
    const ids = Array.from({ length: 6 }, (_, i) => `task-overdue-t${i}`);
    const results = await Promise.all(ids.map((id) => h!.api("POST", "/api/notifications/dismiss", { ids: [id] })));
    expect(results.map((r) => r.status)).toEqual(ids.map(() => 200));
    expect((await storedIds(h)).sort()).toEqual([...ids].sort());
  });

  it("restore refuses an empty request", async () => {
    h = await startHarness(seed());
    expect((await h.api("POST", "/api/notifications/restore", { ids: [] })).status).toBe(400);
  });
});

describe("a bill is not a task: the due scan raises no reminder and retires the ones it made", () => {
  const isBill = (id: string) => id === "bill-1";
  const generated = {
    id: "t1", title: "Bill due: Spotify", status: "todo", priority: "high",
    dueDate: "2026-03-31", dueTime: "09:00", linkedProfiles: ["bill-1"], tags: [], source: "manual",
  };

  it("recognises exactly what the scan wrote", () => {
    expect(isGeneratedBillReminderTask(generated, isBill)).toBe(true);
    // The linked bill was deleted since: still the scan's task.
    expect(isGeneratedBillReminderTask({ ...generated, linkedProfiles: ["gone"] }, (id) => id === "gone")).toBe(true);
  });

  it("leaves alone anything a person typed or changed", () => {
    const no = (over: Record<string, unknown>) =>
      expect(isGeneratedBillReminderTask({ ...generated, ...over }, isBill), JSON.stringify(over)).toBe(false);
    no({ status: "done" });                                  // history stays
    no({ title: "Pay insurance before Friday" });            // their own words
    no({ title: "Bill due: " });                             // no name: not the scan's
    no({ linkedProfiles: [] });                              // not tied to a bill
    no({ linkedProfiles: ["bill-1", "person-1"] });          // they linked someone
    no({ linkedProfiles: ["car-1"] });                       // linked to a non-bill
    no({ priority: "medium" });                              // re-prioritised
    no({ dueTime: "17:30" });                                // retimed
    no({ dueDate: null });                                   // undated
    no({ description: "Call them first" });                  // annotated
    no({ tags: ["recur:monthly"] });                         // their recurring task
    no({ source: "chat" });                                  // created elsewhere
  });

  it("the scan creates no task and trashes generated ones", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const from = src.indexOf("async function runLiabilityDueScan()");
    const scan = src.slice(from, src.indexOf("const cronLiabilityDueScan", from));
    expect(from).toBeGreaterThan(-1);
    expect(scan.length).toBeGreaterThan(500);
    expect(scan).not.toContain("createTask(");
    expect(scan).toContain("retireGeneratedBillReminderTasks(scoped, existingTasks, profiles, log)");
  });
});
