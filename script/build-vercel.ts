import { build as esbuild } from "esbuild";
import { CONTENT_SECURITY_POLICY } from "../server/security-headers";
import { build as viteBuild } from "vite";
import { rm, mkdir, cp, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

async function buildForVercel() {
  // Clean
  await rm("dist", { recursive: true, force: true });
  await rm(".vercel-output", { recursive: true, force: true });
  // Stale code-split outputs from a previous build (content-hashed names would
  // otherwise accumulate and ship via the includeFiles glob).
  await rm("api/chunks", { recursive: true, force: true });
  await rm("api/_bundle.mjs", { force: true });

  // 1. Build the React frontend
  console.log("Building client...");
  await viteBuild();

  // 2. Build the server as a fully-bundled serverless function
  console.log("Building serverless API function...");
  
  // Bundle EVERYTHING except native Node modules (better-sqlite3)
  // and the Anthropic SDK (it's large but needs to be available)
  // Bundle the server into a single file
  await esbuild({
    entryPoints: { _bundle: "server/vercel-entry.ts" },
    platform: "node",
    bundle: true,
    format: "esm",
    // [PERF 2026-07-31 cold-start] Code splitting: routes.ts now imports the
    // AI stack (ai-engine / smart-fill / ai-decide / weekly-review /
    // anthropic-client → @anthropic-ai/sdk) via dynamic import() only, so
    // esbuild carves it into api/chunks/* that are loaded on first AI use.
    // api/index.js cold starts stop parsing/evaluating the whole AI graph —
    // this is what makes the Phase-5.2 function split actually cut cold cost.
    outdir: "api",
    outExtension: { ".js": ".mjs" },
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    // [PERF-1] Minified: ~25-30% smaller serverless bundle → faster cold start.
    // keepNames preserves function/class names so error stacks stay readable.
    minify: true,
    keepNames: true,
    external: [
      "better-sqlite3",
      // Native image codec — cannot be bundled. Loaded via a guarded dynamic
      // import (supabase-storage loadSharp), so Vercel's dependency tracing
      // ships its binaries; if it's ever missing at runtime, document preview
      // generation silently degrades to serving originals.
      "sharp",
    ],
    plugins: [{
      name: "fix-is-promise",
      setup(build) {
        // Replace is-promise with a simple inline implementation
        build.onResolve({ filter: /^is-promise$/ }, () => ({
          path: "is-promise",
          namespace: "is-promise-shim",
        }));
        build.onLoad({ filter: /.*/, namespace: "is-promise-shim" }, () => ({
          contents: `
            function isPromise(obj) {
              return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function';
            }
            module.exports = isPromise;
            module.exports.default = isPromise;
          `,
          loader: "js",
        }));
      },
    }],
    logLevel: "info",
    mainFields: ["module", "main"],
    conditions: ["import", "require", "node"],
  });

  // Create the Vercel function entry points — NO top-level await
  // Use dynamic import in the handler itself
  //
  // PERF Phase 5.2 (PERF_PLAN_LAUNCH_2026-07-16.md): TWO functions sharing the
  // same bundle. api/ai.js serves the long-running AI routes (chat / upload /
  // smart-fill, up to 300s each); api/index.js serves everything else. With a
  // single function, a burst of heavy AI requests saturated its concurrency
  // and queued the cheap dashboard GETs behind minutes-long chat turns. The
  // rewrites below route by path, so the express app inside is unchanged —
  // it still sees the original /api/... URL either way.
  const FUNCTION_STUB = `
let handlerReady = null;

async function loadHandler() {
  if (!handlerReady) {
    handlerReady = import("./_bundle.mjs").then(() => globalThis.__PORTOL_HANDLER);
  }
  return handlerReady;
}

export default async function(req, res) {
  try {
    const handler = await loadHandler();
    if (typeof handler === "function") {
      return handler(req, res);
    }
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Handler not loaded" }));
  } catch(e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Load failed: " + e.message }));
  }
}

// Dependency-trace hint, never called at runtime: sharp is external to the
// esbuild bundle (native binaries) and its only real import sits in a
// code-split chunk that Vercel's tracer doesn't analyze (chunks ship via
// includeFiles). This literal import makes the tracer package
// node_modules/sharp with the function. If it's still absent at runtime,
// loadSharp() in supabase-storage degrades gracefully to serving originals.
export async function __traceSharp() { return import("sharp"); }
`.trim();
  await writeFile("api/index.js", FUNCTION_STUB);
  // The AI function additionally opts into response streaming: /api/chat can
  // return SSE (routes.ts `?stream=1` / Accept: text/event-stream), and the
  // Node runtime buffers the whole body unless this flag is set — which would
  // silently turn the stream back into a 170s buffered wait. Keep in sync
  // with the checked-in api/ai.js.
  await writeFile(
    "api/ai.js",
    FUNCTION_STUB +
      "\n\n// Chat SSE streaming (routes.ts /api/chat?stream=1) requires response streaming.\nexport const config = { supportsResponseStreaming: true };\n" +
      "\n// Cold-start head start (AI lambda only): begin parsing the ai-engine chunk\n// graph the moment the base bundle is up, in parallel with the first request,\n// instead of serialized inside its processMessage call.\nloadHandler().then(() => { try { globalThis.__PORTOL_WARM_AI?.(); } catch {} }).catch(() => {});\n"
  );

  // 3. Copy static files to public/ for Vercel
  console.log("Preparing deployment directory...");
  await rm("public", { recursive: true, force: true });
  await mkdir("public", { recursive: true });
  
  // Copy all built frontend files
  await cp("dist/public", "public", { recursive: true });

  // 4. Write vercel.json — the source-of-truth config that ALSO works for git-push deploys.
  // Includes buildCommand + outputDirectory so Vercel auto-builds correctly when this file is
  // already committed (i.e., on the next git push, Vercel won't rely on a previous prebuilt run).
  const vercelConfig = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: "vite",
    buildCommand: "npm run build",
    installCommand: "npm install",
    outputDirectory: "public",
    // Run the serverless function in the SAME region as the Supabase DB
    // (us-west-2). Default iad1 added ~60-70ms x 3-15 DB round trips per
    // request — the single largest API latency factor (2026-06-10 audit).
    regions: ["pdx1"],
    rewrites: [
      // AI routes (long-running, up to 300s) go to their own function so a
      // burst of chat/upload requests can't queue dashboard reads behind it
      // (Phase 5.2). Order matters: first match wins, so these precede the
      // catch-all. The express app sees the original /api/... URL either way.
      { source: "/api/chat/:path*", destination: "/api/ai" },
      { source: "/api/chat", destination: "/api/ai" },
      { source: "/api/upload/:path*", destination: "/api/ai" },
      { source: "/api/upload", destination: "/api/ai" },
      { source: "/api/smart-fill/:path*", destination: "/api/ai" },
      { source: "/api/smart-fill", destination: "/api/ai" },
      { source: "/api/:path*", destination: "/api" },
      // SPA fallback: any non-asset, non-api, non-file path → index.html
      // Lets users refresh /dashboard, /trackers, /profiles/abc directly without hitting Vercel 404.
      { source: "/((?!assets/|api/|.*\\.[a-zA-Z0-9]+$).*)", destination: "/" }
    ],
    headers: [
      {
        source: "/assets/(.*)",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        // Security headers for the STATIC document — Express's middleware
        // never sees statically-served HTML, so the SPA document must get
        // its CSP/HSTS here. CSP imported from server/security-headers.ts
        // (single source of truth — this file used to wipe a hand-edited
        // vercel.json on every build, silently dropping these headers).
        source: "/((?!assets/|api/).*)",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" }
        ]
      }
    ],
    // Scheduled jobs. These MUST be generated here, not hand-added to
    // vercel.json: this script rewrites that file wholesale on every build, so
    // anything only present in the committed copy is silently deleted the next
    // time someone runs `npm run build` and commits. That is exactly how the
    // security headers above were lost once, and how the reminder cron was lost
    // again on 2026-07-31 — the build ran between the test pass and `git add`,
    // so nothing caught it. tests/reminder-cron.test.ts asserts this block.
    //
    // Hobby plan limits: at most 2 jobs, at most once per day each, and a
    // faster schedule makes the whole DEPLOY fail rather than just the cron.
    crons: [
      { path: "/api/cron/fire-due-reminders", schedule: "0 9 * * *" },
    ],
    functions: {
      // Fast read/write API: 60s is generous once AI traffic is out of this
      // function. (Committed vercel.json previously said 300 while this
      // generator said 60 — the split makes both true on purpose: fast lane
      // bounded, AI lane long.)
      // includeFiles: belt-and-braces so the code-split chunks (loaded via
      // dynamic import from _bundle.mjs) always ship with the function even
      // if Vercel's file tracer misses a specifier.
      "api/index.js": {
        maxDuration: 60,
        memory: 1024,
        includeFiles: "api/chunks/**"
      },
      // Chat / upload / smart-fill: multi-round AI turns, client waits up to
      // 170s (queryClient CHAT_TIMEOUT_MS) — server budget stays above that.
      // memory 1769 = 1 full vCPU on Vercel: the AI lambda parses ~3MB of
      // minified ESM on cold start, and at 1024MB (~0.6 vCPU) that parse ran
      // at roughly half speed (2026-08-17 latency teardown).
      "api/ai.js": {
        maxDuration: 300,
        memory: 1769,
        includeFiles: "api/chunks/**"
      }
    }
  };
  await writeFile("vercel.json", JSON.stringify(vercelConfig, null, 2));

  console.log("Build complete!");
  console.log("  - Frontend: public/");
  console.log("  - API: api/index.js");
  console.log("  - Config: vercel.json");
}

buildForVercel().catch((err) => {
  console.error(err);
  process.exit(1);
});
