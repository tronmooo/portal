// The one address a Supabase client is given: /auth/v1 → GoTrue, /rest/v1 →
// PostgREST. (Supabase's own gateway is Kong; this is the two routes the app
// uses, plus /storage/v1 → the storage service.)
import http from "node:http";

const PORT = Number(process.env.ISOLATED_GATEWAY_PORT || 54321);
const ROUTES = [
  { prefix: "/auth/v1", host: "127.0.0.1", port: 54323 },
  { prefix: "/rest/v1", host: "127.0.0.1", port: 54324 },
  { prefix: "/storage/v1", host: "127.0.0.1", port: 54326 },
];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  "access-control-expose-headers": "content-range,content-profile,x-total-count",
};

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const route = ROUTES.find((r) => req.url.startsWith(r.prefix));
  if (!route) {
    res.writeHead(404, { "content-type": "application/json", ...CORS });
    return res.end(JSON.stringify({ error: "not part of the isolated stack", path: req.url }));
  }
  const headers = { ...req.headers, host: `${route.host}:${route.port}` };
  const up = http.request({ host: route.host, port: route.port, method: req.method, path: req.url.slice(route.prefix.length) || "/", headers }, (r) => {
    res.writeHead(r.statusCode || 502, { ...r.headers, ...CORS });
    r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502, { "content-type": "application/json", ...CORS }); res.end(JSON.stringify({ error: String(e.message) })); });
  req.pipe(up);
}).listen(PORT, "0.0.0.0", () => console.log(`isolated gateway on :${PORT}`));
