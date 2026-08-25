import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { applyLiabilityPayment } from "../server/liability-payments";

/** Minimal storage double: records what was written, returns merged rows. */
function fakeStorage(liability: any) {
  const writes: any[] = [];
  return {
    writes,
    liability,
    createLiabilityPayment: async (data: any) => {
      const row = { id: "pay-1", ...data };
      writes.push(["createLiabilityPayment", row]);
      return row;
    },
    updateProfile: async (id: string, patch: any) => {
      liability = { ...liability, ...patch, fields: { ...liability.fields, ...patch.fields } };
      writes.push(["updateProfile", id, patch]);
      return liability;
    },
  } as any;
}

const CAR_LOAN = {
  id: "liab-1",
  name: "Car loan",
  type: "liability",
  type_key: "auto_loan",
  fields: { currentBalance: 10_000, annualInterestRate: 6, monthlyPayment: 400 },
};

describe("recording a liability payment — one implementation", () => {
  it("mirrors the new balance under every name the app reads it by", async () => {
    // The AI path used to write `currentBalance` only. The liability card, the
    // dashboard and net worth read `remainingBalance` and `loanBalance` too, so
    // they kept rendering the pre-payment number — not a caching delay, a
    // different field.
    const storage = fakeStorage(CAR_LOAN);
    const out = await applyLiabilityPayment(storage, CAR_LOAN, { amount: 400 }, "America/Los_Angeles");
    const fields = out.liability.fields;
    expect(fields.currentBalance).toBe(out.newBalance);
    expect(fields.remainingBalance).toBe(out.newBalance);
    expect(fields.loanBalance).toBe(out.newBalance);
  });

  it("splits principal and interest with the canonical amortization math", async () => {
    const storage = fakeStorage(CAR_LOAN);
    const out = await applyLiabilityPayment(storage, CAR_LOAN, { amount: 400 }, "UTC");
    // 6% APR on $10,000 → $50 interest this period, $350 to principal.
    expect(out.interest).toBeCloseTo(50, 2);
    expect(out.principal).toBeCloseTo(350, 2);
    expect(out.newBalance).toBeCloseTo(9_650, 2);
  });

  it("produces the same result whichever door the payment came through", async () => {
    // The form sends amount + date. Chat sends the same thing plus fields the
    // form has no input for. With one implementation, the parts they share must
    // agree exactly — that is what "AI and manual behave identically" means.
    const viaForm = await applyLiabilityPayment(fakeStorage(CAR_LOAN), CAR_LOAN,
      { amount: 400, paymentDate: "2026-08-25" }, "America/Los_Angeles");
    const viaChat = await applyLiabilityPayment(fakeStorage(CAR_LOAN), CAR_LOAN,
      { amount: 400, paymentDate: "2026-08-25", notes: null, sourceAccount: null }, "America/Los_Angeles");
    expect(viaChat.principal).toBe(viaForm.principal);
    expect(viaChat.interest).toBe(viaForm.interest);
    expect(viaChat.newBalance).toBe(viaForm.newBalance);
    expect(viaChat.payment.remainingBalanceAfter).toBe(viaForm.payment.remainingBalanceAfter);
  });

  it("logs a recurring bill and rolls its due date instead of inventing a balance", async () => {
    // A phone bill is not debt. The AI path had no idea and would reduce a
    // "balance" that does not exist.
    const bill = {
      id: "bill-1", name: "Phone", type: "liability", type_key: "phone_plan",
      fields: { amount: 80, frequency: "monthly", dueDate: "2026-08-01" },
    };
    const storage = fakeStorage(bill);
    const out = await applyLiabilityPayment(storage, bill, { amount: 80 }, "America/Los_Angeles");
    expect(out.recurring).toBe(true);
    expect(out.payment.principalPortion).toBe(80);
    expect(out.payment.interestPortion).toBe(0);
    expect(out.liability.fields.nextDueDate).not.toBe("2026-08-01");
    expect(out.liability.fields.lastPaidDate).toBeTruthy();
  });

  it("honors an explicit payment type", async () => {
    const skipped = await applyLiabilityPayment(fakeStorage(CAR_LOAN), CAR_LOAN,
      { amount: 400, paymentType: "skipped" }, "UTC");
    expect(skipped.newBalance).toBe(10_000);
    expect(skipped.principal).toBe(0);

    const payoff = await applyLiabilityPayment(fakeStorage(CAR_LOAN), CAR_LOAN,
      { amount: 10_050, paymentType: "payoff" }, "UTC");
    expect(payoff.newBalance).toBe(0);
  });

  it("zeroes a balance left at rounding noise instead of leaving a cent behind", async () => {
    const nearlyPaid = { ...CAR_LOAN, fields: { ...CAR_LOAN.fields, currentBalance: 0.4, annualInterestRate: 0 } };
    const out = await applyLiabilityPayment(fakeStorage(nearlyPaid), nearlyPaid, { amount: 0.4 }, "UTC");
    expect(out.newBalance).toBe(0);
  });

  it("leaves no second implementation behind in the AI engine", () => {
    // A source-text guard: the point of the extraction is that the tool cannot
    // drift back into doing its own arithmetic.
    const src = readFileSync(resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    const tool = src.slice(src.indexOf('case "add_liability_payment"'));
    const body = tool.slice(0, tool.indexOf('case "link_liability_asset"'));
    expect(body).toContain("applyLiabilityPayment");
    expect(body).not.toContain("America/Los_Angeles");
    expect(body).not.toMatch(/monthlyRate/);
  });
});
