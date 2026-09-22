/**
 * Rule 34 — every write passes schema AND relationship validation before it
 * is committed (shared/write-validation.ts).
 */
import { describe, it, expect } from "vitest";
import { validateWriteCandidate, assertWriteCandidate, WriteValidationError } from "../shared/write-validation";
import { MAX_TRANSACTION_AMOUNT } from "../shared/schema";

const SELF = "self-1";
const AVERY = "avery-1";
const VALID = new Set([SELF, AVERY]);

describe("validateWriteCandidate", () => {
  it("accepts a well-formed expense whose owner exists", () => {
    expect(validateWriteCandidate("expense", { amount: 12.5, date: "2026-09-22", description: "Lunch", linkedProfiles: [AVERY] }, { validProfileIds: VALID })).toEqual({ ok: true });
  });

  it("rejects an owner id the user does not have", () => {
    const r = validateWriteCandidate("expense", { amount: 1, linkedProfiles: [AVERY, "ghost"] }, { validProfileIds: VALID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["owner profile ghost does not exist"]);
  });

  it("rejects a parent that does not exist, and accepts one that does (or one the caller vouches for)", () => {
    expect(validateWriteCandidate("profile", { parentProfileId: "ghost" }, { validProfileIds: VALID }).ok).toBe(false);
    expect(validateWriteCandidate("profile", { parentProfileId: AVERY }, { validProfileIds: VALID }).ok).toBe(true);
    expect(validateWriteCandidate("profile", { parentProfileId: "ghost" }, { validProfileIds: VALID, parentExists: () => true }).ok).toBe(true);
  });

  it("rejects a day that is not on the calendar and a string that is not a date; accepts timestamps and blanks", () => {
    expect(validateWriteCandidate("expense", { date: "2026-02-30" }, { validProfileIds: VALID }).ok).toBe(false);
    expect(validateWriteCandidate("task", { dueDate: "not-a-date" }, { validProfileIds: VALID }).ok).toBe(false);
    expect(validateWriteCandidate("expense", { date: "2026-09-22T18:50:00.000Z" }, { validProfileIds: VALID }).ok).toBe(true);
    expect(validateWriteCandidate("expense", { date: "" }, { validProfileIds: VALID }).ok).toBe(true);
    expect(validateWriteCandidate("expense", { date: null }, { validProfileIds: VALID }).ok).toBe(true);
  });

  it("rejects money that is not finite, negative amounts, and a transaction over the ceiling", () => {
    expect(validateWriteCandidate("expense", { amount: Number.NaN }, { validProfileIds: VALID }).ok).toBe(false);
    expect(validateWriteCandidate("income", { amount: -5 }, { validProfileIds: VALID }).ok).toBe(false);
    expect(validateWriteCandidate("expense", { amount: MAX_TRANSACTION_AMOUNT + 1 }, { validProfileIds: VALID }).ok).toBe(false);
    expect(validateWriteCandidate("expense", { amount: MAX_TRANSACTION_AMOUNT }, { validProfileIds: VALID }).ok).toBe(true);
    // A balance-sheet number is not a transaction: no ceiling, may be negative.
    expect(validateWriteCandidate("profile", { balance: -250 }, { validProfileIds: VALID }).ok).toBe(true);
  });

  it("a null profile set skips ownership checks (a store with no profiles yet) but not the shape checks", () => {
    expect(validateWriteCandidate("document", { linkedProfiles: ["pA"] }, { validProfileIds: null }).ok).toBe(true);
    expect(validateWriteCandidate("document", { linkedProfiles: "pA" }, { validProfileIds: null }).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const r = validateWriteCandidate("expense", { amount: -1, date: "2026-13-01", linkedProfiles: ["ghost"] }, { validProfileIds: VALID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
  });
});

describe("assertWriteCandidate", () => {
  it("throws a 400 WRITE_INVALID error carrying the problems", () => {
    let caught: any;
    try { assertWriteCandidate("expense", { amount: -1 }, { validProfileIds: VALID }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WriteValidationError);
    expect(caught.statusCode).toBe(400);
    expect(caught.code).toBe("WRITE_INVALID");
    expect(caught.errors).toEqual(["amount cannot be negative"]);
  });
});
