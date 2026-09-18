#!/usr/bin/env node
// Secret gate — blocks a Supabase service-role key from entering the repo.
//
// `tronmooo/portal` is a PUBLIC GitHub repository, and the service-role key
// bypasses EVERY row-level-security policy on EVERY table. A literal committed
// here is a full database compromise for as long as it is in a reachable
// commit, which is why the one-off scripts now read it from the environment
// (scripts/supabase-credentials.ts).
//
// Scans every tracked file for a Supabase JWT and decodes its payload: anon
// keys are public by design and allowed, service-role keys block the push.
// Run directly with: node scripts/scan-secrets.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{20,})\.[A-Za-z0-9_-]{10,}/g;
const SELF = "scripts/scan-secrets.mjs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && f !== SELF);

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable or binary — nothing to decode
  }
  if (!text.includes("eyJ")) continue;
  for (const [, payload] of text.matchAll(JWT)) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      continue; // not a decodable JWT payload
    }
    if (claims?.role === "service_role") {
      hits.push(`${file}  (service_role key for project "${claims.ref ?? "?"}")`);
    }
  }
}

if (hits.length > 0) {
  console.error("\n[secret-scan] Supabase SERVICE-ROLE key found in tracked files:\n");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(
    "\n[secret-scan] This key bypasses all RLS and this repository is public.\n" +
      "[secret-scan] Read it from the environment instead — see\n" +
      "[secret-scan] scripts/supabase-credentials.ts. If the key already reached\n" +
      "[secret-scan] a pushed commit, ROTATE it in the Supabase dashboard.\n",
  );
  process.exit(1);
}

console.log(`[secret-scan] clean — no service-role keys in ${files.length} tracked files.`);
