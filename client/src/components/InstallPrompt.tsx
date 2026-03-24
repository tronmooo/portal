import { useState, useEffect } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!deferredPrompt || dismissed) return null;

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setDeferredPrompt(null);
    }
    setDismissed(true);
  }

  return (
    <div className="fixed bottom-20 md:bottom-4 right-4 z-50 flex items-center gap-3 p-3 bg-card border border-border rounded-xl shadow-lg max-w-xs animate-in slide-in-from-bottom-2" data-testid="install-prompt">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">Install Portol</p>
        <p className="text-xs text-muted-foreground">Add to your home screen for quick access</p>
      </div>
      <Button size="sm" onClick={handleInstall} className="shrink-0" data-testid="button-install-app">
        <Download className="w-4 h-4 mr-1" />
        Install
      </Button>
      <button onClick={() => setDismissed(true)} className="p-1 hover:bg-muted rounded-md shrink-0" data-testid="button-dismiss-install" aria-label="Dismiss">
        <X className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}
