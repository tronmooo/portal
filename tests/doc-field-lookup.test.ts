import { describe, it, expect } from "vitest";
import {
  detectDocFieldIntent,
  detectDocFieldIntentWithHistory,
  looksLikeDocFieldFollowUp,
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

// ─── Expanded matrix: every supported document type, with cross-document
// mix-up regression. Each doc carries a UNIQUE signature value; every intent
// must return ONLY its own document's value, never a lookalike from another
// type. Rotated/low-quality uploads surface here as OCR-only or field-poor
// extractions — the retrieval layer's job is to stay correct (or honestly
// report a miss) for those shapes; pixel handling lives in the upload pipeline.

const WALLET: DocForLookup[] = [
  {
    id: "w-reg", name: "CA Vehicle Registration", type: "vehicle_registration",
    extractedData: {
      "License Number": "8YPJ480",             // the plate — the classic lookalike
      "Vehicle ID Number": "7FARW2H70ME032834",
      "Expiration Date": "10/22/2026",
      "Registered Owner": "Sennabaum Robert James",
    },
  },
  {
    id: "w-dl", name: "CA Driver License", type: "drivers_license",
    extractedData: {
      dlNumber: "D1234567",                     // CA-style "DL" label
      dateOfBirth: "1980-01-01",
      expirationDate: "2030-05-01",
      address: "899 Cypress Lake View Ct",
      fullName: "Robert James Sennabaum",
    },
  },
  {
    id: "w-ins", name: "Progressive Auto Insurance Card", type: "insurance",
    extractedData: { policyNumber: "POL-99887766", memberId: "MEM-1122", expirationDate: "2027-01-31", vin: "7FARW2H70ME032834" },
  },
  {
    id: "w-pass", name: "US Passport", type: "passport",
    extractedData: { passportNumber: "563218890", fullName: "ROBERT JAMES SENNABAUM", expirationDate: "2031-08-15" },
  },
  {
    id: "w-birth", name: "Birth Certificate", type: "birth_certificate",
    extractedData: { stateFileNumber: "BC-445566", dateOfBirth: "1980-01-01" },
  },
  {
    id: "w-util", name: "FPL Electric Bill", type: "utility_bill",
    extractedData: { accountNumber: "UTIL-778899", dueDate: "2026-08-01", totalAmount: 182.44 },
  },
  {
    id: "w-bank", name: "Chase Bank Statement", type: "bank_statement",
    extractedData: { accountNumber: "BANK-334455", routingNumber: "021000021" },
  },
  {
    id: "w-rcpt", name: "Best Buy Receipt", type: "receipt",
    extractedData: { orderNumber: "ORD-2026-0715", totalAmount: 1299.99 },
  },
  {
    id: "w-med", name: "Quest Lab Results", type: "medical_report",
    extractedData: { patientId: "PAT-6001", collectionDate: "2026-06-10" },
  },
  {
    id: "w-warr", name: "Samsung Refrigerator Warranty", type: "warranty",
    extractedData: { serialNumber: "SN-FRIDGE-01", contractNumber: "WC-2025-88" },
  },
  {
    id: "w-title", name: "Honda CR-V Title", type: "vehicle_title",
    extractedData: { titleNumber: "TTL-90210" },
  },
  {
    id: "w-tax", name: "2025 W-2", type: "tax_form",
    extractedData: { controlNumber: "CTRL-777", employerIdentificationNumber: "12-3456789" },
  },
  {
    id: "w-memb", name: "Costco Membership Card", type: "membership_card",
    extractedData: { memberNumber: "COSTCO-111222333" },
  },
  {
    id: "w-ssn", name: "Social Security Card", type: "ssn_card",
    extractedData: { socialSecurityNumber: "123-45-6789" },
  },
];

describe("lookupDocField — full document-type matrix (no cross-document mix-ups)", () => {
  const CASES: Array<{ q: string; docId: string; value: string }> = [
    { q: "What is my driver's license number?",              docId: "w-dl",    value: "D1234567" },
    { q: "what's my license plate?",                          docId: "w-reg",   value: "8YPJ480" },
    { q: "when does my driver's license expire?",             docId: "w-dl",    value: "2030-05-01" },
    { q: "when does my registration expire?",                 docId: "w-reg",   value: "10/22/2026" },
    { q: "what's my insurance policy number?",                docId: "w-ins",   value: "POL-99887766" },
    { q: "when does my insurance expire?",                    docId: "w-ins",   value: "2027-01-31" },
    { q: "what's my passport number?",                        docId: "w-pass",  value: "563218890" },
    { q: "what's the name on my passport?",                   docId: "w-pass",  value: "ROBERT JAMES SENNABAUM" },
    { q: "what's the state file number on my birth certificate?", docId: "w-birth", value: "BC-445566" },
    { q: "what's the account number on my electric bill?",    docId: "w-util",  value: "UTIL-778899" },
    { q: "what's my bank account number?",                    docId: "w-bank",  value: "BANK-334455" },
    { q: "what's the routing number on my bank statement?",   docId: "w-bank",  value: "021000021" },
    { q: "what's the order number on the Best Buy receipt?",  docId: "w-rcpt",  value: "ORD-2026-0715" },
    { q: "what's the patient ID on my medical record?",       docId: "w-med",   value: "PAT-6001" },
    { q: "what's the serial number?",                         docId: "w-warr",  value: "SN-FRIDGE-01" },
    { q: "what's my car title number?",                       docId: "w-title", value: "TTL-90210" },
    { q: "what's the control number on my W-2 tax form?",     docId: "w-tax",   value: "CTRL-777" },
    { q: "what's my Costco member number?",                   docId: "w-memb",  value: "COSTCO-111222333" },
    { q: "what's my SSN?",                                    docId: "w-ssn",   value: "123-45-6789" },
    { q: "date of birth on my driver's license?",             docId: "w-dl",    value: "1980-01-01" },
    { q: "address on my driver's license?",                   docId: "w-dl",    value: "899 Cypress Lake View Ct" },
  ];

  for (const c of CASES) {
    it(`"${c.q}" → ${c.docId} only`, () => {
      const intent = detectDocFieldIntent(c.q);
      expect(intent, `intent should be detected for "${c.q}"`).not.toBeNull();
      const res = lookupDocField(WALLET, intent!);
      expect(res.status).toBe("found");
      expect(res.matches[0].docId).toBe(c.docId);
      expect(res.matches[0].value).toBe(c.value);
    });
  }

  it("the VIN comes from vehicle paperwork, never the driver's license", () => {
    const res = lookupDocField(WALLET, detectDocFieldIntent("what's my VIN?")!);
    expect(res.status).toBe("found");
    expect(res.matches.every(m => m.docId !== "w-dl")).toBe(true);
    expect(res.matches[0].value).toBe("7FARW2H70ME032834");
  });

  it("the plate value never leaks into non-plate answers (the original bug, matrix-wide)", () => {
    for (const c of CASES.filter(x => x.docId !== "w-reg")) {
      const res = lookupDocField(WALLET, detectDocFieldIntent(c.q)!);
      expect(res.matches.map(m => m.value), `"${c.q}" must not return the plate`).not.toContain("8YPJ480");
    }
  });
});

describe("lookupDocField — DL label variations across states", () => {
  const variants: Array<[string, DocForLookup]> = [
    ["CA 'DL Number'", { id: "v1", name: "California Driver License", type: "drivers_license", extractedData: { "DL Number": "CA-111" } }],
    ["FL 'licenseNumber'", { id: "v2", name: "Florida Driver License", type: "drivers_license", extractedData: { licenseNumber: "FL-222" } }],
    ["UK 'Licence Number'", { id: "v3", name: "UK Driving Licence", type: "drivers_licence", extractedData: { "Licence Number": "UK-333" } }],
    ["nested identity group", { id: "v4", name: "TX Driver License", type: "drivers_license", extractedData: { identity: { "License Number": { value: "TX-444" } } } }],
    ["'Customer ID' label", { id: "v5", name: "AZ Driver License", type: "drivers_license", extractedData: { customerId: "AZ-555" } }],
  ];
  const intent = () => detectDocFieldIntent("driver's license number")!;

  for (const [label, doc] of variants) {
    it(`resolves the ${label} variant`, () => {
      const res = lookupDocField([doc], intent());
      expect(res.status).toBe("found");
      expect(res.matches[0].value).toBe(doc.id === "v1" ? "CA-111" : doc.id === "v2" ? "FL-222" : doc.id === "v3" ? "UK-333" : doc.id === "v4" ? "TX-444" : "AZ-555");
    });
  }
});

describe("lookupDocField — field confidence + OCR verification", () => {
  const intent = () => detectDocFieldIntent("driver's license number")!;

  it("low-confidence value confirmed by OCR → ocr_confirmed, structured value kept", () => {
    const doc: DocForLookup = {
      id: "c1", name: "Driver License", type: "drivers_license",
      extractedData: {
        licenseNumber: { value: "D123-456", confidence: 0.5 },
        rawText: "DRIVER LICENSE\nLicense No: D123 456\n",
      },
    };
    const res = lookupDocField([doc], intent());
    expect(res.matches[0].verification).toBe("ocr_confirmed");
    expect(res.matches[0].value).toBe("D123-456");
    expect(res.matches[0].confidence).toBe(0.5);
  });

  it("low-confidence value contradicted by OCR → OCR wins, conflict surfaced", () => {
    const doc: DocForLookup = {
      id: "c2", name: "Driver License", type: "drivers_license",
      extractedData: {
        licenseNumber: { value: "D000-999", confidence: 0.4 },
        rawText: "License No: D123-456\n",
      },
    };
    const res = lookupDocField([doc], intent());
    const m = res.matches[0];
    expect(m.verification).toBe("ocr_conflict");
    expect(m.value).toBe("D123-456");          // OCR reading
    expect(m.conflictingValue).toBe("D000-999"); // shaky extraction, surfaced
    expect(m.source).toBe("ocr");
  });

  it("low-confidence value with no OCR available → flagged unverified", () => {
    const doc: DocForLookup = {
      id: "c3", name: "Driver License", type: "drivers_license",
      extractedData: { licenseNumber: { value: "D77", confidence: 0.3 } },
    };
    const res = lookupDocField([doc], intent());
    expect(res.matches[0].verification).toBe("unverified");
  });

  it("high-confidence value needs no verification pass", () => {
    const doc: DocForLookup = {
      id: "c4", name: "Driver License", type: "drivers_license",
      extractedData: { licenseNumber: { value: "D88", confidence: 0.95 }, rawText: "License No: WRONG" },
    };
    const res = lookupDocField([doc], intent());
    expect(res.matches[0].verification).toBeUndefined();
    expect(res.matches[0].value).toBe("D88");
  });
});

describe("lookupDocField — retrieval tiers (structured → OCR → summary)", () => {
  const intent = () => detectDocFieldIntent("driver's license number")!;

  it("tier 3: labeled value in the extraction summary when fields and OCR miss", () => {
    const doc: DocForLookup = {
      id: "t3", name: "Driver License scan", type: "drivers_license",
      extractedData: { summary: "Photo of a Florida driver license. License Number: D-SUM-1" },
    };
    const res = lookupDocField([doc], intent());
    expect(res.status).toBe("found");
    expect(res.matches[0].source).toBe("summary");
    expect(res.matches[0].value).toBe("D-SUM-1");
  });

  it("low-quality upload (empty extraction, no OCR) → honest field_missing, never a guess", () => {
    const doc: DocForLookup = { id: "t4", name: "blurry license photo", type: "drivers_license", extractedData: {} };
    const res = lookupDocField([doc], intent());
    expect(res.status).toBe("field_missing");
    expect(res.matches).toEqual([]);
  });
});

describe("looksLikeDocFieldFollowUp", () => {
  it("flags corrections and short follow-ups", () => {
    expect(looksLikeDocFieldFollowUp("no, that's not it")).toBe(true);
    expect(looksLikeDocFieldFollowUp("so what is it then?")).toBe(true);
  });
  it("ignores fresh unrelated requests", () => {
    expect(looksLikeDocFieldFollowUp("log a $12 lunch expense")).toBe(false);
  });
});
