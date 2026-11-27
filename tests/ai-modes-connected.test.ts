// AI Modes, connected to the rest of the app (owner, 2026-11-27: "make sure
// it's connected to the entire app").
//  - The main chat opens a mode by its name, the list, or the builder with
//    the user's words (the builder proposes; nothing is created by the chat).
//  - Search lists the person's modes; "AI Modes" has its own shortcut.
//  - A backup carries the modes, and restoring it brings them back (a mode
//    already there by name is kept as it is).
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { executeTool } from "../server/ai-engine";
import { chatNavigationRoute } from "../client/src/lib/chat-navigation";
import { QUICK_ACTIONS } from "../client/src/components/CommandSearch";
import { makeFakeStorage, type FakeDb } from "./helpers/route-harness";
import { AI_MODES_PREF, MODE_TEMPLATES, matchModeByName, modeFromTemplate, parseAiModes, serializeAiModes } from "../shared/ai-modes";

const fit = () => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "fitness")!, [], new Date());
const coach = () => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "life-coach")!, [], new Date());
const freshDb = (): FakeDb => ({
  profiles: [{ id: "self-1", type: "self", name: "Sam", fields: {} }], liabilityPayments: [], expenses: [], incomes: [],
  obligations: [], tasks: [], events: [], documents: [], trackers: [], getDocumentCalls: 0,
  bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [], preferences: {},
} as any);

describe("the main chat reaches AI Modes", () => {
  it("'open my fitness coach' opens that mode; an unknown name opens the list and says which modes there are", async () => {
    const db = freshDb();
    db.preferences![AI_MODES_PREF] = serializeAiModes([fit(), coach()]);
    const storage: any = makeFakeStorage(db);
    const run = (input: any) => new Promise<any>((resolve, reject) => requestStorageContext.run(storage, () => executeTool("navigate", input, "u1").then(resolve, reject)));
    const hit = await run({ page: "ai_mode", modeName: "my fitness coach" });
    expect(hit).toMatchObject({ navigateTo: "ai_mode", modeId: "fitness-coach" });
    expect(chatNavigationRoute([hit])).toBe("/workspace/mode/fitness-coach");
    const miss = await run({ page: "ai_mode", modeName: "Gardening" });
    expect(miss.navigateTo).toBe("ai_modes");
    expect(miss.message).toContain("Fitness Coach");
    expect(chatNavigationRoute([miss])).toBe("/workspace/modes");
    // Nothing was written.
    expect(parseAiModes(db.preferences![AI_MODES_PREF]).map((m) => m.id)).toEqual(["fitness-coach", "life-coach"]);
  });

  it("'make me an AI that …' opens the builder with the words; the chat creates nothing", async () => {
    const db = freshDb();
    const storage: any = makeFakeStorage(db);
    const out = await new Promise<any>((resolve, reject) => requestStorageContext.run(storage, () =>
      executeTool("navigate", { page: "create_ai_mode", description: "An AI that plans my meals & workouts" }, "u1").then(resolve, reject)));
    expect(chatNavigationRoute([out])).toBe(`/workspace/modes?new=1&describe=${encodeURIComponent("An AI that plans my meals & workouts")}`);
    expect(db.preferences![AI_MODES_PREF]).toBeUndefined();
  });

  it("a spoken name finds the mode, never a different one", () => {
    const modes = [fit(), coach(), { ...fit(), id: "money", name: "Money" }];
    expect(matchModeByName(modes, "fitness")?.id).toBe("fitness-coach");
    expect(matchModeByName(modes, "my life coach mode")?.id).toBe("life-coach");
    expect(matchModeByName(modes, "money")?.id).toBe("money");
    expect(matchModeByName(modes, "taxes")).toBeNull();
    expect(matchModeByName(modes, "")).toBeNull();
  });
});

describe("search", () => {
  it("AI Modes is a quick action with its own shortcut letter", () => {
    const a = QUICK_ACTIONS.find((x) => x.path === "/workspace/modes");
    expect(a?.shortcut).toBe("M");
    const letters = QUICK_ACTIONS.map((x) => x.shortcut);
    expect(new Set(letters).size).toBe(letters.length);
  });
});

let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

describe("backup and restore", () => {
  it("the export carries the modes; a restore brings back the ones the account lacks", async () => {
    const db = freshDb();
    db.preferences![AI_MODES_PREF] = serializeAiModes([fit()]);
    const storage: any = makeFakeStorage(db);
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => { (req as any).userId = "backup-user"; requestStorageContext.run(storage, () => next()); });
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const backup = await (await fetch(`${base}/api/export`)).json();
    expect(backup.aiModes.map((m: any) => m.name)).toEqual(["Fitness Coach"]);

    // Restore into an account that has the Fitness Coach already and not the Life Coach.
    const withCoach = { ...backup, aiModes: [...backup.aiModes, coach()], exportedAt: new Date(Date.now() + 1000).toISOString() };
    const r = await fetch(`${base}/api/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(withCoach) });
    const out = await r.json();
    expect(out.imported?.aiModes).toBe(1);
    expect(parseAiModes(db.preferences![AI_MODES_PREF]).map((m) => m.name)).toEqual(["Fitness Coach", "Life Coach"]);
  });
});
