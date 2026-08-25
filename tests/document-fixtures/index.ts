// tests/document-fixtures/index.ts
//
// The corpus that keeps the document engine UNIVERSAL.
//
// The whole point of shared/extraction-actions.ts is that insurance, medical
// reports, receipts, leases, deeds and prescriptions are FIXTURES, not code
// paths. This file is where that claim is made falsifiable: every fixture below
// is run through the same `planExtractionActions`, and the same invariant suite
// is asserted against every one of them.
//
// Adding support for a new kind of document means adding a fixture here. If it
// ever means adding a branch to the planner instead, the design has failed and
// the failure should be visible in this file's diff.
//
// The last fixture is deliberately a document nobody wrote anything for. It
// asserts the engine still produces subjects, roles and actions for it rather
// than falling back to dumping every field onto a profile — the specific
// regression the whole change exists to prevent.

import type { SemanticDocument } from "../../shared/semantic-document";
import type { ExtractionItem } from "../../shared/extraction-destinations";
import type { EntityIndex } from "../../shared/extraction-actions";

export interface DocumentFixture {
  name: string;
  semantic: SemanticDocument;
  items: ExtractionItem[];
  index: EntityIndex;
  primaryProfileId?: string;
  /** What this fixture is here to prove, beyond the universal invariants. */
  expectations?: {
    /** Exactly this many obligation actions. */
    obligations?: number;
    /** These raw rows must reach `reference` and cause nothing. */
    referenceOnlyItemIds?: string[];
    /** At least one action of each of these destinations. */
    destinations?: string[];
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

let n = 0;
const item = (key: string, label: string, value: any): ExtractionItem => ({
  // The id is built the way `buildExtractionItems` builds it — slugged, and so
  // LOWERCASED. Hand-writing `field-yearbuilt` here is what let a bug through
  // where the planner read the field key off the id and wrote `yearbuilt`.
  id: `field-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  key,
  label,
  value,
  destination: "profile",
  destinationOptions: ["profile", "note", "ignore"],
  selected: true,
  source: "field",
});

const profile = (id: string, type: string, name: string, fields: Record<string, any> = {}) =>
  ({ id, type, name, fields });

const emptyIndex = (): EntityIndex =>
  ({ profiles: [], obligations: [], expenses: [], trackers: [], links: [] });

// ═══════════════════════════════════════════════════════════════════════════
// 1. Homeowners insurance declarations — the document from the bug report
// ═══════════════════════════════════════════════════════════════════════════

const insuranceItems = [
  item("propertyAddress", "Property Address", "123 Evergreen Lane, Springfield, CO 80501"),
  item("yearBuilt", "Year Built", "2018"),
  item("squareFeet", "Square Feet", "2450"),
  item("roofType", "Roof Type", "Composition Single"),
  item("constructionType", "Construction Type", "Frame"),
  item("policyNumber", "Policy Number", "SPI-24-87654321"),
  item("carrier", "Insurance Carrier", "Summit Peak Insurance Group"),
  item("namedInsured", "Named Insured", "Johnathan A. Doe"),
  item("effectiveDate", "Effective Date", "2024-06-01"),
  item("expirationDate", "Expiration Date", "2025-06-01"),
  item("annualPremium", "Annual Premium", "1428.00"),
  item("paymentPlan", "Payment Plan", "Annual"),
  item("paymentDueDate", "Payment Due Date", "2024-06-01"),
  item("mortgageeName", "Mortgagee", "Pinnacle Home Loans, LLC"),
  item("loanNumber", "Loan Number", "PHL-4471903"),
  item("signatureDate", "Authorized Representative Signature Date", "2024-05-20"),
  item("naicCode", "NAIC Company Code", "12345"),
];

export const insuranceDeclarations: DocumentFixture = {
  name: "homeowners insurance declarations",
  primaryProfileId: "prop-1",
  items: insuranceItems,
  index: {
    ...emptyIndex(),
    profiles: [
      profile("prop-1", "property", "123 Evergreen Ln", { address: "123 Evergreen Lane", yearBuilt: "2018" }),
      profile("person-1", "self", "Johnathan A. Doe", {}),
      profile("liab-1", "liability", "Pinnacle Home Loans Mortgage", {
        loanNumber: "PHL-4471903", propertyAddress: "123 Evergreen Ln",
      }),
    ],
  },
  semantic: {
    documentType: "Homeowners Insurance Policy",
    primarySubject: "e-property",
    confidence: 0.94,
    summary: "Annual homeowners policy on 123 Evergreen Lane.",
    entities: [
      { ref: "e-property", kind: "property", name: "123 Evergreen Lane", identifiers: {}, confidence: 0.95 },
      { ref: "e-person", kind: "person", name: "Johnathan A. Doe", identifiers: {}, role: "insured", confidence: 0.93 },
      { ref: "e-carrier", kind: "organization", name: "Summit Peak Insurance Group", identifiers: { policyNumber: "SPI-24-87654321" }, role: "insurer", confidence: 0.95 },
      { ref: "e-lender", kind: "liability", name: "Pinnacle Home Loans, LLC", identifiers: { loanNumber: "PHL-4471903" }, role: "mortgagee", confidence: 0.9 },
    ],
    relationships: [
      { from: "e-person", to: "e-property", type: "owns", confidence: 0.9 },
      { from: "e-property", to: "e-carrier", type: "insured_by", confidence: 0.95 },
      { from: "e-property", to: "e-lender", type: "financed_by", confidence: 0.88 },
    ],
    facts: [
      { id: "f-year", itemIds: ["field-yearbuilt"], label: "Year Built", value: "2018", roles: ["entity_data"], subject: { entityRef: "e-property", confidence: 0.95 }, volatility: "stable", confidence: 0.95 },
      { id: "f-sqft", itemIds: ["field-squarefeet"], label: "Square Feet", value: "2450", roles: ["entity_data"], subject: { entityRef: "e-property", confidence: 0.95 }, volatility: "stable", confidence: 0.94 },
      { id: "f-roof", itemIds: ["field-rooftype"], label: "Roof Type", value: "Composition Single", roles: ["entity_data"], subject: { entityRef: "e-property", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
      { id: "f-constr", itemIds: ["field-constructiontype"], label: "Construction Type", value: "Frame", roles: ["entity_data"], subject: { entityRef: "e-property", confidence: 0.9 }, volatility: "stable", confidence: 0.9 },
      { id: "f-policy", itemIds: ["field-policynumber"], label: "Policy Number", value: "SPI-24-87654321", roles: ["entity_data"], subject: { entityRef: "e-carrier", confidence: 0.95 }, volatility: "stable", confidence: 0.95 },
      { id: "f-expiry", itemIds: ["field-expirationdate"], label: "Expiration Date", value: "2025-06-01", roles: ["actionable_date"], subject: { entityRef: "e-carrier", confidence: 0.93 }, volatility: "changeable", confidence: 0.93 },
      { id: "f-premium", itemIds: ["field-annualpremium"], label: "Annual Premium", value: 1428, roles: ["financial", "recurring_obligation"], subject: { entityRef: "e-property", confidence: 0.94 }, volatility: "changeable", confidence: 0.94 },
      { id: "f-plan", itemIds: ["field-paymentplan"], label: "Payment Plan", value: "Annual", roles: ["recurring_obligation"], subject: { entityRef: "e-property", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
      { id: "f-due", itemIds: ["field-paymentduedate"], label: "Payment Due Date", value: "2024-06-01", roles: ["recurring_obligation", "actionable_date"], subject: { entityRef: "e-property", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
      { id: "f-sig", itemIds: ["field-signaturedate"], label: "Authorized Representative Signature Date", value: "2024-05-20", roles: ["reference_only"], subject: { entityRef: "e-carrier", confidence: 0.9 }, volatility: "historical", confidence: 0.92 },
      { id: "f-naic", itemIds: ["field-naiccode"], label: "NAIC Company Code", value: "12345", roles: ["document_metadata"], subject: { entityRef: "e-carrier", confidence: 0.9 }, volatility: "stable", confidence: 0.9 },
    ],
    recurrences: [{
      id: "r-premium",
      factIds: ["f-premium", "f-plan", "f-due"],
      label: "Homeowners premium",
      subjectRef: "e-property",
      cadence: "yearly",
      amountPerOccurrence: 1428,
      annualizedTotal: 1428,
      nextOccurrence: "2024-06-01",
      endsOn: "2025-06-01",
      stated: "both",
      confidence: 0.93,
    }],
    narrative: [],
  },
  expectations: {
    obligations: 1,
    referenceOnlyItemIds: ["field-signaturedate", "field-naiccode"],
    destinations: ["obligation", "entity_field", "reference"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. Medical report — the destination the engine must NOT regress
// ═══════════════════════════════════════════════════════════════════════════

export const medicalReport: DocumentFixture = {
  name: "annual physical lab report",
  primaryProfileId: "person-1",
  items: [
    item("weight", "Weight", "300 lb"),
    item("bloodType", "Blood Type", "AB-"),
    item("hemoglobinA1c", "Hemoglobin A1C", "5.8"),
    item("examSummary", "Physical Exam", "Lungs clear bilaterally. No murmurs, rubs or gallops. Abdomen soft and non-tender."),
    item("collectionDate", "Collection Date", "2026-08-01"),
  ],
  index: {
    ...emptyIndex(),
    profiles: [profile("person-1", "self", "Sarah Miller", { bloodType: "O+", weight: "180" })],
    trackers: [{ id: "trk-1", name: "Weight", unit: "lbs", category: "health" }],
  },
  semantic: {
    documentType: "Lab Report",
    primarySubject: "e-person",
    confidence: 0.95,
    summary: "Annual physical with a lipid and metabolic panel.",
    entities: [{ ref: "e-person", kind: "person", name: "Sarah Miller", identifiers: {}, confidence: 0.96 }],
    relationships: [],
    facts: [
      { id: "f-weight", itemIds: ["field-weight"], label: "Weight", value: 300, roles: ["measurement", "profile_data"], subject: { entityRef: "e-person", confidence: 0.96 }, volatility: "changeable", unit: "lbs", date: "2026-08-01", confidence: 0.95 },
      { id: "f-blood", itemIds: ["field-bloodtype"], label: "Blood Type", value: "AB-", roles: ["profile_data"], subject: { entityRef: "e-person", confidence: 0.95 }, volatility: "stable", confidence: 0.9 },
      { id: "f-a1c", itemIds: ["field-hemoglobina1c"], label: "Hemoglobin A1C", value: 5.8, roles: ["measurement"], subject: { entityRef: "e-person", confidence: 0.95 }, volatility: "changeable", unit: "%", date: "2026-08-01", confidence: 0.94 },
      { id: "f-exam", itemIds: ["field-examsummary"], label: "Physical Exam", value: "Lungs clear bilaterally. No murmurs, rubs or gallops. Abdomen soft and non-tender.", roles: ["narrative"], subject: { entityRef: "e-person", confidence: 0.94 }, volatility: "historical", confidence: 0.92 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { obligations: 0, destinations: ["tracker", "profile", "note"] },
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. Receipt — a one-off charge, no recurrence
// ═══════════════════════════════════════════════════════════════════════════

export const receipt: DocumentFixture = {
  name: "hardware store receipt",
  primaryProfileId: "person-1",
  items: [
    item("vendorName", "Vendor", "Ridgeline Hardware"),
    item("totalAmount", "Total", "84.19"),
    item("transactionDate", "Transaction Date", "2026-08-14"),
  ],
  index: { ...emptyIndex(), profiles: [profile("person-1", "self", "Sarah Miller")] },
  semantic: {
    documentType: "Receipt",
    primarySubject: "e-person",
    confidence: 0.9,
    summary: "Hardware purchase.",
    entities: [
      { ref: "e-person", kind: "person", name: "Sarah Miller", identifiers: {}, confidence: 0.9 },
      { ref: "e-vendor", kind: "business", name: "Ridgeline Hardware", identifiers: {}, role: "vendor", confidence: 0.9 },
    ],
    relationships: [{ from: "e-person", to: "e-vendor", type: "pays", confidence: 0.85 }],
    facts: [
      { id: "f-total", itemIds: ["field-totalamount"], label: "Total", value: 84.19, roles: ["financial"], subject: { entityRef: "e-person", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
      { id: "f-date", itemIds: ["field-transactiondate"], label: "Transaction Date", value: "2026-08-14", roles: ["reference_only"], subject: { entityRef: "e-person", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { obligations: 0 },
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. Parking ticket — a deadline that IS actionable
// ═══════════════════════════════════════════════════════════════════════════

export const parkingTicket: DocumentFixture = {
  name: "parking citation",
  primaryProfileId: "vehicle-1",
  items: [
    item("citationNumber", "Citation Number", "CIT-99120"),
    item("fineAmount", "Fine Amount", "65.00"),
    item("dueDate", "Due Date", "2026-09-25"),
    item("issueDate", "Issue Date", "2026-08-25"),
  ],
  index: {
    ...emptyIndex(),
    profiles: [profile("vehicle-1", "vehicle", "Honda CR-V", { vin: "2HKRW2H85MH512345" })],
  },
  semantic: {
    documentType: "Parking Citation",
    primarySubject: "e-vehicle",
    confidence: 0.9,
    summary: "Parking citation with a payment deadline.",
    entities: [{ ref: "e-vehicle", kind: "vehicle", name: "Honda CR-V", identifiers: {}, confidence: 0.9 }],
    relationships: [],
    facts: [
      { id: "f-fine", itemIds: ["field-fineamount"], label: "Fine Amount", value: 65, roles: ["financial"], subject: { entityRef: "e-vehicle", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
      { id: "f-due", itemIds: ["field-duedate"], label: "Due Date", value: "2026-09-25", roles: ["actionable_date"], subject: { entityRef: "e-vehicle", confidence: 0.92 }, volatility: "changeable", confidence: 0.92 },
      { id: "f-issued", itemIds: ["field-issuedate"], label: "Issue Date", value: "2026-08-25", roles: ["reference_only"], subject: { entityRef: "e-vehicle", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { referenceOnlyItemIds: ["field-issuedate"], destinations: ["calendar"] },
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. Loan statement — an annual-only figure that must NOT sprout instalments
// ═══════════════════════════════════════════════════════════════════════════

export const loanStatement: DocumentFixture = {
  name: "auto loan statement",
  primaryProfileId: "liab-2",
  items: [
    item("lender", "Lender", "Cascade Credit Union"),
    item("currentBalance", "Current Balance", "18240.55"),
    item("monthlyPayment", "Monthly Payment", "412.90"),
    item("nextDueDate", "Next Payment Due", "2026-09-15"),
  ],
  index: {
    ...emptyIndex(),
    profiles: [profile("liab-2", "liability", "Cascade Auto Loan", { lender: "Cascade Credit Union" })],
  },
  semantic: {
    documentType: "Loan Statement",
    primarySubject: "e-loan",
    confidence: 0.93,
    summary: "Monthly auto loan statement.",
    entities: [{ ref: "e-loan", kind: "liability", name: "Cascade Auto Loan", identifiers: {}, confidence: 0.93 }],
    relationships: [],
    facts: [
      { id: "f-balance", itemIds: ["field-currentbalance"], label: "Current Balance", value: 18240.55, roles: ["financial", "entity_data"], subject: { entityRef: "e-loan", confidence: 0.93 }, volatility: "changeable", confidence: 0.93 },
      { id: "f-payment", itemIds: ["field-monthlypayment"], label: "Monthly Payment", value: 412.9, roles: ["financial", "recurring_obligation"], subject: { entityRef: "e-loan", confidence: 0.93 }, volatility: "changeable", confidence: 0.93 },
      { id: "f-due", itemIds: ["field-nextduedate"], label: "Next Payment Due", value: "2026-09-15", roles: ["recurring_obligation", "actionable_date"], subject: { entityRef: "e-loan", confidence: 0.92 }, volatility: "changeable", confidence: 0.92 },
    ],
    recurrences: [{
      id: "r-loan", factIds: ["f-payment", "f-due"], label: "Auto loan payment",
      subjectRef: "e-loan", cadence: "monthly", amountPerOccurrence: 412.9,
      nextOccurrence: "2026-09-15", stated: "per_occurrence", confidence: 0.93,
    }],
    narrative: [],
  },
  expectations: { obligations: 1 },
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. Property deed — stable facts only, nothing recurring, nothing dated
// ═══════════════════════════════════════════════════════════════════════════

export const deed: DocumentFixture = {
  name: "property deed",
  primaryProfileId: "prop-1",
  items: [
    item("parcelNumber", "Parcel Number", "0451-223-19-007"),
    item("legalDescription", "Legal Description", "Lot 14, Block 3, Evergreen Addition"),
    item("recordedDate", "Recorded Date", "2018-04-02"),
  ],
  index: { ...emptyIndex(), profiles: [profile("prop-1", "property", "123 Evergreen Ln")] },
  semantic: {
    documentType: "Warranty Deed",
    primarySubject: "e-property",
    confidence: 0.9,
    summary: "Warranty deed recording ownership.",
    entities: [{ ref: "e-property", kind: "property", name: "123 Evergreen Lane", identifiers: { parcelNumber: "0451-223-19-007" }, confidence: 0.92 }],
    relationships: [],
    facts: [
      { id: "f-parcel", itemIds: ["field-parcelnumber"], label: "Parcel Number", value: "0451-223-19-007", roles: ["entity_data"], subject: { entityRef: "e-property", confidence: 0.92 }, volatility: "stable", confidence: 0.92 },
      { id: "f-legal", itemIds: ["field-legaldescription"], label: "Legal Description", value: "Lot 14, Block 3, Evergreen Addition", roles: ["entity_data"], subject: { entityRef: "e-property", confidence: 0.9 }, volatility: "stable", confidence: 0.9 },
      { id: "f-recorded", itemIds: ["field-recordeddate"], label: "Recorded Date", value: "2018-04-02", roles: ["reference_only"], subject: { entityRef: "e-property", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { obligations: 0, referenceOnlyItemIds: ["field-recordeddate"] },
};

// ═══════════════════════════════════════════════════════════════════════════
// 7. Prescription — a regimen implied by dosage + frequency
// ═══════════════════════════════════════════════════════════════════════════

export const prescription: DocumentFixture = {
  name: "prescription",
  primaryProfileId: "person-1",
  items: [
    item("medicationName", "Medication", "Metformin"),
    item("dose", "Dose", "500 mg"),
    item("frequency", "Frequency", "Twice daily"),
  ],
  index: { ...emptyIndex(), profiles: [profile("person-1", "self", "Sarah Miller")] },
  semantic: {
    documentType: "Prescription",
    primarySubject: "e-person",
    confidence: 0.92,
    summary: "Metformin 500 mg twice daily.",
    entities: [
      { ref: "e-person", kind: "person", name: "Sarah Miller", identifiers: {}, confidence: 0.92 },
      { ref: "e-clinic", kind: "organization", name: "Riverdale Health", identifiers: {}, role: "prescriber", confidence: 0.9 },
    ],
    relationships: [{ from: "e-clinic", to: "e-person", type: "prescribed", confidence: 0.9 }],
    facts: [
      { id: "f-med", itemIds: ["field-medicationname", "field-dose"], label: "Metformin", value: "500 mg", roles: ["profile_data"], subject: { entityRef: "e-person", confidence: 0.92 }, volatility: "changeable", confidence: 0.92 },
      { id: "f-freq", itemIds: ["field-frequency"], label: "Frequency", value: "Twice daily", roles: ["recurring_obligation"], subject: { entityRef: "e-person", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { obligations: 0 },
};

// ═══════════════════════════════════════════════════════════════════════════
// 8. Lease — monthly rent, a term end, an escrow-style bundled cost
// ═══════════════════════════════════════════════════════════════════════════

export const lease: DocumentFixture = {
  name: "residential lease",
  primaryProfileId: "prop-2",
  items: [
    item("monthlyRent", "Monthly Rent", "2150.00"),
    item("leaseEndDate", "Lease End Date", "2027-05-31"),
    item("rentDueDay", "Rent Due", "2026-09-01"),
  ],
  index: { ...emptyIndex(), profiles: [profile("prop-2", "property", "Unit 4B, Larkspur Court")] },
  semantic: {
    documentType: "Residential Lease",
    primarySubject: "e-unit",
    confidence: 0.91,
    summary: "12-month residential lease.",
    entities: [{ ref: "e-unit", kind: "property", name: "Unit 4B, Larkspur Court", identifiers: {}, confidence: 0.91 }],
    relationships: [],
    facts: [
      { id: "f-rent", itemIds: ["field-monthlyrent"], label: "Monthly Rent", value: 2150, roles: ["financial", "recurring_obligation"], subject: { entityRef: "e-unit", confidence: 0.91 }, volatility: "changeable", confidence: 0.91 },
      { id: "f-end", itemIds: ["field-leaseenddate"], label: "Lease End Date", value: "2027-05-31", roles: ["actionable_date"], subject: { entityRef: "e-unit", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
      { id: "f-due", itemIds: ["field-rentdueday"], label: "Rent Due", value: "2026-09-01", roles: ["recurring_obligation", "actionable_date"], subject: { entityRef: "e-unit", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
    ],
    recurrences: [{
      id: "r-rent", factIds: ["f-rent", "f-due"], label: "Rent",
      subjectRef: "e-unit", cadence: "monthly", amountPerOccurrence: 2150,
      nextOccurrence: "2026-09-01", endsOn: "2027-05-31", stated: "per_occurrence", confidence: 0.91,
    }],
    narrative: [],
  },
  expectations: { obligations: 1 },
};

// ═══════════════════════════════════════════════════════════════════════════
// 9. Tax record — historical money, must never become a bill
// ═══════════════════════════════════════════════════════════════════════════

export const taxRecord: DocumentFixture = {
  name: "W-2 wage statement",
  primaryProfileId: "person-1",
  items: [
    item("wagesTipsOther", "Wages, Tips, Other Compensation", "94500.00"),
    item("federalIncomeTaxWithheld", "Federal Income Tax Withheld", "13120.00"),
    item("taxYear", "Tax Year", "2025"),
  ],
  index: { ...emptyIndex(), profiles: [profile("person-1", "self", "Sarah Miller")] },
  semantic: {
    documentType: "W-2 Wage Statement",
    primarySubject: "e-person",
    confidence: 0.93,
    summary: "Annual wage and tax statement.",
    entities: [
      { ref: "e-person", kind: "person", name: "Sarah Miller", identifiers: {}, confidence: 0.93 },
      { ref: "e-employer", kind: "organization", name: "Aurora Systems", identifiers: {}, role: "employer", confidence: 0.9 },
    ],
    relationships: [{ from: "e-person", to: "e-employer", type: "employed_by", confidence: 0.9 }],
    facts: [
      { id: "f-wages", itemIds: ["field-wagestipsother"], label: "Wages", value: 94500, roles: ["financial"], subject: { entityRef: "e-person", confidence: 0.93 }, volatility: "historical", confidence: 0.93 },
      { id: "f-withheld", itemIds: ["field-federalincometaxwithheld"], label: "Federal Income Tax Withheld", value: 13120, roles: ["financial"], subject: { entityRef: "e-person", confidence: 0.92 }, volatility: "historical", confidence: 0.92 },
      { id: "f-year", itemIds: ["field-taxyear"], label: "Tax Year", value: "2025", roles: ["document_metadata"], subject: { entityRef: "e-person", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { obligations: 0 },
};

// ═══════════════════════════════════════════════════════════════════════════
// 10. Warranty — an expiration that matters, nothing else
// ═══════════════════════════════════════════════════════════════════════════

export const warranty: DocumentFixture = {
  name: "appliance warranty",
  primaryProfileId: "asset-1",
  items: [
    item("serialNumber", "Serial Number", "RF28-99120847"),
    item("warrantyExpiration", "Warranty Expiration", "2029-03-11"),
    item("purchaseDate", "Purchase Date", "2026-03-11"),
  ],
  index: { ...emptyIndex(), profiles: [profile("asset-1", "asset", "Kitchen Refrigerator")] },
  semantic: {
    documentType: "Appliance Warranty",
    primarySubject: "e-appliance",
    confidence: 0.9,
    summary: "Three-year manufacturer warranty.",
    entities: [{ ref: "e-appliance", kind: "asset", name: "Kitchen Refrigerator", identifiers: { serialNumber: "RF28-99120847" }, confidence: 0.9 }],
    relationships: [],
    facts: [
      { id: "f-serial", itemIds: ["field-serialnumber"], label: "Serial Number", value: "RF28-99120847", roles: ["entity_data"], subject: { entityRef: "e-appliance", confidence: 0.9 }, volatility: "stable", confidence: 0.9 },
      { id: "f-exp", itemIds: ["field-warrantyexpiration"], label: "Warranty Expiration", value: "2029-03-11", roles: ["actionable_date"], subject: { entityRef: "e-appliance", confidence: 0.9 }, volatility: "changeable", confidence: 0.9 },
      { id: "f-purchase", itemIds: ["field-purchasedate"], label: "Purchase Date", value: "2026-03-11", roles: ["reference_only"], subject: { entityRef: "e-appliance", confidence: 0.9 }, volatility: "historical", confidence: 0.9 },
    ],
    recurrences: [],
    narrative: [],
  },
  expectations: { referenceOnlyItemIds: ["field-purchasedate"], destinations: ["calendar"] },
};

// ═══════════════════════════════════════════════════════════════════════════
// 11. A document nobody wrote a rule for.
//
// This is the fixture that proves the engine is universal. It is a boat club
// membership certificate: no branch anywhere handles it, no key here matches a
// medical or insurance pattern, and the engine must STILL produce subjects,
// roles and actions instead of dumping every field onto a profile.
// ═══════════════════════════════════════════════════════════════════════════

export const unrecognizedDocument: DocumentFixture = {
  name: "unrecognized — boat club membership",
  primaryProfileId: "person-1",
  items: [
    item("membershipNumber", "Membership Number", "BC-77413"),
    item("slipAssignment", "Slip Assignment", "Dock C, Slip 19"),
    item("duesAmount", "Dues", "310.00"),
    item("duesSchedule", "Dues Schedule", "Quarterly"),
    item("nextDuesDate", "Next Dues Date", "2026-10-01"),
    item("membershipExpires", "Membership Expires", "2027-04-01"),
    item("certificateIssued", "Certificate Issued", "2026-07-02"),
  ],
  index: { ...emptyIndex(), profiles: [profile("person-1", "self", "Sarah Miller")] },
  semantic: {
    documentType: "Boat Club Membership Certificate",
    primarySubject: "e-person",
    confidence: 0.82,
    summary: "Quarterly-dues membership with a slip assignment.",
    entities: [
      { ref: "e-person", kind: "person", name: "Sarah Miller", identifiers: {}, confidence: 0.88 },
      { ref: "e-club", kind: "organization", name: "Harbor Point Boat Club", identifiers: { membershipNumber: "BC-77413" }, role: "issuer", confidence: 0.85 },
    ],
    relationships: [{ from: "e-person", to: "e-club", type: "pays", confidence: 0.82 }],
    facts: [
      { id: "f-slip", itemIds: ["field-slipassignment"], label: "Slip Assignment", value: "Dock C, Slip 19", roles: ["profile_data"], subject: { entityRef: "e-person", confidence: 0.8 }, volatility: "changeable", confidence: 0.8 },
      { id: "f-dues", itemIds: ["field-duesamount"], label: "Dues", value: 310, roles: ["financial", "recurring_obligation"], subject: { entityRef: "e-person", confidence: 0.85 }, volatility: "changeable", confidence: 0.85 },
      { id: "f-schedule", itemIds: ["field-duesschedule"], label: "Dues Schedule", value: "Quarterly", roles: ["recurring_obligation"], subject: { entityRef: "e-person", confidence: 0.85 }, volatility: "changeable", confidence: 0.85 },
      { id: "f-next", itemIds: ["field-nextduesdate"], label: "Next Dues Date", value: "2026-10-01", roles: ["recurring_obligation", "actionable_date"], subject: { entityRef: "e-person", confidence: 0.85 }, volatility: "changeable", confidence: 0.85 },
      { id: "f-expires", itemIds: ["field-membershipexpires"], label: "Membership Expires", value: "2027-04-01", roles: ["actionable_date"], subject: { entityRef: "e-person", confidence: 0.85 }, volatility: "changeable", confidence: 0.85 },
      { id: "f-issued", itemIds: ["field-certificateissued"], label: "Certificate Issued", value: "2026-07-02", roles: ["reference_only"], subject: { entityRef: "e-person", confidence: 0.85 }, volatility: "historical", confidence: 0.85 },
    ],
    recurrences: [{
      id: "r-dues", factIds: ["f-dues", "f-schedule", "f-next"], label: "Boat club dues",
      subjectRef: "e-person", cadence: "quarterly", amountPerOccurrence: 310,
      nextOccurrence: "2026-10-01", endsOn: "2027-04-01", stated: "per_occurrence", confidence: 0.84,
    }],
    narrative: [],
  },
  expectations: {
    obligations: 1,
    referenceOnlyItemIds: ["field-certificateissued"],
    destinations: ["obligation", "calendar"],
  },
};

export const ALL_FIXTURES: DocumentFixture[] = [
  insuranceDeclarations,
  medicalReport,
  receipt,
  parkingTicket,
  loanStatement,
  deed,
  prescription,
  lease,
  taxRecord,
  warranty,
  unrecognizedDocument,
];
