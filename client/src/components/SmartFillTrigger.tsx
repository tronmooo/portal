/**
 * SmartFillTrigger — a "Fill a form" button for pages outside the workspace
 * (Documents, a profile's Documents tab).
 *
 * Picking a file hands it to the Fill In workspace and opens it there: there
 * is one place a form is filled (pages/workspace-fill.tsx), and it uses
 * everything on file, so `preselectedSources` is accepted for the existing
 * call sites but no longer narrows anything.
 */
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { hashNavigate } from "@/lib/hashNavigate";
import { setPendingFillFile } from "@/lib/fill-handoff";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface Props {
  preselectedSources?: Array<{ id: string; kind: string; name: string }>;
  label?: string;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
  iconOnly?: boolean;
  testId?: string;
}

export function SmartFillTrigger({
  label = "Fill a form",
  size = "sm",
  variant = "outline",
  className,
  iconOnly,
  testId = "button-smart-fill-trigger",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const onPick = () => inputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-pick same file
    if (!f) return;
    const ok = f.type === "application/pdf" || f.type.startsWith("image/") || f.type === DOCX_MIME || /\.(pdf|docx)$/i.test(f.name);
    if (!ok) {
      toast({ title: "That file can't be filled in", description: "Fill In takes PDF forms, Word (.docx) forms, and photos or screenshots of a form.", variant: "destructive" });
      return;
    }
    const MAX = 10 * 1024 * 1024;
    if (f.size > MAX) {
      toast({ title: "File too large", description: "Maximum 10 MB.", variant: "destructive" });
      return;
    }
    const base64 = await fileToBase64(f);
    setPendingFillFile({ name: f.name, mimeType: f.type || (/\.docx$/i.test(f.name) ? DOCX_MIME : "application/pdf"), base64 });
    hashNavigate("/workspace/fill");
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf,.docx,image/*"
        onChange={onFileChange}
        className="hidden"
        data-testid={`${testId}-input`}
      />
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        onClick={onPick}
        data-testid={testId}
      >
        <Sparkles className={iconOnly ? "h-4 w-4" : "h-4 w-4 mr-1.5"} />
        {!iconOnly && label}
      </Button>
    </>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
