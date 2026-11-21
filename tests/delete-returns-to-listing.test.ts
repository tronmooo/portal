// Deleting a profile returns to the list it was IN — the same place its Back
// button goes. (Owner report 2026-11-21: deleting an asset landed on
// `/profiles`, the Info tab, which never listed it.)
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { profileListing } from "../client/src/lib/profile-listing";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("profileListing", () => {
  it.each(["asset", "vehicle", "property", "investment"])("%s is listed under Assets", (type) => {
    expect(profileListing(type)).toEqual({ href: "/linked?tab=assets", label: "Back to Assets" });
  });
  it.each(["subscription", "insurance", "loan"])("%s is listed under Linked", (type) => {
    expect(profileListing(type).href).toBe("/linked");
  });
  it.each(["person", "pet", "self", "", undefined])("%s is listed under Profiles", (type) => {
    expect(profileListing(type as any).href).toBe("/profiles");
  });
});

describe("the profile page", () => {
  const src = read("client/src/pages/profile-detail.tsx");
  const del = src.slice(src.indexOf("const deleteMutation = useMutation({"), src.indexOf("const deleteMutation = useMutation({") + 900);

  it("returns to the profile's own listing after a delete", () => {
    expect(del).toContain("hashNavigate(profileListing(profile?.type).href)");
    expect(del).not.toContain('navigate("/profiles")');
  });

  it("uses the same rule for its Back button", () => {
    expect(src).toContain("const { href: backHref, label: backLabel } = profileListing(profile.type);");
  });
});

describe("the liability page", () => {
  it("returns to the Liabilities list (rule L7)", () => {
    expect(read("client/src/pages/liability-detail.tsx")).toContain('navigate("/linked?tab=liabilities")');
  });
});
