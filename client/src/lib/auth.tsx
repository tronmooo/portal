import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { apiRequest } from "./queryClient";

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
  signOut: () => void;
  getAuthHeader: () => Record<string, string>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// In-memory token storage (can't use localStorage in sandboxed iframe)
let memoryTokens: { access_token: string; refresh_token: string; expires_at: number } | null = null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);

  // Check auth config on mount
  useEffect(() => {
    checkAuthConfig();
  }, []);

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

      // Try to restore session from memory
      if (memoryTokens) {
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
        // Try refresh
        const refreshRes = await apiRequest("POST", "/api/auth/refresh", {
          refresh_token: tokens.refresh_token,
        });
        const refreshData = await refreshRes.json();
        if (refreshData.session) {
          memoryTokens = refreshData.session;
          setUser(refreshData.user);
          setSession(refreshData.session);
        }
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
          memoryTokens = null;
        }
      }
    } catch {
      memoryTokens = null;
    }
    setLoading(false);
  }

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const res = await apiRequest("POST", "/api/auth/signin", { email, password });
      const data = await res.json();
      if (data.error) return { error: data.error };

      memoryTokens = data.session;
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

      memoryTokens = data.session;
      setUser(data.user);
      setSession(data.session);
      return {};
    } catch (err: any) {
      return { error: err.message || "Sign up failed" };
    }
  }, []);

  const signOut = useCallback(() => {
    memoryTokens = null;
    setUser(null);
    setSession(null);
  }, []);

  const getAuthHeader = useCallback((): Record<string, string> => {
    if (memoryTokens?.access_token) {
      return { Authorization: `Bearer ${memoryTokens.access_token}` };
    }
    return {};
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, authRequired, signIn, signUp, signOut, getAuthHeader }}>
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
            memoryTokens = refreshData.session;
            // Retry the original request with new token
            const retryHeaders = new Headers(init?.headers);
            retryHeaders.set("Authorization", `Bearer ${memoryTokens!.access_token}`);
            return originalFetch!(input, { ...init, headers: retryHeaders });
          }
        } catch { /* fall through */ }
      }
      // Refresh failed — clear session
      memoryTokens = null;
    }

    return response;
  };
}
