// A payment's interest and principal add up to the payment, to the cent (L5).
// allocatePayment rounded an UNROUNDED interest and the principal computed from
// it separately, so $418.50 on $12,030 at 6.995% split as $70.13 + $348.38 —
// the balance fell a cent too far and a cent more was booked than was paid
// (integrity run, 2026-11-27, ui-money.debt). The interest is one month at the
// stored percent, rounded to the cent; the principal is the rest.
import { describe, it, expect } from "vitest";
import { allocatePayment } from "../shared/liability-calc";
import { splitPayment } from "./integrity/oracle";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("allocatePayment", () => {
  it("splits so that interest + principal + fees = what was paid, and matches the oracle", () => {
    const rng = mulberry32(20261127);
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const balance = Math.round((500 + rng() * 60000) * 100) / 100;
      const apr = Math.round(rng() * 2400) / 100 + 0.01; // 0.01 – 24 %, two decimals
      const pay = Math.round((50 + rng() * 2000) * 100) / 100;
      const a = allocatePayment(pay, balance, apr / 100); // the engine is fed the DECIMAL (L3)
      if (pay >= balance) continue;
      expect(Math.round((a.interest + a.principal) * 100)).toBe(Math.round(pay * 100));
      // The exact interest in cents, by integer arithmetic: balance cents ×
      // rate in hundredths of a percent / 120000. At an exact half cent the
      // float paths may round either way; anywhere else they must agree.
      const num = Math.round(balance * 100) * Math.round(apr * 100);
      const tie = num % 120000 === 60000;
      if (Math.round(pay * 100) <= Math.ceil(num / 120000)) continue; // all interest: nothing to split
      const o = splitPayment(balance, apr, pay);
      if (!tie) {
        expect(a.interest).toBe(o.interest);
        expect(a.principal).toBe(o.principal);
      } else {
        expect([Math.floor(num / 120000), Math.ceil(num / 120000)]).toContain(Math.round(a.interest * 100));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
