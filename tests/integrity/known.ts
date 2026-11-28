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
    kind: "gap",
    title: "ENVIRONMENT — the smoke account's mailbox does not accept mail, so a password-reset email cannot be sent to it on production",
    detail: "Supabase answers email_address_invalid for the smoke account's address (the provider marked it as bouncing). The reset link itself was verified end to end on the auth-release preview against the production auth service with a deliverable address, and on the isolated stack through its mail catcher (accounts.password-change-and-reset). A production gate that needs a delivered email needs a deliverable test mailbox.",
    evidence: "production auth logs, 2026-11-27 (auth release verification); tests/password-reset-link-session.test.ts",
  },
  {
    kind: "gap",
    title: "There is no way to delete the account itself",
    detail: "Settings → \"Delete all data\" (DELETE /api/data/all) removes every record and leaves the sign-in in place: no route or screen removes the auth user. A person who asks for their account to be deleted keeps an empty one. Building it is a product decision (it must also end sessions and remove stored files, which the wipe already sweeps).",
    evidence: "accounts.delete-all-data on the isolated stack, 2026-11-27; server/auth.ts and server/routes.ts have no user-deletion route",
  },
  {
    kind: "question",
    title: "OPEN — chat: two purchases of the same NAME in one message are created once",
    detail: "The tool gate's \"one request creates ONE record\" rule (findDuplicateCreateInTurn) refuses a second create of the same name for the same owner within one chat turn; it exists to stop the model filing one thing twice under two types. It is not a comparison with stored transactions, so rule I14 does not remove it — but \"two coffees, $5 each\" said in one message can come out as one $5 expense. Identical purchases said in SEPARATE messages are two expenses, as ruled. Left as is: relaxing it for expenses risks the model's own double call.",
    evidence: "shared/ai-tool-routing.ts findDuplicateCreateInTurn; not observed failing in the chat check",
  },
  {
    kind: "discrepancy",
    title: "Chat sometimes asks before a delete the person asked for directly",
    detail: "The chat's instructions say a direct \"delete X\" counts as confirmation. About one delete in six still came back as \"…Shall I go ahead?\" (a tracker entry, a budget). Nothing is lost and a \"yes\" completes it; the chat scenarios answer once and hold the result to the same database check.",
    evidence: "chat.habits-goals-trackers and chat.money-records, preview 143d076, 2026-11-27 (replies recorded in test-results)",
  },
  {
    kind: "question",
    title: "OPEN — chat: a budget for a category outside the fixed list is filed somewhere different each time",
    detail: "\"Set a budget of $90 for gifts\" was saved under Shopping; \"raise my gifts budget to $120\" then made a General budget of $120; \"delete my gifts budget\" deleted General. The budget tools tell the model the category MUST be one of the screens' categories (EXPENSE_CATEGORIES — since 2026-11-28 the same list the Budget popup offers, so \"travel\" is kept as travel; it used to be filed as transport), so for anything OFF that list it picks one, and not the same one twice — and a delete then acts on the guess, which could remove a real General budget. The API itself keeps an unknown name as its own budget. Not changed: whether an unlisted category should be refused, asked about, mapped by a fixed table or allowed as its own budget is a product decision.",
    evidence: "chat.money-records, preview a4f09e3, 2026-11-27 (replies recorded in test-results); server/ai-engine.ts set_budget / delete_budget",
  },
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
