import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { processMessage, processFileUpload, getActionLog } from "./ai-engine";
import Anthropic from "@anthropic-ai/sdk";
import {
  insertProfileSchema,
  insertTrackerSchema,
  insertTrackerEntrySchema,
  insertTaskSchema,
  insertExpenseSchema,
  insertEventSchema,
  insertHabitSchema,
  insertObligationSchema,
  insertArtifactSchema,
  insertJournalEntrySchema,
  insertMemorySchema,
  insertDomainSchema,
  insertGoalSchema,
  insertEntityLinkSchema,
} from "@shared/schema";
import type { ParsedAction } from "@shared/schema";
import { generateSmartInsights } from "./insights-engine";

// Simple rate limiter
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, maxRequests: number = 60, windowMs: number = 60000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return false; // not rate limited
  }
  entry.count++;
  if (entry.count > maxRequests) return true; // rate limited
  return false;
}
// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 300000);

// Simple response cache for expensive endpoints (10s TTL)
const responseCache = new Map<string, { data: any; expiresAt: number }>();
function getCached(key: string): any | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  return null;
}
function setCache(key: string, data: any, ttlMs: number = 10000): void {
  responseCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}
function bustCache(prefix: string): void {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}
// Bust relevant caches after any write operation
function bustAllCaches(): void {
  responseCache.clear();
}

// Input sanitizer — encode HTML entities instead of stripping (preserves content like emails, math)
function sanitize(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
    .slice(0, 10000);
}

// Date validation helper
function isValidDateStr(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());
}

// Wrap async route handlers to catch unhandled errors and send 500 instead of crashing
type AsyncHandler = (req: any, res: any, next?: any) => Promise<any>;
function asyncHandler(fn: AsyncHandler): AsyncHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err: any) {
      console.error(`[API Error] ${req.method} ${req.path}:`, err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || "Internal server error" });
      }
    }
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Bust response cache on any write operation
  app.use("/api", (req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      bustAllCaches();
    }
    next();
  });

  // ---- Chat / AI ----
  app.post("/api/chat", asyncHandler(async (req, res) => {
    const userId = (req as any).userId || req.ip || 'anonymous';
    if (rateLimit(`chat:${userId}`, 20)) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    }
    try {
      const { message, history } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message required" });
      }
      const result = await processMessage(sanitize(message), Array.isArray(history) ? history : undefined);
      res.json(result);
    } catch (err: any) {
      console.error("Chat error:", err);
      res.status(500).json({ error: "Failed to process message" });
    }
  }));

  // ---- Activity Feed ----
  app.get("/api/activity", asyncHandler(async (_req, res) => {
    const count = 10;
    res.json(getActionLog(count));
  }));

  // ---- File Upload + AI Extraction ----
  app.post("/api/upload", asyncHandler(async (req, res) => {
    const uploadUserId = (req as any).userId || req.ip || 'anonymous';
    if (rateLimit(`upload:${uploadUserId}`, 10)) {
      return res.status(429).json({ error: "Too many uploads. Please wait." });
    }
    try {
      const { fileName, mimeType, fileData, message, profileId } = req.body;
      if (!fileData || !fileName) {
        return res.status(400).json({ error: "fileName and fileData (base64) required" });
      }
      // File size validation: 10MB max (base64 is ~33% larger than binary)
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
      const fileSizeBytes = Math.ceil((fileData.length * 3) / 4);
      if (fileSizeBytes > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `File too large (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.` });
      }
      // MIME type validation
      const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
      const safeMime = ALLOWED_MIMES.includes(mimeType) ? mimeType : 'application/octet-stream';
      const result = await processFileUpload(fileName, safeMime, fileData, message, profileId);
      res.json(result);
    } catch (err: any) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Failed to process upload" });
    }
  }));

  // ---- Batch File Upload + AI Extraction ----
  app.post("/api/upload/batch", asyncHandler(async (req, res) => {
    const batchUserId = (req as any).userId || req.ip || 'anonymous';
    if (rateLimit(`upload:${batchUserId}`, 10)) {
      return res.status(429).json({ error: "Too many uploads. Please wait." });
    }
    try {
      const { files, message } = req.body;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "files array required" });
      }
      if (files.length > 20) {
        return res.status(400).json({ error: "Maximum 20 files per batch" });
      }

      const allProfiles = await storage.getProfiles();
      const profileNameMap = new Map(allProfiles.map(p => [p.id, p.name]));

      const results: Array<{
        fileName: string;
        reply: string;
        actions: ParsedAction[];
        results: any[];
        documentId?: string;
        documentPreview?: { id: string; name: string; mimeType: string; data: string };
        suggestedProfile?: { id: string; name: string } | null;
        documentType?: string;
        pendingExtraction?: any;
      }> = [];

      const linkedCounts: Record<string, number> = {};
      let unlinkedCount = 0;

      // Process files sequentially to avoid overloading the AI API
      for (const file of files) {
        const { fileName, mimeType, fileData, profileId } = file;
        if (!fileName || !fileData) {
          results.push({ fileName: fileName || "unknown", reply: "Skipped — missing fileName or fileData", actions: [], results: [] });
          continue;
        }
        // File size validation per file: 10MB max
        const fileSizeBytes = Math.ceil((fileData.length * 3) / 4);
        if (fileSizeBytes > 10 * 1024 * 1024) {
          results.push({ fileName, reply: `Skipped — file too large (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB, max 10MB)`, actions: [], results: [] });
          continue;
        }

        try {
          const result = await processFileUpload(
            fileName,
            mimeType || "image/jpeg",
            fileData,
            message,
            profileId !== "none" ? profileId : undefined
          );

          // Determine which profile it was linked to
          let suggestedProfile: { id: string; name: string } | null = null;
          // Check the actions for create_profile or update_profile to find the linked profile
          for (const action of result.actions) {
            if (action.type === "update_profile" || action.type === "create_profile") {
              const profileName = action.data?.name;
              if (profileName) {
                // Find the profile by name
                const matchedProfile = allProfiles.find(
                  p => p.name.toLowerCase() === profileName.toLowerCase()
                );
                if (matchedProfile) {
                  suggestedProfile = { id: matchedProfile.id, name: matchedProfile.name };
                }
              }
            }
          }

          // Also check reply text for "Linked to profile: XYZ"
          if (!suggestedProfile) {
            const linkedMatch = result.reply.match(/Linked to profile:\s*(.+?)(?:\n|$)/);
            if (linkedMatch) {
              const pName = linkedMatch[1].trim();
              const matchedProfile = allProfiles.find(
                p => p.name.toLowerCase() === pName.toLowerCase()
              ) || (await storage.getProfiles()).find(
                p => p.name.toLowerCase() === pName.toLowerCase()
              );
              if (matchedProfile) {
                suggestedProfile = { id: matchedProfile.id, name: matchedProfile.name };
              }
            }
          }

          // Also check explicit profileId
          if (!suggestedProfile && profileId && profileId !== "none") {
            const pName = profileNameMap.get(profileId);
            if (pName) {
              suggestedProfile = { id: profileId, name: pName };
            }
          }

          if (suggestedProfile) {
            linkedCounts[suggestedProfile.name] = (linkedCounts[suggestedProfile.name] || 0) + 1;
          } else {
            unlinkedCount++;
          }

          results.push({
            fileName,
            reply: result.reply,
            actions: result.actions,
            results: result.results,
            documentId: result.documentId,
            documentPreview: result.documentPreview,
            suggestedProfile,
            documentType: undefined, // populated from reply context
            pendingExtraction: result.pendingExtraction,
          });
        } catch (fileErr: any) {
          console.error(`Batch upload error for ${fileName}:`, fileErr.message);
          results.push({
            fileName,
            reply: `Failed to process "${fileName}": ${fileErr.message}`,
            actions: [],
            results: [],
          });
          unlinkedCount++;
        }
      }

      // Build summary
      const linkedParts = Object.entries(linkedCounts).map(
        ([name, count]) => `${count} linked to ${name}`
      );
      const parts = [...linkedParts];
      if (unlinkedCount > 0) parts.push(`${unlinkedCount} unlinked`);
      const summary = `Processed ${results.length} document${results.length !== 1 ? "s" : ""}: ${parts.length > 0 ? parts.join(", ") : "all processed"}`;

      res.json({ results, summary });
    } catch (err: any) {
      console.error("Batch upload error:", err);
      res.status(500).json({ error: "Failed to process batch upload" });
    }
  }));

  // ---- Confirm Extraction (two-phase: user approves fields before saving) ----
  app.post("/api/chat/confirm-extraction", asyncHandler(async (req, res) => {
    try {
      const { extractionId, confirmedFields, targetProfileId, createCalendarEvents, trackerEntries } = req.body;
      if (!extractionId) {
        return res.status(400).json({ error: "extractionId required" });
      }

      const saved: string[] = [];

      // 1. Update profile with confirmed fields
      if (targetProfileId && confirmedFields && confirmedFields.length > 0) {
        const profile = await storage.getProfile(targetProfileId);
        if (profile) {
          const fieldUpdates: Record<string, any> = {};
          for (const field of confirmedFields) {
            fieldUpdates[field.key] = field.value;
          }
          await storage.updateProfile(targetProfileId, {
            fields: { ...(profile.fields || {}), ...fieldUpdates },
          });
          saved.push(`Updated ${confirmedFields.length} fields on ${profile.name}`);
        }
      }

      // 2. Create calendar events for confirmed date fields
      if (createCalendarEvents && createCalendarEvents.length > 0) {
        for (const event of createCalendarEvents) {
          try {
            // Parse date from the field value
            let dateStr = event.date;
            if (!dateStr) continue;
            // Normalize date to YYYY-MM-DD
            const dateMatch = dateStr.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
            if (!dateMatch) {
              // Try MM/DD/YYYY format
              const altMatch = dateStr.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);
              if (altMatch) dateStr = `${altMatch[3]}-${altMatch[1]}-${altMatch[2]}`;
              else continue;
            } else {
              dateStr = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
            }
            await storage.createEvent({
              title: event.title || `📅 ${event.field}`,
              date: dateStr,
              time: undefined,
              endTime: undefined,
              description: `Auto-created from document extraction (${event.field})`,
              location: undefined,
              allDay: true,
              category: event.category || "other",
              recurrence: "none",
              recurrenceEnd: undefined,
              color: undefined,
              linkedProfiles: targetProfileId ? [targetProfileId] : [],
              linkedDocuments: [extractionId],
              tags: ["document-extraction"],
              source: "chat",
            });
            saved.push(`Created event: ${event.title || event.field}`);
          } catch (evErr: any) {
            console.error("Failed to create calendar event from extraction:", evErr.message);
          }
        }
      }

      // 3. Log tracker entries
      if (trackerEntries && trackerEntries.length > 0) {
        for (const entry of trackerEntries) {
          try {
            // Find or create the tracker
            const trackers = await storage.getTrackers();
            const humanName = (entry.trackerName || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
            let tracker = trackers.find(
              (t: any) => t.name.toLowerCase().replace(/[_\s]/g, "") === (entry.trackerName || "").toLowerCase().replace(/[_\s]/g, "")
            );
            if (!tracker) {
              const fieldKeys = Object.keys(entry.values || {});
              tracker = await storage.createTracker({
                name: humanName,
                unit: entry.unit || "",
                category: entry.category || "health",
                fields: fieldKeys.length > 0
                  ? fieldKeys.map((k: string, i: number) => ({
                      name: k,
                      type: "number" as const,
                      unit: entry.unit || "",
                      isPrimary: i === 0,
                      options: [],
                    }))
                  : [{ name: "value", type: "number" as const, unit: entry.unit || "", isPrimary: true, options: [] }],
              });
              // Link tracker to profile if specified
              if (targetProfileId && tracker) {
                try {
                  await storage.updateTracker(tracker.id, { linkedProfiles: [targetProfileId] } as any);
                } catch { /* non-critical */ }
              }
              saved.push(`Created tracker: ${humanName}`);
            }
            // Log the entry with proper values object
            const entryValues = entry.values && typeof entry.values === "object" ? entry.values : { value: entry.values || 0 };
            await storage.logEntry({
              trackerId: tracker.id,
              values: entryValues,
              notes: `From document extraction`,
            });
            saved.push(`Logged ${humanName}: ${Object.entries(entryValues).map(([k, v]) => `${k}=${v}`).join(", ")}`);
          } catch (tErr: any) {
            console.error("Failed to log tracker entry from extraction:", tErr.message);
          }
        }
      }

      res.json({
        success: true,
        message: saved.length > 0
          ? `Confirmed: ${saved.join("; ")}`
          : "No fields to save",
        saved,
      });
    } catch (err: any) {
      console.error("Confirm extraction error:", err);
      res.status(500).json({ error: "Failed to confirm extraction" });
    }
  }));

  // ---- Dashboard ----
  app.get("/api/stats", asyncHandler(async (req, res) => {
    const profileId = req.query.profileId as string | undefined;
    const userId = (req as any).userId || "anon";
    const cacheKey = `stats:${userId}:${profileId || 'all'}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const stats = await storage.getStats(profileId);
    setCache(cacheKey, stats, 15000);
    res.json(stats);
  }));

  app.get("/api/dashboard-enhanced", asyncHandler(async (req, res) => {
    const profileId = req.query.profileId as string | undefined;
    const data = await storage.getDashboardEnhanced(profileId);
    res.json(data);
  }));

  // ---- Insights ----
  app.get("/api/insights", asyncHandler(async (_req, res) => {
    try {
      const [profiles, trackers, tasks, expenses, habits, obligations, journal, documents, goals, events] = await Promise.all([
        storage.getProfiles(),
        storage.getTrackers(),
        storage.getTasks(),
        storage.getExpenses(),
        storage.getHabits(),
        storage.getObligations(),
        storage.getJournalEntries(),
        storage.getDocuments(),
        storage.getGoals(),
        storage.getEvents(),
      ]);
      const insights = generateSmartInsights({
        profiles, trackers, tasks, expenses, habits, obligations, journal, documents, goals, events,
      });
      res.json(insights);
    } catch (err: any) {
      console.error("Insights error:", err);
      res.status(500).json({ error: "Failed to generate insights" });
    }
  }));

  // ---- Calendar Status ----
  app.get("/api/calendar/status", asyncHandler(async (_req, res) => {
    try {
      const lastSync = await storage.getPreference("gcal_last_sync");
      const events = await storage.getEvents();
      const gcalEvents = events.filter((e: any) => e.tags?.includes("google-calendar"));
      res.json({
        connected: true,
        lastSync,
        importedCount: gcalEvents.length,
        totalEvents: events.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get calendar status" });
    }
  }));

  // ---- Profiles ----
  app.get("/api/profiles", asyncHandler(async (_req, res) => { res.json(await storage.getProfiles()); }));
  app.get("/api/profiles/:id", asyncHandler(async (req, res) => {
    const profile = await storage.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Not found" });
    res.json(profile);
  }));
  app.get("/api/profiles/:id/detail", asyncHandler(async (req, res) => {
    const cacheKey = `profile-detail:${req.params.id}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const detail = await storage.getProfileDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Not found" });
    setCache(cacheKey, detail, 10000);
    res.json(detail);
  }));
  app.post("/api/profiles", asyncHandler(async (req, res) => {
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Profile name is required" });
    }
    if (!req.body.type || typeof req.body.type !== "string" || !req.body.type.trim()) {
      return res.status(400).json({ error: "Profile type is required" });
    }
    req.body.name = sanitize(req.body.name);
    // Duplicate detection: warn if a profile with the same name and type exists
    const existing = await storage.getProfiles();
    const dup = existing.find(p => p.name.toLowerCase() === req.body.name.toLowerCase() && p.type === req.body.type);
    if (dup) {
      return res.status(409).json({ error: `A ${req.body.type} profile named "${dup.name}" already exists`, existingId: dup.id });
    }
    const parsed = insertProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createProfile(parsed.data));
  }));
  app.patch("/api/profiles/:id", asyncHandler(async (req, res) => {
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || req.body.name.trim() === "") {
        return res.status(400).json({ error: "Profile name must be a non-empty string" });
      }
      req.body.name = sanitize(req.body.name);
    }
    const updated = await storage.updateProfile(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/profiles/:id", asyncHandler(async (req, res) => {
    await storage.deleteProfile(req.params.id);
    res.status(204).send();
  }));

  // ---- Profile Link / Unlink ----
  app.post("/api/profiles/:id/link", asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.body;
    if (!entityType || !entityId) return res.status(400).json({ error: "entityType and entityId required" });
    // Verify profile exists
    const profile = await storage.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    try {
      await storage.linkProfileTo(req.params.id, entityType, entityId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Link failed" });
    }
  }));

  app.post("/api/profiles/:id/unlink", asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.body;
    await storage.unlinkProfileFrom(req.params.id, entityType, entityId);
    res.json({ ok: true });
  }));

  // ---- Profile AI Summary ----
  app.get("/api/profiles/:id/ai-summary", asyncHandler(async (req, res) => {
    try {
      const { id } = req.params;
      const force = req.query.force === "true";

      // Check cache first (2-hour TTL)
      const cacheKey = `profile_ai_${id}`;
      if (!force) {
        const cached = await storage.getPreference(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.generatedAt) {
              const age = Date.now() - new Date(parsed.generatedAt).getTime();
              if (age < 7200000) { // 2 hour TTL
                return res.json(parsed);
              }
            }
          } catch {}
        }
      }

      // Load the full profile detail
      const detail = await storage.getProfileDetail(id);
      if (!detail) return res.status(404).json({ error: "Profile not found" });

      // Build compact data snapshot for the profile
      const now = new Date();
      const profileData: Record<string, any> = {
        name: detail.name,
        type: detail.type,
        fields: detail.fields,
        tags: detail.tags,
        notes: detail.notes,
        documents: detail.relatedDocuments.map(d => ({
          name: d.name,
          type: d.type,
          extractedData: d.extractedData,
          createdAt: d.createdAt,
        })),
        expenses: detail.relatedExpenses.map(e => ({
          description: e.description,
          amount: e.amount,
          category: e.category,
          date: e.date,
        })),
        trackers: detail.relatedTrackers.map(t => ({
          name: t.name,
          category: t.category,
          unit: t.unit,
          entries: (t.entries || []).slice(-15).map(e => ({
            date: e.timestamp.slice(0, 10),
            values: e.values,
          })),
        })),
        tasks: detail.relatedTasks.map(t => ({
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
        })),
        events: detail.relatedEvents.map(e => ({
          title: e.title,
          date: e.date,
          category: e.category,
        })),
        obligations: detail.relatedObligations.map(o => ({
          name: o.name,
          amount: o.amount,
          frequency: o.frequency,
          nextDueDate: o.nextDueDate,
          autopay: o.autopay,
        })),
        timeline: detail.timeline.slice(-20).map(t => ({
          type: t.type,
          title: t.title,
          timestamp: t.timestamp,
        })),
      };

      // Type-specific prompt angles
      const typePrompts: Record<string, string> = {
        person: "Summarize this person's profile. Note recent interactions, linked documents, upcoming events, and any action items.",
        self: "Give a personal life overview: health trends, habits, mood, goals, upcoming obligations, and spending patterns.",
        pet: "Summarize this pet's health records, upcoming vaccinations, vet visits, spending, and any care items needing attention.",
        vehicle: "Summarize this vehicle's status: mileage, insurance, registration, loan, maintenance history, and upcoming service needs.",
        account: "Analyze this account: linked documents, recent activity, and any items needing attention.",
        subscription: "Analyze this subscription/account: cost, value, linked documents, payment history, and whether it's worth keeping.",
        asset: "Summarize this asset's value, maintenance needs, warranty status, documents, and expenses.",
        property: "Summarize this property's status: value, maintenance, documents, expenses, insurance, and upcoming obligations.",
        loan: "Analyze this loan: balance, payments, interest, payoff timeline, and linked documents.",
        investment: "Analyze this investment: performance, value, linked documents, and any action items.",
        medical: "Summarize this medical profile: conditions, medications, appointments, documents, and upcoming care needs.",
      };

      const typePrompt = typePrompts[detail.type] || "Summarize this profile's key information, linked entities, and any action items.";

      const systemPrompt = `You are the AI engine for Portol, a personal life management app. You analyze profile data to produce a concise, actionable summary.

Rules:
- Be specific with numbers and dates. Say "Last vet visit was 8 months ago" not "It's been a while."
- Identify action items: things the user should do (renew insurance, schedule appointment, etc.)
- Highlight key metrics as structured data.
- If data is sparse, still provide useful insights from what's available.
- Return ONLY valid JSON matching the exact schema below. No markdown, no code fences.

JSON Schema:
{
  "summary": "string — 2-3 sentence natural language overview of this profile",
  "actionItems": ["string — specific actionable thing to do"],
  "highlights": [
    {
      "label": "string — metric label like 'Total Spent' or 'Last Visit'",
      "value": "string — the value like '$1,240' or '3 months ago'",
      "trend": "up | down | stable — optional, include only if a trend is clear"
    }
  ]
}

Generate 0-5 action items (only real, actionable ones). Generate 2-4 highlights with key metrics. The summary should be personalized and specific to the data.`;

      const userPrompt = `${typePrompt}\n\nProfile data:\n${JSON.stringify(profileData, null, 1)}`;

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [
          { role: "user", content: userPrompt },
        ],
        system: systemPrompt,
      });

      // Extract text from response
      const textBlock = response.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from Claude");
      }

      // Parse JSON response - strip any markdown code fences if present
      let jsonStr = textBlock.text.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      const aiData = JSON.parse(jsonStr);

      const result = {
        summary: aiData.summary || "No summary available.",
        actionItems: Array.isArray(aiData.actionItems) ? aiData.actionItems : [],
        highlights: Array.isArray(aiData.highlights) ? aiData.highlights : [],
        generatedAt: now.toISOString(),
      };

      // Cache the result
      await storage.setPreference(cacheKey, JSON.stringify(result));

      res.json(result);
    } catch (err: any) {
      console.error("Profile AI Summary error:", err);
      res.status(500).json({ error: "Failed to generate AI summary" });
    }
  }));

  // ---- Trackers ----
  app.get("/api/trackers", asyncHandler(async (_req, res) => { res.json(await storage.getTrackers()); }));
  app.get("/api/trackers/:id", asyncHandler(async (req, res) => {
    const tracker = await storage.getTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: "Not found" });
    res.json(tracker);
  }));
  app.post("/api/trackers", asyncHandler(async (req, res) => {
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Tracker name is required" });
    }
    req.body.name = sanitize(req.body.name);
    const parsed = insertTrackerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createTracker(parsed.data));
  }));
  app.patch("/api/trackers/:id", asyncHandler(async (req, res) => {
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || req.body.name.trim() === "") {
        return res.status(400).json({ error: "Tracker name must be a non-empty string" });
      }
      req.body.name = sanitize(req.body.name);
    }
    const updated = await storage.updateTracker(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.post("/api/trackers/:id/entries", asyncHandler(async (req, res) => {
    const { values } = req.body;
    if (!values || typeof values !== "object") {
      return res.status(400).json({ error: "Values required" });
    }
    // Reject entries where all meaningful values are empty/null/undefined
    const meaningfulKeys = Object.keys(values).filter(k => k !== '_notes' && k !== 'notes' && k !== 'timestamp');
    const hasAtLeastOneValue = meaningfulKeys.some(k => {
      const v = values[k];
      return v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && isNaN(v));
    });
    if (meaningfulKeys.length > 0 && !hasAtLeastOneValue) {
      return res.status(400).json({ error: "At least one value is required. Cannot log an empty entry." });
    }
    if (Object.values(values).some((v: any) => typeof v === "number" && v < 0)) {
      return res.status(400).json({ error: "Values must not be negative" });
    }
    if (Object.values(values).some((v: any) => typeof v === "number" && isNaN(v))) {
      return res.status(400).json({ error: "All values must be valid numbers" });
    }
    // Sanity bounds — reject obviously impossible values
    const numericVals = Object.entries(values).filter(([, v]) => typeof v === 'number') as [string, number][];
    for (const [key, val] of numericVals) {
      if (key === '_notes') continue;
      // Weight (human): max 1000 lbs
      if (key === 'weight' && val > 1000) return res.status(400).json({ error: `Weight ${val} lbs is unrealistic. Max: 1000 lbs.` });
      // Weight (pet): max 500 lbs
      if (key === 'weight' && val > 500 && req.body.trackerId) {
        // Check if this is a pet tracker by name
        const tracker = await storage.getTracker(req.params.id);
        if (tracker && tracker.name.toLowerCase().includes('max')) {
          return res.status(400).json({ error: `Pet weight ${val} lbs is unrealistic. Max: 500 lbs.` });
        }
      }
      // Blood pressure systolic: max 300
      if ((key === 'systolic' || key === 'sbp') && val > 300) return res.status(400).json({ error: `Systolic ${val} is unrealistic. Max: 300.` });
      // Blood pressure diastolic: max 200
      if ((key === 'diastolic' || key === 'dbp') && val > 200) return res.status(400).json({ error: `Diastolic ${val} is unrealistic. Max: 200.` });
      // Heart rate: max 250
      if ((key === 'heartRate' || key === 'bpm' || key === 'pulse') && val > 250) return res.status(400).json({ error: `Heart rate ${val} is unrealistic. Max: 250.` });
      // Sleep hours: max 24
      if (key === 'hours' && val > 24) return res.status(400).json({ error: `Sleep ${val} hours is impossible. Max: 24.` });
      // Calories: max 20000
      if (key === 'calories' && val > 20000) return res.status(400).json({ error: `${val} calories is unrealistic. Max: 20,000.` });
      // Generic upper bound: no single numeric value over 100,000
      if (val > 100000) return res.status(400).json({ error: `Value ${val} for "${key}" exceeds maximum (100,000).` });
    }
    const parsed = insertTrackerEntrySchema.safeParse({ ...req.body, trackerId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const entry = await storage.logEntry(parsed.data);
    if (!entry) return res.status(404).json({ error: "Tracker not found" });
    res.status(201).json(entry);
  }));
  app.delete("/api/trackers/:id/entries/:entryId", asyncHandler(async (req, res) => {
    const deleted = await storage.deleteTrackerEntry(req.params.id, req.params.entryId);
    if (!deleted) return res.status(404).json({ error: "Entry not found" });
    res.status(204).send();
  }));
  app.delete("/api/trackers/:id", asyncHandler(async (req, res) => {
    await storage.deleteTracker(req.params.id);
    res.status(204).send();
  }));

  // Migrate unlinked trackers to "self" profile
  app.post("/api/trackers/migrate-to-self", asyncHandler(async (_req, res) => {
    const count = await storage.migrateUnlinkedTrackersToSelf();
    res.json({ migrated: count });
  }));

  // ---- Tasks ----
  app.get("/api/tasks", asyncHandler(async (_req, res) => { res.json(await storage.getTasks()); }));
  app.get("/api/tasks/:id", asyncHandler(async (req, res) => {
    const tasks = await storage.getTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  }));
  app.post("/api/tasks", asyncHandler(async (req, res) => {
    if (!req.body.title || typeof req.body.title !== "string" || !req.body.title.trim()) {
      return res.status(400).json({ error: "Task title required" });
    }
    req.body.title = sanitize(req.body.title);
    if (req.body.description) req.body.description = sanitize(req.body.description);
    const parsed = insertTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createTask(parsed.data));
  }));
  app.patch("/api/tasks/:id", asyncHandler(async (req, res) => {
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== "string" || req.body.title.trim() === "") {
        return res.status(400).json({ error: "Task title must be a non-empty string" });
      }
      req.body.title = sanitize(req.body.title);
    }
    if (req.body.description) req.body.description = sanitize(req.body.description);
    const updated = await storage.updateTask(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/tasks/:id", asyncHandler(async (req, res) => {
    await storage.deleteTask(req.params.id);
    res.status(204).send();
  }));

  // ---- Expenses ----
  app.get("/api/expenses", asyncHandler(async (_req, res) => { res.json(await storage.getExpenses()); }));
  app.post("/api/expenses", asyncHandler(async (req, res) => {
    if (!req.body.amount || typeof req.body.amount !== "number" || req.body.amount <= 0) {
      return res.status(400).json({ error: "Positive amount required" });
    }
    if (!req.body.description || typeof req.body.description !== "string" || !req.body.description.trim()) {
      return res.status(400).json({ error: "Description required" });
    }
    req.body.description = sanitize(req.body.description);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);
    const parsed = insertExpenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createExpense(parsed.data));
  }));
  app.patch("/api/expenses/:id", asyncHandler(async (req, res) => {
    if (req.body.amount !== undefined && (typeof req.body.amount !== "number" || req.body.amount <= 0)) {
      return res.status(400).json({ error: "Expense amount must be a positive number" });
    }
    if (req.body.description) req.body.description = sanitize(req.body.description);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);
    const updated = await storage.updateExpense(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/expenses/:id", asyncHandler(async (req, res) => {
    await storage.deleteExpense(req.params.id);
    res.status(204).send();
  }));

  // ---- Events ----
  app.get("/api/events", asyncHandler(async (_req, res) => { res.json(await storage.getEvents()); }));
  app.get("/api/events/:id", asyncHandler(async (req, res) => {
    const event = await storage.getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: "Not found" });
    res.json(event);
  }));
  app.post("/api/events", asyncHandler(async (req, res) => {
    const parsed = insertEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createEvent(parsed.data));
  }));
  app.patch("/api/events/:id", asyncHandler(async (req, res) => {
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== "string" || !req.body.title.trim()) return res.status(400).json({ error: "Event title must be a non-empty string" });
      req.body.title = sanitize(req.body.title);
    }
    const updated = await storage.updateEvent(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/events/:id", asyncHandler(async (req, res) => {
    await storage.deleteEvent(req.params.id);
    res.status(204).send();
  }));

  // ---- Unified Calendar Timeline ----
  app.get("/api/calendar/timeline", asyncHandler(async (req, res) => {
    const startRaw = req.query.start as string;
    const endRaw = req.query.end as string;
    const start = (startRaw && isValidDateStr(startRaw)) ? startRaw : new Date().toISOString().slice(0, 10);
    const endDefault = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const end = (endRaw && isValidDateStr(endRaw)) ? endRaw : endDefault;
    try {
      const items = await storage.getCalendarTimeline(start, end);
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load calendar" });
    }
  }));

  // ---- Documents ----
  app.get("/api/documents", asyncHandler(async (_req, res) => { res.json(await storage.getDocuments()); }));
  app.get("/api/documents/:id", asyncHandler(async (req, res) => {
    const doc = await storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  }));
  app.post("/api/documents", asyncHandler(async (req, res) => {
    try {
      const doc = await storage.createDocument(req.body);
      res.status(201).json(doc);
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Failed to create document" });
    }
  }));
  app.patch("/api/documents/:id", asyncHandler(async (req, res) => {
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) return res.status(400).json({ error: "Document name must be a non-empty string" });
      req.body.name = sanitize(req.body.name);
    }
    const updated = await storage.updateDocument(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
    const deleted = await storage.deleteDocument(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  }));
  app.get("/api/profiles/:id/documents", asyncHandler(async (req, res) => {
    res.json(await storage.getDocumentsForProfile(req.params.id));
  }));

  // ---- Document file serving (for download / share) ----
  app.get("/api/documents/:id/file", asyncHandler(async (req, res) => {
    const doc = await storage.getDocument(req.params.id);
    if (!doc || !doc.fileData) return res.status(404).json({ error: "Not found" });
    const buffer = Buffer.from(doc.fileData, "base64");
    res.setHeader("Content-Type", doc.mimeType);
    // Sanitize filename: strip all non-alphanumeric except dots, hyphens, underscores
    const safeName = (doc.name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    res.setHeader("Content-Length", buffer.length.toString());
    res.send(buffer);
  }));

  // ---- Habits ----
  app.get("/api/habits", asyncHandler(async (_req, res) => { res.json(await storage.getHabits()); }));
  app.get("/api/habits/:id", asyncHandler(async (req, res) => {
    const habit = await storage.getHabit(req.params.id);
    if (!habit) return res.status(404).json({ error: "Not found" });
    res.json(habit);
  }));
  app.post("/api/habits", asyncHandler(async (req, res) => {
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Habit name is required" });
    }
    const parsed = insertHabitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createHabit(parsed.data));
  }));
  app.post("/api/habits/:id/checkin", asyncHandler(async (req, res) => {
    const { date, value, notes } = req.body;
    const checkin = await storage.checkinHabit(req.params.id, date, value, notes);
    if (!checkin) return res.status(404).json({ error: "Habit not found" });
    res.status(201).json(checkin);
  }));
  app.patch("/api/habits/:id", asyncHandler(async (req, res) => {
    try {
      const result = await storage.updateHabit(req.params.id, req.body);
      if (!result) return res.status(404).json({ error: "Habit not found" });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  }));
  app.delete("/api/habits/:id", asyncHandler(async (req, res) => {
    await storage.deleteHabit(req.params.id);
    res.status(204).send();
  }));

  // ---- Obligations ----
  app.get("/api/obligations", asyncHandler(async (_req, res) => { res.json(await storage.getObligations()); }));
  app.get("/api/obligations/:id", asyncHandler(async (req, res) => {
    const ob = await storage.getObligation(req.params.id);
    if (!ob) return res.status(404).json({ error: "Not found" });
    res.json(ob);
  }));
  app.post("/api/obligations", asyncHandler(async (req, res) => {
    const parsed = insertObligationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createObligation(parsed.data));
  }));
  app.patch("/api/obligations/:id", asyncHandler(async (req, res) => {
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) return res.status(400).json({ error: "Obligation name must be a non-empty string" });
      req.body.name = sanitize(req.body.name);
    }
    if (req.body.amount !== undefined && (typeof req.body.amount !== "number" || req.body.amount < 0)) {
      return res.status(400).json({ error: "Amount must be a non-negative number" });
    }
    const updated = await storage.updateObligation(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.post("/api/obligations/:id/pay", asyncHandler(async (req, res) => {
    const { amount, method, confirmationNumber } = req.body;
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
      return res.status(400).json({ error: "Payment amount must be a positive number" });
    }
    const payment = await storage.payObligation(req.params.id, amount, method, confirmationNumber);
    if (!payment) return res.status(404).json({ error: "Obligation not found" });
    res.status(201).json(payment);
  }));
  app.delete("/api/obligations/:id", asyncHandler(async (req, res) => {
    await storage.deleteObligation(req.params.id);
    res.status(204).send();
  }));

  // ---- Artifacts ----
  app.get("/api/artifacts", asyncHandler(async (_req, res) => { res.json(await storage.getArtifacts()); }));
  app.get("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const artifact = await storage.getArtifact(req.params.id);
    if (!artifact) return res.status(404).json({ error: "Not found" });
    res.json(artifact);
  }));
  app.post("/api/artifacts", asyncHandler(async (req, res) => {
    if (req.body.title) req.body.title = sanitize(req.body.title);
    const parsed = insertArtifactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createArtifact(parsed.data));
  }));
  app.patch("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const updated = await storage.updateArtifact(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.post("/api/artifacts/:id/toggle/:itemId", asyncHandler(async (req, res) => {
    const result = await storage.toggleChecklistItem(req.params.id, req.params.itemId);
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json(result);
  }));
  app.delete("/api/artifacts/:id", asyncHandler(async (req, res) => {
    await storage.deleteArtifact(req.params.id);
    res.status(204).send();
  }));

  // ---- Journal ----
  app.get("/api/journal", asyncHandler(async (_req, res) => { res.json(await storage.getJournalEntries()); }));
  app.post("/api/journal", asyncHandler(async (req, res) => {
    if (!req.body.content || typeof req.body.content !== "string" || !req.body.content.trim()) {
      return res.status(400).json({ error: "Journal content is required" });
    }
    req.body.content = sanitize(req.body.content);
    const parsed = insertJournalEntrySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createJournalEntry(parsed.data));
  }));
  app.patch("/api/journal/:id", asyncHandler(async (req, res) => {
    const updated = await storage.updateJournalEntry(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/journal/:id", asyncHandler(async (req, res) => {
    await storage.deleteJournalEntry(req.params.id);
    res.status(204).send();
  }));

  // ---- Memory ----
  app.get("/api/memories", asyncHandler(async (_req, res) => {
    try { res.json(await storage.getMemories()); }
    catch { res.status(500).json({ error: "Failed to load memories" }); }
  }));
  app.post("/api/memories", asyncHandler(async (req, res) => {
    const parsed = insertMemorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    try { res.status(201).json(await storage.saveMemory(parsed.data)); }
    catch (err: any) { res.status(500).json({ error: err.message || "Failed to save memory" }); }
  }));
  app.get("/api/memories/recall", asyncHandler(async (req, res) => {
    const q = (req.query.q as string) || "";
    try { res.json(await storage.recallMemory(q)); }
    catch { res.status(500).json({ error: "Recall failed" }); }
  }));
  app.patch("/api/memories/:id", asyncHandler(async (req, res) => {
    try {
      const result = await storage.updateMemory(req.params.id, req.body);
      if (!result) return res.status(404).json({ error: "Memory not found" });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  }));
  app.delete("/api/memories/:id", asyncHandler(async (req, res) => {
    await storage.deleteMemory(req.params.id);
    res.status(204).send();
  }));

  // ---- Domains ----
  app.get("/api/domains", asyncHandler(async (_req, res) => { res.json(await storage.getDomains()); }));
  app.post("/api/domains", asyncHandler(async (req, res) => {
    const parsed = insertDomainSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(await storage.createDomain(parsed.data));
  }));
  app.patch("/api/domains/:id", asyncHandler(async (req, res) => {
    try {
      const result = await storage.updateDomain(req.params.id, req.body);
      if (!result) return res.status(404).json({ error: "Domain not found" });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  }));
  app.delete("/api/domains/:id", asyncHandler(async (req, res) => {
    try {
      const result = await storage.deleteDomain(req.params.id);
      if (!result) return res.status(404).json({ error: "Domain not found" });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  }));
  app.get("/api/domains/:id/entries", asyncHandler(async (req, res) => {
    res.json(await storage.getDomainEntries(req.params.id));
  }));
  app.post("/api/domains/:id/entries", asyncHandler(async (req, res) => {
    const { values, tags, notes } = req.body;
    const entry = await storage.addDomainEntry(req.params.id, values, tags, notes);
    if (!entry) return res.status(404).json({ error: "Domain not found" });
    res.status(201).json(entry);
  }));

  // ---- Notifications (computed on each request) ----
  app.get("/api/notifications", asyncHandler(async (_req, res) => {
    try {
      interface Notification {
        id: string;
        type: "document_expiring" | "task_overdue" | "task_due_today" | "bill_due" | "habit_at_risk" | "streak_milestone";
        severity: "critical" | "warning" | "info";
        title: string;
        message: string;
        entityId?: string;
        entityType?: string;
        dueDate?: string;
        dismissed?: boolean;
      }

      const notifications: Notification[] = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);

      // Helper: try to parse various date formats into a Date object
      const parseDate = (val: string): Date | null => {
        if (!val || typeof val !== "string") return null;
        const trimmed = val.trim();
        // YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
          const d = new Date(trimmed);
          return isNaN(d.getTime()) ? null : d;
        }
        // MM/DD/YYYY or M/D/YYYY
        const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (slashMatch) {
          const d = new Date(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2]));
          return isNaN(d.getTime()) ? null : d;
        }
        // MM-DD-YYYY
        const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (dashMatch) {
          const d = new Date(Number(dashMatch[3]), Number(dashMatch[1]) - 1, Number(dashMatch[2]));
          return isNaN(d.getTime()) ? null : d;
        }
        // Try native parsing as last resort
        const d = new Date(trimmed);
        return isNaN(d.getTime()) ? null : d;
      };

      const daysDiff = (dateA: Date, dateB: Date): number => {
        const a = new Date(dateA); a.setHours(0,0,0,0);
        const b = new Date(dateB); b.setHours(0,0,0,0);
        return Math.round((a.getTime() - b.getTime()) / 86400000);
      };

      // --- Document Expirations ---
      const documents = await storage.getDocuments();
      const expirationKeywords = ["expir", "exp date", "exp_date", "expdate", "valid until", "valid through", "valid_until", "valid_through", "expires", "expiration"];

      for (const doc of documents) {
        if (!doc.extractedData || typeof doc.extractedData !== "object") continue;
        const fields = doc.extractedData as Record<string, any>;
        for (const [key, value] of Object.entries(fields)) {
          if (!value || typeof value !== "string") continue;
          const keyLower = key.toLowerCase();
          const isExpirationField = expirationKeywords.some(kw => keyLower.includes(kw));
          if (!isExpirationField) continue;
          const expDate = parseDate(value);
          if (!expDate) continue;
          const diff = daysDiff(expDate, today);
          if (diff < 0) {
            notifications.push({
              id: `doc-exp-${doc.id}-${key}`,
              type: "document_expiring",
              severity: "critical",
              title: `Expired: ${doc.name}`,
              message: `${key} expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
              entityId: doc.id,
              entityType: "document",
              dueDate: value,
            });
          } else if (diff <= 7) {
            notifications.push({
              id: `doc-exp-${doc.id}-${key}`,
              type: "document_expiring",
              severity: "warning",
              title: `Expiring soon: ${doc.name}`,
              message: `${key} expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
              entityId: doc.id,
              entityType: "document",
              dueDate: value,
            });
          } else if (diff <= 30) {
            notifications.push({
              id: `doc-exp-${doc.id}-${key}`,
              type: "document_expiring",
              severity: "info",
              title: `Expiring: ${doc.name}`,
              message: `${key} expires in ${diff} days (${value})`,
              entityId: doc.id,
              entityType: "document",
              dueDate: value,
            });
          }
        }
      }

      // --- Also scan profile fields for expiration dates ---
      const profiles = await storage.getProfiles();
      for (const profile of profiles) {
        if (!profile.fields || typeof profile.fields !== "object") continue;
        for (const [key, value] of Object.entries(profile.fields as Record<string, any>)) {
          if (!value || typeof value !== "string") continue;
          const keyLower = key.toLowerCase();
          const isExpirationField = expirationKeywords.some(kw => keyLower.includes(kw));
          if (!isExpirationField) continue;
          const expDate = parseDate(value);
          if (!expDate) continue;
          const diff = daysDiff(expDate, today);
          if (diff < 0) {
            notifications.push({
              id: `profile-exp-${profile.id}-${key}`,
              type: "document_expiring",
              severity: "critical",
              title: `Expired: ${profile.name} - ${key}`,
              message: `Expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
              entityId: profile.id,
              entityType: "profile",
              dueDate: value,
            });
          } else if (diff <= 7) {
            notifications.push({
              id: `profile-exp-${profile.id}-${key}`,
              type: "document_expiring",
              severity: "warning",
              title: `Expiring soon: ${profile.name} - ${key}`,
              message: `Expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
              entityId: profile.id,
              entityType: "profile",
              dueDate: value,
            });
          } else if (diff <= 30) {
            notifications.push({
              id: `profile-exp-${profile.id}-${key}`,
              type: "document_expiring",
              severity: "info",
              title: `Expiring: ${profile.name} - ${key}`,
              message: `Expires in ${diff} days (${value})`,
              entityId: profile.id,
              entityType: "profile",
              dueDate: value,
            });
          }
        }
      }

      // --- Task Due Dates ---
      const tasks = await storage.getTasks();
      for (const task of tasks) {
        if (task.status === "done" || !task.dueDate) continue;
        const due = parseDate(task.dueDate);
        if (!due) continue;
        const diff = daysDiff(due, today);
        if (diff < 0) {
          notifications.push({
            id: `task-overdue-${task.id}`,
            type: "task_overdue",
            severity: "critical",
            title: `Overdue: ${task.title}`,
            message: `Was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago`,
            entityId: task.id,
            entityType: "task",
            dueDate: task.dueDate,
          });
        } else if (diff === 0) {
          notifications.push({
            id: `task-today-${task.id}`,
            type: "task_due_today",
            severity: "warning",
            title: `${task.title} is due today`,
            message: `Priority: ${task.priority}`,
            entityId: task.id,
            entityType: "task",
            dueDate: task.dueDate,
          });
        } else if (diff <= 3) {
          notifications.push({
            id: `task-soon-${task.id}`,
            type: "task_due_today",
            severity: "info",
            title: `${task.title} due in ${diff} day${diff !== 1 ? "s" : ""}`,
            message: `Priority: ${task.priority}`,
            entityId: task.id,
            entityType: "task",
            dueDate: task.dueDate,
          });
        }
      }

      // --- Bills/Obligations ---
      const obligations = await storage.getObligations();
      for (const ob of obligations) {
        if (!ob.nextDueDate) continue;
        const due = parseDate(ob.nextDueDate);
        if (!due) continue;
        const diff = daysDiff(due, today);
        if (diff < 0) {
          notifications.push({
            id: `bill-overdue-${ob.id}`,
            type: "bill_due",
            severity: "critical",
            title: `Overdue bill: ${ob.name}`,
            message: `$${ob.amount.toFixed(2)} was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago`,
            entityId: ob.id,
            entityType: "obligation",
            dueDate: ob.nextDueDate,
          });
        } else if (diff <= 3) {
          notifications.push({
            id: `bill-soon-${ob.id}`,
            type: "bill_due",
            severity: "warning",
            title: `Bill due soon: ${ob.name}`,
            message: `$${ob.amount.toFixed(2)} due in ${diff} day${diff !== 1 ? "s" : ""}${diff === 0 ? " (today)" : ""}`,
            entityId: ob.id,
            entityType: "obligation",
            dueDate: ob.nextDueDate,
          });
        } else if (diff <= 7 && !ob.autopay) {
          notifications.push({
            id: `bill-upcoming-${ob.id}`,
            type: "bill_due",
            severity: "info",
            title: `Upcoming bill: ${ob.name}`,
            message: `$${ob.amount.toFixed(2)} due in ${diff} days (no autopay)`,
            entityId: ob.id,
            entityType: "obligation",
            dueDate: ob.nextDueDate,
          });
        }
      }

      // --- Habit Streak Risk & Milestones ---
      const habits = await storage.getHabits();
      const streakMilestones = [7, 14, 30, 60, 90, 100, 365];
      for (const habit of habits) {
        // Streak risk: hasn't checked in today and has streak >= 3
        const checkedInToday = habit.checkins?.some(c => c.date === todayStr);
        if (!checkedInToday && habit.currentStreak >= 3) {
          notifications.push({
            id: `habit-risk-${habit.id}`,
            type: "habit_at_risk",
            severity: "warning",
            title: `Don't break your ${habit.name} streak!`,
            message: `${habit.currentStreak} day${habit.currentStreak !== 1 ? "s" : ""} and counting — check in today`,
            entityId: habit.id,
            entityType: "habit",
          });
        }
        // Streak milestones
        if (streakMilestones.includes(habit.currentStreak)) {
          notifications.push({
            id: `habit-milestone-${habit.id}-${habit.currentStreak}`,
            type: "streak_milestone",
            severity: "info",
            title: `Milestone! ${habit.currentStreak}-day ${habit.name} streak \u{1F389}`,
            message: `You've kept your ${habit.name} habit for ${habit.currentStreak} days straight!`,
            entityId: habit.id,
            entityType: "habit",
          });
        }
      }

      // Sort: critical first, then warning, then info
      const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      notifications.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      res.json(notifications);
    } catch (err: any) {
      console.error("Notifications error:", err);
      res.status(500).json({ error: "Failed to compute notifications" });
    }
  }));

  // ---- Search ----
  app.get("/api/search", asyncHandler(async (req, res) => {
    const q = (req.query.q as string) || "";
    try {
      res.json(await storage.search(q));
    } catch (err: any) {
      res.status(500).json({ error: "Search failed" });
    }
  }));

  // ---- Export / Import ----
  app.get("/api/export", asyncHandler(async (_req, res) => {
    try {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: await storage.getProfiles(),
        trackers: await storage.getTrackers(),
        tasks: await storage.getTasks(),
        expenses: await storage.getExpenses(),
        events: await storage.getEvents(),
        documents: await storage.getDocuments(),
        habits: await storage.getHabits(),
        obligations: await storage.getObligations(),
        artifacts: await storage.getArtifacts(),
        journalEntries: await storage.getJournalEntries(),
        memories: await storage.getMemories(),
        domains: await storage.getDomains(),
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="portol-backup-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(data);
    } catch (err: any) {
      console.error("Export error:", err);
      res.status(500).json({ error: "Export failed" });
    }
  }));

  app.post("/api/import", asyncHandler(async (req, res) => {
    try {
      const data = req.body;
      if (!data || !data.version) {
        return res.status(400).json({ error: "Invalid import file — missing version field" });
      }
      let imported = { profiles: 0, trackers: 0, tasks: 0, expenses: 0, events: 0, documents: 0, habits: 0, obligations: 0, artifacts: 0, journalEntries: 0, memories: 0, domains: 0 };

      // Import profiles
      if (data.profiles && Array.isArray(data.profiles)) {
        for (const p of data.profiles) {
          try { await storage.createProfile({ type: p.type, name: p.name, fields: p.fields, tags: p.tags, notes: p.notes }); imported.profiles++; } catch {}
        }
      }
      // Import trackers + entries
      if (data.trackers && Array.isArray(data.trackers)) {
        for (const t of data.trackers) {
          try {
            const created = await storage.createTracker({ name: t.name, category: t.category, unit: t.unit, icon: t.icon, fields: t.fields });
            if (t.entries) {
              for (const e of t.entries) {
                try { await storage.logEntry({ trackerId: created.id, values: e.values, notes: e.notes, mood: e.mood, tags: e.tags }); } catch {}
              }
            }
            imported.trackers++;
          } catch {}
        }
      }
      // Import tasks
      if (data.tasks && Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          try { await storage.createTask({ title: t.title, description: t.description, priority: t.priority, dueDate: t.dueDate, tags: t.tags }); imported.tasks++; } catch {}
        }
      }
      // Import expenses
      if (data.expenses && Array.isArray(data.expenses)) {
        for (const e of data.expenses) {
          try { await storage.createExpense({ amount: e.amount, category: e.category, description: e.description, vendor: e.vendor, date: e.date, tags: e.tags }); imported.expenses++; } catch {}
        }
      }
      // Import events
      if (data.events && Array.isArray(data.events)) {
        for (const e of data.events) {
          try { await storage.createEvent({ title: e.title, date: e.date, time: e.time, endTime: e.endTime, allDay: e.allDay, description: e.description, location: e.location, category: e.category || "personal", recurrence: e.recurrence || "none", tags: e.tags || [], source: e.source || "manual", linkedProfiles: e.linkedProfiles || [], linkedDocuments: e.linkedDocuments || [] }); imported.events++; } catch {}
        }
      }
      // Import documents
      if (data.documents && Array.isArray(data.documents)) {
        for (const d of data.documents) {
          try { await storage.createDocument({ name: d.name, type: d.type, mimeType: d.mimeType, fileData: d.fileData, extractedData: d.extractedData, tags: d.tags }); imported.documents++; } catch {}
        }
      }
      // Import habits
      if (data.habits && Array.isArray(data.habits)) {
        for (const h of data.habits) {
          try {
            const created = await storage.createHabit({ name: h.name, icon: h.icon, color: h.color, frequency: h.frequency });
            if (h.checkins) {
              for (const c of h.checkins) {
                try { await storage.checkinHabit(created.id, c.date, c.value, c.notes); } catch {}
              }
            }
            imported.habits++;
          } catch {}
        }
      }
      // Import obligations
      if (data.obligations && Array.isArray(data.obligations)) {
        for (const o of data.obligations) {
          try {
            const created = await storage.createObligation({ name: o.name, amount: o.amount, frequency: o.frequency, category: o.category, nextDueDate: o.nextDueDate, autopay: o.autopay, notes: o.notes });
            if (o.payments) {
              for (const p of o.payments) {
                try { await storage.payObligation(created.id, p.amount, p.method, p.confirmationNumber); } catch {}
              }
            }
            imported.obligations++;
          } catch {}
        }
      }
      // Import artifacts
      if (data.artifacts && Array.isArray(data.artifacts)) {
        for (const a of data.artifacts) {
          try { await storage.createArtifact({ type: a.type, title: a.title, content: a.content, items: a.items?.map((i: any) => ({ text: i.text, checked: i.checked })) || [], tags: a.tags, pinned: a.pinned }); imported.artifacts++; } catch {}
        }
      }
      // Import journal entries
      if (data.journalEntries && Array.isArray(data.journalEntries)) {
        for (const j of data.journalEntries) {
          try { await storage.createJournalEntry({ date: j.date, mood: j.mood, content: j.content, tags: j.tags, energy: j.energy, gratitude: j.gratitude, highlights: j.highlights }); imported.journalEntries++; } catch {}
        }
      }
      // Import memories
      if (data.memories && Array.isArray(data.memories)) {
        for (const m of data.memories) {
          try { await storage.saveMemory({ key: m.key, value: m.value, category: m.category }); imported.memories++; } catch {}
        }
      }

      res.json({ success: true, imported });
    } catch (err: any) {
      console.error("Import error:", err);
      res.status(500).json({ error: "Import failed" });
    }
  }));

  // ---- CSV Bank Import ----
  app.post("/api/import/bank-csv", asyncHandler(async (req, res) => {
    try {
      // Accept JSON { csv: "..." } or raw text/csv body
      let csv: string;
      if (typeof req.body === "string") {
        csv = req.body;
      } else if (req.body?.csv && typeof req.body.csv === "string") {
        csv = req.body.csv;
      } else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
        csv = (req.rawBody as Buffer).toString("utf-8");
      } else {
        return res.status(400).json({ error: "CSV data required — send as JSON { csv: '...' } or raw text/csv body" });
      }

      // Parse CSV lines
      const lines = csv.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        return res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      }

      // Parse header — auto-detect column mapping
      const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
      const colMap: Record<string, number> = {};
      for (let i = 0; i < header.length; i++) {
        const h = header[i];
        if (!colMap.date && /date|posted|trans/.test(h)) colMap.date = i;
        if (!colMap.amount && /amount|debit|credit|sum|total/.test(h)) colMap.amount = i;
        if (!colMap.description && /desc|memo|narr|detail|merchant|payee|name/.test(h)) colMap.description = i;
        if (!colMap.category && /cat|type|class/.test(h)) colMap.category = i;
      }

      if (colMap.amount === undefined) {
        return res.status(400).json({ error: "Could not detect an amount column in the CSV header" });
      }

      // Auto-categorize based on keywords
      const CATEGORY_KEYWORDS: Record<string, string[]> = {
        "food": ["grocery", "restaurant", "uber eats", "doordash", "grubhub", "mcdonald", "starbucks", "coffee", "cafe", "pizza", "chipotle", "subway", "diner", "bakery", "food"],
        "transport": ["uber", "lyft", "gas", "fuel", "parking", "toll", "transit", "metro", "bus", "train", "airline", "flight"],
        "shopping": ["amazon", "walmart", "target", "costco", "best buy", "ebay", "shop", "store", "mall", "retail"],
        "entertainment": ["netflix", "spotify", "hulu", "disney", "movie", "theater", "concert", "game", "steam"],
        "health": ["pharmacy", "cvs", "walgreens", "doctor", "hospital", "medical", "dental", "gym", "fitness"],
        "utilities": ["electric", "water", "gas", "internet", "phone", "mobile", "comcast", "verizon", "att"],
        "housing": ["rent", "mortgage", "insurance", "hoa"],
        "subscriptions": ["subscription", "membership", "annual", "monthly", "recurring"],
      };

      const autoCategory = (desc: string): string => {
        const lower = desc.toLowerCase();
        for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
          if (keywords.some(k => lower.includes(k))) return cat;
        }
        return "other";
      };

      // Parse a CSV row respecting quoted fields
      const parseRow = (line: string): string[] => {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQuotes = !inQuotes; continue; }
          if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; continue; }
          current += ch;
        }
        fields.push(current.trim());
        return fields;
      };

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        try {
          const fields = parseRow(lines[i]);
          const rawAmount = fields[colMap.amount] || "";
          const parsedAmount = parseFloat(rawAmount.replace(/[$,\s]/g, ""));
          // Preserve sign: negative = refund/credit, positive = expense
          const amount = parsedAmount;
          const isRefund = parsedAmount < 0;
          if (isNaN(amount) || amount === 0) { skipped++; continue; }

          const description = fields[colMap.description ?? colMap.amount] || `Row ${i}`;
          const date = colMap.date !== undefined ? fields[colMap.date] : new Date().toISOString().slice(0, 10);
          const csvCategory = colMap.category !== undefined ? fields[colMap.category] : undefined;
          const category = csvCategory || autoCategory(description);

          // Normalize date to YYYY-MM-DD if possible
          let normalizedDate = date;
          const parsed = new Date(date);
          if (!isNaN(parsed.getTime())) {
            normalizedDate = parsed.toISOString().slice(0, 10);
          }

          await storage.createExpense({
            amount,
            category,
            description: description.slice(0, 200),
            vendor: description.split(/\s{2,}|[-–]/).shift()?.trim().slice(0, 100) || undefined,
            date: normalizedDate,
            tags: ["bank-import"],
          });
          imported++;
        } catch (err: any) {
          errors.push(`Row ${i}: ${err.message || "unknown error"}`);
        }
      }

      res.json({ success: true, imported, skipped, errors: errors.slice(0, 10), totalRows: lines.length - 1 });
    } catch (err: any) {
      console.error("Bank CSV import error:", err);
      res.status(500).json({ error: "CSV import failed" });
    }
  }));

  // ---- Budgets (uses preferences internally) ----
  app.get("/api/budgets", asyncHandler(async (_req, res) => {
    try {
      const raw = await storage.getPreference("budgets");
      if (!raw) return res.json({});
      res.json(JSON.parse(raw));
    } catch {
      res.json({});
    }
  }));

  app.put("/api/budgets", asyncHandler(async (req, res) => {
    try {
      const { budgets } = req.body;
      if (!budgets || typeof budgets !== "object") {
        return res.status(400).json({ error: "budgets object required" });
      }
      await storage.setPreference("budgets", JSON.stringify(budgets));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to save budgets" });
    }
  }));

  // ---- Spending Analytics ----
  app.get("/api/analytics/spending", asyncHandler(async (req, res) => {
    try {
      const monthsBack = Math.min(Math.max(parseInt(req.query.months as string) || 6, 1), 24);
      const now = new Date();
      const thisYear = now.getFullYear();
      const thisMonth = now.getMonth();
      const todayDate = now.getDate();
      const daysInCurrentMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
      const daysElapsed = todayDate;
      const daysRemaining = daysInCurrentMonth - todayDate;

      const allExpenses = await storage.getExpenses();
      const obligations = await storage.getObligations();

      // --- Current month data ---
      const currentMonthExpenses = allExpenses.filter(e => {
        const d = new Date(e.date);
        return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
      });

      const currentTotal = currentMonthExpenses.reduce((s, e) => s + e.amount, 0);

      // By category
      const catMap: Record<string, { amount: number; count: number }> = {};
      for (const e of currentMonthExpenses) {
        const cat = e.category || "other";
        if (!catMap[cat]) catMap[cat] = { amount: 0, count: 0 };
        catMap[cat].amount += e.amount;
        catMap[cat].count++;
      }
      const byCategory = Object.entries(catMap)
        .map(([category, { amount, count }]) => ({
          category,
          amount: Math.round(amount * 100) / 100,
          percentage: currentTotal > 0 ? Math.round((amount / currentTotal) * 1000) / 10 : 0,
          count,
        }))
        .sort((a, b) => b.amount - a.amount);

      // By vendor
      const vendorMap: Record<string, { amount: number; count: number }> = {};
      for (const e of currentMonthExpenses) {
        const v = e.vendor || e.description || "Unknown";
        if (!vendorMap[v]) vendorMap[v] = { amount: 0, count: 0 };
        vendorMap[v].amount += e.amount;
        vendorMap[v].count++;
      }
      const byVendor = Object.entries(vendorMap)
        .map(([vendor, { amount, count }]) => ({
          vendor,
          amount: Math.round(amount * 100) / 100,
          count,
        }))
        .sort((a, b) => b.amount - a.amount);

      // Daily spending
      const dailyMap: Record<string, number> = {};
      for (const e of currentMonthExpenses) {
        const day = e.date.slice(0, 10);
        dailyMap[day] = (dailyMap[day] || 0) + e.amount;
      }
      const dailySpending = Object.entries(dailyMap)
        .map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const avgPerDay = daysElapsed > 0 ? Math.round((currentTotal / daysElapsed) * 100) / 100 : 0;
      const projectedMonthTotal = Math.round(avgPerDay * daysInCurrentMonth * 100) / 100;

      // --- Monthly trend ---
      const monthlyTrend: Array<{ month: string; total: number; byCategory: Record<string, number> }> = [];
      for (let i = 0; i < monthsBack; i++) {
        const d = new Date(thisYear, thisMonth - i, 1);
        const m = d.getMonth();
        const y = d.getFullYear();
        const monthStr = `${y}-${String(m + 1).padStart(2, "0")}`;
        const monthExpenses = allExpenses.filter(e => {
          const ed = new Date(e.date);
          return ed.getMonth() === m && ed.getFullYear() === y;
        });
        const total = Math.round(monthExpenses.reduce((s, e) => s + e.amount, 0) * 100) / 100;
        const byCat: Record<string, number> = {};
        for (const e of monthExpenses) {
          byCat[e.category || "other"] = (byCat[e.category || "other"] || 0) + e.amount;
        }
        // Round category values
        for (const k of Object.keys(byCat)) byCat[k] = Math.round(byCat[k] * 100) / 100;
        monthlyTrend.push({ month: monthStr, total, byCategory: byCat });
      }
      monthlyTrend.reverse(); // oldest first

      // --- Budgets ---
      let budgetLimits: Record<string, number> = {};
      try {
        const raw = await storage.getPreference("budgets");
        if (raw) budgetLimits = JSON.parse(raw);
      } catch {}
      const budgets = Object.entries(budgetLimits).map(([category, limit]) => {
        const spent = catMap[category]?.amount || 0;
        return {
          category,
          limit,
          spent: Math.round(spent * 100) / 100,
          remaining: Math.round((limit - spent) * 100) / 100,
          percentUsed: limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0,
        };
      });

      // --- Obligations (monthly committed) ---
      const monthlyCommitted = Math.round(
        obligations.reduce((s, o) => {
          switch (o.frequency) {
            case "weekly": return s + o.amount * 4.33;
            case "biweekly": return s + o.amount * 2.17;
            case "monthly": return s + o.amount;
            case "quarterly": return s + o.amount / 3;
            case "yearly": return s + o.amount / 12;
            default: return s;
          }
        }, 0) * 100
      ) / 100;
      const monthlyDiscretionary = Math.round((currentTotal - monthlyCommitted) * 100) / 100;

      // --- Insights ---
      // Highest spending day
      let highestDay = { date: "", amount: 0 };
      for (const ds of dailySpending) {
        if (ds.amount > highestDay.amount) highestDay = ds;
      }

      // Top category
      const topCategory = byCategory.length > 0
        ? { category: byCategory[0].category, amount: byCategory[0].amount }
        : { category: "none", amount: 0 };

      // vs last month
      const lastMonthDate = new Date(thisYear, thisMonth - 1, 1);
      const lastMonthExpenses = allExpenses.filter(e => {
        const d = new Date(e.date);
        return d.getMonth() === lastMonthDate.getMonth() && d.getFullYear() === lastMonthDate.getFullYear();
      });
      const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);
      const change = Math.round((currentTotal - lastMonthTotal) * 100) / 100;
      const percentChange = lastMonthTotal > 0 ? Math.round((change / lastMonthTotal) * 1000) / 10 : 0;

      // Average monthly (across all months with data)
      const monthTotals = monthlyTrend.map(m => m.total).filter(t => t > 0);
      const avgMonthly = monthTotals.length > 0
        ? Math.round((monthTotals.reduce((s, t) => s + t, 0) / monthTotals.length) * 100) / 100
        : 0;

      res.json({
        currentMonth: {
          total: Math.round(currentTotal * 100) / 100,
          byCategory,
          byVendor,
          dailySpending,
          avgPerDay,
          projectedMonthTotal,
          daysRemaining,
        },
        monthlyTrend,
        budgets,
        obligations: {
          monthlyCommitted,
          monthlyDiscretionary: Math.max(monthlyDiscretionary, 0),
        },
        insights: {
          highestDay,
          topCategory,
          vsLastMonth: { change, percentChange },
          avgMonthly,
        },
      });
    } catch (err: any) {
      console.error("Spending analytics error:", err);
      res.status(500).json({ error: "Failed to compute spending analytics" });
    }
  }));

  // ---- AI Digest ----
  app.get("/api/ai-digest", asyncHandler(async (req, res) => {
    try {
      const force = req.query.force === "true";

      // Check cache first (stored in preferences as ai_digest)
      if (!force) {
        const cached = await storage.getPreference("ai_digest");
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.generatedAt) {
              const age = Date.now() - new Date(parsed.generatedAt).getTime();
              if (age < 3600000) { // 1 hour TTL
                return res.json(parsed);
              }
            }
          } catch {}
        }
      }

      // Gather ALL data
      const [profiles, trackers, tasks, expenses, habits, obligations, journal, documents, memories] = await Promise.all([
        storage.getProfiles(),
        storage.getTrackers(),
        storage.getTasks(),
        storage.getExpenses(),
        storage.getHabits(),
        storage.getObligations(),
        storage.getJournalEntries(),
        storage.getDocuments(),
        storage.getMemories(),
      ]);

      // Build compact data snapshot
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400000);
      const monthAgo = new Date(now.getTime() - 30 * 86400000);
      const todayStr = now.toISOString().slice(0, 10);
      const weekAgoStr = weekAgo.toISOString().slice(0, 10);
      const monthAgoStr = monthAgo.toISOString().slice(0, 10);

      // Tracker entries (last 30 per tracker)
      const trackerSnapshot = trackers.map(t => ({
        name: t.name,
        category: t.category,
        unit: t.unit,
        entries: (t.entries || []).slice(-30).map(e => ({
          date: e.timestamp.slice(0, 10),
          values: e.values,
          mood: e.mood,
        })),
      }));

      // Tasks this week
      const tasksThisWeek = tasks.filter(t => {
        const created = new Date(t.createdAt);
        return created >= weekAgo;
      });
      const tasksCompleted = tasks.filter(t => t.status === "done");

      // Expenses this week & month
      const expensesThisWeek = expenses.filter(e => e.date >= weekAgoStr);
      const expensesThisMonth = expenses.filter(e => e.date >= monthAgoStr);
      const weekExpenseTotal = expensesThisWeek.reduce((s, e) => s + e.amount, 0);
      const monthExpenseTotal = expensesThisMonth.reduce((s, e) => s + e.amount, 0);
      const categoryTotals: Record<string, number> = {};
      for (const e of expensesThisWeek) {
        categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
      }
      const topExpenseCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";

      // Habits this week
      const habitSnapshot = habits.map(h => ({
        name: h.name,
        currentStreak: h.currentStreak,
        longestStreak: h.longestStreak,
        checkinsThisWeek: (h.checkins || []).filter(c => c.date >= weekAgoStr).length,
        totalCheckins: (h.checkins || []).length,
      }));
      const habitsCheckedIn = habitSnapshot.reduce((s, h) => s + h.checkinsThisWeek, 0);
      const totalHabitDays = habits.length * 7;

      // Journal this week
      const journalThisWeek = journal.filter(j => j.date >= weekAgoStr);
      const moods = journalThisWeek.map(j => j.mood).filter(Boolean);
      const moodMap: Record<string, number> = { amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 };
      const avgMoodVal = moods.length > 0 ? moods.reduce((s, m) => s + (moodMap[m!] || 3), 0) / moods.length : 0;
      const avgMoodLabel = avgMoodVal >= 4.5 ? "amazing" : avgMoodVal >= 3.5 ? "good" : avgMoodVal >= 2.5 ? "neutral" : avgMoodVal >= 1.5 ? "bad" : avgMoodVal > 0 ? "awful" : "none";

      // Upcoming obligations
      const upcomingObligations = obligations.filter(o => {
        if (!o.nextDueDate) return false;
        return o.nextDueDate >= todayStr && o.nextDueDate <= new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
      }).map(o => ({ name: o.name, amount: o.amount, dueDate: o.nextDueDate, autopay: o.autopay }));

      // Document expiration warnings
      const expiringDocs = documents.filter(d => {
        if (!d.extractedData || typeof d.extractedData !== "object") return false;
        const fields = d.extractedData as Record<string, any>;
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value !== "string") continue;
          if (/expir|valid.until|valid.through/i.test(key)) {
            try {
              const exp = new Date(value);
              const diff = (exp.getTime() - now.getTime()) / 86400000;
              if (diff >= -30 && diff <= 60) return true;
            } catch {}
          }
        }
        return false;
      }).map(d => ({ name: d.name, type: d.type }));

      // Tracker entries count this week
      const trackerEntriesThisWeek = trackers.reduce((sum, t) =>
        sum + (t.entries || []).filter(e => e.timestamp.slice(0, 10) >= weekAgoStr).length, 0);

      // Build the prompt data
      const dataSnapshot = {
        trackers: trackerSnapshot,
        tasks: {
          createdThisWeek: tasksThisWeek.length,
          completedThisWeek: tasksCompleted.length,
          totalPending: tasks.filter(t => t.status !== "done").length,
          overdue: tasks.filter(t => t.status !== "done" && t.dueDate && t.dueDate < todayStr).length,
        },
        expenses: {
          weekTotal: weekExpenseTotal,
          monthTotal: monthExpenseTotal,
          weekByCategory: categoryTotals,
          topCategory: topExpenseCategory,
        },
        habits: habitSnapshot,
        journal: journalThisWeek.map(j => ({ date: j.date, mood: j.mood, highlights: j.highlights })),
        obligations: upcomingObligations,
        expiringDocuments: expiringDocs,
        profiles: profiles.map(p => ({ name: p.name, type: p.type })),
        memories: memories.slice(-10).map(m => ({ key: m.key, value: m.value })),
      };

      const systemPrompt = `You are the AI engine for Portol, a personal life management app. You analyze the user's data to produce a Weekly Digest — a structured personal report card.

Rules:
- Be specific with numbers. Say "You ran 12 miles this week, up from 8 last week" not "You've been active."
- Find cross-entity patterns: exercise vs sleep, spending vs mood, habits vs productivity.
- Give actionable, concise recommendations.
- Assign a 1-100 "life score" based on overall data health. 80+ = excellent, 60-80 = good, 40-60 = needs attention, below 40 = concerning.
- If data is sparse, note it but still provide useful insights from what's available.
- Return ONLY valid JSON matching the exact schema below. No markdown, no code fences.

JSON Schema:
{
  "headline": "string — catchy 5-10 word summary like 'Strong week — your best since February'",
  "score": "number 1-100",
  "sections": [
    {
      "title": "string — e.g. 'Health & Fitness'",
      "icon": "one of: heart, dollar, brain, flame, calendar, target",
      "insight": "string — specific data-backed observation",
      "recommendation": "string — actionable next step",
      "severity": "one of: positive, neutral, warning, critical"
    }
  ],
  "correlations": [
    {
      "insight": "string — cross-entity pattern like 'You sleep 45 min longer on days you exercise'",
      "entities": ["string", "string"]
    }
  ]
}

Generate 3-6 sections covering different life areas. Generate 1-3 correlations if patterns exist. If data is insufficient for correlations, return an empty array.`;

      const userPrompt = `Here is my Portol data snapshot for the week of ${weekAgoStr} to ${todayStr}:\n\n${JSON.stringify(dataSnapshot, null, 1)}\n\nGenerate my Weekly Digest JSON.`;

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [
          { role: "user", content: userPrompt },
        ],
        system: systemPrompt,
      });

      // Extract text from response
      const textBlock = response.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from Claude");
      }

      // Parse the JSON response - strip any markdown code fences if present
      let jsonStr = textBlock.text.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      const digestData = JSON.parse(jsonStr);

      // Build week summary
      const weekSummary = {
        tasksCompleted: tasksCompleted.length,
        tasksCreated: tasksThisWeek.length,
        habitsCheckedIn: habitsCheckedIn,
        totalHabitDays: totalHabitDays,
        expensesTotal: weekExpenseTotal,
        topExpenseCategory: topExpenseCategory,
        trackerEntries: trackerEntriesThisWeek,
        journalEntries: journalThisWeek.length,
        avgMood: avgMoodLabel,
        documentsUploaded: documents.filter(d => {
          try {
            const created = d.createdAt ? new Date(d.createdAt) : null;
            return created && created >= weekAgo;
          } catch { return false; }
        }).length,
      };

      const result = {
        headline: digestData.headline || "Your Weekly Report",
        score: typeof digestData.score === "number" ? digestData.score : 50,
        generatedAt: now.toISOString(),
        sections: Array.isArray(digestData.sections) ? digestData.sections : [],
        correlations: Array.isArray(digestData.correlations) ? digestData.correlations : [],
        weekSummary,
      };

      // Cache the result
      await storage.setPreference("ai_digest", JSON.stringify(result));

      res.json(result);
    } catch (err: any) {
      console.error("AI Digest error:", err);
      res.status(500).json({ error: "Failed to generate AI digest" });
    }
  }));

  // ---- Goals ----
  app.get("/api/goals", asyncHandler(async (req, res) => {
    try {
      const goals = await storage.getGoals();
      res.json(goals);
    } catch (err: any) {
      console.error("Goals error:", err);
      res.status(500).json({ error: "Failed to get goals" });
    }
  }));

  app.get("/api/goals/:id", asyncHandler(async (req, res) => {
    try {
      const goal = await storage.getGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      res.json(goal);
    } catch (err: any) {
      console.error("Goal error:", err);
      res.status(500).json({ error: "Failed to get goal" });
    }
  }));

  app.post("/api/goals", asyncHandler(async (req, res) => {
    try {
      if (!req.body.title || typeof req.body.title !== "string" || !req.body.title.trim()) {
        return res.status(400).json({ error: "Goal title required" });
      }
      if (!req.body.target || typeof req.body.target !== "number" || req.body.target <= 0) {
        return res.status(400).json({ error: "Target must be greater than 0" });
      }
      const parsed = insertGoalSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const goal = await storage.createGoal(parsed.data);
      res.json(goal);
    } catch (err: any) {
      console.error("Create goal error:", err);
      res.status(500).json({ error: "Failed to create goal" });
    }
  }));

  app.patch("/api/goals/:id", asyncHandler(async (req, res) => {
    try {
      const goal = await storage.updateGoal(req.params.id, req.body);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      res.json(goal);
    } catch (err: any) {
      console.error("Update goal error:", err);
      res.status(500).json({ error: "Failed to update goal" });
    }
  }));

  app.delete("/api/goals/:id", asyncHandler(async (req, res) => {
    try {
      const deleted = await storage.deleteGoal(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Goal not found" });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete goal error:", err);
      res.status(500).json({ error: "Failed to delete goal" });
    }
  }));

  // ---- Entity Links ----
  app.get("/api/entity-links/:type/:id", asyncHandler(async (req, res) => {
    try {
      const links = await storage.getEntityLinks(req.params.type, req.params.id);
      res.json(links);
    } catch (err: any) {
      console.error("Get entity links error:", err);
      res.status(500).json({ error: "Failed to get entity links" });
    }
  }));

  app.get("/api/entity-links/:type/:id/related", asyncHandler(async (req, res) => {
    try {
      const related = await storage.getRelatedEntities(req.params.type, req.params.id);
      res.json(related);
    } catch (err: any) {
      console.error("Get related entities error:", err);
      res.status(500).json({ error: "Failed to get related entities" });
    }
  }));

  app.post("/api/entity-links", asyncHandler(async (req, res) => {
    try {
      const parsed = insertEntityLinkSchema.parse(req.body);
      const link = await storage.createEntityLink(parsed);
      res.json(link);
    } catch (err: any) {
      console.error("Create entity link error:", err);
      res.status(400).json({ error: err.message || "Failed to create entity link" });
    }
  }));

  app.delete("/api/entity-links/:id", asyncHandler(async (req, res) => {
    try {
      const deleted = await storage.deleteEntityLink(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Entity link not found" });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete entity link error:", err);
      res.status(500).json({ error: "Failed to delete entity link" });
    }
  }));

  // ---- Preferences ----
  app.get("/api/preferences/:key", asyncHandler(async (req, res) => {
    try {
      const value = await storage.getPreference(req.params.key);
      if (value === null) return res.status(404).json({ error: "Not found" });
      res.json({ value });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get preference" });
    }
  }));

  app.put("/api/preferences/:key", asyncHandler(async (req, res) => {
    try {
      const { value } = req.body;
      if (typeof value !== "string") return res.status(400).json({ error: "value (string) required" });
      await storage.setPreference(req.params.key, value);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to set preference" });
    }
  }));

  // ---- Onboarding Status ----
  app.get("/api/onboarding-status", asyncHandler(async (_req, res) => {
    // Onboarding wizard removed — always return completed
    res.json({ completed: true, hasProfiles: true, hasTrackers: true, hasTasks: true, profileCount: 0, trackerCount: 0, taskCount: 0 });
  }));

  app.post("/api/onboarding/complete", asyncHandler(async (_req, res) => {
    try {
      await storage.setPreference("onboarding_completed", "true");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to complete onboarding" });
    }
  }));

  // ---- Google Calendar Sync ----
  app.post("/api/calendar/sync", asyncHandler(async (req, res) => {
    try {
      const { execFileSync } = require("child_process");

      // Determine date range — sync 2 months (1 month back, 1 month forward)
      const now = new Date();
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
      const endDate = new Date(now);
      endDate.setMonth(endDate.getMonth() + 1);

      const startStr = startDate.toISOString().replace("Z", new Date().toTimeString().match(/[+-]\d{4}/)?.[0]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "+00:00");
      const endStr = endDate.toISOString().replace("Z", new Date().toTimeString().match(/[+-]\d{4}/)?.[0]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "+00:00");

      // Call Google Calendar via external-tool CLI
      const params = JSON.stringify({
        source_id: "gcal",
        tool_name: "search_calendar",
        arguments: {
          start_date: startStr,
          end_date: endStr,
          queries: [""],
        },
      });

      let gcalResult: any;
      try {
        const stdout = execFileSync("external-tool", ["call", params], {
          timeout: 30000,
          encoding: "utf-8",
        });
        gcalResult = JSON.parse(stdout);
      } catch (err: any) {
        console.error("Google Calendar fetch failed:", err.message);
        return res.status(502).json({ error: "Failed to connect to Google Calendar. Please try again." });
      }

      const gcalEvents = gcalResult?.calendar_event_list?.events || [];
      if (gcalEvents.length === 0) {
        return res.json({ imported: 0, exported: 0, message: "No events found in Google Calendar for this period." });
      }

      // Get existing Portol events to avoid duplicates
      const existingEvents = await storage.getEvents();
      const gcalMappings = new Set<string>();
      for (const e of existingEvents) {
        const mapped = await storage.getPreference(`gcal_map_${e.id}`);
        if (mapped) gcalMappings.add(mapped);
      }

      let imported = 0;
      const importedEvents: string[] = [];

      for (const gcEvent of gcalEvents) {
        // Skip if already imported (by Google event ID)
        const gEventId = gcEvent.event_id || "";
        if (gcalMappings.has(gEventId)) continue;

        // Also check for title+date duplicates
        const startParsed = new Date(gcEvent.start);
        const eventDate = startParsed.toISOString().slice(0, 10);
        const isDuplicate = existingEvents.some(
          (e: any) => e.title === gcEvent.title && e.date === eventDate
        );
        if (isDuplicate) continue;

        // Map Google Calendar event → Portol event
        const startTime = gcEvent.is_all_day ? undefined : startParsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        const endParsed = gcEvent.end ? new Date(gcEvent.end) : null;
        const endTime = (gcEvent.is_all_day || !endParsed) ? undefined : endParsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

        // Determine end date for multi-day events
        let endDateStr: string | undefined;
        if (endParsed) {
          const ed = endParsed.toISOString().slice(0, 10);
          if (ed !== eventDate) endDateStr = ed;
        }

        // Guess category from title/description
        let category: "personal" | "work" | "health" | "social" | "travel" | "finance" | "family" | "education" | "other" = "personal";
        const combined = ((gcEvent.title || "") + " " + (gcEvent.description || "")).toLowerCase();
        if (/meeting|standup|sprint|retro|1:1|sync|planning|review/.test(combined)) category = "work";
        else if (/doctor|dentist|medical|appointment|therapy|vet|checkup/.test(combined)) category = "health";
        else if (/birthday|party|dinner|lunch|brunch|wedding|anniversary/.test(combined)) category = "social";
        else if (/gym|workout|run|yoga|fitness|exercise|soccer|game/.test(combined)) category = "health";
        else if (/flight|hotel|trip|travel|vacation/.test(combined)) category = "travel";

        try {
          const created = await storage.createEvent({
            title: gcEvent.title || "Untitled Event",
            date: eventDate,
            time: startTime,
            endTime: endTime,
            endDate: endDateStr,
            allDay: gcEvent.is_all_day || false,
            description: gcEvent.description || undefined,
            location: gcEvent.location || undefined,
            category,
            recurrence: "none",
            source: "external",
            linkedProfiles: [],
            linkedDocuments: [],
            tags: ["google-calendar"],
          });

          // Store the Google event ID for dedup
          await storage.setPreference(`gcal_map_${created.id}`, gEventId);

          imported++;
          importedEvents.push(gcEvent.title || "Untitled");
        } catch (err: any) {
          console.error("Failed to import event:", gcEvent.title, err.message);
        }
      }

      // Record last sync time
      await storage.setPreference("gcal_last_sync", new Date().toISOString());

      res.json({
        imported,
        total: gcalEvents.length,
        importedEvents,
        message: imported > 0
          ? `Imported ${imported} new events from Google Calendar.`
          : "All Google Calendar events are already synced.",
      });
    } catch (err: any) {
      console.error("Calendar sync error:", err);
      res.status(500).json({ error: "Calendar sync failed" });
    }
  }));

  // Export a Portol event to Google Calendar
  app.post("/api/calendar/export/:id", asyncHandler(async (req, res) => {
    try {
      const { execFileSync } = require("child_process");
      const event = await storage.getEvent(req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });

      // Parse time like "6:00 AM" or "14:00"
      let startHour = 0, startMin = 0;
      const timeMatch = (event.time || "").match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (timeMatch) {
        startHour = parseInt(timeMatch[1]);
        startMin = parseInt(timeMatch[2]);
        if (timeMatch[3]?.toUpperCase() === "PM" && startHour !== 12) startHour += 12;
        if (timeMatch[3]?.toUpperCase() === "AM" && startHour === 12) startHour = 0;
      }

      const dateStr = event.date;
      const tzOffset = (() => { const o = new Date().getTimezoneOffset(); const h = String(Math.floor(Math.abs(o)/60)).padStart(2,"0"); const m = String(Math.abs(o)%60).padStart(2,"0"); return (o <= 0 ? "+" : "-") + h + ":" + m; })();
      const startDateTime = `${dateStr}T${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}:00${tzOffset}`;

      let endHour = startHour + 1, endMin = startMin;
      if (event.endTime) {
        const endMatch = event.endTime.match(/(\d+):(\d+)\s*(AM|PM)?/i);
        if (endMatch) {
          endHour = parseInt(endMatch[1]);
          endMin = parseInt(endMatch[2]);
          if (endMatch[3]?.toUpperCase() === "PM" && endHour !== 12) endHour += 12;
          if (endMatch[3]?.toUpperCase() === "AM" && endHour === 12) endHour = 0;
        }
      }
      const endDateTime = `${event.endDate || dateStr}T${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}:00${tzOffset}`;

      const params = JSON.stringify({
        source_id: "gcal",
        tool_name: "update_calendar",
        arguments: {
          create_actions: [{
            action: "create",
            title: event.title,
            description: event.description || "",
            start_date_time: startDateTime,
            end_date_time: endDateTime,
            attendees: [],
            meeting_provider: null,
            location: event.location || null,
          }],
          delete_actions: [],
          update_actions: [],
          user_prompt: null,
        },
      });

      const stdout = execFileSync("external-tool", ["call", params], {
        timeout: 30000,
        encoding: "utf-8",
      });
      const result = JSON.parse(stdout);

      // Mark the event as synced
      await storage.updateEvent(event.id, { source: "external" } as any);

      res.json({ exported: true, title: event.title, result });
    } catch (err: any) {
      console.error("Calendar export error:", err);
      res.status(500).json({ error: "Failed to export event to Google Calendar" });
    }
  }));

  // Get sync status
  app.get("/api/calendar/sync-status", asyncHandler(async (_req, res) => {
    try {
      const lastSync = await storage.getPreference("gcal_last_sync");
      const events = await storage.getEvents();
      const gcalEvents = events.filter((e: any) => e.tags?.includes("google-calendar"));
      res.json({
        connected: true,
        lastSync,
        importedCount: gcalEvents.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get sync status" });
    }
  }));

  // Global async error handler — catches unhandled promise rejections from route handlers
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error(`[API Error]`, err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  });

  return httpServer;
}
