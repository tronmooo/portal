// "I paid $92 toward my phone bill today, for my September 15 bill."
//
// What the user got back: the payment landed in the history, and the bill went
// right on showing $92 due Sep 15 — on the calendar, on the Payments tab
// ("Upcoming (12) / Completed (0)"), and in the liability header ("Payments
// made 0"). So they paid it again through the chat, and the bill ended the day
// with two $92 charges against one billing period. Neither payment ever showed
// up on the Expenses list.
//
// Root cause: `payObligation` — the path a bare "pay this bill" takes — wrote a
// liability_payments row dated TODAY and advanced the due date, and nothing
// else. Occurrences are generated, not stored (shared/liability-schedule.ts):
// one is "paid" only when `fields.occurrences[<due date>]` says so, or when a
// payment carries that exact due date. A payment dated Aug 22 against a Sep 15
// occurrence matches neither, so every surface kept reading it as unpaid.
//
// These tests drive the real methods against an injected Supabase double.

import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";
import { generateSchedule } from "../shared/liability-schedule";
import { isBillExpense } from "../shared/schema";

const TODAY = "2026-08-22";
const DUE = "2026-09-15";

function billProfile() {
  return {
    id: "bill-1",
    name: "QA Phone Bill",
    type: "liability",
    type_key: "phone_plan",
    parentProfileId: "self-1",
    fields: {
      amount: 92,
      monthlyAmount: 92,
      category: "phone",
      frequency: "monthly",
      dueDate: DUE,
      nextDueDate: DUE,
      firstPaymentDate: DUE,
    } as Record<string, any>,
  };
}

/** A storage instance with the DB and the neighbouring reads stubbed out. */
function makeStorage() {
  const profile = billProfile();
  const payments: any[] = [];
  const expenses: any[] = [];
  const expenseUpdates: any[] = [];

  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage._timezone = "America/Los_Angeles";
  storage.supabase = {
    from(table: string) {
      const b: any = {
        _mode: "",
        _payload: null as any,
        insert(payload: any) {
          if (table === "expenses") expenses.push(payload);
          return { error: null };
        },
        update(payload: any) { b._mode = "update"; b._payload = payload; return b; },
        eq() { return b; },
        select() {
          if (b._mode === "update" && table === "expenses") {
            expenseUpdates.push(b._payload);
            // The row exists, so the update sticks and no second row is booked.
            return Promise.resolve({ data: expenses.length ? [{ id: "exp-1" }] : [], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
      };
      return b;
    },
  };

  storage.getProfile = async (id: string) => (id === profile.id ? profile : null);
  storage.getSelfProfile = async () => ({ id: "self-1", name: "Me" });
  storage.updateProfile = async (_id: string, patch: any) => {
    profile.fields = { ...profile.fields, ...(patch.fields || {}) };
    return profile;
  };
  storage._liabilityPayments = async () => payments.map((p) => ({ id: p.id, paymentDate: p.paymentDate }));
  storage.createLiabilityPayment = async (data: any) => {
    const row = { ...data, id: `pay-${payments.length + 1}` };
    payments.push(row);
    return row;
  };
  storage.getLiabilitySchedule = async () => ({ id: profile.id });
  storage.logActivity = () => {};
  storage.adjustAccountBalance = async () => {};

  return { storage, profile, payments, expenses, expenseUpdates };
}

/** The occurrence the app would render for `date`, from the profile's fields. */
function occurrenceOn(profile: any, payments: any[], date: string) {
  const sched = generateSchedule(
    { id: profile.id, fields: profile.fields },
    payments.map((p) => ({ id: p.id, paymentDate: p.paymentDate })),
    { todayISO: TODAY, windowStart: "2026-06-01", windowEnd: "2027-06-01" },
  );
  return sched.find((o) => o.date === date);
}

describe("paying a bill settles a real billing period", () => {
  it("marks the occurrence paid — a bare pay_obligation, no month named", async () => {
    const { storage, profile, payments } = makeStorage();

    await storage.payObligation(profile.id, 92, "manual", undefined, TODAY);

    // The Sep 15 period is what got paid, and the schedule every surface reads
    // now says so. Before the fix this was still "upcoming".
    expect(profile.fields.occurrences?.[DUE]?.status).toBe("paid");
    expect(occurrenceOn(profile, payments, DUE)?.status).toBe("paid");
    expect(payments).toHaveLength(1);
  });

  it("records the payment on the day the money moved, not the future due date", async () => {
    const { storage, profile, payments } = makeStorage();

    await storage.payOccurrence(profile.id, DUE, { amount: 92 });

    // Paying a Sep 15 bill on Aug 22 used to stamp the payment "2026-09-15" —
    // a payment dated in the future, outside the month it was actually made.
    expect(payments[0].paymentDate).toBe(TODAY);
    expect(profile.fields.lastPaidDate).toBe(TODAY);
  });

  it("back-fills a past occurrence at its own date", async () => {
    const { storage, profile, payments } = makeStorage();
    profile.fields.firstPaymentDate = "2026-07-15";
    profile.fields.dueDate = "2026-07-15";
    profile.fields.nextDueDate = "2026-07-15";

    await storage.payOccurrence(profile.id, "2026-07-15", { amount: 92 });

    expect(payments[0].paymentDate).toBe("2026-07-15");
  });

  it("books an expense for the paid period, once", async () => {
    const { storage, profile, expenses, expenseUpdates } = makeStorage();

    await storage.payOccurrence(profile.id, DUE, { amount: 92 });

    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      amount: 92, vendor: "QA Phone Bill", source: "bill", date: TODAY,
    });
    expect(expenses[0].description).toContain("2026-09");
    // The occurrence remembers its expense, so a re-pay updates that row
    // instead of leaving a second $92 on the Expenses list.
    expect(profile.fields.occurrences[DUE].expenseId).toBe(expenses[0].id);

    await storage.payOccurrence(profile.id, DUE, { amount: 92 });
    expect(expenses).toHaveLength(1);
    expect(expenseUpdates).toHaveLength(1);
  });

  it("un-marks the occurrence when the payment is deleted", async () => {
    const { storage, profile } = makeStorage();
    await storage.payOccurrence(profile.id, DUE, { amount: 92 });
    const paymentId = profile.fields.occurrences[DUE].paymentId;

    // deleteLiabilityPayment's own DELETE goes through the double; hand it the
    // deleted row so the cleanup knows which liability to walk.
    storage.supabase.from = () => {
      const b: any = {
        delete() { return b; },
        update() { return b; },
        eq() { return b; },
        select: () => Promise.resolve({ data: [{ id: paymentId, liability_profile_id: profile.id }], error: null }),
      };
      return b;
    };

    expect(await storage.deleteLiabilityPayment(paymentId)).toBe(true);
    // Undo has to undo BOTH halves: the row and the paid stamp. Deleting the
    // row alone left the bill reading "paid" with no payment behind it.
    expect(profile.fields.occurrences[DUE]).toBeUndefined();
  });
});

describe("bill expenses stay out of the rollups that already count bills", () => {
  it("isBillExpense marks only bill-booked rows", () => {
    expect(isBillExpense({ source: "bill" })).toBe(true);
    expect(isBillExpense({ source: "manual" })).toBe(false);
    expect(isBillExpense({})).toBe(false);
    expect(isBillExpense(null)).toBe(false);
  });
});
