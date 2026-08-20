// tests/qa-duplication-data-loss.test.ts
//
// Regression guards for the QA run of 2026-08-20, whose two critical findings
// were both about the write path lying:
//
//   BUG-1  A MODIFICATION created a second entity. "It charges on the 15th"
//          (a follow-up about Spotify) produced a second Spotify liability, a
//          second $9.99 monthly bill, and — with the same phrasing repeated —
//          seven open "Call the dentist" tasks.
//   BUG-2  A note the user asked for ("jot down that the client meeting went
//          really well") was announced as saved, filed as a task by the
//          content-routing gate, and found by no search.
//   BUG-6  "3 glasses of water" logged as 72 oz in one run and 24 oz in
//          another — no stable glass→oz constant.
//
// These run the REAL executor against the real in-memory storage, so they fail
// if either end of the contract drifts.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";
import { createNote, listNotes } from "../server/content-service";
import { normalizeTrackerEntry } from "../server/tracker-normalize";
import { normalizeServiceName, sameServiceName } from "@shared/service-name";
import { checkContentRouting, routeContent } from "@shared/content-routing";
import { splitIntentClauses } from "@shared/ai-intent";

// The chat layer's creation-dedup cache is module-level and keyed by user id.
let seq = 0;
const nextUser = () => `user-qa-dup-${++seq}`;
const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

// ─── BUG-1 · service identity ───────────────────────────────────────────────

describe("service names: a plan tier is not a new service", () => {
  it("reduces a name to its brand tokens", () => {
    expect(normalizeServiceName("Spotify Premium")).toBe("spotify");
    expect(normalizeServiceName("Netflix subscription")).toBe("netflix");
    expect(normalizeServiceName("  The Gym Membership ")).toBe("gym");
  });

  it("treats tier variants of one service as the same service", () => {
    expect(sameServiceName("Spotify", "Spotify Premium")).toBe(true);
    expect(sameServiceName("hulu", "Hulu Subscription")).toBe(true);
  });

  it("never merges two different products", () => {
    expect(sameServiceName("Apple Music", "Apple TV")).toBe(false);
    expect(sameServiceName("Chase Sapphire", "Chase Freedom")).toBe(false);
    expect(sameServiceName("Car Loan", "Car Insurance")).toBe(false);
  });

  it("refuses to make an identity out of qualifier words alone", () => {
    expect(sameServiceName("Subscription", "subscription")).toBe(false);
    expect(sameServiceName("", "")).toBe(false);
  });
});

describe("BUG-1 · a recurring bill is edited, not duplicated", () => {
  let storage: MemStorage; let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("routes a follow-up about the same service onto the existing bill", async () => {
    await run(storage, () => executeTool("create_obligation", {
      name: "Spotify", amount: 9.99, frequency: "monthly", nextDueDate: "2026-09-02",
    }, USER));
    // "It charges on the 15th" — same bill, new due date, name said differently.
    const second: any = await run(storage, () => executeTool("create_obligation", {
      name: "Spotify Premium", amount: 9.99, frequency: "monthly", nextDueDate: "2026-09-15",
    }, USER));

    const obligations = await run(storage, () => storage.getObligations());
    expect(obligations).toHaveLength(1);
    expect(obligations[0].name).toBe("Spotify");
    expect(String(obligations[0].nextDueDate).slice(0, 10)).toBe("2026-09-15");
    expect(second.updatedExisting).toBe(true);
  });

  it("still creates a genuinely different bill", async () => {
    await run(storage, () => executeTool("create_obligation", {
      name: "Spotify", amount: 9.99, frequency: "monthly", nextDueDate: "2026-09-02",
    }, USER));
    await run(storage, () => executeTool("create_obligation", {
      name: "Netflix", amount: 15.49, frequency: "monthly", nextDueDate: "2026-09-08",
    }, USER));
    const obligations = await run(storage, () => storage.getObligations());
    expect(obligations.map(o => o.name).sort()).toEqual(["Netflix", "Spotify"]);
  });
});

describe("BUG-1 · a repeated reminder is moved, not multiplied", () => {
  let storage: MemStorage; let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("reschedules the existing task instead of adding a seventh copy", async () => {
    await run(storage, () => executeTool("create_task", {
      title: "Call the dentist", dueDate: "2026-08-18",
    }, USER));
    const again: any = await run(storage, () => executeTool("create_task", {
      title: "Call the dentist", dueDate: "2026-08-25",
    }, USER));

    const tasks = await run(storage, () => storage.getTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dueDate).toBe("2026-08-25");
    expect(again.updatedExisting).toBe(true);
  });

  it("leaves a differently-titled task alone", async () => {
    await run(storage, () => executeTool("create_task", { title: "Call the dentist", dueDate: "2026-08-18" }, USER));
    await run(storage, () => executeTool("create_task", { title: "Call the vet", dueDate: "2026-08-25" }, USER));
    const tasks = await run(storage, () => storage.getTasks());
    expect(tasks.map(t => t.title).sort()).toEqual(["Call the dentist", "Call the vet"]);
  });

  it("never reschedules a task that is already done", async () => {
    await run(storage, () => executeTool("create_task", { title: "Call the dentist", dueDate: "2026-08-18" }, USER));
    const [done] = await run(storage, () => storage.getTasks());
    await run(storage, () => storage.updateTask(done.id, { status: "done" } as any));
    const again: any = await run(storage, () => executeTool("create_task", {
      title: "Call the dentist", dueDate: "2026-08-25",
    }, USER));
    // Whatever the turn does next, the completed task keeps its own date —
    // history is not rewritten by a new request.
    const after = await run(storage, () => storage.getTasks());
    expect(after.find(t => t.id === done.id)?.dueDate).toBe("2026-08-18");
    expect(again?.updatedExisting).toBeUndefined();
  });
});

describe("BUG-1 · a subscription liability merges into the one that exists", () => {
  let storage: MemStorage; let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("keeps two different credit cards apart", async () => {
    await run(storage, () => executeTool("create_liability", {
      name: "Chase Freedom", subtype: "credit_card", currentBalance: 1200,
    }, USER));
    await run(storage, () => executeTool("create_liability", {
      name: "Chase Freedom Unlimited", subtype: "credit_card", currentBalance: 800,
    }, USER));
    const profiles = await run(storage, () => storage.getProfiles());
    const liabilities = profiles.filter(p => p.type === "liability" || p.type === "loan");
    expect(liabilities).toHaveLength(2);
  });
});

// ─── BUG-2 / BUG-3 · the note the user asked for ────────────────────────────

const MULTI =
  "Okay a few things – remind me to call the dentist next Tuesday, I drank 3 glasses of water today, " +
  "jot down that the client meeting went really well and they want a proposal, and my checking account is now 12,400.";

describe("BUG-2 · a note inside a multi-action message survives", () => {
  it("splits the filing clause out of the message", () => {
    const clauses = splitIntentClauses(MULTI);
    expect(clauses.length).toBeGreaterThan(1);
    expect(clauses.some(c => /jot down that the client meeting/i.test(c))).toBe(true);
  });

  it("reads the message as BOTH a task and a note", () => {
    const kinds = routeContent(MULTI).actions.map(a => a.kind);
    expect(kinds).toContain("task");
    expect(kinds).toContain("note");
  });

  it("lets create_note through the content-routing gate", () => {
    expect(checkContentRouting("create_note", MULTI)).toBeNull();
    expect(checkContentRouting("create_task", MULTI)).toBeNull();
  });

  it("still blocks a journal entry when the user asked for a note", () => {
    const v = checkContentRouting("journal_entry", "jane doe note: she prefers morning appointments");
    expect(v?.requestedKind).toBe("note");
  });

  it("writes a note that search can find", async () => {
    const storage = new MemStorage();
    const created = await run(storage, () => createNote(storage, {
      content: "The client meeting went really well and they want a proposal.",
      source: "chat",
    }));
    expect(created.note?.id).toBeTruthy();
    const found = await run(storage, () => listNotes(storage, { query: "proposal" }));
    expect(found.map((n: any) => n.id)).toContain(created.note.id);
    const searched = await run(storage, () => storage.search("client meeting"));
    expect(searched.some((r: any) => r.id === created.note.id)).toBe(true);
  });

  it("reports a FAILURE when the write cannot be read back", async () => {
    const storage = new MemStorage();
    // A storage whose insert is accepted but whose row never materialises —
    // exactly the shape that produced "Note saved" for content that did not
    // exist. It must throw, not return a well-formed success.
    const blindWrite = Object.create(storage);
    blindWrite.createArtifact = async (data: any) => ({ ...data, id: "ghost-artifact" });
    blindWrite.getArtifact = async () => undefined;
    await expect(
      run(storage, () => createNote(blindWrite, { content: "A note that never lands.", source: "chat" })),
    ).rejects.toThrow(/could not be saved/i);
  });
});

// ─── BUG-6 · one glass is one size ──────────────────────────────────────────

const hydration = {
  name: "Hydration",
  category: "health",
  fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
} as any;

describe("BUG-6 · glasses convert by a constant, not by guess", () => {
  it("turns 3 glasses into 24 oz however the model phrased it", () => {
    expect(normalizeTrackerEntry(hydration, { glasses: 3 }).values.ounces).toBe(24);
    expect(normalizeTrackerEntry(hydration, { glasses: 3, ounces: 72 }).values.ounces).toBe(24);
    expect(normalizeTrackerEntry(hydration, { glasses: 3, ounces: 24 }).values.ounces).toBe(24);
  });

  it("keeps the count the user actually said", () => {
    expect(normalizeTrackerEntry(hydration, { glasses: 3, ounces: 72 }).values.glasses).toBe(3);
  });

  it("uses each container's own size", () => {
    expect(normalizeTrackerEntry(hydration, { bottles: 2 }).values.ounces).toBe(33.8);
    expect(normalizeTrackerEntry(hydration, { cups: 4 }).values.ounces).toBe(32);
  });

  it("leaves a plain ounces log untouched", () => {
    expect(normalizeTrackerEntry(hydration, { ounces: 20 }).values.ounces).toBe(20);
  });

  it("does not touch a non-hydration tracker", () => {
    const weight = { name: "Weight", category: "health", fields: [{ name: "weight", type: "number", unit: "lb" }] } as any;
    expect(normalizeTrackerEntry(weight, { weight: 180 }).values.weight).toBe(180);
  });
});
