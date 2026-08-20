// One database, many processes.
//
// The rig used to boot its "instances" by calling registerRoutes twice inside a
// single Node process. That shares every module-level thing routes.ts owns —
// the response cache, the data-version memo, the rate limiter — so the two
// could never disagree with each other, and the cross-instance staleness that
// the read-your-writes barrier exists to prevent was impossible to reproduce.
//
// Real processes cannot share an in-memory database, so the parent keeps the
// database and exposes it over a tiny RPC. Each child instance talks to it
// through a proxy that forwards every method call. The result is what
// production actually looks like: one datastore, several server processes, each
// with its own cache and its own idea of the current data version.
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

/** Parent side: serve a storage object over HTTP. */
export async function serveStorage(storage: any): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "80mb" }));
  // What the storage object actually offers. A proxy that guesses gets two
  // things wrong: it turns DATA properties (storage._timezone) into functions,
  // and it makes OPTIONAL members (getProfilesLite) look present, defeating the
  // `?.() ?? fallback` pattern the routes rely on. Both produced failures that
  // looked like product bugs and were not.
  app.get("/introspect", (_req, res) => {
    const methods: string[] = [];
    const props: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (let obj = storage; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
      for (const key of Object.getOwnPropertyNames(obj)) {
        if (key === "constructor" || seen.has(key)) continue;
        seen.add(key);
        let value: any;
        try { value = storage[key]; } catch { continue; }
        if (typeof value === "function") { methods.push(key); continue; }
        // Only carry values that survive the wire; the rest simply stay absent.
        try { JSON.stringify(value); props[key] = value; } catch { /* skip */ }
      }
    }
    res.json({ methods, props });
  });

  app.post("/call", async (req, res) => {
    const { method, args } = req.body || {};
    const fn = storage?.[method];
    if (typeof fn !== "function") {
      // Absent is a real answer: optional IStorage members (getProfilesLite,
      // getCaptures…) are meant to be missing so callers use their fallback.
      return res.json({ absent: true });
    }
    try {
      const value = await fn.apply(storage, Array.isArray(args) ? args : []);
      res.json({ value: value === undefined ? null : value });
    } catch (err: any) {
      res.json({ error: String(err?.message || err) });
    }
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * Child side: a storage object whose every method is a call to the parent.
 *
 * `absent` methods return undefined rather than a function, so code that tests
 * `storage.getProfilesLite?.()` behaves exactly as it does against the real
 * backend — a detail that matters, because stubbing those members is what
 * silently broke profile scoping in an earlier version of this rig.
 */
export async function remoteStorage(baseUrl: string): Promise<any> {
  const res = await fetch(`${baseUrl}/introspect`);
  const { methods, props } = await res.json() as { methods: string[]; props: Record<string, unknown> };
  const methodSet = new Set(methods);

  const call = async (method: string, args: any[]) => {
    const r = await fetch(`${baseUrl}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
    });
    const body = await r.json() as { value?: any; error?: string; absent?: boolean };
    if (body.absent) return undefined;
    if (body.error) throw new Error(body.error);
    return body.value;
  };

  return new Proxy({}, {
    get(_t, prop: string) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (methodSet.has(prop)) return (...args: any[]) => call(prop, args);
      if (prop in props) return props[prop];
      // Absent means ABSENT — that is what lets `storage.getProfilesLite?.()`
      // fall through to its intended alternative.
      return undefined;
    },
    has(_t, prop: string) { return methodSet.has(prop) || prop in props; },
  });
}
