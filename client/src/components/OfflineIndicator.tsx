import { useState, useEffect } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { WifiOff, CloudUpload } from "lucide-react";

/**
 * The offline pill, and — new — an honest account of what is waiting.
 *
 * Writes used to be discarded the moment the network was gone: the mutation
 * hit fetch, failed, raised an error toast, and the expense or task went with
 * it. Mutations now pause while the browser reports no connection and run on
 * reconnect (see queryClient's mutations.networkMode), so there is real
 * pending work to tell the user about. Saying "you're offline" while silently
 * holding three unsaved things is the same omission in a smaller form.
 */
export function OfflineIndicator() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  // Mutations paused for the network, counted the way React Query counts them.
  const pending = useIsMutating({ predicate: (m) => m.state.isPaused });

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

  // Back online with work still draining: keep the pill up, but say what it is
  // doing rather than disappearing while saves are still in flight.
  if (!offline && pending === 0) return null;

  const label = offline
    ? pending > 0
      ? `Offline — ${pending} change${pending === 1 ? "" : "s"} will save when you're back`
      : "You're offline"
    : `Saving ${pending} change${pending === 1 ? "" : "s"}…`;

  return (
    <div
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-full shadow-lg text-sm font-medium animate-in slide-in-from-bottom-2 ${
        offline ? "bg-destructive text-destructive-foreground" : "bg-foreground text-background"
      }`}
      role="status"
      aria-live="polite"
      data-testid="offline-indicator"
    >
      {offline ? <WifiOff className="w-4 h-4" /> : <CloudUpload className="w-4 h-4" />}
      {label}
    </div>
  );
}
