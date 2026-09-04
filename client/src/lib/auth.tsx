import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
// NOTE: We do NOT import @supabase/supabase-js on the client to avoid localStorage
// references that break sandboxed iframe deployment. Instead we call the Supabase OAuth
// endpoint directly via URL redirect.
import { apiRequest } from "./queryClient";
import { queryClient, clearAllClientCaches, resetQueryCacheForUserSwitch } from "./queryClient";
import { clearChatCache } from "@/lib/chat-cache";
import { setActiveUserForFilter, clearProfileFilterForUser } from "@/lib/profileFilter";
import { clearStoredTimezone } from "@/lib/timezone";
import { clearStoredCurrency } from "@/lib/currency";
import { warmup } from "@/lib/warmup";

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

// Decode a JWT payload (NO signature verification — the server re-validates
// every request via authMiddleware). Used only to restore UI session state when
// /api/auth/me is unreachable (cold serverless instance / flaky network) so a
// transient blip doesn't sign out a user whose token is still valid.
function decodeJwt(token: string): { sub?: string; email?: string; exp?: number } | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch {
    return null;
  }
}

// Token storage — memory + localStorage + sessionStorage.
//
// PERF Phase 1.1 (2026-07-16, PERF_PLAN_LAUNCH): tokens used to live ONLY in
// sessionStorage, which dies with the tab — every new tab, browser restart,
// or iOS PWA/app relaunch started with no session, so every real "app open"
// showed the full-page spinner AND purged the persisted query cache (its
// owner id could not be resolved). localStorage is now the primary store so
// returning users render instantly; sessionStorage is still written as a
// fallback for sandboxed iframes where localStorage throws, and is read for
// one-release migration of existing sessions. Cross-tab logout/user-switch
// safety already exists (LOGOUT_BROADCAST_KEY + ACTIVE_USER_ID_KEY handlers).
const SESSION_KEY = 'portol_session';
let memoryTokens: { access_token: string; refresh_token: string; expires_at: number } | null = null;

/** Read the raw persisted session JSON: localStorage first (survives app
 *  relaunch), then sessionStorage (legacy slot + sandboxed-iframe fallback). */
export function readStoredSessionRaw(): string | null {
  try {
    const v = localStorage.getItem(SESSION_KEY);
    if (v) return v;
  } catch { /* sandboxed — fall through */ }
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch { /* no storage at all */ }
  return null;
}

function persistTokens(tokens: typeof memoryTokens) {
  memoryTokens = tokens;
  if (tokens) {
    const json = JSON.stringify(tokens);
    try { localStorage.setItem(SESSION_KEY, json); } catch { /* sandboxed */ }
    try { sessionStorage.setItem(SESSION_KEY, json); } catch { /* sandboxed */ }
  } else {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* sandboxed */ }
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* sandboxed */ }
  }
}

function loadPersistedTokens(): typeof memoryTokens {
  if (memoryTokens) return memoryTokens;
  try {
    const stored = readStoredSessionRaw();
    if (stored) {
      memoryTokens = JSON.parse(stored);
      return memoryTokens;
    }
  } catch { /* corrupt/unavailable — no session persistence */ }
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
    const stored = readStoredSessionRaw();
    if (!stored) return { user: null, session: null };
    const tokens = JSON.parse(stored) as { access_token: string; refresh_token: string; expires_at: number };
    // Decode the JWT to get user id + email without trusting the server yet.
    //
    // PERF Phase 1.1: an EXPIRED access token no longer blocks the provisional
    // fast path, as long as a refresh token exists. Supabase access tokens
    // last ~1h, so "open the app the next morning" always used to hit the
    // full-page spinner + cache purge. Rendering provisionally is safe: the
    // first API calls 401, the interceptor's single-flight refresh
    // (refreshSessionOnce) swaps in fresh tokens and retries; if the refresh
    // token is genuinely dead, the interceptor clears the session and the
    // auth-cleared event routes the user to sign-in. The data shown meanwhile
    // is the SAME user's persisted cache, never another account's
    // (cache-isolation.ts ownership check).
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at && tokens.expires_at < now && !tokens.refresh_token) {
      return { user: null, session: null };
    }
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
      // Regional settings are the ACCOUNT's, not the machine's, so they must
      // not survive a sign-out and greet the next person to use this browser
      // with the previous account's zone and currency.
      try { clearStoredTimezone(); } catch { /* ignore */ }
      try { clearStoredCurrency(); } catch { /* ignore */ }
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
      // PERF Phase 1.3 (PERF_PLAN_LAUNCH 2026-07-16): /api/auth/config returns
      // deployment constants (authRequired + Supabase URL/anon key — the anon
      // key is public by design), yet the app used to BLOCK its very first
      // paint on this round trip — a cold serverless start made "Loading
      // Portol..." sit for seconds before anything happened. Cache the config
      // in localStorage: returning visits apply it synchronously and
      // revalidate in the background; only the first-ever visit waits.
      const AUTH_CONFIG_KEY = "portol_auth_config_v1";
      let data: any = null;
      try {
        const cached = localStorage.getItem(AUTH_CONFIG_KEY);
        if (cached) data = JSON.parse(cached);
      } catch { /* unavailable/corrupt — fetch below */ }

      const fetchFreshConfig = async (): Promise<any | null> => {
        const res = await fetch(`${API_BASE}/api/auth/config`);
        const fresh = await res.json();
        try { localStorage.setItem(AUTH_CONFIG_KEY, JSON.stringify(fresh)); } catch { /* ignore */ }
        return fresh;
      };

      if (data && typeof data.authRequired === "boolean") {
        // Background revalidate — a deployment flipping authRequired or
        // rotating the Supabase project converges on the next launch, and
        // within this session too if the value changed.
        void fetchFreshConfig().then((fresh) => {
          if (!fresh) return;
          if (fresh.supabaseUrl && fresh.supabaseAnonKey) {
            supabaseConfig = { url: fresh.supabaseUrl, anonKey: fresh.supabaseAnonKey };
          }
          if (typeof fresh.authRequired === "boolean" && fresh.authRequired !== data.authRequired) {
            setAuthRequired(fresh.authRequired);
            if (!fresh.authRequired) setLoading(false);
          }
        }).catch(() => { /* offline — cached config stands */ });
      } else {
        data = await fetchFreshConfig();
      }

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
            // Pre-warm cache in background after OAuth login (deduped; supersedes
            // the public warmup fired at bundle load).
            warmup({ Authorization: `Bearer ${accessToken}` });
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
        // SINGLE-FLIGHT (PERF Phase 1.1): with the expired-token provisional
        // fast path, dashboard queries can already be 401-ing through the
        // interceptor's refreshSessionOnce() while we get here. Refresh tokens
        // ROTATE on use — two concurrent refresh calls means the loser burns a
        // dead token and wipes the session. Sharing refreshSessionOnce()
        // guarantees exactly one refresh no matter who asks first.
        const newSession = await refreshSessionOnce();
        if (newSession?.access_token) {
          const claims = decodeJwt(newSession.access_token);
          if (claims?.sub) setUser({ id: claims.sub, email: claims.email || "" });
          setSession(newSession);
        }
        // On failure we deliberately KEEP the stored tokens: refreshSessionOnce
        // can't distinguish "refresh token rejected" from a network blip on a
        // cold instance. A genuinely dead token gets cleared by the fetch
        // interceptor's 401 path (persistTokens(null) + auth-cleared event)
        // the moment any API call needs it.
        setLoading(false);
      } else {
        // Verify token. A NETWORK failure here (cold serverless instance, flaky
        // connection) must NOT sign the user out — the token is still inside its
        // validity window (checked above). Only an explicit 401/403 means the
        // token was actually rejected.
        let res: Response | null = null;
        try {
          res = await fetch(`${API_BASE}/api/auth/me`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
        } catch {
          res = null; // network error — fall through to optimistic restore
        }
        if (res && res.ok) {
          const data = await res.json();
          setUser(data.user);
          setSession(tokens);
          // Pre-warm server cache immediately after restoring session (deduped;
          // supersedes the public warmup fired at bundle load).
          warmup({ Authorization: `Bearer ${tokens.access_token}` });
        } else if (res && (res.status === 401 || res.status === 403)) {
          persistTokens(null); // token genuinely rejected → sign out
        } else {
          // Unreachable server or a transient 5xx — restore optimistically from
          // the JWT so a valid session survives the blip. Every API call still
          // re-verifies server-side, so this cannot grant access to a bad token.
          const claims = decodeJwt(tokens.access_token);
          if (claims?.sub) {
            setUser({ id: claims.sub, email: claims.email || "" });
            setSession(tokens);
          }
        }
        setLoading(false);
      }
    } catch {
      // Never hard-clear the session on an unexpected error — just stop loading.
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
    // A cold serverless instance can drop the very first request (Safari shows
    // "Load failed"). Signin is safe to retry — it creates no state — so we warm
    // the function and retry once on a pure network failure before giving up.
    const isNetworkError = (m?: string) => {
      const s = (m || "").toLowerCase();
      return s.includes("load failed") || s.includes("failed to fetch") || s.includes("networkerror") || s.includes("network request failed");
    };
    const attempt = async () => {
      const res = await apiRequest("POST", "/api/auth/signin", { email, password });
      return res.json();
    };
    try {
      let data;
      try {
        data = await attempt();
      } catch (err: any) {
        if (!isNetworkError(err?.message)) throw err;
        // Warm the function, then retry once.
        try { await fetch("/api/warmup", { cache: "no-store" }); } catch { /* ignore */ }
        data = await attempt();
      }
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

/* SINGLE-FLIGHT REFRESH (stuck-skeleton fix, 2026-07-16).
   When the app resumes with an expired access token, ~25 dashboard queries
   fire in parallel and ALL get 401. Previously each one launched its OWN
   /api/auth/refresh with the SAME refresh token — but refresh tokens rotate
   on use, so the first call consumed it and the other two dozen failed with
   a dead token, hit the persistTokens(null) path, and wiped the session the
   first call had just restored. Net effect: returning to the app logged the
   user out / blanked every query into permanent skeletons.
   Now every concurrent 401 awaits the SAME refresh promise. */
let refreshInFlight: Promise<Session | null> | null = null;

/* RESUME-WEDGE FIX (2026-07-21): the refresh call itself must be bounded and
   its failures classified.
   - Bounded: it used to run with NO timeout. On PWA resume over a waking 5G
     radio (or a cold serverless instance) the refresh request could hang
     indefinitely — and because refreshInFlight is only released after it
     settles, EVERY 401'd query in the app awaited that same hung promise
     forever. That is a terminal wedge recoverWedgedQueries can't fix: it
     cancels + refetches the query, the refetch 401s, and re-awaits the same
     dead promise. A 15s abort guarantees the single-flight always settles.
   - Classified: only a definitive HTTP rejection (4xx — the refresh token was
     actually refused) should sign the user out. A timeout / network error is
     transient; wiping the session for it logged users out on every flaky
     resume. The interceptor reads refreshFailedDefinitively after awaiting. */
const REFRESH_TIMEOUT_MS = 15_000;
let refreshFailedDefinitively = false;

function refreshSessionOnce(): Promise<Session | null> {
  if (refreshInFlight) return refreshInFlight;
  const oldRefreshToken = memoryTokens?.refresh_token;
  if (!oldRefreshToken) {
    // No refresh token at all — nothing to retry with; treat as definitive.
    refreshFailedDefinitively = true;
    return Promise.resolve(null);
  }
  refreshInFlight = (async () => {
    refreshFailedDefinitively = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const refreshRes = await originalFetch!(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: oldRefreshToken }),
        signal: controller.signal,
      });
      if (!refreshRes.ok) {
        // 4xx = the refresh token was rejected → the session is genuinely dead.
        // 5xx = server hiccup → transient, keep the session for the next try.
        refreshFailedDefinitively = refreshRes.status >= 400 && refreshRes.status < 500;
        return null;
      }
      const refreshData = await refreshRes.json().catch(() => null);
      // Bug #15: validate refresh response shape before persisting.
      // If body is malformed (no access_token), persistTokens(undefined) would
      // wipe memoryTokens and we'd retry with a stale/empty Authorization header.
      const newSession = refreshData?.session;
      if (newSession?.access_token && newSession?.refresh_token) {
        // Rotation canary — observability only, no behavior change.
        warnIfRefreshTokenNotRotated(oldRefreshToken, newSession.refresh_token);
        persistTokens(newSession);
        return newSession;
      }
      return null; // malformed response — transient (do not wipe the session)
    } catch {
      return null; // network error / timeout — transient
    } finally {
      clearTimeout(timer);
      // Release AFTER settling so late 401s from the same storm reuse the
      // result via the awaited promise, then the next expiry starts fresh.
      setTimeout(() => { refreshInFlight = null; }, 0);
    }
  })();
  return refreshInFlight;
}

export function installAuthInterceptor() {
  if (originalFetch) return; // Already installed
  originalFetch = window.fetch;

  // PROACTIVE RESUME REFRESH (2026-07-21): when the PWA resumes after a long
  // absence (overnight freeze), the ~1h Supabase access token is expired, so
  // the focus-refetch wave would otherwise 401 in a storm and all queue up on
  // the interceptor's reactive refresh below. Kick the single-flight refresh
  // FIRST, the moment the tab becomes visible — by the time refetches land
  // their 401s (or, ideally, go out with the already-renewed token in
  // memoryTokens), the refresh is done or in flight and they simply join it.
  // Same >=15s absence threshold as recoverWedgedQueries (lib/queryClient.ts);
  // quick tab flips never hit the network.
  const maybeRefreshOnResume = () => {
    const tokens = loadPersistedTokens();
    if (!tokens?.refresh_token) return;
    const now = Math.floor(Date.now() / 1000);
    // Refresh if the access token is expired or about to expire (<60s left).
    if (tokens.expires_at && tokens.expires_at <= now + 60) void refreshSessionOnce();
  };
  let resumeHiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      resumeHiddenAt = Date.now();
    } else {
      if (resumeHiddenAt && Date.now() - resumeHiddenAt >= 15_000) maybeRefreshOnResume();
      resumeHiddenAt = 0;
    }
  });
  // bfcache restore (iOS back/forward, app switcher) resumes with whatever
  // token the page was frozen with — same proactive refresh applies.
  window.addEventListener("pageshow", (e: PageTransitionEvent) => {
    if (e.persisted) maybeRefreshOnResume();
  });

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

    // If we get a 401, refresh (single-flight) and retry once
    if (response.status === 401 && url.includes("/api/") && !url.includes("/api/auth/")) {
      if (memoryTokens?.refresh_token) {
        const newSession = await refreshSessionOnce();
        if (newSession?.access_token) {
          // Retry the original request with the freshly-persisted token
          const retryHeaders = new Headers(init?.headers);
          retryHeaders.set("Authorization", `Bearer ${newSession.access_token}`);
          return originalFetch!(input, { ...init, headers: retryHeaders });
        }
        // RESUME-WEDGE FIX (2026-07-21): a TRANSIENT refresh failure (timeout,
        // network blip, 5xx — see refreshSessionOnce) must NOT sign the user
        // out or hand the caller a raw 401: getQueryFn's on401:"returnNull"
        // path would dispatch auth-cleared and bounce a valid session to the
        // sign-in page just because the radio was still waking up. Throw a
        // "timed out" error instead — React Query's retry policy (queryClient
        // retry: "timed out" → 2 retries with backoff) re-runs the query, its
        // next 401 starts a FRESH single-flight refresh, and the session
        // survives. Only a definitive rejection falls through to the clear.
        if (!refreshFailedDefinitively) {
          throw new Error("Session refresh timed out. Please try again.");
        }
      }
      // Refresh definitively failed (or no refresh token) — clear session and
      // notify the app so it can redirect.
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
