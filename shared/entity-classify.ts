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
