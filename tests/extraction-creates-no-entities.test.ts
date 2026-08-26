// tests/extraction-creates-no-entities.test.ts
//
// ONE RULE, ASSERTED AGAINST THE SOURCE ITSELF.
//
//   Document extraction never creates a profile, an asset or a liability.
//
// The selected record already exists — a person chose it before the upload, and
// it is the immovable context for everything the document implies. Extraction's
// job is consequences, not entities.
//
// The runtime gates (the planner's `push`, the review UI, the executor) all
// enforce this, and their tests cover the behaviour. This file covers the thing
// behaviour tests cannot: someone adding a NEW write to an extraction module
// six months from now, reaching for `storage.createProfile` because it is right
// there, and every existing test still passing because no fixture happens to
// exercise the new branch.
//
// The trap this is specifically set for: in this app a recurring bill IS a
// liability. `supabase-storage.createObligation` ends in
// `createProfile({ type: "liability" })`, because obligations were retired into
// type-aware liabilities and their tables dropped. So "create an obligation"
// and "create a liability" are the same operation wearing different names, and
// a rule that only forbade the obvious spelling would not have caught it —
// which is exactly how it got shipped once already.
//
// SCOPE: extraction only. Everything else in the app — chat tools, the
// obligations API, finance import, smart-fill — creates entities freely and is
// deliberately not covered here.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/** The modules that make up the document-extraction write path. */
const EXTRACTION_MODULES = [
  "server/action-executor.ts",
  "server/semantic-reasoner.ts",
  "server/entity-index.ts",
  "shared/extraction-actions.ts",
  "shared/semantic-document.ts",
];

/** Storage calls that bring a profile, asset or liability into existence. */
const ENTITY_CREATORS = [
  "createProfile",
  "createObligation",   // → createProfile({ type: "liability" })
];

const root = (p: string) => resolve(__dirname, "..", p);

/** Source with comments stripped, so prose about a rule never trips the rule. */
function code(path: string): string {
  const raw = readFileSync(root(path), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (not "://" in a URL)
}

describe("document extraction never creates an entity", () => {
  it.each(EXTRACTION_MODULES)("%s calls no entity-creating storage method", (mod) => {
    expect(existsSync(root(mod)), `${mod} is missing — update this list`).toBe(true);
    const src = code(mod);
    for (const method of ENTITY_CREATORS) {
      const called = new RegExp(`\\.\\s*${method}\\s*\\(`).test(src);
      expect(called, `${mod} calls ${method}() — extraction must not create entities`).toBe(false);
    }
  });

  it("the confirm-extraction route creates no entity either", () => {
    // The route is 10k lines serving many endpoints, so this narrows to the one
    // handler rather than the file: the legacy pre-plan path lives here, and it
    // is the path that runs when the understanding stage degraded — precisely
    // when a silent creation would be least expected.
    const src = code("server/routes.ts");
    const start = src.indexOf('app.post("/api/chat/confirm-extraction"');
    expect(start, "confirm-extraction route not found").toBeGreaterThan(-1);
    // The next route registration marks the end of this handler.
    const after = src.indexOf("app.post(", start + 10);
    const handler = src.slice(start, after > start ? after : undefined);

    for (const method of ENTITY_CREATORS) {
      const called = new RegExp(`storage\\.\\s*${method}\\s*\\(`).test(handler);
      expect(called, `confirm-extraction calls storage.${method}()`).toBe(false);
    }
  });

  it("the upload pipeline resolves a profile but never creates one", () => {
    const src = code("server/ai-engine.ts");
    const start = src.indexOf("export async function processFileUpload");
    expect(start).toBeGreaterThan(-1);
    const after = src.indexOf("\nexport ", start + 10);
    const fn = src.slice(start, after > start ? after : undefined);

    for (const method of ENTITY_CREATORS) {
      const called = new RegExp(`storage\\.\\s*${method}\\s*\\(`).test(fn);
      expect(called, `processFileUpload calls storage.${method}()`).toBe(false);
    }
  });

  it("the rest of the app still creates entities — this rule is extraction-only", () => {
    // A guard that over-reaches is its own bug. Chat tools, the obligations API
    // and finance import must keep working exactly as they did; if this ever
    // fails, the rule has leaked out of extraction and into the whole app.
    const engine = code("server/ai-engine.ts");
    const routes = code("server/routes.ts");
    expect(/storage\.\s*createProfile\s*\(/.test(engine)).toBe(true);
    expect(/storage\.\s*createObligation\s*\(/.test(routes)).toBe(true);
  });
});
