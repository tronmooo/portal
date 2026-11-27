// The app's own calculations, held to an independent second implementation on
// random inputs.
//
// WHY (owner, 2026-11-27: "independently calculated expected results,
// randomized testing"): a test that expects `computeNetWorth(...)` to equal
// what `computeNetWorth(...)` returns proves nothing, and a hand-picked example
// proves one case. tests/integrity/oracle.ts is the same arithmetic written a
// second time from the rule as the owner states it, importing nothing from the
// app. Each property below runs a few hundred seeded cases; a failure prints
// the case, and the seed makes it repeatable (INTEGRITY_SEED=… npx vitest run …).
import { describe, it, expect } from "vitest";
import * as O from "./integrity/oracle";
import { mulberry32 } from "./integrity/framework";
import { nextBillDate } from "../shared/bills-timeline";
import { allocatePayment, buildAmortization, computeAmortizedPayment } from "../shared/liability-calc";
import { computeNetWorth } from "../shared/net-worth";
import { advance } from "../shared/recurrence";
import { billRecurrenceRule } from "../shared/liability-recurrence";
import { storedRateFields } from "../shared/liability-fields";

const SEED = Number(process.env.INTEGRITY_SEED ?? 20261127);
const gen = (salt: number) => {
  const rng = mulberry32(SEED + salt);
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  return { rng, int, pick: <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)], money: (lo: number, hi: number) => Math.round((lo + rng() * (hi - lo)) * 100) / 100 };
};
const day = (g: ReturnType<typeof gen>) => O.fmtYmd((() => { const y = g.int(2023, 2032), m = g.int(1, 12); return { y, m, d: g.int(1, O.daysInMonth(y, m)) }; })());

describe("the oracle's calendar agrees with the platform's (so it can be trusted as a second opinion)", () => {
  it("day numbers, weekdays and month lengths match Date.UTC for 2,000 random days", () => {
    const g = gen(1);
    for (let i = 0; i < 2000; i++) {
      const d = day(g);
      const { y, m, d: dd } = O.parseYmd(d);
      const utc = Date.UTC(y, m - 1, dd);
      expect(O.dayNumber(d), d).toBe(utc / 86_400_000);
      expect(O.fromDayNumber(O.dayNumber(d)), d).toBe(d);
      expect(O.weekday(d), d).toBe(new Date(utc).getUTCDay());
      expect(O.daysInMonth(y, m)).toBe(new Date(Date.UTC(y, m, 0)).getUTCDate());
    }
  });

  it("a monthly series keeps its anchor day through short months", () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => O.occurrence("2027-01-31", "monthly", k))).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31", "2027-06-30"]);
    expect([0, 1, 4].map((k) => O.occurrence("2028-02-29", "yearly", k))).toEqual(["2028-02-29", "2029-02-28", "2032-02-29"]);
    expect(O.occurrencesBetween("2026-12-25", "weekly", "2026-12-25", "2027-01-10")).toEqual(["2026-12-25", "2027-01-01", "2027-01-08"]);
  });
});

describe("a recurring bill's next date (shared/bills-timeline nextBillDate)", () => {
  const FREQS: O.Freq[] = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
  it("equals the first unsettled occurrence on or after today — 600 random bills", () => {
    const g = gen(2);
    const bad: string[] = [];
    for (let i = 0; i < 600; i++) {
      const frequency = g.pick(FREQS);
      const stored = day(g);
      const today = O.addDays(stored, g.int(-40, 500));
      // settle some of the occurrences around today
      const upcoming = Array.from({ length: 4 }, (_, k) => O.nextBillDate(stored, frequency, today, []));
      const settled = g.rng() < 0.5 ? [O.nextBillDate(stored, frequency, today)] : [];
      if (settled.length && g.rng() < 0.4) settled.push(O.nextBillDate(stored, frequency, today, settled));
      void upcoming;
      const want = O.nextBillDate(stored, frequency, today, settled);
      const got = nextBillDate({ frequency, nextDueDate: stored, settledDates: settled } as any, today);
      if (got !== want) bad.push(`${frequency} stored ${stored}, today ${today}, settled ${JSON.stringify(settled)}: app ${got}, oracle ${want}`);
    }
    expect(bad.slice(0, 8), `${bad.length} of 600 disagree`).toEqual([]);
  });

  it("the series' own step (advance + the bill's anchor day) matches calendar arithmetic for month-end anchors", () => {
    const g = gen(3);
    const bad: string[] = [];
    for (let i = 0; i < 300; i++) {
      const frequency = g.pick(["monthly", "quarterly", "yearly"] as const);
      const y = g.int(2024, 2030), m = g.int(1, 12);
      const anchor = O.fmtYmd({ y, m, d: g.pick([28, 29, 30, 31].filter((d) => d <= O.daysInMonth(y, m))) });
      const rule = { ...billRecurrenceRule(frequency), anchorDay: Number(anchor.slice(8, 10)) } as any;
      let cur = anchor;
      for (let k = 1; k <= 8; k++) {
        cur = advance(cur, rule);
        const want = O.occurrence(anchor, frequency, k);
        if (cur !== want) { bad.push(`${frequency} from ${anchor}, step ${k}: app ${cur}, oracle ${want}`); break; }
      }
    }
    expect(bad.slice(0, 8), `${bad.length} of 300 series drift`).toEqual([]);
  });
});

describe("a debt payment's split (shared/liability-calc allocatePayment)", () => {
  it("interest is one month's interest, the rest is principal, and the parts add up to the cent — 1,000 random payments", () => {
    const g = gen(4);
    const bad: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const balance = g.money(50, 400_000);
      const apr = g.pick([0, 0.9, 2.99, 3.9, 6, 6.5, 7.25, 12.5, 19.99, 22.9, 29.99]);
      const amount = g.money(1, Math.min(balance * 1.2, 9000));
      const got = allocatePayment(amount, balance, apr / 100);
      const want = O.splitPayment(balance, apr, amount);
      const close = (a: number, b: number) => Math.abs(a - b) <= 0.011;
      const sums = Math.abs(O.cents(got.interest + got.principal) - Math.min(amount, O.cents(balance + got.interest))) <= 0.011;
      const balanceOk = Math.abs(O.cents(balance - got.principal) - got.remainingBalanceAfter) <= 0.011;
      if (!close(got.interest, want.interest) || !close(got.principal, want.principal) || !close(got.remainingBalanceAfter, want.newBalance) || !sums || !balanceOk) {
        bad.push(`${amount} on ${balance} at ${apr}%: app ${JSON.stringify(got)}, oracle ${JSON.stringify(want)}`);
      }
    }
    expect(bad.slice(0, 8), `${bad.length} of 1000 disagree by more than a cent`).toEqual([]);
  });

  it("never drives the balance below zero and never charges more interest than was paid", () => {
    const g = gen(5);
    for (let i = 0; i < 500; i++) {
      const balance = g.money(1, 5000), amount = g.money(0.01, 20_000), apr = g.pick([0, 5, 25]);
      const got = allocatePayment(amount, balance, apr / 100);
      expect(got.remainingBalanceAfter).toBeGreaterThanOrEqual(0);
      expect(got.principal).toBeLessThanOrEqual(O.cents(balance) + 0.001);
      expect(got.interest).toBeLessThanOrEqual(amount + 0.001);
    }
  });
});

describe("a loan's payoff outlook (shared/liability-calc buildAmortization)", () => {
  it("months to zero and total interest match month-by-month arithmetic — 300 random loans", () => {
    const g = gen(6);
    const bad: string[] = [];
    for (let i = 0; i < 300; i++) {
      const balance = g.int(5, 4000) * 100;
      const apr = g.pick([0, 2.9, 4.5, 6, 7.25, 9.99, 14.9, 24.99]);
      const minPay = O.monthInterest(balance, apr);
      const payment = Math.max(25, Math.ceil(minPay * g.pick([1.3, 2, 4, 9]) / 5) * 5 + g.int(0, 40) * 5);
      const want = O.payoff(balance, apr, payment);
      const got = buildAmortization({ currentBalance: balance, annualInterestRate: apr / 100, monthlyPayment: payment, firstPaymentDate: "2027-01-15" } as any);
      // The app projects 50 years (600 rows). Past that it must SAY so
      // (beyondHorizon), never report the horizon as a payoff.
      if (want && want.months > 600) { if (!got.beyondHorizon || got.neverAmortizes) bad.push(`${balance} at ${apr}% paying ${payment}: takes ${want.months} months, but the app reports a payoff in ${got.payoffMonths}`); continue; }
      if (want && got.beyondHorizon) { bad.push(`${balance} at ${apr}% paying ${payment}: pays off in ${want.months} months, but the app says it is beyond the horizon`); continue; }
      if (!want) { if (!got.neverAmortizes) bad.push(`${balance} at ${apr}% paying ${payment}: oracle says it never pays off, app says ${got.payoffMonths} months`); continue; }
      const monthsOk = Math.abs(got.payoffMonths - want.months) <= 0;
      const interestOk = Math.abs(got.totalInterest - want.totalInterest) <= Math.max(0.05, want.months * 0.006);
      if (!monthsOk || !interestOk) bad.push(`${balance} at ${apr}% paying ${payment}: app ${got.payoffMonths} mo / ${got.totalInterest}, oracle ${want.months} mo / ${want.totalInterest}`);
      if (got.rows.length && Math.abs(got.rows[got.rows.length - 1].remainingBalance) > 0.01) bad.push(`${balance} at ${apr}%: the last row leaves ${got.rows[got.rows.length - 1].remainingBalance}`);
    }
    expect(bad.slice(0, 8), `${bad.length} of 300 disagree`).toEqual([]);
  });

  it("a loan that takes more than 50 years is beyond the horizon — not paid off in 600 months, and not 'never'", () => {
    const got = buildAmortization({ currentBalance: 342_200, annualInterestRate: 0, monthlyPayment: 135, firstPaymentDate: "2027-01-15" } as any);
    expect(O.payoff(342_200, 0, 135)?.months ?? Infinity).toBeGreaterThan(600); // 2,535 by hand
    expect(got.beyondHorizon).toBe(true);
    expect(got.neverAmortizes).toBeFalsy();
    expect(got.rows[got.rows.length - 1].remainingBalance).toBeGreaterThan(0);
    // one that just fits is a payoff
    const fits = buildAmortization({ currentBalance: 60_000, annualInterestRate: 0, monthlyPayment: 100, firstPaymentDate: "2027-01-15" } as any);
    expect(fits.beyondHorizon).toBeFalsy();
    expect(fits.payoffMonths).toBe(600);
  });

  it("a payment that does not cover the interest never pays off", () => {
    const got = buildAmortization({ currentBalance: 100_000, annualInterestRate: 0.12, monthlyPayment: 500, firstPaymentDate: "2027-01-15" } as any);
    expect(O.payoff(100_000, 12, 500)).toBeNull();
    expect(got.neverAmortizes).toBe(true);
  });

  it("the level payment of a term loan matches the annuity formula — 300 random loans", () => {
    const g = gen(7);
    for (let i = 0; i < 300; i++) {
      const principal = g.int(10, 5000) * 100, apr = g.pick([0, 3.5, 6.25, 9.9]), months = g.pick([12, 36, 60, 180, 360]);
      expect(Math.abs(O.cents(computeAmortizedPayment(principal, apr / 100, months)) - O.levelPayment(principal, apr, months)), `${principal} ${apr}% ${months}mo`).toBeLessThanOrEqual(0.011);
    }
  });
});

describe("net worth (shared/net-worth computeNetWorth)", () => {
  const ASSET_TYPES = ["vehicle", "property", "asset", "investment"] as const;
  const DEBT_KEYS = ["auto_loan", "credit_card", "mortgage", "personal_loan", "student_loan"] as const;
  const BILL_KEYS = ["utility", "phone_plan", "streaming"] as const;

  function household(g: ReturnType<typeof gen>) {
    const self = { id: "self", type: "self", name: "Me", fields: {} };
    const partner = { id: "partner", type: "person", name: "Partner", fields: {} };
    const profiles: any[] = [self, partner];
    const assetLinks: any[] = [], liabilityLinks: any[] = [];
    const assets: Array<{ value: number; partnerPct: number }> = [], debts: Array<{ value: number; partnerPct: number }> = [];
    const nA = g.int(0, 7);
    for (let i = 0; i < nA; i++) {
      const value = g.money(100, 600_000);
      const id = `a${i}`;
      // some nested under an earlier asset: nesting must not change any total
      const parent = i > 0 && g.rng() < 0.4 ? `a${g.int(0, i - 1)}` : "self";
      const key = g.pick(["currentValue", "value", "marketValue"]);
      profiles.push({ id, type: g.pick(ASSET_TYPES), name: id, parentProfileId: parent, fields: { [key]: value, purchasePrice: value + 5000 } });
      const partnerPct = g.pick([0, 0, 25, 50, 100]);
      if (partnerPct > 0) {
        assetLinks.push({ assetProfileId: id, partyProfileId: "partner", ownershipPercentage: partnerPct, role: "owner" });
        if (partnerPct < 100) assetLinks.push({ assetProfileId: id, partyProfileId: "self", ownershipPercentage: 100 - partnerPct, role: "owner" });
      }
      assets.push({ value, partnerPct });
    }
    const nD = g.int(0, 5);
    for (let i = 0; i < nD; i++) {
      const value = g.money(100, 400_000);
      const id = `d${i}`;
      profiles.push({ id, type: "liability", type_key: g.pick(DEBT_KEYS), name: id, parentProfileId: "self", fields: { balance: value, monthlyPayment: 100, ...storedRateFields(6.5) } });
      const partnerPct = g.pick([0, 0, 50, 100]);
      if (partnerPct > 0) {
        liabilityLinks.push({ liabilityProfileId: id, partyProfileId: "partner", ownershipPercentage: partnerPct, role: "owner" });
        if (partnerPct < 100) liabilityLinks.push({ liabilityProfileId: id, partyProfileId: "self", ownershipPercentage: 100 - partnerPct, role: "owner" });
      }
      debts.push({ value, partnerPct });
    }
    // recurring bills are liabilities on screen but never balance-sheet debt
    for (let i = 0; i < g.int(0, 3); i++) profiles.push({ id: `b${i}`, type: "liability", type_key: g.pick(BILL_KEYS), name: `b${i}`, parentProfileId: "self", fields: { amount: g.money(10, 300), frequency: "monthly", dueDate: "2027-01-15" } });
    // a legacy loan-typed profile is a debt, never also an asset
    if (g.rng() < 0.3) { const value = g.money(1000, 50_000); profiles.push({ id: "legacy", type: "loan", name: "legacy", parentProfileId: "self", fields: { balance: value, interestRate: 5 } }); debts.push({ value, partnerPct: 0 }); }
    return { profiles, ownership: { assetLinks, liabilityLinks, selfProfileId: "self" }, assets, debts };
  }

  it("everyone: every asset and debt once, bills excluded, nesting ignored — 400 random households", () => {
    const g = gen(8);
    const bad: string[] = [];
    for (let i = 0; i < 400; i++) {
      const h = household(g);
      const want = O.netWorth(h.assets.map((a) => ({ value: a.value })), h.debts.map((d) => ({ value: d.value })));
      const got = computeNetWorth(h.profiles, { mode: "everyone", selectedIds: [], ownership: h.ownership });
      if (Math.abs(got.assets - want.assets) > 0.011 || Math.abs(got.liabilities - want.liabilities) > 0.011 || Math.abs(got.netWorth - want.netWorth) > 0.011) {
        bad.push(`app ${got.assets}/${got.liabilities}/${got.netWorth}, oracle ${want.assets}/${want.liabilities}/${want.netWorth} — ${JSON.stringify(h.profiles.map((p) => [p.id, p.type, p.type_key, p.parentProfileId])).slice(0, 300)}`);
      }
    }
    expect(bad.slice(0, 5), `${bad.length} of 400 disagree`).toEqual([]);
  });

  it("one person: each item by that person's share; the two people's figures add up to the household's — 400 random households", () => {
    const g = gen(9);
    const bad: string[] = [];
    for (let i = 0; i < 400; i++) {
      const h = household(g);
      const wantPartner = O.netWorth(h.assets.map((a) => ({ value: a.value, sharePct: a.partnerPct })), h.debts.map((d) => ({ value: d.value, sharePct: d.partnerPct })));
      const wantSelf = O.netWorth(h.assets.map((a) => ({ value: a.value, sharePct: 100 - a.partnerPct })), h.debts.map((d) => ({ value: d.value, sharePct: 100 - d.partnerPct })));
      const partner = computeNetWorth(h.profiles, { mode: "selected", selectedIds: ["partner"], ownership: h.ownership });
      const self = computeNetWorth(h.profiles, { mode: "selected", selectedIds: ["self"], ownership: h.ownership });
      const all = computeNetWorth(h.profiles, { mode: "everyone", selectedIds: [], ownership: h.ownership });
      const off = (a: number, b: number) => Math.abs(a - b) > 0.02;
      if (off(partner.assets, wantPartner.assets) || off(partner.liabilities, wantPartner.liabilities) || off(self.assets, wantSelf.assets) || off(self.liabilities, wantSelf.liabilities)) {
        bad.push(`partner app ${partner.assets}/${partner.liabilities} oracle ${wantPartner.assets}/${wantPartner.liabilities}; self app ${self.assets}/${self.liabilities} oracle ${wantSelf.assets}/${wantSelf.liabilities}`);
      } else if (off(partner.netWorth + self.netWorth, all.netWorth)) {
        bad.push(`shares do not add up: ${partner.netWorth} + ${self.netWorth} ≠ ${all.netWorth}`);
      }
    }
    expect(bad.slice(0, 5), `${bad.length} of 400 disagree`).toEqual([]);
  });
});

describe("the oracle's own small rules", () => {
  it("a streak ends at the first missing day, and today not yet checked does not break it", () => {
    expect(O.dailyStreak(["2026-11-27", "2026-11-26", "2026-11-25", "2026-11-23"], "2026-11-27")).toBe(3);
    expect(O.dailyStreak(["2026-11-26", "2026-11-25"], "2026-11-27")).toBe(2);
    expect(O.dailyStreak(["2026-11-24"], "2026-11-27")).toBe(0);
  });
  it("pace and speed", () => {
    expect(O.pace(1.25, 14)).toEqual({ text: "11:12", mph: 5.36 });
    expect(O.pace(1.5, 14)).toEqual({ text: "9:20", mph: 6.43 });
  });
  it("interest once a month; extra principal carries none", () => {
    expect(O.splitPayment(1250, 22.9, 100)).toEqual({ interest: 23.85, principal: 76.15, newBalance: 1173.85 });
    expect(O.splitPayment(1173.85, 22.9, 100, { interestAlreadyCharged: true })).toEqual({ interest: 0, principal: 100, newBalance: 1073.85 });
    expect(O.splitPayment(500, 22.9, 50, { extraPrincipal: true }).interest).toBe(0);
  });
});
