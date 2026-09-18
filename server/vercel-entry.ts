// Vercel Serverless Function entry point
// This creates the full Express app but does NOT call listen()

import dotenv from "dotenv";
try { dotenv.config(); } catch {}

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import { authMiddleware, registerAuthRoutes } from "./auth";

const app = express();
const httpServer = createServer(app);

// Exactly one trusted proxy hop (Vercel's edge, or a local reverse proxy) sits
// in front of the app, so req.ip is the address that hop saw — not whatever a
// client wrote into X-Forwarded-For. The per-IP rate limits in auth.ts and
// routes.ts depend on this; without it every user shared one bucket.
app.set("trust proxy", 1);
// Don't advertise the framework.
app.disable("x-powered-by");

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Stripe webhook: the RAW bytes must reach signature verification untouched,
// so this parser is mounted BEFORE express.json(). Must stay in lockstep with
// the same line in server/index.ts — production runs through THIS entry.
app.use("/api/finance/webhook", express.raw({ type: "*/*", limit: "1mb" }));

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: 'text/csv', limit: '10mb' }));

// Security headers
import { securityHeaders, csrfOriginCheck } from "./security-headers";
app.use(securityHeaders);
app.use("/api", csrfOriginCheck);

// Register auth endpoints (before auth middleware)
registerAuthRoutes(app);

// Auth middleware on all /api routes (except /api/auth/*)
app.use("/api", authMiddleware);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      console.log(`${req.method} ${req.path} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });
  next();
});

// Initialize routes (async)
let initialized = false;
const initPromise = (async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    console.error("Server Error:", err);
    if (res.headersSent) return next(err);
    // A 4xx from the body parser (malformed JSON, payload too large) carries a
    // message that is safe and useful to the client. Anything else is an
    // internal failure whose message can name tables, hosts or stack frames —
    // log it above, but never send it to the browser.
    const message = status >= 400 && status < 500 && typeof err.message === "string"
      ? err.message
      : "Internal Server Error";
    return res.status(status).json({ message });
  });

  initialized = true;
})();

// Make the handler accessible globally so the wrapper can find it
(globalThis as any).__PORTOL_HANDLER = async (req: any, res: any) => {
  if (!initialized) {
    await initPromise;
  }
  return app(req, res);
};

// Cold-start head start for the AI lambda ONLY: api/ai.js's stub (generated in
// script/build-vercel.ts) calls this right after the base bundle loads, so the
// ~1MB ai-engine/Anthropic-SDK chunk graph parses IN PARALLEL with the first
// request's middleware instead of serialized inside processMessage's dynamic
// import. api/index.js never calls it — its cold-start split stays intact.
(globalThis as any).__PORTOL_WARM_AI = () => {
  import("./ai-engine").catch(() => { /* first real AI call will retry */ });
};
