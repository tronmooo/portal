// Vercel Serverless Function entry point
// This creates the full Express app but does NOT call listen()

import dotenv from "dotenv";
try { dotenv.config(); } catch {}

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import { authMiddleware, registerAuthRoutes } from "./auth";
import { initSentry } from "./sentry";

initSentry();

const app = express();
const httpServer = createServer(app);

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
    const message = err.message || "Internal Server Error";
    console.error("Server Error:", err);
    if (res.headersSent) return next(err);
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
