// Why "it will not allow me to delete profiles" was true (2026-08-11 report).
//
// The delete button and the cascade both existed and both worked. What did not
// exist was a PATH to them for a person:
//
//   profile-route-dispatch.tsx sends self / person / pet at /profiles/:id
//   straight to /profiles/:id/info, and only renders the 13k-line
//   profile-detail.tsx — the one page carrying a Delete control — for every
//   OTHER type. profile-info.tsx, the page people actually landed on, had no
//   delete of any kind.
//
// So assets could be deleted and people could not, which is exactly backwards
// from what the user needed: every bogus row chat had invented ("tires for my
// Dodge ram", "my MacBook Pro m4", "my 2025 Dodge ram") was type "person".
//
// These tests read the source files. That is deliberate — the bug was a
// missing control, and a unit test of a component that never rendered the
// control would have passed just as happily before the fix.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const INFO_PAGE = read("client/src/pages/profile-info.tsx");
const DETAIL_PAGE = read("client/src/pages/profile-detail.tsx");
const DISPATCH = read("client/src/pages/profile-route-dispatch.tsx");
const ROUTES = read("server/routes.ts");
const SUPA = read("server/supabase-storage.ts");
const ENGINE = read("server/ai-engine.ts");

describe("the Info tab is where a person can be deleted", () => {
  it("still routes people to the Info page rather than the detail page", () => {
    // If this ever changes, the Info-page delete stops being the only path and
    // these tests should be revisited — but people must never end up with NO
    // path, which is the state this file exists to prevent.
    expect(DISPATCH).toMatch(/PERSON_TYPES/);
    expect(DISPATCH).toMatch(/\/profiles\/\$\{profile\.id\}\/info/);
  });

  it("renders a delete control on the Info page", () => {
    expect(INFO_PAGE).toMatch(/data-testid="info-delete-profile"/);
    expect(INFO_PAGE).toMatch(/data-testid="info-danger-zone"/);
  });

  it("confirms before deleting, and says what goes with them", () => {
    expect(INFO_PAGE).toMatch(/data-testid="info-dialog-confirm-delete"/);
    expect(INFO_PAGE).toMatch(/data-testid="info-confirm-delete"/);
    expect(INFO_PAGE).toMatch(/data-testid="info-cancel-delete"/);
    for (const word of ["tasks", "habits", "trackers", "documents", "journal"]) {
      expect(INFO_PAGE.toLowerCase()).toContain(word);
    }
  });

  it("calls the real delete endpoint", () => {
    expect(INFO_PAGE).toMatch(/apiRequest\("DELETE", `\/api\/profiles\/\$\{id\}`\)/);
  });

  it("clears the deleted profile out of client state so it cannot reappear", () => {
    // Both list caches (full and lite) plus the detail entry, and the profile
    // scope, which otherwise keeps every scoped query pinned to a dead id.
    expect(INFO_PAGE).toMatch(/setQueryData\(\["\/api\/profiles"\]/);
    expect(INFO_PAGE).toMatch(/setQueryData\(\["\/api\/profiles", "lite"\]/);
    expect(INFO_PAGE).toMatch(/removeQueries/);
    expect(INFO_PAGE).toMatch(/reconcileProfileFilter/);
  });

  it("shows the account owner why there is no button instead of a failing one", () => {
    expect(INFO_PAGE).toMatch(/data-testid="info-primary-owner"/);
    expect(INFO_PAGE).toMatch(/isSelf \?/);
  });
});

describe("the detail page's delete is hidden for the account owner", () => {
  it("guards the hero button", () => {
    expect(DETAIL_PAGE).toMatch(/!isPrimaryProfile\(profile\)/);
  });

  it("also clears client state on delete", () => {
    expect(DETAIL_PAGE).toMatch(/reconcileProfileFilter/);
  });
});

describe("the server refuses to delete the primary account owner", () => {
  it("blocks it at the route, before the cascade runs", () => {
    expect(ROUTES).toMatch(/isPrimaryProfile\(existing\)/);
    expect(ROUTES).toMatch(/PRIMARY_PROFILE_PROTECTED/);
  });

  it("blocks it at the storage layer, so no other caller can route around it", () => {
    expect(SUPA).toMatch(/isPrimaryProfile\(profile\)/);
  });

  it("blocks it in the chat tool", () => {
    expect(ENGINE).toMatch(/PRIMARY_PROFILE_DELETE_ERROR/);
  });
});

describe("chat's delete_profile reports honestly", () => {
  it("does not claim success when the cascade came back false", () => {
    // storage.deleteProfile returns false on a partial cascade. The tool used
    // to ignore the return value entirely and answer { deleted: true }.
    expect(ENGINE).toMatch(/const dpOk = await storage\.deleteProfile\(profile\.id\)/);
    expect(ENGINE).toMatch(/if \(!dpOk\)/);
  });
});

describe("the cascade leaves nothing behind", () => {
  it("cleans up chat artifacts, which have no foreign key to fall back on", () => {
    expect(SUPA).toMatch(/cascadeChatArtifacts/);
    expect(SUPA).toMatch(/from\("chat_artifacts"\)\.delete\(\)/);
  });

  it("keeps the SQL cascade in the repo, chat artifacts included", () => {
    const sql = read("migrations/20260811_delete_profile_cascade_v3.sql");
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.delete_profile_cascade/);
    expect(sql).toMatch(/DELETE FROM chat_artifacts/);
    // The same primary-owner refusal, one layer lower.
    expect(sql).toMatch(/IF v_type = 'self' THEN/);
    // Every table the TypeScript fallback sweeps must appear here too.
    for (const table of [
      "trackers", "tracker_entries", "expenses", "tasks", "habits", "events",
      "documents", "artifacts", "goals", "incomes", "journal_entries",
      "entity_links", "asset_party_links", "liability_profile_links",
      "liability_asset_links", "profiles",
    ]) {
      expect(sql).toContain(table);
    }
  });
});
