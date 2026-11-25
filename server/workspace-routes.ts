// Routes for the AI boxes in the full-screen workspaces. Every one is a
// read: it returns a proposal and writes nothing (server/workspace-ai.ts).
import type { Express, Request, Response } from "express";
import { isVersionKind, type VersionKind } from "@shared/content-versions";
import { isMemoryApp, type AiMemory, type MemoryApp } from "@shared/ai-memory";

// Loaded on first use, like the rest of the AI stack, so the model SDK stays
// out of the everyday function's cold start (script/build-vercel.ts).
const ai = () => import("./workspace-ai");
const intel = () => import("./workspace-intel");
const versions = () => import("./content-versions");

/** Paths here never write user data (listed in READONLY_POST_PATHS). */
export const WORKSPACE_AI_PATHS = [
  "/api/workspace/document/assist",
  "/api/workspace/notes/assist",
  "/api/workspace/journal/reflect",
  // The apps' own tabs (server/workspace-intel.ts): answers and proposals.
  "/api/workspace/notes/insights",
  "/api/workspace/notes/categorize",
  "/api/workspace/journal/insights",
  "/api/workspace/journal/prompts",
  "/api/workspace/document/review",
] as const;
// The two CONVERSATIONS are not in that list: with remembering on they save
// the exchange and what was learned to the AI's own memory row
// (server/ai-memory.ts). They still change no record the person owns.

type Limiter = (key: string, max: number) => boolean;

export function registerWorkspaceRoutes(app: Express, rateLimit: Limiter): void {
  const guard = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
    const uid = (req as any).userId || req.ip || "anonymous";
    if (rateLimit(`workspace-ai:${uid}`, 12)) return res.status(429).json({ error: "Too many AI requests. Please wait a moment." });
    try {
      const out = await fn(req, res);
      if (out && out.ok === false) return res.status(out.status).json({ error: out.error });
      res.json(out);
    } catch (err: any) {
      console.error("[workspace-ai]", err?.message || err);
      res.status(500).json({ error: "The AI request failed. Nothing was changed." });
    }
  };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

  app.post(WORKSPACE_AI_PATHS[0], guard(async (req) => (await ai()).assistDocument({
    instruction: str(req.body?.instruction, 5000), html: str(req.body?.html, 200_000), title: str(req.body?.title, 200),
  })));
  app.post(WORKSPACE_AI_PATHS[1], guard(async (req) => (await ai()).assistNote({
    instruction: str(req.body?.instruction, 2000), content: str(req.body?.content, 60_000),
  })));
  app.post(WORKSPACE_AI_PATHS[2], guard(async (req) => (await ai()).reflectOnJournal({
    instruction: str(req.body?.instruction, 2000), draft: str(req.body?.draft, 10_000),
  })));

  app.post("/api/workspace/notes/chat", guard(async (req) => (await intel()).notesChat({
    messages: req.body?.messages,
    openNote: { id: str(req.body?.openNote?.id, 80) || null, title: str(req.body?.openNote?.title, 200), content: str(req.body?.openNote?.content, 60_000) },
  })));
  app.post("/api/workspace/journal/coach", guard(async (req) => (await intel()).journalCoach({ messages: req.body?.messages, draft: str(req.body?.draft, 10_000) })));
  app.post("/api/workspace/notes/insights", guard(async () => (await intel()).notesInsights()));
  app.post("/api/workspace/notes/categorize", guard(async () => (await intel()).notesCategorize()));
  app.post("/api/workspace/journal/insights", guard(async (req) => (await intel()).journalInsights({ focus: req.body?.focus })));
  app.post("/api/workspace/journal/prompts", guard(async () => (await intel()).journalPrompts()));
  app.post("/api/workspace/document/review", guard(async (req) => (await intel()).reviewDocument({ html: str(req.body?.html, 200_000), title: str(req.body?.title, 200) })));

  // ── What an AI remembers (server/ai-memory.ts) ────────────────────────────
  // The person sees all of it and is in charge of it: add, remove one, clear
  // the conversation, forget everything.
  const memory = () => import("./ai-memory");
  const memSafe = (fn: (req: Request, res: Response, app: MemoryApp) => Promise<any>) => async (req: Request, res: Response) => {
    if (!isMemoryApp(req.params.app)) return res.status(400).json({ error: "Unknown assistant." });
    try { await fn(req, res, req.params.app); } catch (err: any) {
      console.error("[ai-memory]", err?.message || err);
      res.status(500).json({ error: "Couldn't reach what the AI remembers. Nothing was changed." });
    }
  };
  const view = async (m: AiMemory, app: MemoryApp) => {
    const access = (await (await intel()).readAiAccess())[app];
    const self = (((await (await import("./storage")).storage.getProfiles()) || []) as any[]).find((p) => p.type === "self");
    const { clearedAt: _internal, ...shown } = m;
    return { ...shown, remember: access.memory, name: String(self?.name || "").trim().split(/\s+/)[0] || "" };
  };
  app.get("/api/workspace/memory/:app", memSafe(async (_req, res, app) => res.json(await view(await (await memory()).readAiMemory(app), app))));
  app.post("/api/workspace/memory/:app/remember", memSafe(async (req, res, app) => {
    const text = str(req.body?.text, 400).trim();
    if (text.length < 4) return res.status(400).json({ error: "Say what to remember." });
    const out = await (await memory()).addOwnMemory(app, text);
    if (out.added.length === 0) return res.status(409).json({ error: "That is already remembered." });
    res.status(201).json(await view(out.memory, app));
  }));
  app.delete("/api/workspace/memory/:app/items/:id", memSafe(async (req, res, app) => res.json(await view(await (await memory()).forgetMemoryItem(app, String(req.params.id)), app))));
  app.delete("/api/workspace/memory/:app/conversation", memSafe(async (_req, res, app) => res.json(await view(await (await memory()).clearConversation(app), app))));
  app.delete("/api/workspace/memory/:app", memSafe(async (_req, res, app) => res.json(await view(await (await memory()).forgetEverything(app), app))));

  // ── Version history (server/content-versions.ts) ──────────────────────────
  // Reads list what was kept; restore is the one write, and it keeps what it
  // replaces first.
  const safe = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (err: any) {
      console.error("[versions]", err?.message || err);
      res.status(500).json({ error: "Couldn't read the version history. Nothing was changed." });
    }
  };
  const kindOf = (req: Request, res: Response): VersionKind | null => {
    if (isVersionKind(req.params.kind)) return req.params.kind;
    res.status(400).json({ error: "Unknown kind of record." });
    return null;
  };
  app.get("/api/workspace/versions/:kind/:id", safe(async (req, res) => {
    const kind = kindOf(req, res);
    if (!kind) return;
    const v = await versions();
    if (!(await v.readRecordText(kind, String(req.params.id)))) return res.status(404).json({ error: "Not found" });
    res.json({ versions: await v.listVersions(kind, String(req.params.id)) });
  }));
  app.get("/api/workspace/versions/:kind/:id/:versionId", safe(async (req, res) => {
    const kind = kindOf(req, res);
    if (!kind) return;
    const version = await (await versions()).getVersion(kind, String(req.params.id), String(req.params.versionId));
    if (!version) return res.status(404).json({ error: "That version is no longer kept." });
    res.json(version);
  }));
  app.post("/api/workspace/versions/:kind/:id/restore", safe(async (req, res) => {
    const kind = kindOf(req, res);
    if (!kind) return;
    const versionId = str(req.body?.versionId, 80);
    if (!versionId) return res.status(400).json({ error: "Say which version to restore." });
    const out = await (await versions()).restoreVersion(kind, String(req.params.id), versionId);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ record: out.record, restoredFrom: out.restoredFrom });
  }));
}
