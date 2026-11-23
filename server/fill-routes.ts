// Fill In's routes (server/fill-service.ts). On Vercel every /api/smart-fill/*
// path is served by the AI function (300 s), which the model calls need.
//
//   GET  /api/smart-fill/information   My Information: every fact on file (read)
//   POST /api/smart-fill/index         read uploads never read before (writes each document's index)
//   POST /api/smart-fill/analyze       find a form's fields and propose values (read)
//   POST /api/smart-fill/refill        propose values for the empty fields again (read)
//   POST /api/smart-fill/save          write, verify and store the completed file (write)
//   GET  /api/smart-fill/forms         completed forms (read)
//   GET  /api/smart-fill/session/:id   reopen a completed form for editing (read)
import type { Express, Request, Response } from "express";

const svc = () => import("./fill-service");

/** POSTs here that write nothing (listed in READONLY_POST_PATHS). */
export const FILL_READONLY_POST_PATHS = ["/api/smart-fill/analyze", "/api/smart-fill/refill"] as const;
/** The POST that creates documents (listed in AI_WRITE_BARRIER_PATHS). */
export const FILL_SAVE_PATH = "/api/smart-fill/save";

type Limiter = (key: string, max: number) => boolean;

export function registerFillRoutes(app: Express, rateLimit: Limiter): void {
  const route = (limit: number, fn: (req: Request) => Promise<any>) => async (req: Request, res: Response) => {
    const uid = (req as any).userId || req.ip || "anonymous";
    if (limit > 0 && rateLimit(`smartfill:${uid}`, limit)) return res.status(429).json({ error: "Too many Fill In requests. Please wait a moment." });
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = Number(err?.status);
      if (status >= 400 && status < 600 && typeof err?.message === "string") return res.status(status).json({ error: err.message });
      console.error("[fill]", err?.message || err);
      res.status(500).json({ error: "Fill In could not finish that. Nothing was saved." });
    }
  };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const forId = (v: unknown) => (typeof v === "string" && v && v !== "self" ? v.slice(0, 80) : null);

  app.get("/api/smart-fill/information", route(0, async (req) => (await svc()).getFillInformation(forId(req.query.for))));
  app.get("/api/smart-fill/forms", route(0, async () => (await svc()).listFilledForms()));
  app.get("/api/smart-fill/session/:id", route(0, async (req) => (await svc()).loadFillSession(String(req.params.id))));

  app.post("/api/smart-fill/index", route(60, async (req) => (await svc()).indexNextDocuments(Number(req.body?.max) || 2)));
  app.post(FILL_READONLY_POST_PATHS[0], route(20, async (req) => {
    if (!req.body?.fileData || !req.body?.fileName) { const e: any = new Error("fileName and fileData are required."); e.status = 400; throw e; }
    return (await svc()).analyzeForm({
      fileName: str(req.body.fileName, 200), mimeType: str(req.body.mimeType, 120), fileData: String(req.body.fileData),
      textPages: Array.isArray(req.body.textPages) ? req.body.textPages : undefined, forProfileId: forId(req.body.forProfileId),
    });
  }));
  app.post(FILL_READONLY_POST_PATHS[1], route(20, async (req) => (await svc()).refillFields({
    fileName: str(req.body?.fileName, 200), fields: req.body?.fields, forProfileId: forId(req.body?.forProfileId),
  })));
  app.post(FILL_SAVE_PATH, route(20, async (req) => (await svc()).saveFilledForm({
    fileName: str(req.body?.fileName, 200), mimeType: str(req.body?.mimeType, 120),
    fileData: typeof req.body?.fileData === "string" ? req.body.fileData : undefined,
    originalDocumentId: str(req.body?.originalDocumentId, 80) || undefined,
    fields: req.body?.fields, forProfileId: forId(req.body?.forProfileId),
    replacesDocumentId: str(req.body?.replacesDocumentId, 80) || undefined,
  })));
}
