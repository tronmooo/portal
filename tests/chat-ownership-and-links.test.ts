// Two chat ownership defects (chat-tools scenarios on the preview, 2026-11-28):
// - "Add Robin as a co-owner of my drone with a 40% share" never worked on the
//   first message (0 of 7): 40% was added on top of an existing 100% owner.
// - "Link the task … to Kin" made a link row while the task stayed filed under
//   the account holder (3 of 7), and the reply said it was linked.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { withOwnerShare } from "../shared/owner-share";

const sum = (xs: { ownershipPercentage: number }[]) => Math.round(xs.reduce((s, x) => s + x.ownershipPercentage, 0) * 100) / 100;
const of = (xs: { partyProfileId: string; ownershipPercentage: number }[], id: string) => xs.find((x) => x.partyProfileId === id)?.ownershipPercentage;

describe("giving one owner a share", () => {
  it("me 100% + Robin 40% → me 60%, Robin 40%", () => {
    const out = withOwnerShare([{ partyProfileId: "me", ownershipPercentage: 100 }], "robin", 40, "me");
    expect(of(out, "robin")).toBe(40); expect(of(out, "me")).toBe(60); expect(sum(out)).toBe(100);
  });
  it("the others keep their proportions of what is left", () => {
    const out = withOwnerShare([{ partyProfileId: "me", ownershipPercentage: 50 }, { partyProfileId: "sam", ownershipPercentage: 50 }], "robin", 40, "me");
    expect(of(out, "me")).toBe(30); expect(of(out, "sam")).toBe(30); expect(of(out, "robin")).toBe(40);
  });
  it("changing an existing owner's share rescales only the others", () => {
    const out = withOwnerShare([{ partyProfileId: "me", ownershipPercentage: 70 }, { partyProfileId: "robin", ownershipPercentage: 30 }], "robin", 50, "me");
    expect(of(out, "me")).toBe(50); expect(of(out, "robin")).toBe(50);
  });
  it("nobody stored yet: the account holder owns the rest", () => {
    const out = withOwnerShare([], "robin", 25, "me");
    expect(of(out, "me")).toBe(75); expect(of(out, "robin")).toBe(25);
  });
  it("always totals exactly 100, even with thirds", () => {
    for (const pct of [10, 33.33, 40, 66.67, 99.99]) {
      const out = withOwnerShare([{ partyProfileId: "a", ownershipPercentage: 33.33 }, { partyProfileId: "b", ownershipPercentage: 33.33 }, { partyProfileId: "c", ownershipPercentage: 33.34 }], "d", pct, "a");
      expect(sum(out), String(pct)).toBe(100);
    }
  });
  it("100% for the new person leaves only them", () => {
    expect(withOwnerShare([{ partyProfileId: "me", ownershipPercentage: 100 }], "robin", 100, "me")).toEqual([{ partyProfileId: "robin", ownershipPercentage: 100 }]);
  });
});

describe("the chat tools", () => {
  const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
  it("link_asset_owner rewrites the owner set whole for an ownership share", () => {
    const body = src.slice(src.lastIndexOf('case "link_asset_owner": {'), src.lastIndexOf('case "split_ownership": {'));
    expect(body).toContain("withOwnerShare(");
    expect(body).toContain("storage.setAssetOwners(asset.id, next)");
    expect(body).toContain("Do not say it was.");
  });
  it("link_entities files a single-owner record under the person, and never confirms a link that did not land", () => {
    const body = src.slice(src.lastIndexOf('case "link_entities": {'), src.lastIndexOf('case "get_related":'));
    expect(body).toMatch(/recordSide\.type === "task" \|\| recordSide\.type === "expense" \|\| recordSide\.type === "event"/);
    expect(body).toContain("linkedProfiles: [recordSide.person]");
    expect(body).toContain("Do not say it was linked.");
  });
});
