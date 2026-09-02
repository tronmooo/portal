// Pins the scheduling key for parallel tool execution inside one model round
// (latency, 2026-09-01). Calls sharing a key run in model order; different
// keys run concurrently. Getting this wrong re-opens the duplicate-tracker and
// same-name-create races the serial loop never had, so the groupings that
// protect those are pinned here.
import { describe, it, expect, vi } from "vitest";

vi.mock("../server/storage", () => ({
  storage: new Proxy({ _timezone: "America/Los_Angeles" } as Record<string, any>, {
    get(target, prop: string) { return prop in target ? target[prop] : async () => []; },
  }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

const call = (name: string, input: Record<string, any>, id = `tu_${Math.random().toString(36).slice(2)}`) => ({ id, name, input });

describe("toolInterferenceKey", () => {
  it("logs to different trackers run in parallel; logs to the same tracker stay serial", async () => {
    const { toolInterferenceKey } = await import("../server/ai-engine");
    const run = toolInterferenceKey(call("log_tracker_entry", { trackerName: "Running", values: { distance: 2 } }));
    const soccer = toolInterferenceKey(call("log_tracker_entry", { trackerName: "Soccer", values: { duration: 30 } }));
    const runAgain = toolInterferenceKey(call("log_tracker_entry", { trackerName: "running", values: { distance: 3 } }));
    expect(run).not.toBe(soccer);
    expect(run).toBe(runAgain);
  });

  it("collapses the way the executor collapses: wording variants, nutrition aliases, canonical activities", async () => {
    const { toolInterferenceKey } = await import("../server/ai-engine");
    expect(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Multivitamin" })))
      .toBe(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Daily Multivitamin" })));
    expect(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Nutrition", values: { item: "Sandwich" } })))
      .toBe(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Calories", values: { item: "Coke" } })));
    expect(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Walking Distance" })))
      .toBe(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Daily Walk" })));
    // A medication dose keys on the drug, i.e. the tracker it resolves to.
    expect(toolInterferenceKey(call("log_medication_dose", { name: "Fish Oil" })))
      .toBe(toolInterferenceKey(call("log_tracker_entry", { trackerName: "Fish Oil" })));
  });

  it("same-family creates stay serial so the one-request-one-record guard still sees the first create", async () => {
    const { toolInterferenceKey } = await import("../server/ai-engine");
    expect(toolInterferenceKey(call("create_profile", { name: "MacBook Pro m4" })))
      .toBe(toolInterferenceKey(call("create_profile", { name: "my MacBook Pro m4" })));
    expect(toolInterferenceKey(call("create_expense", { description: "Coffee", amount: 4 })))
      .toBe(toolInterferenceKey(call("create_expense", { description: "Lunch", amount: 12 })));
    // …but an expense and a task are independent.
    expect(toolInterferenceKey(call("create_expense", { description: "Coffee", amount: 4 })))
      .not.toBe(toolInterferenceKey(call("create_task", { title: "Call dentist" })));
  });

  it("habit tools share the habit family so they can be sequenced after tracker logs", async () => {
    const { toolInterferenceKey } = await import("../server/ai-engine");
    const a = toolInterferenceKey(call("checkin_habit", { name: "Walk the Dog" }));
    const b = toolInterferenceKey(call("create_habit", { name: "Meditate" }));
    expect(a.startsWith("family:habit")).toBe(true);
    expect(a).toBe(b);
  });

  it("read-only tools never block each other", async () => {
    const { toolInterferenceKey } = await import("../server/ai-engine");
    expect(toolInterferenceKey(call("search", { query: "a" }, "tu_1")))
      .not.toBe(toolInterferenceKey(call("search", { query: "b" }, "tu_2")));
  });
});
