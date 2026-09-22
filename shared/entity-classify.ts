// ── Entity classification / normalization layer (2026-07-20) ─────────────────
// Pure, no I/O. The single place that answers "what KIND of thing is this?"
// before any tracker is created or categorized.
//
// Why: the AI auto-create path used a small hardcoded keyword list, so any
// recognizable entity outside it ("Xanax", "Bench Press", "Pickleball") landed
// in the meaningless "custom" bucket (user report 2026-07-20: a Xanax tracker
// filed as custom). This module recognizes thousands of common medications,
// supplements, and exercises by SEMANTIC identity — dictionaries + fuzzy
// matching for typos — and returns a confidence so callers know whether to
// trust it, consult a learned mapping, defer to the model, or ask the user.
//
// Resolution ladder (implemented by the caller in server/ai-engine.ts):
//   1. this module, high/medium confidence  → use it
//   2. learned mapping (user taught us before) → use it
//   3. model-supplied category (LLM semantic reasoning) → use it + remember it
//   4. "custom" + ask the user a concise clarification, remember the answer
//
// Pinned by tests/entity-classify.test.ts.

export const TRACKER_CATEGORIES = [
  "health", "fitness", "nutrition", "sleep", "mental", "lifestyle",
  "finance", "medication", "habit", "productivity", "custom",
] as const;
export type TrackerCategory = (typeof TRACKER_CATEGORIES)[number];

export function isValidTrackerCategory(v: unknown): v is TrackerCategory {
  return typeof v === "string" && (TRACKER_CATEGORIES as readonly string[]).includes(v.toLowerCase());
}

export type EntityKind =
  | "medication" | "supplement"
  | "strength" | "cardio" | "sport" | "flexibility"
  | "keyword";

export interface EntityClassification {
  category: TrackerCategory;
  /** high = dictionary identity match · medium = fuzzy/keyword · none = unknown */
  confidence: "high" | "medium" | "none";
  kind?: EntityKind;
  matchedTerm?: string;
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize a raw entity/tracker name for matching and for learned-mapping
 * keys: lowercase, strip dose tokens ("0.5mg", "500 mg"), punctuation → space,
 * drop filler words ("my", "daily", "tracker", "log"), collapse whitespace.
 */
export function normalizeEntityName(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|kg|ml|l|iu|units?|tablets?|tabs?|caps?|capsules?|pills?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:my|the|a|an|daily|weekly|tracker|tracking|log|logs|usage|intake|taken)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Singular-ize a token conservatively: "ups"→"up", "dips"→"dip", but never
 * "press"→"pres" (double-s) or two-letter tokens. */
function singular(tok: string): string {
  if (tok.length >= 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  return tok;
}

function normTokens(name: string): string[] {
  return normalizeEntityName(name).split(" ").filter(Boolean).map(singular);
}

/** Levenshtein distance capped at `max` (early-exit). */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let rowMin = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

// ─── Dictionaries ─────────────────────────────────────────────────────────────
// Multi-word terms are matched as normalized phrases; single words as tokens.

// Prescription + OTC medications (generic AND brand names). Kind: medication.
const MEDICATIONS: string[] = [
  // benzodiazepines / anxiolytics
  "xanax", "alprazolam", "ativan", "lorazepam", "valium", "diazepam", "klonopin",
  "clonazepam", "temazepam", "restoril", "buspirone", "buspar", "hydroxyzine", "vistaril",
  // sleep
  "ambien", "zolpidem", "lunesta", "eszopiclone", "trazodone",
  // antidepressants
  "prozac", "fluoxetine", "zoloft", "sertraline", "lexapro", "escitalopram", "celexa",
  "citalopram", "paxil", "paroxetine", "effexor", "venlafaxine", "cymbalta", "duloxetine",
  "pristiq", "desvenlafaxine", "wellbutrin", "bupropion", "remeron", "mirtazapine",
  // mood / antipsychotic / anticonvulsant
  "abilify", "aripiprazole", "seroquel", "quetiapine", "zyprexa", "olanzapine",
  "risperdal", "risperidone", "latuda", "lurasidone", "lamictal", "lamotrigine",
  "lithium", "depakote", "valproate", "tegretol", "carbamazepine",
  // ADHD
  "adderall", "amphetamine", "ritalin", "methylphenidate", "concerta", "vyvanse",
  "lisdexamfetamine", "focalin", "dexmethylphenidate", "strattera", "atomoxetine",
  "guanfacine", "intuniv",
  // pain / anti-inflammatory
  "tylenol", "acetaminophen", "paracetamol", "advil", "ibuprofen", "motrin", "aleve",
  "naproxen", "aspirin", "excedrin", "tramadol", "oxycodone", "percocet", "hydrocodone",
  "vicodin", "norco", "codeine", "morphine", "gabapentin", "neurontin", "pregabalin",
  "lyrica", "celebrex", "celecoxib", "meloxicam", "diclofenac", "toradol", "ketorolac",
  "cyclobenzaprine", "flexeril", "tizanidine", "baclofen",
  // migraine
  "imitrex", "sumatriptan", "rizatriptan", "maxalt", "ubrelvy", "nurtec", "topamax", "topiramate",
  // antibiotics / antifungals / antivirals
  "amoxicillin", "augmentin", "penicillin", "azithromycin", "zithromax", "doxycycline",
  "cephalexin", "keflex", "ciprofloxacin", "cipro", "levofloxacin", "clindamycin",
  "metronidazole", "flagyl", "bactrim", "sulfamethoxazole", "trimethoprim",
  "nitrofurantoin", "macrobid", "fluconazole", "diflucan", "valacyclovir", "valtrex",
  "acyclovir", "tamiflu", "oseltamivir", "paxlovid",
  // allergy / cold / respiratory OTC
  "benadryl", "diphenhydramine", "zyrtec", "cetirizine", "claritin", "loratadine",
  "allegra", "fexofenadine", "flonase", "fluticasone", "singulair", "montelukast",
  "sudafed", "pseudoephedrine", "mucinex", "guaifenesin", "dayquil", "nyquil", "robitussin",
  // asthma / copd
  "albuterol", "ventolin", "proair", "symbicort", "budesonide", "advair", "salmeterol",
  "dulera", "trelegy", "spiriva", "tiotropium", "inhaler",
  // blood pressure / heart
  "lisinopril", "losartan", "valsartan", "amlodipine", "metoprolol", "atenolol",
  "propranolol", "carvedilol", "coreg", "hydrochlorothiazide", "hctz", "furosemide",
  "lasix", "spironolactone", "clonidine", "diltiazem", "verapamil", "nitroglycerin",
  "eliquis", "apixaban", "xarelto", "rivaroxaban", "warfarin", "coumadin", "plavix",
  "clopidogrel",
  // cholesterol
  "lipitor", "atorvastatin", "crestor", "rosuvastatin", "simvastatin", "zocor",
  "pravastatin", "ezetimibe", "zetia",
  // diabetes / weight
  "metformin", "glucophage", "ozempic", "semaglutide", "wegovy", "mounjaro",
  "tirzepatide", "zepbound", "trulicity", "dulaglutide", "jardiance", "empagliflozin",
  "farxiga", "dapagliflozin", "januvia", "sitagliptin", "glipizide", "glyburide",
  "insulin", "lantus", "humalog", "novolog", "tresiba", "levemir", "phentermine",
  // thyroid / hormones
  "levothyroxine", "synthroid", "liothyronine", "estradiol", "progesterone",
  "testosterone", "finasteride", "propecia", "minoxidil", "sildenafil", "viagra",
  "tadalafil", "cialis", "birth control",
  // GI
  "omeprazole", "prilosec", "pantoprazole", "protonix", "esomeprazole", "nexium",
  "famotidine", "pepcid", "tums", "zofran", "ondansetron", "miralax", "dulcolax",
  "imodium", "loperamide", "linzess", "pepto bismol",
  // steroids
  "prednisone", "prednisolone", "dexamethasone", "methylprednisolone", "medrol",
  "hydrocortisone", "cortisone",
  // addiction / rescue / misc
  "naltrexone", "suboxone", "buprenorphine", "methadone", "narcan", "naloxone",
  "phenergan", "promethazine", "methotrexate", "humira", "adalimumab", "accutane",
  "isotretinoin", "tretinoin", "epipen", "epinephrine",
];

// Supplements — also categorized "medication" (the app's dose/adherence bucket).
const SUPPLEMENTS: string[] = [
  "multivitamin", "vitamin a", "vitamin b", "vitamin b12", "b12", "vitamin c",
  "vitamin d", "vitamin d3", "vitamin e", "vitamin k", "fish oil", "omega 3",
  "krill oil", "cod liver oil", "creatine", "magnesium", "zinc", "iron", "calcium",
  "potassium", "folate", "folic acid", "biotin", "collagen", "probiotic", "prebiotic",
  "melatonin", "ashwagandha", "turmeric", "curcumin", "glucosamine", "chondroitin",
  "coq10", "elderberry", "echinacea", "ginkgo", "ginseng", "l theanine", "theanine",
  "5 htp", "gaba", "nac", "berberine", "electrolyte", "fiber supplement",
];

// Strength training — categorized "fitness".
const STRENGTH: string[] = [
  "push up", "pushup", "pull up", "pullup", "chin up", "chinup", "bench press",
  "incline press", "overhead press", "shoulder press", "military press", "squat",
  "front squat", "back squat", "goblet squat", "deadlift", "romanian deadlift",
  "lunge", "bicep curl", "curl", "hammer curl", "tricep extension", "skull crusher",
  "dip", "row", "barbell row", "dumbbell row", "lat pulldown", "leg press",
  "leg extension", "leg curl", "calf raise", "hip thrust", "glute bridge",
  "face pull", "shrug", "farmer carry", "farmers carry", "plank", "crunch",
  "sit up", "situp", "russian twist", "leg raise", "kettlebell", "kettlebell swing",
  "dumbbell", "barbell", "weightlifting", "weight lifting", "lifting", "snatch",
  "clean and jerk", "power clean", "burpee", "strength training", "resistance training",
  "bodyweight workout", "calisthenic",
];

// Cardio — categorized "fitness".
const CARDIO: string[] = [
  "walking", "walk", "running", "run", "jog", "jogging", "cycling", "biking", "bike",
  "swimming", "swim", "hiking", "hike", "elliptical", "treadmill", "rowing",
  "jump rope", "jumping jack", "stairmaster", "stair climber", "stair stepper",
  "sprint", "hiit", "spin class", "spinning", "zumba", "aerobic", "cardio",
  "dance workout", "dancing", "rucking",
];

// Sports — categorized "fitness".
const SPORTS: string[] = [
  "basketball", "tennis", "soccer", "football", "volleyball", "baseball", "softball",
  "hockey", "golf", "pickleball", "badminton", "cricket", "rugby", "lacrosse",
  "skiing", "snowboarding", "skating", "ice skating", "rollerblading", "surfing",
  "skateboarding", "bowling", "boxing", "kickboxing", "mma", "jiu jitsu", "bjj",
  "judo", "karate", "taekwondo", "muay thai", "wrestling", "climbing", "bouldering",
  "rock climbing", "frisbee", "ultimate frisbee", "table tennis", "ping pong",
  "squash", "racquetball", "archery", "fencing", "dodgeball", "handball", "polo",
  "water polo", "kayaking", "paddleboarding", "canoeing",
];

// Flexibility / mind-body — categorized "fitness".
const FLEXIBILITY: string[] = [
  "yoga", "stretching", "stretch", "pilates", "tai chi", "mobility", "foam rolling",
  "barre",
];

/** Context words that veto a fitness match — "Dog Walking" is pet care, not the
 * user's cardio; "Running Errands" isn't a run. Mirrors canonical-activity. */
const FITNESS_BLOCKERS = /\b(dogs?|cats?|pets?|pupp(?:y|ies)|kittens?|plants?|gardens?|errands?|business)\b/i;

interface DictEntry { term: string; tokens: string[]; category: TrackerCategory; kind: EntityKind }

function buildDict(): DictEntry[] {
  const out: DictEntry[] = [];
  const add = (terms: string[], category: TrackerCategory, kind: EntityKind) => {
    for (const t of terms) out.push({ term: t, tokens: t.split(" ").map(singular), category, kind });
  };
  add(MEDICATIONS, "medication", "medication");
  add(SUPPLEMENTS, "medication", "supplement");
  add(STRENGTH, "fitness", "strength");
  add(CARDIO, "fitness", "cardio");
  add(SPORTS, "fitness", "sport");
  add(FLEXIBILITY, "fitness", "flexibility");
  return out;
}
const DICT = buildDict();
// Single-word medication terms for fuzzy typo matching ("ibuprofin" → ibuprofen).
const FUZZY_MED_TERMS = DICT.filter(d => (d.kind === "medication" || d.kind === "supplement") && d.tokens.length === 1 && d.term.length >= 6);

/** Does `name` contain dict entry `e` as a whole-token phrase? */
function phraseHit(nameToks: string[], e: DictEntry): boolean {
  const n = e.tokens.length;
  if (n === 0 || nameToks.length < n) return false;
  for (let i = 0; i + n <= nameToks.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) if (nameToks[i + j] !== e.tokens[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// ─── Keyword waterfall (medium confidence) ────────────────────────────────────
// Ported from the ai-engine auto-create waterfall so ONE module owns category
// inference. ORDER MATTERS — more specific buckets come first (see the original
// comments in server/ai-engine.ts, derived from test_ai_render.ts failures).
const KEYWORD_WATERFALL: Array<{ category: TrackerCategory; words: string[] }> = [
  { category: "mental", words: ["mood", "stress", "anxiety", "depression", "panic", "meditation", "mindful", "mindfulness", "therapy", "therapist", "counsel", "journal", "gratitude", "emotion", "feeling", "mental", "wellness", "calm"] },
  { category: "medication", words: ["medication", "prescription", "prescribed", "supplement", "pill", "tablet", "capsule", "softgel", "gummy", "injection", "vaccine", "refill", "rx", "dose", "dosage", "mg", "mcg", "ml", "iu", "vitamin"] },
  { category: "lifestyle", words: ["gaming", "video game", "videogame", "console", "playstation", "xbox", "nintendo", "steam deck", "pc gaming", "leisure", "entertainment", "hobby", "social media", "tv", "movie", "streaming", "netflix", "hulu", "youtube", "podcast", "pet ", "pets ", "plant", "garden", "feeding", "feed ", "litter", "walking the dog", "vet", "veterinary", "veterinarian", "grooming", "groomer", "kennel", "dog walk", "cat litter", "aquarium", "terrarium"] },
  { category: "nutrition", words: ["nutrition", "food", "diet", "meal", "calories", "protein", "carbs", "fat", "macros", "intake", "eating", "snack", "breakfast", "lunch", "dinner"] },
  { category: "fitness", words: ["workout", "exercise", "gym", "crossfit", "martial", "sport", "match", "practice", "drill", "steps", "miles", "training", "reps", "sets", "pace", "distance"] },
  { category: "sleep", words: ["sleep", "insomnia", "nap "] },
  { category: "health", words: ["weight", "blood", "bp", "heart", "cholesterol", "glucose", "sugar", "oxygen", "spo2", "pulse", "temperature", "fever", "pain", "hydration", "water", "symptom", "creatinine", "a1c", "bmi", "vital", "lab", "panel", "migraine", "headache", "allergy", "period", "cycle length"] },
  { category: "finance", words: ["spending", "expense", "budget", "saving", "invest", "portfolio", "net worth", "income", "salary", "revenue", "profit", "debt", "loan", "mortgage", "credit", "crypto", "stock", "dividend", "rent", "bill", "subscription", "dollar", "cash"] },
  { category: "habit", words: ["habit", "routine", "streak", "daily", "checkin", "check-in", "morning", "evening", "reading", "screen time", "phone usage", "bedtime"] },
  { category: "productivity", words: ["productivity", "focus", "work", "study", "learn", "task", "project", "meeting", "call", "email", "pomodoro", "deep work", "code", "write", "create"] },
];

// ─── Classification ───────────────────────────────────────────────────────────

export interface ClassifyOpts {
  /** Entry values being logged — dose-shaped values boost medication. */
  values?: Record<string, unknown>;
}

/**
 * Classify an entity/tracker name into its semantic category.
 *
 *   high   — dictionary identity match (or unambiguous fuzzy med match)
 *   medium — keyword-waterfall or values-shape inference
 *   none   — unknown ("custom"): caller should consult learned mappings /
 *            the model's category / ask the user
 */
export function classifyEntity(rawName: string, opts: ClassifyOpts = {}): EntityClassification {
  const name = normalizeEntityName(rawName);
  if (!name) return { category: "custom", confidence: "none" };
  const toks = normTokens(rawName);
  const blocked = FITNESS_BLOCKERS.test(name);

  // 1) Dictionary identity (high confidence).
  for (const e of DICT) {
    if (e.category === "fitness" && blocked) continue;
    if (phraseHit(toks, e)) return { category: e.category, confidence: "high", kind: e.kind, matchedTerm: e.term };
  }

  // 2) Fuzzy medication typo match ("ibuprofin", "amoxicilin") — only for
  // reasonably long single tokens, distance scaled to length, and only when
  // the name IS essentially that token (≤2 tokens) so we never hijack phrases.
  if (toks.length <= 2) {
    for (const tok of toks) {
      if (tok.length < 6) continue;
      const maxDist = tok.length >= 9 ? 2 : 1;
      for (const e of FUZZY_MED_TERMS) {
        if (Math.abs(e.term.length - tok.length) > maxDist) continue;
        if (editDistance(tok, singular(e.term), maxDist) <= maxDist) {
          return { category: "medication", confidence: "high", kind: e.kind, matchedTerm: e.term };
        }
      }
    }
  }

  // 3) Dose-shaped values ⇒ medication (medium).
  const vals = opts.values || {};
  const valKeys = Object.keys(vals).map(k => k.toLowerCase());
  if (valKeys.some(k => ["dosage", "dose", "drug", "medication", "adherence", "sideeffects", "side_effects"].includes(k))) {
    return { category: "medication", confidence: "medium", kind: "keyword", matchedTerm: "dose-shaped values" };
  }

  // 4) Keyword waterfall (medium).
  const nameLC = String(rawName || "").toLowerCase();
  for (const bucket of KEYWORD_WATERFALL) {
    const hit = bucket.words.find(w => nameLC.includes(w));
    if (hit) return { category: bucket.category, confidence: "medium", kind: "keyword", matchedTerm: hit };
  }

  return { category: "custom", confidence: "none" };
}

// ─── Canonical category resolution ────────────────────────────────────────────
//
// ONE resolver for "what category does this tracker belong to?", used by every
// write path (create_tracker, log_tracker_entry auto-create, the self-heal
// pass). Before this existed each path had its own precedence rules and they
// disagreed.
//
// QA report 2026-07-25: "'Pushups' is classified under Other instead of
// Fitness." Two defects combined:
//   1. `create_tracker` only consulted the classifier when the supplied
//      category was empty or literally "custom". A model that guessed "other"
//      beat a HIGH-confidence dictionary match on the word "pushup".
//   2. "other" is not a valid TrackerCategory, but the guard was
//      `category = category || "custom"`, a no-op for a non-empty invalid
//      string — so the bogus value was written to the database and every
//      grouped view filed the tracker under "Other".

export type CategorySource = "dictionary" | "supplied" | "learned" | "keyword" | "unknown";

export interface CategoryResolution {
  category: TrackerCategory;
  source: CategorySource;
  /** Worth persisting as a learned mapping (a model judgment we'd re-use). */
  remember: boolean;
  matchedTerm?: string;
}

/**
 * Resolve a tracker's category from every available signal.
 *
 * Precedence, highest first:
 *   1. HIGH-confidence dictionary identity — "Pushups" IS strength training,
 *      no caller-supplied guess overrides a known entity.
 *   2. A valid, non-custom supplied category (the model's semantic judgment).
 *   3. A learned mapping the user taught us earlier.
 *   4. MEDIUM-confidence keyword/values inference.
 *   5. "custom" — the caller should ask.
 *
 * The result is ALWAYS a valid TrackerCategory. An unrecognized supplied value
 * ("other", "misc", "") is discarded rather than written through.
 */
export function resolveTrackerCategory(
  name: string,
  opts: { supplied?: unknown; learned?: unknown; values?: Record<string, unknown> } = {},
): CategoryResolution {
  const classification = classifyEntity(name, { values: opts.values });

  if (classification.confidence === "high") {
    return {
      category: classification.category,
      source: "dictionary",
      remember: false,
      matchedTerm: classification.matchedTerm,
    };
  }

  const supplied = normalizeCategory(opts.supplied);
  if (supplied && supplied !== "custom") {
    return { category: supplied, source: "supplied", remember: true };
  }

  const learned = normalizeCategory(opts.learned);
  if (learned && learned !== "custom") {
    return { category: learned, source: "learned", remember: false };
  }

  if (classification.confidence === "medium") {
    return {
      category: classification.category,
      source: "keyword",
      remember: false,
      matchedTerm: classification.matchedTerm,
    };
  }

  return { category: "custom", source: "unknown", remember: false };
}

/** A supplied category, lowercased, or null when it isn't a real category. */
export function normalizeCategory(v: unknown): TrackerCategory | null {
  if (typeof v !== "string") return null;
  const lc = v.trim().toLowerCase();
  return isValidTrackerCategory(lc) ? (lc as TrackerCategory) : null;
}

/**
 * Should this tracker's category be re-resolved on the next write?
 *
 * True for anything that isn't a real, specific category — missing, "custom",
 * or a junk value like "other" that an older write path let through. The
 * self-heal pass used to check only for "custom", so trackers already stuck on
 * "other" stayed there forever.
 */
export function categoryNeedsResolution(v: unknown): boolean {
  const norm = normalizeCategory(v);
  return norm === null || norm === "custom";
}

// ─── Profile type guard: things are not people ────────────────────────────────
//
// QA 2026-09-18 (F-04): "tires for my Dodge ram" and "my MacBook Pro m4" were
// filed as `person` profiles, so they showed up in the profile switcher, the
// "+ Add owner…" dropdown and the event "Link to Profiles" chips. A human is
// never named "my …", "… for my …" or after a product line. The guard below is
// deliberately conservative: it only fires on shapes no person's name has.

const VEHICLE_WORDS = /\b(?:car|truck|suv|van|sedan|pickup|motorcycle|moped|scooter|bike|bicycle|boat|jet ?ski|trailer|rv|camper|tires?|wheels?|dodge|dodge ram|ram (?:1500|2500|3500)|ford|chevy|chevrolet|gmc|toyota|honda|nissan|subaru|mazda|hyundai|kia|jeep|tesla|bmw|audi|mercedes|lexus|volvo|volkswagen|vw|porsche|f-?\d{3}|silverado|tacoma|tundra|civic|accord|camry|corolla|mustang|wrangler|4runner|model [3sxy])\b/i;
const THING_WORDS = /\b(?:macbook|imac|ipad|iphone|ipod|airpods|laptop|computer|pc|desktop|monitor|tv|television|phone|tablet|watch|camera|lens|console|playstation|xbox|nintendo|switch|kindle|printer|router|drone|guitar|piano|keyboard|couch|sofa|mattress|fridge|refrigerator|washer|dryer|dishwasher|oven|grill|mower|lawnmower|generator|tools?|ring|necklace|bracelet|purse|handbag|jacket|shoes|sneakers|boots|house|home|condo|apartment|cabin|land|lot|garage|shed)\b/i;

/** True for names that are obviously a possession, never a person. */
export function looksLikeAssetName(raw: string | null | undefined): boolean {
  const name = String(raw || "").trim();
  if (!name) return false;
  const lc = name.toLowerCase();
  // Possessive / descriptor phrasing: "my MacBook", "our house", "tires for my Dodge ram",
  // "new tires", "the Honda Civic".
  if (/^(?:my|our|the|a|an|new|old|used)\s+/i.test(lc)) return true;
  if (/\b(?:for|of)\s+(?:my|our|the)\b/i.test(lc)) return true;
  if (VEHICLE_WORDS.test(lc) || THING_WORDS.test(lc)) return true;
  // A model/spec token ("m4", "2022", "15 pro") alongside a word — not a name.
  if (/\b(?:m\d|[a-z]\d{1,2}|\d{4}|\d+\s?(?:gb|tb|inch|in|hp|cc|kw))\b/i.test(lc) && /\s/.test(lc)) return true;
  return false;
}

/**
 * The profile type a create call should actually use. A requested person
 * type (person/self/pet) survives only when the name can be a person's; an
 * asset-shaped name becomes a vehicle or a generic asset. Any explicit
 * non-person type is kept verbatim, and an unknown/absent type is a THING,
 * never a person (2026-08-09: a laptop filed as a human being).
 */
export function coerceProfileType(name: string | null | undefined, requested: string | null | undefined): string {
  const type = String(requested || "").trim().toLowerCase();
  const isPersonish = type === "person" || type === "self" || type === "pet";
  if (type && !isPersonish) return type;
  if (isPersonish && !looksLikeAssetName(name)) return type;
  return VEHICLE_WORDS.test(String(name || "")) ? "vehicle" : "asset";
}

/**
 * Defensive people-picker filter: a real person/pet record, and not a
 * mistyped possession. Every "who" picker (profile switcher, owner dropdown,
 * assignee chips) filters with this so a bad row cannot be offered as a person.
 */
export function isOfferablePerson(p: { type?: string | null; name?: string | null } | null | undefined): boolean {
  if (!p) return false;
  const type = String(p.type || "").trim().toLowerCase();
  if (type !== "self" && type !== "person" && type !== "pet") return false;
  // Rule 28: an explicit `person` (or `self`) row is a person. Hiding one
  // because its name LOOKS like a thing ("Mercedes", "Bentley", "My Mom")
  // made real people vanish from every picker; the retype repair for rows
  // that really are things lives in `retypeMisfiledPersonRows`, not here.
  // Only a pet row keeps the name check — pets are named after things often
  // enough that the create-time coercion is worth mirroring.
  if (type === "pet") return !looksLikeAssetName(p.name);
  return true;
}

/**
 * Rule 28 — the ONE people-picker source. Every "who" picker (owner
 * dropdown, assignee, link-person, scope switcher, quick-add) lists exactly
 * these rows from the canonical profile collection, so a valid person like
 * Morgan appears in every compatible picker. Options:
 *   includePets      pets are people for pickers that can own things
 *                    (default true; a "link person" picker passes false)
 *   includeBusiness  a business is a party for finance pickers (default false)
 *   exclude          ids to leave out (the record being edited)
 * Soft-deleted rows (`fields.deleted`) never appear.
 */
export function offerablePeople<T extends { id: string; type?: string | null; name?: string | null; fields?: any }>(
  profiles: ReadonlyArray<T> | null | undefined,
  opts: { includePets?: boolean; includeBusiness?: boolean; exclude?: ReadonlyArray<string> } = {},
): T[] {
  const includePets = opts.includePets !== false;
  const includeBusiness = opts.includeBusiness === true;
  const excluded = new Set(opts.exclude || []);
  const out: T[] = [];
  for (const p of profiles || []) {
    if (!p || excluded.has(p.id)) continue;
    if (p.fields && typeof p.fields === "object" && (p.fields as any).deleted) continue;
    const type = String(p.type || "").trim().toLowerCase();
    if (type === "business") { if (includeBusiness) out.push(p); continue; }
    if (type === "pet" && !includePets) continue;
    if (isOfferablePerson(p)) out.push(p);
  }
  return out;
}

// ── Repairing rows that were ALREADY stored as people (QA 2026-09-19) ─────────
//
// `coerceProfileType` fixes the create path; it cannot fix the rows that are
// already in the table typed `person`. Retyping those is a data repair, and a
// wrong one is expensive: a real person filed as an `asset` loses their people
// pickers, and ownership starts walking through them as if they were a
// possession. `looksLikeAssetName` on its own is NOT a safe repair rule — it is
// deliberately aggressive because at create time it only breaks a tie the model
// already leaned on, so it fires on "My Mom" (the `my …` rule) and on
// "Sarah 1990" (the 4-digit rule).
//
// The repair therefore needs an asset-shaped name AND positive evidence the row
// is not a human: no human-shaped field on the record, and no human-only record
// attributed to it. `isSafeToRetypeAsThing` is that one rule — the repair
// script (scripts/repair-mistyped-person-profiles.ts) and any future caller
// share it. Pinned by tests/qa-2026-09-19-profile-retype.test.ts.

import { fieldIdentity, normalizeKey, PROFILE_FIELD_GROUPS } from "./profile-field-identity";

/** The only two types a mistyped person row may be repaired into. */
export type ThingProfileType = "vehicle" | "asset";

export interface RetypeCandidateProfile {
  type?: string | null;
  name?: string | null;
  /** The jsonb `fields` blob exactly as stored (nested groups included). */
  fields?: Record<string, any> | null;
}

/**
 * Counts of HUMAN-ONLY records attributed to the profile. Every count must be
 * supplied as 0 (or omitted, meaning "none found") for a retype to be allowed —
 * an unknown count is expressed by passing a positive number, never by omission.
 *
 * Deliberately excluded: tasks, events, expenses and ordinary documents. A car
 * has a registration task, an insurance renewal event, a fuel expense and a
 * title document, so those say nothing about being a person.
 */
export interface HumanRecordEvidence {
  /** Trackers linked to the profile (a log surface belongs to whoever it tracks). */
  trackers?: number;
  /** Entries under those trackers. */
  trackerEntries?: number;
  habits?: number;
  journalEntries?: number;
  /** Medication trackers / medication records attributed to the profile. */
  medications?: number;
  /** Linked documents that `isHealthDocument` accepts. */
  healthDocuments?: number;
}

/**
 * Field identities that only a person (or a pet) carries. Built from the field
 * vocabulary that actually exists in this app — the Info-page identity fields
 * (client/src/lib/profile-fields.ts PERSON_INFO_FIELDS / PET_INFO_FIELDS), the
 * registry `person` and `pet` schemas (scripts/seed-type-registry.ts), and the
 * alias table in shared/profile-field-identity.ts — not from guesses. Compared
 * through `fieldIdentity`, so `date_of_birth`, `dob`, `birthDate` and
 * `Date Of Birth` all collapse onto `birthday`.
 */
const PERSON_FIELD_KEYS = [
  // identity
  "birthday", "dateOfBirth", "dob", "age", "sex", "gender", "pronouns",
  "maidenName", "maritalStatus", "nationality",
  // contact / relationship
  "email", "phone", "mobile", "address", "relationship", "emergencyContact",
  "emergencyPhone", "spouse",
  // work / school
  "occupation", "employer", "jobTitle", "school", "grade", "student",
  // human health
  "bloodType", "allergies", "height", "weight", "medications", "physician",
  "primaryCare", "insuranceMemberId",
  // pet identity (a `pet` row is never retyped, but a person row carrying
  // these is an animal someone mistyped, not a possession)
  "species", "breed", "microchipId", "vet", "vetName", "vetPhone",
];
const PERSON_FIELD_IDENTITIES = new Set(PERSON_FIELD_KEYS.map(fieldIdentity));

/**
 * Longer, unambiguous fragments for spellings the list above cannot enumerate
 * ("birthPlace", "workEmail", "cellPhoneNumber", "relationshipToMe"). Short
 * fragments are NOT used here: "age" would match `mileage`, `garage` and
 * `coverage`, so those keys stay in the exact list above.
 */
const PERSON_FIELD_PATTERN =
  /(?:birth|email|phone|mobilenumber|relationship|occupation|employer|jobtitle|pronoun|gender|maritalstatus|spouse|allerg|bloodtype|emergency|socialsecurity|ssn|medication|prescription|diagnos|physician|doctor|pediatric|nickname)/;

const hasValue = (v: unknown) =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") &&
  !(Array.isArray(v) && v.length === 0);

/**
 * Every human-shaped field key the profile actually carries a value for, top
 * level and inside the nested display groups (`personal`, `identity`, `health`,
 * `contact`, …) that `fields` is allowed to use. Empty strings and empty arrays
 * are not evidence — the AI seeds blank keys.
 *
 * Exported so the repair can print WHY it left a row alone; the decision itself
 * lives in `isSafeToRetypeAsThing`.
 */
export function personFieldEvidence(fields: Record<string, any> | null | undefined): string[] {
  const found: string[] = [];
  const scan = (obj: Record<string, any>, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("_")) continue; // reserved metadata
      const norm = normalizeKey(key);
      if (PERSON_FIELD_IDENTITIES.has(fieldIdentity(key)) || PERSON_FIELD_PATTERN.test(norm)) {
        if (hasValue(value)) found.push(prefix + key);
        continue;
      }
      if (
        (PROFILE_FIELD_GROUPS as readonly string[]).includes(key) &&
        value && typeof value === "object" && !Array.isArray(value)
      ) {
        scan(value as Record<string, any>, `${key}.`);
      }
    }
  };
  if (fields && typeof fields === "object" && !Array.isArray(fields)) scan(fields, "");
  return found;
}

/**
 * The type a stored profile should be repaired to, or null to leave it alone.
 *
 * Returns "vehicle" / "asset" ONLY when every one of these holds:
 *   1. the row is typed exactly `person` — `self` and `pet` are never touched,
 *      and a row already typed vehicle/asset returns null, which is what makes
 *      the repair idempotent;
 *   2. the shared classifier says the name is asset-shaped (same call the
 *      create path makes, so one heuristic serves both);
 *   3. the row carries no human-shaped field with a value (`personFieldEvidence`);
 *   4. no human-only record is attributed to it (`HumanRecordEvidence`).
 *
 * Any doubt returns null: leaving a mistyped thing as a person is a cosmetic
 * bug that the people-picker filters already hide, while retyping a real person
 * is a silent corruption of ownership.
 */
export function isSafeToRetypeAsThing(
  profile: RetypeCandidateProfile | null | undefined,
  evidence: HumanRecordEvidence = {},
): ThingProfileType | null {
  if (!profile) return null;
  // 1. Only a plain `person` row. `self` is the account owner and `pet` is a
  //    living being; neither is ever a possession, whatever it is called.
  if (String(profile.type || "").trim().toLowerCase() !== "person") return null;

  // 2. Asset-shaped name — resolved through the SAME rule the create path uses.
  const target = coerceProfileType(profile.name, "person");
  if (target !== "vehicle" && target !== "asset") return null;

  // 3. No human-shaped field.
  if (personFieldEvidence(profile.fields).length > 0) return null;

  // 4. No human-only record.
  const counts = [
    evidence.trackers, evidence.trackerEntries, evidence.habits,
    evidence.journalEntries, evidence.medications, evidence.healthDocuments,
  ];
  if (counts.some((n) => typeof n === "number" && n > 0)) return null;

  return target;
}
