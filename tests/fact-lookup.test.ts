// tests/fact-lookup.test.ts — TIER 1 deterministic fact retrieval.
//
// The contract this pins has two halves, and the SECOND half matters more:
//   1. An unambiguous single-fact read is answered from stored data.
//   2. Everything else ESCALATES. A wrong fast answer about the user's own
//      records is far worse than a slow correct one, so every gate is tested
//      from the "must decline" side too.

import { describe, it, expect } from "vitest";
import {
  detectFactQuestion,
  lookupStoredFact,
  resolveFact,
  type FactSources,
} from "../shared/fact-lookup";

// ── Fixtures ────────────────────────────────────────────────────────────────

const REGISTRATION = {
  id: "doc-reg",
  name: "2021 Honda CR-V Registration",
  type: "vehicle_registration",
  extractedData: {
    licensePlate: "8YPJ480",
    vin: "2HKRW2H85MH000123",
    registeredOwner: "Robert Sennabaum",
    expirationDate: "2027-03-14",
  },
  ownerNames: ["Robert Sennabaum"],
};

const DRIVERS_LICENSE = {
  id: "doc-dl",
  name: "Robert Sennabaum Driver's License",
  type: "drivers_license",
  extractedData: {
    licenseNumber: "D1234567",
    dateOfBirth: "1985-06-02",
    expirationDate: "2029-06-02",
  },
  ownerNames: ["Robert Sennabaum"],
};

const SELF_PROFILE = {
  id: "p-self",
  name: "Robert Sennabaum",
  type: "self",
  fields: {
    phone: "415-555-0182",
    email: "robert@example.com",
    homeAddress: "12 Blithedale Ave, Mill Valley, CA",
    birthday: "1985-06-02",
  },
};

const VEHICLE_PROFILE = {
  id: "p-crv",
  name: "2021 Honda CR-V",
  type: "vehicle",
  fields: { currentValue: "24500", make: "Honda", model: "CR-V", color: "blue" },
};

const MORTGAGE = {
  id: "p-mortgage",
  name: "Mill Valley Mortgage",
  type: "liability",
  type_key: "mortgage",
  fields: { balance: "612000", monthlyPayment: "4180", lender: "Chase" },
};

const WEIGHT_TRACKER = {
  id: "t-weight",
  name: "Weight",
  category: "health",
  entries: [
    { date: "2026-08-30", values: { weight: 181 } },
    { date: "2026-09-03", values: { weight: 179.4 } },
  ],
};

const SOURCES: FactSources = {
  profiles: [SELF_PROFILE, VEHICLE_PROFILE, MORTGAGE] as any,
  documents: [REGISTRATION, DRIVERS_LICENSE] as any,
  trackers: [WEIGHT_TRACKER] as any,
};

const ask = (q: string) => lookupStoredFact(q, SOURCES);

// ── Detection gate ──────────────────────────────────────────────────────────

describe("detectFactQuestion — only single-fact reads get in", () => {
  it("accepts a plain identifier question", () => {
    expect(detectFactQuestion("What is my license plate number?")).not.toBeNull();
    expect(detectFactQuestion("what's my VIN")).not.toBeNull();
    expect(detectFactQuestion("when does my registration expire")).not.toBeNull();
  });

  it("rejects anything with a mutation signal", () => {
    expect(detectFactQuestion("update my license plate to 9ABC123")).toBeNull();
    expect(detectFactQuestion("what's my plate — also log a coffee")).toBeNull();
    expect(detectFactQuestion("delete my registration document")).toBeNull();
  });

  it("rejects reasoning and synthesis", () => {
    expect(detectFactQuestion("why is my car insurance so expensive")).toBeNull();
    expect(detectFactQuestion("what's my average weight this month")).toBeNull();
    expect(detectFactQuestion("compare my mortgage to my car loan")).toBeNull();
  });

  it("rejects list/aggregate asks", () => {
    expect(detectFactQuestion("what are all my policy numbers")).toBeNull();
    expect(detectFactQuestion("how many documents do I have")).toBeNull();
  });

  it("rejects non-questions and long messages", () => {
    expect(detectFactQuestion("hey there")).toBeNull();
    expect(detectFactQuestion("I was thinking about the registration for the CR-V that we bought back in twenty twenty one")).toBeNull();
  });
});

// ── The reported bug: license plate ─────────────────────────────────────────

describe("the 2026-09 report — a stored identifier answers without the model", () => {
  it("answers the license plate from the registration", () => {
    const out = ask("What is my license plate number?");
    expect(out.answer).not.toBeNull();
    expect(out.answer!.candidate.value).toBe("8YPJ480");
    expect(out.answer!.candidate.source).toBe("document_field");
    expect(out.answer!.reply).toContain("8YPJ480");
  });

  it("answers the VIN, and does NOT answer it with the plate", () => {
    const out = ask("what's my VIN?");
    expect(out.answer!.candidate.value).toBe("2HKRW2H85MH000123");
    expect(out.answer!.reply).not.toContain("8YPJ480");
  });

  it("keeps the driver's-license/plate separation the older fix established", () => {
    const out = ask("what is my driver's license number?");
    expect(out.answer!.candidate.value).toBe("D1234567");
    expect(out.answer!.reply).not.toContain("8YPJ480");
  });

  it("answers a profile field with no document involved", () => {
    const out = ask("what's my phone number?");
    expect(out.answer!.candidate.source).toBe("profile_field");
    expect(out.answer!.candidate.value).toBe("415-555-0182");
  });
});

// ── Typed record values ─────────────────────────────────────────────────────

describe("typed values — asset worth, liability balance, payment", () => {
  it("answers what a named asset is worth", () => {
    const out = ask("what is my Honda CR-V worth?");
    expect(out.answer!.candidate.source).toBe("asset_value");
    expect(out.answer!.candidate.value).toContain("24,500");
  });

  it("answers a named liability balance", () => {
    const out = ask("what's my Mill Valley Mortgage balance?");
    expect(out.answer!.candidate.source).toBe("liability_balance");
    expect(out.answer!.candidate.value).toContain("612,000");
  });

  it("answers a named monthly payment", () => {
    const out = ask("what is my Mill Valley Mortgage payment?");
    expect(out.answer!.candidate.source).toBe("liability_payment");
    expect(out.answer!.candidate.value).toContain("4,180");
  });

  it("declines an unscoped balance question — that is a dashboard aggregate", () => {
    expect(ask("what's my balance?").answer).toBeNull();
  });
});

// ── Trackers ────────────────────────────────────────────────────────────────

describe("tracker latest value", () => {
  it("answers the latest entry of a named tracker", () => {
    const out = ask("what's my latest weight?");
    expect(out.answer!.candidate.source).toBe("tracker_latest");
    expect(out.answer!.candidate.value).toContain("179.4");
  });

  it("uses the newest entry, not the first", () => {
    expect(ask("what's my latest weight?").answer!.candidate.value).not.toContain("181");
  });
});

// ── The escalation gates (the important half) ───────────────────────────────

describe("ambiguity must escalate, never guess", () => {
  it("declines when two people hold the same field and no name is given", () => {
    const two: FactSources = {
      ...SOURCES,
      profiles: [
        SELF_PROFILE,
        { id: "p-jane", name: "Jane Doe", type: "person", fields: { phone: "415-555-0999" } },
      ] as any,
      documents: [],
    };
    const out = lookupStoredFact("what's my phone number?", two);
    expect(out.answer).toBeNull();
    expect(out.missReason).toBe("ambiguous");
  });

  it("answers once the name disambiguates it", () => {
    const two: FactSources = {
      ...SOURCES,
      profiles: [
        SELF_PROFILE,
        { id: "p-jane", name: "Jane Doe", type: "person", fields: { phone: "415-555-0999" } },
      ] as any,
      documents: [],
    };
    const out = lookupStoredFact("what is Jane's phone number?", two);
    expect(out.answer!.candidate.value).toBe("415-555-0999");
  });

  it("declines when nothing is stored", () => {
    const empty: FactSources = { profiles: [], documents: [], trackers: [] };
    const out = lookupStoredFact("what is my passport number?", empty);
    expect(out.answer).toBeNull();
    expect(out.missReason === "no_candidate" || out.missReason === "low_confidence").toBe(true);
  });

  it("treats identical values from several sources as corroboration, not ambiguity", () => {
    const corroborated: FactSources = {
      profiles: [SELF_PROFILE] as any,
      documents: [DRIVERS_LICENSE] as any,
      trackers: [],
    };
    const out = lookupStoredFact("what is my date of birth?", corroborated);
    expect(out.answer).not.toBeNull();
    expect(out.answer!.candidate.value).toBe("1985-06-02");
  });

  it("never answers on a placeholder value", () => {
    const placeholder: FactSources = {
      profiles: [{ id: "p1", name: "Me", type: "self", fields: { policyNumber: "N/A" } }] as any,
      documents: [],
      trackers: [],
    };
    expect(lookupStoredFact("what's my policy number?", placeholder).answer).toBeNull();
  });

  it("never answers from prose stuffed into a field", () => {
    const prose: FactSources = {
      profiles: [{ id: "p1", name: "Me", type: "self", fields: { policyNumber: "x".repeat(400) } }] as any,
      documents: [],
      trackers: [],
    };
    expect(lookupStoredFact("what's my policy number?", prose).answer).toBeNull();
  });

  it("reports a miss reason for every decline, so a slow turn is explainable", () => {
    for (const q of ["update my plate", "why is my car worth that", "what's my balance?"]) {
      const out = lookupStoredFact(q, SOURCES);
      expect(out.answer).toBeNull();
      expect(out.missReason).toBeTruthy();
    }
  });
});

// ── Purity ──────────────────────────────────────────────────────────────────

describe("the resolver is pure", () => {
  it("does not mutate the sources it is given", () => {
    const before = JSON.stringify(SOURCES);
    ask("what is my license plate number?");
    ask("what's my VIN");
    ask("what's my latest weight");
    expect(JSON.stringify(SOURCES)).toBe(before);
  });

  it("resolveFact is deterministic across repeated calls", () => {
    const q = detectFactQuestion("what is my license plate number?")!;
    const a = resolveFact(q, SOURCES, { originalMessage: "what is my license plate number?" });
    const b = resolveFact(q, SOURCES, { originalMessage: "what is my license plate number?" });
    expect(a.answer!.candidate.value).toBe(b.answer!.candidate.value);
  });
});
