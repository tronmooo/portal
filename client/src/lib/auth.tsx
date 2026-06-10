import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
// NOTE: We do NOT import @supabase/supabase-js on the client to avoid localStorage
// references that break sandboxed iframe deployment. Instead we call the Supabase OAuth
// endpoint directly via URL redirect.
import { apiRequest } from "./queryClient";
import { queryClient, clearAllClientCaches, resetQueryCacheForUserSwitch } from "./queryClient";
import { clearChatCache } from "@/pages/chat";
import { setActiveUserForFilter, clearProfileFilterForUser } from "@/lib/profileFilter";

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

// A-1: cross-tab logout sync. signOut() writes a timestamp to this localStorage
// key; OTHER tabs receive the storage event and clear their in-memory session.
// (localStorage on purpose — sessionStorage is per-tab and fires no cross-tab
// event. The key's presence/value isn't sensitive: it's just a timestamp.)
const LOGOUT_BROADCAST_KEY = "portol_logout_broadcast";
// Written by profileFilter.setActiveUserForFilter() on sign-in; a storage event
// with a DIFFERENT uid means another tab signed into a different account.
const ACTIVE_USER_ID_KEY = "portol_active_user_id";

// Refresh-rotation canary: warn once per page load if a successful refresh
// returns the SAME refresh_token (Supabase should rotate it — a non-rotating
// token usually means a server/Supabase misconfiguration). Observability only.
let refreshRotationWarned = false;
function warnIfRefreshTokenNotRotated(oldToken: string | undefined, newToken: string | undefined): void {
  if (refreshRotationWarned) return;
  if (oldToken && newToken && oldToken === newToken) {
    refreshRotationWarned = true;
    console.warn("refresh token was not rotated");
  }
}

// PERF FIX (2026-05-24): hydrate a provisional user from sessionStorage so the
// app doesn't blank to a full-page spinner on every return visit. The real
// session is still validated against the backend in the background, but the
// shell + persisted query cache can render instantly.
function provisionalUserFromStorage(): { user: User | null; session: Session | null } {
  try {
    const stored = sessionStorage.getItem('portol_session');
    if (!stored) return { user: null, session: null };
    const tokens = JSON.parse(stored) as { access_token: string; refresh_token: string; expires_at: number };
    // Decode the JWT to get user id + email without trusting the server yet.
    // If it's already expired we don't show a provisional user — the refresh
    // flow needs to run first.
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at && tokens.expires_at < now) return { user: null, session: null };
    const payload = tokens.access_token.split('.')[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded?.sub) return { user: null, session: null };
    // Populate module-level memoryTokens so the fetch interceptor and
    // apiRequest helpers can attach the Authorization header during the
    // initial render — otherwise every dashboard query would 401 until
    // restoreSession() finishes.
    memoryTokens = tokens;
    return {
      user: { id: decoded.sub, email: decoded.email || '' },
      session: tokens,
    };
  } catch {
    return { user: null, session: null };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const provisional = provisionalUserFromStorage();
  const [user, setUser] = useState<User | null>(provisional.user);
  const [session, setSession] = useState<Session | null>(provisional.session);
  // Start `loading: false` when we have a provisional user — the app shell can
  // render immediately while `checkAuthConfig()` validates the token in the
  // background. Without this, every return visit shows the spinner.
  const [loading, setLoading] = useState(!provisional.user);
  const [authRequired, setAuthRequired] = useState(false);

  // A-1: ref mirror of `user` so the mount-once storage listener below can read
  // the CURRENT user without re-subscribing on every auth change.
  const userRef = useRef<User | null>(user);
  userRef.current = user;

  // Check auth config on mount
  useEffect(() => {
    checkAuthConfig();
  }, []);

  // A-1: cross-tab auth sync. Storage events only fire in OTHER tabs, so there
  // is no echo back to the tab that wrote the key.
  //  - Logout broadcast: another tab signed out → clear this tab's in-memory
  //    tokens/user/session + all client caches (but only if this tab still has
  //    a user; the broadcasting tab already cleared itself, and a signed-out
  //    tab reacting would just churn).
  //  - Different-user sign-in: another tab signed into a DIFFERENT account →
  //    this tab's session/caches belong to the old account; full reload is the
  //    simplest safe way to re-resolve session state from scratch.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOGOUT_BROADCAST_KEY) {
        if (e.newValue == null) return; // key removal/cleanup — not a logout
        if (!userRef.current) return;   // already signed out — avoid loops
        persistTokens(null);
        setUser(null);
        setSession(null);
        try { clearAllClientCaches(); } catch { /* ignore */ }
        try { clearChatCache(); } catch { /* ignore */ }
        return;
      }
      if (e.key === ACTIVE_USER_ID_KEY) {
        const newUid = e.newValue;
        const currentUid = userRef.current?.id;
        // newValue null = sign-out (handled by the broadcast above); only a
        // non-null uid that differs from this tab's user means account switch.
        if (newUid && currentUid && newUid !== currentUid) {
          window.location.reload();
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ST3 fix: keep the profile filter namespaced to whichever user is currently
  // signed in. When the user changes (sign-in, sign-out, OAuth callback, refresh),
  // load that user's saved filter; on sign-out, clear it from memory so the
  // next user does not inherit the previous user's selection.
  useEffect(() => {
    if (user?.id) {
      // SECURITY (defense-in-depth): if a DIFFERENT user was the last active
      // account on this device, scrub any in-memory React Query cache and the
      // persisted snapshot before seeding this user's state. The persisted-cache
      // hydrate already validates ownership against the live session token, but
      // this also covers the rare in-tab account swap where signOut's clear
      // didn't run (e.g. a refresh that returns a different user).
      try {
        const prev = localStorage.getItem("portol_active_user_id");
        if (prev && prev !== user.id) {
          resetQueryCacheForUserSwitch();
          try { clearChatCache(); } catch { /* ignore */ }
        }
      } catch { /* localStorage unavailable — ignore */ }
      setActiveUserForFilter(user.id);
    } else {
      clearProfileFilterForUser();
    }
  }, [user?.id]);

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
      const oldRefreshToken = memoryTokens.refresh_token;
      try {
        const refreshRes = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: oldRefreshToken }),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          if (data.session) {
            // Rotation canary — observability only, no behavior change.
            warnIfRefreshTokenNotRotated(oldRefreshToken, data.session.refresh_token);
            persistTokens(data.session);
            setSession(data.session);
            setUser(data.user);
          }
        }
      } catch { /* retry will happen on next timer cycle */ }
    }, refreshIn);
    return () => clearTimeout(timer);
  }, [session]);

  // Bug #16: react when the fetch interceptor clears the session due to a failed
  // refresh. Without this, React state still holds a stale user/session and the
  // UI keeps trying authenticated requests in a 401 loop.
  useEffect(() => {
    const onAuthCleared = () => {
      setUser(null);
      setSession(null);
      try { queryClient.clear(); } catch { /* ignore */ }
      try { clearChatCache(); } catch { /* ignore */ }
    };
    window.addEventListener("portol:auth-cleared", onAuthCleared as EventListener);
    return () => window.removeEventListener("portol:auth-cleared", onAuthCleared as EventListener);
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
            // Pre-warm cache in background after OAuth login
            fetch(`${API_BASE}/api/warmup`, { headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
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
          // Pre-warm server cache immediately after restoring session
          fetch(`${API_BASE}/api/warmup`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).catch(() => {});
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

  // QA Bug 2: never surface a raw HTTP status to the user. apiRequest throws
  // "400: Authentication failed" — we strip the leading "NNN: " and map any
  // remaining auth-failure messages to a friendly copy.
  const humanizeAuthError = (raw: string | undefined, fallback: string): string => {
    if (!raw) return fallback;
    const stripped = raw.replace(/^\s*\d{3}\s*:\s*/, "").trim();
    const lower = stripped.toLowerCase();
    if (!stripped) return fallback;
    if (lower.includes("authentication failed") || lower.includes("invalid login") || lower.includes("invalid credentials") || lower.includes("invalid email or password") || lower.includes("wrong password")) {
      return "Invalid email or password. Please try again.";
    }
    if (lower.includes("email not confirmed")) return "Please confirm your email before signing in.";
    if (lower.includes("user already registered") || lower.includes("already exists")) return "An account with this email already exists. Try signing in.";
    if (lower.includes("rate limit") || lower.includes("too many")) return "Too many attempts. Please wait a moment and try again.";
    return stripped;
  };

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const res = await apiRequest("POST", "/api/auth/signin", { email, password });
      const data = await res.json();
      if (data.error) return { error: humanizeAuthError(data.error, "Sign in failed") };

      persistTokens(data.session);
      setUser(data.user);
      setSession(data.session);
      return {};
    } catch (err: any) {
      return { error: humanizeAuthError(err?.message, "Sign in failed. Please try again.") };
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    try {
      const res = await apiRequest("POST", "/api/auth/signup", { email, password });
      const data = await res.json();
      if (data.error) return { error: humanizeAuthError(data.error, "Sign up failed") };

      persistTokens(data.session);
      setUser(data.user);
      setSession(data.session);
      return {};
    } catch (err: any) {
      return { error: humanizeAuthError(err?.message, "Sign up failed. Please try again.") };
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

    // 2. Clear ALL client caches — React Query in-memory cache, the persisted
    // localStorage snapshot, and the profile filter. Without this, the next
    // user that signs in on the same browser tab would hydrate from the prior
    // user's persisted cache before their first refetch lands. (Bug #21)
    clearAllClientCaches();

    // 3. Clear module-level chat history cache
    clearChatCache();

    // 4. Clear React state
    setUser(null);
    setSession(null);

    // 5. A-1: broadcast the logout to OTHER tabs via localStorage (storage
    // events don't fire in the writing tab, so no self-echo). Other tabs hold
    // their own in-memory copy of the tokens and would otherwise stay "signed
    // in" until their next 401. The value is just a timestamp — not sensitive.
    try { localStorage.setItem(LOGOUT_BROADCAST_KEY, String(Date.now())); } catch { /* ignore */ }

    // 6. Notify the server (best-effort)
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
        const oldRefreshToken = memoryTokens.refresh_token;
        try {
          const refreshRes = await originalFetch!(`${API_BASE}/api/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: oldRefreshToken }),
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json().catch(() => null);
            // Bug #15: validate refresh response shape before persisting.
            // If body is malformed (no access_token), persistTokens(undefined) would
            // wipe memoryTokens and we'd retry with a stale/empty Authorization header.
            const newSession = refreshData?.session;
            if (newSession?.access_token && newSession?.refresh_token) {
              // Rotation canary — observability only, no behavior change.
              warnIfRefreshTokenNotRotated(oldRefreshToken, newSession.refresh_token);
              persistTokens(newSession);
              // Retry the original request with the freshly-persisted token
              const retryHeaders = new Headers(init?.headers);
              retryHeaders.set("Authorization", `Bearer ${newSession.access_token}`);
              return originalFetch!(input, { ...init, headers: retryHeaders });
            }
            // Malformed refresh response — fall through to clear session
          }
        } catch { /* fall through */ }
      }
      // Refresh failed — clear session and notify the app so it can redirect.
      // Bug #16: previously this cleared tokens silently, leaving the UI stuck
      // in a 401-loop with no feedback. Dispatch an event so AuthProvider/UI
      // can react (show toast, redirect to /auth, etc.).
      persistTokens(null);
      try {
        window.dispatchEvent(new CustomEvent("portol:auth-cleared", {
          detail: { reason: "refresh-failed", url },
        }));
      } catch { /* ignore */ }
    }

    return response;
  };
}
