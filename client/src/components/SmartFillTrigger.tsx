/**
 * SmartFillTrigger — reusable "Smart Fill PDF" button.
 *
 * Renders a button. On click, opens a hidden file picker for PDFs.
 * When a PDF is chosen, opens SmartFillDialog with the file pre-loaded.
 *
 * Used by:
 *  - Documents (Artifacts) page header
 *  - Profile detail (Documents tab)
 *  - Asset detail (Documents tab)
 *  - Liability detail (Documents tab)
 *
 * Optional `preselectedSources` pre-checks the current entity in the source picker.
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { SmartFillDialog, type SmartFillSource } from "./SmartFillDialog";
import { useToast } from "@/hooks/use-toast";

interface Props {
  preselectedSources?: SmartFillSource[];
  label?: string;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
  iconOnly?: boolean;
  testId?: string;
}

export function SmartFillTrigger({
  preselectedSources,
  label = "Smart Fill PDF",
  size = "sm",
  variant = "outline",
  className,
  iconOnly,
  testId = "button-smart-fill-trigger",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [file, setFile] = useState<{ name: string; mimeType: string; base64: string } | null>(null);

  const onPick = () => inputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-pick same file
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      toast({ title: "PDF only", description: "Smart Fill only works with PDF files.", variant: "destructive" });
      return;
    }
    const MAX = 10 * 1024 * 1024;
    if (f.size > MAX) {
      toast({ title: "File too large", description: "Maximum 10 MB.", variant: "destructive" });
      return;
    }
    const base64 = await fileToBase64(f);
    setFile({ name: f.name, mimeType: "application/pdf", base64 });
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
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
      <SmartFillDialog
        open={!!file}
        onOpenChange={(o) => { if (!o) setFile(null); }}
        file={file}
        preselectedSources={preselectedSources}
      />
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
