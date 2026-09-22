// Rule 16 — saving successfully means the transaction is committed.
//
// A success toast is a claim: "this is saved and queryable now". Firing it
// from a mutation's onMutate makes that claim BEFORE the server has answered,
// and the request can still fail (the audit found ten of them, e.g. "Task
// added" / "Task completed" / "✨ habit complete!" from onMutate). The
// optimistic UI may flip instantly; the confirmation waits for onSuccess.
//
// This scans every mutation in client/src: inside an `onMutate` body, no
// `toast({ title: ... })` may carry a success-ish title. Destructive
// (error) toasts and neutral "still saving" affordances are allowed.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../client/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** The source text of every `onMutate` function body in a file. */
export function onMutateBodies(src: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("onMutate", from);
    if (at < 0) break;
    from = at + 8;
    // Property (`onMutate: async (v) => {`) or method (`async onMutate(v) {`)
    // form — either way the body is the first `{` that follows `=>` or the
    // parameter list's `)` on the same statement.
    const head = src.slice(at, at + 400);
    const arrow = head.indexOf("=>");
    const paren = head.indexOf(")");
    const anchor = arrow >= 0 && (paren < 0 || arrow < paren + 40) ? arrow : paren;
    if (anchor < 0) continue;
    const open = head.indexOf("{", anchor);
    if (open < 0) continue;
    let depth = 0;
    let i = at + open;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) break; }
    }
    bodies.push(src.slice(at + open, i + 1));
    from = i;
  }
  return bodies;
}

const NEUTRAL_TITLE = /still saving|required|fail|couldn|can't|cannot|error|invalid|not found/i;

/** Success-ish `toast({ title: ... })` calls inside one body. */
export function successToastsIn(body: string): string[] {
  const out: string[] = [];
  const re = /toast\(\{\s*title:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const call = body.slice(m.index, m.index + 320);
    if (/variant:\s*["']destructive["']/.test(call)) continue;
    const titleStart = call.indexOf("title:") + 6;
    const title = call.slice(titleStart, titleStart + 160);
    if (NEUTRAL_TITLE.test(title)) continue;
    out.push(call.split("\n")[0].trim());
  }
  return out;
}

describe("Rule 16: no success toast fires from onMutate", () => {
  it("every onMutate body in client/src is free of success-ish toasts", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = fs.readFileSync(file, "utf8");
      if (!src.includes("onMutate")) continue;
      for (const body of onMutateBodies(src)) {
        for (const call of successToastsIn(body)) {
          offenders.push(`${path.relative(ROOT, file)}: ${call}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the scanner itself recognises the shapes it guards", () => {
    const bad = `useMutation({ onMutate: async (v) => { await x(); toast({ title: "Task added" }); return { prev }; }, onSuccess: () => {} })`;
    expect(successToastsIn(onMutateBodies(bad)[0])).toHaveLength(1);
    const ok = `useMutation({ onMutate: async () => { toast({ title: "Still saving…" }); toast({ title: "Nope", variant: "destructive" }); return {}; }, onSuccess: () => { toast({ title: "Task added" }); } })`;
    expect(successToastsIn(onMutateBodies(ok)[0])).toHaveLength(0);
  });
});
