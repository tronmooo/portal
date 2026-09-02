// "Sarah and I played soccer for 30 minutes" is TWO records, not one.
//
// Reported 2026-09-02: that sentence produced a single soccer entry on the
// user's own tracker. Sarah's Soccer tracker — which exists — got nothing, and
// nothing in the reply said so. The owner extractor only ever looked for a
// single owner ("for Robert", "Robert's …"), so a joint subject named nobody
// and the activity quietly defaulted to the user.
//
// Detection is deterministic; the write is the model's, steered by a [ROUTER]
// line. So this pins both halves: the shape is recognised, and the directive
// names every participant and asks for one entry each.
import { describe, it, expect, vi } from "vitest";
import { extractSharedActivities } from "@shared/content-routing";

vi.mock("../server/storage", () => ({
  storage: new Proxy({ _timezone: "America/Los_Angeles" } as Record<string, any>, {
    get: (t: any, p: string) => (p in t ? t[p] : async () => []),
  }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

const PROFILES = [
  { id: "p-self", name: "Poop", type: "self" },
  { id: "p-sarah", name: "Sarah Miller", type: "person" },
  { id: "p-jane", name: "Jane QA", type: "person" },
];

const REPORTED =
  "I ran 2 miles this morning in about 19 minutes and drank 24 oz of water afterward. " +
  "Sarah and I played soccer for 30 minutes this afternoon, pretty high intensity. " +
  "Sarah ate some grilled chicken, rice, and broccoli afterward and drank a bottle of water. " +
  "I also did 25 push-ups when we got home. create a task me to buy more chicken this week.";

describe("extractSharedActivities", () => {
  it("reads a joint subject as several participants", () => {
    const cases: Array<[string, string[], boolean]> = [
      ["Sarah and I played soccer for 30 minutes", ["Sarah"], true],
      ["Sarah and I both played soccer", ["Sarah"], true],
      ["Me and Sarah went for a run", ["Sarah"], true],
      ["Sarah, Jane and I ran 3 miles", ["Sarah", "Jane"], true],
      ["Sarah and Robert played tennis", ["Sarah", "Robert"], false],
    ];
    for (const [msg, names, self] of cases) {
      const [hit] = extractSharedActivities(msg);
      expect(hit, msg).toBeTruthy();
      expect(hit.names, msg).toEqual(names);
      expect(hit.includesSelf, msg).toBe(self);
    }
  });

  it("stays silent on a single subject, a food list, and a possessive", () => {
    for (const msg of [
      "I ran 2 miles this morning",
      "Sarah ate some grilled chicken, rice, and broccoli afterward",
      "log grilled chicken and rice for Sarah",
      "I drank 24 oz of water and did 25 push-ups",
      "Sarah's soccer practice is at 4",
    ]) {
      expect(extractSharedActivities(msg), msg).toEqual([]);
    }
  });

  it("finds the soccer clause inside the full reported message", () => {
    const hits = extractSharedActivities(REPORTED);
    expect(hits).toHaveLength(1);
    expect(hits[0].clause).toMatch(/played soccer/);
    expect(hits[0].names).toEqual(["Sarah"]);
    expect(hits[0].includesSelf).toBe(true);
  });
});

describe("the router directive tells the model to write one entry per participant", () => {
  it("names both participants for the reported message", async () => {
    const { buildContentRoutingDirective } = await import("../server/ai-engine");
    const directive = buildContentRoutingDirective(REPORTED, PROFILES) || "";
    expect(directive).toContain("SHARED ACTIVITY");
    // The profile's real name, not the nickname the user typed.
    expect(directive).toContain('forProfile:"Sarah Miller"');
    expect(directive).toMatch(/you and Sarah Miller/);
    expect(directive).toMatch(/one entry per participant/);
  });

  it("says nothing when the joint subject is not made of real profiles", async () => {
    const { buildContentRoutingDirective } = await import("../server/ai-engine");
    const directive = buildContentRoutingDirective("Grilled Chicken and Rice go together", PROFILES) || "";
    expect(directive).not.toContain("SHARED ACTIVITY");
    // …and an unknown person is not invented into a participant either.
    const unknown = buildContentRoutingDirective("Mallory and I played soccer", PROFILES) || "";
    expect(unknown).not.toContain("SHARED ACTIVITY");
  });

  it("handles a shared activity between two OTHER people, with no user entry", async () => {
    const { buildContentRoutingDirective } = await import("../server/ai-engine");
    const directive = buildContentRoutingDirective("Sarah and Jane played tennis for an hour", PROFILES) || "";
    expect(directive).toContain("SHARED ACTIVITY");
    expect(directive).toContain('forProfile:"Sarah Miller"');
    expect(directive).toContain('forProfile:"Jane QA"');
    expect(directive).not.toMatch(/one more for the user/);
  });
});

// ── One nutrition tracker per profile ───────────────────────────────────────
// "There is no calorie tracker, it should go in nutrition" (2026-09-02).
// log_tracker_entry already resolved the aliases onto the existing Nutrition
// tracker; create_tracker's duplicate check did not, so a create call for
// "Calories" would have stood a second nutrition tracker up beside the real
// one.
describe("nutrition tracker aliases", () => {
  it("treats every usual name for the nutrition tracker as the same tracker", async () => {
    const { isNutritionTrackerName } = await import("@shared/nutrition-shaped");
    for (const n of ["Calories", "calorie counter", "Nutrition", "Food Log", "Macros", "Diet", "Meal Log", "Daily Nutrition"]) {
      expect(isNutritionTrackerName(n), n).toBe(true);
    }
  });

  it("does not swallow a real tracker that merely mentions food", async () => {
    const { isNutritionTrackerName } = await import("@shared/nutrition-shaped");
    for (const n of ["Grilled Chicken", "Soccer", "Running", "Bench Press", "Dog Food Cost", "Blood Pressure"]) {
      expect(isNutritionTrackerName(n), n).toBe(false);
    }
  });
});
