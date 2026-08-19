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

## Why two server instances

`rig.ts` boots N Express instances over one shared backend and round-robins
`/api` across them. Each instance memoizes the per-user data version for ~2s, so
a GET landing on a different instance than the write could compute the pre-write
cache key. One process cannot reproduce that; Vercel sprays one page load's
requests across instances exactly this way.

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
