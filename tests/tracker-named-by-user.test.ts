// Owner, 2026-11-27: "The user's explicit instruction takes priority. If the
// user requests a new tracker with a specific name, create that tracker. If
// the user simply logs an activity, use the appropriate existing tracker.
// Never confirm that a tracker was created under a particular name unless that
// tracker actually exists."
//
// Before (live check on the preview): with a "Running" tracker on the account,
// "Log to a new tracker called 'Jog QQ7Z': I ran 1.25 miles in 14 minutes" put
// the run into Running and answered "Logged Jog QQ7Z running, 1.25 mi…".
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { explicitNewTrackerName, isTheNamedTracker } from "../shared/tracker-intent";

describe("did the message name a new tracker?", () => {
  it.each([
    ['Log to a new tracker called "Jog QQ7Z": I ran 1.25 miles in 14 minutes', "Jog QQ7Z"],
    ["Create a tracker called Morning Jog and log 2 miles", "Morning Jog"],
    ["start a new tracker named Cold Plunge", "Cold Plunge"],
    ["Create a tracker called “PullupsDYO4” that records a number of reps", "PullupsDYO4"],
    ["make a separate tracker titled Evening Walks for my dog walks", "Evening Walks"],
    ['set up a "Trail Runs" tracker', "Trail Runs"],
    ["add another tracker called Bike Commute, 6 miles today", "Bike Commute"],
  ])("%s → %s", (msg, name) => {
    expect(explicitNewTrackerName(msg)).toBe(name);
  });

  it.each([
    "I ran 1.25 miles in 14 minutes",
    "log 12 reps to my Pullups tracker",
    "what does my running tracker say?",
    "start a sleep tracker",
    "delete the Jog tracker",
    "rename my tracker to Morning Jog",
    "",
  ])("simply logging or asking names none: %s", (msg) => {
    expect(explicitNewTrackerName(msg)).toBeNull();
  });

  it("matches the named tracker whatever the case or punctuation, and nothing else", () => {
    expect(isTheNamedTracker("jog qq7z", "Jog QQ7Z")).toBe(true);
    expect(isTheNamedTracker("Jog-QQ7Z", "Jog QQ7Z")).toBe(true);
    expect(isTheNamedTracker("Running", "Jog QQ7Z")).toBe(false);
    expect(isTheNamedTracker("Jog QQ7Z", null)).toBe(false);
    expect(isTheNamedTracker("", "Jog QQ7Z")).toBe(false);
  });
});

describe("chat honours the name and reports where the entry is", () => {
  const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
  const logTool = src.slice(src.lastIndexOf('case "log_tracker_entry": {'), src.lastIndexOf('case "create_tracker": {'));

  it("a named new tracker is not folded into the activity's canonical tracker", () => {
    expect(logTool).toContain("explicitNewTrackerName((input as any).__userMessage)");
    expect(logTool).toMatch(/if \(honorsAskedName\) input\.trackerName = askedTrackerName;/);
    expect(logTool).toMatch(/if \(!honorsAskedName && canonActivity &&/);
  });

  it("it is matched by that name only — no contains / identity / alias / value fallback", () => {
    expect(logTool).toContain("if (honorsAskedName) return isTheNamedTracker(t.name, askedTrackerName);");
    expect(logTool).toContain("if (nameMatches.length === 0 && !honorsAskedName)");
  });

  it("the result says which tracker the entry is in, on both paths (existing and created)", () => {
    expect(logTool).toContain("__loggedTo = { id: tracker.id, name: tracker.name }");
    expect(logTool).toContain("__loggedTo = { id: newTracker.id, name: newTracker.name }");
  });

  it("the confirmation's tracker name comes from the result, not from what the model asked for", () => {
    const at = src.indexOf("(result as any)?.__loggedTo?.name");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at - 200, at + 260)).toMatch(/trackerName: \(isSuccess && typeof \(result as any\)\?\.__loggedTo\?\.name === "string"/);
  });

  it("create_tracker never hands back an existing tracker as if it were created", () => {
    const tool = src.slice(src.lastIndexOf('case "create_tracker": {'), src.indexOf("// PR S: AI-driven shape inference", src.lastIndexOf('case "create_tracker": {')));
    expect(tool).not.toMatch(/if \(dupTracker\) return dupTracker;/);
    expect(tool).toContain("deduped: true");
    expect(tool).toContain("createAskedName");
  });
});
