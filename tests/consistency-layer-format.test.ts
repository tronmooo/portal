// Consistency layer — human-readable formatting, no raw ids (req. tests 19, 20).
import { describe, expect, it } from "vitest";
import { humanizeLabel, formatUserDate, formatFieldValue, stripInternalIds, containsInternalId, looksLikeInternalId, displayName } from "../shared/domain";

describe("19. Raw database IDs never appear in normal UI responses", () => {
  const id = "9c8249b8-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  it("a reply mentioning ids is scrubbed, and the detector catches every shape", () => {
    const reply = `Your Auto Loan (id:9c8249b8) [id:${id}] balance is $48,000. Document sha256:9c8249b8ab.`;
    expect(containsInternalId(reply)).toBe(true);
    const clean = stripInternalIds(reply);
    expect(containsInternalId(clean)).toBe(false);
    expect(clean).toBe("Your Auto Loan balance is $48,000. Document.");
    expect(looksLikeInternalId(id)).toBe(true);
    expect(looksLikeInternalId("Auto Loan")).toBe(false);
    expect(displayName({ name: id, title: "Auto Loan" })).toBe("Auto Loan");
    expect(displayName({ id })).toBe("Untitled");
  });
});

describe("20. Internal enum names are converted to readable labels", () => {
  it("snake_case, camelCase and ISO dates pass through the formatting layer", () => {
    expect(humanizeLabel("home_insurance_declarations")).toBe("Home Insurance Declarations");
    expect(humanizeLabel("drivers_license")).toBe("Drivers License");
    expect(humanizeLabel("high_value_item")).toBe("High-value item"); // curated label survives
    expect(formatUserDate("2026-09-25")).toBe("Sep 25, 2026");
    expect(formatUserDate("2026-09-25", "MDY")).toBe("09/25/2026");
    expect(formatUserDate("2026-09-25", "DMY")).toBe("25/09/2026");
    expect(formatFieldValue("dueDate", "2026-09-25")).toBe("Sep 25, 2026");
    expect(formatFieldValue("documentType", "medical_report")).toBe("Medical Report");
  });
});
