// Shared detector for synthetic QA / audit / smoke rows that leak into a real
// user's account when test suites run against it. The dashboard hides these by
// default (with a hidden toggle to reveal them) so normal views aren't polluted
// — see the cleanup that removed 80+ such rows from test@aol.com.
//
// Pure + dependency-free so both the client (filtering lists) and any server
// cleanup job can share ONE definition of "this is test data".

// Anchored / boundaried patterns — deliberately conservative so a real expense
// like "Quarterly taxes" (starts with "QA"? no — needs the QA_ / QA<space>Test
// shapes) is never mistaken for test junk.
const TEST_PATTERNS: RegExp[] = [
  /^AUDIT[0-9A-F]{4,}/i,          // AUDIT4C9B25_Bob_exp
  /^QAMULTI[0-9]/i,               // QAMULTI389053_asset_bob_kayak
  /^QASCALE/i,
  /^W2_[0-9]/i,                   // W2_1780532176_Hsub
  /^SMOKE[_ ]/i,
  /^QA_TEST/i,                    // QA_TEST_Coffee
  /^QA TEST/i,                    // "QA Test Expense EDITED"
  /^EMPTYPROBE_QA/i,
  /__qa[_a-z0-9]*__/i,            // __qa_e2e__, __qa_cascade_test__
  /__aichat_audit/i,              // __aichat_audit_cfd4d673__
  /\bTest Expense QA\b/i,
  /_QA\b/i,                       // trailing _QA token
];

/**
 * True if the given name/description looks like synthetic test data. Safe on
 * null/undefined. Matches are intentionally narrow — see TEST_PATTERNS.
 */
export function isTestDataRow(nameOrDescription: string | null | undefined): boolean {
  if (!nameOrDescription) return false;
  const s = String(nameOrDescription);
  return TEST_PATTERNS.some((re) => re.test(s));
}

/**
 * Convenience predicate for arrays of entities that carry either a `name`
 * (profiles/obligations) or a `description` (expenses/incomes/journal).
 */
export function isTestEntity(e: { name?: string | null; description?: string | null } | null | undefined): boolean {
  if (!e) return false;
  return isTestDataRow(e.name) || isTestDataRow(e.description);
}
