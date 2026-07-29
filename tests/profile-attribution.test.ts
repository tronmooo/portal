// Owner attribution — "it went to the account owner instead of the profile I
// picked" (user QA 2026-07-27: notes, medication, liability, expense move).
//
// Every one of those came from the same shape:
//
//     const p = matchProfileByName(profiles, input.forProfile);
//     if (p) link(p.id);        // …and silently nothing when it didn't match
//
// An unresolvable name produced an UNLINKED record, which the app displays
// under the account owner. Two of the sites were worse than that: create_tracker
// compared names with an EXACT lowercase string equality and then fell through
// to self, and create_liability used a bare `.includes()` that happily picks
// the first profile merely CONTAINING the string.
//
// These tests pin the resolver's contract: exact wins, word-boundary matches,
// ambiguity asks, and an unknown name refuses rather than guessing.
import { describe, it, expect } from "vitest";
import { resolveProfileByName } from "../server/ai-engine";

const P = (id: string, name: string, type = "person") => ({ id, name, type });

describe("resolveProfileByName — the matcher every ownership site now shares", () => {
  const profiles = [
    P("self", "Me", "self"),
    P("rex", "Rex", "pet"),
    P("bob", "Bob"),
    P("bobby", "Bobby"),
    P("hrv", "Honda HR-V", "vehicle"),
    P("crv", "Honda CR-V", "vehicle"),
  ];

  it("matches an exact name regardless of case or padding", () => {
    for (const q of ["Rex", "rex", "  REX  "]) {
      const r = resolveProfileByName(profiles, q);
      expect(r.kind, `query ${JSON.stringify(q)}`).toBe("found");
      expect((r as any).profile.id).toBe("rex");
    }
  });

  it("does NOT let a substring swallow a different profile", () => {
    // "Bob" must not resolve to "Bobby" — the exact match wins outright.
    const r = resolveProfileByName(profiles, "Bob");
    expect(r.kind).toBe("found");
    expect((r as any).profile.id).toBe("bob");
  });

  it("asks instead of guessing when a partial name fits several profiles", () => {
    // The "Honda" case: silently picking one would overwrite the wrong vehicle.
    const r = resolveProfileByName(profiles, "Honda");
    expect(r.kind).toBe("ambiguous");
    expect((r as any).matches.map((m: any) => m.id).sort()).toEqual(["crv", "hrv"]);
  });

  it("reports no match rather than falling back to the account owner", () => {
    // This is the whole bug: "none" used to mean "link nothing", and a record
    // with no links renders under the owner.
    expect(resolveProfileByName(profiles, "Luna").kind).toBe("none");
    expect(resolveProfileByName(profiles, "").kind).toBe("none");
  });

  it("never silently returns the self profile for an unknown name", () => {
    const r = resolveProfileByName(profiles, "Somebody Else");
    expect(r.kind).toBe("none");
    expect((r as any).profile).toBeUndefined();
  });
});

describe("the ownership sites no longer contain the silent-skip shape", () => {
  // A source guard: the fix is only durable if the pattern can't creep back.
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "server/ai-engine.ts"), "utf8");

  it("create_tracker resolves the owner strictly instead of exact-match-then-self", () => {
    expect(src).not.toContain(
      'const match = ctProfiles.find(p => p.name.toLowerCase() === (input.forProfile || "").toLowerCase());');
    expect(src).toContain('resolveOwnerOrError(ctProfiles, input.forProfile');
  });

  it("create_document refuses rather than stranding an unlinked note", () => {
    expect(src).toMatch(/resolveOwnerOrError\(profiles, input\.forProfile, `the document/);
  });

  it("create_liability no longer resolves its parent with a bare includes()", () => {
    expect(src).not.toContain('|| profiles.find((p: any) => p.name.toLowerCase().includes(fp));');
  });

  it("a move REPLACES the owner set — no leftover self link", () => {
    // The expense move used to append self "so it stays visible in Finance",
    // which is what left the extra profile link behind.
    expect(src).not.toContain("? [target.id, selfProfile.id]");
    expect(src).toMatch(/changes\.linkedProfiles = \[owner\.profile\.id\];/);
  });

  it("update_profile actually applies a rename", () => {
    // changes.name was never read, so every rename was silently dropped.
    expect(src).toContain("if (input.changes.name !== undefined) {");
    expect(src).toContain("changes.name = newName;");
  });

  it("a rename that would duplicate an existing profile name asks first", () => {
    expect(src).toMatch(/already exists, so renaming/);
  });
});

describe("delete claims are checked, not asserted", () => {
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "server/ai-engine.ts"), "utf8");
  const storageSrc = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "server/supabase-storage.ts"), "utf8");

  it("delete_profile sweeps for survivors and reports them", () => {
    expect(src).toContain("orphansRemaining");
    expect(src).toMatch(/do NOT say everything was deleted/);
  });

  it("the non-transactional cascade covers obligations like the RPC does", () => {
    // A liability auto-creates a backing obligation; the fallback path used to
    // skip the obligations table entirely, leaking it on every delete.
    expect(storageSrc).toContain('cascadeSharedTable("obligations", "obligations", allObligations as any)');
    // Scope the "retired" claim check to deleteProfile — two unrelated feed
    // helpers still carry that comment and are a display decision, not a leak.
    const del = storageSrc.slice(storageSrc.indexOf("async deleteProfile("));
    const body = del.slice(0, del.indexOf("\n  async ", 10));
    expect(body).not.toContain("Obligations retired");
    expect(body).toContain("allObligations");
  });
});

describe("the reminder→calendar mirror reports what actually happened", () => {
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "server/ai-engine.ts"), "utf8");

  it("no longer lets an in-memory dedup lock silently skip the calendar entry", () => {
    expect(src).toContain("The DATABASE is the duplicate authority");
  });

  it("surfaces a mirror failure instead of claiming it was added", () => {
    expect(src).toContain("calendarWarning");
    expect(src).toMatch(/do not say it was added to the calendar/);
  });

  it("checks the event's wall-clock against the reminder's instant", () => {
    expect(src).toContain("sameMinute");
  });
});
