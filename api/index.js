const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.statusCode = 200; res.end(); return; }

  const url = req.url || "";
  const method = req.method || "GET";

  // --- /api/health ---
  if (url.startsWith("/api/health")) {
    return json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
  }

  // --- /api/auth/config ---
  if (url.startsWith("/api/auth/config")) {
    return json(res, 200, {
      authRequired: true,
      supabaseUrl: process.env.VITE_SUPABASE_URL || null,
      supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || null,
    });
  }

  // --- /api/auth/callback (POST) ---
  if (url.startsWith("/api/auth/callback") && method === "POST") {
    const supabase = getSupabase();
    if (!supabase) return json(res, 500, { error: "Not configured" });
    const body = await parseBody(req);
    if (!body.access_token) return json(res, 400, { error: "Access token required" });
    try {
      const { data: { user }, error } = await supabase.auth.getUser(body.access_token);
      if (error || !user) return json(res, 401, { error: "Invalid token" });
      return json(res, 200, {
        user: { id: user.id, email: user.email },
        session: { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: null },
      });
    } catch (e) { return json(res, 500, { error: "Callback failed" }); }
  }

  // --- /api/auth/signin (POST) ---
  if (url.startsWith("/api/auth/signin") && method === "POST") {
    const supabase = getSupabase();
    if (!supabase) return json(res, 500, { error: "Not configured" });
    const body = await parseBody(req);
    if (!body.email || !body.password) return json(res, 400, { error: "Email and password required" });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, {
        user: { id: data.user.id, email: data.user.email },
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at },
      });
    } catch (e) { return json(res, 500, { error: "Sign in failed" }); }
  }

  // --- /api/auth/signup (POST) ---
  if (url.startsWith("/api/auth/signup") && method === "POST") {
    const supabase = getSupabase();
    if (!supabase) return json(res, 500, { error: "Not configured" });
    const body = await parseBody(req);
    if (!body.email || !body.password) return json(res, 400, { error: "Email and password required" });
    try {
      const { data, error } = await supabase.auth.admin.createUser({ email: body.email, password: body.password, email_confirm: true });
      if (error) return json(res, 400, { error: error.message });
      const { data: sid, error: se } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
      if (se) return json(res, 400, { error: se.message });
      return json(res, 200, {
        user: { id: data.user.id, email: data.user.email },
        session: { access_token: sid.session?.access_token, refresh_token: sid.session?.refresh_token, expires_at: sid.session?.expires_at },
      });
    } catch (e) { return json(res, 500, { error: "Sign up failed" }); }
  }

  // --- /api/auth/refresh (POST) ---
  if (url.startsWith("/api/auth/refresh") && method === "POST") {
    const supabase = getSupabase();
    if (!supabase) return json(res, 500, { error: "Not configured" });
    const body = await parseBody(req);
    if (!body.refresh_token) return json(res, 400, { error: "Refresh token required" });
    try {
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: body.refresh_token });
      if (error || !data.session) return json(res, 401, { error: error?.message || "Session expired" });
      return json(res, 200, {
        user: { id: data.user?.id, email: data.user?.email },
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at },
      });
    } catch (e) { return json(res, 500, { error: "Refresh failed" }); }
  }

  // --- /api/auth/me (GET) ---
  if (url.startsWith("/api/auth/me")) {
    const supabase = getSupabase();
    if (!supabase) return json(res, 500, { error: "Not configured" });
    const auth = req.headers.authorization;
    if (!auth) return json(res, 401, { error: "Not authenticated" });
    try {
      const { data: { user }, error } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
      if (error || !user) return json(res, 401, { error: "Invalid token" });
      return json(res, 200, { user: { id: user.id, email: user.email } });
    } catch (e) { return json(res, 500, { error: "Auth check failed" }); }
  }

  // --- /api/auth/signout (POST) ---
  if (url.startsWith("/api/auth/signout")) {
    return json(res, 200, { success: true });
  }

  // --- /api/auth/forgot-password (POST) ---
  if (url.startsWith("/api/auth/forgot-password") && method === "POST") {
    const supabase = getSupabase();
    if (!supabase) return json(res, 500, { error: "Not configured" });
    const body = await parseBody(req);
    if (!body.email) return json(res, 400, { error: "Email required" });
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(body.email, { redirectTo: "https://portol.me/#/reset-password" });
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, { success: true, message: "Check your email for a reset link" });
    } catch (e) { return json(res, 500, { error: "Failed to send reset email" }); }
  }

  // --- Catch-all ---
  return json(res, 200, {
    message: "Portol API is running. Authentication is fully operational.",
    endpoints: ["/api/auth/config", "/api/auth/signin", "/api/auth/signup", "/api/auth/callback", "/api/auth/me", "/api/health"],
  });
};
