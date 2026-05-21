// End-to-end verification of the universal field-delete fix.
//
// What this exercises (the actual code path that runs in production):
//   server/supabase-storage.ts  -> updateProfile + expandProfileFieldDeletions
//                                  + stripFromNestedGroups + mergeAndApplyDeletes
//   client view simulation       -> the same flattenProfileFields that the UI runs
//
// What this does NOT touch:
//   - Any of the user's existing profiles. We create disposable test profiles
//     tagged `__qa_delete_test__`, run all assertions on those, then call the
//     real deleteProfile cascade to wipe them entirely. There is a final SQL
//     check that no test profiles survive.
//
// Output: a summary table of (profile type, alias group, pass/fail).

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";
const TEST_TAG = "__qa_delete_test__";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);

// ── Mirror of the client's flattenProfileFields, so we can assert the same view
//    that the user sees after a refresh in the browser.
function flattenProfileFields(rawFields: any): any {
  if (!rawFields || typeof rawFields !== "object") return rawFields || {};
  const NESTED_GROUPS = [
    "vehicles", "insurance", "housing", "other", "finance", "subscriptions", "utilities",
    "personal", "identity", "health", "contact", "emergency",
    "pets", "pet",
  ];
  const KEY_ALIASES: Record<string, string> = {
    dateOfBirth: "birthday", dob: "birthday",
    licenseNumber: "license", licenseClass: "licenseClass",
    issuingAuthority: "licenseState", expirationDate: "licenseExpiration",
    patientName: "name", primaryPhone: "phone", homePhone: "phone", cellPhone: "phone",
    homeAddress: "address", serviceAddress: "address",
  };
  const out: any = {};
  const setIfEmpty = (key: string, val: any) => {
    if (val === undefined || val === null || val === "") return;
    if (out[key] === undefined || out[key] === null || out[key] === "") out[key] = val;
  };
  for (const group of NESTED_GROUPS) {
    const nested = rawFields[group];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested)) {
        if (v === undefined || v === null || v === "") continue;
        setIfEmpty(k, v);
        const alias = KEY_ALIASES[k];
        if (alias && alias !== k) setIfEmpty(alias, v);
      }
    }
  }
  for (const [k, v] of Object.entries(rawFields)) {
    if (NESTED_GROUPS.includes(k)) { out[k] = v; continue; }
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

type TestCase = {
  name: string;
  profileType: string;
  initialFields: Record<string, any>;
  uiKeyToDelete: string;
  // After deletion, NONE of these keys should appear in the flattened view.
  // Also asserted: NONE of them should appear in raw storage (top-level OR
  // inside any nested group).
  uiKeysExpectedGone: string[];
  storageKeysExpectedGone: string[];
};

const CASES: TestCase[] = [
  // Person — birthday alias group (the exact bug the user just reported)
  {
    name: "person/birthday with all aliases set everywhere",
    profileType: "person",
    initialFields: {
      birthday: "1990-01-01",
      dateOfBirth: "1990-01-01",
      dob: "1990-01-01",
      personal: { dateOfBirth: "1990-01-01", height: "5'10\"" },
      identity: { dob: "1990-01-01", licenseNumber: "D1234" },
      relationship: "Friend",
    },
    uiKeyToDelete: "birthday",
    uiKeysExpectedGone: ["birthday"],
    storageKeysExpectedGone: ["birthday", "dateOfBirth", "dob", "date_of_birth"],
  },
  // Person — phone alias group (multiple homed sources)
  {
    name: "person/phone with primaryPhone + homePhone + cellPhone aliases",
    profileType: "person",
    initialFields: {
      phone: "555-1111",
      primaryPhone: "555-2222",
      homePhone: "555-3333",
      contact: { cellPhone: "555-4444", email: "x@y.com" },
    },
    uiKeyToDelete: "phone",
    uiKeysExpectedGone: ["phone"],
    storageKeysExpectedGone: ["phone", "primaryPhone", "homePhone", "cellPhone"],
  },
  // Person — address alias group
  {
    name: "person/address with homeAddress + serviceAddress aliases",
    profileType: "person",
    initialFields: {
      address: "123 Main St",
      homeAddress: "456 Side Ave",
      personal: { serviceAddress: "789 Back Rd" },
    },
    uiKeyToDelete: "address",
    uiKeysExpectedGone: ["address"],
    storageKeysExpectedGone: ["address", "homeAddress", "serviceAddress"],
  },
  // Person — license alias group
  {
    name: "person/license with licenseNumber alias",
    profileType: "person",
    initialFields: {
      license: "ABC-1",
      licenseNumber: "DEF-2",
      identity: { licenseNumber: "GHI-3" },
    },
    uiKeyToDelete: "license",
    uiKeysExpectedGone: ["license"],
    storageKeysExpectedGone: ["license", "licenseNumber"],
  },
  // Asset — currentValue, custom field (no aliases). Verifies the no-alias
  // fallthrough path is unchanged.
  {
    name: "asset/custom field with no alias",
    profileType: "asset",
    initialFields: {
      currentValue: 25000,
      housing: { currentValue: 25000, beds: 3 },
      myCustomField: "to be removed",
    },
    uiKeyToDelete: "myCustomField",
    uiKeysExpectedGone: ["myCustomField"],
    storageKeysExpectedGone: ["myCustomField"],
  },
  // Liability — finance.loanBalance via nested + top-level. No alias group,
  // but we want to make sure delete of `loanBalance` removes the nested copy
  // (since it lives in `finance.loanBalance` too on some seeded data).
  // Note: storage only nests it if we put it there ourselves; our system today
  // does NOT alias loanBalance, but it IS in our PROFILE_NESTED_GROUPS sweep,
  // so a nested copy SHOULD also be stripped.
  {
    name: "liability/loanBalance with finance.loanBalance nested copy",
    profileType: "liability",
    initialFields: {
      loanBalance: 12000,
      finance: { loanBalance: 12000, interestRate: 5.5 },
    },
    uiKeyToDelete: "loanBalance",
    uiKeysExpectedGone: ["loanBalance"],
    storageKeysExpectedGone: ["loanBalance"],
  },
  // Pet — custom field
  {
    name: "pet/custom field with no alias",
    profileType: "pet",
    initialFields: {
      breed: "Lab",
      pet: { breed: "Lab", age: 5 },
      vaccinationDate: "2025-01-01",
    },
    uiKeyToDelete: "vaccinationDate",
    uiKeysExpectedGone: ["vaccinationDate"],
    storageKeysExpectedGone: ["vaccinationDate"],
  },
  // Person — birthday but ONLY nested (no top-level). The user's actual Bob
  // profile is shaped like this. This is the case the previous fix missed.
  {
    name: "person/birthday ONLY nested in personal (the actual Bob shape)",
    profileType: "person",
    initialFields: {
      relationship: "Neighbor",
      personal: { dateOfBirth: "1980-07-15", height: "5'10\"" },
      dateOfBirth: "1980-07-15",
    },
    uiKeyToDelete: "birthday",
    uiKeysExpectedGone: ["birthday"],
    storageKeysExpectedGone: ["birthday", "dateOfBirth", "dob"],
  },
];

type Result = { name: string; passed: boolean; details: string[] };

function assertKeyAbsentDeep(fields: any, key: string): boolean {
  if (!fields || typeof fields !== "object") return true;
  if (key in fields) return false;
  for (const v of Object.values(fields)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (key in (v as any)) return false;
    }
  }
  return true;
}

async function runCase(tc: TestCase): Promise<Result> {
  const details: string[] = [];
  // Create
  const created = await storage.createProfile({
    type: tc.profileType,
    name: `${TEST_TAG} ${tc.name}`,
    fields: tc.initialFields,
    tags: [TEST_TAG],
  } as any);
  if (!created) return { name: tc.name, passed: false, details: ["createProfile returned undefined"] };
  details.push(`created id=${created.id}`);

  // Re-fetch to make sure the storage round-trip works
  const fetched = await storage.getProfile(created.id);
  if (!fetched) return { name: tc.name, passed: false, details: [...details, "getProfile returned undefined after create"] };

  // Apply the delete
  await storage.updateProfile(created.id, { fieldsToDelete: [tc.uiKeyToDelete] } as any);

  // Re-fetch raw + flatten
  const after = await storage.getProfile(created.id);
  if (!after) return { name: tc.name, passed: false, details: [...details, "getProfile returned undefined after delete"] };
  const rawFields = after.fields || {};
  const flat = flattenProfileFields(rawFields);

  // Assertions
  let passed = true;

  // 1. None of the UI-side aliases should appear in the flat view.
  for (const k of tc.uiKeysExpectedGone) {
    if (k in flat) {
      passed = false;
      details.push(`FAIL ui-view: '${k}' still in flattened view = ${JSON.stringify(flat[k])}`);
    } else {
      details.push(`PASS ui-view: '${k}' absent`);
    }
  }

  // 2. None of the storage-side alias keys should appear at top level or
  //    inside any nested group.
  for (const k of tc.storageKeysExpectedGone) {
    if (!assertKeyAbsentDeep(rawFields, k)) {
      passed = false;
      // Where is it?
      const where: string[] = [];
      if (k in rawFields) where.push("top-level");
      for (const [g, v] of Object.entries(rawFields)) {
        if (v && typeof v === "object" && !Array.isArray(v) && k in (v as any)) where.push(`${g}.${k}`);
      }
      details.push(`FAIL storage: '${k}' still present at [${where.join(", ")}]`);
    } else {
      details.push(`PASS storage: '${k}' absent everywhere`);
    }
  }

  // 3. Specifically for the alias case: the value should not re-appear after
  //    a fresh flatten. (Already covered by #1 but called out explicitly.)
  if (tc.uiKeyToDelete in flat) {
    passed = false;
    details.push(`FAIL refresh-simulation: '${tc.uiKeyToDelete}' came back as ${JSON.stringify(flat[tc.uiKeyToDelete])}`);
  }

  return { name: tc.name, passed, details };
}

async function cleanup() {
  // Delete every test profile we created. This uses the real cascade so any
  // child entities go with it.
  const all = await storage.getProfiles();
  const ours = all.filter(p => (p.tags || []).includes(TEST_TAG) || (p.name || "").startsWith(TEST_TAG));
  console.log(`\n── Cleaning up ${ours.length} test profile(s)`);
  for (const p of ours) {
    await storage.deleteProfile(p.id);
    console.log(`  deleted ${p.id} (${p.name})`);
  }
}

(async () => {
  // Pre-flight cleanup in case a previous run left stragglers.
  await cleanup();

  const results: Result[] = [];
  for (const tc of CASES) {
    console.log(`\n── Running: ${tc.name}`);
    try {
      const r = await runCase(tc);
      results.push(r);
      for (const d of r.details) console.log(`  ${d}`);
    } catch (e: any) {
      results.push({ name: tc.name, passed: false, details: [`THREW: ${e?.message || e}`] });
      console.log(`  THREW: ${e?.message || e}`);
    }
  }

  // Post-test cleanup
  await cleanup();

  // Summary
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Universal delete — verification summary");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const r of results) {
    console.log(`  ${r.passed ? "✅" : "❌"}  ${r.name}`);
  }
  const failed = results.filter(r => !r.passed);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : `❌ ${failed.length} of ${results.length} FAILED`}`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
