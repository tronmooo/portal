# AI Plant Identification — Feature Spec

Branch: `claude/ai-plant-identification-enHfT`
Status: Planning (not yet implemented)

## 1. What we're building

A dynamic plant-identification system for Portol. User takes/uploads a
photo → Claude vision (optionally paired with a plant-specific API) identifies
the plant, extracts care data, and proposes a structured save. The user
**reviews and selects** what gets saved — we never persist blindly, because
AI outputs vary and photo uploads sometimes partially fail. Plants become
first-class profiles with their own tab layout and a rich photo timeline.

This reuses the existing `pendingExtraction` → `ExtractionConfirmation`
pattern already proven for document ingestion (`server/routes.ts:467`,
`client/src/pages/chat.tsx:420-600`), adapted for plants.

## 2. Research — how this should work

### Identification approach (layered, dynamic)
1. **Primary pass** — Claude Sonnet 4.5 vision (already wired in
   `server/ai-engine.ts:620-800`). Prompted to return a strict JSON shape
   with a `confidence` score per field.
2. **Secondary pass (optional, plant-specific)** — Pl@ntNet API
   (`my.plantnet.org`) or Plant.id. We call it only when Claude's
   confidence < 0.75, to avoid cost and latency on easy cases.
3. **Merge step** — if both services agree on species, confidence = high.
   If they disagree, surface BOTH candidates in the review UI and let the
   user pick. Never silently choose.
4. **EXIF pass** — parse EXIF client-side (`exifr` lib) to get
   GPS + capture date. This becomes "where/when the photo was taken" and
   feeds the plant's location + timeline — no extra AI needed.

### Why selective save matters
- Vision models hallucinate exact species when they should stop at genus.
- Photo uploads sometimes fail partway (large HEIC, rotated iPhone images,
  slow networks) — we need to tolerate missing fields.
- Care advice is generic by default and the user may want to override it
  (e.g. their apartment gets low light even though the species "wants"
  bright).
- Privacy: GPS from EXIF should be OFF by default and opt-in per save.

Therefore every extracted field ships with `{ value, confidence, selected,
source }` and the UI lets the user toggle, edit, or drop it before commit.

## 3. Data model

### 3.1 New profile type — `plant`
Add `"plant"` to `ProfileType` in `shared/schema.ts:191`. Reuse the
existing `fields: Record<string, any>` JSON bag — **no schema migration
needed** beyond the union literal. Canonical shape of `fields` for a plant:

```ts
{
  commonName: "Monstera Deliciosa",
  scientificName: "Monstera deliciosa",
  family: "Araceae",
  nickname: "Big Leaf",            // user-chosen
  acquiredOn: "2025-03-14",
  acquiredFrom: "Home Depot",
  location: "living room window",  // human, not GPS
  potSize: "10in",
  soilType: "aroid mix",
  care: {
    light: "bright indirect",
    watering: { frequency: "weekly", lastWatered: "2025-04-14" },
    humidity: "50-60%",
    temperatureF: { min: 65, max: 85 },
    fertilizer: "monthly, balanced, spring-summer only",
    toxicity: "toxic to cats/dogs"
  },
  health: {
    status: "thriving" | "stressed" | "sick" | "recovering",
    lastAssessedAt: "2025-04-15",
    issues: ["yellowing lower leaf"]   // AI-suggested, user-confirmed
  },
  identification: {
    confidence: 0.92,
    source: "claude+plantnet",
    candidates: [ { name, confidence } ]   // alt IDs if ambiguous
  }
}
```

### 3.2 Photo records — reuse `Document`
Each plant photo is a `Document` with:
- `type: "plant_photo"`
- `linkedProfiles: [plantProfileId]`
- `extractedData`: the vision pass output (full, raw — even fields the
  user chose not to promote to the profile)
- `fields`: only the user-approved subset (what we actually trust)
- `capturedAt` (from EXIF or upload time)
- `tags`: e.g. `["before-repot", "new-leaf", "sick"]`

This gives us a **timeline** per plant for free using existing document
queries.

### 3.3 Trackers for plants
Reuse existing `trackers` infra. Offered (not forced) on confirmation:
- `watering` — numeric count, daily granularity
- `fertilizing` — monthly
- `leaf-count` — for growth
- `height-cm` — for growth
- `health-score` — 1-5, updated when new photos arrive

### 3.4 Linking
- Plant → owner person profile via `parentProfileId` or `entity_links`.
- Plant → property/room via `entity_links` (e.g. "Kitchen", "South
  balcony").
- Photo → plant via `linkedProfiles` (existing).

## 4. The "dynamic / selective save" flow

End-to-end, mirroring the document extraction flow:

```
[1] Client: user picks/takes photo
    ├── correctImageOrientation()       (already in chat.tsx:1627)
    ├── read EXIF (GPS, capturedAt)     NEW — exifr, client-side
    └── POST /api/plant/identify        NEW endpoint

[2] Server: POST /api/plant/identify
    ├── size/mime checks                (reuse routes.ts:308-314)
    ├── store photo:
    │     - >2MB → Supabase Storage    (supabase-storage.ts)
    │     - else → base64 in Document
    ├── call identifyPlant() in ai-engine.ts:
    │     - Claude Sonnet vision pass
    │     - if confidence<0.75 → Pl@ntNet fallback
    │     - merge candidates
    └── respond with pendingPlantId (NOT yet saved)

[3] Client: render PlantIdReview dialog
    Every field row:
      [✓] commonName:      Monstera Deliciosa   (0.94) [edit]
      [✓] scientificName:  Monstera deliciosa   (0.91) [edit]
      [ ] family:          Araceae              (0.88) [edit]
      [✓] light:           bright indirect      (rule) [edit]
      [ ] GPS location:    37.77,-122.42        (EXIF)  ← off by default
      Target plant:  ( ) New plant  (•) Update "Big Leaf"
      Trackers:      [✓] watering  [ ] growth  [ ] health score

[4] User clicks Save
    POST /api/plant/confirm with { extractionId, selectedFields,
                                   targetProfileId|newProfile,
                                   trackersToCreate }

[5] Server: inside a transaction
    ├── upsert plant profile (fields ← selectedFields only)
    ├── persist Document (extractedData = full, fields = selectedFields)
    ├── create trackers + initial entries
    └── return { profileId, documentId }
```

Key rule: **`extractedData` on the Document keeps the full AI output**
(audit trail / retry), but **`Profile.fields` only gets what the user
checked**. That's how we stay honest when the AI is wrong and how the
user can re-open the photo later and promote more fields.

### Resilience against broken uploads
- Chunk the upload; if the image bytes fail we still save a `Document`
  stub with `status: "upload_failed"` so the user doesn't lose the
  identification draft.
- Identification result is cached by `extractionId` for 24h so the
  review dialog can be reopened after a reload.
- If EXIF read fails we skip it — never block identification on metadata.
- Client validates dimensions ≥ 200px before sending (blurry thumbnails
  waste a vision call).

## 5. How it looks inside each profile

### 5.1 New plant profile tab layout
Add to `PROFILE_TABS_SPEC.md`:

```
### Plant
Overview | Care | Photos | Health | Reminders | Activity
```

- **Overview** — hero photo, common + scientific name, nickname,
  location, acquired date, quick "next watering" card, toxicity badge.
- **Care** — editable care card (light / water / humidity / temp /
  fertilizer / soil). Every field shows its source badge (`AI`, `you`,
  `Pl@ntNet`) and a confidence dot.
- **Photos** — chronological timeline of plant photos. Click any photo
  → see the original AI extraction, re-run identification, add tags
  (`new-leaf`, `repotted`, `sick`), or promote extra fields to the
  profile.
- **Health** — current status chip + history of issues + a "diagnose
  from latest photo" button (runs a focused vision pass for disease /
  pests).
- **Reminders** — derived from care data: next watering, next fertilize,
  seasonal repot. One-click accept → creates a task.
- **Activity** — unified feed: photos added, fields edited, tracker
  entries, reminders fired.

### 5.2 How plant data appears on OTHER profiles
- On a **Person / Self** profile → a "Plants" smart card on Overview
  listing plants where `parentProfileId === personId`. Click → the
  plant's own profile.
- On a **Property** profile → Overview gets a "Plants in this space"
  group so a user can see their home's plants by room.
- Chat: existing tool-use AI already can answer "what plants need water
  this week" once plant profiles + trackers exist — no extra wiring
  needed beyond exposing a `getPlants` tool.

## 6. API surface (new)

| Method | Path                       | Purpose |
|--------|----------------------------|---------|
| POST   | `/api/plant/identify`      | Upload photo, return `pendingPlantId` |
| POST   | `/api/plant/confirm`       | Commit selected fields + trackers |
| POST   | `/api/plant/:id/diagnose`  | Health-only vision pass for an existing plant |
| GET    | `/api/plant/:id/photos`    | Timeline of photos for a plant |
| POST   | `/api/plant/:id/promote`   | Promote a field from a past photo's `extractedData` onto the profile |

All wrapped by `IStorage` so in-memory, SQLite, and Supabase backends
stay interchangeable.

## 7. File-by-file implementation plan

Suggested order, each step is independently shippable.

### Step 1 — Schema (smallest possible)
- `shared/schema.ts:191` — add `"plant"` to `ProfileType`.
- `shared/schema.ts` — add `PendingPlantIdentification` shape next to
  `PendingExtraction`.
- `shared/schema.ts` — add `"plant_photo"` to document `type` literals.
- No DB migration needed; `fields` is already JSON.

### Step 2 — Server: identification engine
- `server/ai-engine.ts` — new `identifyPlant(file, opts)` that:
  - builds a plant-specific system prompt demanding a strict JSON
    schema with `confidence` per field,
  - optionally calls Pl@ntNet when confidence is low,
  - returns the same `PendingPlantIdentification` shape.
- `server/plantnet.ts` — thin wrapper around Pl@ntNet REST (env key
  `PLANTNET_API_KEY`), feature-flagged off by default.

### Step 3 — Server: routes
- `server/routes.ts` — register the 5 endpoints above. `/identify`
  reuses the size/mime/orientation logic from `/api/upload`.
- Add `extractionId`-keyed in-memory cache (24h TTL) for pending
  identifications.

### Step 4 — Client: review dialog
- `client/src/components/PlantIdReview.tsx` — new, but copy-paste heavy
  from `ExtractionConfirmation` in `chat.tsx:420-600`. Per-field
  checkbox + inline edit + confidence dot + source badge.
- `client/src/lib/exif.ts` — tiny EXIF reader using `exifr`.
- Hook from camera/upload button: show the dialog, POST to
  `/api/plant/confirm` on save.

### Step 5 — Client: plant profile tabs
- `client/src/pages/profile-detail.tsx` — branch on `profile.type ===
  "plant"` to render the new tab set.
- New components: `PlantOverviewTab`, `PlantCareTab`, `PlantPhotosTab`,
  `PlantHealthTab`, `PlantRemindersTab`. Activity is already generic.

### Step 6 — Surfacing on other profiles
- Person/Self Overview: add "Plants" smart card.
- Property Overview: add "Plants in this space" group.
- Chat tools: register a `listPlants` / `getPlantCare` tool.

### Step 7 — Polish
- Failed-upload draft recovery.
- "Re-identify this photo" action on the photo timeline (in case a
  newer model does better).
- Export: each plant profile → PDF care card, already supported by the
  shared PDF pipeline, just wire the template.

## 8. Open questions for the user

1. **Plant-specific API** — OK to add Pl@ntNet as a low-confidence
   fallback (free tier), or Claude-only for v1?
2. **GPS** — default OFF on save (my recommendation), or auto-fill
   location from EXIF when available?
3. **Scope of v1** — ship identification + profile + photo timeline
   first, and leave disease diagnosis for v2? Or include a basic
   "health" pass from day one?
4. **Plant type as a new `ProfileType`** vs. piggy-backing on `asset`
   with a type-key. New type is cleaner; piggy-back avoids touching the
   union. Recommendation: new type.

## 9. Summary

- Reuse the proven extract → review → confirm pattern; don't invent a
  new one.
- Keep `Document.extractedData` as the full AI trace, keep
  `Profile.fields` as only user-approved truth — that's how the system
  stays trustworthy when photos are bad or models are wrong.
- Add one profile type (`plant`) and one document type (`plant_photo`).
  No DB migration.
- Dedicated plant tabs; plants also surface as cards on their owners'
  and their rooms' profiles.
- Everything is selective, every field has provenance, nothing is saved
  until the user says so.
