import { build as esbuild } from "esbuild";
import { CONTENT_SECURITY_POLICY } from "../server/security-headers";
import { build as viteBuild } from "vite";
import { rm, mkdir, cp, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

async function buildForVercel() {
  // Clean
  await rm("dist", { recursive: true, force: true });
  await rm(".vercel-output", { recursive: true, force: true });

  // 1. Build the React frontend
  console.log("Building client...");
  await viteBuild();

  // 2. Build the server as a fully-bundled serverless function
  console.log("Building serverless API function...");
  
  // Bundle EVERYTHING except native Node modules (better-sqlite3)
  // and the Anthropic SDK (it's large but needs to be available)
  // Bundle the server into a single file
  await esbuild({
    entryPoints: ["server/vercel-entry.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "api/_bundle.mjs",
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
`.trim();
  await writeFile("api/index.js", FUNCTION_STUB);
  await writeFile("api/ai.js", FUNCTION_STUB);

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
    functions: {
      // Fast read/write API: 60s is generous once AI traffic is out of this
      // function. (Committed vercel.json previously said 300 while this
      // generator said 60 — the split makes both true on purpose: fast lane
      // bounded, AI lane long.)
      "api/index.js": {
        maxDuration: 60,
        memory: 1024
      },
      // Chat / upload / smart-fill: multi-round AI turns, client waits up to
      // 170s (queryClient CHAT_TIMEOUT_MS) — server budget stays above that.
      "api/ai.js": {
        maxDuration: 300,
        memory: 1024
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
