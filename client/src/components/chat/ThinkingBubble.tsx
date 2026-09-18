// The assistant's placeholder while a turn runs (QA 2026-09-18 F-46): a real
// bubble in the thread, with the running tool's name or a phase that moves
// with the clock, and the elapsed time once it stops being instant. Mounts at
// send, unmounts when the reply lands, so its own mount time is the turn's
// start. The label rule lives in shared/chat-progress.
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { chatProgressLabel, elapsedBadge } from "@shared/chat-progress";

export function ThinkingBubble({ runningTools, uploading }: {
  runningTools: ReadonlyArray<{ tool: string; label?: string }>;
  uploading: boolean;
}) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedMs = now - startedAt;
  const label = chatProgressLabel({ elapsedMs, runningTools, uploading });
  const badge = elapsedBadge(elapsedMs);
  const labelTestId = runningTools.length > 0 ? "live-tool-indicator"
    : uploading ? "upload-progress-indicator" : "chat-thinking-label";
  return (
    <div className="message-in flex justify-start" data-testid="chat-thinking" role="status" aria-live="polite">
      <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-card border border-border">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Bot className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-primary">Portol</span>
          {badge && (
            <span className="ml-auto pl-3 text-xs text-muted-foreground/70 tabular-nums" data-testid="chat-thinking-elapsed">
              {badge}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" aria-hidden="true">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm text-muted-foreground truncate max-w-[280px]" data-testid={labelTestId}>{label}</span>
        </div>
      </div>
    </div>
  );
}
