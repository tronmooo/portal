# Portol Autonomous Tutorial Studio

This branch contains production tooling only. It does not change the application, merge itself, or publish videos.

## Implemented scope

- Isolated Playwright package and lockfile; no root dependency installation.
- New tutorial account provisioning via the normal signup API. Credentials are saved before the request, mode 0600, outside source control. Run this once; never reset or use smoke accounts. If signup fails, inspect the saved pending record before retrying.
- Authentication in an unrecorded browser context, validated against `/api/auth/me` and pinned user/profile IDs. No saved browser state, tokens, HAR, traces, auth screenshots, or credentials in artifacts.
- Source route inventory, with every discovered route starting **untested**. An inventory is not complete feature coverage.
- Real chat pilot with per-run marker, exact typed fields, owner, unit, date and persistence checks, screenshot checkpoints and raw video. Failures prevent narration and final rendering.
- ElevenLabs narration with a character estimate and explicit character budget; per-scene audio.
- Actual frame-based scene alignment using a temporary 16px capture marker removed from rendered video.
- Scene-based FFmpeg assembly, captions, chapters, normalization, full-file decode and technical MP4 checks. Human playback/factual review remains required.
- Weekly GitHub Actions workflow, disabled until `TUTORIAL_STUDIO_ENABLED=true`. Artifacts require repository access and expire in 14 days. No public publishing step exists.

## Cloud setup

The new account credentials have been saved as sensitive variables on Vercel project `portal`, preview branch `feature/cloud-tutorial-producer` only. GitHub Actions cannot read Vercel secrets. Configure the following independently in the GitHub `tutorial-production` environment through an authenticated settings session:

- `PORTOL_TUTORIAL_EMAIL`
- `PORTOL_TUTORIAL_PASSWORD`
- `PORTOL_TUTORIAL_USER_ID`
- `PORTOL_TUTORIAL_PROFILE_ID`
- `ELEVENLABS_API_KEY` (TTS permission only)

Restrict that environment to reviewed branches. If running the draft branch, approve its exact reviewed commit before credentials are exposed. Installation steps have no credential environment. Do not use `pull_request_target` or untrusted PR scripts with secrets.

Repository variables: `TUTORIAL_STUDIO_ENABLED=true` only after the successful reviewed pilot; `ELEVENLABS_APPROVED_CHARACTER_LIMIT` set to the approved usage budget. A connected ElevenLabs ChatGPT account does not provide a CI API credential.

## Commands (repository root)

```sh
npm ci --ignore-scripts --prefix tutorial-producer
node --test tutorial-producer/tests/*.test.mjs
node tutorial-producer/discover.mjs
node tutorial-producer/record.mjs
node tutorial-producer/narrate.mjs --estimate
node tutorial-producer/narrate.mjs
python3 tutorial-producer/align.py
python3 tutorial-producer/render.py --dry-run
python3 tutorial-producer/render.py
```

Use Ubuntu 24.04 for the pinned Playwright version. The Vercel universal image currently uses Ubuntu 26.04, so validating there requires `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` during browser installation. That compatibility setting was tested in the cloud, not assumed.

## Expanding coverage

For each inventory feature, add explicit actions, expected values/owner/date, destination revisit, reload proof and screenshots before creating narration. Read-only route visibility must never be labeled CRUD coverage. Dynamic routes, integrations, document extraction, deletion cascades, recurrence, finance and profile isolation require individual tested scenarios. Never generate a claim from a route title alone. Unsupported/untested features remain blocked in the production report.

## Editorial handoff

Only a passing capture can become a tutorial. Import real raw footage plus approved narration into Descript for editorial review; preserve original footage. Canva may create a thumbnail after the demonstrated feature is verified. vidIQ packaging research is optional and does not authorize a public upload. None of those services can prove an app mutation succeeded.
