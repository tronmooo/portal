// ── Scan a nutrition label or a barcode ──────────────────────────────────────
// Opened from the chat box. Three ways in: a photo of the Nutrition Facts
// panel, a photo of the barcode, or the barcode's digits typed in. Reading
// writes nothing (Rule 3): the dialog shows what was read — serving size,
// servings per container, every nutrient printed, % Daily Values — and the
// figures for the amount the user says they ate, worked out with the same
// functions the server uses (shared/nutrition-scan.ts). Only "Log it" writes,
// and it writes one entry. A nutrient the label does not print is shown as
// not stated, never as 0 (Nutrition rule N3).
import { useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { NUTRIENT_KEYS, NUTRIENT_LABELS, formatNutrient, netCarbsOf, type NutrientKey } from "@shared/nutrition-enrichment";
import { consumedFromScan, scaledScanValues, scanItemName, type ScannedLabel } from "@shared/nutrition-scan";

type Phase = "idle" | "reading" | "review" | "logging" | "error";
const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
/** What a standard panel carries: named as "not stated" when the label is silent. */
const PANEL: NutrientKey[] = ["calories", "fat", "saturatedFat", "carbs", "fiber", "sugar", "protein", "sodium"];

/** The picture as base64, shrunk to what a label needs so a phone photo uploads quickly. */
async function pictureData(file: File): Promise<{ data: string; mime: string }> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("The picture could not be read from this device."));
    r.readAsDataURL(file);
  });
  // Shrink where the browser can decode the picture; otherwise send it as it is.
  try {
    if (typeof createImageBitmap === "function") {
      const img = await createImageBitmap(file);
      const max = 1800;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      if (scale < 1 || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL("image/jpeg", 0.88);
          if (out.length > 100) return { data: out.split(",")[1], mime: "image/jpeg" };
        }
      }
    }
  } catch { /* send the original */ }
  return { data: raw.includes(",") ? raw.split(",")[1] : raw, mime: file.type || "image/jpeg" };
}

/** The browser's own barcode reader, where it has one (never required). */
async function detectBarcode(file: File): Promise<string | null> {
  try {
    const Detector = (window as any).BarcodeDetector;
    if (!Detector || typeof createImageBitmap !== "function") return null;
    const bitmap = await createImageBitmap(file);
    const found = await new Detector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] }).detect(bitmap);
    const code = String(found?.[0]?.rawValue || "").replace(/\D/g, "");
    return code.length >= 8 ? code : null;
  } catch { return null; }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try { const j = await res.json(); return String(j?.error || fallback); } catch { return fallback; }
}

export function NutritionScanDialog({ open, onClose, onLogged }: { open: boolean; onClose: () => void; onLogged?: (summary: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [label, setLabel] = useState<ScannedLabel | null>(null);
  const [quantity, setQuantity] = useState("");
  const [meal, setMeal] = useState<string>("");
  const [code, setCode] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const lastTry = useRef<(() => void) | null>(null);

  const reset = () => { setPhase("idle"); setError(""); setLabel(null); setQuantity(""); setMeal(""); setCode(""); lastTry.current = null; };
  const close = () => { reset(); onClose(); };
  const fail = (message: string) => { setError(message); setPhase("error"); };

  const lookup = async (digits: string) => {
    const clean = digits.replace(/\D/g, "");
    lastTry.current = () => { void lookup(clean); };
    if (clean.length < 8) return fail("Enter the digits printed under the barcode (8, 12, 13 or 14 of them).");
    setPhase("reading");
    try {
      const res = await fetchBarcode(clean);
      if (!res.ok) return fail(await errorText(res, "That barcode could not be looked up."));
      const body = await res.json();
      if (!body?.label) return fail("No product database has that barcode. Take a photo of the nutrition label instead.");
      setLabel(body.label); setPhase("review");
    } catch (e: any) { fail(e?.message || "The lookup failed. Nothing was logged."); }
  };

  const scan = async (file: File | undefined | null) => {
    if (!file) return;
    lastTry.current = () => { void scan(file); };
    setPhase("reading");
    try {
      const local = await detectBarcode(file);
      if (local) { await lookup(local); return; }
      const { data, mime } = await pictureData(file);
      const res = await apiRequest("POST", "/api/nutrition/scan-label", { fileData: data, mimeType: mime });
      const body = await res.json();
      if (body?.kind === "label" && body.label) { setLabel(body.label); setPhase("review"); return; }
      if (body?.kind === "barcode") {
        if (body.label) { setLabel(body.label); setPhase("review"); return; }
        return fail(`I read the barcode ${body.barcode}, but no product database has it. Take a photo of the nutrition label instead.`);
      }
      fail(`That picture doesn't show a nutrition label or a barcode${body?.reason ? ` (${body.reason})` : ""}. Try again with the label filling the frame.`);
    } catch (e: any) { fail(String(e?.message || "The picture could not be read. Nothing was logged.").replace(/^\d{3}:\s*/, "")); }
  };

  const eaten = useMemo(() => (label ? consumedFromScan(label, quantity) : null), [label, quantity]);
  const values = useMemo(() => (label && eaten ? scaledScanValues(label, eaten.servings) : {}), [label, eaten]);
  const printed = label ? NUTRIENT_KEYS.filter((k) => label.perServing[k] != null) : [];
  const notStated = label ? PANEL.filter((k) => label.perServing[k] == null) : [];
  const net = netCarbsOf(values);

  const log = async () => {
    if (!label) return;
    setPhase("logging");
    try {
      const res = await apiRequest("POST", "/api/nutrition/log-scan", { label, quantity, ...(meal ? { mealType: meal } : {}) });
      const body = await res.json();
      const summary = String(body?.recap || `${scanItemName(label)}: ${formatNutrient("calories", Number(body?.values?.calories ?? values.calories ?? 0))}`);
      onLogged?.(`Logged ${summary}`);
      close();
    } catch (e: any) {
      setError(String(e?.message || "The entry could not be saved.").replace(/^\d{3}:\s*/, ""));
      setPhase("review");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" data-testid="nutrition-scan-dialog">
        <DialogHeader>
          <DialogTitle>Scan a nutrition label</DialogTitle>
          <DialogDescription>
            Photograph the Nutrition Facts panel or the barcode. You'll see what was read before anything is logged.
          </DialogDescription>
        </DialogHeader>

        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" data-testid="scan-input-camera"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void scan(f); }} />
        <input ref={libraryRef} type="file" accept="image/*" className="hidden" data-testid="scan-input-library"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void scan(f); }} />

        {(phase === "idle" || phase === "error") && (
          <div className="space-y-3">
            {phase === "error" && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm" role="alert" data-testid="scan-error">
                {error}
                {lastTry.current && (
                  <Button size="sm" variant="ghost" className="ml-2 h-7 text-xs" onClick={() => lastTry.current?.()} data-testid="scan-retry">Try again</Button>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => cameraRef.current?.click()} data-testid="scan-take-photo">Take a photo</Button>
              <Button variant="secondary" onClick={() => libraryRef.current?.click()} data-testid="scan-choose-photo">Choose a photo</Button>
            </div>
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void lookup(code); }}>
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="Or type the barcode number" aria-label="Barcode number" data-testid="scan-barcode-input" />
              <Button type="submit" variant="outline" disabled={code.replace(/\D/g, "").length < 8} data-testid="scan-barcode-lookup">Look up</Button>
            </form>
          </div>
        )}

        {phase === "reading" && <p className="py-6 text-center text-sm text-muted-foreground" data-testid="scan-reading">Reading…</p>}

        {(phase === "review" || phase === "logging") && label && eaten && (
          <div className="space-y-3 text-sm" data-testid="scan-review">
            <div>
              <Input value={label.productName || ""} placeholder="Name this food" aria-label="Food name" data-testid="scan-name"
                onChange={(e) => setLabel({ ...label, productName: e.target.value })} />
              <div className="mt-1 text-xs text-muted-foreground">
                {label.brand ? `${label.brand} · ` : ""}Serving {label.serving.text}
                {label.servingsPerContainer ? ` · ${label.servingsPerContainer} servings per container` : ""}
              </div>
              <div className="text-xs text-muted-foreground" data-testid="scan-source">
                Source: {label.origin === "photo" ? "the label in your photo" : `${label.sourceName || "product database"} (barcode ${label.barcode || ""})`}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium" htmlFor="scan-quantity">How much did you eat?</label>
              <Input id="scan-quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="2 servings · 40 g · half the bag" data-testid="scan-quantity" />
              <div className="mt-1 text-xs text-muted-foreground" data-testid="scan-method">
                {eaten.assumed ? "No amount given: " : ""}{eaten.method}
              </div>
            </div>

            <table className="w-full text-xs" data-testid="scan-table">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Nutrient</th>
                  <th className="py-1 font-medium text-right">Per serving</th>
                  <th className="py-1 font-medium text-right">You ate</th>
                  <th className="py-1 font-medium text-right">% DV</th>
                </tr>
              </thead>
              <tbody>
                {printed.map((k) => (
                  <tr key={k} className="border-t border-border/50" data-testid={`scan-row-${k}`}>
                    <td className="py-1">{NUTRIENT_LABELS[k]}</td>
                    <td className="py-1 text-right text-muted-foreground">{formatNutrient(k, label.perServing[k]!)}</td>
                    <td className="py-1 text-right font-medium">{formatNutrient(k, values[k] ?? 0)}</td>
                    <td className="py-1 text-right text-muted-foreground">{label.dailyValues?.[k] != null ? `${Math.round(label.dailyValues[k]! * eaten.servings)}%` : ""}</td>
                  </tr>
                ))}
                {net != null && (
                  <tr className="border-t border-border/50" data-testid="scan-row-net-carbs">
                    <td className="py-1">Net carbs</td><td /><td className="py-1 text-right font-medium">{formatNutrient("carbs", net)}</td><td />
                  </tr>
                )}
              </tbody>
            </table>
            {notStated.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="scan-not-stated">
                Not on this label (left unknown, not counted as 0): {notStated.map((k) => NUTRIENT_LABELS[k].toLowerCase()).join(", ")}
              </p>
            )}

            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Meal">
              {MEALS.map((m) => (
                <button key={m} type="button" onClick={() => setMeal(meal === m ? "" : m)} aria-pressed={meal === m} data-testid={`scan-meal-${m}`}
                  className={`h-7 rounded-full border px-2.5 text-xs capitalize ${meal === m ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}>
                  {m}
                </button>
              ))}
            </div>

            {error && phase === "review" && <div className="text-xs text-destructive" role="alert" data-testid="scan-log-error">{error}</div>}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={reset} disabled={phase === "logging"} data-testid="scan-again">Scan another</Button>
              <Button onClick={() => void log()} disabled={phase === "logging"} data-testid="scan-log">{phase === "logging" ? "Logging…" : "Log it"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** GET through apiRequest so a failure is a thrown error with the server's message, never an empty result (Rule 7). */
async function fetchBarcode(code: string): Promise<Response> {
  try {
    return await apiRequest("GET", `/api/nutrition/barcode/${encodeURIComponent(code)}`);
  } catch (e: any) {
    const message = String(e?.message || "");
    const body = message.replace(/^\d{3}:\s*/, "");
    let text = body;
    try { text = String(JSON.parse(body)?.error || body); } catch { /* plain text */ }
    throw new Error(text || "That barcode could not be looked up.");
  }
}
