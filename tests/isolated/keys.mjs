// Mint this run's JWT secret and the two API keys a Supabase project has
// (anon, service_role). Generated per run and written to .run/env, which is
// not committed: there is no key in the repository to leak.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), ".run");
fs.mkdirSync(dir, { recursive: true });
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const secret = randomBytes(36).toString("base64url");
const sign = (role) => {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "isolated", role, iat: 1700000000, exp: 4102444800 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const env = {
  ISOLATED_DB_PASSWORD: randomBytes(18).toString("base64url"),
  ISOLATED_JWT_SECRET: secret,
  ISOLATED_ANON_KEY: sign("anon"),
  ISOLATED_SERVICE_KEY: sign("service_role"),
};
fs.writeFileSync(path.join(dir, "env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log(`wrote ${path.join(dir, "env")}`);
