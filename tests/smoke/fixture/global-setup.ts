/**
 * Contract-suite global setup: hold the smoke account's gate lock for the
 * whole run (see gate-lock.ts), and never reuse a seed from an earlier run —
 * another gate may have wiped the account since, which left this suite
 * testing deleted records (404s) when it reused a cached seed.
 */
import { rmSync } from "node:fs";
import { api } from "./api";
import { acquireGateLock, preferenceLockIo } from "./gate-lock";
import { LOCK_FILE } from "./setup";

export default async function setup(): Promise<() => Promise<void>> {
  const release = await acquireGateLock(
    preferenceLockIo((method, path, body) => api(method, path, body)),
    { gate: "contracts" },
  );
  rmSync(LOCK_FILE, { force: true });
  return release;
}
