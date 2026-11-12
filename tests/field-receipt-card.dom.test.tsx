// @vitest-environment jsdom
//
// The chat's save receipt: a green check ONLY on a line the database read-back
// confirmed (owner spec 2026-11-12: "Never display a green checkmark for
// unverified information").
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FieldReceiptList } from "../client/src/components/chat/FieldReceiptList";
import { buildFieldReceipt } from "../shared/field-receipt";

afterEach(cleanup);

const stored = { id: "c", name: "Honda CR-V", type: "vehicle", fields: { color: "white", mileage: 35000 } };

describe("FieldReceiptList", () => {
  it("shows each field, a check only on verified ones, and where it was saved", () => {
    const receipt = buildFieldReceipt({
      stored, profileId: "c", profileName: "Honda CR-V",
      requestedFields: { color: "white", mileage: 35000, drivetrain: "AWD" },
    });
    render(<FieldReceiptList receipt={receipt} />);
    expect(screen.getByTestId("field-receipt-line-color").getAttribute("data-verified")).toBe("true");
    expect(screen.getByTestId("field-receipt-line-mileage").textContent).toContain("35,000 miles");
    const drive = screen.getByTestId("field-receipt-line-drivetrain");
    expect(drive.getAttribute("data-verified")).toBe("false");
    expect(drive.textContent).toContain("not saved");
    expect(drive.querySelector('[aria-label="verified"]')).toBeNull();
    expect(screen.getByTestId("field-receipt-summary").textContent).toBe("2 of 3 saved · 1 did not save");
    expect(screen.getByTestId("field-receipt-saved-to").textContent).toBe("Saved to: Assets → Vehicles → Honda CR-V");
  });

  it("all verified reads as saved and verified", () => {
    const receipt = buildFieldReceipt({ stored, profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "white" } });
    render(<FieldReceiptList receipt={receipt} />);
    expect(screen.getByTestId("field-receipt-summary").textContent).toBe("Saved and verified · 1 field");
  });
});
