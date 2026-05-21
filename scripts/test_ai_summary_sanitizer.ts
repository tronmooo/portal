// Unit test for the AI summary sanitizer (server/routes.ts).
//
// What this verifies (the actual bug Bob Robertson exposed):
//   1. When the profile has NO birthday/dateOfBirth/dob anywhere
//      (top-level OR nested), every linked document's extractedData
//      gets its `dateOfBirth` / `date_of_birth` / `dob` / `birthDate`
//      / `birth_date` / `DOB` stripped before being sent to the AI.
//   2. When the profile DOES have a birthday somewhere (top-level OR
//      a nested group like `personal.dateOfBirth`), the sanitizer is
//      a no-op and documents keep their DOB so the AI can use it for
//      the summary.
//   3. The same logic applies to `age` and `ssn` families.
//   4. The original document/profile objects are NOT mutated — we
//      always operate on a deep clone (defense-in-depth, since the
//      caller passes the live `detail` object).
//
// Run: npx tsx scripts/test_ai_summary_sanitizer.ts
// No DB, no network. Exits 1 on any failure.

import { computeAiSensitiveStripKeys, deepStripKeys } from "../server/ai-summary-sanitizer.js";

let failed = 0;
function expect(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.log(`  FAIL  ${msg}`);
    failed++;
  }
}

console.log("── Bob Robertson shape: NO birthday on profile, DOB in license docs");
{
  // Mirrors Bob's actual stored fields after the user deleted birthday.
  const bobFields = {
    name: "BOB ROBERTSON",
    state: "NP",
    height: "5'10\"",
    weight: 180,
    address: "FAKE ST, ANCHORAGE, NP 99501",
    license: "D9876543",
    identity: { issueDate: "2026-02-04", licenseNumber: "D9876543", expirationDate: "2030-02-04" },
    personal: { name: "BOB ROBERTSON", state: "NP", height: "5'10\"", weight: 180 },
    issueDate: "2026-02-04",
    licenseNumber: "D9876543",
    expirationDate: "2030-02-04",
    licenseExpiration: "2030-02-04",
    other: { stateName: "NEW PACIFICA" },
  };
  const docs = [
    {
      name: "New Pacifica Driver License - Bob Robertson",
      type: "drivers_license",
      extractedData: {
        name: "BOB ROBERTSON",
        state: "NP",
        height: "5'10\"",
        weight: 180,
        dateOfBirth: "1980-07-15",
        licenseNumber: "D9876543",
        expirationDate: "2030-02-04",
      },
    },
    {
      name: "Driver License - Bob Robertson",
      type: "drivers_license",
      extractedData: {
        name: "BOB ROBERTSON",
        dateOfBirth: "07/15/1980",
        dob: "07/15/1980",
        birthDate: "1980-07-15",
        licenseNumber: "D9876543",
      },
    },
  ];

  const strip = computeAiSensitiveStripKeys(bobFields);
  expect(strip.has("dateOfBirth"), "strip set includes dateOfBirth");
  expect(strip.has("date_of_birth"), "strip set includes date_of_birth");
  expect(strip.has("dob"), "strip set includes dob");
  expect(strip.has("DOB"), "strip set includes DOB");
  expect(strip.has("birthDate"), "strip set includes birthDate");
  expect(strip.has("birth_date"), "strip set includes birth_date");
  expect(strip.has("birthday"), "strip set includes birthday");
  // SSN/age also missing on Bob → also stripped
  expect(strip.has("ssn"), "strip set includes ssn (also missing on profile)");
  expect(strip.has("age"), "strip set includes age (also missing on profile)");

  const sanitizedDocs = docs.map((d) => ({ ...d, extractedData: deepStripKeys(d.extractedData, strip) }));
  for (const d of sanitizedDocs) {
    expect(!("dateOfBirth" in d.extractedData), `doc "${d.name}": dateOfBirth stripped`);
    expect(!("dob" in d.extractedData), `doc "${d.name}": dob stripped`);
    expect(!("birthDate" in d.extractedData), `doc "${d.name}": birthDate stripped`);
    // Everything else preserved
    expect(d.extractedData.licenseNumber === "D9876543", `doc "${d.name}": licenseNumber preserved`);
  }

  // Original docs unchanged
  expect(docs[0].extractedData.dateOfBirth === "1980-07-15", "original doc[0].extractedData.dateOfBirth NOT mutated");
  expect(docs[1].extractedData.dob === "07/15/1980", "original doc[1].extractedData.dob NOT mutated");
}

console.log("\n── Profile WITH top-level birthday: sanitizer is a no-op for DOB");
{
  const fields = { name: "Alice", birthday: "1990-01-01", phone: "555-1212" };
  const strip = computeAiSensitiveStripKeys(fields);
  expect(!strip.has("birthday"), "top-level birthday present → birthday NOT stripped");
  expect(!strip.has("dateOfBirth"), "top-level birthday present → dateOfBirth NOT stripped");
  expect(!strip.has("dob"), "top-level birthday present → dob NOT stripped");
}

console.log("\n── Profile with ONLY nested personal.dateOfBirth: also a no-op for DOB");
{
  const fields = { name: "Carol", personal: { dateOfBirth: "1975-05-20" } };
  const strip = computeAiSensitiveStripKeys(fields);
  expect(!strip.has("dateOfBirth"), "nested personal.dateOfBirth present → not stripped");
  expect(!strip.has("birthday"), "nested personal.dateOfBirth present → birthday alias not stripped");
}

console.log("\n── Profile with empty-string birthday: TREATED AS MISSING (so DOB IS stripped)");
{
  const fields = { name: "Dave", birthday: "", personal: { dateOfBirth: null } };
  const strip = computeAiSensitiveStripKeys(fields);
  expect(strip.has("dateOfBirth"), "empty birthday + null nested → dateOfBirth stripped");
  expect(strip.has("birthday"), "empty birthday + null nested → birthday stripped");
}

console.log("\n── deepStripKeys: deeply nested objects + arrays");
{
  const input = {
    a: 1,
    dateOfBirth: "1980-01-01",
    nested: {
      b: 2,
      dateOfBirth: "1980-01-01",
      deep: { c: 3, dob: "1980-01-01" },
    },
    list: [
      { name: "x", dateOfBirth: "1980-01-01" },
      { name: "y" },
    ],
  };
  const drop = new Set(["dateOfBirth", "dob"]);
  const out = deepStripKeys(input, drop);
  expect(out.a === 1, "top-level a preserved");
  expect(!("dateOfBirth" in out), "top-level dateOfBirth stripped");
  expect(out.nested.b === 2, "nested.b preserved");
  expect(!("dateOfBirth" in out.nested), "nested.dateOfBirth stripped");
  expect(out.nested.deep.c === 3, "nested.deep.c preserved");
  expect(!("dob" in out.nested.deep), "nested.deep.dob stripped");
  expect(out.list[0].name === "x", "list[0].name preserved");
  expect(!("dateOfBirth" in out.list[0]), "list[0].dateOfBirth stripped");
  // Original NOT mutated
  expect(input.dateOfBirth === "1980-01-01", "original.dateOfBirth NOT mutated");
  expect(input.nested.deep.dob === "1980-01-01", "original.nested.deep.dob NOT mutated");
}

console.log("\n── deepStripKeys: handles null / undefined / primitives gracefully");
{
  const drop = new Set(["x"]);
  expect(deepStripKeys(null, drop) === null, "null passthrough");
  expect(deepStripKeys(undefined, drop) === undefined, "undefined passthrough");
  expect(deepStripKeys(5, drop) === 5, "number passthrough");
  expect(deepStripKeys("hello", drop) === "hello", "string passthrough");
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(failed === 0 ? "✅ ALL PASS" : `❌ ${failed} assertion(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
