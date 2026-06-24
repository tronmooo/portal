import { describe, it, expect } from "vitest";
import { pickTrackerForLog } from "../server/ai-engine";

// Regression guard for the "Chess (2)" bug: logging to an existing tracker must
// reuse it (or adopt an orphan), never silently clone into a numbered copy.
describe("pickTrackerForLog", () => {
  const SELF = "self-id";
  const OTHER = "other-id";

  it("returns nothing to adopt when there are no name matches", () => {
    expect(pickTrackerForLog([], SELF)).toEqual({ tracker: undefined, clone: false });
  });

  it("uses a tracker already linked to the target profile", () => {
    const t = { id: "a", linkedProfiles: [SELF] };
    expect(pickTrackerForLog([t], SELF)).toEqual({ tracker: t, clone: false });
  });

  it("ADOPTS an orphan tracker (no linkedProfiles) instead of cloning — the Chess (2) fix", () => {
    const orphan = { id: "chess", linkedProfiles: [] as string[] };
    expect(pickTrackerForLog([orphan], SELF)).toEqual({ tracker: orphan, clone: false });
  });

  it("adopts an orphan with undefined linkedProfiles", () => {
    const orphan = { id: "chess" } as { linkedProfiles?: string[] };
    expect(pickTrackerForLog([orphan], SELF)).toEqual({ tracker: orphan, clone: false });
  });

  it("prefers a target-owned tracker over an orphan when both exist", () => {
    const orphan = { id: "orphan", linkedProfiles: [] as string[] };
    const owned = { id: "owned", linkedProfiles: [SELF] };
    expect(pickTrackerForLog([orphan, owned], SELF)).toEqual({ tracker: owned, clone: false });
  });

  it("clones only when every match belongs to a DIFFERENT profile", () => {
    const othersOnly = { id: "bobchess", linkedProfiles: [OTHER] };
    expect(pickTrackerForLog([othersOnly], SELF)).toEqual({ tracker: undefined, clone: true });
  });

  it("does not clone when an other-owned AND an orphan match exist (adopts the orphan)", () => {
    const other = { id: "bob", linkedProfiles: [OTHER] };
    const orphan = { id: "orphan", linkedProfiles: [] as string[] };
    expect(pickTrackerForLog([other, orphan], SELF)).toEqual({ tracker: orphan, clone: false });
  });
});
