// Vercel Serverless API entry point
const { createClient } = require("@supabase/supabase-js");

const express = require("express");
const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false }));

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Auth config
app.get("/api/auth/config", (req, res) => {
  res.json({
    authRequired: true,
    supabaseUrl: process.env.VITE_SUPABASE_URL || null,
    supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || null,
  });
});

// OAuth callback (Google sign-in)
app.post("/api/auth/callback", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Not configured" });
  const { access_token, refresh_token } = req.body;
  if (!access_token) return res.status(400).json({ error: "Access token required" });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(access_token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });
    res.json({ user: { id: user.id, email: user.email }, session: { access_token, refresh_token, expires_at: null } });
  } catch { res.status(500).json({ error: "Callback failed" }); }
});

// Sign in with email/password
app.post("/api/auth/signin", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Not configured" });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ user: { id: data.user.id, email: data.user.email }, session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at } });
  } catch { res.status(500).json({ error: "Sign in failed" }); }
});

// Sign up
app.post("/api/auth/signup", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Not configured" });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return res.status(400).json({ error: signInError.message });
    res.json({ user: { id: data.user.id, email: data.user.email }, session: { access_token: signInData.session?.access_token, refresh_token: signInData.session?.refresh_token, expires_at: signInData.session?.expires_at } });
  } catch { res.status(500).json({ error: "Sign up failed" }); }
});

// Refresh token
app.post("/api/auth/refresh", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Not configured" });
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: "Refresh token required" });
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error || !data.session) return res.status(401).json({ error: error?.message || "Session expired" });
    res.json({ user: { id: data.user?.id, email: data.user?.email }, session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at } });
  } catch { res.status(500).json({ error: "Refresh failed" }); }
});

// Get current user
app.get("/api/auth/me", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Not configured" });
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Not authenticated" });
  try {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });
    res.json({ user: { id: user.id, email: user.email } });
  } catch { res.status(500).json({ error: "Auth check failed" }); }
});

// Sign out
app.post("/api/auth/signout", (req, res) => {
  res.json({ success: true });
});

// Forgot password
app.post("/api/auth/forgot-password", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Not configured" });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: "https://portol.me/#/reset-password" });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, message: "Check your email for a reset link" });
  } catch { res.status(500).json({ error: "Failed to send reset email" }); }
});

// Catch-all for other API routes
app.all("/api/*", (req, res) => {
  res.status(200).json({
    message: "Portol API — authentication endpoints are available. Full app features (AI chat, trackers, documents, etc.) require the backend server.",
    auth: "working",
    availableEndpoints: ["/api/auth/config", "/api/auth/signin", "/api/auth/signup", "/api/auth/callback", "/api/auth/refresh", "/api/auth/me", "/api/health"],
  });
});

module.exports = app;
