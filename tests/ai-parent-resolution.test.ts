import { describe, it, expect } from "vitest";
import { resolveProfileByName } from "../server/ai-engine";

// Lightweight mocks: only `name` matters for resolution.
type P = { id: string; name: string };

const profiles = (names: string[]): P[] => names.map((n, i) => ({ id: `id-${i}`, name: n }));

describe("resolveProfileByName", () => {
  it("returns 'none' when nothing matches", () => {
    const r = resolveProfileByName(profiles(["Home", "Garage"]), "Computer");
    expect(r.kind).toBe("none");
  });

  it("returns 'found' for an exact case-insensitive match", () => {
    const r = resolveProfileByName(profiles(["Home", "Computer"]), "computer");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Computer");
  });

  it("returns 'found' for a single word-boundary match", () => {
    const r = resolveProfileByName(profiles(["Gaming Computer", "Home"]), "computer");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Gaming Computer");
  });

  // User-spec: "two computers existing should make it ask"
  it("returns 'ambiguous' when two computers exist with the same name length", () => {
    const r = resolveProfileByName(
      profiles(["Computer A", "Computer B"]), // both 10 chars
      "computer",
    );
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches).toHaveLength(2);
      expect(r.matches.map(m => m.name).sort()).toEqual(["Computer A", "Computer B"]);
    }
  });

  // #4 (2026-06-25): a bare "Honda" matching two vehicles must NOT silently
  // resolve to one and overwrite it — "Honda CR-V" overwrote "Honda HR-V".
  it("returns 'ambiguous' for a make that matches two vehicles", () => {
    const r = resolveProfileByName(profiles(["Honda HR-V", "Honda CR-V"]), "Honda");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches.map(m => m.name).sort()).toEqual(["Honda CR-V", "Honda HR-V"]);
    }
  });

  it("still resolves the exact model name unambiguously", () => {
    const r = resolveProfileByName(profiles(["Honda HR-V", "Honda CR-V"]), "Honda CR-V");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Honda CR-V");
  });

  it("returns 'none' (never a wrong match) when the named model doesn't exist", () => {
    // Only "Honda HR-V" exists; "Honda CR-V" must not silently match it.
    const r = resolveProfileByName(profiles(["Honda HR-V"]), "Honda CR-V");
    expect(r.kind).toBe("none");
  });

  it("prefers exact match over word-boundary match (even longer ones)", () => {
    // "Computer" is an EXACT match for "computer" and short-circuits.
    // Even though "Gaming Desktop Computer" also contains the word
    // "computer", the exact match wins because it's unambiguous.
    const r = resolveProfileByName(
      profiles(["Gaming Desktop Computer", "Computer"]),
      "computer",
    );
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Computer");
  });

  it("prefers the more specific name when none is an exact match", () => {
    // Neither name is exactly "PC"; both contain "PC" as a word. The
    // materially longer one (>=2 chars longer) wins.
    const r = resolveProfileByName(
      profiles(["Gaming PC Setup", "PC Bob"]),
      "PC",
    );
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Gaming PC Setup");
  });

  it("handles empty/whitespace input gracefully", () => {
    expect(resolveProfileByName(profiles(["A"]), "").kind).toBe("none");
    expect(resolveProfileByName(profiles(["A"]), "   ").kind).toBe("none");
    expect(resolveProfileByName(profiles(["A"]), null).kind).toBe("none");
    expect(resolveProfileByName(profiles(["A"]), undefined).kind).toBe("none");
  });

  // User-spec: "Resolving a parent chain across two levels"
  it("can resolve a deep child by exact name (e.g. 'Mouse' in Home > Computer > Mouse)", () => {
    const r = resolveProfileByName(
      profiles(["Home", "Computer", "Mouse"]),
      "mouse",
    );
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Mouse");
  });

  it("doesn't fuzz-match unrelated names (regex special chars escaped)", () => {
    const r = resolveProfileByName(profiles(["Home (Main)", "Other"]), "Home (Main)");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.profile.name).toBe("Home (Main)");
  });
});
