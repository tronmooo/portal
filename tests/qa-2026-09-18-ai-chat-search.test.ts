// tests/qa-2026-09-18-ai-chat-search.test.ts
//
// QA 2026-09-18, AI & chat / global search / notifications — the pure rules:
//
//   • F-44  the AI-advice response is read whatever spelling it arrives in;
//   • F-45  a message identical to the one just sent is a stuck draft, not a send;
//   • F-46  the thinking placeholder names the running tool or the elapsed phase;
//   • F-48  ONE search matcher for both storages, covering tasks, notes and the
//           birthdays a profile carries;
//   • F-51  a dated notice names the record, never the field key, with a
//           readable date;
//   • F-52  a search result carries a record highlight the target page reads;
//   • F-53  severity is per notification: an overdue errand is a warning.
//
// The screens are covered in tests/qa-2026-09-18-ai-chat-search.dom.test.tsx.
import { describe, it, expect } from "vitest";
import { searchCorpus, virtualDateRows, rowMatches } from "../shared/search-match";
import { dateRuleNotice, overdueTaskSeverity, formatNoticeDate, dateRuleSeverity } from "../shared/notification-rules";
import { chatProgressLabel, humanizeToolName, isDuplicateResend, elapsedBadge } from "../shared/chat-progress";
import { highlightHref, parseHighlight, stripHighlight } from "../shared/record-highlight";
import { normalizeAiSuggestions } from "../shared/executive-sections";
import { buildNotifications } from "../server/notification-service";

// ── F-44 ────────────────────────────────────────────────────────────────────
describe("F-44 normalizeAiSuggestions reads the route's real shape", () => {
  const SERVER_SHAPE = {
    suggestions: [
      { title: "Recategorize auto loan as vehicle obligation", body: "It sits under general.", action: "Recategorize", priority: "high" },
      { title: "Link 3 documents", body: "They have no profile.", action: "Link", priority: "medium" },
    ],
    generatedAt: "2026-09-18T12:00:00.000Z", source: "ai", fingerprint: "123",
  };
  it("returns every titled row from { suggestions }", () => {
    const rows = normalizeAiSuggestions(SERVER_SHAPE);
    expect(rows.map((r) => r.title)).toEqual([
      "Recategorize auto loan as vehicle obligation", "Link 3 documents",
    ]);
    expect(rows[0].priority).toBe("high");
  });
  it("also accepts a bare array and { items }", () => {
    expect(normalizeAiSuggestions(SERVER_SHAPE.suggestions)).toHaveLength(2);
    expect(normalizeAiSuggestions({ items: SERVER_SHAPE.suggestions })).toHaveLength(2);
  });
  it("drops rows without a title and survives garbage", () => {
    expect(normalizeAiSuggestions({ suggestions: [{ body: "no title" }, null, "x"] })).toEqual([]);
    expect(normalizeAiSuggestions(null)).toEqual([]);
    expect(normalizeAiSuggestions({ error: "Failed", suggestions: [] })).toEqual([]);
  });
});

// ── F-45 ────────────────────────────────────────────────────────────────────
describe("F-45 duplicate-resend guard", () => {
  const last = { text: "add $30 groceries", at: 10_000 };
  it("refuses the same text while the first send is in flight", () => {
    expect(isDuplicateResend(last, "add $30 groceries", 10_500, true)).toBe(true);
  });
  it("refuses the same text within a beat of the first send settling", () => {
    expect(isDuplicateResend(last, " add $30 groceries ", 10_900, false)).toBe(true);
  });
  it("allows the same text sent deliberately later, and any different text", () => {
    expect(isDuplicateResend(last, "add $30 groceries", 20_000, false)).toBe(false);
    expect(isDuplicateResend(last, "add $40 groceries", 10_100, true)).toBe(false);
    expect(isDuplicateResend(null, "add $30 groceries", 10_100, true)).toBe(false);
  });
});

// ── F-46 ────────────────────────────────────────────────────────────────────
describe("F-46 thinking placeholder label", () => {
  it("names the running tool as an action", () => {
    expect(humanizeToolName("create_expense")).toBe("Adding expense");
    expect(humanizeToolName("log_tracker_entry")).toBe("Logging tracker entry");
    expect(humanizeToolName("get_profile")).toBe("Looking up profile");
    expect(chatProgressLabel({ elapsedMs: 4000, runningTools: [{ tool: "create_expense", label: "Groceries $30" }] }))
      .toBe("Adding expense: Groceries $30…");
    expect(chatProgressLabel({ elapsedMs: 4000, runningTools: [{ tool: "create_expense" }] })).toBe("Adding expense…");
  });
  it("moves with the clock when no tool is running", () => {
    expect(chatProgressLabel({ elapsedMs: 800 })).toBe("Thinking…");
    expect(chatProgressLabel({ elapsedMs: 5000 })).toBe("Working on it…");
    expect(chatProgressLabel({ elapsedMs: 12_000 })).toBe("Still working… 12s");
    expect(chatProgressLabel({ elapsedMs: 26_000 })).toBe("Still working… 26s");
    expect(chatProgressLabel({ elapsedMs: 40_000 })).toContain("40s");
    expect(chatProgressLabel({ elapsedMs: 40_000, uploading: true })).toBe("Uploading & reading your document…");
  });
  it("shows elapsed seconds once the turn stops being instant", () => {
    expect(elapsedBadge(1000)).toBe("");
    expect(elapsedBadge(26_400)).toBe("26s");
  });
});

// ── F-48 ────────────────────────────────────────────────────────────────────
describe("F-48 one search matcher, every record", () => {
  const corpus = {
    profiles: [
      { id: "p-dana", name: "Dana", type: "person", tags: [], fields: { birthday: "1990-06-15" } },
      { id: "p-mom", name: "Mom", type: "person", tags: [], fields: { birthday: "1955-02-01" } },
    ],
    tasks: [
      { id: "t1", title: "Call Dana about Thanksgiving", status: "todo", tags: [] },
      { id: "t2", title: "Renew plates", description: "DMV closes at 5, bring the Dana Ave lease", status: "todo" },
    ],
    events: [{ id: "e1", title: "Mom's Birthday", date: "2026-02-01", category: "birthday" }],
    expenses: [{ id: "x1", description: "Weekly shop", category: "groceries", notes: "at Costco with Dana" }],
    documents: [{ id: "d1", name: "Homeowners Insurance", type: "insurance", fileData: "AAAA", content: "big" }],
  };

  it("finds a person, the task that names her, her birthday and a note about her", () => {
    const hits = searchCorpus(corpus, "dana");
    const by = (t: string) => hits.filter((h) => h._type === t);
    expect(by("profile").map((h) => h.id)).toEqual(["p-dana"]);
    expect(by("task").map((h) => h.id).sort()).toEqual(["t1", "t2"]);   // title AND description
    expect(by("event").some((h) => h.title === "Dana's Birthday" && h.virtual)).toBe(true);
    expect(by("expense").map((h) => h.id)).toEqual(["x1"]);            // notes
  });

  it("lists every birthday the Important Dates page lists, not only hand-entered events", () => {
    const hits = searchCorpus(corpus, "birthday").filter((h) => h._type === "event");
    expect(hits.map((h) => h.title).sort()).toEqual(["Dana's Birthday", "Mom's Birthday", "Mom's Birthday"]);
    const dana = hits.find((h) => h.title === "Dana's Birthday")!;
    expect(dana.href).toContain("p-dana");
    expect(dana.date).toBeTruthy();
  });

  it("never returns a document's file body, and never matches on it", () => {
    const [doc] = searchCorpus(corpus, "homeowners");
    expect(doc._type).toBe("document");
    expect(doc).not.toHaveProperty("fileData");
    expect(doc).not.toHaveProperty("content");
    expect(searchCorpus(corpus, "aaaa")).toEqual([]);
  });

  it("empty query matches nothing; a null field never throws", () => {
    expect(searchCorpus(corpus, "   ")).toEqual([]);
    expect(rowMatches("task", { title: null, tags: undefined }, "x")).toBe(false);
    expect(virtualDateRows([{ id: "p", name: "X", fields: null }])).toEqual([]);
  });
});

// ── F-51 / F-53 ─────────────────────────────────────────────────────────────
describe("F-51 a dated notice names the record, with a readable date", () => {
  it("formats the date and never leaks the field key", () => {
    expect(formatNoticeDate("2026-06-01")).toBe("Jun 1, 2026");
    expect(formatNoticeDate("2026-06-01T00:00:00Z")).toBe("Jun 1, 2026");
    expect(formatNoticeDate("garbage")).toBe("garbage");
    const n = dateRuleNotice({ ruleType: "expiration", isDocument: true, entityName: "Homeowners Insurance", diff: -109, date: "2026-06-01" });
    expect(n.title).toBe("Expired: Homeowners Insurance");
    expect(n.message).toBe("Homeowners Insurance expired 109 days ago (Jun 1, 2026)");
    expect(n.severity).toBe("critical");
  });
  it("labels a profile field by its human name", () => {
    const n = dateRuleNotice({ ruleType: "expiration", isDocument: false, entityName: "Dana", fieldKey: "passport_expiration", diff: 3, date: "2026-09-21" });
    expect(n.title).toBe("Expiring soon: Dana · Passport Expiration");
    expect(n.message).toBe("Passport Expiration expires in 3 days (Sep 21, 2026)");
    expect(n.severity).toBe("warning");
    const nested = dateRuleNotice({ ruleType: "renewal", isDocument: false, entityName: "Dana", fieldKey: "insurance.renewalDate", diff: 0, date: "2026-09-18" });
    expect(nested.message).toBe("Renewal Date renews today (Sep 18, 2026)");
    expect(dateRuleSeverity(20)).toBe("info");
  });
});

describe("F-53 severity is per notification", () => {
  it("an overdue errand is a warning; only an urgent, long-overdue task is critical", () => {
    expect(overdueTaskSeverity(1, "medium")).toBe("warning");
    expect(overdueTaskSeverity(30, "low")).toBe("warning");
    expect(overdueTaskSeverity(3, "high")).toBe("warning");
    expect(overdueTaskSeverity(14, "high")).toBe("critical");
    expect(overdueTaskSeverity(20, "urgent")).toBe("critical");
  });
});

describe("notification-service applies both rules", () => {
  const NY_TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const nyDaysAgo = (n: number) => { const d = new Date(`${NY_TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const stubStorage = (over: Record<string, any>): any => ({
    getDocuments: async () => [], getProfiles: async () => [], getTasks: async () => [],
    getObligations: async () => [], getHabits: async () => [], listReminders: async () => [],
    listUserNotifications: async () => [], getPreference: async () => null, setPreference: async () => {},
    ...over,
  });

  it("'Put out the trash' overdue a day is Attention, an expired policy is Critical, and neither leaks a key", async () => {
    const expired = nyDaysAgo(109);
    const storage = stubStorage({
      getTasks: async () => [{ id: "t1", title: "Put out the trash", status: "todo", priority: "medium", dueDate: nyDaysAgo(1) }],
      getDocuments: async () => [{ id: "d1", name: "Homeowners Insurance", type: "insurance", extractedData: { expirationDate: expired } }],
    });
    const list = await buildNotifications(storage, "America/New_York");
    const task = list.find((n) => n.type === "task_overdue")!;
    expect(task.severity).toBe("warning");
    const doc = list.find((n) => n.type === "document_expiring")!;
    expect(doc.severity).toBe("critical");
    expect(doc.message).not.toContain("expirationDate");
    expect(doc.message).toContain(`expired 109 days ago (${formatNoticeDate(expired)})`);
    expect(doc.message).toMatch(/^Homeowners Insurance /);
  });
});

// ── F-52 ────────────────────────────────────────────────────────────────────
describe("F-52 record highlight round-trips through the hash route", () => {
  it("builds, parses and strips the parameter", () => {
    const href = highlightHref("/dashboard/finance", "expense", "abc-1");
    expect(href).toBe("/dashboard/finance?highlight=expense%3Aabc-1");
    expect(parseHighlight(`#${href}`)).toEqual({ type: "expense", id: "abc-1" });
    expect(parseHighlight("#/dashboard/finance")).toBeNull();
    expect(parseHighlight("#/dashboard/finance?highlight=nonsense")).toBeNull();
    expect(stripHighlight("#/dashboard/finance?highlight=expense%3Aabc&x=1")).toBe("#/dashboard/finance?x=1");
    expect(stripHighlight("#/dashboard/finance?highlight=expense%3Aabc")).toBe("#/dashboard/finance");
    expect(highlightHref("/finance?new=expense", "expense", 7)).toBe("/finance?new=expense&highlight=expense%3A7");
  });
});
