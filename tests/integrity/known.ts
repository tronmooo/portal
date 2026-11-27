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
    title: "Another device's reads can be up to about two seconds behind a write",
    detail: "The server's response cache is keyed by a data version each instance memoizes for ~2 s. The device that made the write carries the new version in its next requests and always reads fresh (0 stale of 384 reads, production, 2026-11-27). A different device, which has no such token, can be answered from the pre-write cache for up to ~2 s (17 of 64 dashboard-bootstrap reads immediately after a write).",
    evidence: "production probe, 2026-11-27 (server/routes.ts VERSION_MEMO_MS)",
  },
  {
    kind: "sync",
    title: "A record written on another device is not shown by in-app navigation for up to 3 minutes",
    detail: "Lists are trusted for 3 minutes inside one sitting (staleTime) and only the five aggregate payloads refetch on a real resume (15 s away). Nothing tells an open tab that another DEVICE, or the Auto Pay cron, wrote. A reload shows it at once. Deliberate (it ended the 2026-07 refetch storm); the cost is a short window in which two devices disagree.",
    evidence: "browser.written-elsewhere (records whether navigation alone showed the task); client/src/lib/queryClient.ts",
  },
  {
    kind: "gap",
    title: "An emptied version history leaves an empty preferences row",
    detail: "Deleting a note, journal entry or document empties its versions (the text is gone) but the row versions:<kind>:<id> stays with the value \"[]\". No text is kept; one small row per deleted record is.",
    evidence: "records.journal-notes; server/content-versions.ts forgetVersions",
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
