// Guard for the "profile-scope leak" reported in the 2026-07-25 UX audit.
//
// FINDING: there is no cross-user leak. Every profile read in
// supabase-storage.ts is already scoped with .eq("user_id", this.userId), and
// the userId comes from a per-request storage instance created by the auth
// middleware (server/auth.ts → createScopedStorage). The audit's "ALL profiles
// in the system" is really ~79 profiles that all belong to the one test
// account — accumulated test data, not another user's rows.
//
// RLS is NOT the backstop here: the server connects with the service-role key,
// which bypasses RLS entirely. The `.eq("user_id", …)` in this file IS the
// enforcement boundary, so it is worth a static guard: a future refactor that
// drops one of these filters would silently expose every user's profiles.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../server/supabase-storage.ts"),
  "utf8",
);

describe("profiles table access is always owner-scoped", () => {
  it("every .from(\"profiles\") chain filters or writes user_id", () => {
    const offenders: string[] = [];
    let idx = SRC.indexOf('.from("profiles")');
    while (idx !== -1) {
      // A PostgREST chain ends at the statement terminator. Look ahead far
      // enough to cover the multi-line builder form.
      const chain = SRC.slice(idx, idx + 400).split(";")[0];
      const scoped = chain.includes('.eq("user_id"') || chain.includes(".insert(");
      if (!scoped) {
        const line = SRC.slice(0, idx).split("\n").length;
        offenders.push(`supabase-storage.ts:${line}`);
      }
      idx = SRC.indexOf('.from("profiles")', idx + 1);
    }
    expect(offenders, `unscoped profiles queries: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the insert path stamps the owner onto the row", () => {
    // createProfile builds `insertData` then inserts it — the owner stamp must
    // be on the object, not on a filter.
    expect(/insertData[\s\S]{0,60}user_id: this\.userId|user_id: this\.userId/.test(SRC)).toBe(true);
  });

  it("userId is per-instance, never a mutable module global", () => {
    expect(SRC).toMatch(/private userId: string/);
  });
});
