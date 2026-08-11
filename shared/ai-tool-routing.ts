// shared/ai-tool-routing.ts — STRICT ENTITY INTENT ROUTING.
//
// The gate between "the model emitted a tool_use block" and "we wrote to the
// database". Every write tool call is checked against the pre-execution intent
// object (shared/ai-intent.ts) parsed from the CURRENT user message.
//
// Three classes of failure this catches, all observed in production:
//
//  1. CREATE silently became UPDATE. "Create an asset for my Dodge Ram 2025"
//     ran update_profile because a similarly-named profile existed, and the
//     chat reported "Updated the Dodge Ram 2025". A create is a create; if a
//     duplicate would be dangerous the model must ASK, not switch operations.
//
//  2. WRONG ENTITY. The same request also produced a create_habit call, i.e.
//     a habit tool on an asset request.
//
//  3. HISTORY REPLAY. Tool calls for an OLD user message ("walk the dog",
//     "mow the lawn") fired again while handling a new one, so unrelated
//     action cards piled up under every later answer.
//
// Pure and dependency-free: the server gates on it, the tests pin it.

import {
  type IntentEntity,
  type IntentOperation,
  type ParsedIntent,
  type TurnIntentPlan,
  hasBackReference,
  hasExplicitUpdateIntent,
  isActionable,
  personAssetAmbiguous,
} from "./ai-intent";

/** Which entity a tool writes to, in INTENT terms (not storage terms). */
export const TOOL_INTENT_ENTITY: Record<string, IntentEntity> = {
  // Profiles / assets. `asset` and `profile` are the same table; the intent
  // distinction is what the user called it, and `areEntitiesCompatible`
  // treats them as interchangeable.
  //
  // NB: this is the TOOL-NAME-only reading. create_profile writes a person
  // when its `type` argument says person, and that is a different intent
  // entity — see `toolIntentEntity`, which every gate below goes through.
  create_profile: "asset", update_profile: "asset", delete_profile: "asset",
  revalue_asset: "asset", convert_expense_to_asset: "asset",
  repair_profile_types: "asset",
  link_asset_owner: "asset", split_ownership: "asset", merge_profiles: "asset",

  // Habits
  create_habit: "habit", update_habit: "habit", delete_habit: "habit",
  checkin_habit: "habit", uncomplete_habit: "habit", restore_habit: "habit",

  // Tasks
  create_task: "task", update_task: "task", delete_task: "task",
  complete_task: "task", restore_task: "task", bulk_complete_tasks: "task",

  // Events
  create_event: "event", update_event: "event", delete_event: "event",
  complete_event: "event",

  // (No reminders: retired 2026-08-09. "Remind me to X" is a task.)

  // Trackers + entries
  create_tracker: "tracker", update_tracker: "tracker", delete_tracker: "tracker",
  log_tracker_entry: "tracker", update_tracker_entry: "tracker",
  delete_tracker_entry: "tracker", log_medication_dose: "tracker",
  skip_medication_dose: "tracker",

  // Money
  create_expense: "expense", update_expense: "expense", delete_expense: "expense",
  refund_expense: "expense",
  log_income: "income", update_income: "income", delete_income: "income",
  log_expected_paycheck: "income", confirm_paycheck_received: "income",
  delete_paycheck: "income",

  create_obligation: "obligation", update_obligation: "obligation",
  delete_obligation: "obligation", pay_obligation: "obligation",
  undo_last_payment: "obligation",

  create_liability: "liability", update_liability: "liability",
  add_liability_payment: "liability", update_liability_payment: "liability",
  delete_liability_payment: "liability", mark_loan_payment: "liability",
  link_liability_asset: "liability", link_liability_owner: "liability",
  link_asset_to_liability: "liability", unlink_asset_from_liability: "liability",
  move_liability_to_asset: "liability",

  // Goals / journal / memory / artifacts / documents
  create_goal: "goal", update_goal: "goal", delete_goal: "goal",
  journal_entry: "journal", update_journal: "journal", delete_journal: "journal",
  save_memory: "memory", update_memory: "memory", delete_memory: "memory",
  create_artifact: "artifact", update_artifact: "artifact",
  delete_artifact: "artifact", duplicate_artifact: "artifact",
  toggle_artifact_item: "artifact",
  create_document: "document", upload_document: "document",
  manage_document: "document", link_document: "document",
};

/**
 * Profile `type` values that make the row a HUMAN (or the account owner).
 * These are the types that put a row in the people list, the owner badges and
 * the profile switcher — which is why filing a thing as one of them is so much
 * worse than filing it as the wrong kind of thing.
 */
export const IDENTITY_PROFILE_TYPES = new Set(["person", "self"]);

/**
 * Which entity a tool call writes to, reading its ARGUMENTS as well as its
 * name.
 *
 * `create_profile` is one tool for two very different requests: it writes an
 * asset when `type` is vehicle/asset/property/…, and a human when `type` is
 * "person" or "self". Gating on the tool name alone made those indistinguish-
 * able, so "create a Tires asset profile under my Dodge Ram" could answer with
 * create_profile(type:"person", name:"my tires for my Dodge ram") and pass
 * every check — which is exactly what production did, three times.
 */
export function toolIntentEntity(
  toolName: string,
  input?: Record<string, any> | null,
): IntentEntity | undefined {
  const base = TOOL_INTENT_ENTITY[toolName];
  if (!base) return undefined;
  if (toolName !== "create_profile" && toolName !== "update_profile") return base;
  const type = String(
    (input as any)?.type ?? (input as any)?.changes?.type ?? "",
  ).toLowerCase();
  if (!type) return base;
  return IDENTITY_PROFILE_TYPES.has(type) ? "person" : base;
}

/** What a tool DOES, in intent terms. */
export function toolOperation(toolName: string): IntentOperation {
  if (/^(delete_|remove_|unlink_)/.test(toolName)) return "delete";
  if (/^(create_|log_|add_|journal_entry$|save_memory$|upload_|duplicate_)/.test(toolName)) return "create";
  if (/^(complete_|checkin_|uncomplete_|toggle_|pay_|mark_)/.test(toolName)) return "complete";
  if (/^(get_|search|query_|recall_|find_|validate_|explain_|preview_)/.test(toolName)) return "read";
  return "update";
}

/**
 * Entities that mean the same thing at the storage layer, so a tool on one is
 * never a routing error for the other.
 *
 * - asset/profile: assets, vehicles and properties ARE profile rows.
 * - task/event: the two dated-item shapes. The app routes between them by what
 *   the thing IS — something you do vs something that happens — not by whether
 *   a clock time was given, since a task carries one. That routing is the
 *   system prompt's job, not this gate's.
 * - expense/income and obligation/liability: adjacent money shapes with
 *   documented cross-routing rules in the prompt.
 */
const COMPATIBLE: Array<Set<IntentEntity>> = [
  new Set<IntentEntity>(["asset", "profile"]),
  // A bare "profile" is genuinely ambiguous — "create a profile for my wife"
  // and "create a profile for my MacBook" are the same word — so it pairs with
  // BOTH. `person` and `asset` deliberately do NOT pair with each other: that
  // is the whole point of this change. Compatibility is checked pairwise, not
  // transitively, so person↔profile↔asset does not make person↔asset legal.
  new Set<IntentEntity>(["person", "profile"]),
  new Set<IntentEntity>(["task", "event"]),
  new Set<IntentEntity>(["expense", "income"]),
  // "Add a mouse for my computer, $50" — a price in the sentence reads as an
  // expense, but a physical item the user owns is an ASSET, and the prompt
  // routes it that way on purpose (there is a convert_expense_to_asset tool
  // for exactly this overlap). Without this pair the gate blocked every
  // nested asset that came with a price.
  new Set<IntentEntity>(["asset", "expense"]),
  new Set<IntentEntity>(["obligation", "liability", "expense"]),
  new Set<IntentEntity>(["tracker", "journal"]),
  new Set<IntentEntity>(["goal", "habit", "tracker"]),
];

export function areEntitiesCompatible(a: IntentEntity, b: IntentEntity): boolean {
  if (a === b) return true;
  if (a === "unknown" || b === "unknown") return true;
  return COMPATIBLE.some((set) => set.has(a) && set.has(b));
}

export type RoutingMismatch =
  | "create_downgraded_to_update"
  | "entity_mismatch"
  | "stale_turn_replay"
  | "duplicate_create_in_turn";

export interface RoutingViolation {
  mismatchType: RoutingMismatch;
  tool: string;
  expectedEntity: IntentEntity;
  actualEntity: IntentEntity;
  expectedOperation: IntentOperation;
  actualOperation: IntentOperation;
  /** Directive handed BACK TO THE MODEL as a tool error. Never user-facing. */
  modelDirective: string;
  /** What the user is told if this ends the turn. Always safe to render. */
  userMessage: string;
}

/** The create tool that should have been used for each entity. */
const CREATE_TOOL_FOR: Partial<Record<IntentEntity, string>> = {
  asset: "create_profile",
  profile: "create_profile",
  person: "create_profile",
  habit: "create_habit",
  task: "create_task",
  event: "create_event",
  tracker: "create_tracker",
  expense: "create_expense",
  income: "log_income",
  obligation: "create_obligation",
  liability: "create_liability",
  goal: "create_goal",
  journal: "journal_entry",
  memory: "save_memory",
  artifact: "create_artifact",
  document: "create_document",
};

/**
 * CREATE VS UPDATE SAFETY + ENTITY ROUTING.
 *
 * Checked against EVERY actionable intent in the message, because one message
 * can carry several requests ("add a task to call the dentist and log $20 for
 * lunch"). A tool is allowed if it serves any of them; it is blocked only when
 * it serves none.
 *
 * Returns null when the call is allowed. Violations are raised only against
 * ACTIONABLE intents (confident entity + write operation), so an ambiguous
 * message can never block a legitimate tool call.
 */
export function checkToolAgainstIntent(
  toolName: string,
  plan: TurnIntentPlan | ParsedIntent | ParsedIntent[],
  toolInput?: Record<string, any> | null,
): RoutingViolation | null {
  const actualEntity = toolIntentEntity(toolName, toolInput);
  // Unmapped tool (reads, system/dashboard tools, chart builders) — not gated.
  if (!actualEntity) return null;

  const normalized: TurnIntentPlan =
    Array.isArray(plan)
      ? { message: plan[0]?.sourceMessage ?? "", intents: plan, exhaustive: plan.length > 0 && plan.every(isActionable) }
      : "intents" in plan
        ? plan
        : { message: plan.sourceMessage, intents: [plan], exhaustive: isActionable(plan) };

  const all = normalized.intents.filter(isActionable);
  if (all.length === 0) return null;

  const actualOperation = toolOperation(toolName);
  if (actualOperation === "read") return null;

  // ── 1. Wrong entity ───────────────────────────────────────────────────────
  // Only when NO request in the message is about a compatible entity — AND we
  // parsed the whole message. A message with a clause we could not classify
  // may be asking for exactly what this tool does.
  const sameEntity = all.filter((i) => areEntitiesCompatible(i.entity, actualEntity));
  if (sameEntity.length === 0 && normalized.exhaustive) {
    const intent = all[0];
    // One message can legitimately ask for a person AND a thing ("add Bob and
    // his truck"); clause splitting can't separate those, so don't gate them.
    const personVsThing =
      (actualEntity === "person" && intent.entity === "asset") ||
      (actualEntity === "asset" && intent.entity === "person");
    if (personVsThing && personAssetAmbiguous(normalized.message)) return null;
    const want = CREATE_TOOL_FOR[intent.entity];
    // person/asset are the SAME tool with a different `type`, so "use
    // create_profile instead" would read as a no-op. Name the argument.
    const remedy =
      personVsThing && intent.operation === "create"
        ? ` Call create_profile with type:"${intent.entity === "person" ? "person" : "asset"}" (or the specific asset type) instead — never type:"person" for a thing.`
        : want && intent.operation === "create"
          ? ` Use ${want} instead.`
          : "";
    return {
      mismatchType: "entity_mismatch",
      tool: toolName,
      expectedEntity: intent.entity,
      actualEntity,
      expectedOperation: intent.operation,
      actualOperation,
      modelDirective:
        `Blocked: this message asks to ${all.map((i) => `${i.operation} a ${i.entity}`).join(" and ")}, ` +
        `but ${toolName} writes a ${actualEntity}. Do not call ${toolName} for this message.` +
        remedy,
      // A person conjured out of an asset request is a routing bug the user
      // did nothing to cause and the asset itself succeeded — saying "try
      // rephrasing" would be blaming them for a phrase that was fine.
      userMessage: personVsThing
        ? ""
        : `I couldn't complete that — the action didn't match what you asked for. Could you try rephrasing it?`,
    };
  }

  // ── 2. Create silently downgraded to update ───────────────────────────────
  // The user said CREATE. A same-named record existing is NOT permission to
  // update it instead: that is how "create an asset for my Dodge Ram" became
  // "Updated the Dodge Ram 2025". If ANY request for this entity did ask for
  // an update, the call is legitimate and passes.
  // Anywhere in the message asking for an edit ("...and change its mileage")
  // makes an update tool legitimate even if that clause didn't parse.
  if (
    actualOperation === "update" &&
    sameEntity.length > 0 &&
    sameEntity.every((i) => i.operation === "create") &&
    !hasExplicitUpdateIntent(normalized.message)
  ) {
    const intent = sameEntity[0];
    const want = CREATE_TOOL_FOR[intent.entity];
    return {
      mismatchType: "create_downgraded_to_update",
      tool: toolName,
      expectedEntity: intent.entity,
      actualEntity,
      expectedOperation: "create",
      actualOperation,
      modelDirective:
        `Blocked: the user asked to CREATE a new ${intent.entity}` +
        (intent.fields?.name ? ` ("${intent.fields.name}")` : "") +
        `, not to update an existing record. ` +
        (want ? `Call ${want} instead. ` : "") +
        `If a record with that name already exists and creating a duplicate would be wrong, ASK the user which they want — do not update on your own.`,
      userMessage: `You asked me to create that, but a similar record already exists. Do you want a new one, or should I update the existing record?`,
    };
  }

  return null;
}

// ── 7. Turn scoping: don't re-execute old requests ──────────────────────────

/** Words too common to identify a record. */
const STOPWORDS = new Set([
  "the", "a", "an", "my", "our", "your", "his", "her", "their", "for", "to", "of",
  "and", "or", "with", "at", "on", "in", "it", "is", "was", "me", "i", "new",
  "create", "add", "make", "set", "log", "day", "daily", "week", "weekly",
]);

function tokenize(text: unknown): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** The name/title a tool call is about, from whichever field carries it. */
export function toolTargetLabel(input: Record<string, any> | undefined | null): string {
  if (!input || typeof input !== "object") return "";
  for (const key of ["name", "title", "trackerName", "description", "key", "query"]) {
    const v = (input as any)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Is this tool call a REPLAY of an earlier user message rather than work for
 * the current one?
 *
 * True only when ALL of these hold, which makes false positives very hard:
 *   - the call names a target at all;
 *   - none of that target's distinctive words appear in the current message;
 *   - they DO appear in an earlier user message in this conversation;
 *   - the current message contains no back-reference ("do it again", "delete
 *     that one") that would legitimately point at older context.
 *
 * "Create a habit to walk the dog" followed later by "Create an asset for my
 * Dodge Ram" → a create_habit("Walk the Dog") call on the second turn is
 * replay. A create_profile("Dodge Ram 2025") call is not.
 */
export function isStaleTurnReplay(
  toolInput: Record<string, any> | undefined | null,
  currentMessage: string,
  priorUserMessages: string[],
): boolean {
  const label = toolTargetLabel(toolInput);
  if (!label) return false;
  if (hasBackReference(currentMessage)) return false;

  const labelTokens = tokenize(label);
  if (labelTokens.length === 0) return false;

  const currentTokens = new Set(tokenize(currentMessage));
  // Any overlap with the current message means this call is about THIS turn.
  if (labelTokens.some((t) => currentTokens.has(t))) return false;

  // Every distinctive word of the target must be traceable to an older turn —
  // otherwise the model invented a name and that is a different problem.
  const priorTokens = new Set(priorUserMessages.flatMap(tokenize));
  return labelTokens.every((t) => priorTokens.has(t));
}

// ── One request, one record ─────────────────────────────────────────────────

/** A create this turn already performed. */
export interface TurnCreate {
  tool: string;
  entity: IntentEntity;
  /** Determiner-free, punctuation-free, lowercased name. */
  key: string;
  /** True when this create wrote a HUMAN row (create_profile type person/self). */
  identity?: boolean;
}

/**
 * Name key for same-turn duplicate detection. Drops the determiners and
 * punctuation that let one request produce two records: "my MacBook Pro m4"
 * and "MacBook Pro M4" are the same laptop.
 */
export function createNameKey(label: string): string {
  return String(label ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:my|our|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Has this turn already created this exact thing?
 *
 * Regression (2026-08-09): "Create a profile for my MacBook Pro m4" ran
 * create_profile TWICE — once as an asset named "MacBook Pro M4", once as a
 * person named "my MacBook Pro m4" — and the user got two records from one
 * request. A create request produces ONE record.
 *
 * Matched on the NAME, not on the entity alone, so "add my cat Luna and my dog
 * Rex" (two creates, two names) is untouched. Only a second create of the
 * SAME name on a compatible entity is refused.
 */
export function findDuplicateCreateInTurn(
  toolName: string,
  input: Record<string, any> | undefined | null,
  priorCreates: TurnCreate[],
): TurnCreate | null {
  if (toolOperation(toolName) !== "create") return null;
  const entity = TOOL_INTENT_ENTITY[toolName];
  if (!entity) return null;
  const key = createNameKey(toolTargetLabel(input));
  if (!key) return null;
  const exact = priorCreates.find(
    (c) => c.key === key && areEntitiesCompatible(c.entity, entity),
  );
  if (exact) return exact;

  // ── The person-shadow rule ────────────────────────────────────────────────
  // Exact-key matching only catches the shadow when the two names differ by a
  // determiner ("MacBook Pro M4" vs "my MacBook Pro m4"). Production produced
  // wordier shadows that slipped straight past it:
  //
  //   asset "Tires"           + person "my tires for my Dodge ram"
  //   vehicle "Dodge Ram 2025" + person "my 2025 Dodge ram"
  //
  // Both are one request that wrote two records, the second of them a human.
  // So when a create_profile crosses the identity boundary — a person after a
  // thing, or a thing after a person, in the SAME turn — match on the words
  // instead: if either name's distinctive words are contained in the other's,
  // it is the same subject wearing a different type.
  //
  // Scoped to the identity boundary on purpose. Word-containment is too loose
  // to apply generally ("add my Honda and my Honda Civic" is two vehicles),
  // but across person-vs-thing there is no legitimate reading: nobody asks for
  // a person and a possession that share a name in one breath.
  if (toolName !== "create_profile") return null;
  const isIdentity = isIdentityCreate(toolName, input);
  const mine = distinctiveWords(key);
  if (mine.size === 0) return null;
  return (
    priorCreates.find((c) => {
      // Both sides must be profile creates, and exactly one of them a human.
      if (c.tool !== "create_profile") return false;
      if (!!c.identity === isIdentity) return false;
      const theirs = distinctiveWords(c.key);
      if (theirs.size === 0) return false;
      return isSubsetOf(mine, theirs) || isSubsetOf(theirs, mine);
    }) ?? null
  );
}

function isIdentityCreate(toolName: string, input: Record<string, any> | undefined | null): boolean {
  if (toolName !== "create_profile") return false;
  return IDENTITY_PROFILE_TYPES.has(String((input as any)?.type ?? "").toLowerCase());
}

/** Name words worth comparing — createNameKey has already dropped determiners. */
function distinctiveWords(key: string): Set<string> {
  return new Set(key.split(" ").filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

export function recordTurnCreate(toolName: string, input: Record<string, any> | undefined | null): TurnCreate | null {
  if (toolOperation(toolName) !== "create") return null;
  const entity = TOOL_INTENT_ENTITY[toolName];
  const key = createNameKey(toolTargetLabel(input));
  if (!entity || !key) return null;
  return { tool: toolName, entity, key, identity: isIdentityCreate(toolName, input) };
}

export function duplicateCreateViolation(toolName: string, label: string, prior: TurnCreate): RoutingViolation {
  const entity = TOOL_INTENT_ENTITY[toolName] ?? "unknown";
  return {
    mismatchType: "duplicate_create_in_turn",
    tool: toolName,
    expectedEntity: prior.entity,
    actualEntity: entity,
    expectedOperation: "create",
    actualOperation: "create",
    modelDirective:
      `Blocked: you already created "${prior.key}" in this turn with ${prior.tool}` +
      (prior.identity ? " (as a person)" : "") +
      `, and "${label}" is the same subject. ` +
      `One request creates ONE record — do not create it a second time under a different type or spelling, ` +
      `and never mirror a thing you just created as a person profile. ` +
      `If you need to add details to it, call the matching update tool instead.`,
    // Silent: the first create's card already tells the user it exists.
    userMessage: "",
  };
}

export function staleReplayViolation(toolName: string, label: string): RoutingViolation {
  const entity = TOOL_INTENT_ENTITY[toolName] ?? "unknown";
  return {
    mismatchType: "stale_turn_replay",
    tool: toolName,
    expectedEntity: entity,
    actualEntity: entity,
    expectedOperation: toolOperation(toolName),
    actualOperation: toolOperation(toolName),
    modelDirective:
      `Blocked: "${label}" belongs to an EARLIER message in this conversation and was already handled. ` +
      `Respond only to the user's current message — do not re-run past requests.`,
    userMessage: "",
  };
}
