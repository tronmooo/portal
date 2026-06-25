import { describe, it, expect } from "vitest";
import { inferTrackerShape, effectiveTrackerFields } from "@shared/tracker-shapes";
import { classifyTrackerPresentation } from "@shared/tracker-presentation";

// Root-cause guard for the "Fish Oil → qt" bug: a bare "oil" pattern was
// matching "Fish Oil" and assigning motor-oil quarts. Health-domain dose items
// must always resolve to the medication/adherence shape, never a vehicle shape.
describe("inferTrackerShape — domain collisions", () => {
  it("Fish Oil resolves to a dose shape, NOT motor-oil quarts", () => {
    const fields = inferTrackerShape("Fish Oil", "supplement");
    expect(fields).toBeTruthy();
    const names = (fields || []).map((f) => f.name);
    expect(names).toContain("dosage");
    expect(names).toContain("adherence");
    // The motor-oil "quarts (qt)" field must NOT be present.
    expect(names).not.toContain("quarts");
    expect((fields || []).some((f) => f.unit === "qt")).toBe(false);
  });

  it("Fish Oil with no category still avoids the oil_change shape", () => {
    const fields = inferTrackerShape("Fish Oil");
    const names = (fields || []).map((f) => f.name);
    expect(names).not.toContain("quarts");
  });

  it("Multivitamin resolves to a dose shape", () => {
    const fields = inferTrackerShape("Multivitamin", "supplement");
    expect((fields || []).map((f) => f.name)).toContain("dosage");
  });

  it("Amoxicillin (prescription) resolves to a medication shape", () => {
    const fields = inferTrackerShape("Amoxicillin", "medication");
    expect(fields).toBeTruthy();
    const names = (fields || []).map((f) => f.name);
    expect(names).toContain("dosage");
    expect(names).toContain("adherence");
  });

  it("an actual oil change still gets quarts (qt)", () => {
    const fields = inferTrackerShape("Oil Change", "vehicle");
    const names = (fields || []).map((f) => f.name);
    expect(names).toContain("quarts");
    expect((fields || []).find((f) => f.name === "quarts")?.unit).toBe("qt");
  });
});

// The whole point: every dose item presents as an adherence tracker (no
// physical-quantity unit), consistently, regardless of wording.
describe("dose items present as adherence (consistent units)", () => {
  for (const name of ["Fish Oil", "Multivitamin", "Amoxicillin", "Vitamin D"]) {
    it(`${name} → adherence with empty physical unit`, () => {
      const fields = effectiveTrackerFields(name, name === "Amoxicillin" ? "medication" : "supplement", undefined, undefined);
      const pres = classifyTrackerPresentation({ name, category: "supplement", fields } as any);
      expect(pres.metricKind).toBe("adherence");
      expect(pres.unit).toBe("");
    });
  }
});
