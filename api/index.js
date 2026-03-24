// Vercel Serverless Function — Portol API
// This handles all /api/* requests

let supabaseModule = null;

try {
  supabaseModule = require("@supabase/supabase-js");
} catch (e) {
  // Module not available — will return error responses
}

function getSupabase() {
  if (!supabaseModule) return null;
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return supabaseModule.createClient(url, key);
}

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body) { resolve(req.body); return; }
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { sendJson(res, 200, {}); return; }

  const url = (req.url || "").replace(/\?.*$/, "");
  const method = req.method || "GET";

  try {
    // Health
    if (url === "/api/health" || url === "/api") {
      return sendJson(res, 200, { status: "ok", time: new Date().toISOString(), supabase: !!supabaseModule, env: !!process.env.VITE_SUPABASE_URL });
    }

    // Auth config
    if (url === "/api/auth/config") {
      return sendJson(res, 200, {
        authRequired: true,
        supabaseUrl: process.env.VITE_SUPABASE_URL || null,
        supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || null,
      });
    }

    // Auth callback (Google OAuth)
    if (url === "/api/auth/callback" && method === "POST") {
      const supabase = getSupabase();
      if (!supabase) return sendJson(res, 500, { error: "Supabase not configured" });
      const body = await parseBody(req);
      if (!body.access_token) return sendJson(res, 400, { error: "Access token required" });
      const { data: { user }, error } = await supabase.auth.getUser(body.access_token);
      if (error || !user) return sendJson(res, 401, { error: "Invalid token" });
      return sendJson(res, 200, {
        user: { id: user.id, email: user.email },
        session: { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: null },
      });
    }

    // Sign in
    if (url === "/api/auth/signin" && method === "POST") {
      const supabase = getSupabase();
      if (!supabase) return sendJson(res, 500, { error: "Supabase not configured" });
      const body = await parseBody(req);
      if (!body.email || !body.password) return sendJson(res, 400, { error: "Email and password required" });
      const { data, error } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
      if (error) return sendJson(res, 400, { error: error.message });
      return sendJson(res, 200, {
        user: { id: data.user.id, email: data.user.email },
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at },
      });
    }

    // Sign up
    if (url === "/api/auth/signup" && method === "POST") {
      const supabase = getSupabase();
      if (!supabase) return sendJson(res, 500, { error: "Supabase not configured" });
      const body = await parseBody(req);
      if (!body.email || !body.password) return sendJson(res, 400, { error: "Email and password required" });
      const { data, error } = await supabase.auth.admin.createUser({ email: body.email, password: body.password, email_confirm: true });
      if (error) return sendJson(res, 400, { error: error.message });
      const { data: sid, error: se } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
      if (se) return sendJson(res, 400, { error: se.message });
      return sendJson(res, 200, {
        user: { id: data.user.id, email: data.user.email },
        session: { access_token: sid.session?.access_token, refresh_token: sid.session?.refresh_token, expires_at: sid.session?.expires_at },
      });
    }

    // Refresh
    if (url === "/api/auth/refresh" && method === "POST") {
      const supabase = getSupabase();
      if (!supabase) return sendJson(res, 500, { error: "Supabase not configured" });
      const body = await parseBody(req);
      if (!body.refresh_token) return sendJson(res, 400, { error: "Refresh token required" });
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: body.refresh_token });
      if (error || !data.session) return sendJson(res, 401, { error: error?.message || "Session expired" });
      return sendJson(res, 200, {
        user: { id: data.user?.id, email: data.user?.email },
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at },
      });
    }

    // Me
    if (url === "/api/auth/me") {
      const supabase = getSupabase();
      if (!supabase) return sendJson(res, 500, { error: "Supabase not configured" });
      const auth = req.headers.authorization;
      if (!auth) return sendJson(res, 401, { error: "Not authenticated" });
      const { data: { user }, error } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
      if (error || !user) return sendJson(res, 401, { error: "Invalid token" });
      return sendJson(res, 200, { user: { id: user.id, email: user.email } });
    }

    // Signout
    if (url === "/api/auth/signout") {
      return sendJson(res, 200, { success: true });
    }

    // Forgot password
    if (url === "/api/auth/forgot-password" && method === "POST") {
      const supabase = getSupabase();
      if (!supabase) return sendJson(res, 500, { error: "Supabase not configured" });
      const body = await parseBody(req);
      if (!body.email) return sendJson(res, 400, { error: "Email required" });
      const { error } = await supabase.auth.resetPasswordForEmail(body.email, { redirectTo: "https://portol.me/#/reset-password" });
      if (error) return sendJson(res, 400, { error: error.message });
      return sendJson(res, 200, { success: true, message: "Check your email for a reset link" });
    }

    // Catch-all
    return sendJson(res, 200, {
      message: "Portol API — authentication is fully operational.",
      note: "Full app features (AI chat, data management) require the Express server.",
    });

  } catch (err) {
    return sendJson(res, 500, { error: "Internal server error", detail: String(err) });
  }
};
