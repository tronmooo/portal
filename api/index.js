let handlerReady = null;

async function loadHandler() {
  if (!handlerReady) {
    handlerReady = import("./_bundle.mjs").then(() => globalThis.__PORTOL_HANDLER);
  }
  return handlerReady;
}

export default async function(req, res) {
  try {
    const handler = await loadHandler();
    if (typeof handler === "function") {
      return handler(req, res);
    }
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Handler not loaded" }));
  } catch(e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Load failed: " + e.message }));
  }
}

// Dependency-trace hint, never called at runtime: sharp is external to the
// esbuild bundle (native binaries) and its only real import sits in a
// code-split chunk that Vercel's tracer doesn't analyze (chunks ship via
// includeFiles). This literal import makes the tracer package
// node_modules/sharp with the function. If it's still absent at runtime,
// loadSharp() in supabase-storage degrades gracefully to serving originals.
export async function __traceSharp() { return import("sharp"); }