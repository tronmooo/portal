// "My Information": what Fill In may put on a form, and the rules that keep
// it honest (shared/fill-info.ts). Owner request 2026-11-23.
import { describe, it, expect } from "vitest";
import {
  buildFillFacts, canonicalKeyFor, factFitsKind, formatFormDate, groundValue, isSensitiveLabel, maskValue, matchLabelToFacts,
  parseLooseDate, searchFacts, splitAddress, type FillFact,
} from "../shared/fill-info";
import { sanitizeFields, serializeFields } from "../shared/fill-fields";

const self = { id: "p-me", type: "self", name: "Jordan A. Lee", fields: { phone: "(555) 010-2299", email: "jordan@example.com", password: "hunter2" }, updatedAt: "2026-10-01T00:00:00Z" };
const spouse = { id: "p-sam", type: "person", name: "Sam Lee", relationship: "spouse", fields: { phone: "(555) 010-7700", address: "9 Other Rd, Elsewhere, NY 10001" } };
const car = { id: "p-car", type: "asset", name: "Honda CR-V", fields: { vin: "2HKRW2H5XNH600001", licensePlate: "8ABC123", year: 2022 } };
const licence = {
  id: "d-lic", name: "Driver's License.jpg", type: "drivers_license", createdAt: "2026-03-01T00:00:00Z", linkedProfiles: [],
  extractedData: { fullName: "Jordan A. Lee", address: "123 Main St, Springfield, IL 62704", dateOfBirth: "1990-03-04", licenseNumber: "L600-4412-9087", expirationDate: "2029-03-04" },
};
const resume = {
  id: "d-cv", name: "Resume 2025.pdf", type: "saved", createdAt: "2025-06-01T00:00:00Z", linkedProfiles: [],
  extractedData: { fillIndex: { indexedAt: "2026-11-23T00:00:00Z", data: JSON.stringify({
    documentType: "Résumé", facts: { "Full name": "Jordan A. Lee", Email: "jordan@example.com" },
    records: {
      employment: [{ employer: "Northwind Traders", jobTitle: "Warehouse Lead", startDate: "2019", endDate: "Present" }, { employer: "Contoso Freight", jobTitle: "Picker", startDate: "2015", endDate: "2019" }],
      education: [{ school: "Springfield Community College", degree: "A.S. Logistics", graduationDate: "2015" }],
    },
    skills: ["Forklift certified", "Inventory audits"],
  }) } },
};
const facts = () => buildFillFacts({ profiles: [self, spouse, car], documents: [licence, resume], notes: [{ id: "n1", title: "Home", content: "Landlord: Pat Murphy\nJust a sentence without a label.\n- Wifi password: nope" }] });
const find = (list: FillFact[], label: RegExp) => list.filter((f) => label.test(f.label));

describe("the list of facts", () => {
  it("is built from profiles, every upload (old ones and ones read later), and notes — each with its source", () => {
    const list = facts();
    expect(find(list, /^Address$/)[0]).toMatchObject({ value: "123 Main St, Springfield, IL 62704", category: "Contact", source: { kind: "document", id: "d-lic", name: "Driver's License" }, reliability: 3 });
    expect(find(list, /^Phone$/)[0]).toMatchObject({ value: "(555) 010-2299", source: { name: "My profile" } });
    expect(find(list, /^Employer \(1\)$/)[0]).toMatchObject({ value: "Northwind Traders", category: "Employment", key: "employer", source: { name: "Resume 2025" } });
    expect(find(list, /^Employer \(2\)$/)[0].value).toBe("Contoso Freight");
    expect(find(list, /^School \(1\)$/)[0]).toMatchObject({ category: "Education", key: "school" });
    expect(find(list, /^Skills$/)[0].value).toBe("Forklift certified, Inventory audits");
    expect(find(list, /^Landlord$/)[0]).toMatchObject({ value: "Pat Murphy", source: { kind: "note", name: "Home" }, reliability: 1 });
    expect(find(list, /Honda CR-V — vin/)[0]).toMatchObject({ category: "Assets", subject: "Honda CR-V", key: "vin" });
  });

  it("works out name parts and address parts, marked as derived", () => {
    const list = facts();
    expect(find(list, /^First name$/)[0]).toMatchObject({ value: "Jordan", derived: true });
    expect(find(list, /^Last name$/)[0].value).toBe("Lee");
    expect(find(list, /^City$/)[0]).toMatchObject({ value: "Springfield", derived: true, source: { name: "Driver's License" } });
    expect(find(list, /^ZIP code$/)[0].value).toBe("62704");
    expect(splitAddress("no commas here")).toBeNull();
  });

  it("never lists a password, and marks identity numbers sensitive", () => {
    const list = facts();
    expect(list.some((f) => /hunter2|nope/.test(f.value))).toBe(false);
    const lic = find(list, /^License number$/)[0];
    expect(lic.sensitive).toBe(true);
    expect(maskValue(lic.value)).toBe("••••••••9087");
    expect(isSensitiveLabel("Social Security Number")).toBe(true);
    expect(isSensitiveLabel("City")).toBe(false);
  });

  it("another person's details are listed under their name and never answer a plain 'Phone' or 'Address'", () => {
    const list = facts();
    expect(find(list, /Sam Lee \(spouse\) — phone/)[0]).toMatchObject({ key: null, category: "Contact", value: "(555) 010-7700" });
    expect(matchLabelToFacts("Phone", list, "p-me")!.fact.value).toBe("(555) 010-2299");
    expect(matchLabelToFacts("Address", list, "p-me")!.fact.value).toBe("123 Main St, Springfield, IL 62704");
    // Filled FOR Sam: Sam's own address answers, not the account holder's.
    const forSam = buildFillFacts({ profiles: [self, spouse, car], documents: [licence, resume], forProfileId: "p-sam" });
    expect(matchLabelToFacts("Address", forSam, "p-sam")!.fact.value).toBe("9 Other Rd, Elsewhere, NY 10001");
    expect(forSam.some((f) => f.key === "address" && f.value.startsWith("123 Main"))).toBe(false);
  });

  it("a completed form and its blank original are never sources", () => {
    const list = buildFillFacts({ profiles: [self], documents: [
      { id: "d1", name: "Lease — Completed", type: "smart_fill", tags: ["smart-fill"], extractedData: { address: "WRONG 1" } },
      { id: "d2", name: "Lease (blank form)", tags: ["fill-original"], extractedData: { address: "WRONG 2" } },
      { id: "d3", name: "Trashed", deletedAt: "2026-01-01", extractedData: { address: "WRONG 3" } },
    ] });
    expect(list.some((f) => /WRONG/.test(f.value))).toBe(false);
  });
});

describe("matching a form label", () => {
  it("understands what a label means", () => {
    expect(canonicalKeyFor("Applicant's Name:")).toBe("fullName");
    expect(canonicalKeyFor("Date of Birth")).toBe("dateOfBirth");
    expect(canonicalKeyFor("ZIP / Postal Code")).toBe("zip");
    expect(canonicalKeyFor("Tag Number")).toBe("licensePlate");
    expect(canonicalKeyFor("Mailing Address")).toBe("address");
    expect(canonicalKeyFor("Favourite colour of your first pet")).toBeNull();
    const list = facts();
    expect(matchLabelToFacts("Current Employer", list, "p-me")!.fact.value).toBe("Northwind Traders");
    expect(matchLabelToFacts("VIN", list, "p-me")!.fact.value).toBe("2HKRW2H5XNH600001");
    expect(matchLabelToFacts("Blood type", list, "p-me")).toBeNull();
  });

  it("two different values on file: the person's own profile and identity papers outrank other papers, newer first — and the others are offered", () => {
    const bill = { id: "d-bill", name: "Utility bill.pdf", type: "utility_bill", createdAt: "2026-09-01T00:00:00Z", extractedData: { address: "77 Old Lane, Shelbyville, IL 62565" } };
    const list = buildFillFacts({ profiles: [self], documents: [bill, licence] });
    const m = matchLabelToFacts("Address", list, "p-me")!;
    expect(m.fact).toMatchObject({ value: "123 Main St, Springfield, IL 62704", source: { name: "Driver's License" } });
    expect(m.alternatives.map((a) => `${a.value} · ${a.source.name}`)).toEqual(["77 Old Lane, Shelbyville, IL 62565 · Utility bill"]);
    // The user's own profile wins over both.
    const own = buildFillFacts({ profiles: [{ ...self, fields: { address: "500 New St, Chicago, IL 60601" } }], documents: [bill, licence] });
    expect(matchLabelToFacts("Address", own, "p-me")!.fact.source.name).toBe("My profile");
  });
});

describe("never invent", () => {
  const cited = [
    { value: "123 Main St, Springfield, IL 62704" }, { value: "Jordan A. Lee" }, { value: "1990-03-04" },
  ] as FillFact[];
  it("a value must be made of what the cited facts say", () => {
    expect(groundValue("Springfield", cited)).toBe(true);
    expect(groundValue("Lee, Jordan A.", cited)).toBe(true);
    expect(groundValue("03/04/1990", cited)).toBe(true);
    expect(groundValue("March 4, 1990", cited)).toBe(true);
    expect(groundValue("(555) 010-2299", cited)).toBe(false); // a plausible phone number nobody has on file
    expect(groundValue("124 Main St", cited)).toBe(false);
    expect(groundValue("Jordan", [])).toBe(false);
    expect(groundValue("yes", cited)).toBe(true);
  });
  it("dates are read in the ways people write them and written the way forms want them", () => {
    expect(parseLooseDate("Mar 4, 1990")).toBe("1990-03-04");
    expect(parseLooseDate("3/4/90")).toBe("1990-03-04");
    expect(parseLooseDate("soon")).toBeNull();
    expect(formatFormDate("1990-03-04")).toBe("03/04/1990");
    expect(formatFormDate("Present")).toBe("Present");
  });
});

describe("the panel", () => {
  it("searches labels, values and sources — but never a sensitive value", () => {
    const list = facts();
    expect(searchFacts(list, "springfield").some((f) => f.label === "Address")).toBe(true);
    expect(searchFacts(list, "resume employer").map((f) => f.value)).toEqual(["Northwind Traders", "Contoso Freight"]);
    expect(searchFacts(list, "9087")).toEqual([]);
    expect(searchFacts(list, "license number").length).toBeGreaterThan(0);
  });
  it("knows which fields a fact can go in (what a drag highlights)", () => {
    const list = facts();
    const dob = find(list, /^Date of birth$/)[0];
    const name = find(list, /^Full name$/)[0];
    expect(factFitsKind(dob, "date")).toBe(true);
    expect(factFitsKind(name, "date")).toBe(false);
    expect(factFitsKind(name, "text")).toBe(true);
    expect(factFitsKind(name, "signature")).toBe(false);
    expect(factFitsKind(name, "checkbox")).toBe(false);
  });
});

describe("a stored session", () => {
  it("round-trips, and an unconfirmed sensitive value is not written into it", () => {
    const stored = sanitizeFields(serializeFields([
      { id: "a1", label: "Name", kind: "text", page: 0, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.02 }, origin: "acroform", acroName: "name", value: "Jordan", source: "My profile", filledBy: "structured" },
      { id: "a2", label: "SSN", kind: "text", page: 0, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.02 }, origin: "acroform", acroName: "ssn", value: "123-45-6789", sensitive: true, confirmed: false },
    ]));
    expect(stored[0]).toMatchObject({ id: "a1", acroName: "name", value: "Jordan", source: "My profile", filledBy: "structured" });
    expect(stored[1]).toMatchObject({ id: "a2", value: "", sensitive: true, confirmed: false });
    expect(sanitizeFields("not json")).toEqual([]);
    expect(sanitizeFields([{ id: "z", box: { x: 5, y: -1, w: 9, h: 9 } }])[0].box).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
