// Known limits and open questions the integrity run does not fail on.
//
// Each was observed (a scenario step, a property test or a production probe)
// and is either a deliberate design choice or a small discrepancy that was not
// changed without the owner's say. They are printed in docs/INTEGRITY_REPORT.md
// so a known limit is never mistaken for an unknown one. Remove an entry when
// it is fixed or decided; add one rather than loosening a check.
export interface Known {
  kind: "discrepancy" | "sync" | "gap" | "question";
  title: string;
  detail: string;
  /** Where it was seen. */
  evidence: string;
}

export const KNOWN: Known[] = [
  {
    kind: "sync",
    title: "OPEN, NOT FIXED — a task ticked done on Tasks sometimes stays open on the dashboard",
    detail: "The row is stored as done, but the dashboard opened right after by in-app navigation keeps the task under Tasks \"Remaining\", Timeline and Next Important for more than ten seconds (until the page is left or reloaded). Intermittent: 1 of 3 repeat runs on production and 1 run on the preview, desktop each time. A local write invalidates with refetchType \"active\" (client/src/lib/cache-bus.ts), so the cause is not the sibling-tab rule; it has not been established. Breaks \"Done means gone\" (Rule 8). The scenario keeps failing when it happens.",
    evidence: "browser.task-form (screenshot test-results/integrity/screenshots/browser.task-form-desktop.png); rerun: npx tsx tests/integrity/run.ts --only browser.task-form",
  },
  {
    kind: "sync",
    title: "A record written on another device is not shown by in-app navigation for up to 3 minutes",
    detail: "Lists are trusted for 3 minutes inside one sitting (staleTime) and only the five aggregate payloads refetch on a real resume (15 s away). Nothing tells an open tab that another DEVICE, or the Auto Pay cron, wrote. A reload shows it at once. Deliberate (it ended the 2026-07 refetch storm); the cost is a short window in which two devices disagree.",
    evidence: "browser.written-elsewhere (records whether navigation alone showed the task); client/src/lib/queryClient.ts",
  },
  {
    kind: "discrepancy",
    title: "A loan that takes more than 50 years to repay is shown as paid off in 600 months",
    detail: "buildAmortization stops at 600 rows. A loan still owing after that (0% with a very small payment) reports payoffMonths 600 and a payoff date, with a balance left on its last row, instead of saying no payoff is in view.",
    evidence: "tests/integrity-oracle-properties.test.ts (beyond-horizon cases are left out of the comparison); shared/liability-calc.ts SAFETY_MAX_PERIODS",
  },
  {
    kind: "question",
    title: "A bill's recorded payments stay in spending after the bill is deleted",
    detail: "Deleting a paid bill or loan deletes its payment rows but keeps the expense each payment logged (linked to the payer, tagged liability:<id> / payment:<id> for rows that no longer exist). Money that was spent stays spent, which is defensible — but the expense can no longer be traced to, or reversed from, the bill.",
    evidence: "integrity run cleanup (expenses named \"<bill> — <date>\" outlive the bill); money.bill-cycle",
  },
  {
    kind: "gap",
    title: "An emptied version history leaves an empty preferences row",
    detail: "Deleting a note, journal entry or document empties its versions (the text is gone) but the row versions:<kind>:<id> stays with the value \"[]\". No text is kept; one small row per deleted record is.",
    evidence: "records.journal-notes; server/content-versions.ts forgetVersions",
  },
  {
    kind: "question",
    title: "The same loan payment sent twice within a minute is folded into one",
    detail: "POST /api/liabilities/:id/payments answers the second identical request (same amount, same day, seconds apart) with the first payment: a double-submit guard. Two genuinely separate equal payments made within that window would be recorded as one; a different amount, or a later moment, is its own payment.",
    evidence: "money.loan-payments (\"the identical request sent again adds no second payment\")",
  },
  {
    kind: "gap",
    title: "An income date given as a timestamp is accepted for its day, even when the time is not a real time",
    detail: "POST /api/incomes with date \"2026-11-27T25:99:00Z\" is stored as 2026-11-27. The day is valid and is what is kept; the junk after it is ignored rather than refused.",
    evidence: "first integrity run on production, 2026-11-27 (hardening.refused-input-writes-nothing)",
  },
  {
    kind: "gap",
    title: "The preview and production share one database",
    detail: "A branch preview reads and writes the same Supabase project as production, so a live run against a preview still writes as the smoke account in the production database (under the same gate lock). There is no separate test database; isolation is by account, enforced by row-level security (verified by hardening.account-isolation).",
    evidence: "tests/smoke/fixture/account.ts; hardening.account-isolation",
  },
];
