// Local harness: the REAL Express app + Vite client, backed by MemStorage.
// One MemStorage per `x-local-user` header (default "u1") so isolation can be probed.
// LATENCY_MS delays every /api response to make waterfalls measurable.
// Every /api call is appended as JSON to tests/perf/out/reqlog.jsonl.
process.env.NODE_ENV = process.env.NODE_ENV || "development";
delete process.env.VITE_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { registerRoutes } from "../../server/routes";
import { registerAuthRoutes, authMiddleware } from "../../server/auth";
import { securityHeaders, csrfOriginCheck } from "../../server/security-headers";
import { MemStorage, requestStorageContext, type IStorage } from "../../server/storage";
import { SupabaseStorage } from "../../server/supabase-storage";

const LATENCY_MS = parseInt(process.env.LATENCY_MS || "0", 10);
const LOG = path.resolve(import.meta.dirname, "out", "reqlog.jsonl");
fs.mkdirSync(path.dirname(LOG), { recursive: true });

function makeUserStorage(userId: string): IStorage {
  const mem: any = new MemStorage();
  const cache = new Map<string, { payload: any; expiresAt: number }>();
  let epoch = 0; const domains: Record<string, number> = {};
  const extra: Record<string, any> = {
    userId,
    setUserId() {}, seedIfEmpty: async () => {},
    enableRequestMemo() {}, disableRequestMemo() {}, clearRequestMemo() {}, primeRequestMemo() {},
    snapshotRequestMemo: async () => ({}),
    getProfilesLite: () => mem.getProfiles(),
    getResponseCache: async (k: string) => { const h = cache.get(k); if (!h) return null; if (Date.now() > h.expiresAt) { cache.delete(k); return null; } return h.payload; },
    setResponseCache: async (k: string, p: any, ttl: number) => { cache.set(k, { payload: p, expiresAt: Date.now() + ttl }); },
    cleanupResponseCache: async () => {}, sweepResponseCache: async () => {},
    getDataVersion: async () => epoch, bumpDataVersion: async () => ++epoch,
    getDataVersions: async () => ({ epoch, ...domains }),
    bumpDataVersions: async (ds: string[] = []) => { if (!ds.length) epoch++; for (const d of ds) domains[d] = (domains[d] || 0) + 1; return { epoch, ...domains }; },
    getOwnershipConsistency: async () => ({ disagreementCount: 0, jsonbOnlyCount: 0, financeDisagreementCount: 0, samples: [] }),
    repairOwnershipConsistency: async () => ({ repaired: 0 }),
    getRecentLiabilityPayments: async (limit = 10) => { const all: any[] = Array.from((mem.liabilityPayments?.values?.() ?? [])); return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit); },
    getArtifactByShareToken: async () => undefined, setArtifactShareToken: async () => undefined,
  };
  // Borrow the account helpers: they only use this.getProfiles/getProfile/updateProfile/createProfile.
  for (const m of ["getAccounts", "createAccount", "updateAccount"]) extra[m] = (SupabaseStorage.prototype as any)[m];
  return new Proxy(mem, {
    get(t, p, r) { if (p in extra) { const v = extra[p as string]; return typeof v === "function" ? v.bind(r) : v; } const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; },
  }) as IStorage;
}
const users = new Map<string, IStorage>();
const storageFor = (u: string) => { let s = users.get(u); if (!s) { s = makeUserStorage(u); users.set(u, s); } return s; };

const app = express();
const httpServer = createServer(app);
app.use(express.json({ limit: "10mb", verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: "text/csv", limit: "10mb" }));
app.use(securityHeaders);
app.use("/api", csrfOriginCheck);
registerAuthRoutes(app);
app.use("/api", authMiddleware);
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const u = String(req.headers["x-local-user"] || "u1");
  let seedN = 0;
  (req as any).userId = req.headers["x-seed"] ? `${u}:seed:${Date.now()}:${Math.random()}` : u; (req as any).userEmail = `${u}@local.test`;
  const start = Date.now();
  res.on("finish", () => {
    const line = { t: start, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - start, user: u, bytes: Number(res.getHeader("content-length") || 0) };
    fs.appendFile(LOG, JSON.stringify(line) + "\n", () => {});
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} in ${line.ms}ms`);
  });
  const go = () => requestStorageContext.run(storageFor(u), () => next());
  if (LATENCY_MS > 0) setTimeout(go, LATENCY_MS); else go();
});
(async () => {
  await registerRoutes(httpServer, app);
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ message: "Internal Server Error", detail: String(err?.message || err) });
  });
  if (process.env.SERVE_DIST) {
    const dist = path.resolve(import.meta.dirname, "..", "..", "dist", "public");
    app.use(express.static(dist, { maxAge: "1h" }));
    app.use("/{*path}", (_req, res) => res.sendFile(path.resolve(dist, "index.html")));
  } else {
    const { setupVite } = await import("../../server/vite");
    await setupVite(httpServer, app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen({ port, host: "0.0.0.0" }, () => console.log(`[local-dev] serving on ${port} latency=${LATENCY_MS}ms`));
})();
