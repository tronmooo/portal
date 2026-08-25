// client/src/components/chat/CopyButton.tsx
//
// Copy-to-clipboard, with the "Copied" acknowledgement that makes it obvious
// the click did something. Lifted out of chat.tsx unchanged when the extraction
// review pane moved to its own module — both files need it, and a shared button
// is better than two.

import { useState } from "react";
import { Copy, Check } from "lucide-react";

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
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = typeof value === "function" ? value() : value;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors ${iconOnly ? "p-1" : "px-1.5 py-0.5"} ${className}`}
      aria-label={label}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {!iconOnly && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}
