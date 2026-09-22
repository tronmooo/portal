// shared/domain/data-environment.ts — real data, demo data and test data are
// three environments, and production totals read only the first.
//
// Test rows were detected by name pattern alone (shared/test-data.ts) and the
// predicate was re-inlined at a dozen call sites with different field sets;
// getStats() applied none of them, so the Settings tiles counted QA rows the
// dashboard hid. This module gives every record ONE environment, read from an
// explicit flag first and the name heuristic second, and one filter every
// aggregate calls.
//
// Pure. Pinned by tests/consistency-layer-test-data.test.ts.

import { isTestDataRow } from "../test-data";

export type DataEnvironment = "production" | "demo" | "test";

/** The tag that marks a row as test data. A system tag — never shown as a chip. */
export const TEST_DATA_TAG = "env:test";
export const DEMO_DATA_TAG = "env:demo";

const QA_PREFIX = /^QA\s+(?!(?:manager|engineer|lead|analyst|team|department|salary|role|job|interview)\b)\S/i;

export interface EnvironmentTagged {
  environment?: string | null;
  isTestData?: boolean | null;
  tags?: readonly unknown[] | null;
  /** Profile-style field bag; trackers carry an array here, which is ignored. */
  fields?: unknown;
  name?: string | null;
  title?: string | null;
  description?: string | null;
}

/**
 * The environment a record belongs to. Explicit markers win; the name
 * heuristic (`QA Phone Bill`, `AUDIT…`) is the fallback for rows created
 * before the flag existed.
 */
export function dataEnvironmentOf(record: EnvironmentTagged | null | undefined): DataEnvironment {
  if (!record) return "production";
  const bag = record.fields && typeof record.fields === "object" && !Array.isArray(record.fields) ? (record.fields as Record<string, any>) : {};
  const explicit = String(record.environment ?? bag.environment ?? bag._environment ?? "").toLowerCase();
  if (explicit === "test" || explicit === "demo" || explicit === "production") return explicit;
  if (record.isTestData === true || bag.isTestData === true) return "test";
  const tags = (record.tags || []).map((t) => String(t ?? "").toLowerCase());
  if (tags.includes(TEST_DATA_TAG) || tags.includes("test-data") || tags.includes("qa")) return "test";
  if (tags.includes(DEMO_DATA_TAG)) return "demo";
  if (isTestDataRow(record.name) || isTestDataRow(record.title) || isTestDataRow(record.description)) return "test";
  // "QA Phone Bill", "QA receipt" — a QA prefix on a record name is a test
  // marker; a QA job title ("QA Manager salary") is not.
  if ([record.name, record.title].some((v) => QA_PREFIX.test(String(v ?? "")))) return "test";
  return "production";
}

export function isTestRecord(record: EnvironmentTagged | null | undefined): boolean {
  return dataEnvironmentOf(record) === "test";
}

export function isProductionRecord(record: EnvironmentTagged | null | undefined): boolean {
  return dataEnvironmentOf(record) === "production";
}

export interface EnvironmentFilter {
  /** Show test rows too (the hidden developer toggle). Default false. */
  includeTest?: boolean;
  /** Show demo rows. Default true — a demo profile is a real profile for QA. */
  includeDemo?: boolean;
}

/** The rows a normal production surface may aggregate. */
export function forEnvironment<T extends EnvironmentTagged>(rows: readonly T[] | null | undefined, filter: EnvironmentFilter = {}): T[] {
  const includeTest = filter.includeTest === true;
  const includeDemo = filter.includeDemo !== false;
  return (rows || []).filter((r) => {
    const env = dataEnvironmentOf(r);
    if (env === "test") return includeTest;
    if (env === "demo") return includeDemo;
    return true;
  });
}

/** Stamp a record as test data (returns a new object). */
export function markAsTestData<T extends EnvironmentTagged>(record: T): T {
  const tags = Array.from(new Set([...(record.tags || []).map(String), TEST_DATA_TAG]));
  return { ...record, isTestData: true, environment: "test", tags };
}
