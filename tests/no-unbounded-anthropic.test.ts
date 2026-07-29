// ── No unbounded Anthropic clients (blocker #3 regression guard) ─────────────
//
// The 60s production timeouts came from EIGHT separate `new Anthropic({ apiKey })`
// call sites, each silently inheriting the SDK's 10-minute timeout and 2
// retries. Centralising them only helps if a ninth does not appear later, so
// this asserts at the source level that `server/anthropic-client.ts` is the
// only place allowed to construct one.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SERVER_DIR = join(__dirname, "..", "server");
/** The single sanctioned construction site. */
const ALLOWED = new Set(["anthropic-client.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strip line and block comments so commented-out examples don't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Anthropic client construction is centralised", () => {
  const files = walk(SERVER_DIR);

  it("finds server sources to scan (guards against a broken glob)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("no server file constructs Anthropic directly except anthropic-client.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const base = file.slice(SERVER_DIR.length + 1);
      if (ALLOWED.has(base)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (/\bnew\s+Anthropic\s*\(/.test(src)) offenders.push(base);
    }
    expect(
      offenders,
      `These files build an Anthropic client directly and would inherit the SDK's ` +
      `10-minute timeout. Use getAnthropicClient() from server/anthropic-client.ts: ` +
      offenders.join(", "),
    ).toEqual([]);
  });

  it("the sanctioned client always passes an explicit timeout and maxRetries", () => {
    const src = readFileSync(join(SERVER_DIR, "anthropic-client.ts"), "utf8");
    const ctor = src.slice(src.indexOf("new Anthropic("));
    expect(ctor).toMatch(/timeout/);
    expect(ctor).toMatch(/maxRetries/);
  });
});
