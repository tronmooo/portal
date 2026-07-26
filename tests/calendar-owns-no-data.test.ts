// The calendar renders occurrences. It never creates records.
//
// User report 2026-07-26, Problem #6:
//   "The calendar should never own data.
//      Liability → Recurring Rule → Occurrence Generator → Calendar
//    NOT
//      Calendar → creates another record → creates another profile → duplicate.
//    The calendar is a view, not the source of truth."
//
// And Problem #1:
//   "You currently have 💳 Progressive Auto Insurance (Bill) and 🔄 Progressive
//    Auto Insurance Renewal (Recurring Event). Those are actually the same
//    liability… It should never create another profile called 'Renewal.'"
//
// WHAT WAS ACTUALLY IN THE DATABASE (confirmed 2026-07-26 before the fix):
//
//   profiles  6211cb06  Progressive Auto Insurance   type=liability type_key=bill
//   profiles  8883f623  Progressive Auto Insurance   type=subscription  ← shadow
//   events    85e6ba72  🔄 Progressive … — Renewal   monthly, tags:[auto-generated]
//
// `autoGenerateProfileEvents` wrote an event row for each profile's OWN
// recurring schedule — a schedule the occurrence engine already derives from
// the profile. So every recurring payment existed twice, and the generated twin
// drifted into a different category ("Renewal" → Events) from the record it was
// copied from ("bill" → Bills).
//
// The rule this file enforces: generate an event ONLY for a date the occurrence
// engine cannot derive. Anything the engine already produces is forbidden.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { seriesFromAll } from "../shared/calendar-adapters";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "server/supabase-storage.ts"), "utf8",
);

/** The `eventDefs.push(...)` field keys inside autoGenerateProfileEvents. */
function generatedFieldKeys(): string[] {
  const start = SRC.indexOf("private async autoGenerateProfileEvents");
  expect(start, "autoGenerateProfileEvents not found").toBeGreaterThan(-1);
  const body = SRC.slice(start, SRC.indexOf("\n  async updateProfile", start));
  return [...body.matchAll(/eventDefs\.push\(\{\s*fieldKey:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("the profile-event generator writes nothing the engine derives", () => {
  const DERIVED = [
    // A liability / subscription's recurring payment schedule. The engine reads
    // nextDueDate + frequency off the profile and generates every occurrence.
    "nextPayment",
    // A subscription's renewal cycle — same schedule, different word. This is
    // the exact key that produced "🔄 Progressive … — Renewal".
    "renewalDate",
    // `seriesFromProfiles` already yields a yearly series from fields.birthday.
    "birthday",
  ];

  it.each(DERIVED)("never generates an event from `%s`", (key) => {
    expect(
      generatedFieldKeys(),
      `autoGenerateProfileEvents still writes an event row for "${key}" — the ` +
      `occurrence engine already generates that date, so every one will appear twice`,
    ).not.toContain(key);
  });

  it("still generates the one-off dates nothing else derives", () => {
    // Not a blanket ban — a warranty expiry is a real date with no rule behind
    // it, so it does need a row.
    const keys = generatedFieldKeys();
    expect(keys).toContain("warrantyExpiry");
    expect(keys).toContain("leaseEnd");
    expect(keys.length).toBeGreaterThan(3);
  });

  it("keeps a written record of why, so this is not silently reverted", () => {
    const start = SRC.indexOf("private async autoGenerateProfileEvents");
    const body = SRC.slice(start, start + 3000);
    expect(body).toMatch(/never own data|cannot derive|already derives/i);
  });
});

describe("a liability produces exactly one series, not two", () => {
  it("does not yield both a bill and a renewal for one Progressive record", () => {
    // The real rows, minus the shadow profile and mirror event that are now
    // deleted and can no longer be created.
    const series = seriesFromAll({
      profiles: [{
        id: "6211cb06", name: "Progressive Auto Insurance - Honda CR-V 2021",
        type: "liability", type_key: "bill",
        fields: { nextDueDate: "2026-07-30", frequency: "monthly", category: "insurance", balance: "155" },
      }],
      events: [],
    });
    expect(series).toHaveLength(1);
    expect(series[0].kind).toBe("bill");
    expect(series[0].source.system).toBe("liability");
    expect(series[0].source.id).toBe("6211cb06");
  });

  it("routes that one series back to the liability profile", () => {
    // "Every road should eventually lead back to the same profile."
    const [s] = seriesFromAll({
      profiles: [{
        id: "6211cb06", name: "Progressive", type: "liability", type_key: "bill",
        fields: { nextDueDate: "2026-07-30", frequency: "monthly" },
      }],
    });
    expect(s.source.href).toContain("6211cb06");
    expect(s.source.profileId).toBe("6211cb06");
  });
});
