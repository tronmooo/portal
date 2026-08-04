// ── Medication dose ledger (server re-export) ────────────────────────────────
// The dose math moved to shared/medication-doses.ts when the Executive tab
// started reporting adherence gaps — it was always pure (the old `IStorage`
// import here was never used), so the client can run the same code rather than
// re-deriving it. This module stays so the AI engine's tool handlers keep
// importing from "./medication-doses" unchanged.
export {
  isMedicationTracker,
  trackerFrequencyText,
  resolveMedicationTracker,
  computeMissedDoses,
  doseHistory,
  type DoseWindowOpts,
} from "@shared/medication-doses";
