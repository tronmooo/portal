/**
 * Rule 33 — conflicting canonical facts trigger an integrity warning.
 *
 * `validateEntityIntegrity` (shared/entity-integrity) reports a record that
 * names one fact twice with two answers; `resolveCanonicalFields` chooses the
 * canonical key, parks the loser under `_integrity.stale` and hands the
 * warnings back for the server to log. Also pins Rule 11: the alias tables
 * (profile-field-canon, profile-field-identity, registry-fields) agree.
 */
import { describe, it, expect } from "vitest";
import { validateEntityIntegrity, resolveCanonicalFields, readIntegrityMeta } from "@shared/entity-integrity";
import { CANONICAL_ALIASES, canonicalFieldKey, canonicalizeProfileFields } from "@shared/profile-field-canon";
import { fieldIdentity } from "@shared/profile-field-identity";
import { REGISTRY_KEY_ALIASES, prepareProfileFields } from "@shared/registry-fields";
import { readInterestRatePct, readMonthlyPayment, readBalance } from "@shared/liability-fields";
import { resolveAnnualRate } from "@shared/liability-calc";

describe("validateEntityIntegrity — the exact regressions", () => {
  it("{ apr: 6, annualInterestRate: 0.1 } is an alias_conflict on interestRate", () => {
    const r = validateEntityIntegrity({ id: "loan-1", type: "liability", fields: { apr: 6, annualInterestRate: 0.1 } });
    expect(r.ok).toBe(false);
    const w = r.warnings.find((x) => x.code === "alias_conflict");
    expect(w).toBeTruthy();
    expect(w!.canonicalKey).toBe("interestRate");
    expect(w!.canonicalValue).toBe(6);
    expect(w!.conflicts).toEqual([{ key: "annualInterestRate", value: 0.1 }]);
    expect(w!.message).toContain("interestRate");
  });

  it("{ monthlyPayment: 912.4, monthlyAmount: 900 } conflicts; the canonical key's value wins", () => {
    const r = validateEntityIntegrity({ fields: { monthlyAmount: 900, monthlyPayment: 912.4 } });
    expect(r.ok).toBe(false);
    expect(r.warnings[0]).toMatchObject({ code: "alias_conflict", canonicalKey: "monthlyPayment", canonicalValue: 912.4, conflicts: [{ key: "monthlyAmount", value: 900 }] });
  });

  it("equal aliases (numerically, with currency punctuation) are not a warning", () => {
    expect(validateEntityIntegrity({ fields: { balance: 26000, currentBalance: "$26,000", loanBalance: "26000" } }).ok).toBe(true);
    expect(validateEntityIntegrity({ fields: { interestRate: 6, apr: "6%" } }).ok).toBe(true);
    expect(validateEntityIntegrity({ fields: { balance: 100 } }).ok).toBe(true);
    expect(validateEntityIntegrity({ fields: null }).ok).toBe(true);
    expect(validateEntityIntegrity(null).ok).toBe(true);
  });

  it("impossible days, negative money and a dueDate/nextDueDate split are reported", () => {
    const r = validateEntityIntegrity({ type: "liability", fields: { dueDate: "2026-02-30", nextDueDate: "2026-03-01", balance: -50 } });
    const codes = r.warnings.map((w) => w.code).sort();
    expect(codes).toEqual(["impossible_date", "negative_money", "schedule_conflict"]);
    expect(r.warnings.find((w) => w.code === "impossible_date")!.canonicalKey).toBe("dueDate");
    expect(r.warnings.find((w) => w.code === "negative_money")!.canonicalKey).toBe("balance");
  });

  it("a loan's nextPaymentDate override is a schedule, not a conflict with its creation dueDate", () => {
    expect(validateEntityIntegrity({ fields: { dueDate: "2025-03-31", nextPaymentDate: "2026-10-25" } }).ok).toBe(true);
  });
});

describe("resolveCanonicalFields — choose, park, report", () => {
  it("keeps the canonical value, drops the alternates, parks the differing one under _integrity.stale", () => {
    const { fields, warnings, changed } = resolveCanonicalFields({ apr: 6, annualInterestRate: 0.1, lender: "CU" });
    expect(changed).toBe(true);
    expect(fields.interestRate).toBe(6);
    expect(fields.apr).toBeUndefined();
    expect(fields.annualInterestRate).toBeUndefined();
    expect(fields.lender).toBe("CU");
    expect(readIntegrityMeta(fields)).toMatchObject({ stale: { annualInterestRate: 0.1 }, codes: ["alias_conflict"] });
    expect(warnings).toHaveLength(1);
    // The readers now see ONE rate everywhere.
    expect(readInterestRatePct(fields)).toBe(6);
    expect(resolveAnnualRate(fields)).toBeCloseTo(0.06, 9);
  });

  it("agreeing aliases collapse silently (no stale entry, no warning)", () => {
    const { fields, warnings } = resolveCanonicalFields({ balance: 26000, currentBalance: 26000, remainingBalance: "$26,000" });
    expect(fields).toEqual({ balance: 26000 });
    expect(warnings).toEqual([]);
  });

  it("does not fold schedule keys — they are distinct facts", () => {
    const { fields } = resolveCanonicalFields({ dueDate: "2026-10-01", nextDueDate: "2026-11-01" });
    expect(fields.dueDate).toBe("2026-10-01");
    expect(fields.nextDueDate).toBe("2026-11-01");
    expect(readIntegrityMeta(fields)?.codes).toEqual(["schedule_conflict"]);
  });
});

describe("Rule 11 — the alias tables agree and the readers read canonical first", () => {
  it("every canon alias has the same identity as its canonical key", () => {
    for (const [canonical, aliases] of Object.entries(CANONICAL_ALIASES)) {
      for (const a of aliases) expect(fieldIdentity(a), `${a} → ${canonical}`).toBe(fieldIdentity(canonical));
    }
  });

  it("the registry fold points at the canon table's keys, never the other way", () => {
    for (const [alias, target] of REGISTRY_KEY_ALIASES) expect(canonicalFieldKey(target), alias).toBe(target);
    const byAlias = Object.fromEntries(REGISTRY_KEY_ALIASES);
    expect(byAlias.monthly_payment).toBe("monthlyPayment");
    expect(byAlias.current_value).toBe("currentValue");
    expect(byAlias.current_balance).toBe("balance");
    expect(byAlias.original_balance).toBe("originalBalance");
  });

  it("the rate spellings all normalize on ingestion, and prepareProfileFields agrees with canonicalizeProfileFields", () => {
    for (const k of ["annualInterestRate", "annualRate", "annual_interest_rate", "loanRate", "annualInterest", "apr"]) {
      expect(canonicalFieldKey(k), k).toBe("interestRate");
    }
    const viaAi = canonicalizeProfileFields({ annualInterestRate: 6.5, currentBalance: 5000, monthlyAmount: 300, value: 9000 }).fields;
    const viaStorage = prepareProfileFields({ annualInterestRate: 6.5, current_balance: "5000", monthly_payment: "300", current_value: 9000 }, { typeKey: "auto_loan", todayISO: "2026-09-22" });
    expect(viaAi).toEqual({ interestRate: 6.5, balance: 5000, monthlyPayment: 300, currentValue: 9000 });
    expect(viaStorage).toEqual({ interestRate: 6.5, balance: 5000, monthlyPayment: 300, currentValue: 9000 });
  });

  it("the readers start from the canonical key and still see every legacy spelling", () => {
    expect(readInterestRatePct({ interestRate: 6, annualInterestRate: 0.1 })).toBe(6);
    expect(readInterestRatePct({ annualInterestRate: 6.49 })).toBe(6.49);
    expect(readInterestRatePct({ finance: { apr: "5.5%" } })).toBe(5.5);
    expect(readMonthlyPayment({ monthlyPayment: 912.4, monthlyAmount: 900 })).toBe(912.4);
    expect(readMonthlyPayment({ monthlyAmount: 900 })).toBe(900);
    expect(readMonthlyPayment({ amount: 92 })).toBe(92);
    expect(readMonthlyPayment({ loan: { monthly_payment: "$1,200" } })).toBe(1200);
    expect(readBalance({ balance: 100, currentBalance: 200 })).toBeGreaterThan(0);
    expect(readBalance({ fields: { loan_balance: "3,000" } })).toBe(3000);
  });
});
