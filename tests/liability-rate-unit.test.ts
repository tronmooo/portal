// A debt's rate has ONE unit, stated on the record (Liabilities tutorial,
// 2026-11-20, findings 2 and 6).
//
//  • Typing 0.9 (%) in the loan-terms form stored 90 and the header read
//    "APR 90.00%": the form ran the "1 or less is a fraction" guess on a value
//    typed into a "%" field. A 0.9% promo APR could not be entered at all.
//  • Stored rates were a mix of percents (24.99, 5) and fractions (0.0625,
//    0.22899999999999998) that only the guessing readers could tell apart.
//
// A rate is stored as a percent WITH a unit marker; a marked rate is never
// guessed, and an unmarked one is converted (once) the next time it is
// written.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  RATE_UNIT_KEY, storedRateFields, stampRateUnit, chatRatePct,
  readAnnualRate, readInterestRatePct, rateInputValue, rateInputToStoredPct, liabilityReceiptFields,
} from "../shared/liability-fields";
import { deriveLiabilityAmortization } from "../shared/liability-derived";
import { composeOverview } from "../shared/overview-compose";
import { fieldSemantics, isAdministrativeKey } from "../shared/overview-semantics";
import { isSystemFieldKey } from "../shared/system-fields";
import { prepareProfileFields } from "../shared/registry-fields";
import { resolveCanonicalFields } from "../shared/entity-integrity";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("a rate typed into a % field is that percent", () => {
  it("0.9 is 0.9%, not 90%", () => {
    const f = storedRateFields("0.9");
    expect(f).toEqual({ interestRate: 0.9, [RATE_UNIT_KEY]: "percent" });
    expect(readInterestRatePct(f)).toBe(0.9);
    expect(readAnnualRate(f)).toBeCloseTo(0.009, 10);
    expect(rateInputValue(f)).toBe("0.9");
    expect(rateInputToStoredPct("0.9")).toBe(0.9);
  });

  it("1 is 1%, 7 is 7%, 24.99 is 24.99%", () => {
    for (const v of [1, 7, 24.99]) expect(readInterestRatePct(storedRateFields(v))).toBe(v);
  });

  it("a blank or non-numeric input writes nothing", () => {
    expect(storedRateFields("")).toEqual({});
    expect(storedRateFields("abc")).toEqual({});
    expect(storedRateFields(null)).toEqual({});
  });

  it("the payoff math uses 0.9%, so the schedule is not a 90% loan", () => {
    const amort = deriveLiabilityAmortization(
      { balance: 12000, monthlyPayment: 500, dueDay: 15, ...storedRateFields(0.9) }, "2026-11-20", { typeKey: "auto_loan" });
    // 0.9% on $12,000 is $9.00 in the first month (90% would be $900).
    expect(amort.rows[0].interest).toBeCloseTo(9, 2);
  });
});

describe("rows written before the marker", () => {
  it("are still read by the old rule", () => {
    expect(readInterestRatePct({ interestRate: 0.0625 })).toBe(6.25);
    expect(readInterestRatePct({ interestRate: 6.25 })).toBe(6.25);
    expect(readInterestRatePct({ interestRate: 0.22899999999999998 })).toBe(22.9);
  });

  it("become a marked percent the next time they are written", () => {
    expect(stampRateUnit({ interestRate: 0.0625, balance: 1 })).toEqual({ interestRate: 6.25, balance: 1, [RATE_UNIT_KEY]: "percent" });
    expect(stampRateUnit({ interestRate: 0.22899999999999998 })).toEqual({ interestRate: 22.9, [RATE_UNIT_KEY]: "percent" });
    expect(stampRateUnit({ interestRate: 24.99 })).toEqual({ interestRate: 24.99, [RATE_UNIT_KEY]: "percent" });
  });

  it("a marked rate is never converted again", () => {
    const marked = storedRateFields(0.9);
    expect(stampRateUnit({ ...marked })).toEqual(marked);
    expect(stampRateUnit(stampRateUnit({ interestRate: 0.065 }))).toEqual({ interestRate: 6.5, [RATE_UNIT_KEY]: "percent" });
  });

  it("fields with no rate are left alone", () => {
    expect(stampRateUnit({ balance: 5 })).toEqual({ balance: 5 });
  });
});

describe("the marker survives a write and is never shown as a field", () => {
  it("passes the storage field fold untouched", () => {
    const prepared = prepareProfileFields({ interest_rate: 0.9, [RATE_UNIT_KEY]: "percent", current_balance: 100 });
    const stored = resolveCanonicalFields(prepared).fields;
    expect(stored[RATE_UNIT_KEY]).toBe("percent");
    expect(readInterestRatePct(stored)).toBe(0.9);
  });

  it("is a system key on every surface that lists fields", () => {
    expect(isSystemFieldKey(RATE_UNIT_KEY)).toBe(true);
    expect(isAdministrativeKey(RATE_UNIT_KEY)).toBe(true);
    expect(fieldSemantics(RATE_UNIT_KEY, "percent").key).toBe(RATE_UNIT_KEY);
  });

  it("the Overview prints a marked 0.9 as 0.9, and an unmarked 0.0625 as 6.25", () => {
    const rateOf = (fields: Record<string, any>) => {
      const spec = composeOverview({ entity: { id: "l", name: "Loan", type: "liability", type_key: "auto_loan", fields }, now: new Date("2026-11-20T12:00:00") } as any);
      const out: any[] = [];
      JSON.stringify(spec, (_k, v) => { if (v && typeof v === "object" && v.sourceReference?.fieldKey === "interestRate") out.push(v.value); return v; });
      return out;
    };
    const marked = rateOf({ balance: 12000, ...storedRateFields(0.9) });
    expect(marked.length).toBeGreaterThan(0);
    for (const v of marked) expect(v).toBe(0.9);
    for (const v of rateOf({ balance: 12000, interestRate: 0.0625 })) expect(v).toBe(6.25);
  });
});

describe("the chat's rate", () => {
  it("a fraction or a percent from the model becomes the percent", () => {
    expect(chatRatePct(0.0625)).toBe(6.25);
    expect(chatRatePct(6.25)).toBe(6.25);
    expect(chatRatePct(0.229)).toBe(22.9);
    expect(Number.isNaN(chatRatePct("n/a"))).toBe(true);
  });

  it("a rate under 1 that the user stated as a percentage is that percent", () => {
    expect(chatRatePct(0.9, "0.9% promo APR for 12 months")).toBe(0.9);
    expect(chatRatePct(0.5, "the rate is 0.5 percent")).toBe(0.5);
    // Not stated as a percentage in the message: still a fraction.
    expect(chatRatePct(0.065, "6.5% APR")).toBe(6.5);
  });

  it("the save receipt asks for the same percent the tool stores", () => {
    expect(liabilityReceiptFields("create_liability", { annualRate: 0.9, __userMessage: "at 0.9% APR" }).interestRate).toBe(0.9);
    expect(liabilityReceiptFields("update_liability", { changes: { annualRate: 0.055 } }).interestRate).toBe(5.5);
  });
});

describe("every writer that knows its unit stamps it", () => {
  it("the loan-terms form, the asset loan tab, the create dialog and the chat tools", () => {
    expect(src("client/src/pages/liability-detail.tsx")).toContain("Object.assign(fields, storedRateFields(v.rate));");
    expect(src("client/src/pages/profile-detail.tsx")).toContain("if (v.rate) Object.assign(fields, storedRateFields(v.rate));");
    expect(src("client/src/components/CreateProfileDialog.tsx")).toContain('(cleanFields as any)[RATE_UNIT_KEY] = "percent";');
    const engine = src("server/ai-engine.ts");
    expect(engine).toContain("Object.assign(fields, storedRateFields(ratePct));");
    expect(engine).toContain('ch[RATE_UNIT_KEY] = "percent";');
  });

  it("the storage layer stamps any debt rate that arrives without it", () => {
    expect(src("server/supabase-storage.ts")).toMatch(/if \(meta\.entityType === "liability" \|\| meta\.entityType === "loan"\) prepared = stampRateUnit\(prepared\);/);
  });

  it("no page prints the raw rate field (L3)", () => {
    expect(src("client/src/pages/profile-detail.tsx")).not.toMatch(/\$\{f\.interestRate\}% APR/);
  });
});
