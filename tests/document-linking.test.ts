// #3 (2026-06-25): documents can now be re-linked to profiles via chat
// (manage_document link/move/unlink). These pin the link-set semantics so a
// "this belongs to Jane, not Bob" never silently keeps the wrong owner, and a
// "link to her too" never drops the existing owner.
import { describe, it, expect } from "vitest";
import { computeDocProfileLinks } from "../server/ai-engine";

describe("computeDocProfileLinks", () => {
  it("link ADDS owners without dropping existing ones (union, deduped)", () => {
    expect(computeDocProfileLinks(["bob"], "link", ["jane"]).sort()).toEqual(["bob", "jane"]);
    expect(computeDocProfileLinks(["bob"], "link", ["bob"])).toEqual(["bob"]); // no dup
  });

  it("move REPLACES with exactly the named owners ('belongs to Jane, not Bob')", () => {
    expect(computeDocProfileLinks(["bob"], "move", ["jane"])).toEqual(["jane"]);
    expect(computeDocProfileLinks(["everyone", "bob"], "move", ["jane"])).toEqual(["jane"]);
  });

  it("unlink REMOVES the named owner ('remove shared visibility')", () => {
    expect(computeDocProfileLinks(["bob", "jane"], "unlink", ["bob"])).toEqual(["jane"]);
    expect(computeDocProfileLinks(["bob"], "unlink", ["bob"])).toEqual([]);
  });

  it("handles a missing/empty current link list", () => {
    expect(computeDocProfileLinks(null, "link", ["jane"])).toEqual(["jane"]);
    expect(computeDocProfileLinks(undefined, "move", ["jane"])).toEqual(["jane"]);
    expect(computeDocProfileLinks(null, "unlink", ["jane"])).toEqual([]);
  });
});
