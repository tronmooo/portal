// shared/hidden-task-tags.ts
//
// System-encoded task tags — machine state that rides in `tags` but must be
// FILTERED OUT of every user-facing tag list. QA run 002 (B9): task rows on
// the Tasks page printed `recur:yearly`, `ranchor:1`, `migrated:reminder` and
// `runtil:2027-08-03` as visible chips, because the page rendered tags raw and
// the one existing filter was a component-local regex that had drifted out of
// sync with the tags the recurrence engine actually writes.
//
// Mirrors the shape of shared/hidden-tracker-categories.ts: ONE definition,
// imported by every render site, with a regression test keeping it in lockstep
// with the writers.
//
// Writers to keep in sync with:
//   - shared/recurrence.ts (RECUR_TAG_RE): recur: runtil: rcount: rdone:
//     ranchor: rpaused
//   - server/ai-engine.ts task creation: runtil:, ranchor:
//   - migrations/20260809_reminders_to_timed_tasks.sql: migrated:reminder
//   - task metadata prefixes used across the client: prio: cat: time: remind:
//     est: st: (subtasks), and the bare markers reminder / allday

export const SYSTEM_TASK_TAG_RE =
  /^(recur:|runtil:|rcount:|rdone:|ranchor:|rpaused$|migrated:|prio:|cat:|time:|remind:|est:|st:|reminder$|allday$)/;

/** The tags a person actually typed — everything system-encoded removed. */
export function visibleTaskTags(tags: readonly string[] | undefined | null): string[] {
  return (tags || []).filter((t) => !SYSTEM_TASK_TAG_RE.test(t));
}
