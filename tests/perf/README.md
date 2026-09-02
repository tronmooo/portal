# Performance / CRUD stress harness

Drives the **built** client and the **real** Express app against an in-memory
storage double, with Playwright recording every `/api` call, long tasks, paint
marks, CPU profiles and the live React Query cache. This is what produced
`audit/perf-ledger-2026-09-02.md`. None of it needs Supabase or an Anthropic
key; AI routes answer 500 locally and are exercised live instead
(`live-chat.ts`).

These files are deliberately outside `tsconfig.json`'s include set and
`vitest.config.ts`'s include list: they are tools, not tests.

```bash
npx vite build --sourcemap                       # production bundle (+ maps for the profiler)
SERVE_DIST=1 LATENCY_MS=120 PORT=5000 npx tsx tests/perf/local-dev.ts   # app on :5000, 120ms simulated round trip
SCALE=3 npx tsx tests/perf/seed.ts               # 3× fixture: 900 expenses, 120 tasks, 10 trackers …
npx tsx tests/perf/p02-sweep.ts                  # every route: requests, duplicates, long tasks, paint
npx tsx tests/perf/p04-tasks-crud.ts             # create/edit/complete/delete + dashboard sync + double submit
npx tsx tests/perf/p06-tracker-habit-expense.ts  # tracker log/rapid/edit/delete, habit check-in, expense add
npx tsx tests/perf/p08-scope-pollution.ts        # Bob's scoped cache must stay Bob's after a write
npx tsx tests/perf/p05-cpuprofile.ts /finance    # sourcemapped CPU profile of a navigation
npx tsx tests/perf/p09-invalidation-trace.ts task # every invalidateQueries call after a write, with stacks
npx tsx tests/perf/p03-cachedump.ts /dashboard /trackers  # query keys, observers, update counts per screen
```

Conventions the harness relies on: requests carry `x-local-user` (one
in-memory store per user; default `u1`); `x-seed: 1` rotates the write
rate-limit key so a seed can exceed 60 writes/min; the built page exposes the
query client on `window.__portolQueryClient` when
`localStorage.portol_debug_qc === "1"` (set by `pw.ts`).

Playwright uses `PW_EXE` or `/opt/pw-browsers/chromium`. Screenshots, request
logs and CPU profiles land in `tests/perf/out/` (git-ignored).
