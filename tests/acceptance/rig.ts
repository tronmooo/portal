// The acceptance rig: the REAL app, running locally, in a real browser.
//
// What is real here: the built client bundle, React Query and its caches, the
// cache bus, the Express app from server/routes.ts with every middleware, the
// per-user response cache and its version-stamped keys, the AI tool loop, the
// post-write envelope, and the change manifest.
//
// What is doubled: the database (in-memory, see backend.ts) and the model
// (scripted, see mock-anthropic.ts). Neither is where the staleness bug lived.
//
// Why MULTIPLE server instances: the bug's sharpest edge is cross-instance.
// Each instance memoizes the per-user data version for ~2s, so a GET landing on
// a different warm instance than the write could compute the PRE-write cache key
// and be served pre-write data. One process cannot reproduce that. The rig boots
// N independent Express instances over ONE shared backend and round-robins /api
// requests across them through a front proxy — which is what Vercel does to a
// burst of requests from one page load.
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import path from "path";
import fs from "fs";
import { SignJWT } from "jose";
import { requestStorageContext } from "../../server/storage";
import { registerRoutes } from "../../server/routes";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { createBackend, seedProfiles } from "./backend";
import { startMockAnthropic, type MockModel } from "./mock-anthropic";
import { serveStorage } from "./storage-rpc";

export const JWT_SECRET = "acceptance-rig-secret-at-least-32-characters-long";
export const USER_ID = "3f2b8c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

export interface CapturedResponse {
  path: string;
  instance: number;
  status: number;
  at: number;
  /** The read-your-writes token the client sent with this request, if any. */
  dataVersionHeader?: string;
  /** Response body, captured only for paths matching `capture`. */
  body?: string;
}

export interface Rig {
  /** Origin the browser talks to. Serves the client AND proxies /api. */
  url: string;
  storage: any;
  stats: ReturnType<typeof createBackend>["stats"];
  profiles: Record<string, any>;
  model: MockModel;
  /** Which backend instance served each /api request, in order. */
  routing: Array<{ path: string; instance: number }>;
  /** Full responses for paths matching the capture pattern (diagnostics). */
  captured: CapturedResponse[];
  /** Set to capture response bodies for matching request paths. */
  setCapture: (re: RegExp | null) => void;
  /** Pin every subsequent /api request to one instance (null = round-robin). */
  pinInstance: (index: number | null) => void;
  /**
   * Answer the next request matching `re` with `body` instead of asking a
   * backend — a stand-in for the pre-write response a stale instance or an
   * in-flight request delivers after a write has already landed. This is the
   * only way to reproduce that here: the rig's instances share one process, so
   * they share the response cache and version memo and cannot genuinely
   * disagree with each other.
   */
  injectStaleOnce: (re: RegExp, body: unknown) => void;
  instanceCount: number;
  session: { access_token: string; refresh_token: string; expires_at: number };
  close: () => Promise<void>;
}

async function bootInstance(storage: any): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "60mb" }));
  // Stands in for server/index.ts's authMiddleware. The rig's front proxy has
  // already checked the JWT, so instances trust the resolved user — the same
  // contract registerRoutes expects in production.
  app.use((req, _res, next) => {
    (req as any).userId = USER_ID;
    requestStorageContext.run(storage, () => next());
  });
  const httpServer: Server = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

/**
 * Boot one server instance in its OWN PROCESS, against the shared database.
 *
 * In-process instances share every module-level thing routes.ts owns — the
 * response cache, the version memo, the rate limiter — so they can never
 * disagree, and cross-instance staleness cannot be reproduced. Separate
 * processes can.
 */
async function bootProcessInstance(storageUrl: string): Promise<{ url: string; close: () => Promise<void> }> {
  // ESM module scope: no require/__dirname. Resolve both from import.meta.url.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child: ChildProcess = spawn(
    "npx",
    ["tsx", path.join(here, "instance-entry.ts")],
    {
      env: {
        ...process.env,
        RIG_STORAGE_URL: storageUrl,
        RIG_USER_ID: USER_ID,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("instance did not start in 60s")), 60_000);
    let buffer = "";
    child.stdout!.on("data", (chunk) => {
      buffer += String(chunk);
      const m = buffer.match(/RIG_INSTANCE_READY (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr!.on("data", (chunk) => {
      if (process.env.RIG_VERBOSE) process.stderr.write(`[instance] ${String(chunk)}`);
      else {
        const text = String(chunk);
        if (/Error|error:/i.test(text)) process.stderr.write(`[instance] ${text}`);
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`instance exited early (${code})`)); });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => { child.kill("SIGKILL"); },
  };
}

export async function startRig(opts: { instances?: number; separateProcesses?: boolean } = {}): Promise<Rig> {
  const instanceCount = opts.instances ?? 2;
  const separateProcesses = opts.separateProcesses ?? false;
  const captured: CapturedResponse[] = [];
  let capturePattern: RegExp | null = null;
  let pinned: number | null = null;
  let staleInjection: { re: RegExp; body: unknown } | null = null;

  const distPath = path.resolve(process.cwd(), "dist/public");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Client bundle missing at ${distPath} — run \`npx vite build\` first.`);
  }

  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.ANTHROPIC_API_KEY = "acceptance-rig-key";
  process.env.NODE_ENV = process.env.NODE_ENV || "production";

  const model = await startMockAnthropic();
  process.env.ANTHROPIC_BASE_URL = model.url;
  // The client memoizes per budget, so drop any client built before the
  // base URL pointed at the mock.
  const { resetAnthropicClients } = await import("../../server/anthropic-client");
  resetAnthropicClients();

  const { storage, stats } = createBackend();
  const profiles = await requestStorageContext.run(storage, () => seedProfiles(storage));

  const instances = [];
  let storageServer: { url: string; close: () => Promise<void> } | null = null;
  if (separateProcesses) {
    storageServer = await serveStorage(storage);
    for (let i = 0; i < instanceCount; i++) instances.push(await bootProcessInstance(storageServer.url));
  } else {
    for (let i = 0; i < instanceCount; i++) instances.push(await bootInstance(storage));
  }

  // ── Front proxy: static client + round-robin /api ────────────────────────
  const routing: Rig["routing"] = [];
  let cursor = 0;
  const front = express();

  front.use("/api", async (req, res) => {
    if (staleInjection && staleInjection.re.test(req.originalUrl)) {
      const body = staleInjection.body;
      staleInjection = null;
      res.status(200).json(body);
      return;
    }
    const index = pinned ?? (cursor++ % instances.length);
    routing.push({ path: req.originalUrl, instance: index });
    const target = `${instances[index].url}${req.originalUrl}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length"].includes(k)) continue;
      if (typeof v === "string") headers[k] = v;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    await new Promise<void>((r) => req.on("end", () => r()));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) return;
        res.setHeader(key, value);
      });
      const capturing = capturePattern?.test(req.originalUrl) ?? false;
      const parts: Buffer[] = [];
      // Stream the body through so SSE chat frames arrive incrementally,
      // exactly as they do in production.
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (capturing) parts.push(chunk);
          res.write(chunk);
          (res as any).flush?.();
        }
      }
      if (capturing) {
        captured.push({
          path: req.originalUrl, instance: index, status: upstream.status,
          at: Date.now(), body: Buffer.concat(parts).toString("utf8").slice(0, 20000),
          dataVersionHeader: headers["x-data-version"],
        });
      }
      res.end();
    } catch (err: any) {
      if (!res.headersSent) res.status(502).json({ error: String(err?.message || err) });
      else res.end();
    }
  });

  front.use(express.static(distPath));
  front.use("/{*path}", (_req, res) => res.sendFile(path.resolve(distPath, "index.html")));

  const frontServer: Server = createServer(front);
  await new Promise<void>((r) => frontServer.listen(0, "127.0.0.1", r));
  const frontPort = (frontServer.address() as AddressInfo).port;

  const access_token = await new SignJWT({ role: "authenticated", email: "rig@example.test" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(JWT_SECRET));

  return {
    url: `http://127.0.0.1:${frontPort}`,
    storage,
    stats,
    profiles,
    model,
    routing,
    captured,
    setCapture: (re) => { capturePattern = re; },
    pinInstance: (i) => { pinned = i; },
    injectStaleOnce: (re, body) => { staleInjection = { re, body }; },
    instanceCount,
    session: {
      access_token,
      refresh_token: "rig-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 7200,
    },
    close: async () => {
      await new Promise<void>((r) => frontServer.close(() => r()));
      await Promise.all(instances.map((i) => i.close()));
      if (storageServer) await storageServer.close();
      await model.close();
    },
  };
}
