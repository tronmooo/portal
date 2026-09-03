// Regression coverage for the 2026-09-02 error-hunting round — storage layer.
// One describe per ledger item; each pins the lowest-level shared cause.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  SupabaseStorage,
  dedupCalendarTimelineItems,
  calendarTitleKey,
  calendarDaysUntil,
  hydrationDailyTotal,
  isRecurringBillShell,
} from "../server/supabase-storage";
import { MemStorage } from "../server/storage";
import { targetForStorageMethod, STORAGE_METHOD_TARGETS } from "@shared/storage-domains";
import { createWriteJournal, writeJournalContext, journalStorageCall } from "../server/write-journal";
import { planMergeProfiles, executeMergeProfiles } from "../server/merge-profiles";
import { completeHabitOccurrence, HABIT_MIRROR_KEY } from "../server/habit-completion";
import { addDays, getUserToday } from "@shared/timezone";

const SRC = readFileSync(resolve(__dirname, "../server/supabase-storage.ts"), "utf8");
const USER = "22222222-2222-4222-8222-222222222222";
const SELF = "11111111-1111-4111-8111-111111111111";
const LIVE = "33333333-3333-4333-8333-333333333333";
const DEAD = "44444444-4444-4444-8444-444444444444";

/** A SupabaseStorage instance without the real client: prototype + stubs. */
function bareStorage(over: Record<string, any> = {}): any {
  const s: any = Object.create(SupabaseStorage.prototype);
  s.userId = USER;
  s._timezone = "America/Los_Angeles";
  s.memoEnabled = false;
  s.memoCache = new Map();
  s.logActivity = () => {};
  Object.assign(s, over);
  return s;
}

/**
 * A permissive supabase-js query-builder double: every builder method returns
 * the chain, awaiting it resolves what `respond(table, op)` says. `calls`
 * records every (table, op, payload) so tests can assert on the writes.
 */
function chainClient(respond: (table: string, op: string, payload?: any) => any = () => ({ data: [], error: null })) {
  const calls: Array<{ table: string; op: string; payload?: any; filters: Array<[string, any]> }> = [];
  const from = (table: string) => {
    const rec = { table, op: "select", payload: undefined as any, filters: [] as Array<[string, any]> };
    calls.push(rec);
    const chain: any = {};
    for (const op of ["select", "update", "insert", "upsert", "delete"]) {
      chain[op] = (payload?: any) => { if (op !== "select" || rec.op === "select") { if (op !== "select") { rec.op = op; rec.payload = payload; } } return chain; };
    }
    for (const f of ["eq", "is", "gte", "lte", "in", "not", "order", "limit", "ilike", "contains", "or", "range"]) {
      chain[f] = (...args: any[]) => { rec.filters.push([f, args]); return chain; };
    }
    const result = () => Promise.resolve(respond(table, rec.op, rec.payload));
    chain.maybeSingle = () => result().then((r: any) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
    chain.single = chain.maybeSingle;
    chain.then = (res: any, rej?: any) => result().then(res, rej);
    return chain;
  };
  return { client: { from }, calls };
}

afterEach(() => { vi.useRealTimers(); });

// ─────────────────────────────────────────────────────────────────────────────
// #1 createObligation must not convert a same-named loan into a bill
// ─────────────────────────────────────────────────────────────────────────────
describe("#1 createObligation: a same-named loan keeps its identity", () => {
  const self = { id: SELF, type: "self", name: "Me", fields: {} };
  const loan = { id: LIVE, type: "liability", type_key: "auto_loan", name: "Car Loan", parentProfileId: SELF, fields: { principal: 20000, apr: 6 } };

  function obligationStorage(profiles: any[]) {
    const updateProfile = vi.fn(async () => undefined);
    const createProfile = vi.fn(async (d: any) => ({ id: "bill-new", ...d }));
    const s = bareStorage({
      getProfiles: async () => profiles,
      getSelfProfile: async () => self,
      updateProfile, createProfile,
      ensureAutoOwnerLink: async () => undefined,
      getObligation: async (id: string) => ({ id, name: "x" }),
    });
    return { s, updateProfile, createProfile };
  }

  it("isRecurringBillShell: bills and bare shells qualify, loans/cards do not", () => {
    expect(isRecurringBillShell({ type_key: "utility" })).toBe(true);
    expect(isRecurringBillShell({ type_key: null })).toBe(true);
    expect(isRecurringBillShell({})).toBe(true);
    expect(isRecurringBillShell({ type_key: "auto_loan" })).toBe(false);
    expect(isRecurringBillShell({ typeKey: "credit_card" })).toBe(false);
    expect(isRecurringBillShell({ type_key: "medical_debt" })).toBe(false);
  });

  it("creates a SEPARATE bill linked to the loan instead of overwriting the loan's type_key", async () => {
    const { s, updateProfile, createProfile } = obligationStorage([self, loan]);
    const res = await s.createObligation({ name: "Car Loan payment", amount: 400, frequency: "monthly", nextDueDate: "2026-09-15" });
    expect(res.id).toBe("bill-new");
    // The loan row was never touched.
    expect(updateProfile).not.toHaveBeenCalled();
    // A new recurring-bill profile, related to the loan it pays.
    expect(createProfile).toHaveBeenCalledTimes(1);
    const arg = createProfile.mock.calls[0][0] as any;
    expect(arg.type).toBe("liability");
    expect(arg.type_key).toBe("bill");
    expect(arg.name).toBe("Car Loan payment");
    expect(arg.fields.linkedLiabilityId).toBe(LIVE);
    expect(arg.fields.monthlyAmount).toBe(400);
  });

  it("still upserts a bare liability shell (no type_key) of the same name", async () => {
    const shell = { ...loan, type_key: undefined, name: "Water", fields: {} };
    const { s, updateProfile, createProfile } = obligationStorage([self, shell]);
    // normLiabilityName: "Water payment" ≡ "Water".
    await s.createObligation({ name: "Water payment", amount: 60 });
    expect(createProfile).not.toHaveBeenCalled();
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect((updateProfile.mock.calls[0] as any)[0]).toBe(LIVE);
    expect((updateProfile.mock.calls[0] as any)[1].type_key).toBe("utility");
  });

  it("still upserts an existing recurring bill of the same name (idempotent create)", async () => {
    const bill = { ...loan, type_key: "utility", name: "Water", fields: { monthlyAmount: 50 } };
    const { s, updateProfile, createProfile } = obligationStorage([self, bill]);
    await s.createObligation({ name: "Water", amount: 60 });
    expect(createProfile).not.toHaveBeenCalled();
    expect(updateProfile).toHaveBeenCalledTimes(1);
    const patch = (updateProfile.mock.calls[0] as any)[1];
    expect(patch.fields.monthlyAmount).toBe(60);
    expect(patch.fields.linkedLiabilityId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 / #3 cascading writes invalidate everything
// ─────────────────────────────────────────────────────────────────────────────
describe("#2 deleteProfile (and everything that cascades) maps to the everything domain", () => {
  it("method-level override beats the Profile noun", () => {
    expect(targetForStorageMethod("deleteProfile")!.domains).toEqual(["everything"]);
    expect(targetForStorageMethod("deleteObligation")!.domains).toEqual(["everything"]);
    expect(targetForStorageMethod("mergeProfiles")!.domains).toEqual(["everything"]);
    expect(targetForStorageMethod("unmergeProfiles")!.domains).toEqual(["everything"]);
    // A plain profile write is unchanged.
    expect(targetForStorageMethod("updateProfile")!.domains).not.toContain("everything");
    for (const t of Object.values(STORAGE_METHOD_TARGETS)) expect(t.domains).toContain("everything");
  });

  it("a request that deleted a profile drains an everything manifest", () => {
    const journal = createWriteJournal();
    writeJournalContext.run(journal, () => journalStorageCall("deleteProfile", ["p1"], true));
    const m = journal.drain();
    expect(m.domains).toContain("everything");
    expect(m.changes).toEqual([{ op: "delete", endpoint: "/api/profiles", id: "p1" }]);
  });
});

describe("#3 merge_profiles reports its raw-row writes to the caches", () => {
  const PROFILES = [
    { id: SELF, type: "self", name: "Me" },
    { id: LIVE, type: "person", name: "Mike" },
    { id: DEAD, type: "person", name: "Mike Smith" },
  ];
  function mergeStorage(extra: Record<string, any> = {}) {
    const plans = new Map<string, any>();
    const { client } = chainClient(() => ({ data: [], error: null }));
    return {
      supabase: client, userId: USER,
      getProfiles: async () => PROFILES,
      getTasks: async () => [], getExpenses: async () => [], getIncomes: async () => [],
      getEvents: async () => [], getHabits: async () => [], getTrackers: async () => [],
      getGoals: async () => [], getObligations: async () => [], getJournalEntries: async () => [],
      getArtifacts: async () => [], getDocuments: async () => [],
      createAiBulkPlan: async (p: any) => { const row = { id: `plan-${plans.size + 1}`, status: "pending", ...p }; plans.set(row.id, row); return row; },
      getAiBulkPlan: async (id: string) => plans.get(id),
      setAiBulkPlanStatus: async (id: string, status: string, patch?: any) => { const r = plans.get(id); if (r) Object.assign(r, { status }, patch || {}); },
      createAiActionLog: async () => undefined,
      _plans: plans,
      ...extra,
    } as any;
  }

  it("inside a request: the write journal ends up with everything", async () => {
    const storage = mergeStorage();
    const plan = await planMergeProfiles(storage, "Mike Smith", "Mike");
    const journal = createWriteJournal();
    const res = await writeJournalContext.run(journal, () => executeMergeProfiles(storage, storage._plans.get(plan.plan_id)));
    expect(res.executed).toBe(true);
    expect(journal.dirty).toBe(true);
    expect(journal.drain().domains).toContain("everything");
  });

  it("outside a request: the account-wide epoch is bumped directly", async () => {
    const bumpDataVersions = vi.fn(async () => ({ epoch: 9 }));
    const storage = mergeStorage({ bumpDataVersions });
    const plan = await planMergeProfiles(storage, "Mike Smith", "Mike");
    const res = await executeMergeProfiles(storage, storage._plans.get(plan.plan_id));
    expect(res.executed).toBe(true);
    // [] is how bumpDataVersionNow tells the RPC "move the epoch".
    expect(bumpDataVersions).toHaveBeenCalledWith([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4 calendar dedup — whole names, obligations keyed by source row
// ─────────────────────────────────────────────────────────────────────────────
describe("#4 getCalendarTimeline dedup", () => {
  const D = "2026-09-05";
  it("keeps an event whose title merely CONTAINS a bill name", () => {
    const items = [
      { id: "b1", type: "obligation", title: "Rent", date: D, sourceId: "rent" },
      { id: "b2", type: "obligation", title: "Water", date: D, sourceId: "water" },
      { id: "e1", type: "event", title: "Parent-teacher conference", date: D, sourceId: "ev1" },
      { id: "e2", type: "event", title: "Water polo", date: D, sourceId: "ev2" },
    ];
    expect(dedupCalendarTimelineItems(items).map(i => i.id)).toEqual(["b1", "b2", "e1", "e2"]);
  });
  it("drops an event that IS the bill (same normalized name, same date)", () => {
    const items = [
      { id: "b1", type: "obligation", title: "Rent", date: D, sourceId: "rent" },
      { id: "e1", type: "event", title: "💵 Rent — $1200", date: D, sourceId: "ev1" },
      { id: "e2", type: "event", title: "Rent payment", date: D, sourceId: "ev2" },
      { id: "e3", type: "event", title: "Rent", date: "2026-09-06", sourceId: "ev3" }, // other day
    ];
    expect(dedupCalendarTimelineItems(items).map(i => i.id)).toEqual(["b1", "e3"]);
  });
  it("keeps two DIFFERENT bills that share a name on one date, and collapses one bill's duplicate rows", () => {
    const items = [
      { id: "b1", type: "obligation", title: "Phone", date: D, sourceId: "phone-me" },
      { id: "b2", type: "obligation", title: "Phone", date: D, sourceId: "phone-bob" },
      { id: "b3", type: "obligation", title: "Phone", date: D, sourceId: "phone-me" },
    ];
    expect(dedupCalendarTimelineItems(items).map(i => i.id)).toEqual(["b1", "b2"]);
  });
  it("calendarTitleKey", () => {
    expect(calendarTitleKey("💧 Water Bill — $42.10")).toBe("water");
    expect(calendarTitleKey("Water polo")).toBe("water polo");
    expect(calendarTitleKey("Pay rent")).toBe("rent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5 / #6 dashboard day math in the user's zone
// ─────────────────────────────────────────────────────────────────────────────
describe("#5 upcomingBills daysUntil is a whole-day difference of calendar dates", () => {
  it("a bill due today is due_today all day, not overdue after 5 pm Pacific", () => {
    // 00:30Z on Sep 2 = 5:30 pm Pacific on Sep 1.
    const now = new Date("2026-09-02T00:30:00Z");
    const today = getUserToday("America/Los_Angeles"); // real clock — only used for shape
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const userToday = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    expect(userToday).toBe("2026-09-01");
    expect(calendarDaysUntil("2026-09-01", userToday)).toBe(0);
    expect(calendarDaysUntil("2026-09-03", userToday)).toBe(2);
    expect(calendarDaysUntil("2026-08-30", userToday)).toBe(-2);
    // The old instant math: ceil((UTC-midnight Sep 1 − Sep 2 00:30Z) / day) = −1 → "overdue".
    expect(Math.ceil((new Date("2026-09-01").getTime() - now.getTime()) / 86400000)).toBe(-1);
    expect(Number.isNaN(calendarDaysUntil("garbage", userToday))).toBe(true);
  });
  it("the storage method reads the user's today, not an instant", () => {
    const i = SRC.indexOf("const upcomingBills = allObligations");
    const body = SRC.slice(i, i + 900);
    expect(body).toContain("calendarDaysUntil(o.nextDueDate, today, this._timezone)");
    expect(body).not.toContain("new Date(o.nextDueDate).getTime() - now.getTime()");
  });
});

describe("#6 hydration dailyTotal compares the entry's LOCAL day", () => {
  it("counts a 7 pm Pacific glass toward today, not tomorrow", () => {
    const entries = [
      { timestamp: "2026-09-02T02:00:00Z", values: { ounces: 16 } }, // Sep 1, 7 pm Pacific
      { timestamp: "2026-09-01T15:00:00Z", values: { ounces: 8 } },  // Sep 1, 8 am Pacific
      { timestamp: "2026-09-02T16:00:00Z", values: { ounces: 12 } }, // Sep 2 Pacific
    ];
    expect(hydrationDailyTotal(entries, "ounces", "2026-09-01", "America/Los_Angeles")).toBe(24);
    expect(hydrationDailyTotal(entries, "ounces", "2026-09-02", "America/Los_Angeles")).toBe(12);
    // The old prefix test would have put the 7 pm glass on Sep 2.
    expect(entries.filter(e => e.timestamp.startsWith("2026-09-02")).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #7 updateTrackerEntry runs the same unit + value gate as logEntry
// ─────────────────────────────────────────────────────────────────────────────
describe("#7 updateTrackerEntry gates the patch like logEntry", () => {
  function entryStorage(tracker: any, existingRow: any) {
    const captured: { update: any } = { update: null };
    const { client } = chainClient((table, op, payload) => {
      if (table !== "tracker_entries") return { data: [], error: null };
      if (op === "update") { captured.update = payload; return { data: [{ ...existingRow, ...payload }], error: null }; }
      return { data: [existingRow], error: null };
    });
    const s = bareStorage({ supabase: client, getTracker: async () => tracker });
    return { s, captured };
  }
  const row = { id: "e1", tracker_id: "t1", user_id: USER, entry_values: { weight: 180 }, computed: { validated: true }, timestamp: "2026-09-01T12:00:00Z" };

  it("converts '80 kg' into the tracker's pounds instead of storing a bare 80", async () => {
    const { s, captured } = entryStorage({ id: "t1", name: "Weight", category: "health", unit: "lbs", fields: [{ name: "weight", type: "number", unit: "lbs", isPrimary: true }] }, row);
    const out = await s.updateTrackerEntry("t1", "e1", { values: { weight: "80 kg" } });
    expect(typeof captured.update.entry_values.weight).toBe("number");
    expect(captured.update.entry_values.weight).toBeGreaterThan(175);
    expect(captured.update.entry_values.weight).toBeLessThan(178);
    expect(out.values.weight).toBe(captured.update.entry_values.weight);
  });

  it("rejects 8000 hours of sleep with the guard's error (→ 400), and writes nothing", async () => {
    const { s, captured } = entryStorage({ id: "t1", name: "Sleep", category: "sleep", fields: [{ name: "hours", type: "number", isPrimary: true }] }, { ...row, entry_values: { hours: 7 } });
    await expect(s.updateTrackerEntry("t1", "e1", { values: { hours: 8000 } })).rejects.toThrow(/impossible|Max/);
    expect(captured.update).toBeNull();
  });

  it("an edit of one field is not blocked by a legacy value in another (the patch is gated, then merged)", async () => {
    const { s, captured } = entryStorage({ id: "t1", name: "Sleep", category: "sleep", fields: [{ name: "hours", type: "number" }, { name: "quality", type: "text" }] }, { ...row, entry_values: { hours: 8000, quality: "ok" } });
    await s.updateTrackerEntry("t1", "e1", { values: { quality: "good" } });
    expect(captured.update.entry_values).toEqual({ hours: 8000, quality: "good" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #8 updateIncome reads the row back by id
// ─────────────────────────────────────────────────────────────────────────────
describe("#8 updateIncome returns the persisted row, not the memoized pre-update list", () => {
  it("amount comes from the DB read-back", async () => {
    const dbRow = { id: "i1", description: "Salary", amount: 6000, category: "salary", frequency: "monthly", linked_profiles: [SELF], tags: [] };
    const { client, calls } = chainClient((table, op) => table === "incomes" && op === "select" ? { data: [dbRow], error: null } : { data: [], error: null });
    const s = bareStorage({
      supabase: client,
      // The request memo still holds the PRE-update row.
      getIncomes: async () => [{ id: "i1", description: "Salary", amount: 5000 }],
    });
    const out = await s.updateIncome("i1", { amount: 6000 });
    expect(out.amount).toBe(6000);
    expect(out.linkedProfiles).toEqual([SELF]);
    const read = calls.find(c => c.table === "incomes" && c.op === "select")!;
    expect(read.filters).toEqual(expect.arrayContaining([["eq", ["id", "i1"]]]));
  });
  it("no other update method returns out of a memoized list", () => {
    expect(SRC).not.toMatch(/const all = await this\.get\w+s\(\);\s*\n\s*return all\.find/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #9 computeGoalProgress — the user's month
// ─────────────────────────────────────────────────────────────────────────────
describe("#9 computeGoalProgress uses the user's current month", () => {
  it("counts an entry logged at 7 pm Pacific on Aug 31 in August, and Aug 1 (a date-only expense) in August", async () => {
    // 03:00Z Sep 1 = 8 pm Pacific Aug 31: the user's month is still August.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T03:00:00Z"));
    const tracker = {
      id: "t1", name: "Running", category: "fitness", fields: [], entries: [
        { id: "a", timestamp: "2026-09-01T02:00:00Z", values: { distance: 3 }, computed: {} }, // Aug 31 Pacific
        { id: "b", timestamp: "2026-08-01T12:00:00Z", values: { distance: 2 }, computed: {} },
        { id: "c", timestamp: "2026-07-31T12:00:00Z", values: { distance: 5 }, computed: {} },
      ],
    };
    const s = bareStorage({
      getTracker: async () => tracker,
      getExpenses: async () => [
        { id: "x1", date: "2026-08-01", amount: 40, category: "Food" },
        { id: "x2", date: "2026-08-31", amount: 10, category: "Food" },
        { id: "x3", date: "2026-07-31", amount: 99, category: "Food" },
        { id: "x4", date: "2026-08-15", amount: 7, category: "Gas" },
      ],
    });
    const distance = await s.computeGoalProgress({ type: "fitness_distance", trackerId: "t1", current: 0 });
    expect(distance).toBe(5);
    const freq = await s.computeGoalProgress({ type: "fitness_frequency", trackerId: "t1", current: 0 });
    expect(freq).toBe(2);
    const spend = await s.computeGoalProgress({ type: "spending_limit", category: "food", current: 0 });
    expect(spend).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #10 undated tasks land on their creation day in the user's zone
// ─────────────────────────────────────────────────────────────────────────────
describe("#10 getCalendarTimeline places undated tasks on the LOCAL creation day", () => {
  it("source: createdAt goes through localDayOf, not slice(0,10)", () => {
    const i = SRC.indexOf("async getCalendarTimeline(");
    const j = SRC.indexOf("for (const task of tasks)", i);
    const body = SRC.slice(j, j + 1800);
    expect(body).toContain("localDayOf(rawDate, this._timezone)");
    expect(body).not.toMatch(/rawDate\.slice\(0, 10\) >= startDate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #11 logEntry dedup: the mirror bypass and the entry's own timestamp
// ─────────────────────────────────────────────────────────────────────────────
describe("#11 logEntry dedup", () => {
  const TRACKER = { id: "t1", name: "Hydration", category: "health", fields: [{ name: "ounces", type: "number", unit: "oz" }], entries: [] };
  function logStorage(recent: any[]) {
    const inserts: any[] = [];
    const { client, calls } = chainClient((table, op, payload) => {
      if (table !== "tracker_entries") return { data: [], error: null };
      if (op === "insert") { inserts.push(payload); return { data: [payload], error: null }; }
      return { data: recent, error: null };
    });
    const s = bareStorage({ supabase: client, getTracker: async () => TRACKER });
    return { s, inserts, calls };
  }
  const nowIso = () => new Date().toISOString();

  it("still swallows an accidental double-fire (identical values, same moment)", async () => {
    const { s, inserts } = logStorage([{ id: "first", entry_values: { ounces: 24 }, timestamp: nowIso() }]);
    const out = await s.logEntry({ trackerId: "t1", values: { ounces: 24 } });
    expect(out.id).toBe("first");
    expect(inserts).toHaveLength(0);
  });

  it("__skipDedupe (the habit mirror) writes a distinct row even with identical values", async () => {
    const { s, inserts } = logStorage([{ id: "first", entry_values: { completions: 1, [HABIT_MIRROR_KEY]: "h1" }, timestamp: nowIso() }]);
    const out = await s.logEntry({ trackerId: "t1", values: { completions: 1, [HABIT_MIRROR_KEY]: "h1" }, __skipHabitSync: true, __skipDedupe: true });
    expect(inserts).toHaveLength(1);
    expect(out.id).not.toBe("first");
  });

  it("a backdated identical entry ('also 180 for yesterday') is not dropped against today's row", async () => {
    const { s, inserts, calls } = logStorage([{ id: "today", entry_values: { ounces: 24 }, timestamp: nowIso() }]);
    const yesterdayNoon = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const out = await s.logEntry({ trackerId: "t1", values: { ounces: 24 }, timestamp: yesterdayNoon });
    expect(inserts).toHaveLength(1);
    expect(out.id).not.toBe("today");
    // The window was anchored on the entry's timestamp, not the wall clock.
    const q = calls.find(c => c.table === "tracker_entries" && c.op === "select")!;
    const gte = q.filters.find(f => f[0] === "gte")![1] as any[];
    expect(Math.abs(Date.parse(gte[1]) - (Date.parse(yesterdayNoon) - 5 * 60 * 1000))).toBeLessThan(1000);
  });

  it("completeHabitOccurrence marks every mirror entry with __skipDedupe and writes one per check-in", async () => {
    const today = getUserToday("UTC");
    const habit: any = { id: "h1", name: "Drink water", frequency: "daily", targetPerDay: 2, linkedTrackerId: "t1", checkins: [], linkedProfiles: [] };
    const logged: any[] = [];
    const storage: any = {
      getHabit: async () => habit,
      getHabits: async () => [habit],
      checkinHabit: async (_id: string, date: string) => { const c = { id: `c${habit.checkins.length + 1}`, date, timestamp: nowIso() }; habit.checkins.push(c); return c; },
      deleteHabitCheckin: async () => true,
      updateHabit: async () => habit,
      getTracker: async () => ({ id: "t1", name: "Hydration", fields: [{ name: "completions", type: "number" }], entries: [] }),
      getTrackers: async () => [], createTracker: async () => { throw new Error("unexpected"); },
      updateTracker: async () => undefined,
      logEntry: async (d: any) => { logged.push(d); return { id: `e${logged.length}`, values: d.values, timestamp: d.timestamp }; },
      deleteTrackerEntry: async () => true,
      getProfiles: async () => [],
    };
    const res = await completeHabitOccurrence(storage, { habitId: "h1", source: "habit_ui", count: 2, date: today, timezone: "UTC" });
    expect(res.recorded).toBe(2);
    expect(logged).toHaveLength(2);
    for (const d of logged) {
      expect(d.__skipDedupe).toBe(true);
      expect(d.__skipHabitSync).toBe(true);
      expect(d.values[HABIT_MIRROR_KEY]).toBe("h1");
    }
    expect(res.trackerEntries.map(e => e.id)).toEqual(["e1", "e2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #12 deleteTracker clears habit links; completion re-resolves a dangling one
// ─────────────────────────────────────────────────────────────────────────────
describe("#12 deleted trackers do not leave habits dangling", () => {
  it("SupabaseStorage.deleteTracker nulls habits.linked_tracker_id", async () => {
    const { client, calls } = chainClient(() => ({ data: [], error: null }));
    const s = bareStorage({ supabase: client, cleanupEntityLinks: async () => undefined });
    expect(await s.deleteTracker("t1")).toBe(true);
    const unlink = calls.find(c => c.table === "habits" && c.op === "update")!;
    expect(unlink.payload).toEqual({ linked_tracker_id: null });
    expect(unlink.filters).toEqual(expect.arrayContaining([["eq", ["linked_tracker_id", "t1"]], ["eq", ["user_id", USER]]]));
  });

  it("MemStorage.deleteTracker clears the link too", async () => {
    const m = new MemStorage("u-1");
    const t = await m.createTracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }] } as any);
    const h = await m.createHabit({ name: "Run", frequency: "daily", linkedTrackerId: t.id } as any);
    expect((await m.getHabit(h.id))!.linkedTrackerId).toBe(t.id);
    await m.deleteTracker(t.id);
    expect((await m.getHabit(h.id))!.linkedTrackerId).toBeFalsy();
  });

  it("completeHabitOccurrence re-links a habit whose tracker is gone and mirrors into the new one", async () => {
    const today = getUserToday("UTC");
    const habit: any = { id: "h1", name: "Run", frequency: "daily", targetPerDay: 1, linkedTrackerId: "gone", checkins: [], linkedProfiles: [] };
    const logged: any[] = [];
    const updates: any[] = [];
    const fresh = { id: "t-new", name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }], entries: [], linkedProfiles: [] };
    const storage: any = {
      getHabit: async () => habit,
      getHabits: async () => [habit],
      checkinHabit: async (_id: string, date: string) => { const c = { id: "c1", date, timestamp: new Date().toISOString() }; habit.checkins.push(c); return c; },
      deleteHabitCheckin: async () => true,
      updateHabit: async (_id: string, d: any) => { updates.push(d); Object.assign(habit, d); return habit; },
      getTracker: async (id: string) => (id === "t-new" ? fresh : undefined),
      getTrackers: async () => [],
      createTracker: async () => fresh,
      updateTracker: async () => undefined,
      logEntry: async (d: any) => { logged.push(d); return { id: "e1", values: d.values, timestamp: d.timestamp }; },
      deleteTrackerEntry: async () => true,
      getProfiles: async () => [{ id: SELF, type: "self" }],
    };
    const res = await completeHabitOccurrence(storage, { habitId: "h1", source: "habit_ui", date: today, timezone: "UTC" });
    expect(res.ok).toBe(true);
    expect(updates).toEqual([{ linkedTrackerId: "t-new" }]);
    expect(res.tracker?.id).toBe("t-new");
    expect(logged).toHaveLength(1);
    expect(logged[0].trackerId).toBe("t-new");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #13 restore drops owners that no longer exist
// ─────────────────────────────────────────────────────────────────────────────
describe("#13 restoring a row re-owns it to live profiles", () => {
  function restoreStorage(table: string, restoredRow: any, live: string[]) {
    const reowned: any[] = [];
    const { client, calls } = chainClient((t, op) => {
      if (t === table && op === "update") return { data: [restoredRow], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({
      supabase: client,
      getProfilesLite: async () => live.map(id => ({ id })),
      getSelfProfile: async () => ({ id: SELF, type: "self" }),
      applyOwnershipPatch: async (type: string, id: string, owners: string[]) => { reowned.push({ type, id, owners }); },
    });
    return { s, reowned, calls };
  }

  it("restoreTask keeps the live owner and drops the deleted one", async () => {
    const { s, reowned } = restoreStorage("tasks", { id: "t1", linked_profiles: [DEAD, LIVE] }, [SELF, LIVE]);
    expect(await s.restoreTask("t1")).toBe(true);
    expect(reowned).toEqual([{ type: "task", id: "t1", owners: [LIVE] }]);
  });

  it("restoreExpense (via restoreEntity) falls back to self when every owner is gone", async () => {
    const { s, reowned } = restoreStorage("expenses", { id: "x1", linked_profiles: [DEAD], amount: 5 }, [SELF]);
    expect(await s.restoreEntity("expense", "x1")).toBe(true);
    expect(reowned).toEqual([{ type: "expense", id: "x1", owners: [SELF] }]);
  });

  it("restoreHabit / restoreGoal go through the same check; intact owners write nothing", async () => {
    const h = restoreStorage("habits", { id: "h1", linked_tracker_id: null, linked_profiles: [LIVE] }, [SELF, LIVE]);
    expect(await h.s.restoreHabit("h1")).toBe(true);
    expect(h.reowned).toEqual([]);
    const g = restoreStorage("goals", { id: "g1", linked_profiles: [DEAD, LIVE] }, [SELF, LIVE]);
    expect(await g.s.restoreGoal("g1")).toBe(true);
    expect(g.reowned).toEqual([{ type: "goal", id: "g1", owners: [LIVE] }]);
  });

  it("restoreDocument re-links only the surviving owners", async () => {
    const linked: string[] = [];
    const { s, reowned } = restoreStorage("documents", { id: "d1", linked_profiles: [DEAD, LIVE] }, [SELF, LIVE]);
    s.getProfile = async (id: string) => { linked.push(id); return id === LIVE ? { id, documents: [] } : undefined; };
    expect(await s.restoreDocument("d1")).toBe(true);
    expect(reowned).toEqual([{ type: "document", id: "d1", owners: [LIVE] }]);
    expect(linked).toEqual([LIVE]);
  });

  it("a table with no owners column (reminders) restores untouched", async () => {
    const { s, reowned } = restoreStorage("reminders", { id: "r1", title: "x" }, [SELF]);
    expect(await s.restoreEntity("reminder", "r1")).toBe(true);
    expect(reowned).toEqual([]);
  });

  it("every restore* method funnels through the one helper", () => {
    for (const m of ["restoreTask", "restoreHabit", "restoreGoal", "restoreDocument", "restoreEntity"]) {
      const i = SRC.indexOf(`async ${m}(`);
      expect(i, m).toBeGreaterThan(-1);
      const body = SRC.slice(i, SRC.indexOf("\n  async ", i + 10));
      expect(body, m).toContain("_reownRestoredRow(");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #14 spawnNextRecurringTask uses the shared recurrence step
// ─────────────────────────────────────────────────────────────────────────────
describe("#14 spawnNextRecurringTask follows shared/recurrence", () => {
  function spawnStorage(tz = "America/Los_Angeles", liveTasks: any[] = []) {
    const created: any[] = [];
    const { client, calls } = chainClient((table, op) => {
      if (table !== "tasks" || op !== "select") return { data: [], error: null };
      // The double ignores filters; return rows for the requested due date.
      const wanted = calls[calls.length - 1].filters.find(f => f[0] === "eq" && f[1][0] === "due_date")?.[1][1];
      return { data: liveTasks.filter(t => t.due_date === wanted), error: null };
    });
    const s = bareStorage({ _timezone: tz, supabase: client, createTask: async (d: any) => { created.push(d); return { id: "next", ...d }; } });
    return { s, created, calls };
  }
  const prev = (over: any) => ({ id: "p", title: "Pay rent", priority: "medium", dueTime: "09:00", linkedProfiles: [SELF], ...over });

  it("every-2-weeks / weekdays / yearly spawn (they used to spawn nothing)", async () => {
    const { s, created } = spawnStorage();
    await s.spawnNextRecurringTask(prev({ dueDate: "2026-09-01", tags: ["recur:every-2-weeks"] }), "every-2-weeks");
    await s.spawnNextRecurringTask(prev({ dueDate: "2026-09-04", tags: ["recur:weekdays"] }), "weekdays"); // Friday
    await s.spawnNextRecurringTask(prev({ dueDate: "2028-02-29", tags: ["recur:yearly"] }), "yearly"); // leap day
    expect(created.map(c => c.dueDate)).toEqual(["2026-09-15", "2026-09-07", "2029-02-28"]);
    expect(created[0].tags).toContain("rdone:1");
    expect(created[0].dueTime).toBe("09:00");
    expect(created[0].linkedProfiles).toEqual([SELF]);
  });

  it("monthly keeps the 31st through February", async () => {
    // Pinned clock: a late completion steps to the first anchor date on or
    // after the user's today (D151), so the chore must not be overdue here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T20:00:00Z"));
    const { s, created } = spawnStorage();
    await s.spawnNextRecurringTask(prev({ dueDate: "2026-01-31", tags: ["recur:monthly"] }), "monthly");
    expect(created[0].dueDate).toBe("2026-02-28");
    expect(created[0].tags).toContain("ranchor:31");
    await s.spawnNextRecurringTask(prev({ dueDate: created[0].dueDate, tags: created[0].tags }), "monthly");
    expect(created[1].dueDate).toBe("2026-03-31");
  });

  it("runtil: / rcount: end the series instead of being ignored", async () => {
    const { s, created } = spawnStorage();
    await s.spawnNextRecurringTask(prev({ dueDate: "2026-09-01", tags: ["recur:weekly", "runtil:2026-09-05"] }), "weekly");
    await s.spawnNextRecurringTask(prev({ dueDate: "2026-09-01", tags: ["recur:daily", "rcount:2", "rdone:1"] }), "daily");
    expect(created).toEqual([]);
  });

  it("an undated chore steps from the USER's today, not the host clock", async () => {
    const tz = "Pacific/Kiritimati"; // UTC+14 — a different calendar day from UTC for most of the day
    const { s, created } = spawnStorage(tz);
    await s.spawnNextRecurringTask(prev({ dueDate: undefined, tags: ["recur:daily"] }), "daily");
    expect(created[0].dueDate).toBe(addDays(getUserToday(tz), 1));
  });

  it("is idempotent: un-checking and re-checking does not clone the next occurrence twice", async () => {
    // First completion spawned "mow lawn" for +7d; the row is live.
    const existing = { id: "clone-1", title: "Mow lawn", linked_profiles: [SELF], due_date: "2026-09-08" };
    const { s, created, calls } = spawnStorage("America/Los_Angeles", [existing]);
    await s.spawnNextRecurringTask(prev({ title: "mow lawn", dueDate: "2026-09-01", tags: ["recur:weekly"] }), "weekly");
    expect(created).toEqual([]);
    // The check reads the DB directly, scoped to the user and to live rows.
    const q = calls.find(c => c.table === "tasks")!;
    expect(q.filters).toEqual(expect.arrayContaining([["eq", ["user_id", USER]], ["is", ["deleted_at", null]], ["eq", ["due_date", "2026-09-08"]]]));
  });

  it("a different owner's or a differently named task on that date does not block the spawn", async () => {
    const other = { id: "x", title: "Mow lawn", linked_profiles: [LIVE], due_date: "2026-09-08" };
    const named = { id: "y", title: "Mow lawn edges", linked_profiles: [SELF], due_date: "2026-09-08" };
    const { s, created } = spawnStorage("America/Los_Angeles", [other, named]);
    await s.spawnNextRecurringTask(prev({ title: "Mow lawn", dueDate: "2026-09-01", tags: ["recur:weekly"] }), "weekly");
    expect(created.map(c => c.dueDate)).toEqual(["2026-09-08"]);
  });

  it("the caller still only spawns on the todo → done transition of a recur: task (source)", () => {
    const i = SRC.indexOf("async updateTask(");
    const body = SRC.slice(i, SRC.indexOf("spawnNextRecurringTask(existing", i) + 60);
    expect(body).toContain('data.status === "done" && existing.status !== "done"');
    expect(body).toContain('startsWith("recur:")');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #15 budget writers surface Supabase errors
// ─────────────────────────────────────────────────────────────────────────────
describe("#15 setBudgets / addBudget / updateBudget throw on a failed write", () => {
  function budgetStorage(fail: { read?: boolean; update?: boolean; insert?: boolean }, existingRow: any) {
    const { client, calls } = chainClient((table, op) => {
      if (table !== "preferences") return { data: [], error: null };
      if (op === "select") return fail.read ? { data: null, error: { message: "read boom" } } : { data: existingRow ? [existingRow] : [], error: null };
      if (op === "update") return fail.update ? { data: null, error: { message: "update boom" } } : { data: [existingRow], error: null };
      if (op === "insert") return fail.insert ? { data: null, error: { message: "insert boom" } } : { data: [], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getBudgets: async () => [{ id: "b1", category: "Food", amount: 100 }] });
    return { s, calls };
  }
  const budgets = [{ id: "b1", category: "Food", amount: 100 }];

  it("a failed UPDATE is thrown, not swallowed", async () => {
    const { s } = budgetStorage({ update: true }, { id: "pref-1" });
    await expect(s.setBudgets("2026-09", budgets)).rejects.toMatchObject({ message: "update boom" });
  });
  it("a failed INSERT is thrown, not swallowed", async () => {
    const { s } = budgetStorage({ insert: true }, null);
    await expect(s.setBudgets("2026-09", budgets)).rejects.toMatchObject({ message: "insert boom" });
  });
  it("a failed read is thrown too (otherwise a blind insert duplicates the row)", async () => {
    const { s } = budgetStorage({ read: true }, null);
    await expect(s.setBudgets("2026-09", budgets)).rejects.toMatchObject({ message: "read boom" });
  });
  it("addBudget / updateBudget propagate the failure instead of answering success", async () => {
    // The row carries the current list (the atomic writer reads and
    // compare-and-swaps the row's value), so both writes have a change to
    // make and meet the failing UPDATE.
    const { s } = budgetStorage({ update: true }, { id: "pref-1", value: JSON.stringify(budgets) });
    await expect(s.addBudget("2026-09", "Fuel", 250)).rejects.toMatchObject({ message: "update boom" });
    await expect(s.updateBudget("2026-09", "b1", { amount: 250 })).rejects.toMatchObject({ message: "update boom" });
  });
  it("a successful write resolves, and the update is scoped to the user", async () => {
    const { s, calls } = budgetStorage({}, { id: "pref-1" });
    await expect(s.setBudgets("2026-09", budgets)).resolves.toBeUndefined();
    const upd = calls.find(c => c.table === "preferences" && c.op === "update")!;
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", ["user_id", USER]]]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #16 tracker entries carry their trackerId
// ─────────────────────────────────────────────────────────────────────────────
describe("#16 rowToTrackerEntry / getTrackerEntry include trackerId", () => {
  const row = { id: "e1", tracker_id: "t1", user_id: USER, entry_values: { ounces: 24 }, computed: {}, timestamp: "2026-09-01T12:00:00Z" };
  it("getTrackerEntry says which tracker owns the entry", async () => {
    const { client } = chainClient((table) => table === "tracker_entries" ? { data: [row], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client });
    const e = await s.getTrackerEntry("e1");
    expect(e).toMatchObject({ id: "e1", trackerId: "t1", values: { ounces: 24 } });
  });
  it("logEntry's read-back carries it too", async () => {
    const { client } = chainClient((table, op, payload) => {
      if (table !== "tracker_entries") return { data: [], error: null };
      if (op === "insert") return { data: [payload], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getTracker: async () => ({ id: "t1", name: "Hydration", category: "health", fields: [{ name: "ounces", type: "number" }], entries: [] }) });
    const e = await s.logEntry({ trackerId: "t1", values: { ounces: 8 }, __skipHabitSync: true });
    expect(e.trackerId).toBe("t1");
  });
});


// ────────────────────────────────────────────────────
// D73 createExpense: a missing date is the user's calendar day, not UTC's
// ────────────────────────────────────────────────────
describe("D73 createExpense defaults the date to the user's local today", () => {
  it("writes getUserToday(timezone), never the UTC instant's date", async () => {
    vi.useFakeTimers();
    // 18:50 UTC on Sep 2 is Sep 3 in Kiritimati (UTC+14) and Sep 2 in Los Angeles.
    vi.setSystemTime(new Date("2026-09-02T18:50:00Z"));
    for (const [tz, want] of [["Pacific/Kiritimati", "2026-09-03"], ["America/Los_Angeles", "2026-09-02"]] as const) {
      const { client, calls } = chainClient((table, op) => {
        if (table === "expenses" && op === "insert") return { data: null, error: null };
        if (table === "expenses") return { data: [{ id: "x", amount: 4, description: "coffee", date: want, linked_profiles: [], tags: [], created_at: "2026-09-02T18:50:00Z" }], error: null };
        return { data: [], error: null };
      });
      const s = bareStorage({ supabase: client, _timezone: tz,
        getSelfProfile: async () => ({ id: SELF, type: "self" }),
        applyOwnershipPatch: async () => undefined, setOwners: async () => undefined,
        getExpense: async (id: string) => ({ id, amount: 4, description: "coffee", date: want, linkedProfiles: [], tags: [] }),
        linkProfileTo: async () => true, bumpDataVersion: async () => 1, bumpDataVersions: async () => ({}),
      });
      await s.createExpense({ description: "coffee", amount: 4, category: "food" } as any);
      const ins = calls.find((c) => c.table === "expenses" && c.op === "insert");
      expect(ins?.payload?.date, tz).toBe(want);
    }
  });
});

// D76 (storage side): the obligation projection never echoes a lifecycle word.
describe("D76 canonicalObligationStatus", () => {
  it("maps lifecycle words to active and keeps paused/cancelled", async () => {
    const { canonicalObligationStatus } = await import("../server/supabase-storage");
    expect(canonicalObligationStatus("upcoming")).toBe("active");
    expect(canonicalObligationStatus("overdue")).toBe("active");
    expect(canonicalObligationStatus(undefined)).toBe("active");
    expect(canonicalObligationStatus("paused")).toBe("paused");
    expect(canonicalObligationStatus("Cancelled")).toBe("cancelled");
    expect(canonicalObligationStatus("canceled")).toBe("cancelled");
  });
});

// D77 — two completions racing past the sibling check must not spawn two clones.
describe("D77 recurring spawn clone id is deterministic per series + date", () => {
  it("derives the same uuid for the same (series row, next date) and swallows the PK clash", async () => {
    const inserted: any[] = [];
    let first = true;
    const s = bareStorage({
      supabase: chainClient((table, op, payload) => {
        if (table === "tasks" && op === "insert") {
          inserted.push(payload);
          if (!first) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          first = false; return { data: null, error: null };
        }
        return { data: [], error: null };
      }).client,
      getSelfProfile: async () => ({ id: SELF, type: "self" }),
      getTask: async (id: string) => ({ id, title: "Mow lawn", tags: ["recur:weekly"], dueDate: "2026-09-09", linkedProfiles: [SELF] }),
      applyOwnershipPatch: async () => undefined, setOwners: async () => undefined, linkProfileTo: async () => true,
      logActivity: () => {},
    });
    const prev = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Mow lawn", tags: ["recur:weekly"], dueDate: "2026-09-02", status: "done", linkedProfiles: [SELF] } as any;
    await (s as any).spawnNextRecurringTask(prev, "weekly");
    await (s as any).spawnNextRecurringTask(prev, "weekly"); // the racing twin
    expect(inserted).toHaveLength(2);
    expect(inserted[0].id).toBe(inserted[1].id);
    expect(inserted[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(inserted[0].due_date).toBe("2026-09-09");
  });
});

// D90 — the optimistic-concurrency guard was check-then-write: two edits
// carrying the same expectedUpdatedAt both passed the pre-check and both
// wrote. The write now carries the version, and a write that touches no row
// under a version is the same 409. Expense/event/habit/income rows also did
// not surface updatedAt, so a client could never guard those edits.
describe("D90: a guarded update is conditional on the version it was checked against", () => {
  const ROW_VERSION = "2026-09-02T20:06:11.746601+00:00";
  function expenseStorage(updateRows: any[]) {
    const { client, calls } = chainClient((table, op) => {
      if (table === "expenses" && op === "select") return { data: [{ updated_at: ROW_VERSION }], error: null };
      if (table === "expenses" && op === "update") return { data: updateRows, error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({
      supabase: client,
      getExpense: async (id: string) => ({ id, amount: 5, category: "general", description: "x", tags: [], date: "2026-09-02", linkedProfiles: [] }),
      applyOwnershipPatch: async () => undefined,
    });
    return { s, calls };
  }
  it("filters the UPDATE on updated_at when expectedUpdatedAt was sent, and 409s when no row matched", async () => {
    const { s, calls } = expenseStorage([]);
    await expect(s.updateExpense("exp-1", { amount: 6, expectedUpdatedAt: ROW_VERSION })).rejects.toMatchObject({ statusCode: 409 });
    const upd = calls.find(c => c.table === "expenses" && c.op === "update")!;
    expect(upd.filters).toContainEqual(["eq", ["updated_at", ROW_VERSION]]);
    expect(upd.payload.expectedUpdatedAt).toBeUndefined();
  });
  it("writes when the row still carries the version", async () => {
    const { s, calls } = expenseStorage([{ id: "exp-1" }]);
    await expect(s.updateExpense("exp-1", { amount: 6, expectedUpdatedAt: ROW_VERSION })).resolves.toBeTruthy();
    expect(calls.find(c => c.table === "expenses" && c.op === "update")!.payload.amount).toBe(6);
  });
  it("an unguarded edit never filters on updated_at (last write wins, as before)", async () => {
    const { s, calls } = expenseStorage([]);
    await expect(s.updateExpense("exp-1", { amount: 6 })).resolves.toBeTruthy();
    const upd = calls.find(c => c.table === "expenses" && c.op === "update")!;
    expect(upd.filters.some(([f, a]) => f === "eq" && a[0] === "updated_at")).toBe(false);
  });
  it("a stale expectedUpdatedAt is rejected before the write", async () => {
    const { s, calls } = expenseStorage([{ id: "exp-1" }]);
    await expect(s.updateExpense("exp-1", { amount: 6, expectedUpdatedAt: "2026-09-01T00:00:00.000Z" })).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.some(c => c.table === "expenses" && c.op === "update")).toBe(false);
  });
  it("expense, event, habit and income rows surface updatedAt", () => {
    const s = bareStorage();
    const r = { id: "r1", updated_at: ROW_VERSION, created_at: ROW_VERSION, amount: 1, linked_profiles: [], tags: [] };
    expect(s.rowToExpense(r).updatedAt).toBe(ROW_VERSION);
    expect(s.rowToEvent(r).updatedAt).toBe(ROW_VERSION);
    expect(s.rowToIncome(r).updatedAt).toBe(ROW_VERSION);
    expect(s.rowToHabit(r, []).updatedAt).toBe(ROW_VERSION);
  });
});

// D103 — a paid one-time bill kept its due date and stayed "upcoming".
describe("D103: a settled one-time bill has no next due date; recurrenceEnd rides along", () => {
  it("maps a paid once-bill to an empty nextDueDate and passes recurrenceEnd through", () => {
    const s = bareStorage();
    const once = { id: "o1", name: "Deposit", type: "liability", type_key: "bill", fields: { amount: 90, frequency: "once", dueDate: "2026-09-05", occurrences: { "2026-09-05": { status: "paid", paymentId: "p1" } } } };
    expect(s.liabilityToObligation(once).nextDueDate).toBe("");
    const unpaid = { ...once, fields: { ...once.fields, occurrences: {} } };
    expect(s.liabilityToObligation(unpaid).nextDueDate).toBe("2026-09-05");
    const monthly = { ...once, fields: { amount: 30, frequency: "monthly", dueDate: "2026-09-05", recurrenceEnd: "2026-09-01", occurrences: { "2026-09-05": { status: "paid" } } } };
    const o = s.liabilityToObligation(monthly);
    // D119: a recurring bill on a paid occurrence maps to its next unsettled
    // date — unless that date falls past recurrenceEnd, in which case the
    // series has ended (D252): no next due date, status "ended".
    expect(o.nextDueDate).toBe("");
    expect(o.status).toBe("ended");
    expect(o.recurrenceEnd).toBe("2026-09-01");
    const stillRunning = { ...monthly, fields: { ...monthly.fields, recurrenceEnd: "2026-12-31" } };
    expect(s.liabilityToObligation(stillRunning).nextDueDate).toBe("2026-10-05");
  });
});

// D108 — un-completing a recurring task left the occurrence its completion
// had spawned, so the series forked.
describe("D108: un-completing a recurring task takes back the untouched spawn", () => {
  const prevTask = { id: "p1", title: "Water plants", status: "done", dueDate: "2026-09-02", tags: ["recur:daily"], linkedProfiles: [SELF] };
  function retractStorage(cloneRow: any | null) {
    const deleted: string[] = [];
    const s = bareStorage({
      _timezone: "UTC",
      getTask: async (id: string) => (cloneRow && id === cloneRow.id ? cloneRow : undefined),
      deleteTask: async () => { throw new Error("soft delete must not be used: the clone id is deterministic"); },
      purgeTask: async (id: string) => { deleted.push(id); return true; },
    });
    return { s, deleted };
  }
  it("hard-deletes the open, unedited clone on the predicted date (so a re-completion can spawn it again)", async () => {
    const { s } = retractStorage(null);
    const cloneId = s.recurringCloneId("p1", "2026-09-03");
    const { s: s2, deleted } = retractStorage({ id: cloneId, title: "Water plants", status: "todo", dueDate: "2026-09-03" });
    expect(await s2.retractSpawnedRecurringTask(prevTask)).toBe(true);
    expect(deleted).toEqual([cloneId]);
  });
  it("keeps a clone the user completed, moved or renamed, and does nothing without a spawn", async () => {
    const { s } = retractStorage(null);
    const cloneId = s.recurringCloneId("p1", "2026-09-03");
    for (const row of [
      { id: cloneId, title: "Water plants", status: "done", dueDate: "2026-09-03" },
      { id: cloneId, title: "Water plants", status: "todo", dueDate: "2026-09-05" },
      { id: cloneId, title: "Water the garden", status: "todo", dueDate: "2026-09-03" },
    ]) {
      const { s: sx, deleted } = retractStorage(row);
      expect(await sx.retractSpawnedRecurringTask(prevTask)).toBe(false);
      expect(deleted).toEqual([]);
    }
    const { s: s3, deleted } = retractStorage(null);
    expect(await s3.retractSpawnedRecurringTask(prevTask)).toBe(false);
    expect(await s3.retractSpawnedRecurringTask({ ...prevTask, tags: [] })).toBe(false);
    expect(deleted).toEqual([]);
  });
});

// D119 — a recurring bill whose stored date is a paid occurrence showed that
// paid day as "next due".
describe("D119: a recurring bill on a settled occurrence maps to its next unsettled date", () => {
  it("advances past paid and skipped occurrences; an unsettled date is untouched", () => {
    const s = bareStorage();
    const bill = (occ: any, due = "2026-09-04") => ({ id: "b1", name: "Electric", type: "liability", type_key: "utility", fields: { amount: 92.4, frequency: "monthly", dueDate: due, firstPaymentDate: "2026-08-04", occurrences: occ } });
    expect(s.liabilityToObligation(bill({ "2026-09-04": { status: "paid" } })).nextDueDate).toBe("2026-10-04");
    expect(s.liabilityToObligation(bill({ "2026-09-04": { status: "paid" }, "2026-10-04": { status: "skipped" } })).nextDueDate).toBe("2026-11-04");
    expect(s.liabilityToObligation(bill({})).nextDueDate).toBe("2026-09-04");
  });
});

// D120 (pushdown) — every person-scoped list fetch pushed `linked_profiles
// @> [id]` down with the RAW selection, so the car's tasks, documents, bills
// and events never reached the JS filter that knows about the owner chain
// (D88) and co-ownership (D120). The storage now widens the ids once.
describe("D120: containment pushdowns match the owner chain and co-ownership", () => {
  const profiles = [
    { id: "self", type: "self", name: "Me" },
    { id: "mike", type: "person", name: "Mike" },
    { id: "linda", type: "person", name: "Linda" },
    { id: "car-1", type: "vehicle", name: "Honda", parentProfileId: "self" },
    { id: "dog-1", type: "pet", name: "Rex", parentProfileId: "mike" },
  ];
  const links = [{ id: "apl-1", assetProfileId: "car-1", partyProfileId: "linda", ownershipPercentage: 50 }];
  const liabLinks = [{ id: "lpl-1", liabilityProfileId: "loan-1", partyProfileId: "linda", ownershipPercentage: 50 }];
  function scoped() {
    const { client, calls } = chainClient(() => ({ data: [], error: null, count: 0 }));
    const s = bareStorage({ supabase: client, getProfilesLite: async () => [...profiles, { id: "loan-1", type: "liability", name: "Car loan", parentProfileId: "self" }], getAssetPartyLinks: async () => links, getLiabilityProfileLinks: async () => liabLinks });
    const orClause = (table: string) => {
      const c = calls.find((x) => x.table === table);
      const f = c?.filters.find(([k]) => k === "or");
      return f ? String(f[1][0]) : undefined;
    };
    return { s, calls, orClause };
  }
  it("a co-owner's task/document/event/bill fetch also matches the co-owned car", async () => {
    const { s, orClause } = scoped();
    await s.getTasks(["linda"]);
    await s.getDocuments(["linda"]);
    await s.getDocumentsPage({ profileIds: ["linda"], limit: 10 });
    await s.getEvents(["linda"]);
    for (const t of ["tasks", "documents", "events"]) {
      expect(orClause(t), t).toBe('linked_profiles.cs.["linda"],linked_profiles.cs.["car-1"],linked_profiles.cs.["loan-1"]');
    }
  });
  it("an owner's fetch reaches a nested pet; the array-column tables use the array literal", async () => {
    const { s, orClause } = scoped();
    await s.getExpenses(["mike"]);
    expect(orClause("expenses")).toBe('linked_profiles.cs.["mike"],linked_profiles.cs.["dog-1"]');
    await s.getJournalEntries(["mike"]);
    expect(orClause("journal_entries")).toBe("linked_profiles.cs.{mike},linked_profiles.cs.{dog-1}");
  });
  it("no filter stays unfiltered and a self-only selection is unchanged", async () => {
    const { s, orClause, calls } = scoped();
    await s.getTasks();
    expect(orClause("tasks")).toBeUndefined();
    expect(calls.some((c) => c.table === "profiles" || c.table === "asset_party_links")).toBe(false);
    await s.getGoals(["mike", "linda"]);
    expect(orClause("goals")!.split(",").sort()).toEqual(['linked_profiles.cs.["car-1"]', 'linked_profiles.cs.["dog-1"]', 'linked_profiles.cs.["linda"]', 'linked_profiles.cs.["loan-1"]', 'linked_profiles.cs.["mike"]']);
  });
});

// D125 — reverseMerge starts with restoreEntity("profile", source), which had
// no profile table: every "this can be undone" merge failed to undo.
describe("D125: a merge-archived profile can be restored; a hard-deleted one still cannot", () => {
  it("un-deletes the soft-deleted profile row", async () => {
    const { client, calls } = chainClient((table, op) => table === "profiles" && op === "update" ? { data: [{ id: "p1", deleted_at: null }], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client });
    expect(await s.restoreEntity("profile", "p1")).toBe(true);
    const upd = calls.find((c) => c.table === "profiles" && c.op === "update");
    expect(upd?.payload).toEqual({ deleted_at: null });
    expect(upd?.filters).toContainEqual(["eq", ["id", "p1"]]);
  });
  it("answers false when no row exists (hard cascade)", async () => {
    const { client } = chainClient(() => ({ data: [], error: null }));
    const s = bareStorage({ supabase: client });
    expect(await s.restoreEntity("profile", "gone")).toBe(false);
    expect(await s.restoreEntity("obligation", "x")).toBe(false);
  });
});

// D127 — deleting a person left their per-person budget entries in the
// month (budgets live as JSON in preferences, which the SQL cascade never
// touches), so the everyone-mode total kept counting a person who was gone.
describe("D127: deleting a profile prunes its budget entries", () => {
  it("drops only the deleted person's entries, in every month that has them", async () => {
    const { client } = chainClient(() => ({ data: [], error: null }));
    (client as any).rpc = async () => ({ data: { profiles_deleted: 1 }, error: null });
    const months: Record<string, any[]> = {
      "2026-09": [{ id: "b1", category: "food", amount: 77, profileId: "gone" }, { id: "b2", category: "food", amount: 200, profileId: "self" }, { id: "b3", category: "fuel", amount: 50 }],
      "2026-10": [{ id: "b4", category: "food", amount: 10, profileId: "gone" }],
      "2026-11": [{ id: "b5", category: "food", amount: 10, profileId: "self" }],
    };
    const writes: Array<[string, any[]]> = [];
    const s = bareStorage({
      supabase: client,
      getProfile: async () => ({ id: "gone", type: "person", name: "X" }),
      getProfilesLite: async () => [{ id: "self", type: "self", name: "Me" }],
      getAllBudgets: async () => months,
      // The prune goes through the atomic writer; capture what it leaves per month.
      mutateBudgets: async (month: string, fn: (list: any[]) => any) => { const list = months[month].map((b) => ({ ...b })); const out = await fn(list); writes.push([month, list]); return out; },
    });
    expect(await s.deleteProfile("gone")).toBe(true);
    expect(writes.map(([m]) => m).sort()).toEqual(["2026-09", "2026-10"]);
    expect(writes.find(([m]) => m === "2026-09")![1].map((b: any) => b.id)).toEqual(["b2", "b3"]);
    expect(writes.find(([m]) => m === "2026-10")![1]).toEqual([]);
  });
});

// D128 — a tracker_target goal on a tracker without field definitions
// (created with just a name and a unit) never moved off its stored figure.
describe("D128: a tracker_target goal follows a fields-less tracker's latest entry", () => {
  const goalRow = { id: "g1", title: "Walk 10k", type: "tracker_target", target: 10000, current: 0, unit: "steps", tracker_id: "tr-1", status: "active", milestones: [], linked_profiles: ["self"] };
  const tracker = (fields: any[]) => ({ id: "tr-1", name: "Steps", fields, entries: [
    { id: "e1", values: { value: "4000" }, timestamp: "2026-09-01T10:00:00Z" },
    { id: "e2", values: { value: "2500" }, timestamp: "2026-09-02T10:00:00Z" },
  ] });
  it("uses the latest entry's first numeric value when the tracker has no fields", async () => {
    const { client } = chainClient((table) => table === "goals" ? { data: [goalRow], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client, getTracker: async () => tracker([]) });
    expect((await s.getGoal("g1"))?.current).toBe(2500);
  });
  it("still prefers the primary field when one is defined", async () => {
    const { client } = chainClient((table) => table === "goals" ? { data: [goalRow], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client, getTracker: async () => ({ ...tracker([{ name: "steps", type: "number", isPrimary: true }]), entries: [{ id: "e1", values: { steps: "7200", note: "x" }, timestamp: "2026-09-02T10:00:00Z" }] }) });
    expect((await s.getGoal("g1"))?.current).toBe(7200);
  });
});

// D131 — a tracker entry dated after today (user's zone) was accepted and
// became the "latest" reading everywhere.
describe("D131: tracker entries cannot be dated in the future", () => {
  const tracker = { id: "tr-1", name: "Weight", fields: [{ name: "weight", type: "number", isPrimary: true }], entries: [] };
  function entryStorage() {
    const inserts: any[] = [];
    const { client } = chainClient((table, op, payload) => {
      if (table === "tracker_entries" && op === "insert") { inserts.push(payload); return { data: [{ id: "e1", ...payload }], error: null }; }
      if (table === "tracker_entries" && op === "update") return { data: [{ id: "e1", ...payload }], error: null };
      if (table === "tracker_entries" && op === "select") return { data: [{ id: "e1", tracker_id: "tr-1", user_id: USER, entry_values: { weight: 170 }, timestamp: "2026-09-01T10:00:00Z" }], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getTracker: async () => tracker, _timezone: "America/Los_Angeles", logActivity: () => {}, _reownRestoredRow: async () => {} });
    return { s, inserts };
  }
  it("refuses a create dated tomorrow with a 400, keeps today at any clock time", async () => {
    const { s, inserts } = entryStorage();
    const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    await expect(s.logEntry({ trackerId: "tr-1", values: { weight: 180 }, timestamp: tomorrow })).rejects.toMatchObject({ statusCode: 400 });
    expect(inserts).toHaveLength(0);
    const earlierToday = new Date(Date.now() - 60 * 1000).toISOString();
    await s.logEntry({ trackerId: "tr-1", values: { weight: 180 }, timestamp: earlierToday, __skipDedupe: true } as any);
    expect(inserts).toHaveLength(1);
  });
  it("refuses moving an existing entry into the future", async () => {
    const { s } = entryStorage();
    const nextWeek = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    await expect(s.updateTrackerEntry("tr-1", "e1", { timestamp: nextWeek })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// D133 — the scoped bill list behind the dashboard snapshot and stats matched
// only the raw selection or a bill's immediate parent.
describe("D133: scoped getObligations reaches a co-owned car's bill and a bill nested two levels down", () => {
  const profiles = [
    { id: "self", type: "self", name: "Me" },
    { id: "mike", type: "person", name: "Mike" },
    { id: "linda", type: "person", name: "Linda" },
    { id: "car-1", type: "vehicle", name: "Honda", parentProfileId: "self" },
    { id: "truck-1", type: "vehicle", name: "Truck", parentProfileId: "mike" },
    { id: "bill-car", type: "liability", type_key: "utility", name: "Car insurance", parentProfileId: "car-1", fields: { monthlyAmount: 118, dueDate: "2026-09-22", frequency: "monthly" } },
    { id: "bill-truck", type: "liability", type_key: "utility", name: "Truck insurance", parentProfileId: "truck-1", fields: { monthlyAmount: 90, dueDate: "2026-09-10", frequency: "monthly" } },
    { id: "bill-self", type: "liability", type_key: "utility", name: "Internet", parentProfileId: "self", fields: { monthlyAmount: 60, dueDate: "2026-09-05", frequency: "monthly" } },
  ];
  function billStorage(links: any[]) {
    const { client } = chainClient(() => ({ data: [], error: null }));
    return bareStorage({ supabase: client, getProfiles: async () => profiles, getProfilesLite: async () => profiles, getAssetPartyLinks: async () => links, getLiabilityProfileLinks: async () => [] });
  }
  it("Linda (co-owner of the car) gets the car's bill; Mike gets the bill under his truck", async () => {
    const s = billStorage([{ id: "apl", assetProfileId: "car-1", partyProfileId: "linda", ownershipPercentage: 50 }]);
    expect((await s.getObligations(["linda"])).map((o: any) => o.name)).toEqual(["Car insurance"]);
    expect((await s.getObligations(["mike"])).map((o: any) => o.name)).toEqual(["Truck insurance"]);
    expect((await s.getObligations(["self"])).map((o: any) => o.name).sort()).toEqual(["Car insurance", "Internet"]);
  });
  it("without the link Linda gets nothing", async () => {
    const s = billStorage([]);
    expect(await s.getObligations(["linda"])).toEqual([]);
  });
});

// D139 — deleting a co-owner dropped their link row and left the asset
// partly owned by nobody.
describe("D139: a deleted co-owner's shares return to the remaining owners", () => {
  it("one remaining owner gets 100%; several split the share pro rata; a sole owner is left alone", async () => {
    const { client } = chainClient(() => ({ data: [], error: null }));
    (client as any).rpc = async () => ({ data: {}, error: null });
    const assetWrites: any[] = []; const liabWrites: any[] = [];
    const s = bareStorage({
      supabase: client,
      getProfile: async () => ({ id: "linda", type: "person", name: "Linda" }),
      getProfilesLite: async () => [{ id: "self", type: "self" }],
      getAllBudgets: async () => ({}),
      getAssetPartyLinks: async () => [
        { id: "a1", assetProfileId: "car", partyProfileId: "self", ownershipPercentage: 50 },
        { id: "a2", assetProfileId: "car", partyProfileId: "linda", ownershipPercentage: 50 },
        { id: "a3", assetProfileId: "boat", partyProfileId: "linda", ownershipPercentage: 100 },
      ],
      getLiabilityProfileLinks: async () => [
        { id: "l1", liabilityProfileId: "loan", partyProfileId: "self", ownershipPercentage: 40 },
        { id: "l2", liabilityProfileId: "loan", partyProfileId: "linda", ownershipPercentage: 40 },
        { id: "l3", liabilityProfileId: "loan", partyProfileId: "mike", ownershipPercentage: 20 },
      ],
      setAssetOwners: async (id: string, owners: any[]) => { assetWrites.push([id, owners]); return owners; },
      setLiabilityOwners: async (id: string, owners: any[]) => { liabWrites.push([id, owners]); return owners; },
    });
    expect(await s.deleteProfile("linda")).toBe(true);
    expect(assetWrites).toEqual([["car", [{ partyProfileId: "self", ownershipPercentage: 100 }]]]);
    expect(liabWrites).toEqual([["loan", [{ partyProfileId: "self", ownershipPercentage: 66.67 }, { partyProfileId: "mike", ownershipPercentage: 33.33 }]]]);
    // The boat had no other owner: nothing to write (no rows ⇒ Self's by convention).
    expect(assetWrites.some(([id]) => id === "boat")).toBe(false);
  });
});
