// client/src/components/chat/CopyButton.tsx
//
// Copy-to-clipboard, with the "Copied" acknowledgement that makes it obvious
// the click did something. Lifted out of chat.tsx unchanged when the extraction
// review pane moved to its own module — both files need it, and a shared button
// is better than two.

import { useState } from "react";
import { Copy, Check, X } from "lucide-react";
import { copyText } from "@/lib/clipboard";

export function CopyButton({
  value,
  label = "Copy",
  className = "",
  iconOnly = false,
}: {
  value: string | (() => string);
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = typeof value === "function" ? value() : value;
    if (!text) return;
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1500);
  };
  const copied = state === "copied";
  const status = copied ? "Copied" : state === "failed" ? "Couldn't copy" : label;
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors ${iconOnly ? "p-1" : "px-1.5 py-0.5"} ${className}`}
      aria-label={label}
      title={status}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : state === "failed" ? <X className="h-3 w-3 text-destructive" /> : <Copy className="h-3 w-3" />}
      {!iconOnly && <span>{status}</span>}
    </button>
  );
}
