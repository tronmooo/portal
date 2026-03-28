import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
// NOTE: We do NOT import @supabase/supabase-js on the client to avoid localStorage
// references that break sandboxed iframe deployment. Instead we call the Supabase OAuth
// endpoint directly via URL redirect.
import { apiRequest } from "./queryClient";
import { queryClient } from "./queryClient";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface User {
  id: string;
  email: string;
}

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  authRequired: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string }>;
  signInWithGoogle: () => Promise<{ error?: string }>;
  signOut: () => void;
  getAuthHeader: () => Record<string, string>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Token storage — memory + sessionStorage for persistence across page refreshes.
// sessionStorage works in most sandboxed iframes (unlike localStorage).
let memoryTokens: { access_token: string; refresh_token: string; expires_at: number } | null = null;

function persistTokens(tokens: typeof memoryTokens) {
  memoryTokens = tokens;
  if (tokens) {
    try { sessionStorage.setItem('portol_session', JSON.stringify(tokens)); } catch { /* sandboxed */ }
  } else {
    try { sessionStorage.removeItem('portol_session'); } catch { /* sandboxed */ }
  }
}

function loadPersistedTokens(): typeof memoryTokens {
  if (memoryTokens) return memoryTokens;
  try {
    const stored = sessionStorage.getItem('portol_session');
    if (stored) {
      memoryTokens = JSON.parse(stored);
      return memoryTokens;
    }
  } catch { /* sandboxed — no session persistence available */ }
  return null;
}

// Supabase config (loaded lazily from /api/auth/config)
let supabaseConfig: { url: string; anonKey: string } | null = null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);

  // Check auth config on mount
  useEffect(() => {
    checkAuthConfig();
  }, []);

  // Background token refresh — renew 5 minutes before expiry to prevent silent 401s
  useEffect(() => {
    if (!session || !memoryTokens?.refresh_token) return;
    const expiresAt = memoryTokens.expires_at || 0;
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = expiresAt - now;
    // Refresh 5 minutes before expiry, or immediately if already close
    const refreshIn = Math.max((ttlSeconds - 300) * 1000, 10000); // at least 10s
    const timer = setTimeout(async () => {
      if (!memoryTokens?.refresh_token) return;
      try {
        const refreshRes = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: memoryTokens.refresh_token }),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          if (data.session) {
            persistTokens(data.session);
            setSession(data.session);
            setUser(data.user);
          }
        }
      } catch { /* retry will happen on next timer cycle */ }
    }, refreshIn);
    return () => clearTimeout(timer);
  }, [session]);

  async function checkAuthConfig() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/config`);
      const data = await res.json();
      setAuthRequired(data.authRequired);

      if (!data.authRequired) {
        // No auth needed (SQLite mode) — just proceed
        setLoading(false);
        return;
      }

      // Cache Supabase config for OAuth flows
      if (data.supabaseUrl && data.supabaseAnonKey) {
        supabaseConfig = { url: data.supabaseUrl, anonKey: data.supabaseAnonKey };
      }

      // Handle OAuth redirect — Supabase puts tokens in the URL hash after Google sign-in
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");
      if (accessToken) {
        // Clean up the URL (remove tokens from hash)
        window.history.replaceState(null, "", window.location.pathname);

        try {
          // Verify and store the session via our backend
          const callbackRes = await apiRequest("POST", "/api/auth/callback", {
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          const callbackData = await callbackRes.json();
          if (!callbackData.error) {
            persistTokens({
              access_token: accessToken,
              refresh_token: refreshToken || "",
              expires_at: callbackData.session?.expires_at || (Math.floor(Date.now() / 1000) + 3600),
            });
            setUser(callbackData.user);
            setSession(memoryTokens);
            setLoading(false);
            return;
          }
        } catch {
          // Fall through to normal flow
        }
      }

      // Try to restore session from memory
      if (loadPersistedTokens()) {
        await restoreSession(memoryTokens);
      } else {
        setLoading(false);
      }
    } catch {
      setLoading(false);
    }
  }

  async function restoreSession(tokens: typeof memoryTokens) {
    if (!tokens) {
      setLoading(false);
      return;
    }

    try {
      // Check if token is expired
      const now = Math.floor(Date.now() / 1000);
      if (tokens.expires_at && tokens.expires_at < now) {
        // Try refresh — wrap in its own try-catch since apiRequest throws on non-2xx
        try {
          const refreshRes = await apiRequest("POST", "/api/auth/refresh", {
            refresh_token: tokens.refresh_token,
          });
          const refreshData = await refreshRes.json();
          if (refreshData.session) {
            persistTokens(refreshData.session);
            setUser(refreshData.user);
            setSession(refreshData.session);
          } else {
            persistTokens(null);
          }
        } catch {
          persistTokens(null);
        }
        setLoading(false);
      } else {
        // Verify token
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          setSession(tokens);
        } else {
          persistTokens(null);
        }
        setLoading(false);
      }
    } catch {
      persistTokens(null);
      setLoading(false);
    }
  }

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const res = await apiRequest("POST", "/api/auth/signin", { email, password });
      const data = await res.json();
      if (data.error) return { error: data.error };

      persistTokens(data.session);
      setUser(data.user);
      setSession(data.session);
      return {};
    } catch (err: any) {
      return { error: err.message || "Sign in failed" };
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    try {
      const res = await apiRequest("POST", "/api/auth/signup", { email, password });
      const data = await res.json();
      if (data.error) return { error: data.error };

      persistTokens(data.session);
      setUser(data.user);
      setSession(data.session);
      return {};
    } catch (err: any) {
      return { error: err.message || "Sign up failed" };
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try {
      // Load Supabase config if not cached
      if (!supabaseConfig) {
        const res = await fetch(`${API_BASE}/api/auth/config`);
        const config = await res.json();
        if (config.supabaseUrl && config.supabaseAnonKey) {
          supabaseConfig = { url: config.supabaseUrl, anonKey: config.supabaseAnonKey };
        }
      }
      if (!supabaseConfig) {
        return { error: "Supabase not configured" };
      }

      // Build the Supabase OAuth URL directly (avoids importing @supabase/supabase-js)
      const redirectTo = encodeURIComponent(window.location.origin);
      const oauthUrl = `${supabaseConfig.url}/auth/v1/authorize?provider=google&redirect_to=${redirectTo}&access_type=offline&prompt=consent`;
      
      // Redirect the browser to Google's OAuth consent screen via Supabase
      window.location.href = oauthUrl;
      return {};
    } catch (err: any) {
      return { error: err.message || "Google sign-in failed" };
    }
  }, []);

  const signOut = useCallback(() => {
    // 1. Clear the in-memory auth tokens
    persistTokens(null);

    // 2. Clear ALL React Query cache — prevents data leaking between users
    queryClient.clear();

    // 3. Clear React state
    setUser(null);
    setSession(null);

    // 4. Notify the server (best-effort)
    fetch(`${API_BASE}/api/auth/signout`, { method: "POST" }).catch(() => {});
  }, []);

  const getAuthHeader = useCallback((): Record<string, string> => {
    if (memoryTokens?.access_token) {
      return { Authorization: `Bearer ${memoryTokens.access_token}` };
    }
    return {};
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, authRequired, signIn, signUp, signInWithGoogle, signOut, getAuthHeader }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// Patch the global fetch to add auth headers automatically
let originalFetch: typeof fetch | null = null;

export function installAuthInterceptor() {
  if (originalFetch) return; // Already installed
  originalFetch = window.fetch;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as globalThis.Request).url;

    // Only add auth to /api/ requests (not auth endpoints)
    if (url.includes("/api/") && !url.includes("/api/auth/")) {
      if (memoryTokens?.access_token) {
        const headers = new Headers(init?.headers);
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${memoryTokens.access_token}`);
        }
        init = { ...init, headers };
      }
    }

    const response = await originalFetch!(input, init);

    // If we get a 401, clear the session
    if (response.status === 401 && url.includes("/api/") && !url.includes("/api/auth/")) {
      // Try refresh first
      if (memoryTokens?.refresh_token) {
        try {
          const refreshRes = await originalFetch!(`${API_BASE}/api/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: memoryTokens.refresh_token }),
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            persistTokens(refreshData.session);
            // Retry the original request with new token
            const retryHeaders = new Headers(init?.headers);
            retryHeaders.set("Authorization", `Bearer ${memoryTokens!.access_token}`);
            return originalFetch!(input, { ...init, headers: retryHeaders });
          }
        } catch { /* fall through */ }
      }
      // Refresh failed — clear session
      persistTokens(null);
    }

    return response;
  };
}
