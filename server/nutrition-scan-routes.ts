// Routes for scanning a nutrition label, looking a product up by barcode, and
// logging the result. Scan and barcode lookup are reads (they return what the
// label says and write nothing — listed in READONLY_POST_PATHS); only
// /api/nutrition/log-scan writes, and only the one entry the user asked for.
import type { Express, Request, Response } from "express";
import { storage } from "./storage";

// Loaded on first use, like the rest of the AI stack (script/build-vercel.ts).
const scan = () => import("./nutrition-label-scan");

export const NUTRITION_SCAN_READ_PATHS = ["/api/nutrition/scan-label"] as const;

type Limiter = (key: string, max: number) => boolean;
const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

export function registerNutritionScanRoutes(app: Express, rateLimit: Limiter): void {
  const uid = (req: Request) => (req as any).userId || req.ip || "anonymous";
  const fail = (res: Response, where: string, err: any) => {
    console.error(`[nutrition-scan] ${where}:`, err?.message || err);
    res.status(500).json({ error: err?.message && /could not be read/i.test(err.message) ? err.message : "That didn't work. Nothing was logged." });
  };

  // A photo of a nutrition label or a barcode → what it says. Writes nothing.
  app.post(NUTRITION_SCAN_READ_PATHS[0], async (req, res) => {
    if (rateLimit(`nutrition-scan:${uid(req)}`, 12)) return res.status(429).json({ error: "Too many scans. Please wait a moment." });
    const { fileData, mimeType } = req.body || {};
    if (!fileData || typeof fileData !== "string") return res.status(400).json({ error: "fileData (base64 image) required" });
    const mime = String(mimeType || "image/jpeg").toLowerCase();
    if (!IMAGE_MIMES.has(mime)) return res.status(400).json({ error: "The picture must be a JPEG, PNG or WebP image." });
    if (fileData.length > 14_000_000) return res.status(413).json({ error: "That picture is too large (10 MB at most)." });
    try {
      res.json(await (await scan()).scanNutritionLabel(fileData, mime === "image/jpg" ? "image/jpeg" : mime));
    } catch (err) { fail(res, "scan", err); }
  });

  // A typed or scanned barcode → the product's label, from the product databases. Writes nothing.
  app.get("/api/nutrition/barcode/:code", async (req, res) => {
    if (rateLimit(`nutrition-barcode:${uid(req)}`, 30)) return res.status(429).json({ error: "Too many lookups. Please wait a moment." });
    const code = String(req.params.code || "").replace(/\D/g, "");
    try {
      const { isValidGtin } = await import("./nutrition-sources");
      if (!isValidGtin(code)) return res.status(400).json({ error: "That is not a valid barcode number. Check the digits under the bars (8, 12, 13 or 14 of them)." });
      const label = await (await scan()).labelFromBarcode(code);
      if (!label) return res.status(404).json({ error: "No product database has that barcode. Scan the nutrition label instead.", barcode: code });
      res.json({ kind: "barcode", barcode: code, label });
    } catch (err) { fail(res, "barcode", err); }
  });

  // Which food sources this deployment can reach: says whether a key is set, never the key.
  app.get("/api/nutrition/sources", async (_req, res) => {
    const { fdcKey, FDC_KEY_NAMES } = await import("./nutrition-sources");
    res.json({
      usdaFoodDataCentral: fdcKey() ? "configured" : "shared demo key (10 requests an hour)",
      // Variable NAMES only (never a value), so a missing or misnamed key can be seen from outside.
      usdaKeyNamesAccepted: FDC_KEY_NAMES,
      usdaLikeVariablesPresent: Object.keys(process.env).filter((k) => /fdc|usda|fooddata|data_?gov/i.test(k)),
      vercelEnv: process.env.VERCEL_ENV || null,
      openFoodFacts: process.env.NUTRITION_LOOKUP_DISABLE === "1" ? "disabled" : "enabled",
      model: process.env.ANTHROPIC_API_KEY ? "configured" : "not configured",
    });
  });

  // Log a scanned label (or a barcode match) for the amount eaten.
  app.post("/api/nutrition/log-scan", async (req, res) => {
    if (rateLimit(`nutrition-log:${uid(req)}`, 30)) return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    const body = req.body || {};
    if (!body.label || typeof body.label !== "object") return res.status(400).json({ error: "label required" });
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
    try {
      let forProfile: string | undefined;
      const profileId = str(body.profileId, 80);
      if (profileId) forProfile = (await storage.getProfiles()).find((p) => p.id === profileId)?.name;
      const out = await (await scan()).logScannedLabel(storage, {
        label: body.label, quantity: str(body.quantity, 200), forProfile, at: str(body.at, 40), mealType: str(body.mealType, 20),
      });
      if ("error" in out) return res.status(400).json({ error: out.error });
      res.json({ entry: out.entry, trackerName: out.trackerName, consumption: out.consumption, values: out.values, recap: out.recap });
    } catch (err) { fail(res, "log", err); }
  });
}
