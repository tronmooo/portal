// Regression tests for the asset/liability/subscription classification rules.
//
// Two invariants are locked here so the bugs they encode can never return:
//
//  1. SUBSCRIPTION-IS-NEVER-AN-ASSET (BUG-NW-1, 2026-06-03).
//     Subscriptions are recurring obligations, not balance-sheet items. A
//     subscription profile carries a `cost` field that resolveAssetValue would
//     happily read as a positive value, so the ONLY thing keeping it out of net
//     worth is that "subscription" is absent from ASSET_PROFILE_TYPES /
//     LIABILITY_PROFILE_TYPES. This test pins that contract at the shared layer
//     (isAssetProfile / computeNetWorth), the single source of truth every
//     surface routes through.
//
//  2. NO-DIVERGENT-TYPE-SET-COPIES.
//     The server dashboard (server/supabase-storage.ts) used to inline its own
//     hardcoded copies of the asset/liability profile-type sets — six of them.
//     Identical to the canonical sets at the time, but free to drift. They were
//     consolidated to import ASSET_PROFILE_TYPES / LIABILITY_PROFILE_TYPES from
//     shared/asset-value.ts. This guard fails the build if any production file
//     re-introduces a literal copy of those exact sets, forcing future code to
//     use the shared constant instead.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import {
  ASSET_PROFILE_TYPES,
  LIABILITY_PROFILE_TYPES,
  isAssetProfile,
  isLiabilityProfile,
} from "@shared/asset-value";
import { computeNetWorth } from "@shared/net-worth";

describe("classification: subscriptions are never assets or liabilities (BUG-NW-1)", () => {
  it("subscription is absent from both canonical type sets", () => {
    expect(ASSET_PROFILE_TYPES.has("subscription")).toBe(false);
    expect(LIABILITY_PROFILE_TYPES.has("subscription")).toBe(false);
  });

  it("a subscription profile with a cost field is neither asset nor liability", () => {
    const sub = {
      id: "11111111-1111-1111-1111-111111111111",
      type: "subscription",
      name: "Netflix Premium",
      fields: { cost: 22.99, frequency: "monthly", provider: "Netflix" },
    };
    expect(isAssetProfile(sub)).toBe(false);
    expect(isLiabilityProfile(sub)).toBe(false);
  });

  it("computeNetWorth ignores a subscription's cost entirely", () => {
    const sub = {
      id: "22222222-2222-2222-2222-222222222222",
      type: "subscription",
      name: "Spotify",
      // every field resolveAssetValue would otherwise latch onto:
      fields: { cost: 11.99, amount: 11.99, price: 11.99, value: 11.99 },
    };
    const result = computeNetWorth([sub], { mode: "everyone", selectedIds: [] });
    expect(result.assets).toBe(0);
    expect(result.liabilities).toBe(0);
    expect(result.netWorth).toBe(0);
    expect(result.assetProfiles).toHaveLength(0);
  });

  it("a real asset alongside a subscription counts only the asset", () => {
    const asset = {
      id: "33333333-3333-3333-3333-333333333333",
      type: "asset",
      name: "Savings",
      fields: { currentValue: 5000 },
    };
    const sub = {
      id: "44444444-4444-4444-4444-444444444444",
      type: "subscription",
      name: "iCloud",
      fields: { cost: 2.99 },
    };
    const result = computeNetWorth([asset, sub], { mode: "everyone", selectedIds: [] });
    expect(result.assets).toBe(5000);
    expect(result.netWorth).toBe(5000);
  });
});

describe("classification: no divergent copies of the type sets", () => {
  // The exact literal forms that used to live inline in the dashboard code.
  const FORBIDDEN = [
    /new Set\(\[\s*"vehicle",\s*"asset",\s*"investment",\s*"property",\s*"loan",\s*"account"\s*\]\)/,
    /new Set\(\[\s*"liability",\s*"loan",\s*"vehicle",\s*"property",\s*"asset",\s*"account",\s*"investment"\s*\]\)/,
  ];

  const REPO_ROOT = path.resolve(__dirname, "..");
  const SCAN_DIRS = ["server", "client/src", "shared"].map((d) => path.join(REPO_ROOT, d));

  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (["node_modules", "dist", ".next", "build"].includes(entry)) continue;
        walk(p, out);
      } else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
        out.push(p);
      }
    }
    return out;
  }

  it("no production source re-inlines the canonical asset/liability net-worth type sets", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(d));
    const violations: { file: string; line: number; snippet: string }[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        for (const pat of FORBIDDEN) {
          if (pat.test(line)) {
            violations.push({ file: rel, line: i + 1, snippet: trimmed.slice(0, 160) });
            break;
          }
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  - ${v.file}:${v.line}\n      ${v.snippet}`).join("\n");
      throw new Error(
        `Inlined copy of a canonical net-worth type set found. Import ASSET_PROFILE_TYPES / ` +
          `LIABILITY_PROFILE_TYPES from shared/asset-value.ts instead.\n${msg}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
