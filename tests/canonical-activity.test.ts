// Pins canonical tracker resolution (shared/canonical-activity.ts): unit and
// phrasing variants of the same activity must land on ONE tracker instead of
// spawning "Walking Distance" / "Steps Walked" / "Daily Walk" duplicates.
import { describe, it, expect } from "vitest";
import { resolveCanonicalActivity } from "@shared/canonical-activity";

describe("resolveCanonicalActivity", () => {
  it("maps every walking variant to the canonical Walking tracker", () => {
    for (const name of ["Walking Distance", "Walking Miles", "Steps Walked", "Daily Walk", "Walking Activity", "walk", "walked", "went for a walk", "Steps", "stroll"]) {
      expect(resolveCanonicalActivity(name)?.trackerName, name).toBe("Walking");
    }
  });

  it("maps running variants to Running (and beats the walking pattern)", () => {
    for (const name of ["Running", "run", "Morning Jog", "jogging", "ran"]) {
      expect(resolveCanonicalActivity(name)?.trackerName, name).toBe("Running");
    }
  });

  it("maps hydration and sleep variants", () => {
    expect(resolveCanonicalActivity("Water Intake")?.trackerName).toBe("Hydration");
    expect(resolveCanonicalActivity("water")?.trackerName).toBe("Hydration");
    expect(resolveCanonicalActivity("Sleep")?.trackerName).toBe("Sleep");
    expect(resolveCanonicalActivity("napped")?.trackerName).toBe("Sleep");
  });

  it("does not hijack different domains that share a keyword", () => {
    expect(resolveCanonicalActivity("Plant Watering")).toBeNull();
    expect(resolveCanonicalActivity("Dog Walking")).toBeNull();
    expect(resolveCanonicalActivity("Soccer")).toBeNull();
    expect(resolveCanonicalActivity("Cannabis")).toBeNull();
    expect(resolveCanonicalActivity("Guitar Practice")).toBeNull();
    expect(resolveCanonicalActivity("")).toBeNull();
  });
});
