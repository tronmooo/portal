import { describe, it, expect } from "vitest";
import {
  resolveOwners,
  shareForParty,
  shareForParties,
  validateOwnership,
  distributeEvenly,
  type OwnershipLink,
} from "../shared/ownership-model";

const SELF = "self-id";
const JOE = "joe-id";
const ME = SELF;

describe("resolveOwners — default rules", () => {
  it("defaults to Self at 100% when there are no explicit links", () => {
    const owners = resolveOwners([], SELF);
    expect(owners).toEqual([{ ownerId: SELF, pct: 100, implicit: true }]);
  });

  it("defaults to Self at 100% when links is null/undefined", () => {
    expect(resolveOwners(null, SELF)[0]).toMatchObject({ ownerId: SELF, pct: 100, implicit: true });
    expect(resolveOwners(undefined, SELF)[0]).toMatchObject({ ownerId: SELF, pct: 100, implicit: true });
  });

  it("returns nothing when there is no Self profile and no links", () => {
    expect(resolveOwners([], null)).toEqual([]);
  });

  it("uses explicit owners when assigned (single owner 100%)", () => {
    const links: OwnershipLink[] = [{ partyProfileId: JOE, ownershipPercentage: 100, role: "owner" }];
    expect(resolveOwners(links, SELF)).toEqual([{ ownerId: JOE, pct: 100, implicit: false }]);
  });

  it("NEVER invents 50% — only reflects what was explicitly assigned", () => {
    // The reported bug: two owners both default to 100 and a trigger split them
    // to 50/50. Here a SINGLE explicit owner stays 100, and Self is NOT silently
    // added as a second 50% owner.
    const links: OwnershipLink[] = [{ partyProfileId: JOE, ownershipPercentage: 100, role: "owner" }];
    const owners = resolveOwners(links, SELF);
    expect(owners).toHaveLength(1);
    expect(owners[0].pct).toBe(100);
    expect(shareForParty(ME, links, SELF)).toBe(0); // Me owns 0% — not 50%
    expect(shareForParty(JOE, links, SELF)).toBe(100);
  });

  it("honors a real 50/50 split only when the user assigned it", () => {
    const links: OwnershipLink[] = [
      { partyProfileId: JOE, ownershipPercentage: 50, role: "owner" },
      { partyProfileId: ME, ownershipPercentage: 50, role: "owner" },
    ];
    expect(shareForParty(JOE, links, SELF)).toBe(50);
    expect(shareForParty(ME, links, SELF)).toBe(50);
  });

  it("ignores non-owner roles (co_signer/guarantor) in ownership math", () => {
    const links: OwnershipLink[] = [
      { partyProfileId: JOE, ownershipPercentage: 100, role: "owner" },
      { partyProfileId: ME, ownershipPercentage: 100, role: "co_signer" },
    ];
    expect(resolveOwners(links, SELF)).toEqual([{ ownerId: JOE, pct: 100, implicit: false }]);
    expect(shareForParty(ME, links, SELF)).toBe(0);
  });

  it("merges duplicate owner rows for the same party", () => {
    const links: OwnershipLink[] = [
      { partyProfileId: JOE, ownershipPercentage: 30, role: "owner" },
      { partyProfileId: JOE, ownershipPercentage: 70, role: "owner" },
    ];
    expect(shareForParty(JOE, links, SELF)).toBe(100);
  });
});

describe("shareForParties — dashboard filter scope", () => {
  const split: OwnershipLink[] = [
    { partyProfileId: JOE, ownershipPercentage: 75, role: "owner" },
    { partyProfileId: ME, ownershipPercentage: 25, role: "owner" },
  ];

  it("returns 100% when no filter is applied (everyone)", () => {
    expect(shareForParties([], split, SELF)).toBe(100);
    expect(shareForParties(null, split, SELF)).toBe(100);
  });

  it("returns just the selected party's share", () => {
    expect(shareForParties([JOE], split, SELF)).toBe(75);
    expect(shareForParties([ME], split, SELF)).toBe(25);
  });

  it("sums shares when multiple owners are selected, capped at 100", () => {
    expect(shareForParties([JOE, ME], split, SELF)).toBe(100);
  });

  it("uses the Self default (100%) for an unconfigured asset when Self is selected", () => {
    expect(shareForParties([ME], [], SELF)).toBe(100);
    expect(shareForParties([JOE], [], SELF)).toBe(0); // Joe owns none of an unconfigured asset
  });
});

describe("validateOwnership", () => {
  it("treats zero owners as valid + unconfigured (Self owns 100%)", () => {
    const v = validateOwnership([]);
    expect(v).toMatchObject({ valid: true, configured: false, total: 0 });
  });

  it("accepts owners that total exactly 100%", () => {
    const v = validateOwnership([
      { partyProfileId: JOE, ownershipPercentage: 60, role: "owner" },
      { partyProfileId: ME, ownershipPercentage: 40, role: "owner" },
    ]);
    expect(v).toMatchObject({ valid: true, configured: true, total: 100 });
    expect(v.errors).toHaveLength(0);
  });

  it("rejects totals that are not 100% (the invalid config the user must not be able to save)", () => {
    const v = validateOwnership([
      { partyProfileId: JOE, ownershipPercentage: 100, role: "owner" },
      { partyProfileId: ME, ownershipPercentage: 100, role: "owner" }, // sum 200
    ]);
    expect(v.valid).toBe(false);
    expect(v.total).toBe(200);
    expect(v.errors[0]).toMatch(/total exactly 100/i);
  });

  it("rejects out-of-range percentages", () => {
    const v = validateOwnership([{ partyProfileId: JOE, ownershipPercentage: 150, role: "owner" }]);
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toMatch(/between 0 and 100/i);
  });

  it("rejects duplicate owners", () => {
    const v = validateOwnership([
      { partyProfileId: JOE, ownershipPercentage: 50, role: "owner" },
      { partyProfileId: JOE, ownershipPercentage: 50, role: "owner" },
    ]);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => /more than once/i.test(e))).toBe(true);
  });

  it("accepts a clean 33/33/34 split within epsilon", () => {
    const v = validateOwnership([
      { partyProfileId: "a", ownershipPercentage: 33.33, role: "owner" },
      { partyProfileId: "b", ownershipPercentage: 33.33, role: "owner" },
      { partyProfileId: "c", ownershipPercentage: 33.34, role: "owner" },
    ]);
    expect(v.valid).toBe(true);
  });
});

describe("distributeEvenly — non-destructive suggestion", () => {
  it("splits two owners 50/50", () => {
    expect(distributeEvenly(2)).toEqual([50, 50]);
  });
  it("splits three owners to total exactly 100", () => {
    const split = distributeEvenly(3);
    expect(Math.round(split.reduce((a, b) => a + b, 0))).toBe(100);
    expect(split).toHaveLength(3);
  });
  it("returns [100] for a single owner", () => {
    expect(distributeEvenly(1)).toEqual([100]);
  });
  it("returns [] for zero", () => {
    expect(distributeEvenly(0)).toEqual([]);
  });
});
