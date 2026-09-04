import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

/**
 * PERF FIX (2026-05-24) — strip eager <link rel="modulepreload"> and
 * <link rel="stylesheet"> tags for editor-only chunks (univer / exceljs /
 * pdfjs) from the generated index.html.
 *
 * Why: Vite emits modulepreload + stylesheet tags in index.html for every
 * chunk reachable from the entry, including chunks reached ONLY via dynamic
 * import when manualChunks groups them under a named chunk. That made every
 * cold load of the app eagerly download the 2.5MB / 10MB-decoded univer
 * bundle just to render /dashboard — producing "30 seconds of skeleton"
 * the user reported, even though no dashboard code uses Univer.
 *
 * These chunks are only needed inside /editor for spreadsheet artifacts;
 * the dynamic `import("@/components/UniverSheet")` already fetches them
 * on demand, so the static preload is pure waste on every other route.
 */
function stripEditorChunkPreloads(): Plugin {
  const HEAVY = /(univer|exceljs|pdfjs)-[A-Za-z0-9_-]+\.(js|css)/;
  return {
    name: "strip-editor-chunk-preloads",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html: string) {
      // Remove modulepreload and stylesheet tags whose href points at one of
      // the heavy editor-only chunks. Matches single-line link tags emitted
      // by Vite (one tag per line in production output).
      return html
        .split("\n")
        .filter((line: string) => {
          if (!line.includes("<link")) return true;
          if (!HEAVY.test(line)) return true;
          // Keep nothing for these chunks; they load via dynamic import on demand.
          return false;
        })
        .join("\n");
    },
  };
}

/**
 * PERF (first paint) — preload the landing route's chunk.
 *
 * index.html ships a single <script type="module"> for the entry bundle and
 * nothing else, so the dashboard chunk (the landing route: "/" redirects to
 * "/dashboard") is not even discovered until the entry has downloaded, parsed,
 * mounted React and resolved auth. That's a four-step serial waterfall before
 * the first request for the code that actually paints the screen.
 *
 * Emitting <link rel="modulepreload"> for the dashboard chunk lets the browser
 * fetch it alongside the entry bundle, so by the time AuthGate renders the
 * route the module is already in the cache. Only the page chunk itself is
 * preloaded — its lazy sub-chunks (popups, charts) stay on demand.
 */
function preloadLandingRoute(): Plugin {
  return {
    name: "preload-landing-route",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html: string, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return html;
      const chunk = Object.keys(bundle).find((f) =>
        /^assets\/dashboard-[A-Za-z0-9_-]+\.js$/.test(f),
      );
      if (!chunk) return html;
      const tag = `    <link rel="modulepreload" crossorigin href="/${chunk}">\n`;
      return html.replace("</head>", `${tag}  </head>`);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    stripEditorChunkPreloads(),
    preloadLandingRoute(),
    // P1.2 (2026-06-10): real PWA service worker. Replaces the old inline
    // "unregister everything" script in index.html (which gave zero offline
    // support and zero asset caching).
    VitePWA({
      registerType: "autoUpdate",
      // Registration happens via `virtual:pwa-register` in client/src/main.tsx —
      // no injected/inline <script> in index.html (CSP must be able to drop
      // 'unsafe-inline').
      injectRegister: false,
      // Keep the existing hand-maintained client/public/manifest.json and the
      // <link rel="manifest" href="/manifest.json"> already in index.html.
      manifest: false,
      workbox: {
        // Precache ONLY the small app shell. The hashed /assets/* JS/CSS are
        // intentionally NOT precached: the lazy editor chunks (univer ~5.4MB,
        // exceljs, mermaid, pdfjs...) would force every user to download
        // ~15MB up front. /assets/* is content-hashed + immutable, so a
        // runtime CacheFirst strategy (below) gives the same repeat-visit
        // performance without the up-front cost.
        // CRITICAL (2026-06-10 incident): index.html must NEVER be precached.
        // Precache + navigateFallback served a FROZEN app shell on every
        // refresh — users were pinned to the deploy that first installed the
        // SW and could not receive fixes without a double-reload SW update
        // cycle. Navigations are NetworkFirst below: online users always get
        // the current shell (and therefore the current hashed bundles);
        // offline users get the last cached copy.
        globPatterns: ["manifest.json", "favicon.png", "icons/*.png"],
        // Belt-and-suspenders: never let a giant chunk slip into the precache.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // No navigateFallback: it can only serve from the precache (see
        // incident note above). The NetworkFirst document route below owns
        // navigations, including offline fallback.
        navigateFallback: null,
        runtimeCaching: [
          {
            // The app shell (all SPA navigations). NetworkFirst: fresh
            // index.html whenever online — a new deploy reaches the client on
            // the very next refresh. 3s timeout falls back to the cached
            // shell on dead/slow networks, preserving offline support.
            urlPattern: ({ request, url, sameOrigin }) =>
              sameOrigin && request.mode === "navigate" &&
              !url.pathname.startsWith("/api/") &&
              !url.pathname.startsWith("/auth/callback"),
            handler: "NetworkFirst",
            options: {
              cacheName: "portol-shell",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // /api/* is NEVER cached — the app is data-driven and must not
            // serve stale data. NetworkOnly also keeps responses out of the
            // Cache Storage entirely.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
          {
            // Content-hashed immutable build assets: cache-first, fetched
            // lazily as routes are visited.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.startsWith("/assets/"),
            handler: "CacheFirst",
            options: {
              cacheName: "portol-assets",
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Fontshare (General Sans) CSS + woff2 — third-party font we
            // can't self-host; cache it so repeat loads don't block on the CDN.
            urlPattern: ({ url }) => url.hostname.endsWith("fontshare.com"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "portol-fonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      // Wave 16: Univer's render engine imports opentype.module.js, but newer
      // opentype.js ships the ESM build as .mjs. Alias the deep path so Rollup
      // can find it during the production build.
      "opentype.js/dist/opentype.module.js": path.resolve(
        import.meta.dirname,
        "node_modules/opentype.js/dist/opentype.mjs",
      ),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  // Use absolute base ("/") so the index.html shipped on every SPA fallback
  // route (e.g. /editor/new/sheet) resolves /assets/* correctly. With "./"
  // nested routes turned `./assets/index.js` into /editor/new/assets/index.js
  // and 404'd, leaving the page blank.
  base: "/",
  // P1.4: strip console.log/console.debug from production bundles (pure
  // annotations only take effect during minification, so dev is unaffected).
  // console.error / console.warn are kept for field diagnostics.
  esbuild: {
    pure: ["console.log", "console.debug"],
  },
  build: {
    target: "es2020",
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // First-load perf: pre-segment heavy vendor chunks so the initial bundle
    // (the chat page) stays small. Without this, every dependency lands in
    // one giant index-*.js. The user reported "when I first open the website,
    // it needs to be faster" — splitting these out lets the browser fetch
    // them in parallel and cache them across deploys.
    //
    // PERF FIX (2026-05-24): exclude the giant editor-only chunks (univer,
    // exceljs, pdfjs) from runtime modulepreload dependency resolution.
    // Combined with the stripEditorChunkPreloads() plugin above which removes
    // their tags from index.html, this guarantees they never load until the
    // /editor route is visited and their dynamic import() runs.
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter(d => !/(univer|exceljs|pdfjs)-[A-Za-z0-9_-]+\.(js|css)/.test(d));
      },
    },
    // NOTE: manualChunks INTENTIONALLY DROPPED for univer / exceljs / pdfjs.
    //
    // Background: previously we used `manualChunks` to force these heavy
    // libs into named chunks. But Rollup’s name-based chunking introduced
    // a load-order bug — even though `editor.tsx` is lazy and the only
    // statically-reachable code path, Rollup still leaked a top-level
    // `import "./univer-*.js"` into the main entry bundle (verified by
    // grepping the built index-*.js). That caused every cold load to
    // download 2.5MB / 10MB-decoded just to render /dashboard.
    //
    // Without manualChunks, Rollup’s natural dynamic-import code splitting
    // keeps the univer / exceljs / pdfjs code inside the editor’s lazy
    // chunk hierarchy (or its own dynamic sub-chunks), so they only load
    // when the /editor route is actually visited. The strip-preload plugin
    // above is kept as belt-and-suspenders in case Rollup re-introduces a
    // named chunk via dependency sharing.
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
