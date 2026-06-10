// Guard for the 2026-06-10 stale-shell incident.
//
// The service worker precached index.html and served it via navigateFallback
// (cache-first by construction). Users were PINNED to whatever deploy first
// installed the SW: every refresh re-served the frozen shell, so bug fixes
// "didn't work" on their devices for hours. Navigations must be NetworkFirst
// and index.html must never enter the precache manifest.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const viteConfig = readFileSync(path.join(REPO_ROOT, "vite.config.ts"), "utf8");

describe("service worker shell freshness", () => {
  it("never precaches index.html", () => {
    const globLine = viteConfig.match(/globPatterns:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(globLine).not.toMatch(/index\.html/);
  });

  it("does not use precache-backed navigateFallback", () => {
    // navigateFallback may only be null/absent — a string value serves the
    // frozen precached shell on every navigation.
    const m = viteConfig.match(/navigateFallback:\s*([^,\n]+)/);
    if (m) expect(m[1].trim()).toBe("null");
  });

  it("owns navigations with a NetworkFirst runtime route", () => {
    expect(viteConfig).toMatch(/request\.mode === "navigate"/);
    const navIdx = viteConfig.indexOf('request.mode === "navigate"');
    const after = viteConfig.slice(navIdx, navIdx + 400);
    expect(after).toMatch(/handler:\s*"NetworkFirst"/);
  });

  it("keeps /api/* NetworkOnly (data is never served from SW cache)", () => {
    const apiIdx = viteConfig.indexOf('url.pathname.startsWith("/api/")');
    expect(apiIdx).toBeGreaterThan(-1);
    expect(viteConfig).toMatch(/handler:\s*"NetworkOnly"/);
  });
});
