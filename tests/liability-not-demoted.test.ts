import { describe, it, expect, vi } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

// THE BUG, exactly as it reached production.
//
// A user asked for "a recurring auto-loan liability for my 2025 Dodge Ram 1500
// … 72-month term … payoff Feb 28 2031", and got back a profile showing a
// $912.40 monthly bill with no principal, no original amount, no APR, no term
// ("Ongoing — no end date") and no amortization schedule. The loan terms were
// never lost — the profile stopped being a loan.
//
// The chain:
//   1. create_liability writes the profile with type_key "auto_loan" and the
//      full loan terms. Correct.
//   2. It then creates a calendar obligation named "<loan name> payment".
//   3. createObligation upserts by NORMALIZED name, and normLiabilityName
//      strips a trailing "payment" — so "Dodge Ram 2025 Auto Loan payment"
//      resolves to the loan created one step earlier.
//   4. The upsert rewrites that row: type_key := billTypeKey(...) = "bill".
//
// "bill" is in the RECURRING family, so isRecurringBill() flipped true and the
// detail page swapped the loan layout for the bill layout. countsTowardNetWorth
// flipped false too, so $49,275 of debt silently left the net-worth total.
//
// Step 2 is gone now (an amortizing loan carries its own schedule), but the
// demotion was reachable from every other obligation path, so the guard lives
// in createObligation itself. These tests drive that method directly.

const SELF = { id: "self-1", type: "self", name: "Me", fields: {}, parentProfileId: null };

const LOAN = {
  id: "loan-1",
  type: "liability",
  type_key: "auto_loan",
  name: "Dodge Ram 2025 Auto Loan",
  parentProfileId: "self-1",
  fields: {
    lender: "Capital Auto Finance",
    currentBalance: 49275,
    originalBalance: 54800,
    annualInterestRate: 0.0649,
    monthlyPayment: 912.4,
    termMonths: 72,
    remainingTermMonths: 55,
    loanStartDate: "2025-03-31",
    firstPaymentDate: "2025-03-31",
    payoffDate: "2031-02-28",
    dueDay: 31,
  },
};

const PHONE_BILL = {
  id: "bill-1",
  type: "liability",
  type_key: "phone_plan",
  name: "Verizon Wireless",
  parentProfileId: "self-1",
  fields: { monthlyAmount: 90.5, amount: 90.5, dueDate: "2026-08-15" },
};

/** A storage instance whose reads come from `profiles` and whose writes are
 *  recorded instead of sent. Only the surface createObligation touches. */
function makeStorage(profiles: any[]) {
  vi.stubEnv("SUPABASE_URL", "http://localhost");
  const storage = new SupabaseStorage("http://localhost", "test-key", "user-1") as any;
  const rows = profiles.map((p) => ({ ...p, fields: { ...p.fields } }));
  const updates: Array<{ id: string; payload: any }> = [];

  storage.getProfiles = async () => rows;
  storage.getProfile = async (id: string) => rows.find((p) => p.id === id);
  storage.getSelfProfile = async () => rows.find((p) => p.type === "self");
  storage.ensureAutoOwnerLink = async () => {};
  storage.logActivity = () => {};
  storage.createProfile = async (p: any) => {
    const created = { ...p, id: `new-${rows.length}` };
    rows.push(created);
    return created;
  };
  storage.updateProfile = async (id: string, payload: any) => {
    updates.push({ id, payload });
    const row = rows.find((p) => p.id === id);
    if (!row) return undefined;
    if (payload.name !== undefined) row.name = payload.name;
    if (payload.type !== undefined) row.type = payload.type;
    if (payload.type_key !== undefined) row.type_key = payload.type_key;
    if (payload.fields) row.fields = { ...row.fields, ...payload.fields };
    return row;
  };
  storage.supabase = {
    from: () => {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, order: () => b,
        then: (res: any) => res({ data: [], error: null }),
      };
      return b;
    },
  };
  return { storage, rows, updates };
}

describe("createObligation never demotes a real debt into a bill", () => {
  it("leaves the loan's subtype alone when its payment is scheduled", async () => {
    const { storage, rows } = makeStorage([SELF, LOAN]);

    await storage.createObligation({
      name: "Dodge Ram 2025 Auto Loan payment",
      amount: 912.4,
      frequency: "monthly",
      category: "liability",
      nextDueDate: "2026-08-31",
      linkedProfiles: ["self-1"],
    });

    const loan = rows.find((p) => p.id === "loan-1")!;
    // The whole bug in one assertion.
    expect(loan.type_key).toBe("auto_loan");
    expect(loan.name).toBe("Dodge Ram 2025 Auto Loan");
  });

  it("keeps every loan term the user stated", async () => {
    const { storage, rows } = makeStorage([SELF, LOAN]);

    await storage.createObligation({
      name: "Dodge Ram 2025 Auto Loan payment",
      amount: 912.4,
      frequency: "monthly",
      nextDueDate: "2026-08-31",
      linkedProfiles: ["self-1"],
    });

    expect(rows.find((p) => p.id === "loan-1")!.fields).toMatchObject({
      lender: "Capital Auto Finance",
      currentBalance: 49275,
      originalBalance: 54800,
      annualInterestRate: 0.0649,
      monthlyPayment: 912.4,
      termMonths: 72,
      loanStartDate: "2025-03-31",
      payoffDate: "2031-02-28",
      dueDay: 31,
    });
  });

  it("does not overwrite the loan's balance with the payment amount", async () => {
    // billFields carries `amount`/`monthlyAmount`, and readTerms falls back to
    // `amount` for the balance — merging the bill payload wholesale would have
    // reported this $49,275 loan as owing $912.40.
    const { storage, rows } = makeStorage([SELF, LOAN]);

    await storage.createObligation({
      name: "Dodge Ram 2025 Auto Loan payment",
      amount: 912.4,
      frequency: "monthly",
      nextDueDate: "2026-08-31",
      linkedProfiles: ["self-1"],
    });

    const f = rows.find((p) => p.id === "loan-1")!.fields;
    expect(f.amount).toBeUndefined();
    expect(f.monthlyAmount).toBeUndefined();
    expect(f.currentBalance).toBe(49275);
  });

  it("does not reset the loan's first payment date to the next due date", async () => {
    // firstPaymentDate anchors the amortization series; the bill payload sets
    // it to whatever the next due date is, which would restart a two-year-old
    // loan's schedule at today.
    const { storage, rows } = makeStorage([SELF, LOAN]);

    await storage.createObligation({
      name: "Dodge Ram 2025 Auto Loan payment",
      amount: 912.4,
      frequency: "monthly",
      nextDueDate: "2026-08-31",
      linkedProfiles: ["self-1"],
    });

    expect(rows.find((p) => p.id === "loan-1")!.fields.firstPaymentDate).toBe("2025-03-31");
  });

  it("still applies the schedule fields the calendar needs", async () => {
    const { storage, rows } = makeStorage([SELF, LOAN]);

    await storage.createObligation({
      name: "Dodge Ram 2025 Auto Loan payment",
      amount: 912.4,
      frequency: "monthly",
      nextDueDate: "2026-08-31",
      linkedProfiles: ["self-1"],
    });

    expect(rows.find((p) => p.id === "loan-1")!.fields).toMatchObject({
      dueDate: "2026-08-31",
      nextDueDate: "2026-08-31",
      frequency: "monthly",
    });
  });

  it("reports the installment, not the principal, in the obligation view", async () => {
    const { storage } = makeStorage([SELF, LOAN]);

    const ob = await storage.createObligation({
      name: "Dodge Ram 2025 Auto Loan payment",
      amount: 912.4,
      frequency: "monthly",
      nextDueDate: "2026-08-31",
      linkedProfiles: ["self-1"],
    });

    // getObligation() returns undefined for a non-recurring row, so the old
    // `!`-asserted return would have handed callers undefined.
    expect(ob).toBeDefined();
    expect(ob.amount).toBe(912.4);
  });
});

describe("createObligation still upserts genuine recurring bills", () => {
  it("updates the existing bill in place rather than duplicating it", async () => {
    const { storage, rows } = makeStorage([SELF, PHONE_BILL]);

    await storage.createObligation({
      name: "Verizon Wireless payment",
      amount: 95,
      frequency: "monthly",
      nextDueDate: "2026-09-15",
      linkedProfiles: ["self-1"],
    });

    expect(rows.filter((p) => p.type === "liability")).toHaveLength(1);
    const bill = rows.find((p) => p.id === "bill-1")!;
    expect(bill.type_key).toBe("phone_plan");
    expect(bill.fields.amount).toBe(95);
    expect(bill.fields.monthlyAmount).toBe(95);
    expect(bill.fields.dueDate).toBe("2026-09-15");
  });

  it("creates a new bill when nothing matches", async () => {
    const { storage, rows } = makeStorage([SELF]);

    await storage.createObligation({
      name: "Netflix",
      amount: 22.99,
      frequency: "monthly",
      nextDueDate: "2026-08-20",
      linkedProfiles: ["self-1"],
    });

    const created = rows.find((p) => p.name === "Netflix")!;
    expect(created.type).toBe("liability");
    expect(created.type_key).toBe("streaming");
    expect(created.fields.monthlyAmount).toBe(22.99);
  });
});
