// The twelve live checks that were red on production on 2026-11-27, each
// investigated on its own. Printed in docs/INTEGRITY_REPORT.md.
//
// verdict:
//   defect     a product bug — fixed on the branch and guarded by a test
//   outdated   the assertion contradicted a LATER owner rule or a redesign;
//              brought in line with that rule (the check says so in place)
//   flaky      did not reproduce; passes when rerun alone
//   runner     caused by scripts/run-live-checks.ts itself
//   open       a real behaviour, not changed: needs a product decision
export interface Triage {
  check: string;
  verdict: Array<"defect" | "outdated" | "flaky" | "runner" | "open">;
  found: string;
  action: string;
}

export const TRIAGE_2026_11_27: Triage[] = [
  {
    check: "live-assets-liabilities-ui-check",
    verdict: ["defect"],
    found: "#20: a payment recorded from another client left a reopened loan's header on the old balance until a reload. Deterministic. Nothing told an open tab that anyone else had written; it trusted its copy for three minutes.",
    action: "Fixed: every read carries the account's version map and the app re-reads the domains another device moved, on navigation, on return to the tab and twice a minute (client/src/lib/server-versions.ts). Guard: tests/server-versions.test.ts; live: browser.written-elsewhere.",
  },
  {
    check: "live-task-date-and-calendar-check",
    verdict: ["outdated"],
    found: "\"Calendar: the open task offers Mark as done\" — the grid now opens the redesigned detail sheet, whose action is the \"Mark complete\" button; the check looked for the old dialog's checkbox. Deterministic since the redesign.",
    action: "The check drives the sheet's own control and, because the sheet closes on completing, reopens the item to require it reads Completed and no longer offers completion. Its day-panel count and timeline assertions are unchanged.",
  },
  {
    check: "live-autopay-scenarios-check",
    verdict: ["outdated"],
    found: "Expected an \"Overdue bill\" alert for a monthly bill whose date passed yesterday. Rule A7 (owner, 2026-11-22, the day after the check was written) says a recurring bill's elapsed date is assumed paid and nothing reads overdue.",
    action: "The assertion now requires NO overdue alert for it; the check's missed-payment assertions (the exception that does show) are unchanged.",
  },
  {
    check: "live-asset-overview-check",
    verdict: ["outdated"],
    found: "\"The Value card shows no confidence figure\" searched the whole card. \"Remove confidence\" (2026-11-23) was about the value estimate; the lifecycle section (11-24) and the optimal disposal point (11-26) were later asked to state their own, inside the same card.",
    action: "Narrowed to what was asked: the value estimate's own block carries no confidence figure.",
  },
  {
    check: "live-chat-variations-check",
    verdict: ["defect", "open", "flaky"],
    found: "Not a timeout: it takes about 25 minutes (165 chat turns) and my runner stopped it at 7–9. Run to the end on production: 123 of 139 phrasings pass, 16 fail. (a) \"remember that my library card number is 20418\" was stored over an older memory — the key was the first three words. (b) A reply in Spanish claimed \"guardado\" for an expense the duplicate question had blocked — the unbacked-claim guard knew only English. (c) Seven failures are the duplicate guard asking before a second same-priced purchase that day (Rule 35, deliberate). (d) Three expect \"Friday\" said on a Friday to mean next week. (e) The rest are the model's reading of a correction (\"oops, it was $45\" made a second expense; \"push it back a week\" made a second event; a repeated \"I meditated today\" logged twice).",
    action: "(a) fixed: a memory is keyed by its subject (shared/memory-key.ts, tests/memory-key.test.ts). (b) fixed: write claims are recognised in Spanish, Portuguese, French, German and Italian (tests/claim-check-languages.test.ts). (c) open question for the owner (known.ts). (d) the expectation is ambiguous on Fridays — not changed. (e) open: real chat behaviour, not fixed in this pass.",
  },
  {
    check: "live-content-workflows-check",
    verdict: ["runner"],
    found: "\"Stopped after 7 minutes\" both times. It ran directly after chat-variations was killed, and waited on the smoke account's gate lock the killed check still held.",
    action: "Passes alone on production (51 checks, under 4 minutes). The runner now frees the lock after stopping a check.",
  },
  {
    check: "live-exec-dashboards-check",
    verdict: ["flaky"],
    found: "Once \"Tagged Spend shows both purchases and their total\", once \"could not create an expense\" — two different failures in two runs.",
    action: "Passes alone on production (65 checks). The second failure is consistent with the duplicate guard meeting another check's leftover expense of the same amount that day; not established.",
  },
  {
    check: "live-dated-owner-check",
    verdict: ["flaky"],
    found: "A browser timeout, twice.",
    action: "Passes alone on production. Both failures followed a killed check holding the gate lock; likely the same runner cause, not established.",
  },
  {
    check: "live-entry-edit-and-series-edit-check",
    verdict: ["flaky"],
    found: "Its setup asks the chat to log a run to a new tracker, and twice the chat did not do it the way the check expects.",
    action: "Passes alone on production (17 checks). The step under test (an edit re-derives pace) is deterministic; its setup depends on a model call. Not changed.",
  },
  {
    check: "live-artifacts-check",
    verdict: ["flaky"],
    found: "A 30-second browser timeout scrolling to an element.",
    action: "Passes on the preview (187 s). Slow rather than broken; not changed.",
  },
  {
    check: "live-journal-check",
    verdict: ["flaky"],
    found: "\"A name with no profile creates none and says so\": the reply did say so; the count of new entries was off by one in that run.",
    action: "Passes on the preview. Not reproduced.",
  },
  {
    check: "live-wellness-dashboard-check",
    verdict: ["flaky", "open"],
    found: "Its AI Builder assertions depend on what the model chooses: once it built the sleep card over a tracker named Sleep rather than the sleep measurement, once it chose \"latest\" where the check expects \"total\". Looking at the account for it turned up a separate discrepancy: /api/stats counts 9 trackers where /api/trackers lists 1.",
    action: "Not changed (the choices are within what H8 allows the model). The tracker-count discrepancy is recorded in known.ts.",
  },
];
