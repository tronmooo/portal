// Module-level chat history cache + sessionStorage persistence.
//
// PERF (2026-07-16, Phase 1.5 of PERF_PLAN_LAUNCH): this state used to live in
// pages/chat.tsx. auth.tsx imports clearChatCache() (sign-out must scrub chat
// history), and that static edge pulled the entire 3.7k-line chat page — and
// everything it imports — into the ENTRY bundle for every user on every route.
// Extracting the cache into this dependency-light module lets App.tsx load the
// chat page lazily like every other route.
import type { ChatMessage } from "@shared/schema";

const CHAT_HISTORY_KEY = "portol_chat_history";

export const WELCOME_MSG: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content: "Hi! I'm your Portol AI. Ask me to log health data, track expenses, create events, add tasks, open documents, and more. What would you like to do?",
  timestamp: new Date().toISOString(),
};

// Persist chat history to sessionStorage so it survives page reloads
export function loadChatHistory(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem(CHAT_HISTORY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore parse errors */ }
  return [WELCOME_MSG];
}

// Persisted attachments keep their base64 only when small enough to render a
// thumbnail after reload without blowing the sessionStorage quota. Above this
// the data is dropped (the document itself is already saved server-side).
const PERSIST_ATTACHMENT_DATA_MAX_CHARS = 400_000; // ~400KB of base64

export function saveChatHistory(messages: ChatMessage[]) {
  try {
    // Keep last 100 messages to avoid storage bloat. PERF (2026-08-17): this
    // runs on EVERY setMessages, and multi-MB attachment base64 made each call
    // a multi-MB JSON.stringify that then threw QuotaExceededError silently —
    // so history quietly stopped persisting the moment a photo was uploaded.
    // Strip oversized attachment data and NEVER persist blob: previewUrls
    // (they cannot survive a reload — restoring them renders broken images).
    const toSave = messages.slice(-100).map((m) => {
      const att = (m as any).attachment;
      if (!att) return m;
      const keepData = typeof att.data === "string" && att.data.length <= PERSIST_ATTACHMENT_DATA_MAX_CHARS;
      return {
        ...m,
        attachment: {
          ...att,
          data: keepData ? att.data : "",
          previewUrl: "",
        },
      };
    });
    sessionStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(toSave));
  } catch { /* storage full — ignore */ }
}

// Lazy-initialized so importing this module (e.g. from auth.tsx at boot) does
// no storage I/O until the chat page actually reads the cache.
let _chatCache: ChatMessage[] | null = null;

export function getChatCache(): ChatMessage[] {
  if (_chatCache === null) _chatCache = loadChatHistory();
  return _chatCache;
}

export function setChatCache(messages: ChatMessage[]) {
  _chatCache = messages;
}

/** Clear module-level chat cache — must be called on sign-out to prevent data leakage between users */
export function clearChatCache() {
  _chatCache = [WELCOME_MSG];
  try { sessionStorage.removeItem(CHAT_HISTORY_KEY); } catch {}
}
