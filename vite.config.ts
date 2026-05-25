import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
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

export default defineConfig({
  plugins: [react(), stripEditorChunkPreloads()],
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
  build: {
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
