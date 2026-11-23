// Fill In workspace (owner request 2026-11-22): drop or pick a form and fill
// it from saved information. Full screen; the X goes back to AI Chat.
//
// The filling itself is Smart Fill: it reads the form, shows every field with
// where its value came from and what is missing, and saves a filled copy only
// when the user confirms. Nothing is submitted anywhere.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { WorkspaceShell, leaveWorkspace } from "@/components/workspace/WorkspaceShell";

const SmartFillDialog = lazy(() => import("@/components/SmartFillDialog").then((m) => ({ default: m.SmartFillDialog })));

export const FILL_MAX_BYTES = 10 * 1024 * 1024;
/** What Smart Fill can read today: a PDF, or a photo / scan of a form. */
export function isFillableFile(file: { type: string; name: string }): boolean {
  return file.type === "application/pdf" || file.type.startsWith("image/") || /\.pdf$/i.test(file.name);
}

type Picked = { name: string; mimeType: string; base64: string };

export default function FillWorkspacePage() {
  useEffect(() => { document.title = "Fill In — Portol"; }, []);
  const { toast } = useToast();
  const [file, setFile] = useState<Picked | null>(null);
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = (f: File | undefined) => {
    if (!f) return;
    if (!isFillableFile(f)) {
      toast({ title: "That file can't be filled in yet", description: "Fill In reads PDF forms and photos or scans of forms. Word documents and spreadsheets are not supported yet.", variant: "destructive" });
      return;
    }
    if (f.size > FILL_MAX_BYTES) {
      toast({ title: "File too large", description: "Fill In takes files up to 10 MB.", variant: "destructive" });
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onerror = () => { setReading(false); toast({ title: "Couldn't read that file", variant: "destructive" }); };
    reader.onload = () => {
      const data = String(reader.result || "");
      setReading(false);
      setFile({ name: f.name, mimeType: f.type || "application/pdf", base64: data.includes(",") ? data.split(",").pop() || "" : data });
    };
    reader.readAsDataURL(f);
  };

  return (
    <WorkspaceShell
      kind="fill"
      title={<span className="text-base font-semibold truncate block">{file ? file.name : "Fill in a form"}</span>}
      actions={file ? (
        <button type="button" onClick={() => setFile(null)} className="h-9 px-2.5 rounded-md border border-border text-xs" data-testid="button-fill-another">
          Choose another form
        </button>
      ) : undefined}
      onClose={() => leaveWorkspace()}
    >
      {/* The drop zone gives way to the review once a form is open. */}
      <div
        className={file ? "hidden" : "flex-1 min-h-0 flex items-center justify-center p-4"}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files?.[0]); }}
        data-testid="fill-drop-zone"
      >
        <div className={`w-full max-w-xl rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${over ? "border-primary bg-primary/10" : "border-border"}`}>
          {reading ? <Loader2 className="h-8 w-8 mx-auto animate-spin text-muted-foreground" /> : <FileUp className="h-8 w-8 mx-auto text-muted-foreground" />}
          <h2 className="mt-3 text-lg font-semibold">Drop a form here</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A PDF, or a photo or scan of a paper form. Portol reads the fields, fills what it can from the information you choose,
            and shows you every field — and what is missing — before anything is saved. It never guesses and never submits.
          </p>
          <button
            type="button"
            onClick={() => { if (inputRef.current) { inputRef.current.value = ""; inputRef.current.click(); } }}
            className="mt-5 h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold"
            data-testid="button-fill-choose"
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => take(e.target.files?.[0])}
            data-testid="input-fill-file"
          />
        </div>
      </div>
      {file && (
        <Suspense fallback={null}>
          <SmartFillDialog open onOpenChange={(o) => { if (!o) setFile(null); }} file={file} fullScreen />
        </Suspense>
      )}
    </WorkspaceShell>
  );
}
