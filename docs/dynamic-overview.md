# Dynamic Asset & Liability Overview

The Overview tab of an asset or liability profile is **composed**, not templated.
Nothing in the pipeline asks "which hardcoded layout does a house get?" — it asks
"what is this entity, what do we actually know about it, and what is the clearest
summary we can build from that?"

```
entity data → semantic classification → entity schema → composition → renderer
 (canonical)   overview-semantics.ts     roles + ranks   overview-compose.ts   DynamicOverview.tsx
```

## Files

| File | Responsibility |
| --- | --- |
| `shared/overview-spec.ts` | The output contract: components, importance, provenance, display types, the AI-hint contract and its strict normalizer, and `overviewSignature()`. |
| `shared/overview-semantics.ts` | "What is this, and what does each field mean?" Field roles, date meanings, importance, entity family — all from key/value SHAPE, never from a per-product template. |
| `shared/overview-compose.ts` | Builds the `OverviewSpec`: resolves values, derives financial intelligence, summarizes relationships, ranks relevance, raises attention items, suggests missing information. Pure and synchronous. |
| `server/overview-engine.ts` | Gathers canonical data (profile detail, junction tables, owners, documents, obligations, expense rollups), optionally consults the model for *shape*, composes. |
| `GET /api/profiles/:id/overview` | The endpoint. `?refresh=true` re-reasons the composition; `?ai=0` composes deterministically. |
| `client/src/components/overview/DynamicOverview.tsx` | The renderer. Owns every visual decision; implements the component vocabulary and nothing else. |

## The two halves, and why they are separate

* **Composition** (which sections exist, in what order, holding which semantic
  keys) depends on the entity's *shape*. It is the only part the model is
  consulted about, and it is cached under the entity's structural signature —
  `type + type_key + sorted field keys + relationship kinds + has documents`.
* **Data** (the values in those slots) is resolved from canonical storage on
  every single request and is never cached.

So editing a balance shows the new balance under the same layout; adding a field
or linking a mortgage changes the signature and the layout is re-reasoned. A
stale layout can never render a stale number.

## What the model may and may not do

The model never returns an `OverviewSpec`, markup, component code, or a value.
It returns *hints* — labels, importance, grouping, section order, missing-field
suggestions, at most two short insights — which
`normalizeSchemaHints(raw, knownFieldKeys)` filters hard:

* a component / importance / display type outside the vocabulary is dropped
* a hint for a field the entity doesn't carry is dropped
* a "missing" field the entity already has is dropped
* insights are length-capped

Composition holds the pen, so a hallucinated key or an invented number cannot
reach the screen. The Overview composes fine with no model configured at all.

## Rules the composition enforces

* **Relevance.** Only `primary` / `secondary` information reaches the Overview.
  `detailed` and `administrative` facts are recorded in `meta.routedElsewhere`
  with their destination tab instead of being dumped into a card.
* **No duplication.** One canonical home per number. A value already shown as
  the headline or a summary metric is not repeated in a details card; repetition
  has to mean something different (value vs debt vs equity).
* **Relationships, not copies.** A property's Overview may show its mortgage's
  balance, but `sourceReference` points at the mortgage — the data keeps
  belonging to the record that owns it.
* **Derived values are sourced.** Every derived metric names its inputs and is
  marked `calculated`. Nothing derived is written back as a stored fact unless
  the user explicitly saves it.
* **Missing information must unlock something.** A suggestion appears only when
  the field completes a metric or a date that matters for *this* entity — never
  an exhaustive form of everything a field could theoretically be.
* **Partial data stays intentional.** A handful of facts collapse into one
  compact card rather than four near-empty ones; the Overview gets richer as
  documents, links and edits add data.
* **Provenance is visible where it changes trust.** Calculated / linked /
  estimated / AI values are marked; user- and document-entered values are not,
  so the marker keeps meaning something.

## Adding a new presentation primitive

1. Add it to `OVERVIEW_COMPONENTS` in `shared/overview-spec.ts`.
2. Emit it from `composeOverview` where the reasoning calls for it.
3. Implement it in `renderSection` in `DynamicOverview.tsx`.

Do **not** add a per-type branch. If a family of entity needs something new, ask
what general property of the data justifies it (a balance against a limit → a
utilization metric; a value against a purchase price → appreciation) and express
that instead.

Tests: `tests/overview-compose.test.ts`, `tests/overview-engine.test.ts`,
`tests/overview-render.dom.test.tsx`.
