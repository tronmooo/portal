import { useState, useEffect } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// ── One session-level install prompt ─────────────────────────────────────────
// QA 2026-08-20 (bug 15): "It appeared after switching to Jane and Test Child,
// but was absent on Bob during the same session."
//
// The component was already mounted once at the app root, outside any
// profile-specific tree — but its ELIGIBILITY was accidental. `beforeinstallprompt`
// fires whenever the browser decides, so whichever screen happened to be open
// at that moment got the prompt, which reads exactly like "switching profiles
// summons it". And the 15s auto-dismiss set only an in-memory flag, so a reload
// (or anything that remounted the tree) brought it straight back.
//
// The policy is now explicit and profile-independent:
//   · suppressed entirely once the app is running installed (standalone), or
//     after the browser reports `appinstalled`;
//   · shown AT MOST ONCE per session — including the auto-dismiss path, which
//     now persists like the manual one;
//   · a manual dismissal is remembered for DISMISS_DAYS across sessions.
const SESSION_KEY = "portol_install_dismissed";        // this tab/session only
const SNOOZE_KEY = "portol_install_snoozed_until";     // across sessions (ms epoch)
const DISMISS_DAYS = 30;
const AUTO_DISMISS_MS = 15_000;

function isStandalone(): boolean {
  try {
    return window.matchMedia?.("(display-mode: standalone)")?.matches === true
      || (window.navigator as any)?.standalone === true;
  } catch { return false; }
}

/** Pure policy check — exported so the rule can be tested without a DOM event. */
export function installPromptSuppressed(now: number = Date.now()): boolean {
  if (isStandalone()) return true;
  try {
    if (sessionStorage.getItem(SESSION_KEY) === "1") return true;
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    if (Number.isFinite(until) && until > now) return true;
  } catch { /* private mode — fall through to "not suppressed" */ }
  return false;
}

function suppressForSession(): void {
  try { sessionStorage.setItem(SESSION_KEY, "1"); } catch {}
}

function snoozeAcrossSessions(): void {
  suppressForSession();
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + DISMISS_DAYS * 86400000));
  } catch {}
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => installPromptSuppressed());

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      // Capture the event even while suppressed (it is only offered once per
      // page load), but never surface it against the policy above.
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      if (installPromptSuppressed()) setDismissed(true);
    };
    const installed = () => { snoozeAcrossSessions(); setDismissed(true); setDeferredPrompt(null); };
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  // Auto-dismiss after 15 seconds to prevent blocking UI. Persisted for the
  // session so it does not come back on the next screen the user opens.
  useEffect(() => {
    if (!deferredPrompt || dismissed) return;
    const timer = setTimeout(() => {
      suppressForSession();
      setDismissed(true);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [deferredPrompt, dismissed]);

  if (!deferredPrompt || dismissed) return null;

  function handleDismiss() {
    // An explicit "no" outlives the session; the auto-dismiss above does not.
    snoozeAcrossSessions();
    setDismissed(true);
  }

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setDeferredPrompt(null);
    }
    handleDismiss();
  }

  return (
    <div className="bubble fixed bottom-20 md:bottom-4 right-4 z-40 flex items-center gap-3 p-3 shadow-lg max-w-xs animate-in slide-in-from-bottom-2" data-testid="install-prompt">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">Install Portol</p>
        <p className="text-xs text-muted-foreground">Add to your home screen for quick access</p>
      </div>
      <Button size="sm" onClick={handleInstall} className="shrink-0" data-testid="button-install-app">
        <Download className="w-4 h-4 mr-1" />
        Install
      </Button>
      <button onClick={handleDismiss} className="p-1 hover:bg-muted rounded-md shrink-0" data-testid="button-dismiss-install" aria-label="Dismiss install prompt">
        <X className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  );
}
