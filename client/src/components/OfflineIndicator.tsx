import { useState, useEffect } from "react";
import { WifiOff } from "lucide-react";

export function OfflineIndicator() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 bg-destructive text-destructive-foreground rounded-full shadow-lg text-sm font-medium animate-in slide-in-from-bottom-2" data-testid="offline-indicator">
      <WifiOff className="w-4 h-4" />
      You're offline
    </div>
  );
}
