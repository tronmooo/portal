// Variable / usage-based liabilities: the per-occurrence money model.
//
// The property under test throughout is the one the whole design exists for:
// EDITING ONE BILLING PERIOD CANNOT CHANGE ANY OTHER PERIOD. Every test that
// touches an amount also asserts what the neighbouring months still say.

import { describe, it, expect } from "vitest";
import {
  resolveBillingModel, normalizeBillingModel, resolveOccurrenceAmount,
  addCharge, removeCharge, setEstimate, setActual, occurrenceCharges,
  findOccurrenceForPeriod, hasVariableAmounts, normalizeChargeKind,
  type OccurrenceOverride,
} from "@shared/liability-billing";
import { generateSchedule, monthlyTotals, totalForWindow } from "@shared/liability-schedule";
import { seriesFromLiabilityProfiles } from "@shared/calendar-adapters";
import { generateSeriesOccurrences } from "@shared/calendar-occurrences";
import { moneyCapabilitiesFor, hasPerOccurrenceMoney } from "@shared/calendar-capabilities";

const TODAY = "2026-08-11";

/** A usage-based AI subscription: $20/month base, due the 20th. */
function chatgpt(occurrences: Record<string, OccurrenceOverride> = {}) {
  return {
    id: "liab-chatgpt",
    type: "liability",
    type_key: "software",
    name: "ChatGPT",
    fields: {
      billingModel: "usage_based",
      monthlyAmount: 20, amount: 20,
      frequency: "monthly",
      firstPaymentDate: "2026-07-20",
      dueDate: "2026-08-20", nextDueDate: "2026-08-20",
      occurrences,
    },
  };
}

/** A variable utility bill: no fixed amount, due the 5th. */
function electric(occurrences: Record<string, OccurrenceOverride> = {}) {
  return {
    id: "liab-electric",
    type: "liability",
    type_key: "utility",
    name: "Electric",
    fields: {
      billingModel: "variable",
      monthlyAmount: 80, amount: 80,
      frequency: "monthly",
      firstPaymentDate: "2026-01-05",
      dueDate: "2026-08-05", nextDueDate: "2026-08-05",
      occurrences,
    },
  };
}

describe("billing model resolution", () => {
  it("reads an explicit billingModel off the liability", () => {
    expect(resolveBillingModel(chatgpt())).toBe("usage_based");
    expect(resolveBillingModel(electric())).toBe("variable");
  });

  it("falls back to the behavioral family so pre-existing liabilities still resolve", () => {
    // No billingModel field at all — the shape every liability had before this
    // model existed. None of them may become "variable" by accident.
    expect(resolveBillingModel({ type_key: "mortgage", fields: {} })).toBe("installment");
    expect(resolveBillingModel({ type_key: "credit_card", fields: {} })).toBe("installment");
    expect(resolveBillingModel({ type_key: "streaming", fields: {} })).toBe("fixed");
    expect(resolveBillingModel({ type_key: "medical_debt", fields: {} })).toBe("one_time");
    expect(resolveBillingModel(null)).toBe("one_time");
  });

  it("normalizes the words a user or the AI actually says", () => {
    expect(normalizeBillingModel("Usage Based")).toBe("usage_based");
    expect(normalizeBillingModel("variable recurring")).toBe("variable");
    expect(normalizeBillingModel("metered")).toBe("usage_based");
    expect(normalizeBillingModel("one-time")).toBe("one_time");
    expect(normalizeBillingModel("nonsense")).toBeNull();
  });

  it("only variable and usage-based bills carry per-occurrence amounts", () => {
    expect(hasVariableAmounts(chatgpt())).toBe(true);
    expect(hasVariableAmounts(electric())).toBe(true);
    expect(hasVariableAmounts({ type_key: "streaming", fields: {} })).toBe(false);
  });
});

describe("resolveOccurrenceAmount", () => {
  it("a fixed bill is just its definition amount", () => {
    const m = resolveOccurrenceAmount(86.5, null, "fixed");
    expect(m.current).toBe(86.5);
    expect(m.isEstimate).toBe(false);
    expect(m.label).toBe("Actual");
  });

  it("assembles a usage-based total from base + credits + usage", () => {
    // The spec's worked example: $20 base + $14 credits + $8 usage = $42.
    let ov: OccurrenceOverride = {};
    ov = addCharge(ov, { amount: 14, kind: "credits", label: "Additional credits" });
    ov = addCharge(ov, { amount: 8, kind: "usage" });
    const m = resolveOccurrenceAmount(20, ov, "usage_based");
    expect(m.base).toBe(20);
    expect(m.chargeTotal).toBe(22);
    expect(m.current).toBe(42);
  });

  it("an explicit base charge replaces the definition base rather than doubling it", () => {
    const ov = addCharge({}, { amount: 20, kind: "base" });
    const m = resolveOccurrenceAmount(20, ov, "usage_based");
    expect(m.current).toBe(20);
  });

  it("moves from Estimated to Current to Actual as the period unfolds", () => {
    // "AI Service — Estimated $35 — Due August 20"
    let ov = setEstimate({}, 35);
    let m = resolveOccurrenceAmount(20, ov, "variable");
    expect(m.current).toBe(35);
    expect(m.label).toBe("Estimated");
    expect(m.isEstimate).toBe(true);

    // "…another $15 of usage occurs → Current $50"
    ov = addCharge(ov, { amount: 15, kind: "usage" });
    m = resolveOccurrenceAmount(20, ov, "variable");
    expect(m.current).toBe(50);
    expect(m.label).toBe("Current");
    expect(m.isEstimate).toBe(true);

    // The bill posts. That figure is now history.
    ov = setActual(ov, 50);
    m = resolveOccurrenceAmount(20, ov, "variable");
    expect(m.current).toBe(50);
    expect(m.label).toBe("Actual");
    expect(m.isEstimate).toBe(false);
  });

  it("a posted actual is immune to later charges and to definition changes", () => {
    let ov = setActual({}, 143.82);
    ov = addCharge(ov, { amount: 40, kind: "usage" });
    // Both the stray charge AND a completely different definition amount.
    expect(resolveOccurrenceAmount(80, ov, "variable").current).toBe(143.82);
    expect(resolveOccurrenceAmount(9999, ov, "variable").current).toBe(143.82);
  });

  it("stores discounts negative whichever sign the caller passes", () => {
    const a = addCharge({}, { amount: 5, kind: "discount" });
    const b = addCharge({}, { amount: -5, kind: "discount" });
    expect(occurrenceCharges(a)[0].amount).toBe(-5);
    expect(occurrenceCharges(b)[0].amount).toBe(-5);
    expect(resolveOccurrenceAmount(20, a, "usage_based").current).toBe(15);
  });

  it("removes a charge by id without disturbing the others", () => {
    let ov = addCharge({}, { amount: 14, kind: "credits", id: "c1" });
    ov = addCharge(ov, { amount: 8, kind: "usage", id: "c2" });
    ov = removeCharge(ov, "c1");
    expect(occurrenceCharges(ov).map(c => c.id)).toEqual(["c2"]);
    expect(resolveOccurrenceAmount(20, ov, "usage_based").current).toBe(28);
  });

  it("normalizes the charge words a user actually types", () => {
    // Spaces and hyphens are both folded to underscores, so the spoken form
    // and the token form of the same phrase land on the same kind.
    expect(normalizeChargeKind("top-up")).toBe("credits");
    expect(normalizeChargeKind("API usage")).toBe("usage");
    expect(normalizeChargeKind("api_usage")).toBe("usage");
    expect(normalizeChargeKind("late fee")).toBe("fee");
    expect(normalizeChargeKind("base subscription")).toBe("base");
    // Anything genuinely unrecognized lands on the neutral bucket rather than
    // being guessed into a kind that changes the sign.
    expect(normalizeChargeKind("whatever this is")).toBe("adjustment");
  });
});

describe("the schedule prices each period independently", () => {
  it("gives a variable bill three different monthly amounts from one definition", () => {
    // January $72, February $91, March $84 — the spec's example.
    const bill = electric({
      "2026-01-05": { actualAmount: 72 },
      "2026-02-05": { actualAmount: 91 },
      "2026-03-05": { actualAmount: 84 },
    });
    const sched = generateSchedule(bill, [], {
      todayISO: TODAY, windowStart: "2026-01-01", windowEnd: "2026-04-30",
    });
    const byDate = Object.fromEntries(sched.map(o => [o.date, o.amount]));
    expect(byDate["2026-01-05"]).toBe(72);
    expect(byDate["2026-02-05"]).toBe(91);
    expect(byDate["2026-03-05"]).toBe(84);
    // A month with nothing of its own falls back to the definition.
    expect(byDate["2026-04-05"]).toBe(80);
  });

  it("adding August usage leaves July and September untouched", () => {
    const before = chatgpt({
      "2026-07-20": { actualAmount: 20 },
      "2026-08-20": { charges: [{ id: "c1", kind: "credits", amount: 30 }] },
    });
    const sched = generateSchedule(before, [], {
      todayISO: TODAY, windowStart: "2026-07-01", windowEnd: "2026-09-30",
    });
    const byDate = Object.fromEntries(sched.map(o => [o.date, o.amount]));
    expect(byDate["2026-07-20"]).toBe(20);   // history, unmoved
    expect(byDate["2026-08-20"]).toBe(50);   // 20 base + 30 credits
    expect(byDate["2026-09-20"]).toBe(20);   // next period starts fresh at base
  });

  it("assembles the spec's August ChatGPT bill and starts September clean", () => {
    // ChatGPT → August → base $20 + credits $30 + usage $12 = $62.
    let aug: OccurrenceOverride = {};
    aug = addCharge(aug, { amount: 30, kind: "credits" });
    aug = addCharge(aug, { amount: 12, kind: "usage" });
    const sched = generateSchedule(chatgpt({ "2026-08-20": aug }), [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-09-30",
    });
    const august = sched.find(o => o.date === "2026-08-20")!;
    const september = sched.find(o => o.date === "2026-09-20")!;
    expect(august.amount).toBe(62);
    expect(august.baseAmount).toBe(20);
    expect(august.chargeTotal).toBe(42);
    expect(september.amount).toBe(20);
    expect(september.charges).toEqual([]);
  });

  it("marks a paid occurrence as history even before an actual is stamped", () => {
    const bill = electric({ "2026-08-05": { status: "paid", amount: 91 } });
    const sched = generateSchedule(bill, [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-08-31",
    });
    const o = sched[0];
    expect(o.status).toBe("paid");
    expect(o.isEstimate).toBe(false);
    expect(o.amountLabel).toBe("Actual");
  });

  it("carries the estimate flag on unposted variable periods", () => {
    const sched = generateSchedule(electric({ "2026-09-05": { estimatedAmount: 120 } }), [], {
      todayISO: TODAY, windowStart: "2026-09-01", windowEnd: "2026-09-30",
    });
    expect(sched[0].amount).toBe(120);
    expect(sched[0].isEstimate).toBe(true);
    expect(sched[0].estimatedAmount).toBe(120);
    expect(sched[0].actualAmount).toBeNull();
  });
});

describe("period rollups sum real occurrences, never amount x periods", () => {
  it("totals a variable bill from its actual months", () => {
    const sched = generateSchedule(
      electric({
        "2026-01-05": { actualAmount: 72 },
        "2026-02-05": { actualAmount: 91 },
        "2026-03-05": { actualAmount: 84 },
      }),
      [],
      { todayISO: TODAY, windowStart: "2026-01-01", windowEnd: "2026-03-31" },
    );
    const window = totalForWindow(sched, "2026-01-01", "2026-03-31");
    expect(window.total).toBe(247);       // not 80 x 3 = 240
    expect(window.actual).toBe(247);
    expect(window.estimated).toBe(0);

    const months = monthlyTotals(sched);
    expect(months.map(m => m.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months.map(m => m.total)).toEqual([72, 91, 84]);
  });

  it("separates forecast from posted money and excludes skipped periods", () => {
    const sched = generateSchedule(
      electric({
        "2026-08-05": { actualAmount: 100 },
        "2026-09-05": { estimatedAmount: 120 },
        "2026-10-05": { status: "skipped" },
      }),
      [],
      { todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-10-31" },
    );
    const w = totalForWindow(sched, "2026-08-01", "2026-10-31");
    expect(w.actual).toBe(100);
    expect(w.estimated).toBe(120);
    expect(w.total).toBe(220);
    expect(w.count).toBe(2);
  });
});

describe("calendar integration", () => {
  it("shows each month its own amount without changing the series", () => {
    const [series] = seriesFromLiabilityProfiles([
      electric({
        "2026-08-05": { actualAmount: 143.82 },
        "2026-09-05": { estimatedAmount: 120 },
      }),
    ]);
    expect(series.amount).toBe(80);                 // the series is untouched
    expect(series.amountByDate).toEqual({ "2026-08-05": 143.82, "2026-09-05": 120 });
    expect(series.estimatedDates).toEqual(["2026-09-05"]);
    expect(series.billingModel).toBe("variable");

    const occs = generateSeriesOccurrences(series, {
      todayISO: "2026-08-01", lookbackDays: 30, horizonDays: 120,
    });
    const byDate = Object.fromEntries(occs.map(o => [o.date, o]));
    expect(byDate["2026-08-05"].amount).toBe(143.82);
    expect(byDate["2026-08-05"].amountIsEstimate).toBeUndefined();
    expect(byDate["2026-09-05"].amount).toBe(120);
    expect(byDate["2026-09-05"].amountIsEstimate).toBe(true);
    // A month that said nothing of its own still shows the series amount.
    expect(byDate["2026-10-05"].amount).toBe(80);
  });

  it("surfaces paid, skipped and moved months on the calendar", () => {
    const [series] = seriesFromLiabilityProfiles([
      electric({
        "2026-08-05": { status: "paid" },
        "2026-09-05": { status: "skipped" },
        "2026-10-05": { movedTo: "2026-10-12" },
      }),
    ]);
    expect(series.completedDates).toEqual(["2026-08-05"]);
    expect(series.skippedDates).toEqual(["2026-09-05"]);
    expect(series.movedDates).toEqual({ "2026-10-05": "2026-10-12" });
  });

  it("offers per-period money edits only where they are honest", () => {
    const [variableSeries] = seriesFromLiabilityProfiles([electric()]);
    expect(hasPerOccurrenceMoney(variableSeries)).toBe(true);

    const [fixedSeries] = seriesFromLiabilityProfiles([{
      id: "l2", type: "liability", type_key: "streaming", name: "Netflix",
      fields: { monthlyAmount: 15.49, frequency: "monthly", dueDate: "2026-08-14" },
    }]);
    expect(hasPerOccurrenceMoney(fixedSeries)).toBe(false);
    // A disabled action must always say where to do it instead.
    for (const cap of moneyCapabilitiesFor(fixedSeries)) {
      expect(cap.enabled).toBe(false);
      expect(cap.reason).toBeTruthy();
    }
  });
});

describe("findOccurrenceForPeriod — resolving what the user said to one month", () => {
  const occs = [
    { date: "2026-07-20", effectiveDate: "2026-07-20", status: "paid" },
    { date: "2026-08-20", effectiveDate: "2026-08-20", status: "upcoming" },
    { date: "2026-09-20", effectiveDate: "2026-09-20", status: "upcoming" },
  ];

  it("maps the phrases the AI actually receives", () => {
    expect(findOccurrenceForPeriod(occs, "this month", TODAY)?.date).toBe("2026-08-20");
    expect(findOccurrenceForPeriod(occs, undefined, TODAY)?.date).toBe("2026-08-20");
    expect(findOccurrenceForPeriod(occs, "next month", TODAY)?.date).toBe("2026-09-20");
    expect(findOccurrenceForPeriod(occs, "last month", TODAY)?.date).toBe("2026-07-20");
    expect(findOccurrenceForPeriod(occs, "2026-09", TODAY)?.date).toBe("2026-09-20");
    expect(findOccurrenceForPeriod(occs, "2026-08-20", TODAY)?.date).toBe("2026-08-20");
    expect(findOccurrenceForPeriod(occs, "september", TODAY)?.date).toBe("2026-09-20");
  });

  it("returns null rather than guessing at a period that does not exist", () => {
    expect(findOccurrenceForPeriod(occs, "2027-03", TODAY)).toBeNull();
    expect(findOccurrenceForPeriod(occs, "gibberish", TODAY)).toBeNull();
    expect(findOccurrenceForPeriod([], "this month", TODAY)).toBeNull();
  });
});
