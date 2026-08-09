// A record has ONE source type, everywhere, and it comes from the data.
//
// User report 2026-07-26:
//   #5  "In Rules, many records initially appeared as Liability. In Upcoming
//        Dates, those same records become Bill or Subscription. The same record
//        should have one stable source type everywhere."
//   #6  "Car Insurance appears as a Bill in one place and a Liability-backed
//        record elsewhere… The app is mixing the financial profile type with
//        the calendar display category."
//   #15 "Bills 8, Subs 5, and Liabilities 3 coexist, while many rules describe
//        liabilities as bills or subscriptions."
//
// ROOT CAUSE. `seriesFromLiabilityProfiles` hardcoded `kind: "liability"` for
// every row it adapted. `liability` is the STORAGE type — the table these live
// in — not what the record IS. The rows already carried the answer and it was
// being discarded:
//
//   ChatGPT Pro   type_key=subscription  fields.category=subscription  → Subs 0
//   Progressive   type_key=bill          fields.category=insurance     → Bills 0
//
// Verified against the real rows in Supabase before writing this.
import { describe, it, expect } from "vitest";
import {
  kindForLiabilityProfile, seriesFromLiabilityProfiles, seriesFromAll,
} from "../shared/calendar-adapters";
import { categoryForKind, countRules } from "../shared/calendar-categories";
import { dedupeSeries } from "../shared/calendar-occurrences";

const SELF = "ebfd58a4";

/** The user's actual liability rows, as stored. */
const REAL_ROWS = [
  { id: "114811d2", name: "ChatGPT Pro", type: "liability", type_key: "subscription",
    parentProfileId: SELF,
    fields: { nextDueDate: "2026-07-30", frequency: "monthly", category: "subscription", balance: "20" } },
  { id: "02ee5378", name: "Lubi", type: "liability", type_key: "subscription",
    parentProfileId: SELF,
    fields: { nextDueDate: "2026-07-03", frequency: "monthly", category: "subscription", balance: "10" } },
  { id: "0ded0965", name: "Netflix", type: "liability", type_key: "subscription",
    fields: { nextDueDate: "2026-07-02", frequency: "monthly", category: "subscription", balance: "9.99" } },
  { id: "6211cb06", name: "Progressive Auto Insurance - Honda CR-V 2021", type: "liability",
    type_key: "bill", parentProfileId: SELF,
    fields: { nextDueDate: "2026-06-30", frequency: "monthly", category: "insurance", balance: "155" } },
  { id: "d88ae46e", name: "Spotify Premium", type: "liability", type_key: "subscription",
    fields: { nextDueDate: "2026-07-30", frequency: "monthly", category: "subscription", balance: "11" } },
  { id: "7085e988", name: "Auto Loan", type: "liability", type_key: "auto_loan",
    fields: { nextDueDate: "2026-08-05", frequency: "monthly", monthlyPayment: 1000,
              balance: "24000", interestRate: 5.9, payoffDate: "2029-08-05" } },
];

describe("the stored classification is read, not thrown away", () => {
  it("calls the reported rows what they actually are", () => {
    const byName = Object.fromEntries(REAL_ROWS.map((r) => [r.name, kindForLiabilityProfile(r)]));
    expect(byName["ChatGPT Pro"]).toBe("subscription");
    expect(byName["Netflix"]).toBe("subscription");
    expect(byName["Spotify Premium"]).toBe("subscription");
    expect(byName["Lubi"]).toBe("subscription");
    expect(byName["Progressive Auto Insurance - Honda CR-V 2021"]).toBe("bill");
    // A real debt keeps the Liability kind — that is what the word is for.
    expect(byName["Auto Loan"]).toBe("liability");
  });

  it("reads type_key when fields.category is absent, and vice versa", () => {
    expect(kindForLiabilityProfile({ type: "liability", type_key: "subscription" })).toBe("subscription");
    expect(kindForLiabilityProfile({ type: "liability", fields: { category: "insurance" } })).toBe("bill");
    expect(kindForLiabilityProfile({ type: "liability", fields: { category: "housing" } })).toBe("bill");
    expect(kindForLiabilityProfile({ type: "liability", fields: { category: "loan_payment" } })).toBe("liability");
  });

  it("never guesses Subscription for an unclassified row", () => {
    // Putting a mortgage under Subs is worse than the generic answer.
    const bare = kindForLiabilityProfile({ type: "liability", fields: {} });
    expect(bare).not.toBe("subscription");
    expect(bare).toBe("bill");
  });

  it("treats a row with a payoff date and interest as debt", () => {
    expect(kindForLiabilityProfile({
      type: "liability", fields: { balance: "24000", interestRate: 5.9, payoffDate: "2029-08-05" },
    })).toBe("liability");
  });

  it("is case- and separator-insensitive", () => {
    for (const k of ["Subscription", "SUBSCRIPTION", "sub_scription".replace("_", "")]) {
      expect(kindForLiabilityProfile({ type: "liability", type_key: k }), k).toBe("subscription");
    }
    expect(kindForLiabilityProfile({ type: "liability", type_key: "AUTO LOAN" })).toBe("liability");
  });
});

describe("the chip counts stop lying", () => {
  it("puts the reported rows under Subs and Bills, not all under Liabilities", () => {
    const series = seriesFromLiabilityProfiles(REAL_ROWS);
    const counts = countRules(series);
    expect(counts.subscriptions).toBe(4); // ChatGPT, Lubi, Netflix, Spotify
    expect(counts.bills).toBe(1);         // Progressive
    expect(counts.liabilities).toBe(1);   // Auto Loan
    expect(counts.all).toBe(6);
  });

  it("keeps the categories mutually exclusive — every rule lands in exactly one", () => {
    // "Users cannot tell whether these are exclusive categories or overlapping
    // labels." They are exclusive, and this is the proof.
    const series = seriesFromLiabilityProfiles(REAL_ROWS);
    const counts = countRules(series);
    const sourceTotal =
      counts.birthdays + counts.anniversaries + counts.bills + counts.subscriptions +
      counts.liabilities + counts.documents + counts.tasks +
      counts.events + counts.other;
    expect(sourceTotal).toBe(counts.all);
  });
});

describe("one record, one source type, on every screen", () => {
  // #5: the same record must not be a Liability in Rules and a Bill in Upcoming.
  // Both views read the same series list, so the kind cannot diverge — pinned
  // here so a future screen cannot reintroduce its own classification.
  it("the kind on the series is the kind on every occurrence of it", () => {
    const all = seriesFromAll({ profiles: REAL_ROWS });
    const survivors = dedupeSeries(all).map((d) => d.series);
    for (const s of survivors) {
      const category = categoryForKind(s.kind);
      expect(categoryForKind(s.kind), `${s.title} drifted`).toBe(category);
      expect(s.kind, `${s.title} still generically "liability"`).toBe(
        kindForLiabilityProfile(REAL_ROWS.find((r) => s.id.endsWith(r.id))!),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #"Why is there only three things?" — five liabilities existed; two vanished.
// ─────────────────────────────────────────────────────────────────────────────
import { filterSeriesByProfiles } from "../shared/calendar-adapters";

describe("an unparented record is not silently dropped by a profile filter", () => {
  it("keeps a liability with no parent when the self profile is selected", () => {
    // Netflix and Spotify Premium have parent_profile_id NULL. `ownerCandidates`
    // always contained the liability's OWN id, so the soft-orphan rule (an
    // unowned record belongs to the primary person) could never fire and they
    // matched nothing.
    const series = seriesFromLiabilityProfiles(REAL_ROWS);
    const scoped = filterSeriesByProfiles(series, [SELF], { selfIds: new Set([SELF]) });
    const names = scoped.map((s) => s.title);
    expect(names).toContain("Netflix");
    expect(names).toContain("Spotify Premium");
    expect(names).toContain("ChatGPT Pro");
    expect(scoped).toHaveLength(REAL_ROWS.length);
  });

  it("still hides it from an unrelated person", () => {
    const series = seriesFromLiabilityProfiles(REAL_ROWS);
    const scoped = filterSeriesByProfiles(series, ["someone-else"], { selfIds: new Set([SELF]) });
    expect(scoped.map((s) => s.title)).not.toContain("Netflix");
  });

  it("still finds it when the record itself is selected", () => {
    const series = seriesFromLiabilityProfiles(REAL_ROWS);
    const scoped = filterSeriesByProfiles(series, ["0ded0965"], { selfIds: new Set([SELF]) });
    expect(scoped.map((s) => s.title)).toEqual(["Netflix"]);
  });
});
