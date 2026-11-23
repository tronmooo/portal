// Routes for the AI boxes in the full-screen workspaces. Every one is a
// read: it returns a proposal and writes nothing (server/workspace-ai.ts).
import type { Express, Request, Response } from "express";

// Loaded on first use, like the rest of the AI stack, so the model SDK stays
// out of the everyday function's cold start (script/build-vercel.ts).
const ai = () => import("./workspace-ai");

/** Paths here never write user data (listed in READONLY_POST_PATHS). */
export const WORKSPACE_AI_PATHS = [
  "/api/workspace/document/assist",
  "/api/workspace/notes/assist",
  "/api/workspace/journal/reflect",
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
}
