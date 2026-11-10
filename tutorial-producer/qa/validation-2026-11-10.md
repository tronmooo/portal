# Validation report — 2026-11-10

## Verified live

Vercel project `portal`, origin https://portol.me, fresh dedicated account and `Tutorial Studio` person profile. No shared smoke account was used. No existing customers were modified.

The real Chat-to-Trackers pilot passed all five checkpoints in a Vercel cloud sandbox: visible dedicated profile selection; one real chat submission; unique tracker in compact list; matching history row with 2.5 miles, 42 minutes, UTC date and run marker; same exact row after reload. Read-only authenticated API checks independently confirmed the user ID, entry owner, values and field units (`miles`, `min`). All test writes were synthetic and scoped to the new account.

ElevenLabs Bella narration was generated (553 credits, estimated USD 0.092184) and transcribed back. Its 95-word transcript matches the approved script. The original video is 45.08 seconds; the narrated pilot export is H.264/AAC, 1920x1080, with captions and private download delivery. No public publish was performed.

## Confirmed UI defect: duration units omitted in history

Severity: low, display clarity. The stored duration field declares `unit: min`, and the compact list displays `42 min`, but the history row displays `Duration: 42` without the unit.

Reproduction:
1. Use the dedicated Tutorial Studio profile.
2. Ask Chat to create a walking tracker and log 2.5 miles and 42 minutes today.
3. Open Trackers, compact list, the new tracker, then History.
4. Compare `Duration: 42` in history with `42 min` in the compact list and the field definition.

Expected: `Duration: 42 min`. Actual: `Duration: 42`. Evidence: `raw/screenshots/04-history.png` and `05-reload.png` in the delivered evidence bundle. Do not treat this as a persistence failure. Production UI fix is intentionally not included in this tooling PR.

## Tooling findings

- First capture failed at tracker navigation because the runner did not select its dedicated profile. Fixed by selecting and visibly confirming Tutorial Studio before chat; subsequent capture passed.
- Wall-clock timing drifted from encoded video frames. Initial export review caught an outcome hold on a loading frame. Added frame-marker-based alignment and removed capture markers from final exports. The earlier pilot edit has manually reviewed source frame boundaries.
- Initial provisioning code called the Fetch `ok` property as a function. It was corrected, and credentials are now written privately before the signup request. An earlier synthetic signup may have created an unused account whose generated identity was not retained; no cleanup was attempted against unknown accounts. The managed dedicated account is distinct and successfully validated.
- Descript produced a private editable draft but reported narration synchronization limits; it is not an approved final export and was never published.

## Coverage limits and genuine access gaps

The source inventory contains 44 route entries, many aliases. It is a discovery queue, not proof of all feature coverage. Documents/OCR, finance CRUD and calculations, calendar recurrence, habits and medication, integrations, nested assets, deletion cascades, and broader profile isolation still require individual end-to-end scenarios and tutorial recordings.

The GitHub connector can update source and PR metadata but exposes no environment-secret configuration or workflow-dispatch tool. CLI and TinyFish GitHub browser are signed out. Therefore GitHub environment secret installation and dispatch have not been completed. Vercel branch-scoped sensitive credentials are configured, but Actions cannot consume Vercel secrets. A secure authenticated GitHub settings session is required; never paste credentials into chat.

Unattended ElevenLabs API calls also require a runner API key; the connected ChatGPT ElevenLabs account does not supply that secret. Keep the schedule opt-in flag disabled until credentials and a full unattended run are validated. Automated technical QA cannot replace factual playback approval.
