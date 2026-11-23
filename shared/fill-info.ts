// "My Information" — everything Fill In may put on a form, as one list of
// FACTS (owner request 2026-11-23: "Fill-In should be able to retrieve
// information from every file, document, profile and record … Users should not
// have to upload the same information repeatedly").
//
// A fact is a labelled value WITH ITS SOURCE ("Address · Driver's License").
// The list is built from the same rows every screen reads — profiles (people,
// assets, liabilities, accounts), every uploaded document's extracted data
// (old uploads included), and notes — and nothing is stored: it is derived on
// each read, so it can never disagree with the records (Rule 1).
//
// Three rules live here:
//  1. Never invent. A form value is a fact, a re-formatting of one, or blank.
//     `groundValue` is the check: every word and number of a proposed value
//     must come from the facts it cites.
//  2. Sensitive is confirmed. Identity and account numbers are facts like any
//     other, but they are masked on screen, never sent to the model (it sees
//     "[on file]" and cites the fact by id), and a field filled from one waits
//     for the user's tap. Passwords, PINs and card security codes are never
//     facts at all.
//  3. A conflict is shown, not hidden. Two different addresses on file are
//     ranked (the person's own profile, then identity documents, then other
//     documents; newer first) and the field carries the alternatives.
//
// Pure. Pinned by tests/fill-info.test.ts.

export type FillCategory =
  | "Personal" | "Contact" | "Employment" | "Education" | "Identification"
  | "Finance" | "Assets" | "Documents" | "Custom";

/** The tag on a blank form kept as the original of a completed one. */
export const FILL_ORIGINAL_TAG = "fill-original";

export const FILL_CATEGORIES: FillCategory[] = [
  "Personal", "Contact", "Employment", "Education", "Identification", "Finance", "Assets", "Documents", "Custom",
];

export interface FillFactSource {
  kind: "profile" | "document" | "note";
  id: string;
  /** What the user sees: "Driver's License", "Résumé", "My profile". */
  name: string;
}

export interface FillFact {
  /** Stable within one build: f1, f2 … */
  id: string;
  category: FillCategory;
  label: string;
  value: string;
  /** Canonical meaning, when the label has one ("address", "employer"). */
  key: string | null;
  source: FillFactSource;
  /** The person this fact is about; null = the account holder. */
  ownerProfileId: string | null;
  /** A thing the fact is about ("Honda CR-V"), for assets and debts. */
  subject?: string;
  /** Rows that belong together: one job, one school. */
  group?: string;
  sensitive: boolean;
  /** Worked out from another fact (first name from full name). */
  derived?: boolean;
  /** 3 = the person's own profile or an identity document, 2 = a document, 1 = a note. */
  reliability: number;
  updatedAt?: string;
}

export interface FillProfileRow {
  id: string; type: string; name: string;
  fields?: Record<string, any> | null; notes?: string | null;
  type_key?: string | null; updatedAt?: string | null; createdAt?: string | null;
  relationship?: string | null;
}
export interface FillDocumentRow {
  id: string; name: string; type?: string | null;
  extractedData?: Record<string, any> | null;
  linkedProfiles?: string[] | null; tags?: string[] | null;
  createdAt?: string | null; updatedAt?: string | null; deletedAt?: string | null;
}
export interface FillNoteRow { id: string; title?: string | null; content?: string | null; updatedAt?: string | null; linkedProfiles?: string[] | null }

// ── keys ─────────────────────────────────────────────────────────────────────

/** Never a fact: these do not belong on a form Portol fills. */
const NEVER_KEY = /pass(word|code|phrase)|\bpin\b|pin(code|number)|cvv|cvc|security.?(code|answer|question)|secret|token|api.?key|otp|recovery/i;
/** A fact, but confirmed by the user and never shown to the model. */
const SENSITIVE_KEY = /ssn|social.?security|tax.?(id|payer)|\bein\b|\bitin\b|passport.?(no|num|#)|passport$|licen[sc]e.?(no|num|#)|driver.?s?.?licen[sc]e$|\bdl\b|account.?(no|num|#)|routing|iban|swift|card.?(no|num|#)|member.?id|policy.?(no|num|#)|\bnid\b|national.?id|state.?id|alien|visa.?(no|num)/i;

/** Bookkeeping, never a fact. */
const INTERNAL_KEY = /^_|(^|[_.])id$|Id$|^ids?$|uuid|^source$|^provenance$|^smartFill$|^fillIndex$|^raw|^ocr|hash|^confidence$|^storagePath$|^thumbnail|^image|^photo$|^avatar|^icon$|^color$|^valuation|^aiSummary|^summary$|^note$|^_interestRateUnit$|^autopay|^tracked$|^history$|^status$|^category$|^frequency$|^kind$|^type$|^subtype$|^typeKey$|^type_key$|^nextDue|^lastPaid|^leadTime|^isActive$|^archived$|^currency$|^sortOrder$|^createdAt$|^updatedAt$/;

const CANON: Array<[string, RegExp]> = [
  ["firstName", /^(legal )?(first|given)( ?name)?$|^fname$|^forename$/],
  ["middleName", /^middle( ?name| initial)?$|^mi$/],
  ["lastName", /^(last|family|sur) ?name$|^surname$|^lname$|^last$/],
  ["fullName", /^(full |legal |printed? |your |applicant'?s? |employee'?s? |owner'?s? |patient'?s? |insured'?s? |customer'?s? |member'?s? )*name( \(?(first|last|print|printed|please print)[^)]*\)?)*$|^name of (applicant|employee|owner|patient|insured)$|^applicant$|^print name$/],
  ["dateOfBirth", /^(date of birth|birth ?date|dob|d\.o\.b\.?|birthday|born)$/],
  ["gender", /^(gender|sex)$/],
  ["maritalStatus", /^marital status$/],
  ["email", /^e-?mail( address)?$|^email id$/],
  ["phone", /^((home|mobile|cell|cellular|primary|daytime|contact|work)? ?(phone|telephone|tel|mobile|cell)( ?(number|no\.?|#))?)$|^phone$|^contact number$/],
  ["street", /^(street|mailing|home|residential|current)? ?address( line)? ?1$|^street( address)?$|^address \(street\)$|^(number and street|street and number)$/],
  ["street2", /^address( line)? ?2$|^(apt|apartment|unit|suite|ste)( ?(number|no\.?|#))?$/],
  ["address", /^((current|home|mailing|residential|permanent|present|street|full|physical|your) ?)*address$|^residence$|^address of (applicant|employee|owner)$/],
  ["city", /^(city|town)( ?\/ ?town)?$|^city or town$/],
  ["state", /^(state|province)( ?\/ ?province)?$|^state or province$|^st$/],
  ["zip", /^(zip|postal)( ?code)?$|^zip ?\/ ?postal code$|^postcode$/],
  ["country", /^country$/],
  ["ssn", /^(ssn|social security( number| no\.?| #)?|ss ?#)$/],
  ["driversLicenseNumber", /^(driver'?s? ?licen[sc]e|dl|licen[sc]e)( ?(number|no\.?|#|num))?$|^dln$/],
  ["licenseState", /^(licen[sc]e|dl|issuing) state$|^state of issue$|^state issued$/],
  ["licenseExpiration", /^(driver'?s? ?)?(licen[sc]e|dl) (exp(iration|iry)?( date)?|expires)$/],
  ["passportNumber", /^passport( ?(number|no\.?|#))?$/],
  ["passportExpiration", /^passport (exp(iration|iry)?( date)?|expires)$/],
  ["employer", /^(current |present |most recent )?(employer|company)( ?name)?$|^(name of )?(employer|company)$|^place of employment$|^organization$/],
  ["jobTitle", /^(job |position |current )?(title|position|occupation|role)$|^job title$|^position held$/],
  ["employmentStart", /^(employment |job )?(start|from)( ?date)?$|^date (hired|started)$|^hire date$/],
  ["employmentEnd", /^(employment |job )?(end|to)( ?date)?$|^date (left|ended)$/],
  ["employerPhone", /^(employer|company|work|supervisor)('?s)? (phone|telephone)( number)?$/],
  ["employerAddress", /^(employer|company|work)('?s)? address$/],
  ["supervisor", /^(supervisor|manager)('?s)?( name)?$/],
  ["salary", /^(salary|annual (income|salary)|income|pay|wage)$/],
  ["school", /^(school|college|university|institution)( ?name)?$|^name of (school|institution)$/],
  ["degree", /^(degree|diploma|qualification)( ?(earned|obtained|received))?$/],
  ["fieldOfStudy", /^(major|field of study|course of study|area of study)$/],
  ["graduationDate", /^(graduation|grad)( ?(date|year))?$|^year graduated$/],
  ["skills", /^skills?$|^(special|relevant) skills$/],
  ["vin", /^(vin|vehicle identification( number| no\.?)?)$/],
  ["licensePlate", /^(licen[sc]e )?plate( ?(number|no\.?|#))?$|^tag( number)?$|^registration (number|no\.?)$/],
  ["vehicleMake", /^(vehicle )?make$/],
  ["vehicleModel", /^(vehicle )?model$/],
  ["vehicleYear", /^(vehicle |model )?year$/],
  ["vehicleColor", /^(vehicle )?colou?r$/],
  ["bankName", /^(bank|financial institution)( ?name)?$/],
  ["accountNumber", /^(bank )?account( ?(number|no\.?|#))?$/],
  ["routingNumber", /^(aba |bank )?routing( ?(number|no\.?|#))?$/],
  ["emergencyContactName", /^emergency contact( name)?$/],
  ["emergencyContactPhone", /^emergency (contact )?(phone|number)$/],
  ["citizenship", /^(citizenship|nationality)$/],
];

/** camelCase / snake_case / "Label:" → lower-case words. */
export function normalizeLabel(label: string): string {
  return String(label || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/[:*?]+\s*$/g, "")
    .replace(/\(\s*required\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The canonical meaning of a data key or a form label, or null. */
export function canonicalKeyFor(label: string): string | null {
  const n = normalizeLabel(label).replace(/^\d+[.)]\s*/, "").replace(/^(your|applicant'?s?|employee'?s?) /, "");
  if (!n) return null;
  for (const [key, re] of CANON) if (re.test(n)) return key;
  return null;
}

/** "licensePlate" → "License plate". */
export function humanizeKey(key: string): string {
  const words = normalizeLabel(key);
  if (!words) return "";
  const s = words.replace(/\b(vin|ssn|dob|id|zip|dl|ein)\b/g, (m) => m.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function isSensitiveLabel(label: string): boolean {
  const n = normalizeLabel(label);
  const key = canonicalKeyFor(label);
  return SENSITIVE_KEY.test(n) || SENSITIVE_KEY.test(label) || ["ssn", "driversLicenseNumber", "passportNumber", "accountNumber", "routingNumber"].includes(key || "");
}

/** What the screen shows for a sensitive value until it is revealed. */
export function maskValue(value: string): string {
  const v = String(value || "");
  if (v.length <= 4) return "••••";
  return `${"•".repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`;
}

// ── building the list ────────────────────────────────────────────────────────

const ID_DOCUMENT = /licen[sc]e|passport|identification|\bid\b|id.?card|birth.?cert|social.?security|green.?card|visa|permit/i;
const RESUME_DOCUMENT = /r[ée]sum[ée]|\bcv\b|curriculum/i;

function categoryFor(key: string | null, label: string, sourceType: string): FillCategory {
  const n = normalizeLabel(label);
  if (key) {
    if (/^(firstName|middleName|lastName|fullName|dateOfBirth|gender|maritalStatus|citizenship)$/.test(key)) return "Personal";
    if (/^(email|phone|street|street2|address|city|state|zip|country|emergencyContact)/.test(key)) return "Contact";
    if (/^(employer|jobTitle|employment|supervisor|salary|skills)/.test(key)) return "Employment";
    if (/^(school|degree|fieldOfStudy|graduationDate)$/.test(key)) return "Education";
    if (/^(ssn|driversLicense|license(State|Expiration)|passport)/.test(key)) return "Identification";
    if (/^(bankName|accountNumber|routingNumber)$/.test(key)) return "Finance";
    if (/^(vin|licensePlate|vehicle)/.test(key)) return "Assets";
  }
  if (/employ|job|work|position|supervisor|salary|skill/.test(n)) return "Employment";
  if (/school|degree|educat|universit|college|gpa|major/.test(n)) return "Education";
  if (/licen[sc]e|passport|ssn|social security|\bid\b|identification/.test(n)) return "Identification";
  if (sourceType === "asset") return "Assets";
  if (sourceType === "liability" || sourceType === "account" || /balance|loan|bank|account|payment|premium|insur|policy/.test(n)) return "Finance";
  if (sourceType === "document") return "Documents";
  return "Custom";
}

interface Flat { path: string[]; value: string; group?: string }

function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s.length > 400) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return null; // a record id
    if (/^(data:|blob:|https?:\/\/)/i.test(s)) return null;
    return s;
  }
  return null; // booleans and the rest are app state, not form facts
}

/** Every leaf of a record that could go on a form. */
export function flattenFacts(obj: unknown, path: string[] = [], group?: string, depth = 0, out: Flat[] = []): Flat[] {
  if (depth > 5 || out.length > 400 || obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    const scalars = obj.map(scalar).filter((v): v is string => v !== null);
    if (scalars.length === obj.length && scalars.length > 0) {
      out.push({ path, value: scalars.join(", ").slice(0, 400), group });
      return out;
    }
    obj.slice(0, 12).forEach((item, i) => {
      if (item && typeof item === "object") flattenFacts(item, path, `${path.join(".") || "item"}:${i + 1}`, depth + 1, out);
    });
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (INTERNAL_KEY.test(k) || NEVER_KEY.test(k)) continue;
      const s = scalar(v);
      if (s !== null) out.push({ path: [...path, k], value: s, group });
      else if (v && typeof v === "object") flattenFacts(v, [...path, k], group, depth + 1, out);
    }
  }
  return out;
}

/** "123 Main St, Springfield, IL 62704" → its parts (US shape); null when it is not that shape. */
export function splitAddress(address: string): { street: string; city: string; state: string; zip: string } | null {
  const m = /^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*(?:,?\s*(?:USA|US|United States))?\s*$/.exec(String(address || "").replace(/\s*\n\s*/g, ", "));
  if (!m) return null;
  return { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
}

/** "Jordan A. Lee" → first / middle / last. */
export function splitName(name: string): { first: string; middle: string; last: string } | null {
  const parts = String(name || "").replace(/\s+/g, " ").trim().split(" ");
  if (parts.length < 2 || parts.length > 4) return null;
  if (/,/.test(name)) return null;
  return { first: parts[0], middle: parts.length > 2 ? parts.slice(1, -1).join(" ") : "", last: parts[parts.length - 1] };
}

/**
 * What Fill In read out of an upload the first time it was needed
 * (`extractedData.fillIndex`). The reading is kept as ONE JSON string, so the
 * date-rule engine and every screen that lists a document's extracted fields
 * never see it: indexing an old upload adds no alert and no row anywhere.
 */
export function readFillIndex(extractedData: Record<string, any> | null | undefined): { facts?: Record<string, any>; records?: any; skills?: any; documentType?: string } | null {
  const idx = extractedData && typeof extractedData === "object" ? (extractedData as any).fillIndex : null;
  if (!idx || typeof idx !== "object" || typeof idx.data !== "string") return null;
  try { const parsed = JSON.parse(idx.data); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
}
/** Has Fill In already read this upload (successfully or not)? */
export function isFillIndexed(extractedData: Record<string, any> | null | undefined): boolean {
  const idx = extractedData && typeof extractedData === "object" ? (extractedData as any).fillIndex : null;
  return !!idx && typeof idx === "object" && typeof idx.indexedAt === "string";
}

const docSourceName = (d: FillDocumentRow) => String(d.name || "Document").replace(/\.[a-z0-9]{2,5}$/i, "");

export interface BuildFactsInput {
  profiles: FillProfileRow[];
  documents: FillDocumentRow[];
  notes?: FillNoteRow[];
  /** Whose form this is. Default: the account holder. */
  forProfileId?: string | null;
}

/**
 * Every fact Fill In may use for a form filled for `forProfileId`.
 * The person's own facts carry canonical keys (so "Address" finds them);
 * other people's are listed under their name and are only ever placed by
 * choice (an emergency contact, a spouse).
 */
export function buildFillFacts(input: BuildFactsInput): FillFact[] {
  const profiles = (input.profiles || []).filter(Boolean);
  const self = profiles.find((p) => p.type === "self") || null;
  const subjectId = input.forProfileId || self?.id || null;
  const subject = profiles.find((p) => p.id === subjectId) || self;
  const isSubject = (profileId: string | null | undefined) => !!subject && profileId === subject.id;
  const facts: FillFact[] = [];
  const seen = new Set<string>();
  let n = 0;

  const add = (f: Omit<FillFact, "id" | "sensitive" | "key" | "category"> & { key?: string | null; category?: FillCategory; sourceType: string }) => {
    const label = f.label.trim();
    const value = String(f.value ?? "").trim();
    if (!label || !value) return;
    if (NEVER_KEY.test(label)) return;
    const key = f.key === undefined ? canonicalKeyFor(label) : f.key;
    const dedupe = `${f.ownerProfileId || ""}|${f.subject || ""}|${(key || normalizeLabel(label))}|${value.toLowerCase()}|${f.source.id}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const { sourceType, ...rest } = f;
    facts.push({
      ...rest, label, value, key,
      id: `f${++n}`,
      category: f.category || categoryFor(key, label, sourceType),
      sensitive: isSensitiveLabel(label) || isSensitiveLabel(key || ""),
    });
  };

  /** Add a fact and the facts that follow from it (name parts, address parts). */
  const addWithDerived = (base: Parameters<typeof add>[0]) => {
    add(base);
    const key = base.key === undefined ? canonicalKeyFor(base.label) : base.key;
    if (key === "fullName") {
      const parts = splitName(base.value);
      if (parts) {
        add({ ...base, label: "First name", key: "firstName", value: parts.first, derived: true });
        if (parts.middle) add({ ...base, label: "Middle name", key: "middleName", value: parts.middle, derived: true });
        add({ ...base, label: "Last name", key: "lastName", value: parts.last, derived: true });
      }
    }
    if (key === "address") {
      const parts = splitAddress(base.value);
      if (parts) {
        add({ ...base, label: "Street address", key: "street", value: parts.street, derived: true });
        add({ ...base, label: "City", key: "city", value: parts.city, derived: true });
        add({ ...base, label: "State", key: "state", value: parts.state, derived: true });
        add({ ...base, label: "ZIP code", key: "zip", value: parts.zip, derived: true });
      }
    }
  };

  // ── profiles ──
  for (const p of profiles) {
    const kind = p.type;
    const person = kind === "self" || kind === "person" || kind === "pet";
    const owned = isSubject(p.id);
    const source: FillFactSource = { kind: "profile", id: p.id, name: kind === "self" ? "My profile" : `${p.name} profile` };
    const updatedAt = p.updatedAt || p.createdAt || undefined;
    const flat = flattenFacts(p.fields || {});
    if (person) {
      if (kind === "pet" && !owned) continue;
      if (owned) {
        addWithDerived({ label: "Full name", key: "fullName", value: p.name, source, ownerProfileId: p.id, reliability: 3, updatedAt, sourceType: kind });
        for (const f of flat) {
          const label = humanizeKey(f.path[f.path.length - 1]);
          addWithDerived({ label, value: f.value, source, ownerProfileId: p.id, reliability: 3, updatedAt, group: f.group, sourceType: kind });
        }
      } else {
        // Someone else: listed under their name, never matched to "Name" / "Phone" on their own.
        const who = p.relationship ? `${p.name} (${p.relationship})` : p.name;
        add({ label: `${who} — name`, key: null, category: "Contact", value: p.name, source, ownerProfileId: p.id, reliability: 3, updatedAt, sourceType: kind });
        for (const f of flat) {
          const k = canonicalKeyFor(f.path[f.path.length - 1]);
          if (!k || !/^(phone|email|address|street|city|state|zip|dateOfBirth|employer)$/.test(k)) continue;
          add({ label: `${who} — ${humanizeKey(f.path[f.path.length - 1]).toLowerCase()}`, key: null, category: "Contact", value: f.value, source, ownerProfileId: p.id, reliability: 3, updatedAt, sourceType: kind });
        }
      }
      continue;
    }
    // An owned thing, a debt, an account, a provider: its facts are about IT.
    const thingCategory: FillCategory = kind === "asset" ? "Assets" : /liabilit|loan|account|subscription|bill/.test(kind) ? "Finance" : "Custom";
    add({ label: `${p.name} — name`, key: null, category: thingCategory, value: p.name, source, ownerProfileId: null, subject: p.name, reliability: 3, updatedAt, sourceType: kind });
    for (const f of flat) {
      const leaf = f.path[f.path.length - 1];
      add({
        label: `${p.name} — ${humanizeKey(leaf).toLowerCase()}`, key: canonicalKeyFor(leaf), category: thingCategory,
        value: f.value, source, ownerProfileId: null, subject: p.name, reliability: 3, updatedAt, group: f.group, sourceType: kind,
      });
    }
  }

  // ── documents (every upload, however old) ──
  for (const d of input.documents || []) {
    if (!d || d.deletedAt) continue;
    // A form Portol filled, or the blank form it was filled from, is not a source.
    if ((d.tags || []).includes("smart-fill") || (d.tags || []).includes(FILL_ORIGINAL_TAG) || d.type === "smart_fill") continue;
    const linked = (d.linkedProfiles || []).filter(Boolean);
    const linkedPeople = linked.map((id) => profiles.find((p) => p.id === id)).filter((p): p is FillProfileRow => !!p);
    const person = linkedPeople.find((p) => p.type === "self" || p.type === "person");
    const thing = linkedPeople.find((p) => p.type !== "self" && p.type !== "person" && p.type !== "pet");
    // A document linked to nobody is the account holder's.
    const ownerId = person ? person.id : (self?.id ?? null);
    const owned = isSubject(ownerId);
    const name = docSourceName(d);
    const source: FillFactSource = { kind: "document", id: d.id, name };
    const idDoc = ID_DOCUMENT.test(`${d.type || ""} ${name}`);
    const resume = RESUME_DOCUMENT.test(`${d.type || ""} ${name}`);
    const reliability = idDoc ? 3 : 2;
    const updatedAt = d.updatedAt || d.createdAt || undefined;
    const data = d.extractedData || {};
    const index = readFillIndex(data);
    const flat = [
      ...flattenFacts(data),
      ...(index ? flattenFacts(index.facts || {}) : []),
      ...(index && index.records && typeof index.records === "object" ? flattenFacts(index.records) : []),
      ...(index && Array.isArray(index.skills) && index.skills.length ? [{ path: ["skills"], value: index.skills.map(String).join(", ").slice(0, 400) } as Flat] : []),
    ];
    for (const f of flat) {
      const leaf = f.path[f.path.length - 1];
      if (/^(document ?type|label|type|kind|indexed ?at|failed|status)$/i.test(normalizeLabel(leaf))) continue;
      const base = humanizeKey(leaf);
      const groupNo = f.group ? f.group.split(":").pop() : "";
      const recordType = f.group ? normalizeLabel(f.group.split(":")[0].split(".").pop() || "") : "";
      let key = canonicalKeyFor(leaf);
      // Inside a résumé's job / school rows, bare "name" / "title" mean the employer / the position.
      if (f.group && /employ|experience|job|work|position/.test(`${recordType} ${f.path.join(" ")}`.toLowerCase())) {
        if (/^(name|company|organization|employer)$/i.test(leaf)) key = "employer";
        if (/^(title|role|position)$/i.test(leaf)) key = "jobTitle";
        if (/^(start|from|start ?date)$/i.test(normalizeLabel(leaf))) key = "employmentStart";
        if (/^(end|to|end ?date)$/i.test(normalizeLabel(leaf))) key = "employmentEnd";
      }
      if (f.group && /educat|school|degree/.test(`${recordType} ${f.path.join(" ")}`.toLowerCase())) {
        if (/^(name|institution|school)$/i.test(leaf)) key = "school";
      }
      const label = f.group ? `${base}${groupNo ? ` (${groupNo})` : ""}` : base;
      if (thing && !person) {
        add({ label: `${thing.name} — ${base.toLowerCase()}`, key, value: f.value, source, ownerProfileId: null, subject: thing.name, reliability, updatedAt, group: f.group ? `${d.id}:${f.group}` : undefined, sourceType: "document", category: thing.type === "asset" ? "Assets" : undefined });
        continue;
      }
      if (!owned) {
        // Someone else's document: named, never matched on its own.
        const whoName = person ? person.name : "Other";
        add({ label: `${whoName} — ${base.toLowerCase()}`, key: null, category: "Documents", value: f.value, source, ownerProfileId: ownerId, reliability, updatedAt, sourceType: "document" });
        continue;
      }
      addWithDerived({
        label, key, value: f.value, source, ownerProfileId: ownerId, reliability, updatedAt,
        group: f.group ? `${d.id}:${f.group}` : undefined, sourceType: "document",
        category: resume && !key ? "Employment" : undefined,
      });
    }
  }

  // ── notes: a short one is a fact the user wrote down ("Gate code …" is not sent anywhere; it is offered) ──
  for (const note of input.notes || []) {
    const text = String(note.content || "").trim();
    if (!text) continue;
    const title = String(note.title || "").trim() || "Note";
    for (const line of text.split("\n").slice(0, 40)) {
      const m = /^[\s>*\-\d.)\[\]x]*\**([A-Za-z][A-Za-z0-9 '\/#&.()-]{1,40}?)\**\s*[:=]\s*(.{1,200})$/.exec(line);
      if (!m) continue;
      if (/https?:\/\//i.test(m[2])) continue;
      add({ label: m[1].trim(), value: m[2].trim().replace(/\*+$/, ""), source: { kind: "note", id: note.id, name: title }, ownerProfileId: self?.id ?? null, reliability: 1, updatedAt: note.updatedAt || undefined, sourceType: "note" });
    }
  }
  return facts;
}

// ── matching ────────────────────────────────────────────────────────────────

const THING_KEYS = new Set(["vin", "licensePlate", "vehicleMake", "vehicleModel", "vehicleYear", "vehicleColor", "bankName", "accountNumber", "routingNumber"]);

const normValue = (v: string) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Best first: reliability, then not-derived, then newest. */
export function rankFacts(candidates: FillFact[]): FillFact[] {
  return [...candidates].sort((a, b) =>
    b.reliability - a.reliability
    || Number(!!a.derived) - Number(!!b.derived)
    || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export interface FillMatch {
  fact: FillFact;
  /** Other DIFFERENT values on file for the same thing, best first. */
  alternatives: FillFact[];
}

/**
 * The structured match: a form label's canonical meaning against the
 * subject's own facts. No model. Returns null when the label has no known
 * meaning or nothing on file answers it.
 */
export function matchLabelToFacts(label: string, facts: FillFact[], subjectId: string | null): FillMatch | null {
  const key = canonicalKeyFor(label);
  if (!key) return null;
  let pool = facts.filter((f) => f.key === key && !f.subject && (f.ownerProfileId === subjectId || f.ownerProfileId === null));
  // "Street address" when the papers give the street as "Address" (no city in it).
  if (pool.length === 0 && key === "street") {
    pool = facts.filter((f) => f.key === "address" && !f.subject && !f.value.includes(",") && (f.ownerProfileId === subjectId || f.ownerProfileId === null));
  }
  // A thing's fact ("VIN") answers only when exactly one thing has it — and
  // only for what is asked ABOUT things. A house's address is never the
  // person's address, a lender's phone never their phone.
  if (pool.length === 0 && THING_KEYS.has(key)) {
    const things = facts.filter((f) => f.key === key && !!f.subject);
    const subjects = new Set(things.map((f) => f.subject));
    if (subjects.size === 1) pool = things;
    else if (subjects.size > 1) {
      const ranked = rankFacts(things);
      return { fact: ranked[0], alternatives: distinctValues(ranked.slice(1), ranked[0]) };
    }
  }
  // "Address" with only parts on file: compose it.
  if (pool.length === 0 && key === "address") {
    const part = (k: string) => rankFacts(facts.filter((f) => f.key === k && !f.subject && (f.ownerProfileId === subjectId || f.ownerProfileId === null)))[0];
    const street = part("street"), city = part("city"), state = part("state"), zip = part("zip");
    if (street && city) {
      const value = `${street.value}, ${city.value}${state ? `, ${state.value}` : ""}${zip ? ` ${zip.value}` : ""}`;
      return { fact: { ...street, id: `${street.id}+`, label: "Address", key: "address", value, derived: true }, alternatives: [] };
    }
  }
  // A repeated row (a job, a school): the first group is the most recent one listed.
  if (pool.length === 0) return null;
  const ranked = rankFacts(pool);
  return { fact: ranked[0], alternatives: distinctValues(ranked.slice(1), ranked[0]) };
}

function distinctValues(rest: FillFact[], top: FillFact): FillFact[] {
  const seen = new Set([normValue(top.value)]);
  const out: FillFact[] = [];
  for (const f of rest) {
    const v = normValue(f.value);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(f);
    if (out.length >= 4) break;
  }
  return out;
}

// ── grounding: a value on a form comes from the facts it cites ────────────────

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A calendar day out of the common ways one is written, or null. */
export function parseLooseDate(text: string): string | null {
  const s = String(text || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
  if (m) return iso(+m[3] < 100 ? (+m[3] > 40 ? 1900 + +m[3] : 2000 + +m[3]) : +m[3], +m[1], +m[2]);
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) { const mo = MONTHS.findIndex((x) => x.startsWith(m![1].toLowerCase().slice(0, 3))); if (mo >= 0) return iso(+m[3], mo + 1, +m[2]); }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) { const mo = MONTHS.findIndex((x) => x.startsWith(m![2].toLowerCase().slice(0, 3))); if (mo >= 0) return iso(+m[3], mo + 1, +m[1]); }
  return null;
}
function iso(y: number, mo: number, d: number): string | null {
  if (!(y > 1800 && y < 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The US way a form expects a date. */
export function formatFormDate(value: string): string {
  const day = parseLooseDate(value);
  if (!day) return value;
  const [y, m, d] = day.split("-");
  return `${m}/${d}/${y}`;
}

const CHECK_WORDS = new Set(["yes", "no", "true", "false", "x", "checked", "unchecked", "on", "off", "n", "y", "na", "n a"]);
const tokens = (s: string) => normValue(s).split(" ").filter(Boolean);

/**
 * Is `value` made only of what the cited facts say? Every word and number
 * must appear in one of them (a date may be re-written; a checkbox answer is
 * yes/no). This is what stops a model from supplying a plausible phone number.
 */
export function groundValue(value: string, cited: FillFact[]): boolean {
  const v = String(value || "").trim();
  if (!v) return true;
  if (cited.length === 0) return false;
  if (CHECK_WORDS.has(normValue(v))) return true;
  const day = parseLooseDate(v);
  if (day && cited.some((f) => parseLooseDate(f.value) === day)) return true;
  const have = new Set<string>();
  const joined: string[] = [];
  for (const f of cited) {
    for (const t of tokens(f.value)) have.add(t);
    joined.push(normValue(f.value).replace(/ /g, ""));
    const d = parseLooseDate(f.value);
    if (d) { const [y, m, dd] = d.split("-"); [y, m, dd, String(+m), String(+dd), y.slice(2), MONTHS[+m - 1], MONTHS[+m - 1].slice(0, 3)].forEach((t) => have.add(t)); }
  }
  return tokens(v).every((t) => have.has(t) || joined.some((j) => j.includes(t) && t.length >= 3));
}

/** Search the list the way the panel does: every word, in the label, value or source. */
export function searchFacts(facts: FillFact[], query: string): FillFact[] {
  const words = normValue(query).split(" ").filter(Boolean);
  if (words.length === 0) return facts;
  return facts.filter((f) => {
    const hay = normValue(`${f.label} ${f.sensitive ? "" : f.value} ${f.source.name} ${f.category} ${f.subject || ""}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Could this fact go in a field of this kind? (What a drag highlights.) */
export function factFitsKind(fact: FillFact, kind: string): boolean {
  if (kind === "signature") return false;
  if (kind === "checkbox" || kind === "radio") return false;
  if (kind === "date") return parseLooseDate(fact.value) !== null;
  if (kind === "number") return /\d/.test(fact.value);
  return true;
}
