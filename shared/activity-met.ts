// MET vocabulary for activity energy expenditure — pure, no I/O, no LLM.
//
// This module holds DATA, not math: the metabolic-equivalent value of an
// activity and the multiplier for a stated intensity. shared/estimation-engine
// does the arithmetic (kcal = MET × weight × hours) so that calories are
// derived from THE LOGGING PERSON'S OWN weight instead of a flat per-minute
// rate. Before this existed the language model was handed a weight-independent
// table ("Basketball: ~7 cal/min"), so two people who played the same game got
// byte-identical calorie numbers no matter how differently they were built.
//
// Keys are normalizeEntityName()'d so they line up with the activity
// vocabulary in shared/entity-classify.ts; tests/activity-met-estimation.test.ts
// loops those lists and asserts every term resolves here.
//
// MET values are the moderate-effort entries from the Compendium of Physical
// Activities (Ainsworth et al.). "Moderate" IS the baseline, which is what
// makes it the honest default when the user says nothing about effort.

import { normalizeEntityName, SPORTS, CARDIO, STRENGTH, FLEXIBILITY } from "./entity-classify";

export interface MetResolution {
  /** Normalized key that matched, or the normalized input when nothing did. */
  key: string;
  met: number;
  /** False when we fell back to the generic MET — lowers confidence downstream. */
  matched: boolean;
  /** Human label for the method string, e.g. "basketball". */
  label: string;
}

/** Generic moderate physical activity — used when the activity isn't recognized. */
export const DEFAULT_ACTIVITY_MET = 4.0;

/** What we assume when the user describes no effort level. */
export const DEFAULT_ACTIVITY_INTENSITY = "moderate";

/** Same numbers the cardio branch of estimation-engine already uses, so a
 * "hard" basketball game and a "hard" run scale identically. */
const LIGHT_MULT = 0.85;
const INTENSE_MULT = 1.15;

const LIGHT_WORDS = /^(light|easy|low|gentle|relaxed|casual)$/;
const INTENSE_WORDS = /^(intense|hard|vigorous|high|max|maximal|all out)$/;

export const MET_TABLE: Record<string, number> = {
  // ── cardio ──
  walking: 3.5, walk: 3.5, rucking: 6.0,
  running: 9.8, run: 9.8, jog: 7.0, jogging: 7.0, sprint: 12.0,
  cycling: 7.5, biking: 7.5, bike: 7.5, "spin class": 8.5, spinning: 8.5,
  swimming: 5.8, swim: 5.8,
  hiking: 6.0, hike: 6.0,
  elliptical: 5.0, treadmill: 6.0,
  rowing: 7.0, row: 7.0,
  "jump rope": 12.3, "jumping jack": 8.0,
  stairmaster: 9.0, "stair climber": 9.0, "stair stepper": 9.0,
  hiit: 8.0, cardio: 6.0, aerobic: 6.5, zumba: 6.5,
  dancing: 5.0, "dance workout": 6.0,

  // ── sports ──
  basketball: 6.5, tennis: 7.3, soccer: 7.0, football: 8.0,
  volleyball: 4.0, baseball: 5.0, softball: 5.0, hockey: 8.0,
  golf: 4.8, pickleball: 5.5, badminton: 5.5, cricket: 4.8,
  rugby: 8.3, lacrosse: 8.0,
  skiing: 7.0, snowboarding: 5.3, skating: 7.0, "ice skating": 7.0,
  rollerblading: 7.5, surfing: 5.0, skateboarding: 5.0, bowling: 3.0,
  boxing: 7.8, kickboxing: 8.3, mma: 10.3, "jiu jitsu": 10.3, bjj: 10.3,
  judo: 10.3, karate: 10.3, taekwondo: 10.3, "muay thai": 10.3, wrestling: 6.0,
  climbing: 8.0, bouldering: 8.0, "rock climbing": 8.0,
  frisbee: 3.0, "ultimate frisbee": 8.0,
  "table tennis": 4.0, "ping pong": 4.0, squash: 7.3, racquetball: 7.0,
  archery: 4.3, fencing: 6.0, dodgeball: 5.0, handball: 8.0,
  polo: 8.0, "water polo": 10.0,
  kayaking: 5.0, paddleboarding: 6.0, canoeing: 5.0,

  // ── flexibility / mind-body ──
  yoga: 2.5, stretching: 2.3, stretch: 2.3, pilates: 3.0,
  "tai chi": 3.0, mobility: 2.3, "foam rolling": 2.3, barre: 3.5,

  // ── strength: one moderate baseline, with the explosive moves called out ──
  "strength training": 5.0, "resistance training": 5.0,
  weightlifting: 5.0, "weight lifting": 5.0, lifting: 5.0,
  "bodyweight workout": 4.5, calisthenic: 4.5,
  burpee: 8.0, snatch: 6.0, "clean and jerk": 6.0, "power clean": 6.0,
  kettlebell: 8.0, "kettlebell swing": 8.0,
  plank: 3.0, crunch: 3.8, "sit up": 3.8, situp: 3.8,
  "russian twist": 3.8, "leg raise": 3.8,
  "push up": 4.5, pushup: 4.5, "pull up": 5.0, pullup: 5.0,
  "chin up": 5.0, chinup: 5.0, dip: 5.0,
  "bench press": 5.0, "incline press": 5.0, "overhead press": 5.0,
  "shoulder press": 5.0, "military press": 5.0,
  squat: 5.0, "front squat": 5.0, "back squat": 5.0, "goblet squat": 5.0,
  deadlift: 6.0, "romanian deadlift": 6.0,
  lunge: 4.0, "bicep curl": 3.5, curl: 3.5, "hammer curl": 3.5,
  "tricep extension": 3.5, "skull crusher": 3.5,
  "barbell row": 5.0, "dumbbell row": 5.0, "lat pulldown": 5.0,
  "leg press": 5.0, "leg extension": 3.5, "leg curl": 3.5,
  "calf raise": 3.5, "hip thrust": 5.0, "glute bridge": 3.5,
  "face pull": 3.5, shrug: 3.5,
  "farmer carry": 5.0, "farmers carry": 5.0,
  dumbbell: 5.0, barbell: 5.0,
};

/** Keys longest-first so "rock climbing" wins over "climbing" and
 * "table tennis" over "tennis". Computed once. */
const KEYS_BY_LENGTH = Object.keys(MET_TABLE).sort((a, b) => b.length - a.length);

/**
 * Resolve an activity phrase (values.activityType, else the tracker name) to
 * its MET. Falls back to a generic moderate MET rather than refusing: a
 * missing lookup must never block a log, it only lowers confidence.
 */
export function resolveActivityMet(raw: string): MetResolution {
  const name = normalizeEntityName(raw);
  if (!name) return { key: "", met: DEFAULT_ACTIVITY_MET, matched: false, label: "activity" };

  // 1. exact
  if (MET_TABLE[name] != null) return { key: name, met: MET_TABLE[name], matched: true, label: name };

  // 2. longest whole-word phrase contained in the name ("Morning Basketball")
  const padded = ` ${name} `;
  for (const key of KEYS_BY_LENGTH) {
    if (padded.includes(` ${key} `)) return { key, met: MET_TABLE[key], matched: true, label: key };
  }

  // 3. single token ("Basketballs" won't match, but "Basketball Game" already did above)
  for (const token of name.split(" ")) {
    if (MET_TABLE[token] != null) return { key: token, met: MET_TABLE[token], matched: true, label: token };
  }

  return { key: name, met: DEFAULT_ACTIVITY_MET, matched: false, label: name };
}

/**
 * Effort multiplier for a stated intensity. `stated` is false when the user
 * described no effort level — the caller registers the moderate assumption.
 */
export function intensityMultiplier(raw: unknown): { mult: number; label: string; stated: boolean } {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return { mult: 1, label: DEFAULT_ACTIVITY_INTENSITY, stated: false };
  // Numeric 1-3 zones, as the tool schema allows.
  if (s === "1") return { mult: LIGHT_MULT, label: "light", stated: true };
  if (s === "2") return { mult: 1, label: "moderate", stated: true };
  if (s === "3") return { mult: INTENSE_MULT, label: "intense", stated: true };
  if (LIGHT_WORDS.test(s)) return { mult: LIGHT_MULT, label: s, stated: true };
  if (INTENSE_WORDS.test(s)) return { mult: INTENSE_MULT, label: s, stated: true };
  return { mult: 1, label: s, stated: true };
}

/** Every activity term the classifier knows — the sync surface for tests. */
export const KNOWN_ACTIVITY_TERMS: string[] = [...CARDIO, ...SPORTS, ...STRENGTH, ...FLEXIBILITY];
