// @vitest-environment jsdom
//
// "I marked it as paid in the calendar, and the liability's Payments tab still
// says September 15 is upcoming."
//
// The write itself was never the problem: paying from the calendar POSTs to
// /api/obligation-occurrences/<liabilityId>:<date>/status, which stamps
// fields.occurrences on the liability profile — the same store the profile's
// Schedule & Calendar reads. What broke was the refresh. The server's write
// manifest named the "liabilities" domain, the cache bus fired, and the one
// query that renders that schedule did not match its predicate, because the
// predicate required a TRAILING SLASH ("/api/liabilities/") while the schedule
// is keyed ["/api/liabilities", id, "schedule"]. Both spellings are in use
// across the app, so half the liability reads were unreachable by domain
// invalidation and the other half were not.
//
// These tests pin the fan-out by behavior: seed a query under every spelling a
// liability surface actually uses, invalidate the domain a payment reports, and
// require all of them to be marked stale.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import type { Domain } from "@shared/entity-domains";

const LIABILITY_ID = "liab-1";

/** Every key spelling a liability profile's own surfaces are read under. */
const LIABILITY_KEYS: readonly unknown[][] = [
  // Schedule & Calendar (the Payments tab occurrence list) — array form.
  ["/api/liabilities", LIABILITY_ID, "schedule"],
  // Party links, read under BOTH spellings by two cards on the same page.
  ["/api/liabilities", LIABILITY_ID, "parties"],
  [`/api/liabilities/${LIABILITY_ID}/parties`],
  // Payment history and linked assets — template form.
  [`/api/liabilities/${LIABILITY_ID}/payments`],
  [`/api/liabilities/${LIABILITY_ID}/assets`],
  // The profile row itself, and its composed Overview.
  ["/api/profiles"],
  ["/api/profiles", LIABILITY_ID, "overview"],
];

function seed(keys: readonly unknown[][]) {
  queryClient.clear();
  for (const key of keys) queryClient.setQueryData(key, { seeded: true });
}

function stale(key: readonly unknown[]): boolean {
  return queryClient.getQueryState(key)?.isInvalidated === true;
}

async function bust(...domains: Domain[]) {
  await invalidateDomains(...domains);
}

describe("cache bus — a liability write reaches every spelling of its keys", () => {
  beforeEach(() => seed(LIABILITY_KEYS));

  it("invalidates the occurrence schedule when the liabilities domain fires", async () => {
    await bust("liabilities");
    // The exact key behind "marked paid on the calendar, still upcoming here".
    expect(stale(["/api/liabilities", LIABILITY_ID, "schedule"])).toBe(true);
  });

  it("invalidates every liability sub-resource, both key spellings", async () => {
    await bust("liabilities");
    for (const key of LIABILITY_KEYS) {
      expect(stale(key), JSON.stringify(key)).toBe(true);
    }
  });

  it("reaches the same keys from the obligations domain", async () => {
    // A bill occurrence is written through the obligation endpoints, so a pay
    // reports "obligations" as well — and a bill IS a liability profile.
    await bust("obligations");
    for (const key of LIABILITY_KEYS) {
      expect(stale(key), JSON.stringify(key)).toBe(true);
    }
  });

  it("still refreshes the calendar when a payment is recorded on the profile", async () => {
    seed([["/api/calendar/timeline"], ["/api/obligations"], ["/api/notifications"]]);
    await bust("liabilities", "obligations");
    expect(stale(["/api/calendar/timeline"])).toBe(true);
    expect(stale(["/api/obligations"])).toBe(true);
    expect(stale(["/api/notifications"])).toBe(true);
  });

  it("does not invalidate unrelated domains", async () => {
    seed([["/api/journal"], ["/api/habits"], ["/api/liabilities", LIABILITY_ID, "schedule"]]);
    await bust("liabilities");
    expect(stale(["/api/liabilities", LIABILITY_ID, "schedule"])).toBe(true);
    expect(stale(["/api/journal"])).toBe(false);
    expect(stale(["/api/habits"])).toBe(false);
  });
});

// ─── Where the relational sections live ────────────────────────────────────
// Linked assets, the ownership split and the linked-people list are field-level
// detail about the liability, not a summary of the debt. They belonged on
// Details, next to the terms they qualify; Overview keeps the read-only
// ownership rollup the composed overview draws.
describe("liability profile — relational sections live on Details", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../client/src/pages/liability-detail.tsx"),
    "utf8",
  );

  /** The JSX between one TabsContent's open tag and the next one. */
  function tabBody(value: string): string {
    const start = src.indexOf(`<TabsContent value="${value}"`);
    expect(start, `tab ${value} not found`).toBeGreaterThan(-1);
    const next = src.indexOf("<TabsContent value=", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  const details = tabBody("details");
  const overview = tabBody("overview");

  it("renders linked assets, ownership and linked people on Details", () => {
    for (const marker of ["<LinkedAssetsCard", "<OwnershipEditor", "<LinkedPeopleTab"]) {
      expect(details, marker).toContain(marker);
    }
  });

  it("no longer renders them on Overview", () => {
    for (const marker of ["<LinkedAssetsCard", "<OwnershipEditor", "<LinkedPeopleTab"]) {
      expect(overview, marker).not.toContain(marker);
    }
  });

  it("keeps the composed Overview on Overview", () => {
    expect(overview).toContain("<DynamicOverview");
    expect(details).not.toContain("<DynamicOverview");
  });
});
