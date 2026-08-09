// Pins the pure pieces of the bulk multi-action path: operation parsing
// (whitelist/caps), the extraction prompt contract, the deterministic recap
// builder, and the "8:15 AM" bare-time fix in log_tracker_entry validation.
import { describe, it, expect } from "vitest";
import {
  BULK_ACTION_TOOLS,
  MAX_BULK_OPERATIONS,
  EXTRACT_ACTIONS_TOOL,
  parseExtractedOperations,
  buildExtractionSystemPrompt,
  buildBulkReply,
  summarizeOpDetail,
  type OperationOutcome,
} from "../server/ai-bulk-log";
import { validateToolInput } from "../server/ai-engine";

describe("parseExtractedOperations", () => {
  it("keeps whitelisted well-formed operations in order", () => {
    const ops = parseExtractedOperations({
      operations: [
        { tool: "log_tracker_entry", input: { trackerName: "Soccer", values: { duration: 60 } }, raw: "played soccer for an hour" },
        { tool: "log_tracker_entry", input: { trackerName: "Cannabis", values: { sessions: 1 } }, raw: "smoked some cannabis" },
        { tool: "log_tracker_entry", input: { trackerName: "Shower", values: { count: 1 } }, raw: "took a shower" },
        { tool: "log_tracker_entry", input: { trackerName: "Bathroom Visits", values: { count: 1 }, at: "8:15 AM" }, raw: "went to the bathroom at 8:15 AM" },
      ],
    });
    expect(ops.length).toBe(4);
    expect(ops.map((o) => o.input.trackerName)).toEqual(["Soccer", "Cannabis", "Shower", "Bathroom Visits"]);
  });

  it("drops non-whitelisted tools (no deletes/updates through the bulk path)", () => {
    const ops = parseExtractedOperations({
      operations: [
        { tool: "delete_tracker", input: { name: "Soccer" }, raw: "x" },
        { tool: "update_profile", input: { name: "Me" }, raw: "y" },
        { tool: "create_task", input: { title: "Call dentist" }, raw: "call the dentist" },
      ],
    });
    expect(ops.length).toBe(1);
    expect(ops[0].tool).toBe("create_task");
  });

  it("drops malformed rows and tolerates garbage input", () => {
    expect(parseExtractedOperations(null)).toEqual([]);
    expect(parseExtractedOperations({})).toEqual([]);
    expect(parseExtractedOperations({ operations: "nope" })).toEqual([]);
    const ops = parseExtractedOperations({
      operations: [
        null,
        42,
        { tool: "log_tracker_entry" }, // no input
        { tool: "log_tracker_entry", input: [1, 2] }, // array input
        { tool: "log_tracker_entry", input: { trackerName: "Reading", values: { minutes: 45 } } }, // no raw → derived
      ],
    });
    expect(ops.length).toBe(1);
    expect(ops[0].raw).toBe("Reading");
  });

  it("caps at MAX_BULK_OPERATIONS", () => {
    const rows = Array.from({ length: MAX_BULK_OPERATIONS + 20 }, (_, i) => ({
      tool: "log_tracker_entry",
      input: { trackerName: `T${i}`, values: { count: 1 } },
      raw: `action ${i}`,
    }));
    expect(parseExtractedOperations({ operations: rows }).length).toBe(MAX_BULK_OPERATIONS);
  });

  it("whitelist matches the extraction tool schema enum", () => {
    const schema: any = EXTRACT_ACTIONS_TOOL.input_schema;
    expect(schema.properties.operations.items.properties.tool.enum).toEqual([...BULK_ACTION_TOOLS]);
  });
});

describe("buildExtractionSystemPrompt", () => {
  it("embeds existing tracker/habit/profile names and universal-logging rules", () => {
    const prompt = buildExtractionSystemPrompt({
      nowISO: "2026-07-15T12:00:00Z",
      timezone: "America/Los_Angeles",
      trackerNames: ["Soccer", "Hydration"],
      profileNames: ["Rex"],
      habitNames: ["Morning Run"],
    });
    expect(prompt).toContain("Soccer, Hydration");
    expect(prompt).toContain("Morning Run");
    expect(prompt).toContain("Rex");
    expect(prompt).toContain("NEVER drop, merge, or refuse");
    expect(prompt.toLowerCase()).toContain("bathroom");
  });

  it("pins detail preservation and count-aware habit routing", () => {
    const prompt = buildExtractionSystemPrompt({
      nowISO: "2026-07-15T12:00:00Z",
      trackerNames: [],
      profileNames: [],
      habitNames: [],
    });
    // "I smoked a blunt" must keep method:"blunt"; times must ride in at.
    expect(prompt).toContain('method:"blunt"');
    expect(prompt).toContain("8:15 AM");
    // Habits are counted, not binary — "twice" must survive extraction.
    expect(prompt).toContain("count:2");
    expect(prompt).toContain('at:"HH:MM"');
    // An activity with no matching habit is still a tracker log, and an
    // activity report NEVER creates a habit.
    expect(prompt).toContain("otherwise the activity is ALWAYS log_tracker_entry");
    expect(prompt).toContain("Never create a habit from an activity report");
    // Profiles come only from the current message.
    expect(prompt).toContain("ONLY when THIS message names someone else");
  });
});

describe("summarizeOpDetail", () => {
  it("keeps every stated quantity, method, and timestamp", () => {
    expect(summarizeOpDetail({ trackerName: "Soccer", values: { duration: 60 } })).toBe("duration 60");
    expect(summarizeOpDetail({ trackerName: "Cannabis", values: { count: 1, method: "blunt" } })).toBe("count 1, method blunt");
    expect(summarizeOpDetail({ trackerName: "Bathroom Visits", values: { count: 1 }, at: "8:15 AM" })).toBe("count 1, at 8:15 AM");
    expect(summarizeOpDetail({ description: "electric bill", amount: 120 })).toBe("$120");
  });
});

describe("buildBulkReply", () => {
  const ok = (i: number, name: string): OperationOutcome => ({ index: i, raw: name, tool: "log_tracker_entry", status: "ok", trackerName: name });

  it("enumerates every success and never claims more than what ran", () => {
    const ops = [ok(0, "Soccer"), ok(1, "Cannabis"), ok(2, "Shower"), ok(3, "Bathroom Visits")];
    const reply = buildBulkReply(ops, [{ id: "t1", name: "Cannabis" }]);
    expect(reply).toContain("Logged 4 of 4 actions");
    expect(reply).toContain("Soccer");
    expect(reply).toContain("Cannabis");
    expect(reply).toContain("Shower");
    expect(reply).toContain("Bathroom Visits");
    expect(reply).toContain("Created 1 new tracker");
    // The reported bug phrase must never appear.
    expect(reply.toLowerCase()).not.toMatch(/(don'?t|can'?t|aren'?t|isn'?t|not something i) track/);
  });

  it("reports failures per-action without hiding successes", () => {
    const ops: OperationOutcome[] = [
      ok(0, "Soccer"),
      { index: 1, raw: "paid my electric bill", tool: "create_expense", status: "failed", error: "Validation failed: Amount is required" },
      { index: 2, raw: "went to bed at 10:30", tool: "log_tracker_entry", status: "skipped", error: "Ran out of time this message", trackerName: "Sleep" },
    ];
    const reply = buildBulkReply(ops, []);
    expect(reply).toContain("Logged 1 of 3 actions");
    expect(reply).toContain("1 failed");
    expect(reply).toContain("Amount is required");
    expect(reply).toContain("not run");
  });

  it("ok lines carry the recorded details so dropped data is visible", () => {
    const ops: OperationOutcome[] = [
      { index: 0, raw: "played soccer for an hour", tool: "log_tracker_entry", status: "ok", trackerName: "Soccer", detail: "duration 60" },
      { index: 1, raw: "smoked a blunt", tool: "log_tracker_entry", status: "ok", trackerName: "Cannabis", detail: "count 1, method blunt" },
      { index: 2, raw: "went to the bathroom", tool: "log_tracker_entry", status: "ok", trackerName: "Bathroom Visits", detail: "count 1, at 8:15 AM" },
    ];
    const reply = buildBulkReply(ops, []);
    expect(reply).toContain("duration 60");
    expect(reply).toContain("method blunt");
    expect(reply).toContain("8:15 AM");
  });

  it("marks storage-level duplicates honestly", () => {
    const ops: OperationOutcome[] = [
      ok(0, "Coffee"),
      { index: 1, raw: "drank coffee", tool: "log_tracker_entry", status: "deduped", trackerName: "Coffee", entityId: "e1" },
    ];
    const reply = buildBulkReply(ops, []);
    expect(reply).toContain("already logged");
  });
});

describe("log_tracker_entry `at` validation — bare clock times", () => {
  // Bare times compose against the USER'S timezone (default America/Los_Angeles
  // when no x-timezone header has been seen), not the server clock — the
  // server is UTC on Vercel. Assert the wall-clock reading in that zone.
  const TZ = "America/Los_Angeles";
  const wallClock = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

  it('parses "8:15 AM" as today at 08:15 (user tz) instead of dropping it', () => {
    const v = validateToolInput("log_tracker_entry", {
      trackerName: "Bathroom Visits",
      values: { count: 1 },
      at: "8:15 AM",
    });
    expect(v.valid).toBe(true);
    expect(v.normalized.at, "at should be preserved, not dropped to now").toBeTruthy();
    expect(wallClock(v.normalized.at)).toBe("08:15");
    const dayInTz = new Date(v.normalized.at).toLocaleDateString("en-CA", { timeZone: TZ });
    expect(dayInTz).toBe(new Date().toLocaleDateString("en-CA", { timeZone: TZ }));
  });

  it('parses "10pm" and "12:30 p.m." correctly', () => {
    const v1 = validateToolInput("log_tracker_entry", { trackerName: "Sleep", values: { count: 1 }, at: "10pm" });
    expect(wallClock(v1.normalized.at)).toBe("22:00");
    const v2 = validateToolInput("log_tracker_entry", { trackerName: "Lunch", values: { count: 1 }, at: "12:30 p.m." });
    expect(wallClock(v2.normalized.at)).toBe("12:30");
  });

  it("still accepts ISO dates and drops unparseable values with a warning", () => {
    const iso = validateToolInput("log_tracker_entry", { trackerName: "Weight", values: { weight: 180 }, at: "2026-07-01" });
    expect(iso.normalized.at).toContain("2026-07-01");
    const junk = validateToolInput("log_tracker_entry", { trackerName: "Weight", values: { weight: 180 }, at: "banana o'clock" });
    expect(junk.normalized.at).toBeUndefined();
    expect(junk.warnings.join(" ")).toContain("Couldn't parse");
  });
});
