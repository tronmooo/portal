// Pre-merge audit, 2026-11-22: "tasks, bills and document alerts behave
// consistently across the Dashboard, Finance, Calendar and Notifications".
// Each block is a disagreement the audit found between those surfaces.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { nextBillDate, rollBillsForward, buildBillsTimeline, shownOccurrenceToPay, nextBillDateForFields } from "../shared/bills-timeline";
import { sumBillsDueThroughMonth } from "../shared/obligation-windows";
import { startHarness, type Harness } from "./helpers/route-harness";

const TODAY = "2026-11-22";
const netflix = (over: Record<string, unknown> = {}) => ({
  id: "b1", name: "Netflix", amount: 9.99, frequency: "monthly", nextDueDate: "2026-07-25", status: "active", ...over,
});

// ── 1. A date settled from the calendar (or from a rolled row) is done ───────
// The stored date only moves when the occurrence it names is the one settled,
// so "Mark paid" on Nov 25 left July stored and every list kept saying Nov 25.
describe("the next date steps over an occurrence already paid, skipped or missed", () => {
  it("names December once November is settled", () => {
    expect(nextBillDate(netflix(), TODAY)).toBe("2026-11-25");
    expect(nextBillDate(netflix({ settledDates: ["2026-11-25"] }), TODAY)).toBe("2026-12-25");
    expect(nextBillDate(netflix({ settledDates: ["2026-11-25", "2026-12-25"] }), TODAY)).toBe("2027-01-25");
  });
  it("…for a stored date that is itself ahead and settled", () => {
    expect(nextBillDate(netflix({ nextDueDate: "2026-11-25", settledDates: ["2026-11-25"] }), TODAY)).toBe("2026-12-25");
  });
  it("a one-time bill whose only occurrence is settled has nothing coming", () => {
    expect(nextBillDate(netflix({ frequency: "once", nextDueDate: "2026-11-25", settledDates: ["2026-11-25"] }), TODAY)).toBeNull();
  });
  it("Dashboard, Finance and the month's total agree after the payment", () => {
    const paid = netflix({ settledDates: ["2026-11-25"], payments: [{ id: "p1", amount: 9.99, date: TODAY }] });
    const rolled = rollBillsForward([paid], TODAY);
    const timeline = buildBillsTimeline([paid] as any, TODAY, { upcomingDays: 60 });
    expect(rolled.map((o) => o.nextDueDate)).toEqual(["2026-12-25"]);
    expect(timeline.upcoming.map((r) => r.date)).toEqual(["2026-12-25"]);
    // Paid once: the payment row, and no "assumed" twin for the same cycle.
    expect(timeline.past.filter((r) => r.state === "paid")).toHaveLength(1);
    expect(timeline.past.some((r) => r.date === "2026-11-25")).toBe(false);
    // November no longer owes it — the expense carries it (no double count).
    expect(sumBillsDueThroughMonth(rolled, "2026-11")).toBe(0);
    expect(sumBillsDueThroughMonth(rollBillsForward([netflix()], TODAY), "2026-11")).toBe(9.99);
  });
  it("the server hands the stamps to the rule", () => {
    const src = readFileSync(new URL("../server/supabase-storage.ts", import.meta.url), "utf8");
    expect(src).toContain("settledDates: Object.keys((f.occurrences && typeof f.occurrences === \"object\") ? f.occurrences : {})");
  });
});

// ── 2. "Pay" settles the date the row shows ──────────────────────────────────
describe("a plain Pay on a rolled row settles the occurrence shown, once", () => {
  it("names the shown date for a stale bill, and nothing for one that is not stale", () => {
    expect(shownOccurrenceToPay(netflix(), TODAY)).toBe("2026-11-25");
    expect(shownOccurrenceToPay(netflix({ nextDueDate: "2026-11-25" }), TODAY)).toBeNull(); // the pay operation's own rule
    expect(shownOccurrenceToPay(netflix({ nextDueDate: TODAY }), TODAY)).toBeNull();
    expect(shownOccurrenceToPay(netflix({ frequency: "once" }), TODAY)).toBeNull();
  });

  it("through the real pay operation: one payment, the shown month stamped, the row moves on", async () => {
    const { payBillOccurrence } = await import("../server/liability-payments");
    const rows: any[] = [];
    let profile: any = { id: "b1", type: "liability", type_key: "subscription", name: "Netflix", fields: { monthlyAmount: 9.99, dueDate: "2026-07-25", nextDueDate: "2026-07-25", frequency: "monthly", occurrences: {} }, tags: [], notes: "" };
    const storage: any = {
      _timezone: "UTC",
      getProfile: async () => profile, getProfiles: async () => [profile],
      updateProfile: async (_id: string, patch: any) => { profile = { ...profile, fields: { ...profile.fields, ...(patch?.fields || {}) } }; return profile; },
      mutateProfileFields: async (_id: string, fn: any) => { const r = fn(profile); profile = { ...profile, fields: { ...profile.fields, ...(r?.fields || {}) } }; return profile; },
      claimBillOccurrence: async (_id: string, date: string, stamp: any, extra: any) => {
        const occ = { ...(profile.fields.occurrences || {}) };
        if (occ[date]?.status === "paid") return { status: "already-paid", occurrences: occ };
        occ[date] = stamp; profile = { ...profile, fields: { ...profile.fields, ...extra, occurrences: occ } };
        return { status: "claimed", occurrences: occ };
      },
      createLiabilityPayment: async (r: any) => { const row = { id: r.id || `pay-${rows.length + 1}`, ...r }; rows.push(row); return row; },
      getLiabilityPayments: async () => rows, getLiabilityPayment: async (id: string) => rows.find((r) => r.id === id) || null,
      updateOccurrenceOverride: async () => {}, getTasks: async () => [], getExpenses: async () => [], createExpense: async (e: any) => e,
    };
    const asObligation = () => ({
      ...netflix({ nextDueDate: profile.fields.dueDate }),
      settledDates: Object.keys(profile.fields.occurrences).filter((d) => profile.fields.occurrences[d]?.status === "paid"),
    });
    const shown = shownOccurrenceToPay(asObligation(), TODAY);
    expect(shown).toBe("2026-11-25");
    const res = await payBillOccurrence(storage, "b1", { amount: null, paymentDate: TODAY, occurrenceDate: shown, source: "route" } as any, "UTC");
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(1);
    // The month the row showed is the one stamped — not July.
    expect(Object.keys(profile.fields.occurrences)).toEqual(["2026-11-25"]);
    // …so the row leaves November for December, and the same tap again would
    // name December, never an old month.
    expect(nextBillDate(asObligation(), TODAY)).toBe("2026-12-25");
    expect(shownOccurrenceToPay(asObligation(), TODAY)).toBe("2026-12-25");

    // A second tap seconds later lands on another server instance, where the
    // shown date is already December. It is the same tap: nothing more is
    // recorded (live check, 2026-11-23: one Pay, two expenses).
    const again = await payBillOccurrence(storage, "b1", { amount: null, paymentDate: null, occurrenceDate: shownOccurrenceToPay(asObligation(), TODAY), implicitOccurrence: true, source: "route" } as any, "UTC");
    expect(again.ok).toBe(true);
    expect(again.deduped).toBe(true);
    expect(rows).toHaveLength(1);
    expect(Object.keys(profile.fields.occurrences)).toEqual(["2026-11-25"]);
    // An occurrence the caller NAMED is a payment of its own.
    const named = await payBillOccurrence(storage, "b1", { amount: null, paymentDate: null, occurrenceDate: "2026-12-25", source: "route" } as any, "UTC");
    expect(named.ok).toBe(true);
    expect(named.deduped).not.toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("the route applies it only when the caller named no occurrence", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const i = src.indexOf('app.post("/api/obligations/:id/pay"');
    const block = src.slice(i, i + 6500);
    expect(i).toBeGreaterThan(-1);
    expect(block).toContain("const shownOccurrence = namedOccurrence ? null");
    expect(block).toContain("occurrenceDate: namedOccurrence ?? shownOccurrence,");
    expect(block).toContain("implicitOccurrence: !namedOccurrence && !!shownOccurrence,");
  });

  it("the bills editor writes a due date only when the user changed it", () => {
    const src = readFileSync(new URL("../client/src/components/dashboard/BriefingPopups.tsx", import.meta.url), "utf8");
    expect(src).toContain("...(editDue && editDue !== due ? { nextDueDate: editDue } : {})");
    expect(src).not.toContain("...(editDue ? { nextDueDate: editDue } : {})");
  });
});

// ── 3. The Liabilities list reads the same date ──────────────────────────────
describe("a bill's card on the Liabilities list shows its next date", () => {
  it("reads the next date off the record's own fields and stamps", () => {
    expect(nextBillDateForFields({ frequency: "monthly" }, "2026-07-25", TODAY)).toBe("2026-11-25");
    expect(nextBillDateForFields({ frequency: "monthly", occurrences: { "2026-11-25": { status: "paid" } } }, "2026-07-25", TODAY)).toBe("2026-12-25");
    expect(nextBillDateForFields({ billingFrequency: "yearly" }, "2025-12-15", TODAY)).toBe("2026-12-15");
    // Nothing coming (a one-time bill): the caller still gets the stored date.
    expect(nextBillDateForFields({ frequency: "once" }, "2026-10-01", TODAY)).toBe("2026-10-01");
    expect(nextBillDateForFields({}, null, TODAY)).toBeNull();
  });
  it("the list and the bill page header use it", () => {
    const list = readFileSync(new URL("../client/src/pages/trackers.tsx", import.meta.url), "utf8");
    expect(list).toContain("? nextBillDateForFields(fields,");
    const page = readFileSync(new URL("../client/src/pages/liability-detail.tsx", import.meta.url), "utf8");
    expect(page).toContain('(o) => o.effectiveDate >= todayISO && o.status !== "paid" && o.status !== "skipped" && o.status !== "missed"');
  });
});

// ── 4. The bell: one dismissal hides one fact, not the whole record ──────────
describe("the bell removes dismissed alerts before collapsing a record's notices", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
  const notices = async (hh: Harness): Promise<any[]> => {
    const r = await hh.api("GET", "/api/notifications");
    expect(r.status).toBe(200);
    if (!Array.isArray(r.data)) throw new Error("notifications is not a list");
    return r.data.filter((n: any) => n.entityId === "doc-p");
  };

  it("dismissing a policy's nearer date lets its other date show, instead of hiding the record", async () => {
    h = await startHarness({
      documents: [{ id: "doc-p", name: "Auto Policy", type: "insurance", linkedProfiles: [], extractedData: { renewalDate: day(5), expirationDate: day(-3) } }],
    });
    const first = await notices(h);
    expect(first).toHaveLength(1); // one notice per record, the most severe
    const firstId = first[0].id;
    await h.api("POST", "/api/notifications/dismiss", { ids: [firstId] });
    const after = await notices(h);
    expect(after.map((n) => n.id)).not.toContain(firstId); // dismissed stays dismissed
    expect(after).toHaveLength(1);                           // the other fact is still told
    expect(after[0].dueDate).not.toBe(first[0].dueDate);
    // Dismiss that too: nothing left, and nothing comes back.
    await h.api("POST", "/api/notifications/dismiss", { ids: [after[0].id] });
    expect(await notices(h)).toEqual([]);
  });
});

// ── 5. Generated "Bill due" tasks are gone on the first read ─────────────────
describe("reading the task list retires the generated bill reminders", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });

  it("the scan's tasks leave; a typed task, an edited one and a completed one stay", async () => {
    const gen = (over: Record<string, unknown>) => ({
      status: "todo", priority: "high", dueDate: "2026-03-31", dueTime: "09:00", tags: [], linkedProfiles: ["bill-1"], ...over,
    });
    h = await startHarness({
      profiles: [
        { id: "bill-1", type: "liability", type_key: "subscription", name: "Spotify", fields: { frequency: "monthly", dueDate: "2026-07-30" } },
        { id: "car-1", type: "asset", type_key: "vehicle", name: "Civic", fields: {} },
      ],
      tasks: [
        gen({ id: "g1", title: "Bill due: Spotify" }),
        gen({ id: "g2", title: "Bill due: Old Gym", linkedProfiles: ["deleted-bill"] }),
        gen({ id: "u1", title: "Pay insurance before Friday" }),
        gen({ id: "u2", title: "Bill due: Spotify", description: "ask about the family plan" }),
        gen({ id: "u3", title: "Bill due: Civic", linkedProfiles: ["car-1"] }),
        gen({ id: "d1", title: "Bill due: Spotify", status: "done" }),
      ],
    });
    const r = await h.api("GET", "/api/tasks");
    expect(r.status).toBe(200);
    if (!Array.isArray(r.data)) throw new Error("tasks is not a list");
    expect(r.data.map((t: any) => t.id).sort()).toEqual(["d1", "u1", "u2", "u3"]);
    expect(h.db.tasks.map((t: any) => t.id).sort()).toEqual(["d1", "u1", "u2", "u3"]);
  });
});
