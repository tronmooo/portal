import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  parseStorageMethod,
  targetForStorageMethod,
  STORAGE_NOUN_TARGETS,
  STORAGE_INFRA_METHODS,
} from "@shared/storage-domains";
import type { Domain } from "@shared/entity-domains";

/** Every method declared on the IStorage interface. */
function storageInterfaceMethods(): string[] {
  const src = readFileSync(resolve(__dirname, "../server/storage.ts"), "utf8");
  const start = src.indexOf("export interface IStorage {");
  expect(start).toBeGreaterThan(-1);
  // Walk to the interface's closing brace at column 0.
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\??\(/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/** Domains the client cache bus knows how to expand. */
function busDomains(): Set<string> {
  const src = readFileSync(resolve(__dirname, "../client/src/lib/cache-bus.ts"), "utf8");
  const start = src.indexOf("const DOMAIN_KEYS");
  const end = src.indexOf("\n};", start);
  const found = new Set<string>();
  for (const line of src.slice(start, end).split("\n")) {
    const m = /^\s{2}([a-zA-Z]+):\s*\[/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

describe("storage method → domain coverage", () => {
  const methods = storageInterfaceMethods();

  it("finds the storage interface", () => {
    expect(methods.length).toBeGreaterThan(100);
    expect(methods).toContain("createLiabilityPayment");
  });

  it("classifies every write-shaped method on IStorage", () => {
    // The guarantee this file exists for: adding a write to the storage
    // interface without saying what it changes fails here, instead of shipping
    // a mutation whose effects never reach a screen. The failure message names
    // the noun to add to STORAGE_NOUN_TARGETS.
    const unmapped: string[] = [];
    for (const name of methods) {
      if (STORAGE_INFRA_METHODS.has(name)) continue;
      const parsed = parseStorageMethod(name);
      if (!parsed) continue;                       // not a write verb — a read
      if (!STORAGE_NOUN_TARGETS[parsed.noun]) unmapped.push(`${name} (noun: ${parsed.noun})`);
    }
    expect(unmapped).toEqual([]);
  });

  it("only expands to domains the cache bus can actually invalidate", () => {
    const known = busDomains();
    expect(known.size).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const [noun, target] of Object.entries(STORAGE_NOUN_TARGETS)) {
      for (const d of target.domains as Domain[]) {
        if (!known.has(d)) bad.push(`${noun} → ${d}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("names only real API endpoints", () => {
    for (const [noun, target] of Object.entries(STORAGE_NOUN_TARGETS)) {
      if (target.endpoint == null) continue;
      expect(target.endpoint, noun).toMatch(/^\/api\/[a-z-]+$/);
    }
  });

  it("treats reads as reads", () => {
    for (const name of ["getProfiles", "getStats", "getDashboardEnhanced", "getLiabilityPayments"]) {
      expect(targetForStorageMethod(name), name).toBeNull();
    }
  });

  it("routes a liability write into every domain that renders one", () => {
    // Assets and liabilities are profile ROWS, not separate tables. A write to
    // one that didn't ripple into all four is how "changed a car's value, the
    // assets list didn't move" happens.
    const t = targetForStorageMethod("updateProfile")!;
    expect(t.domains).toEqual(expect.arrayContaining(["profiles", "assets", "liabilities", "people"]));
  });
});
