// Every asset TYPE gets curated detail groups on its Overview.
//
// Reported from the live app: a Roth IRA's profile Overview was blank. The
// cause was FIELD_GROUPS having no entry for `investment` (nor `account`), so
// `groups` resolved to [] and every field fell into the "Other (N)" catch-all
// — which renders COLLAPSED. The account existed, its fields existed, and the
// page showed none of them.
//
// A source read rather than a render: profile-detail.tsx is ~14k lines behind
// a lazy route with a dozen queries, and what's being asserted is which keys
// the map declares — exactly what a parse can see.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(
  path.resolve(__dirname, "..", "client/src/pages/profile-detail.tsx"), "utf8",
);

/** The FIELD_GROUPS object literal, as text. */
const fieldGroupsBlock = (() => {
  const i = src.indexOf("const FIELD_GROUPS");
  expect(i, "FIELD_GROUPS not found").toBeGreaterThan(-1);
  const j = src.indexOf("\n};", i);
  return src.slice(i, j);
})();

/** Top-level keys of FIELD_GROUPS, in declaration order. */
const declaredTypes = [...fieldGroupsBlock.matchAll(/^ {2}(\w+):\s*\[/gm)].map(m => m[1]);

/** The field keys declared under one type. */
function keysFor(type: string): string[] {
  const start = fieldGroupsBlock.indexOf(`\n  ${type}: [`);
  if (start < 0) return [];
  const rest = fieldGroupsBlock.slice(start + 1);
  const end = rest.search(/\n {2}\w+:\s*\[/);
  const seg = end < 0 ? rest : rest.slice(0, end);
  return [...seg.matchAll(/key:\s*"([^"]+)"/g)].map(m => m[1]);
}

describe("every first-class asset type has curated detail groups", () => {
  it("covers the types a profile page can open with", () => {
    for (const type of ["vehicle", "property", "investment", "account", "asset", "loan", "subscription", "person", "pet"]) {
      expect(keysFor(type).length, `FIELD_GROUPS has no entry for "${type}" — its fields fall into the collapsed "Other" bucket`)
        .toBeGreaterThan(0);
    }
  });

  it("declares no type twice — the later literal silently wins", () => {
    const dupes = declaredTypes.filter((t, i) => declaredTypes.indexOf(t) !== i);
    expect(dupes, `duplicate FIELD_GROUPS keys: ${dupes.join(", ")}`).toEqual([]);
  });

  it("gives an investment account the fields that describe one", () => {
    const keys = keysFor("investment");
    for (const k of ["institution", "accountType", "balance", "currentValue"]) {
      expect(keys, `investment is missing "${k}"`).toContain(k);
    }
  });

  it("gives a property the fields that describe one", () => {
    const keys = keysFor("property");
    for (const k of ["address", "bedrooms", "bathrooms", "yearBuilt", "currentValue", "propertyType"]) {
      expect(keys, `property is missing "${k}"`).toContain(k);
    }
  });

  it("gives a vehicle the fields that describe one", () => {
    const keys = keysFor("vehicle");
    for (const k of ["make", "model", "year", "vin"]) {
      expect(keys, `vehicle is missing "${k}"`).toContain(k);
    }
  });

  it("renders genuinely different fields per type, not one generic list", () => {
    const vehicle = new Set(keysFor("vehicle"));
    const property = new Set(keysFor("property"));
    const investment = new Set(keysFor("investment"));
    // Each type owns keys the others don't.
    expect([...vehicle].some(k => !property.has(k) && !investment.has(k))).toBe(true);
    expect([...property].some(k => !vehicle.has(k) && !investment.has(k))).toBe(true);
    expect([...investment].some(k => !vehicle.has(k) && !property.has(k))).toBe(true);
  });
});

describe("no redundancy on an account's Overview", () => {
  it("the account field group does NOT restate what the account card shows", () => {
    // AccountOverview renders balance / available / limit / institution /
    // as-of in a kind-aware layout. Declaring them again here would print the
    // same number twice on one screen.
    const keys = keysFor("account");
    for (const k of ["balance", "currentBalance", "availableBalance", "creditLimit", "institution", "balanceAsOf"]) {
      expect(keys, `"account" group restates "${k}", which AccountOverview already renders`)
        .not.toContain(k);
    }
  });

  it("suppresses the account card's keys from the Other catch-all too", () => {
    // Otherwise every one of them reappears under "Other (N)".
    expect(src).toContain("ACCOUNT_CARD_KEYS");
    expect(src).toContain("hiddenByAccountCard");
    const i = src.indexOf("const ACCOUNT_CARD_KEYS");
    const seg = src.slice(i, i + 900);
    for (const k of ["balance", "creditLimit", "availableBalance", "institution", "balanceAsOf", "balanceHistory"]) {
      expect(seg, `ACCOUNT_CARD_KEYS is missing "${k}"`).toContain(`"${k}"`);
    }
  });

  it("drops the header value row on an account — the hero and card both show it", () => {
    expect(src).toContain("keyValueEntry && !isAccountProfile(profile)");
  });
});
