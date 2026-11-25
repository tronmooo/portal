// Routes for the AI boxes in the full-screen workspaces. Every one is a
// read: it returns a proposal and writes nothing (server/workspace-ai.ts).
import type { Express, Request, Response } from "express";
import { isVersionKind, type VersionKind } from "@shared/content-versions";

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
  "/api/workspace/notes/chat",
  "/api/workspace/notes/insights",
  "/api/workspace/notes/categorize",
  "/api/workspace/journal/coach",
  "/api/workspace/journal/insights",
  "/api/workspace/journal/prompts",
  "/api/workspace/document/review",
] as const;

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

  app.post(WORKSPACE_AI_PATHS[3], guard(async (req) => (await intel()).notesChat({
    messages: req.body?.messages,
    openNote: { id: str(req.body?.openNote?.id, 80) || null, title: str(req.body?.openNote?.title, 200), content: str(req.body?.openNote?.content, 60_000) },
  })));
  app.post(WORKSPACE_AI_PATHS[4], guard(async () => (await intel()).notesInsights()));
  app.post(WORKSPACE_AI_PATHS[5], guard(async () => (await intel()).notesCategorize()));
  app.post(WORKSPACE_AI_PATHS[6], guard(async (req) => (await intel()).journalCoach({ messages: req.body?.messages, draft: str(req.body?.draft, 10_000) })));
  app.post(WORKSPACE_AI_PATHS[7], guard(async (req) => (await intel()).journalInsights({ focus: req.body?.focus })));
  app.post(WORKSPACE_AI_PATHS[8], guard(async () => (await intel()).journalPrompts()));
  app.post(WORKSPACE_AI_PATHS[9], guard(async (req) => (await intel()).reviewDocument({ html: str(req.body?.html, 200_000), title: str(req.body?.title, 200) })));

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
