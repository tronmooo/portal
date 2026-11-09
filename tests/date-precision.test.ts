// 2026-11-09 report: "Max's birthday defaults to the 1st of the month". The
// user said "born in March 2020"; the model stored 2020-03-01, and from then
// on March 1 was Max's birthday everywhere. A day the user never stated is
// never stored (shared/date-precision).
import { describe, it, expect } from "vitest";
import { keepStatedPrecision, keepStatedBirthPrecision, formatYearMonth, isBirthDateField } from "../shared/date-precision";
import { formatFieldValue } from "../shared/domain/format";
import { formatClockTime } from "../shared/timezone";
import { bareDateOf } from "../shared/date-rules";

describe("keepStatedPrecision", () => {
  it("a month and year with no day stays a month", () => {
    expect(keepStatedPrecision("2020-03-01", "Add my dog Max, a golden retriever born in March 2020, 70 lbs")).toBe("2020-03");
    expect(keepStatedPrecision("2020-03-01", "Max was born mar 2020")).toBe("2020-03");
    expect(keepStatedPrecision("2020-03-01", "born 3/2020")).toBe("2020-03");
  });

  it("a stated day is kept", () => {
    expect(keepStatedPrecision("2020-03-01", "Max was born March 1, 2020")).toBe("2020-03-01");
    expect(keepStatedPrecision("2020-03-01", "born on the 1st of March 2020")).toBe("2020-03-01");
    expect(keepStatedPrecision("2020-03-01", "born 3/1/2020")).toBe("2020-03-01");
    expect(keepStatedPrecision("2020-03-01", "dob 2020-03-01")).toBe("2020-03-01");
    expect(keepStatedPrecision("2020-03-01", "born the first of March 2020")).toBe("2020-03-01");
  });

  it("leaves everything else alone", () => {
    expect(keepStatedPrecision("2020-03-14", "born in March 2020")).toBe("2020-03-14");
    expect(keepStatedPrecision("2020-03-01", "")).toBe("2020-03-01");
    expect(keepStatedPrecision("2020-03-01", "born in 2020")).toBe("2020-03-01"); // the month isn't stated either; not ours to guess
    expect(keepStatedPrecision("2020-03", "born in March 2020")).toBe("2020-03");
    expect(keepStatedPrecision(42, "born in March 2020")).toBe(42);
  });

  it("only birth-date fields are touched", () => {
    const fields: Record<string, unknown> = { birthday: "2020-03-01", adoptedDate: "2020-03-01", breed: "Golden Retriever" };
    expect(keepStatedBirthPrecision(fields, "born in March 2020, adopted March 2020")).toEqual(["birthday"]);
    expect(fields).toEqual({ birthday: "2020-03", adoptedDate: "2020-03-01", breed: "Golden Retriever" });
    expect(isBirthDateField("dateOfBirth")).toBe(true);
    expect(isBirthDateField("date_of_birth")).toBe(true);
    expect(isBirthDateField("expirationDate")).toBe(false);
  });

  it("a month-precision birthday makes no dated rule and reads as the month", () => {
    expect(bareDateOf("2020-03")).toBeNull();
    expect(formatYearMonth("2020-03")).toBe("March 2020");
    expect(formatYearMonth("2020-13")).toBeNull();
    expect(formatFieldValue("birthday", "2020-03")).toBe("March 2020");
  });
});

describe("formatClockTime", () => {
  it("renders a stored clock time for people", () => {
    expect(formatClockTime("10:00")).toBe("10 AM");
    expect(formatClockTime("18:30")).toBe("6:30 PM");
    expect(formatClockTime("00:05")).toBe("12:05 AM");
    expect(formatClockTime("12:00")).toBe("12 PM");
    expect(formatClockTime(undefined)).toBe("");
    expect(formatClockTime("soon")).toBe("");
  });
});
