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
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
