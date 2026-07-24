import { describe, it, expect } from "vitest";
import {
  detectDocFieldIntent,
  detectDocFieldIntentWithHistory,
  lookupDocField,
  type DocForLookup,
} from "../shared/doc-field-lookup";

// Regression suite for the 2026-07 report: "What is my driver's license
// number?" was answered with the vehicle's license PLATE (8YPJ480) because
// retrieval searched one flat field pool instead of scoping to the document
// type the user named. These tests pin the deterministic pipeline:
// intent detection → structured fields of THAT doc type → OCR → (model-side)
// broad search last.

const REGISTRATION: DocForLookup = {
  id: "doc-reg",
  name: "Honda Registration",
  type: "registration",
  createdAt: "2026-01-05T00:00:00Z",
  ownerNames: ["Honda CR-V"],
  extractedData: {
    // The exact lookalike from the report: the plate is printed as "License Number".
    "License Number": "8YPJ480",
    "Sticker Issued": "D7060197",
    "Expiration Date": "10/22/2026",
    "Registered Owner": "Sennabaum Robert James",
    "Vehicle ID Number": "7FARW2H70ME032834",
  },
};

const DRIVERS_LICENSE: DocForLookup = {
  id: "doc-dl",
  name: "Florida Driver License",
  type: "drivers_license",
  createdAt: "2026-02-10T00:00:00Z",
  ownerNames: ["Robert"],
  extractedData: {
    licenseNumber: "D123-456-78-901-0",
    dateOfBirth: "1980-01-01",
    expirationDate: "2030-05-01",
    address: "899 Cypress Lake View Ct",
  },
};

const DOCS = [REGISTRATION, DRIVERS_LICENSE];

describe("detectDocFieldIntent", () => {
  it("detects the driver's-license number question (apostrophe and plain forms)", () => {
    for (const q of [
      "What is my driver's license number?",
      "whats my drivers license number",
      "driver license number please",
    ]) {
      const intent = detectDocFieldIntent(q);
      expect(intent?.docKind).toBe("drivers_license");
      expect(intent?.fieldKind).toBe("number");
    }
  });

  it("detects the plate question as a registration-scoped intent", () => {
    const intent = detectDocFieldIntent("what's my license plate?");
    expect(intent?.docKind).toBe("license_plate");
    expect(intent?.fieldKind).toBe("number");
  });

  it("a correction picks the non-negated document kind", () => {
    // "that's my license plate" rules OUT the plate; the DL is what's wanted.
    const intent = detectDocFieldIntent(
      "That's my license plate. I want my driver's license number.",
    );
    expect(intent?.docKind).toBe("drivers_license");
  });

  it("detects generic fields (expiration) against the named document", () => {
    const intent = detectDocFieldIntent("when does my driver's license expire?");
    expect(intent?.docKind).toBe("drivers_license");
    expect(intent?.fieldKind).toBe("expiration");
  });

  it("returns null for non-document messages", () => {
    expect(detectDocFieldIntent("log a $12 lunch expense")).toBeNull();
    expect(detectDocFieldIntent("remind me to wash the dishes")).toBeNull();
    // Bare document mention without a field question is an open request, not a field lookup.
    expect(detectDocFieldIntent("open my driver's license")).toBeNull();
  });
});

describe("detectDocFieldIntentWithHistory (follow-up context)", () => {
  const history = [
    { role: "user", content: "What is my driver's license number?" },
    { role: "assistant", content: "Your license plate is 8YPJ480." },
  ];

  it("recovers the subject from history for a bare follow-up", () => {
    const hit = detectDocFieldIntentWithHistory("no, that's not it — what is it?", history);
    expect(hit?.intent.docKind).toBe("drivers_license");
    expect(hit?.fromHistory).toBe(true);
  });

  it("does not inject stale intent into an unrelated new request", () => {
    expect(detectDocFieldIntentWithHistory("log a $12 lunch expense", history)).toBeNull();
  });

  it("prefers the current message's own intent over history", () => {
    const hit = detectDocFieldIntentWithHistory("that's my plate — my driver's license number please", history);
    expect(hit?.intent.docKind).toBe("drivers_license");
    expect(hit?.fromHistory).toBe(false);
  });
});

describe("lookupDocField — type-scoped, structured-fields-first", () => {
  it("driver's-license number comes from the DL document, never the registration's plate", () => {
    const intent = detectDocFieldIntent("What is my driver's license number?")!;
    const res = lookupDocField(DOCS, intent);
    expect(res.status).toBe("found");
    expect(res.matches[0].docId).toBe("doc-dl");
    expect(res.matches[0].value).toBe("D123-456-78-901-0");
    expect(res.matches[0].source).toBe("structured");
    // The plate value must never appear in the result set.
    expect(res.matches.map(m => m.value)).not.toContain("8YPJ480");
  });

  it("plate question resolves to the registration's 'License Number' field", () => {
    const intent = detectDocFieldIntent("what's my license plate number?")!;
    const res = lookupDocField(DOCS, intent);
    expect(res.status).toBe("found");
    expect(res.matches[0].docId).toBe("doc-reg");
    expect(res.matches[0].value).toBe("8YPJ480");
  });

  it("expiration questions stay scoped to the named document type", () => {
    const dlExp = lookupDocField(DOCS, detectDocFieldIntent("when does my driver's license expire?")!);
    expect(dlExp.matches[0].docId).toBe("doc-dl");
    expect(dlExp.matches[0].value).toBe("2030-05-01");

    const regExp = lookupDocField(DOCS, detectDocFieldIntent("when does my registration expire?")!);
    expect(regExp.matches[0].docId).toBe("doc-reg");
    expect(regExp.matches[0].value).toBe("10/22/2026");
  });

  it("falls back to OCR text when structured fields miss", () => {
    const dlOcrOnly: DocForLookup = {
      id: "doc-dl2", name: "NY Driver License", type: "drivers_license",
      extractedData: {
        rawText: "NEW YORK STATE\nDRIVER LICENSE\nLicense No: 987 654 321\nEXP 2029-03-01",
      },
    };
    const intent = detectDocFieldIntent("driver's license number?")!;
    const res = lookupDocField([REGISTRATION, dlOcrOnly], intent);
    expect(res.status).toBe("found");
    expect(res.matches[0].docId).toBe("doc-dl2");
    expect(res.matches[0].source).toBe("ocr");
    expect(res.matches[0].value).toBe("987 654 321");
  });

  it("reports field_missing (not a lookalike answer) when the right doc lacks the field", () => {
    const dlNoNumber: DocForLookup = {
      id: "doc-dl3", name: "Driver License photo", type: "drivers_license",
      extractedData: { state: "FL" },
    };
    const intent = detectDocFieldIntent("driver's license number?")!;
    const res = lookupDocField([REGISTRATION, dlNoNumber], intent);
    expect(res.status).toBe("field_missing");
    expect(res.matches).toEqual([]);
    expect(res.checkedDocs.map(d => d.docId)).toEqual(["doc-dl3"]);
  });

  it("reports no_document when no doc of the asked type exists", () => {
    const intent = detectDocFieldIntent("what's my passport number?")!;
    const res = lookupDocField(DOCS, intent);
    expect(res.status).toBe("no_document");
    expect(res.totalDocs).toBe(2);
  });

  it("unwraps { value } leaves and nested groups from extractor output", () => {
    const nested: DocForLookup = {
      id: "doc-dl4", name: "Driver License", type: "drivers_license",
      extractedData: { identity: { "License Number": { value: "X99-11" } } },
    };
    const intent = detectDocFieldIntent("drivers license number")!;
    const res = lookupDocField([nested], intent);
    expect(res.status).toBe("found");
    expect(res.matches[0].value).toBe("X99-11");
  });

  it("returns one match per document so multi-person households can be disambiguated", () => {
    const janes: DocForLookup = {
      id: "doc-dl5", name: "Jane Driver License", type: "drivers_license",
      ownerNames: ["Jane"],
      extractedData: { licenseNumber: "J555" },
    };
    const intent = detectDocFieldIntent("driver's license number")!;
    const res = lookupDocField([DRIVERS_LICENSE, janes], intent);
    expect(res.matches.length).toBe(2);
    const owners = res.matches.flatMap(m => m.ownerNames);
    expect(owners).toContain("Robert");
    expect(owners).toContain("Jane");
  });
});
