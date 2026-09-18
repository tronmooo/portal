// QA 2026-09-18 — documents / artifacts / assets cluster (pure logic).
//
//  BUG-12  required registry fields are enforced from the same schema flag
//          that draws the asterisk (shared/registry-fields missingRequiredFields)
//  BUG-30  internal tags (sha256:…, image-discarded, _…) never reach a chip
//  BUG-31  the list's "Format" and the viewer's "no file" card share one
//          predicate (shared/document-file)
import { describe, it, expect } from "vitest";
import { missingRequiredFields } from "../shared/registry-fields";
import {
  documentHasFile, documentFormatLabel, wasFileDiscarded, isInternalDocumentTag, visibleDocumentTags,
  DISCARDED_FILE_TAG, NO_FILE_FORMAT_LABEL, mimeFormatLabel,
} from "../shared/document-file";

// The Savings Account schema from the report: two required fields + optionals.
const SAVINGS_SCHEMA = [
  { key: "institution", label: "Bank / Institution", type: "text", required: true },
  { key: "current_balance", label: "Current Balance", type: "currency", required: true },
  { key: "interest_rate", label: "Interest Rate", type: "percentage" },
  { key: "joint", label: "Joint account", type: "boolean", required: true },
];

describe("BUG-12 missingRequiredFields", () => {
  it("reports every required field left blank, in schema order", () => {
    expect(missingRequiredFields(SAVINGS_SCHEMA, {}).map((f) => f.key))
      .toEqual(["institution", "current_balance", "joint"]);
  });

  it("treats whitespace and empty strings as blank, numbers must parse", () => {
    const missing = missingRequiredFields(SAVINGS_SCHEMA, { institution: "   ", current_balance: "abc", joint: false });
    expect(missing.map((f) => f.key)).toEqual(["institution", "current_balance"]);
  });

  it("passes when the required fields are filled (money punctuation tolerated, false is an answer)", () => {
    expect(missingRequiredFields(SAVINGS_SCHEMA, { institution: "Chase", current_balance: "$1,200.50", joint: false })).toEqual([]);
    expect(missingRequiredFields(SAVINGS_SCHEMA, { institution: "Chase", current_balance: 0, joint: true })).toEqual([]);
  });

  it("ignores optional fields and tolerates a missing schema", () => {
    expect(missingRequiredFields([{ key: "x", type: "text" }], {})).toEqual([]);
    expect(missingRequiredFields(null, { a: 1 })).toEqual([]);
    expect(missingRequiredFields(SAVINGS_SCHEMA, null).length).toBe(3);
  });
});

describe("BUG-31 documentHasFile / documentFormatLabel", () => {
  it("a discarded-photo receipt has no file and says so, even with an image MIME type", () => {
    const row = { mimeType: "image/jpeg", tags: [DISCARDED_FILE_TAG, "receipt"] };
    expect(wasFileDiscarded(row)).toBe(true);
    expect(documentHasFile(row)).toBe(false);
    expect(documentFormatLabel(row)).toBe(NO_FILE_FORMAT_LABEL);
  });

  it("the viewer's hasFile answer is authoritative either way", () => {
    expect(documentHasFile({ mimeType: "image/jpeg", tags: [DISCARDED_FILE_TAG], hasFile: true })).toBe(true);
    expect(documentHasFile({ mimeType: "image/jpeg", hasFile: false })).toBe(false);
    expect(documentFormatLabel({ mimeType: "image/jpeg", hasFile: false })).toBe(NO_FILE_FORMAT_LABEL);
  });

  it("a storage path or inline bytes prove a file exists", () => {
    expect(documentHasFile({ mimeType: "application/pdf", storagePath: "u/doc.pdf" })).toBe(true);
    expect(documentHasFile({ mimeType: "application/pdf", fileData: "JVBERi0=" })).toBe(true);
    expect(documentHasFile({ mimeType: "application/pdf", fileData: "__LAZY_LOAD__", tags: [DISCARDED_FILE_TAG] })).toBe(false);
  });

  it("an ordinary list row (no proof either way) is assumed to have its file", () => {
    expect(documentHasFile({ mimeType: "image/png", tags: ["receipt"] })).toBe(true);
    expect(documentFormatLabel({ mimeType: "image/png" })).toBe("Image");
    expect(documentFormatLabel({ mimeType: "application/pdf" })).toBe("PDF");
    expect(documentFormatLabel({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("Word");
    expect(mimeFormatLabel("")).toBe("File");
    expect(documentHasFile(null)).toBe(false);
  });
});

describe("BUG-30 internal tags", () => {
  it("hides namespaced, underscored and marker tags; keeps the user's", () => {
    expect(isInternalDocumentTag("sha256:9c8249b8ac8bfb205d22a963256ca01d")).toBe(true);
    expect(isInternalDocumentTag("image-discarded")).toBe(true);
    expect(isInternalDocumentTag("_draft")).toBe(true);
    expect(isInternalDocumentTag("src:chat")).toBe(true);
    expect(isInternalDocumentTag("")).toBe(true);
    expect(isInternalDocumentTag("receipt")).toBe(false);
    expect(isInternalDocumentTag("drivers_license")).toBe(false);
    expect(visibleDocumentTags(["sha256:abc", "receipt", "image-discarded", "Tax 2026"])).toEqual(["receipt", "Tax 2026"]);
    expect(visibleDocumentTags(undefined)).toEqual([]);
  });
});

// Money-keyed extracted fields print as money (viewer + artifact preview).
import { isMoneyFieldKey, stringifyFieldFor } from "../client/src/lib/field-display";

describe("stringifyFieldFor — money-keyed values", () => {
  it("formats tax / subtotal / total numbers as money, two decimals", () => {
    expect(isMoneyFieldKey("tax")).toBe(true);
    expect(isMoneyFieldKey("subtotal")).toBe(true);
    expect(isMoneyFieldKey("totalAmount")).toBe(true);
    expect(isMoneyFieldKey("amount_due")).toBe(true);
    expect(stringifyFieldFor("tax", 1.66)).toBe("$1.66");
    expect(stringifyFieldFor("subtotal", 17.5)).toBe("$17.50");
    expect(stringifyFieldFor("total", "19.16")).toBe("$19.16");
    expect(stringifyFieldFor("total", { value: 19.16 })).toBe("$19.16");
  });
  it("leaves non-money keys and non-numeric values alone", () => {
    expect(isMoneyFieldKey("taxId")).toBe(false);
    expect(isMoneyFieldKey("vendor")).toBe(false);
    expect(stringifyFieldFor("vendor", "Starbucks")).toBe("Starbucks");
    expect(stringifyFieldFor("tax", "included")).toBe("included");
    expect(stringifyFieldFor("year", 2024)).toBe("2024");
  });
});
