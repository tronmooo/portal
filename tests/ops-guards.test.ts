// Operational guards — the "nobody noticed" class of failure.
//
// 2026-10-09: Vercel retired Node 20 while the project still pinned it, and
// every production deploy failed for two weeks without anyone knowing; ten
// high-severity advisories had piled up unseen; and the one live end-to-end
// workflow had been red on every run, so its failures meant nothing. These
// tests keep the countermeasures in place:
//   · ONE Node version, declared once (.nvmrc) and used by package.json
//     engines (what Vercel builds with) and by every CI workflow;
//   · no workflow on a deprecated action runtime;
//   · the production watchdog runs on every push to main and daily;
//   · CI runs weekly with no push, and its audit gate stays on;
//   · Dependabot keeps dependencies (and actions) moving in small steps.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const workflows = fs.readdirSync(path.join(root, ".github/workflows")).filter(f => /\.ya?ml$/.test(f));

describe("one Node version everywhere", () => {
  const nvmrc = read(".nvmrc").trim();
  const engines = JSON.parse(read("package.json")).engines?.node as string | undefined;

  it(".nvmrc names a major version and package.json engines matches it (Vercel builds with engines)", () => {
    expect(nvmrc).toMatch(/^\d+$/);
    expect(engines, "package.json engines.node").toBe(`${nvmrc}.x`);
  });

  it("@types/node describes the runtime we actually run (same major as .nvmrc)", () => {
    const pkg = JSON.parse(read("package.json"));
    const types = String(pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"] ?? "");
    expect(types.replace(/^[^\d]*/, "").split(".")[0], "@types/node major").toBe(nvmrc);
  });

  it("every workflow that sets up Node reads .nvmrc instead of hard-coding a version", () => {
    for (const f of workflows) {
      const src = read(`.github/workflows/${f}`);
      if (!src.includes("actions/setup-node")) continue;
      expect(src, f).toContain("node-version-file: '.nvmrc'");
      expect(src, f).not.toMatch(/node-version:\s*['"]?\d/);
    }
  });

  it("no workflow uses an action major that runs on the deprecated Node 20 runtime", () => {
    for (const f of workflows) {
      const src = read(`.github/workflows/${f}`);
      expect(src, f).not.toMatch(/actions\/(checkout|setup-node)@v[1-4]\b/);
      expect(src, f).not.toMatch(/actions\/github-script@v[1-7]\b/);
    }
  });
});

describe("failures are noticed without anyone looking", () => {
  it("the production watchdog checks the live commit after every push to main and daily, and raises an issue", () => {
    const src = read(".github/workflows/deploy-verify.yml");
    expect(src).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(src).toMatch(/schedule:/);
    expect(src).toContain("/api/version");
    expect(src).toContain("issues: write");
    expect(src).toContain("issues.create");
  });

  it("the live site still reports which commit it serves (the watchdog's only probe)", () => {
    expect(read("server/routes.ts")).toMatch(/app\.get\("\/api\/version"[\s\S]{0,200}VERCEL_GIT_COMMIT_SHA/);
  });

  it("CI runs weekly with no push, and keeps its dependency-audit gate", () => {
    const src = read(".github/workflows/ci.yml");
    expect(src).toMatch(/schedule:\s*\n\s*- cron:/);
    expect(src).toContain("npm run audit:ci");
  });

  it("Dependabot watches npm and GitHub Actions", () => {
    const src = read(".github/dependabot.yml");
    expect(src).toContain("package-ecosystem: npm");
    expect(src).toContain("package-ecosystem: github-actions");
  });
});

describe("the live end-to-end suite stays a trustworthy alarm", () => {
  const src = read("tests/live-scenarios.test.ts");

  it("runs on the dedicated smoke account, never a person's login", () => {
    expect(src).toContain("SMOKE_EMAIL");
    expect(src).not.toMatch(/E2E_EMAIL \|\| "[^"]+@/);
    expect(src).not.toMatch(/E2E_PASSWORD \|\| "password"/);
  });

  it("reads response shapes through strict helpers — no `|| []` that lets a negative check pass on a missing field", () => {
    // `(data?.assetBreakdown || []).some(...) === false` passed for months
    // against a field that did not exist.
    expect(src).not.toMatch(/data\?\.(assetBreakdown|liabilityBreakdown|childProfiles)\s*\|\|/);
    expect(src).not.toMatch(/\(budgets\.data \|\| \[\]\)/);
  });

  it("runs automatically after every deploy the watchdog confirms", () => {
    const wf = read(".github/workflows/live-e2e.yml");
    expect(wf).toMatch(/workflow_run:\s*\n\s*workflows: \["Production serves main"\]/);
    expect(read(".github/workflows/deploy-verify.yml")).toMatch(/^name: Production serves main$/m);
  });
});

describe("no live credentials in the repository", () => {
  it("no script signs in to production with a literal login or password", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") scan(rel); continue; }
        if (!/\.(ts|tsx|js|mjs|py)$/.test(e.name)) continue;
        const src = read(rel);
        // A literal personal login, or the literal password "password", used to sign in.
        if (/tron@aol\.com/.test(src) || /password["']?\s*[:,]\s*["']password["']/.test(src)) offenders.push(rel);
      }
    };
    for (const d of ["tests", "scripts", "script"]) if (fs.existsSync(path.join(root, d))) scan(d);
    for (const f of fs.readdirSync(root)) if (/\.(ts|py|mjs|js)$/.test(f) && /tron@aol\.com/.test(read(f))) offenders.push(f);
    expect(offenders).toEqual([]);
  });
});

describe("CLAUDE.md stays true", () => {
  it("every file and test it points to exists", () => {
    const doc = read("CLAUDE.md");
    const refs = [...doc.matchAll(/`((?:client|server|shared|tests|docs|\.github|\.githooks)\/[^`*\s]+\.(?:ts|tsx|md|yml))`/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(10);
    const missing = refs.filter(r => !fs.existsSync(path.join(root, r)));
    expect(missing).toEqual([]);
  });
});
