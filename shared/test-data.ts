// Shared detector for synthetic QA / audit / smoke rows that leak into a real
// user's account when test suites run against it. The dashboard hides these by
// default (with a hidden toggle to reveal them) so normal views aren't polluted
// — see the cleanup that removed 80+ such rows from test@aol.com.
//
// Pure + dependency-free so both the client (filtering lists) and any server
// cleanup job can share ONE definition of "this is test data".
//
// ── How test data is isolated (Rule 27) ─────────────────────────────────────
// There is no `is_test` column. Isolation is two layers:
//   1. The smoke/QA fixture account is a SEPARATE workspace (see
//      REGRESSION_TESTS.md) — suites that need a real account run there.
//   2. Rows that still land in a real account are recognised by the NAME
//      PATTERNS below (`isTestEntity`) and excluded from every total by
//      default: the dashboard snapshot (`getDashboardEnhanced`), `/api/stats`,
//      and the AI's financial snapshot all pass their rows through
//      `excludeTestData`. The client hides them from lists (showTestData.ts,
//      default off).
// `includeTestData` (`?includeTestData=1`, the hidden "show test data"
// toggle) is the ONLY way a test row enters a total. Plain list endpoints
// (`/api/expenses`, …) are NOT filtered: the client filters lists itself, and
// test suites seed test-patterned rows through them and read them back.

// Anchored / boundaried patterns — deliberately conservative so a real expense
// like "Quarterly taxes" (starts with "QA"? no — needs the QA_ / QA<space>Test
// shapes) is never mistaken for test junk.
const TEST_PATTERNS: RegExp[] = [
  /^AUDIT[0-9A-F]{4,}/i,          // AUDIT4C9B25_Bob_exp
  /^AUDIT[ _-]?TEST\b/i,          // "AUDIT TEST TASK — please delete"
  /^QAMULTI[0-9]/i,               // QAMULTI389053_asset_bob_kayak
  /^QASCALE/i,
  /^W2_[0-9]/i,                   // W2_1780532176_Hsub
  /^SMOKE[_ ]/i,
  /^QA_TEST/i,                    // QA_TEST_Coffee
  /^QA TEST/i,                    // "QA Test Expense EDITED", "QA Test Daily Habit"
  /^EMPTYPROBE_QA/i,
  /__qa[_a-z0-9]*__/i,            // __qa_e2e__, __qa_cascade_test__
  /__aichat_audit/i,              // __aichat_audit_cfd4d673__
  /\bTest Expense QA\b/i,
  /_QA\b/i,                       // trailing _QA token
  /\bQA\d{3,}\b/i,                // "Buy printer paper QA778" (QA + run number)
  /^Test QA\b/i,                  // "Test QA Task"
  /^Test\b.*\bQA$/i,              // "Test Habit QA" (starts Test, ends QA)
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

/**
 * The rows a TOTAL may count: test-patterned rows removed unless the caller
 * explicitly opted in (`includeTestData`, from `?includeTestData=1`). Pure —
 * returns the same array when nothing is filtered so callers can compare by
 * identity. Every aggregate on the server (dashboard snapshot, /api/stats,
 * the AI's financial snapshot) reads its rows through this one gate.
 */
export function excludeTestData<T extends { name?: string | null; description?: string | null }>(
  rows: readonly T[] | null | undefined,
  includeTestData?: boolean,
): T[] {
  const list = (rows || []) as T[];
  if (includeTestData) return list;
  return list.filter((r) => !isTestEntity(r));
}
