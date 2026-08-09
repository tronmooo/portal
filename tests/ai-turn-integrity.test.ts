// Regression pins for the 2026-08-09 chat hallucination / routing / validation
// report. Every case here is one of the four screenshots or one of the exact
// prompts the remediation spec listed under "TEST THESE EXACT REGRESSIONS".
//
// Screenshot 1: "Create me a habit too walk the dog twice a day"
//   → "habits are binary daily check-ins … or I can create two separate
//      habits" — a limitation that no longer exists, plus a stale action card
//      ("MOW THE LAWN — Set Reminder") from an earlier turn.
// Screenshot 3: "Create an asset for my Dodge ram 2025 it's white
//   four-wheel-drive" → "Updated the Dodge Ram 2025" (an UPDATE described as
//   an asset creation), two more stale cards, and raw evaluator text:
//   "Walk the Dog — The user didn't ask for a habit — do NOT create one.
//    Log the activity with log_tracker_entry(trackerName:"Walk the Dog")…"
import { describe, it, expect } from "vitest";
import {
  parseTurnIntent,
  parseTurnIntents,
  parseDailyTarget,
  detectOperation,
  detectEntity,
  extractEntityName,
  hasExplicitUpdateIntent,
  isActionable,
} from "@shared/ai-intent";
import {
  checkToolAgainstIntent,
  isStaleTurnReplay,
  toolOperation,
  TOOL_INTENT_ENTITY,
  areEntitiesCompatible,
  createNameKey,
  findDuplicateCreateInTurn,
  recordTurnCreate,
  duplicateCreateViolation,
} from "@shared/ai-tool-routing";
import { stripLeadingDeterminer } from "@shared/entity-naming";
import {
  isInternalDirective,
  toUserFacingError,
  stripInternalText,
  isRenderable,
  RENDERABLE_KINDS,
} from "@shared/ai-message-kinds";
import {
  checkClaims,
  extractSuccessClaims,
  findStaleCapabilityClaims,
  stripStaleCapabilityClaims,
  honestFailureReply,
  groundedSummary,
} from "@shared/ai-claim-check";

// The exact strings from the report.
const HABIT_MSG = "Create me a habit too walk the dog twice a day";
const SOCCER_MSG = "Create me a reoccurring event soccer at 7 AM on Tuesdays for the next year";
const ASSET_MSG = "Create an asset for my Dodge ram 2025 it's white four-wheel-drive";
const LEAKED_ERROR =
  'The user didn\'t ask for a habit — do NOT create one. Log the activity with log_tracker_entry(trackerName:"Walk the Dog") instead, keeping every quantity, method, and timestamp they stated.';
const BINARY_REPLY =
  '"Walk the Dog" habit created (daily). Note: habits are binary daily check-ins — you\'ll check it off twice each day manually, or I can create two separate habits (morning & evening walk) if you\'d prefer.';

// ── 1. Habit capability model ───────────────────────────────────────────────

describe("habit daily targets", () => {
  it("reads 'twice a day' as a target of 2", () => {
    expect(parseDailyTarget(HABIT_MSG)).toBe(2);
  });

  it("reads every phrasing of a per-day count", () => {
    const cases: Array<[string, number]> = [
      ["walk the dog twice a day", 2],
      ["walk the dog twice daily", 2],
      ["brush teeth 3x daily", 3],
      ["brush teeth three times a day", 3],
      ["take it 2 times per day", 2],
      ["stretch four times each day", 4],
      ["meds morning and night", 2],
      ["water the plants once a day", 1],
    ];
    for (const [msg, want] of cases) {
      expect(parseDailyTarget(msg), msg).toBe(want);
    }
  });

  it("does NOT invent a daily target from a non-daily cadence", () => {
    for (const msg of [
      "walk the dog twice a week",
      "pay rent once a month",
      "meet three times this quarter",
      "create a habit to meditate",
    ]) {
      expect(parseDailyTarget(msg), msg).toBeNull();
    }
  });

  it("clamps to the 1-10 range the habit schema accepts", () => {
    expect(parseDailyTarget("check it 40 times a day")).toBe(10);
  });

  it("puts the target on the ONE habit the message asked for", () => {
    const intent = parseTurnIntent(HABIT_MSG);
    expect(intent.entity).toBe("habit");
    expect(intent.operation).toBe("create");
    expect(intent.fields.dailyTarget).toBe(2);
    // One request, therefore one habit.
    expect(parseTurnIntents(HABIT_MSG).filter(isActionable)).toHaveLength(1);
  });
});

describe("stale capability claims", () => {
  it("flags the binary-habit disclaimer from the screenshot", () => {
    const found = findStaleCapabilityClaims(BINARY_REPLY);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].mismatchType).toBe("claimed_stale_capability");
  });

  it("flags the offer to split one habit into two", () => {
    expect(
      findStaleCapabilityClaims("I can create two separate habits (morning & evening) if you'd prefer.").length,
    ).toBeGreaterThan(0);
  });

  it("strips the disclaimer but keeps the real confirmation", () => {
    const cleaned = stripStaleCapabilityClaims(BINARY_REPLY);
    expect(cleaned).toContain("Walk the Dog");
    expect(cleaned.toLowerCase()).not.toContain("binary");
    expect(cleaned.toLowerCase()).not.toContain("two separate habits");
  });

  it("leaves an honest habit confirmation alone", () => {
    const good = 'Created the "Walk the Dog" habit — 2× per day.';
    expect(findStaleCapabilityClaims(good)).toHaveLength(0);
    expect(stripStaleCapabilityClaims(good)).toBe(good);
  });
});

// ── 2. Strict entity intent routing ─────────────────────────────────────────

describe("entity intent routing", () => {
  it("resolves the Dodge Ram request to entity=asset, operation=create", () => {
    const intent = parseTurnIntent(ASSET_MSG);
    expect(intent.entity).toBe("asset");
    expect(intent.operation).toBe("create");
    expect(intent.target).toBeNull();
    expect(intent.fields.name).toBe("Dodge ram 2025");
    expect(intent.fields.color).toBe("white");
    expect(intent.fields.driveType).toBe("4WD");
    expect(intent.fields.year).toBe(2025);
    expect(isActionable(intent)).toBe(true);
  });

  it("extracts the entity name without the trailing attributes", () => {
    expect(extractEntityName(ASSET_MSG)).toBe("Dodge ram 2025");
    expect(extractEntityName("Create an asset for my Dodge Ram 2025. It's white, four-wheel-drive."))
      .toBe("Dodge Ram 2025");
  });

  it("blocks update_profile on a create-an-asset request", () => {
    const v = checkToolAgainstIntent("update_profile", parseTurnIntents(ASSET_MSG));
    expect(v?.mismatchType).toBe("create_downgraded_to_update");
    expect(v?.modelDirective).toContain("create_profile");
  });

  it("blocks create_habit and create_tracker on the same request", () => {
    for (const tool of ["create_habit", "create_tracker", "checkin_habit"]) {
      const v = checkToolAgainstIntent(tool, parseTurnIntents(ASSET_MSG));
      expect(v?.mismatchType, tool).toBe("entity_mismatch");
    }
  });

  it("allows create_profile — the tool the request actually names", () => {
    expect(checkToolAgainstIntent("create_profile", parseTurnIntents(ASSET_MSG))).toBeNull();
  });

  it("allows the recurring-soccer turn to create an event and nothing else", () => {
    const intents = parseTurnIntents(SOCCER_MSG);
    expect(intents[0].entity).toBe("event");
    expect(intents[0].operation).toBe("create");
    expect(checkToolAgainstIntent("create_event", intents)).toBeNull();
    expect(checkToolAgainstIntent("create_habit", intents)?.mismatchType).toBe("entity_mismatch");
    expect(checkToolAgainstIntent("create_profile", intents)?.mismatchType).toBe("entity_mismatch");
  });

  it("allows create_habit on the habit turn", () => {
    expect(checkToolAgainstIntent("create_habit", parseTurnIntents(HABIT_MSG))).toBeNull();
  });
});

describe("multi-request messages are not false positives", () => {
  const MULTI = "Add a task to call the dentist and log $20 for lunch";

  it("parses one intent per request", () => {
    const entities = parseTurnIntents(MULTI).filter(isActionable).map((i) => i.entity);
    expect(entities).toContain("task");
    expect(entities).toContain("expense");
  });

  it("allows the tool for each request", () => {
    const intents = parseTurnIntents(MULTI);
    expect(checkToolAgainstIntent("create_task", intents)).toBeNull();
    expect(checkToolAgainstIntent("create_expense", intents)).toBeNull();
  });

  it("never gates on an ambiguous message", () => {
    for (const msg of ["how much did I spend on groceries", "thanks!", "180 lbs"]) {
      for (const tool of ["create_task", "update_profile", "log_tracker_entry"]) {
        expect(checkToolAgainstIntent(tool, parseTurnIntents(msg)), `${msg} / ${tool}`).toBeNull();
      }
    }
  });

  it("leaves unmapped tools (reads, system tools) ungated", () => {
    const intents = parseTurnIntents(ASSET_MSG);
    for (const tool of ["search", "get_summary", "generate_chart", "navigate", "recall_memory"]) {
      expect(checkToolAgainstIntent(tool, intents), tool).toBeNull();
    }
  });
});

// ── 3. Create vs update safety ──────────────────────────────────────────────

describe("create vs update safety", () => {
  it("treats create language as CREATE even when a like-named record exists", () => {
    for (const msg of [
      "Create an asset for my Dodge Ram",
      "Add a new Dodge Ram 2025",
      "Make an asset for the truck",
      "Register an asset for my trailer",
    ]) {
      expect(detectOperation(msg), msg).toBe("create");
      expect(hasExplicitUpdateIntent(msg), msg).toBe(false);
    }
  });

  it("switches to UPDATE only on the user's own update language", () => {
    for (const msg of [
      "Update my Dodge Ram to white",
      "Change the color of my Dodge Ram",
      "Edit the Dodge Ram asset",
      "Modify my truck's mileage",
      "Make my existing Dodge Ram four-wheel-drive",
      "The Dodge Ram I already have is white",
    ]) {
      expect(hasExplicitUpdateIntent(msg), msg).toBe(true);
    }
  });

  it("allows update_profile once the user actually asks for an update", () => {
    const intents = parseTurnIntents("Update my Dodge Ram 2025 — it's white four-wheel-drive");
    expect(intents[0].operation).toBe("update");
    expect(checkToolAgainstIntent("update_profile", intents)).toBeNull();
  });

  it("gives the model a directive that names the right tool", () => {
    const v = checkToolAgainstIntent("update_profile", parseTurnIntents(ASSET_MSG));
    expect(v?.modelDirective).toMatch(/ASK the user/i);
    expect(v?.userMessage).not.toMatch(/create_profile|update_profile/);
  });
});

// ── 4 + 5. Tool-result-grounded responses ───────────────────────────────────

describe("claims must match executed tool results", () => {
  it("catches the exact screenshot lie: 'Updated the Dodge Ram' with no write", () => {
    const res = checkClaims({
      reply: "Updated the Dodge Ram 2025 — color: white, drive type: 4WD.",
      operations: [{ tool: "update_profile", status: "failed" }],
    });
    expect(res.unsupportedSuccess).toBe(true);
    expect(res.violations[0].mismatchType).toBe("claimed_success_without_write");
  });

  it("catches 'Created' when only an update ran", () => {
    const res = checkClaims({
      reply: "Created the Dodge Ram 2025 asset.",
      operations: [{ tool: "update_profile", status: "ok", entityId: "p1" }],
      intentEntity: "asset",
      intentOperation: "create",
    });
    expect(res.violations.some((v) => v.mismatchType === "claimed_create_but_updated")).toBe(true);
  });

  it("catches 'Updated' when only a create ran", () => {
    const res = checkClaims({
      reply: "Updated the Dodge Ram 2025 — color: white, drive type: 4WD.",
      operations: [{ tool: "create_profile", status: "ok", entityId: "p1" }],
      intentEntity: "asset",
      intentOperation: "create",
    });
    expect(res.violations.some((v) => v.mismatchType === "claimed_entity_not_written")).toBe(true);
  });

  it("catches a habit write on an asset turn", () => {
    const res = checkClaims({
      reply: "Created the habit.",
      operations: [{ tool: "create_habit", status: "ok", entityId: "h1" }],
      intentEntity: "asset",
      intentOperation: "create",
    });
    expect(res.violations.some((v) => v.mismatchType === "claimed_entity_not_written")).toBe(true);
  });

  it("passes a grounded reply", () => {
    const res = checkClaims({
      reply: "Created the Dodge Ram 2025 asset — white, 4WD.",
      operations: [{ tool: "create_profile", status: "ok", entityId: "p1" }],
      intentEntity: "asset",
      intentOperation: "create",
    });
    expect(res.violations).toHaveLength(0);
    expect(res.unsupportedSuccess).toBe(false);
  });

  it("does not treat offers or questions as claims", () => {
    for (const reply of [
      "I'll create that for you — want me to?",
      "Should I create a second one?",
      "Do you want me to add a reminder?",
      "I couldn't create that — nothing was saved.",
    ]) {
      expect(extractSuccessClaims(reply), reply).toHaveLength(0);
    }
  });

  it("offers an honest reply when nothing landed", () => {
    expect(honestFailureReply([])).toMatch(/nothing was saved/i);
    expect(honestFailureReply([{ tool: "create_profile", status: "failed" }])).toMatch(/couldn'?t complete/i);
  });

  it("rebuilds the summary from what executed when the prose disagreed", () => {
    const summary = groundedSummary([
      { tool: "create_profile", status: "ok", entityId: "p1", raw: "Dodge Ram 2025" },
    ]);
    expect(summary).toContain("Created");
    expect(summary).toContain("Dodge Ram 2025");
    expect(summary).not.toMatch(/updated/i);
  });

  it("names the real operation for an update, and reports partial failure", () => {
    const summary = groundedSummary([
      { tool: "update_profile", status: "ok", entityId: "p1", raw: "Dodge Ram 2025" },
      { tool: "create_habit", status: "failed", raw: "Walk the Dog" },
    ]);
    expect(summary).toContain("Updated");
    expect(summary).toMatch(/1 step didn'?t go through/i);
  });

  it("falls back to the honest failure text when nothing succeeded", () => {
    expect(groundedSummary([{ tool: "create_profile", status: "failed" }])).toMatch(/couldn'?t complete/i);
  });
});

// ── 6. Internal debug text must never render ────────────────────────────────

describe("internal text never reaches the user", () => {
  it("recognises the leaked evaluator message from the screenshot", () => {
    expect(isInternalDirective(LEAKED_ERROR)).toBe(true);
  });

  it("recognises every shape of model-facing directive", () => {
    for (const s of [
      "The user didn't ask for a habit — do NOT create one.",
      'Log the activity with log_tracker_entry(trackerName:"Walk the Dog") instead.',
      "Tell the user the save failed; do NOT report success.",
      "Blocked: the user asked to create a asset, but create_habit writes a habit.",
      "NOT_A_HABIT_REQUEST",
      "Instead, call create_profile.",
    ]) {
      expect(isInternalDirective(s), s).toBe(true);
    }
  });

  it("passes through errors already written for a human", () => {
    for (const s of [
      "I couldn't find a task called 'stretching'.",
      "That took too long — please try again.",
      "Amount must be a positive number.",
    ]) {
      expect(isInternalDirective(s), s).toBe(false);
      expect(toUserFacingError(s), s).toBe(s);
    }
  });

  it("replaces a directive with a plain sentence naming no internals", () => {
    const out = toUserFacingError(LEAKED_ERROR, "create_habit");
    expect(out).not.toMatch(/do NOT|log_tracker_entry|the user/i);
    expect(out.length).toBeGreaterThan(0);
    expect(isInternalDirective(out)).toBe(false);
  });

  it("strips directive lines the model echoed into its reply", () => {
    const reply = "Saved the Dodge Ram 2025.\nThe user didn't ask for a habit — do NOT create one.";
    const out = stripInternalText(reply);
    expect(out).toBe("Saved the Dodge Ram 2025.");
  });

  it("only ever renders user, assistant and action-card messages", () => {
    expect([...RENDERABLE_KINDS].sort()).toEqual(["action_card", "assistant_message", "user_message"]);
    for (const kind of ["internal_reasoning", "evaluation", "debug", "tool_result"] as const) {
      expect(isRenderable(kind), kind).toBe(false);
    }
  });
});

// ── 7 + 8. Turn scoping and action-card isolation ───────────────────────────

describe("old requests are not re-executed on a new turn", () => {
  // The exact sequence from the report.
  const history = [HABIT_MSG, SOCCER_MSG];

  it("flags the stale habit and reminder calls fired on the Dodge Ram turn", () => {
    expect(isStaleTurnReplay({ name: "Walk the Dog" }, ASSET_MSG, history)).toBe(true);
    expect(isStaleTurnReplay({ title: "Soccer" }, ASSET_MSG, history)).toBe(true);
  });

  it("does NOT flag the turn's own work", () => {
    expect(isStaleTurnReplay({ name: "Dodge ram 2025" }, ASSET_MSG, history)).toBe(false);
    expect(isStaleTurnReplay({ name: "Walk the Dog" }, HABIT_MSG, [])).toBe(false);
    expect(isStaleTurnReplay({ title: "Soccer" }, SOCCER_MSG, [HABIT_MSG])).toBe(false);
  });

  it("does NOT flag a legitimate back-reference to an earlier turn", () => {
    for (const msg of [
      "delete the one I just made",
      "do that again",
      "change that to three times a day",
      "undo it",
    ]) {
      expect(isStaleTurnReplay({ name: "Walk the Dog" }, msg, history), msg).toBe(false);
    }
  });

  it("does not flag a call with no target name", () => {
    expect(isStaleTurnReplay({}, ASSET_MSG, history)).toBe(false);
    expect(isStaleTurnReplay({ amount: 20 }, ASSET_MSG, history)).toBe(false);
  });

  it("does not flag a name the user never said before either", () => {
    // Invented names are a different failure (fabrication), not replay.
    expect(isStaleTurnReplay({ name: "Quarterly Tax Filing" }, ASSET_MSG, history)).toBe(false);
  });

  it("keeps each prompt in the reported sequence to its own actions", () => {
    const turns: Array<{ msg: string; tool: string }> = [
      { msg: HABIT_MSG, tool: "create_habit" },
      { msg: SOCCER_MSG, tool: "create_event" },
      { msg: ASSET_MSG, tool: "create_profile" },
    ];
    turns.forEach(({ msg, tool }, i) => {
      const prior = turns.slice(0, i).map((t) => t.msg);
      const intents = parseTurnIntents(msg);
      // Its own tool is allowed…
      expect(checkToolAgainstIntent(tool, intents), `${msg} / ${tool}`).toBeNull();
      // …and every earlier turn's tool is refused.
      for (const earlier of turns.slice(0, i)) {
        const blocked =
          checkToolAgainstIntent(earlier.tool, intents) !== null ||
          isStaleTurnReplay({ name: earlier.msg.includes("habit") ? "Walk the Dog" : "Soccer" }, msg, prior);
        expect(blocked, `${msg} must not run ${earlier.tool}`).toBe(true);
      }
    });
  });
});

// ── One request, one record ─────────────────────────────────────────────────
// 2026-08-09 screenshot: "Create a profile for my MacBook Pro m4" produced TWO
// profiles — "MacBook Pro M4" (Asset) and "my MacBook Pro m4" (Person). Three
// separate defects lined up: the model fanned one request into two calls, the
// determiner survived into the name so name-equality dedup missed it, and an
// absent/invalid type silently defaulted to "person", filing a laptop as a
// human being.
const MACBOOK_MSG = "Create a profile for my MacBook Pro m4";

describe("one create request produces one record", () => {
  it("reads the request as a single asset create named without the determiner", () => {
    const intent = parseTurnIntent(MACBOOK_MSG);
    expect(intent.operation).toBe("create");
    expect(["asset", "profile"]).toContain(intent.entity);
    expect(parseTurnIntents(MACBOOK_MSG).filter(isActionable)).toHaveLength(1);
  });

  it("strips a leading first-person determiner from a name", () => {
    expect(stripLeadingDeterminer("my MacBook Pro m4")).toBe("MacBook Pro m4");
    expect(stripLeadingDeterminer("Our House")).toBe("House");
    expect(stripLeadingDeterminer("  my  Truck ")).toBe("Truck");
  });

  it("leaves real names alone", () => {
    for (const name of ["MacBook Pro M4", "The Home Depot", "MyFitnessPal", "Mystic River House", "Amy"]) {
      expect(stripLeadingDeterminer(name), name).toBe(name);
    }
  });

  it("keys both spellings of the same thing to one name", () => {
    expect(createNameKey("my MacBook Pro m4")).toBe(createNameKey("MacBook Pro M4"));
    expect(createNameKey("the Dodge Ram 2025")).toBe(createNameKey("Dodge Ram 2025"));
  });

  it("blocks the second create of the same thing in one turn", () => {
    const first = recordTurnCreate("create_profile", { name: "MacBook Pro M4", type: "asset" });
    expect(first).not.toBeNull();
    const dup = findDuplicateCreateInTurn(
      "create_profile",
      { name: "my MacBook Pro m4", type: "person" },
      [first!],
    );
    expect(dup).not.toBeNull();
    const v = duplicateCreateViolation("create_profile", "my MacBook Pro m4", dup!);
    expect(v.mismatchType).toBe("duplicate_create_in_turn");
    // Silent for the user — the first card already shows the record.
    expect(v.userMessage).toBe("");
    expect(v.modelDirective).toMatch(/already created/i);
  });

  it("does NOT block two creates of DIFFERENT things in one turn", () => {
    const luna = recordTurnCreate("create_profile", { name: "Luna", type: "pet" })!;
    expect(findDuplicateCreateInTurn("create_profile", { name: "Rex", type: "pet" }, [luna])).toBeNull();
  });

  it("does NOT block an update after a create of the same record", () => {
    const mac = recordTurnCreate("create_profile", { name: "MacBook Pro M4", type: "asset" })!;
    expect(findDuplicateCreateInTurn("update_profile", { name: "MacBook Pro M4" }, [mac])).toBeNull();
  });

  it("does NOT block a create with no name to key on", () => {
    const mac = recordTurnCreate("create_profile", { name: "MacBook Pro M4", type: "asset" })!;
    expect(findDuplicateCreateInTurn("create_expense", { amount: 2400 }, [mac])).toBeNull();
    expect(recordTurnCreate("create_expense", { amount: 2400 })).toBeNull();
  });

  it("does not confuse a create on an unrelated entity", () => {
    const mac = recordTurnCreate("create_profile", { name: "MacBook Pro M4", type: "asset" })!;
    // Same name, different entity family — a habit called "MacBook Pro M4" is
    // odd but it is not the asset, so it is not a duplicate create.
    expect(findDuplicateCreateInTurn("create_habit", { name: "MacBook Pro M4" }, [mac])).toBeNull();
  });

  it("counts a deduped write as landed, not as a lost one", () => {
    const res = checkClaims({
      reply: "MacBook Pro M4 asset profile created.",
      operations: [{ tool: "create_profile", status: "deduped", entityId: "p1", raw: "MacBook Pro M4" }],
      intentEntity: "asset",
      intentOperation: "create",
    });
    expect(res.unsupportedSuccess).toBe(false);
  });

  it("says what a dedup actually did when it rebuilds the summary", () => {
    const summary = groundedSummary([
      { tool: "create_profile", status: "deduped", entityId: "p1", raw: "MacBook Pro M4" },
    ]);
    expect(summary).toMatch(/Updated the existing/i);
    expect(summary).toContain("MacBook Pro M4");
    expect(summary).not.toMatch(/didn'?t go through/i);
  });
});

// ── Whose is it? ────────────────────────────────────────────────────────────
// Ownership decides which balance sheet an asset lands on. "This is Bob's
// MacBook" must file the laptop under Bob and keep it OFF the user's totals.
describe("ownership from a possessive", () => {
  it("splits owner from name on a create request", () => {
    const intent = parseTurnIntent("Create a profile for Bob's MacBook Pro");
    expect(intent.fields.owner).toBe("Bob");
    expect(intent.fields.name).toBe("MacBook Pro");
  });

  it("reads the same owner however the sentence is phrased", () => {
    for (const [msg, owner, name] of [
      ["Add Robert's truck", "Robert", "truck"],
      ["Create an asset for Mom's iPad", "Mom", "iPad"],
    ] as Array<[string, string, string]>) {
      const intent = parseTurnIntent(msg);
      expect(intent.fields.owner, msg).toBe(owner);
      expect(intent.fields.name, msg).toBe(name);
    }
  });

  it("treats 'my' as the user, not a third-party owner", () => {
    const intent = parseTurnIntent("Create a profile for my MacBook Pro m4");
    expect(intent.fields.owner).toBeUndefined();
    expect(intent.fields.name).toBe("MacBook Pro m4");
  });

  it("does not invent an owner from a brand possessive", () => {
    const intent = parseTurnIntent("Create an asset for Levi's 501 Jeans");
    expect(intent.fields.owner).toBeUndefined();
  });

  it("still routes to a plain asset create", () => {
    const intents = parseTurnIntents("Create a profile for Bob's MacBook Pro");
    expect(checkToolAgainstIntent("create_profile", intents)).toBeNull();
    expect(checkToolAgainstIntent("create_habit", intents)?.mismatchType).toBe("entity_mismatch");
  });
});

// ── Tool/entity map integrity ───────────────────────────────────────────────

describe("tool routing map", () => {
  it("classifies operations from the tool name", () => {
    expect(toolOperation("create_profile")).toBe("create");
    expect(toolOperation("update_profile")).toBe("update");
    expect(toolOperation("delete_habit")).toBe("delete");
    expect(toolOperation("checkin_habit")).toBe("complete");
    expect(toolOperation("log_tracker_entry")).toBe("create");
    expect(toolOperation("get_summary")).toBe("read");
  });

  it("treats assets and profiles as one entity, habits and assets as distinct", () => {
    expect(areEntitiesCompatible("asset", "profile")).toBe(true);
    expect(areEntitiesCompatible("asset", "habit")).toBe(false);
    expect(areEntitiesCompatible("event", "habit")).toBe(false);
  });

  it("maps every write tool the report touched", () => {
    for (const tool of [
      "create_profile", "update_profile", "create_habit", "checkin_habit",
      "create_event", "create_task", "log_tracker_entry",
    ]) {
      expect(TOOL_INTENT_ENTITY[tool], tool).toBeTruthy();
    }
  });

  it("reads 'remind me to X' as a TASK — there is no reminder entity", () => {
    // Reminders were retired 2026-08-09. Leaving `reminder` in the intent
    // vocabulary would have the routing gate hand the model `create_reminder`
    // as the tool it should have used — a tool that no longer exists.
    expect(detectEntity("remind me to mow the lawn at 9am").entity).toBe("task");
    expect(detectEntity("delete my dentist reminder").entity).toBe("task");
    expect(TOOL_INTENT_ENTITY.create_reminder).toBeUndefined();
  });

  it("detects the entity noun the user used", () => {
    expect(detectEntity("create an asset for my truck").entity).toBe("asset");
    expect(detectEntity("create a habit to stretch").entity).toBe("habit");
    expect(detectEntity("add an event on my calendar").entity).toBe("event");
    expect(detectEntity("hello there").entity).toBe("unknown");
  });
});
