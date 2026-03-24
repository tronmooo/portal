// Vercel Serverless API entry point
// Loads the built Express server bundle and exports it as a serverless handler

// Set production mode
process.env.NODE_ENV = "production";

// The built server bundle (dist/index.cjs) starts listening on its own,
// so we need a different approach — export a minimal Express app that
// handles only API routes for Vercel's serverless functions.

const express = require("express");

// We need to dynamically construct the Express app here because
// the main server bundle calls listen() which we don't want in serverless.

let app;
let initialized = false;

async function getApp() {
  if (initialized) return app;

  app = express();

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: false }));

  // Import storage and auth modules
  // These are available because they're bundled in node_modules
  const { createClient } = require("@supabase/supabase-js");

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    app.all("*", (req, res) => {
      res.status(500).json({ error: "Server not configured — missing Supabase credentials" });
    });
    initialized = true;
    return app;
  }

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Auth config endpoint
  app.get("/api/auth/config", (req, res) => {
    res.json({
      authRequired: true,
      supabaseUrl: process.env.VITE_SUPABASE_URL || null,
      supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || null,
    });
  });

  // Auth callback for Google OAuth
  app.post("/api/auth/callback", async (req, res) => {
    try {
      const supabase = createClient(supabaseUrl, serviceKey);
      const { access_token, refresh_token } = req.body;
      if (!access_token) return res.status(400).json({ error: "Access token required" });

      const { data: { user }, error } = await supabase.auth.getUser(access_token);
      if (error || !user) return res.status(401).json({ error: "Invalid token" });

      res.json({
        user: { id: user.id, email: user.email },
        session: { access_token, refresh_token, expires_at: null },
      });
    } catch (err) {
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  // Auth signin
  app.post("/api/auth/signin", async (req, res) => {
    try {
      const supabase = createClient(supabaseUrl, serviceKey);
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(400).json({ error: error.message });

      res.json({
        user: { id: data.user.id, email: data.user.email },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
        },
      });
    } catch (err) {
      res.status(500).json({ error: "Sign in failed" });
    }
  });

  // Auth signup
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const supabase = createClient(supabaseUrl, serviceKey);
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });

      const { data, error } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (error) return res.status(400).json({ error: error.message });

      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) return res.status(400).json({ error: signInError.message });

      res.json({
        user: { id: data.user.id, email: data.user.email },
        session: {
          access_token: signInData.session?.access_token,
          refresh_token: signInData.session?.refresh_token,
          expires_at: signInData.session?.expires_at,
        },
      });
    } catch (err) {
      res.status(500).json({ error: "Sign up failed" });
    }
  });

  // Auth refresh
  app.post("/api/auth/refresh", async (req, res) => {
    try {
      const supabase = createClient(supabaseUrl, serviceKey);
      const { refresh_token } = req.body;
      if (!refresh_token) return res.status(400).json({ error: "Refresh token required" });

      const { data, error } = await supabase.auth.refreshSession({ refresh_token });
      if (error || !data.session) return res.status(401).json({ error: error?.message || "Session expired" });

      res.json({
        user: { id: data.user?.id, email: data.user?.email },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
        },
      });
    } catch (err) {
      res.status(500).json({ error: "Refresh failed" });
    }
  });

  // Auth me
  app.get("/api/auth/me", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: "Not authenticated" });

      const supabase = createClient(supabaseUrl, serviceKey);
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Invalid token" });

      res.json({ user: { id: user.id, email: user.email } });
    } catch (err) {
      res.status(500).json({ error: "Auth check failed" });
    }
  });

  // Signout
  app.post("/api/auth/signout", (req, res) => {
    res.json({ success: true });
  });

  // Catch-all for non-auth API routes — these need the full server
  app.all("/api/*", (req, res) => {
    res.status(503).json({
      error: "This API endpoint requires the full application server. The serverless deployment only handles authentication. For full functionality, the app needs a persistent server deployment.",
      hint: "Authentication (Google & email/password) works. Other features require the Express server to be running.",
    });
  });

  initialized = true;
  return app;
}

module.exports = async (req, res) => {
  const handler = await getApp();
  return handler(req, res);
};
