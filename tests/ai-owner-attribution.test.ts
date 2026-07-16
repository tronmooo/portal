/**
 * Owner attribution for chat action cards (2026-07-15 user report: "that's
 * Jim's Honda CRV, not mine"). resolveEntityOwner walks nested-asset parent
 * chains so the card badge and the model's phrasing name the REAL owner.
 */
import { describe, it, expect } from "vitest";
import { resolveEntityOwner } from "../server/ai-engine";

const SELF = "self-1";
const profiles = [
  { id: SELF, name: "Me", type: "self", parentProfileId: null },
  { id: "jim", name: "Jim", type: "person", parentProfileId: null },
  { id: "crv", name: "Honda CRV 2021", type: "vehicle", parentProfileId: "jim" },
  { id: "stereo", name: "Stereo", type: "asset", parentProfileId: "crv" },
  { id: "my-car", name: "Tesla", type: "vehicle", parentProfileId: SELF },
  { id: "kayak", name: "Kayak", type: "asset", parentProfileId: null },
  { id: "orphan", name: "New Bike", type: "asset", parentProfileId: "created-this-turn" },
];

describe("resolveEntityOwner", () => {
  it("walks a nested vehicle up to the owning person (Jim's Honda CRV)", () => {
    const o = resolveEntityOwner({ id: "crv" }, profiles, SELF);
    expect(o).toEqual({ id: "jim", name: "Jim", isSelf: false });
  });

  it("walks multi-level chains (stereo → CRV → Jim)", () => {
    expect(resolveEntityOwner({ id: "stereo" }, profiles, SELF)?.name).toBe("Jim");
  });

  it("resolves self-owned items to You", () => {
    const o = resolveEntityOwner({ id: "my-car" }, profiles, SELF);
    expect(o).toEqual({ id: SELF, name: "You", isSelf: true });
  });

  it("treats a parentless standalone asset as the user's own", () => {
    const o = resolveEntityOwner({ id: "kayak" }, profiles, SELF);
    expect(o?.isSelf).toBe(true);
    expect(o?.name).toBe("You");
  });

  it("returns the person directly for person-linked entities", () => {
    expect(resolveEntityOwner({ id: "jim" }, profiles, SELF)?.name).toBe("Jim");
  });

  it("skips attribution when the parent was created in the same turn (unknown)", () => {
    expect(resolveEntityOwner({ id: "orphan" }, profiles, SELF)).toBeNull();
  });

  it("uses the provided start row when the entity itself is not in the list yet", () => {
    const o = resolveEntityOwner(
      { id: "new-trailer", parentProfileId: "jim", type: "asset", name: "Trailer" },
      profiles,
      SELF,
    );
    expect(o?.name).toBe("Jim");
  });

  it("returns null without a start row", () => {
    expect(resolveEntityOwner(undefined, profiles, SELF)).toBeNull();
  });
});
