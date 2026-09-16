# Universal automatic current-value system

Every owned asset profile shows its **estimated current value** the moment it
opens, from a stored record, and keeps that estimate current in the background.
No asset type is special-cased: the pipeline decides for itself what the thing
is, which stored facts matter, which valuation methods its evidence supports,
and how sure it can be.

```
Asset Data Resolver        server/valuation/resolver.ts     getProfileDetail → AssetDataBundle
        ↓
Valuation Context Builder  shared/valuation/context.ts      material facts by semantic role, identifiers,
                                                            user value vs estimator value, appraisals,
                                                            improvements, income, fingerprint
        ↓
Valuation Strategy Planner shared/valuation/planner.ts      methods from EVIDENCE (symbol → quote, purchase →
                                                            transaction/trajectory, description → live comps,
                                                            income → capitalization, history → trend…)
        ↓
Evidence providers         server/valuation/providers/*     market-quote (public quote API), live-search
                                                            (existing Perplexity/Anthropic appraiser),
                                                            internal (shared/valuation/internal-evidence.ts)
        ↓
Valuation Engine           shared/valuation/engine.ts       weight = method × reliability × relevance × decay
Confidence / Range Engine                                   blend, dispersion, honest confidence, no false precision
        ↓
Cache + History            server/valuation/storage-codec   preferences rows `valuation:<id>` /
                           + both storage backends           `valuation-history:<id>` (user-scoped)
        ↓
Freshness / Refresh        shared/valuation/freshness.ts    fingerprint, per-record market window, backoff
                           server/valuation/service.ts      snapshot (cheap) / refresh (background, locked)
        ↓
Asset Profile UI           client/src/hooks/useAssetValuation.ts   CACHE FIRST → DISPLAY → CHECK → REFRESH → UPDATE
                           client/src/components/asset/CurrentValueCard.tsx
```

## Speed contract

* `GET /api/profile-bootstrap/:id` reads the stored record in the same
  `Promise.all` as the profile detail and computes the freshness verdict from
  the detail it already has (sub-millisecond, pure). No provider, model or
  calculation runs on the open path. Measured in `tests/valuation-routes.test.ts`
  (`[bench]` line).
* The client renders the seeded record, then — off the render path — calls
  `POST /api/profiles/:id/valuation/refresh` only when the verdict is stale.
  Attempts are throttled per asset per tab; a per-asset server lock makes
  concurrent opens share one run (202 → the client polls the cheap snapshot).
* The refresh route is a **conditional write**: a run that changed nothing
  neither bumps the data version nor busts any cache (`isConditionalWritePath`
  in `server/routes.ts`). A changed estimate is journaled as an `assets` write
  and propagates through the normal write manifest.

## Invalidation

`inputFingerprint` hashes only material facts (identity, specification, usage,
location, condition, purchase, appraisals, improvements, income, condition
words in notes). Contacts, coverage, ownership plumbing, administrative keys,
tags and — critically — prior valuation outputs are excluded, so editing them
never invalidates. Market evidence has its own window per record
(`marketFreshnessMs`: hours for a quoted instrument, 7/30/90 days for a searched
market by volatility). Errors back off exponentially; "insufficient data" is
re-tried weekly or when inputs change. `VALUATION_MODEL_VERSION` re-values
everything on the next open when the math changes.

## User values

The estimate never overwrites a user-entered value. `fields.currentValue` is
mirrored only when it is empty or already estimator-owned
(`fields.currentValueSource === "estimate"`, or legacy `valuationMethod`
markers). A value typed through `PATCH /api/profiles/:id` is stamped
`currentValueSource: "user"`. Purchase price, appraisals and document values are
inputs and are never modified. History is kept per asset (bounded).

## AI

The model is consulted only in the background refresh, only when deterministic
planning could not classify/plan the asset confidently, and its answer
(`AssetUnderstanding`: kind, value drivers, volatility, drift, searchability,
symbol) is cached by the asset's structural signature. It returns hints, never
a value. The live-search appraiser (Perplexity → Anthropic fallback) is one
evidence provider among others, weighed by the engine like any other source.

## Adding a source

Implement `EvidenceProvider` (`server/valuation/providers/types.ts`) and add it
to `server/valuation/providers/registry.ts`. Name its id in the planner rule
that should use it. No route, engine, storage or UI change is needed.

## Endpoints

* `GET  /api/profiles/:id/valuation[?history=1]` — snapshot (+ history)
* `POST /api/profiles/:id/valuation/refresh` `{ force?: boolean }` — background refresh
* `POST /api/profiles/:id/lookup-value` — legacy button; same pipeline, forced
