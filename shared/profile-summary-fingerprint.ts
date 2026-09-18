// ─── AI-summary value fingerprint ────────────────────────────────────────────
// The profile AI summary is cached for two hours, keyed by profile id only.
// Changing a MacBook's value $1,330 → $1,150 moved net worth instantly while
// the summary paragraph and its stat tiles kept quoting $1,330 (QA
// 2026-09-18 F-56): the client kept its cached copy, and the estimator's
// value write-back never cleared the server's. The summary now carries the
// fingerprint of the figures it was written from; a mismatch on either side
// means "regenerate", whichever path changed the value.
import { resolveAssetValue, resolveLiabilityBalance } from "./asset-value";

export function profileValueFingerprint(profile: any): string {
  if (!profile || typeof profile !== "object") return "";
  const fields = profile.fields && typeof profile.fields === "object" ? profile.fields : profile;
  const asset = resolveAssetValue(fields);
  const debt = resolveLiabilityBalance(fields);
  const asOf = String(fields?.currentValueAsOf ?? fields?.valueAsOf ?? "").slice(0, 10);
  return `v${asset}|d${debt}|${asOf}`;
}

/** True when a cached summary was written from different figures than the profile shows now. */
export function summaryIsStale(summary: { fingerprint?: string | null } | null | undefined, profile: any): boolean {
  if (!summary || summary.fingerprint == null) return false;
  return summary.fingerprint !== profileValueFingerprint(profile);
}
