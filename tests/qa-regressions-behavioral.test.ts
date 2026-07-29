// BEHAVIORAL regressions for the 2026-07-27 QA report.
//
// The companion suites assert the verifier's logic and guard the source shapes.
// These do the thing the user actually asked for: run the REAL tool handlers
// (executeTool, the same entry point chat and the bulk extractor both use) and
// then read the store back to see what was actually written.
//
// storage is a Proxy over requestStorageContext (an AsyncLocalStorage), so a
// test can substitute a recording store and exercise production code paths
// end-to-end without a database. Nothing here greps source.
import { describe, it, expect, beforeEach } from "vitest";
import { requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";

// ── A recording store: real enough for these handlers, and it REMEMBERS. ─────
type Row = Record<string, any>;
let db: {
  profiles: Row[]; documents: Row[]; trackers: Row[]; events: Row[];
  expenses: Row[]; tasks: Row[]; obligations: Row[]; reminders: Row[]; journal: Row[];
  links: Array<{ profileId: string; kind: string; entityId: string }>;
  updateProfileCalls: Array<{ id: string; data: Row }>;
};

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

function freshDb() {
  db = {
    profiles: [
      { id: "self-1", name: "Me", type: "self", fields: {}, linkedProfiles: [] },
      { id: "p-craig", name: "Craig", type: "person", fields: { birthday: "1990-04-02" }, notes: "old note", linkedProfiles: [] },
      { id: "p-rex", name: "Rex", type: "pet", fields: {}, linkedProfiles: [] },
      { id: "v-hrv", name: "Honda HR-V", type: "vehicle", fields: {}, linkedProfiles: [] },
      { id: "v-crv", name: "Honda CR-V", type: "vehicle", fields: {}, linkedProfiles: [] },
    ],
    documents: [], trackers: [], events: [], expenses: [], tasks: [],
    obligations: [], reminders: [], journal: [], links: [], updateProfileCalls: [],
  };
}

const store: any = {
  _timezone: "America/Los_Angeles",
  getProfiles: async () => db.profiles,
  getProfilesLite: async () => db.profiles,
  getProfile: async (id: string) => db.profiles.find(p => p.id === id),
  updateProfile: async (id: string, data: Row) => {
    db.updateProfileCalls.push({ id, data });
    const p = db.profiles.find(x => x.id === id);
    if (!p) return undefined;
    // Mirror SupabaseStorage: `fields` MERGES, scalars overwrite.
    Object.assign(p, { ...data, fields: { ...(p.fields || {}), ...(data.fields || {}) } });
    return p;
  },
  createDocument: async (d: Row) => { const row = { ...d, id: uid("doc"), linkedProfiles: [] }; db.documents.push(row); return row; },
  getDocuments: async () => db.documents,
  deleteDocument: async (id: string) => { db.documents = db.documents.filter(d => d.id !== id); return true; },
  linkProfileTo: async (profileId: string, kind: string, entityId: string) => {
    db.links.push({ profileId, kind, entityId });
    const bucket = ({ document: db.documents, event: db.events, expense: db.expenses, tracker: db.trackers } as any)[kind];
    const row = bucket?.find((r: Row) => r.id === entityId);
    if (row) row.linkedProfiles = Array.from(new Set([...(row.linkedProfiles || []), profileId]));
    return true;
  },
  getTrackers: async () => db.trackers,
  getTracker: async (id: string) => db.trackers.find(t => t.id === id),
  createTracker: async (t: Row) => { const row = { ...t, id: uid("trk"), entries: [] }; db.trackers.push(row); return row; },
  getEvents: async () => db.events,
  createEvent: async (e: Row) => { const row = { ...e, id: uid("evt"), linkedProfiles: e.linkedProfiles || [] }; db.events.push(row); return row; },
  getExpenses: async () => db.expenses,
  updateExpense: async (id: string, changes: Row) => {
    const e = db.expenses.find(x => x.id === id); if (!e) return undefined;
    Object.assign(e, changes); return e;
  },
  getTasks: async () => db.tasks,
  updateTask: async (id: string, changes: Row) => {
    const t = db.tasks.find(x => x.id === id); if (!t) return undefined;
    Object.assign(t, changes); return t;
  },
  getObligations: async () => db.obligations,
  listReminders: async () => db.reminders,
  createReminder: async (r: Row) => { const row = { ...r, id: uid("rem") }; db.reminders.push(row); return row; },
  wouldCreateCycle: async () => false,
  getPreference: async () => null,
  logActivity: () => {},
  getJournalEntries: async () => db.journal,
  getJournalEntry: async (id: string) => db.journal.find(j => j.id === id),
  updateJournalEntry: async (id: string, data: Row) => {
    const j = db.journal.find(x => x.id === id); if (!j) return undefined;
    Object.assign(j, data); return j;
  },
};

/** Run a real tool against the recording store. */
const run = (tool: string, input: Row) =>
  requestStorageContext.run(store as any, () => executeTool(tool, { ...input }, "test-user"));

beforeEach(freshDb);

// ═══════════════════════════════════════════════════════════════════════════
describe("Profile update: the requested rename actually persists", () => {
  it("writes the new name AND the sibling edits in one call", async () => {
    const res: any = await run("update_profile", {
      name: "Craig",
      changes: { name: "Craig Jr", notes: "updated note", fields: { birthday: "1991-05-03" } },
    });
    expect(res?.error).toBeUndefined();
    // Read the store back — this is the assertion the old code would fail.
    const craig = db.profiles.find(p => p.id === "p-craig")!;
    expect(craig.name).toBe("Craig Jr");
    expect(craig.notes).toBe("updated note");
    expect(craig.fields.birthday).toBe("1991-05-03");
    // And the rename was genuinely handed to storage, not just echoed back.
    expect(db.updateProfileCalls.at(-1)!.data.name).toBe("Craig Jr");
  });

  it("refuses a rename that would duplicate an existing profile name", async () => {
    const res: any = await run("update_profile", { name: "Craig", changes: { name: "Rex" } });
    expect(res.error).toMatch(/already exists/i);
    expect(db.profiles.find(p => p.id === "p-craig")!.name).toBe("Craig"); // untouched
  });

  it("rejects an empty rename instead of blanking the profile", async () => {
    const res: any = await run("update_profile", { name: "Craig", changes: { name: "   " } });
    expect(res.error).toMatch(/can't be empty/i);
    expect(db.profiles.find(p => p.id === "p-craig")!.name).toBe("Craig");
  });

  it("captures the old name so the change can be reverted", async () => {
    const res: any = await run("update_profile", { name: "Craig", changes: { name: "Craig Jr" } });
    expect(res._previousState.name).toBe("Craig");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Notes: a document goes to the named profile or nowhere", () => {
  it("links the document to the profile the user named", async () => {
    const res: any = await run("create_document", { name: "Vet records", content: "hi", forProfile: "Rex" });
    expect(res?.error).toBeUndefined();
    expect(db.documents).toHaveLength(1);
    expect(db.links).toContainEqual({ profileId: "p-rex", kind: "document", entityId: db.documents[0].id });
    expect(db.documents[0].linkedProfiles).toEqual(["p-rex"]);
  });

  it("does NOT strand an unlinked note under the account owner when the name is unknown", async () => {
    // The reported bug: this used to create the document, skip the link, and
    // report success — leaving it invisible on the intended profile's page.
    const res: any = await run("create_document", { name: "Luna's chart", content: "x", forProfile: "Luna" });
    expect(res.error).toMatch(/couldn't find a profile named "Luna"/i);
    expect(db.documents).toHaveLength(0);   // rolled back, not stranded
    expect(db.links).toHaveLength(0);
  });

  it("asks which profile when the name is ambiguous, and writes nothing", async () => {
    const res: any = await run("create_document", { name: "Service record", content: "x", forProfile: "Honda" });
    expect(res.error).toMatch(/matches more than one profile/i);
    expect(db.documents).toHaveLength(0);
  });

  it("still allows an unowned document when no profile was named", async () => {
    const res: any = await run("create_document", { name: "Scratch note", content: "x" });
    expect(res?.error).toBeUndefined();
    expect(db.documents).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Medication: the tracker lands on the requested profile, never silently on self", () => {
  it("attributes a new tracker to the named profile", async () => {
    const res: any = await run("create_tracker", { name: "Heartworm Meds", category: "medication", forProfile: "Rex" });
    expect(res?.error).toBeUndefined();
    expect(db.trackers[0].linkedProfiles).toEqual(["p-rex"]);
  });

  it("does NOT fall through to the account owner on an unknown name", async () => {
    // Old behavior: exact-lowercase compare failed, then `if (!ctTargetId)`
    // assigned SELF — a medication filed under the wrong person.
    const res: any = await run("create_tracker", { name: "Insulin", forProfile: "Luna" });
    expect(res.error).toMatch(/couldn't find a profile named "Luna"/i);
    expect(db.trackers).toHaveLength(0);
    expect(db.trackers.some(t => (t.linkedProfiles || []).includes("self-1"))).toBe(false);
  });

  it("resolves a name that isn't a byte-exact match", async () => {
    const res: any = await run("create_tracker", { name: "Flea Meds", forProfile: "  rex  " });
    expect(res?.error).toBeUndefined();
    expect(db.trackers[0].linkedProfiles).toEqual(["p-rex"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Expense reassignment: a move MOVES", () => {
  beforeEach(() => {
    db.expenses.push({ id: "exp-1", description: "gym membership", amount: 40, linkedProfiles: ["self-1"] });
  });

  it("replaces the owner set instead of appending the destination", async () => {
    const res: any = await run("update_expense", { description: "gym", forProfile: "Craig" });
    expect(res?.error).toBeUndefined();
    // The reported bug: this used to be ["p-craig", "self-1"].
    expect(db.expenses[0].linkedProfiles).toEqual(["p-craig"]);
  });

  it("refuses an unknown destination rather than silently leaving the owner", async () => {
    const res: any = await run("update_expense", { description: "gym", forProfile: "Luna" });
    expect(res.error).toMatch(/couldn't find a profile named "Luna"/i);
    expect(db.expenses[0].linkedProfiles).toEqual(["self-1"]); // unchanged
  });
});

describe("Task reassignment resolves strictly too", () => {
  beforeEach(() => {
    db.tasks.push({ id: "task-1", title: "renew registration", status: "todo", linkedProfiles: ["self-1"] });
  });

  it("moves the task to exactly the named profile", async () => {
    await run("update_task", { title: "renew", forProfile: "Craig" });
    expect(db.tasks[0].linkedProfiles).toEqual(["p-craig"]);
  });

  it("asks rather than guessing between two similar profiles", async () => {
    const res: any = await run("update_task", { title: "renew", forProfile: "Honda" });
    expect(res.error).toMatch(/matches more than one profile/i);
    expect(db.tasks[0].linkedProfiles).toEqual(["self-1"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Events: forProfile is honored or refused", () => {
  it("links the event to the named profile", async () => {
    const res: any = await run("create_event", { title: "Vet checkup", date: "2026-09-01", forProfile: "Rex" });
    expect(res?.error).toBeUndefined();
    expect(db.events[0].linkedProfiles).toContain("p-rex");
  });

  it("refuses an unknown profile instead of creating an unowned event", async () => {
    const res: any = await run("create_event", { title: "Vet checkup", date: "2026-09-01", forProfile: "Luna" });
    expect(res.error).toMatch(/couldn't find a profile named "Luna"/i);
    expect(db.events).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Birthdays are written once", () => {
  it("a second birthday event for the same day returns the existing one", async () => {
    // The auto-generated entry is anchored at the BIRTH year; a model writes the
    // upcoming year. Same-date dedup never matched, so both survived.
    db.events.push({
      id: "evt-auto", title: "🎂 Craig's Birthday", date: "1990-04-02",
      recurrence: "yearly", linkedProfiles: ["p-craig"], tags: ["auto-generated"],
    });
    const res: any = await run("create_event", {
      title: "🎂 Craig's Birthday", date: "2026-04-02", recurrence: "yearly", forProfile: "Craig",
    });
    expect(res.id).toBe("evt-auto");        // handed back the existing row
    expect(db.events).toHaveLength(1);      // and did NOT write a second
  });

  it("still allows a different person's birthday on the same day", async () => {
    db.events.push({
      id: "evt-auto", title: "🎂 Craig's Birthday", date: "1990-04-02",
      recurrence: "yearly", linkedProfiles: ["p-craig"], tags: [],
    });
    await run("create_event", { title: "🎂 Rex's Birthday", date: "2026-04-02", recurrence: "yearly" });
    expect(db.events).toHaveLength(2);
  });

  it("does not treat an ordinary event as a birthday", async () => {
    db.events.push({ id: "evt-1", title: "Dentist", date: "2026-04-02", recurrence: "none", linkedProfiles: [] });
    await run("create_event", { title: "Dentist", date: "2027-04-02" });
    expect(db.events).toHaveLength(2);      // a year later is a real second visit
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Reminder → calendar: the claim matches reality", () => {
  const at = "2026-09-04T17:00:00.000Z";

  it("creates the reminder AND the mirrored calendar event, with matching times", async () => {
    const res: any = await run("create_reminder", { title: "Call the dentist", fireAt: at });
    expect(res?.error).toBeUndefined();
    expect(db.reminders).toHaveLength(1);
    expect(db.events).toHaveLength(1);
    expect(res.calendarWarning).toBeUndefined();
    expect(res.message).toMatch(/added to your calendar/);
    // The two records describe the same moment in the same zone.
    const tz = store._timezone;
    const fired = new Date(db.reminders[0].fireAt);
    expect(db.events[0].date).toBe(fired.toLocaleDateString("en-CA", { timeZone: tz }));
    expect(db.events[0].time).toBe(fired.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }));
  });

  it("says so — and does NOT claim the calendar — when the mirror fails", async () => {
    const failing = { ...store, createEvent: async () => { throw new Error("events table offline"); } };
    const res: any = await requestStorageContext.run(failing as any, () =>
      executeTool("create_reminder", { title: "Call the dentist", fireAt: at }, "test-user"));
    expect(db.reminders).toHaveLength(1);           // the reminder itself survived
    expect(res.calendarWarning).toMatch(/failed to save/i);
    expect(res.message).toMatch(/do not say it was added to the calendar/i);
    expect(res.message).not.toMatch(/and added to your calendar/);
  });

  it("reuses an existing calendar row rather than duplicating it", async () => {
    await run("create_reminder", { title: "Call the dentist", fireAt: at });
    expect(db.events).toHaveLength(1);
    await run("create_reminder", { title: "Call the dentist", fireAt: at });
    expect(db.events).toHaveLength(1);              // still one
    expect(db.reminders).toHaveLength(2);           // two reminders, one calendar row
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Delete: survivors are reported instead of a blanket success", () => {
  it("names the leftover records when the cascade misses something", async () => {
    db.obligations.push({ id: "obl-1", name: "Car Loan payment", linkedProfiles: ["p-craig"] });
    const res: any = await requestStorageContext.run(
      { ...store, deleteProfile: async () => { db.profiles = db.profiles.filter(p => p.id !== "p-craig"); return true; } } as any,
      () => executeTool("delete_profile", { name: "Craig" }, "test-user"),
    );
    expect(res.deleted).toBe(true);
    expect(res.orphansRemaining).toContain('bill "Car Loan payment"');
    expect(res.error).toMatch(/do NOT say everything was deleted/);
  });

  it("reports a clean delete plainly when nothing survives", async () => {
    const res: any = await requestStorageContext.run(
      { ...store, deleteProfile: async () => { db.profiles = db.profiles.filter(p => p.id !== "p-craig"); return true; } } as any,
      () => executeTool("delete_profile", { name: "Craig" }, "test-user"),
    );
    expect(res.deleted).toBe(true);
    expect(res.orphansRemaining).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  it("does not claim a delete that was rolled back", async () => {
    const res: any = await requestStorageContext.run(
      { ...store, deleteProfile: async () => false } as any,
      () => executeTool("delete_profile", { name: "Craig" }, "test-user"),
    );
    expect(res.error).toMatch(/failed and was rolled back/i);
    expect(db.profiles.some(p => p.id === "p-craig")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Liability: the parent profile is the one the user named", () => {
  const liabilityStore = () => ({
    ...store,
    createProfile: async (p: Row) => { const row = { ...p, id: uid("liab") }; db.profiles.push(row); return row; },
  });

  it("nests the liability under the named profile", async () => {
    const res: any = await requestStorageContext.run(liabilityStore() as any, () =>
      executeTool("create_liability", {
        name: "Craig's Car Loan", subtype: "auto_loan",
        currentBalance: 12000, monthlyPayment: 300, forProfile: "Craig",
      }, "test-user"));
    expect(res?.error).toBeUndefined();
    const created = db.profiles.find(p => p.name === "Craig's Car Loan");
    expect(created?.parentProfileId).toBe("p-craig");
  });

  it("refuses an unknown owner instead of silently nesting under the account holder", async () => {
    const res: any = await requestStorageContext.run(liabilityStore() as any, () =>
      executeTool("create_liability", {
        name: "Luna's Car Loan", subtype: "auto_loan",
        currentBalance: 12000, monthlyPayment: 300, forProfile: "Luna",
      }, "test-user"));
    expect(res.error).toMatch(/couldn't find a profile named "Luna"/i);
    expect(db.profiles.some(p => p.name === "Luna's Car Loan")).toBe(false);
  });

  it("asks rather than picking the first profile whose name merely CONTAINS the string", async () => {
    // The old resolution was a bare .includes(), so "Honda" would silently
    // attach the loan to whichever Honda came first in the list.
    const res: any = await requestStorageContext.run(liabilityStore() as any, () =>
      executeTool("create_liability", {
        name: "Honda Loan", subtype: "auto_loan",
        currentBalance: 12000, monthlyPayment: 300, forProfile: "Honda",
      }, "test-user"));
    expect(res.error).toMatch(/matches more than one profile/i);
    expect(db.profiles.some(p => p.name === "Honda Loan")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Journal: the entry can actually be moved to another day", () => {
  beforeEach(() => {
    db.journal.push({ id: "j-1", date: "2026-07-20", content: "original text", mood: "ok", linkedProfiles: [] });
  });

  it("applies the content edit AND the date move in one call", async () => {
    // The reported bug: content updated, the date change did not. The tool
    // schema never advertised changes.date, so "change the date" landed in the
    // top-level `date` param — which FINDS an entry rather than moving one.
    const res: any = await run("update_journal", {
      date: "2026-07-20",
      changes: { content: "corrected text", date: "2026-07-18" },
    });
    expect(res?.error).toBeUndefined();
    expect(db.journal[0].content).toBe("corrected text");
    expect(db.journal[0].date).toBe("2026-07-18");
  });

  it("refuses to move an entry onto a day that already has one", async () => {
    db.journal.push({ id: "j-2", date: "2026-07-18", content: "other day", linkedProfiles: [] });
    const res: any = await run("update_journal", { date: "2026-07-20", changes: { date: "2026-07-18" } });
    expect(res.error).toMatch(/already a journal entry for 2026-07-18/i);
    expect(db.journal.find(j => j.id === "j-1")!.date).toBe("2026-07-20"); // untouched
  });

  it("rejects a malformed date instead of writing junk", async () => {
    const res: any = await run("update_journal", { date: "2026-07-20", changes: { date: "next Tuesday" } });
    expect(res.error).toMatch(/isn't a valid date/i);
    expect(db.journal[0].date).toBe("2026-07-20");
  });

  it("still does a plain find/replace without touching the date", async () => {
    const res: any = await run("update_journal", { date: "2026-07-20", find: "original", replace: "revised" });
    expect(res?.error).toBeUndefined();
    expect(db.journal[0].content).toBe("revised text");
    expect(db.journal[0].date).toBe("2026-07-20");
  });
});
