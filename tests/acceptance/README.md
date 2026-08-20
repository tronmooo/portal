# Browser acceptance rig

Answers one question the unit tests cannot: **after a chat write, is the row on
screen the moment you navigate — with no refresh, no waiting, and no stale
flash?**

## Running it

```bash
npx vite build          # the rig serves the real client bundle
npx tsx tests/acceptance/run.ts
```

Not part of `npm test`: it drives a real browser and takes several minutes.

## What is real, and what is not

Real: the built client, React Query and its caches, the cache bus, the Express
app from `server/routes.ts` with every middleware, the version-stamped response
cache, the AI tool loop, the post-write envelope, and the change manifest.

Doubled: the database (`backend.ts`, in-memory over `MemStorage`) and the model
(`mock-anthropic.ts`, scripted). Neither is where the staleness bug lived.

The chat message carries the script inline, so a test names the exact tool it
wants executed while everything downstream stays production code:

```
##create_task {"title":"Buy milk"}
##create_task {...} ##create_expense {...}      # one turn, two tool calls
```

## Two rigs, two questions

**`run.ts` / `run-ui.ts` — what is on screen, and when.** Instances run
in-process (`startRig({ instances: 2 })`). They round-robin `/api`, but they
share every module-level thing `server/routes.ts` owns — the response cache, the
data-version memo, the rate limiter — so they cannot genuinely disagree. These
runs therefore say nothing about cross-instance staleness; they measure the
client: optimistic patches, invalidation, profile scoping, cross-tab, reload.

**`cross-instance.ts` — can one instance serve data another just changed?**
This one uses `startRig({ separateProcesses: true })`: each instance is a real
child process with its own caches, talking to a database the parent owns over a
small RPC (`storage-rpc.ts`). That is the only way to reproduce the production
failure, and it does: against the pre-fix commit the other instance returns a
deleted row, misses an added row, and misses an edit. Requests are pinned to a
chosen instance so the sequence is deterministic rather than a race.

The AI chat path does not currently run under the separate-process rig — the
child cannot drive the ai-engine import — so `cross-instance.ts` exercises REST
writes only. That is where the gap was.

## Why every case needs a control row

`navigateAndRecord` samples every animation frame after navigation. Without a
control, "the list rendered but is missing the new row" (the bug) and "the list
has not rendered yet" (an ordinary loading state) are both just "needle absent".
The control is a row of the same type created earlier in the run:

- control present, needle absent → **STALE** — the user is looking at old data
- control absent, needle absent → the list has not painted yet

Verdicts are three-way on purpose. `INCONCLUSIVE` means the surface does not
render that entity by name at all, so the run cannot judge it either way — it is
never silently counted as a pass.

## Known measurement limits

- `/api/tasks` pages at 100 rows by default, so the repeated-cycles suite runs
  first, before the rest of the run crosses that cap.
- `/api/chat` is rate limited to 20 turns/minute; `driver.chat()` detects the
  throttle and waits the window out rather than measuring writes that never
  happened.
- Income, trackers and calendar events have no surface that renders them by
  name in this build, so they report INCONCLUSIVE.
- Upload and confirm-extraction carry the version barrier but no precise
  manifest, so their data appears without a refresh but not on the first frame.
