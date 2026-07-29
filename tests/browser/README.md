# Browser checks

```bash
npm run build        # the harness serves dist/public — it checks the real bundle
npm run test:browser
```

Screenshots land in `dist/browser-check/`.

## Why this exists

The unit suite can prove a pure function is right and that a component renders
what it was handed. It cannot prove the assembled app behaves — and on the
2026-07-29 audit fixes, three bugs lived exactly in that gap:

- **Two writers, one browser title.** `App.tsx`'s route map and `trackers.tsx`
  both set `document.title`. A static test asserting the map contained
  `"/assets": "Assets — Portol"` passed while the running app still showed
  "Trackers", because the page mounted second and overwrote it. This is the
  same bug the audit reported as "the Liabilities page's tab title read
  Trackers".
- **A fourth net-worth surface.** The hub KPI strip subtracted the finance
  snapshot's raw totals, so it counted synthetic QA rows the rest of the app
  filters out. A screenshot caught it reading `-80,586` directly above a
  Finance card reading `-80,771` — the $185 gap being one "Test Laptop QA".
- **A section that never opened.** `useState(defaultOpen)` reads its argument
  once, and every section mounts before its data arrives, so the Overdue
  section stayed collapsed while its own badge read 4.

None of those are visible without a real browser, a real bundle, and real
mount ordering.

## How it works

A static server hosts `dist/public`; Playwright intercepts every `/api/*` call
and answers from fixtures that reproduce the numbers the audit reported on
production — the 50%-owned house, ten liabilities whose last two sum to the
$223 gap, four overdue bills, a `Test Laptop QA` row, and the weight goal that
claimed "Target reached" 21 lbs from target.

It is deliberately **not** pointed at production. The audit recorded a real
$90.50 payment by misclicking during what was meant to be a read-only pass,
and the P1 check here clicks that same button on purpose.

## Adding a check

`check(id, name, pass, detail)` — `id` is the audit finding (`D1a`, `P3-alias`).
Always pass `detail` with the observed value; a failure should say what it saw,
not just that it failed. Assert against `data-testid`, never rendered prose.
