import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
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
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes("node_modules")) return undefined;
          // Univer is enormous (5.4MB) and only used on the editor route
          if (id.includes("@univerjs") || id.includes("opentype.js")) return "univer";
          // ExcelJS — only used on the editor for spreadsheet export/import
          if (id.includes("exceljs")) return "exceljs";
          // Recharts is large and only used on a few dashboard widgets
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          // PDF.js used only when opening a document
          if (id.includes("pdfjs-dist")) return "pdfjs";
          // Radix UI is sprinkled everywhere but compresses well as one chunk
          if (id.includes("@radix-ui")) return "radix";
          // React core stays in vendor
          if (id.includes("react-dom") || id.includes("react/") || id.includes("scheduler")) return "react-core";
          // Everything else stays in the default vendor split
          return "vendor";
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
