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
    kind: "discrepancy",
    title: "The dashboard's tracker count includes trackers the tracker list does not show",
    detail: "GET /api/stats counted 9 trackers for the smoke account while GET /api/trackers listed 1: eight live finance-shaped trackers (\"Regression Probe finance …\", from May) are counted but not listed. Two answers to \"how many trackers\" (Rule 1). Not changed: which of the two is intended is the owner's call.",
    evidence: "production, 2026-11-27 (database rows vs /api/trackers vs /api/stats.totalTrackers)",
  },
  {
    kind: "sync",
    title: "Another device learns of a write on its next navigation, its return to the tab, or within 30 seconds — not instantly",
    detail: "There is no push channel. Every read carries the account's version map and the app asks for it on each in-app navigation, on return to the tab and twice a minute (lib/server-versions.ts); a domain another device moved is then read again. A screen that is simply left open can therefore show the old value for up to ~30 s.",
    evidence: "browser.written-elsewhere (measures both); client/src/App.tsx VersionWatch",
  },
  {
    kind: "sync",
    title: "Another device's reads can be up to about two seconds behind a write",
    detail: "The server's response cache is keyed by a data version each instance memoizes for ~2 s. The device that made the write carries the new version in its next requests and always reads fresh (0 stale of 384 reads, production, 2026-11-27). A different device, which has no such token, can be answered from the pre-write cache for up to ~2 s (17 of 64 dashboard-bootstrap reads immediately after a write).",
    evidence: "production probe, 2026-11-27 (server/routes.ts VERSION_MEMO_MS)",
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
