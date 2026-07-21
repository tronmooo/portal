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

// Chat SSE streaming (routes.ts /api/chat?stream=1): the Node runtime buffers
// the whole response body unless streaming is explicitly enabled, which would
// defeat incremental frames entirely. Keep in sync with script/build-vercel.ts
// (which regenerates this file on every build).
export const config = { supportsResponseStreaming: true };