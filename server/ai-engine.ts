import { logger } from "./logger";
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import type { ParsedAction } from "@shared/schema";

// Lazy-init: dotenv.config() runs after ESM imports resolve,
// so we defer client creation until first use.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ============================================================
// CONTEXT CACHE — short-lived cache for AI context data (avoids repeated DB queries)
// ============================================================

interface ContextCache {
  data: any[] | null;
  timestamp: number;
}

const contextCache: ContextCache = { data: null, timestamp: 0 };
const CONTEXT_CACHE_TTL = 5000; // 5 seconds

function invalidateContextCache() {
  contextCache.data = null;
  contextCache.timestamp = 0;
}

async function getCachedContextData(): Promise<any[]> {
  const now = Date.now();
  if (contextCache.data && (now - contextCache.timestamp) < CONTEXT_CACHE_TTL) {
    return contextCache.data;
  }
  const data = await Promise.all([
    storage.getProfiles(),
    storage.getTrackers(),
    storage.getTasks(),
    storage.getExpenses(),
    storage.getEvents(),
    storage.getHabits(),
    storage.getObligations(),
    storage.getMemories(),
    storage.getDocuments(),
    storage.getGoals(),
  ]);
  contextCache.data = data;
  contextCache.timestamp = now;
  return data;
}

// ============================================================
// ACTION LOG — in-memory history of the last 20 CRUD operations
// ============================================================

interface ActionLogEntry {
  timestamp: string;
  action: string;
  type: string;
  entityName: string;
  entityId?: string;
}

const actionLog: ActionLogEntry[] = [];

function logAction(action: string, type: string, entityName: string, entityId?: string) {
  actionLog.push({ timestamp: new Date().toISOString(), action, type, entityName, entityId });
  if (actionLog.length > 20) actionLog.shift();
}

export function getActionLog(count = 10): ActionLogEntry[] {
  return actionLog.slice(-count);
}

// ============================================================
// FAST-PATH REGEX — instant processing for common patterns
// ============================================================

interface FastPathResult {
  matched: boolean;
  reply: string;
  actions: ParsedAction[];
  results: any[];
}

async function tryFastPath(message: string): Promise<FastPathResult> {
  const lower = message.toLowerCase().trim();
  const actions: ParsedAction[] = [];
  const results: any[] = [];

  // GUARD: Skip fast-path for multi-intent messages.
  // If the message contains conjunctions, multiple sentences, or commas separating actions,
  // let the AI handle it to avoid losing secondary intents.
  const multiIntentSignals = [
    /\band\s+(?:also|then|i|my|please|add|log|create|set|track|record|remind)/i,
    /[.!?]\s+[A-Z]/,     // Multiple sentences
    /,\s*(?:also|then|and|plus)/i,  // Comma-separated actions
    /\balso\b.*\b(?:add|log|create|set|track|remind|save|record)\b/i,
  ];
  if (multiIntentSignals.some(re => re.test(message))) {
    return { matched: false, reply: "", actions: [], results: [] };
  }

  // ---- Open document command: "open my drivers license", "show max's vaccination record" ----
  // Also handles multiple documents: "open my insurance and my license"
  const openDocPattern = /^(?:open\s*(?:up)?|show|view|pull\s*up|display|get|find)\s+/i;
  if (openDocPattern.test(lower)) {
    const searchPart = lower.replace(openDocPattern, "").trim();
    // Split on "and", commas, "&" to handle multiple docs
    const searchTerms = searchPart.split(/\s*(?:,|\band\b|&)\s*/).map(s => s.replace(/^(?:my|the|also|up)\s+/i, "").trim()).filter(Boolean);
    
    const [allDocuments, allProfiles] = await Promise.all([storage.getDocuments(), storage.getProfiles()]);
    const foundDocs: any[] = [];
    const documentPreviews: any[] = [];
    
    for (const term of searchTerms) {
      // Strip possessive, trailing type words, and noise words
      const cleaned = term.replace(/(?:'s|s')\s+/g, " ").replace(/\s+(?:document|file|record|report|pdf|photo|image)$/i, "").replace(/\b(?:up|the|a|an)\b/g, "").replace(/\s+/g, " ").trim();
      const cleanedWords = cleaned.split(/\s+/).filter(w => w.length > 1);
      
      // Resolve profile name from query
      const profileMatch = allProfiles.find(p => cleaned.includes(p.name.toLowerCase()));
      // Extract content words (words that aren't the profile name)
      const contentWords = cleanedWords.filter(w => !profileMatch || !profileMatch.name.toLowerCase().includes(w));

      // Score-based document matching
      const scoreDoc = (d: any): number => {
        const dName = d.name.toLowerCase();
        const dType = (d.type || "").toLowerCase();
        const dTags = (d.tags || []).map((t: string) => t.toLowerCase());
        let score = 0;
        // Full name match = highest
        if (dName.includes(cleaned)) score += 100;
        // Content word matches in name (e.g., "wellness" in "Jane Doe's Wellness Check")
        for (const w of contentWords) {
          if (dName.includes(w)) score += 30;
          if (dType.includes(w)) score += 20;
          if (dTags.some((t: string) => t.includes(w))) score += 15;
        }
        // Profile match bonus
        if (profileMatch && d.linkedProfiles.includes(profileMatch.id)) score += 25;
        // Keyword synonyms
        const synonyms: Record<string, string[]> = {
          wellness: ["medical", "health", "visit", "checkup", "check"],
          license: ["drivers", "driver", "licence", "id"],
          lab: ["blood", "results", "test"],
          insurance: ["policy", "coverage"],
        };
        for (const w of contentWords) {
          for (const [key, syns] of Object.entries(synonyms)) {
            if (syns.includes(w) && (dName.includes(key) || dType.includes(key))) score += 20;
            if (w === key && syns.some(s => dName.includes(s) || dType.includes(s))) score += 20;
          }
        }
        return score;
      }

      // Score all docs and pick the best
      const scored = allDocuments.map(d => ({ doc: d, score: scoreDoc(d) })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
      const doc = scored[0]?.doc;
      if (doc) {
        const fullDoc = await storage.getDocument(doc.id);
        actions.push({ type: "retrieve", category: "document", data: { documentId: doc.id, name: doc.name } });
        if (fullDoc) {
          results.push(fullDoc);
          foundDocs.push(fullDoc);
          documentPreviews.push({ id: fullDoc.id, name: fullDoc.name, mimeType: fullDoc.mimeType, data: fullDoc.fileData });
        }
      }
    }
    
    if (foundDocs.length > 0) {
      let reply = foundDocs.length === 1 ? `Here's "${foundDocs[0].name}"` : `Here are your ${foundDocs.length} documents:`;
      for (const doc of foundDocs) {
        if (foundDocs.length > 1) reply += `\n\n📄 ${doc.name}`;
        if (Object.keys(doc.extractedData || {}).length > 0) {
          const extracted = Object.entries(doc.extractedData)
            .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').trim()}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\n• ');
          reply += `\n• ${extracted}`;
        }
      }
      return { 
        matched: true, reply, actions, results, 
        documentPreview: documentPreviews[0] ? { id: documentPreviews[0].id, name: documentPreviews[0].name, mimeType: documentPreviews[0].mimeType, data: documentPreviews[0].data } : undefined,
        documentPreviews,
      } as any;
    }
  }

  // ---- Habit check-in: "done meditation", "did water", "checked in reading" ----
  const habitCheckinMatch = lower.match(/^(?:done|did|completed?|checked?\s*in|✓|✅)\s+(.+)/);
  if (habitCheckinMatch) {
    const habitName = habitCheckinMatch[1].trim();
    const habits = await storage.getHabits();
    const habit = habits.find(h => h.name.toLowerCase().includes(habitName));
    if (habit) {
      const checkin = await storage.checkinHabit(habit.id);
      actions.push({ type: "checkin_habit", category: "habit", data: { habitName: habit.name } });
      if (checkin) results.push(checkin);
      return { matched: true, reply: `Checked in "${habit.name}" — ${habit.currentStreak + 1}-day streak.`, actions, results };
    }
  }

  // ---- Expense and task commands go through AI for proper handling ----
  // Previously had fast-path regex here that was stripping context, losing profile links,
  // dropping dates, and preventing multi-action handling. Removed intentionally.
  // The AI handles expenses, tasks, reminders, and complex commands with full intelligence.

  // ---- Quick weight log: "weight 183", "183 lbs" ----
  const weightMatch = lower.match(/^(?:weight\s+)?(\d{2,3}(?:\.\d{1,2})?)\s*(?:lbs?|pounds?)?$/);
  if (weightMatch && !lower.includes("track")) {
    const weight = parseFloat(weightMatch[1]);
    if (weight > 80 && weight < 500) {
      const trackers = await storage.getTrackers();
      const weightTracker = trackers.find(t => t.name.toLowerCase() === "weight");
      if (weightTracker) {
        const entry = await storage.logEntry({ trackerId: weightTracker.id, values: { weight } });
        actions.push({ type: "log_entry", category: "health", data: { trackerName: "weight", weight } });
        if (entry) results.push(entry);
        const bmi = entry?.computed?.bmi;
        return { matched: true, reply: `Logged weight: ${weight} lbs${bmi ? ` (BMI: ${bmi})` : ""}`, actions, results };
      }
    }
  }

  // ---- Quick BP: "bp 120/80", "blood pressure 118/76" ----
  const bpMatch = lower.match(/^(?:bp|blood\s*pressure)\s+(\d{2,3})\s*\/\s*(\d{2,3})(?:\s+(?:pulse\s+)?(\d{2,3}))?/);
  if (bpMatch) {
    const sys = parseInt(bpMatch[1]), dia = parseInt(bpMatch[2]), pulse = bpMatch[3] ? parseInt(bpMatch[3]) : undefined;
    const trackers = await storage.getTrackers();
    const bpTracker = trackers.find(t => t.name.toLowerCase().includes("blood pressure"));
    if (bpTracker) {
      const values: Record<string, any> = { systolic: sys, diastolic: dia };
      if (pulse) values.pulse = pulse;
      const entry = await storage.logEntry({ trackerId: bpTracker.id, values });
      actions.push({ type: "log_entry", category: "health", data: { trackerName: "blood pressure", ...values } });
      if (entry) results.push(entry);
      const cat = entry?.computed?.bloodPressureCategory || "";
      return { matched: true, reply: `Logged BP: ${sys}/${dia}${pulse ? ` pulse ${pulse}` : ""}${cat ? ` — ${cat.replace(/_/g, " ")}` : ""}`, actions, results };
    }
  }

  // ---- Quick sleep: "slept 7 hours", "sleep 8.5" ----
  const sleepMatch = lower.match(/^(?:slept?|sleep)\s+(\d+(?:\.\d)?)\s*(?:hours?|hrs?)?/);
  if (sleepMatch) {
    const hours = parseFloat(sleepMatch[1]);
    const trackers = await storage.getTrackers();
    const sleepTracker = trackers.find(t => t.name.toLowerCase() === "sleep");
    if (sleepTracker) {
      const entry = await storage.logEntry({ trackerId: sleepTracker.id, values: { hours } });
      actions.push({ type: "log_entry", category: "health", data: { trackerName: "sleep", hours } });
      if (entry) results.push(entry);
      const quality = entry?.computed?.sleepQuality || "";
      return { matched: true, reply: `Logged sleep: ${hours} hours${quality ? ` (${quality} quality)` : ""}`, actions, results };
    }
  }

  // ---- Quick run: "ran 3 miles in 25:00", "ran 2.5mi" ----
  const runMatch = lower.match(/^(?:ran|run|jogged?)\s+(\d+(?:\.\d+)?)\s*(?:mi(?:les?)?|km)?\s*(?:in\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (runMatch) {
    const distance = parseFloat(runMatch[1]);
    const duration = runMatch[2] || undefined;
    const trackers = await storage.getTrackers();
    const runTracker = trackers.find(t => t.name.toLowerCase() === "running");
    if (runTracker) {
      const values: Record<string, any> = { distance };
      if (duration) values.duration = duration;
      const entry = await storage.logEntry({ trackerId: runTracker.id, values });
      actions.push({ type: "log_entry", category: "fitness", data: { trackerName: "running", ...values } });
      if (entry) results.push(entry);
      const c = entry?.computed;
      let detail = `Logged: ${distance} mi run`;
      if (c?.pace) detail += ` (${c.pace} pace)`;
      if (c?.caloriesBurned) detail += ` (~${c.caloriesBurned} cal)`;
      if (c?.heartRateZone) detail += ` — ${c.heartRateZone.replace("_", " ")} zone`;
      return { matched: true, reply: detail, actions, results };
    }
  }

  // ---- Journal shortcut: "mood good", "feeling amazing" ----
  const moodMatch = lower.match(/^(?:mood|feeling|i\s+feel)\s+(amazing|great|good|okay|neutral|bad|awful|terrible)/);
  if (moodMatch) {
    const mood = moodMatch[1] as any;
    const entry = await storage.createJournalEntry({ mood, content: message, tags: [] });
    actions.push({ type: "journal_entry", category: "journal", data: { mood } });
    results.push(entry);
    return { matched: true, reply: `Logged mood: ${mood}. Add more thoughts whenever you want.`, actions, results };
  }

  // ---- Memory save: "remember that X" ----
  const rememberMatch = lower.match(/^remember\s+(?:that\s+)?(.+)/);
  if (rememberMatch && !lower.includes("remind")) {
    const value = rememberMatch[1].trim();
    const key = value.split(/\s+/).slice(0, 3).join("_").toLowerCase().replace(/[^a-z0-9_]/g, "");
    const memory = await storage.saveMemory({ key, value, category: "general" });
    actions.push({ type: "save_memory", category: "memory", data: { key, value } });
    results.push(memory);
    return { matched: true, reply: `Remembered: "${value}"`, actions, results };
  }

  return { matched: false, reply: "", actions: [], results: [] };
}

// ============================================================
// FILE UPLOAD PROCESSING — AI Vision extraction
// ============================================================

export async function processFileUpload(
  fileName: string,
  mimeType: string,
  base64Data: string,
  userMessage?: string,
  profileId?: string
): Promise<{
  reply: string;
  actions: ParsedAction[];
  results: any[];
  documentId?: string;
  documentPreview?: { id: string; name: string; mimeType: string; data: string };
  pendingExtraction?: any;
}> {
  const actions: ParsedAction[] = [];
  const results: any[] = [];

  // Use Claude vision to analyze the image/document
  const extractionPrompt = `You are Portol AI — analyzing an uploaded file. Extract ONLY key, useful data. Be minimal and focused.

Rules:
1. DOCUMENT TYPE: (drivers_license, medical_report, receipt, insurance_card, passport, vehicle_registration, prescription, lab_results, utility_bill, bank_statement, warranty, pet_record, school_record, tax_document, other)
2. EXTRACTED DATA (identity/static only): ONLY include essential identity fields. Examples: name, date of birth, policy number, VIN, license number, visit date.
   DO NOT include: units (mg/dL, K/uL), reference ranges, interpretations, metadata, lab method, facility info, or any field that is a measurement/reading.
   Keep it to 3-6 fields MAX. Less is better.
3. TARGET PROFILE: Who does this belong to? Match to an existing profile by name.
4. TRACKER ENTRIES: Every numeric reading/measurement goes here as a tracker entry. Use human-readable names.
   - If a tracker already exists (e.g., "Weight", "LDL Cholesterol"), reuse the SAME name — don't create duplicates.
   - Include the unit in the tracker entry, NOT as a separate extracted field.
   - One entry per metric. Only include the actual measured value, not reference ranges.
5. LABEL: Short, clean label like "Luna's Blood Work - Mar 2026"

${userMessage ? `User context: "${userMessage}"` : ""}

Prioritize clarity over completeness. Only store what is actually useful. No noise.

Respond with JSON:
{
  "documentType": "lab_results",
  "label": "Luna's Blood Work - Mar 2026",
  "extractedData": { "patientName": "Luna", "visitDate": "2026-03-15", "veterinarian": "Dr. Smith" },
  "targetProfile": { "name": "Luna", "type": "pet", "matchExisting": true },
  "trackerEntries": [
    { "trackerName": "White Blood Cells", "values": { "value": 12.5 }, "unit": "K/uL", "category": "health" },
    { "trackerName": "Hemoglobin", "values": { "value": 14.2 }, "unit": "g/dL", "category": "health" },
    { "trackerName": "Platelets", "values": { "value": 250 }, "unit": "K/uL", "category": "health" }
  ],
  "summary": "Luna's blood work — 3 health metrics extracted."
}`;

  try {
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";
    const mediaType = isImage ? mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" : "image/jpeg";

    // Build content based on file type
    const messageContent: any[] = [];
    if (isImage || isPdf) {
      // Images and PDFs can be sent to Vision API
      messageContent.push({
        type: isPdf ? "document" : "image",
        source: { type: "base64", media_type: isPdf ? "application/pdf" : mediaType, data: base64Data },
      });
    } else {
      // Text files: decode and send as text
      try {
        const textContent = Buffer.from(base64Data, "base64").toString("utf-8").slice(0, 10000);
        messageContent.push({ type: "text", text: `File content of ${fileName}:\n\n${textContent}` });
      } catch {
        messageContent.push({ type: "text", text: `File: ${fileName} (${mimeType}) — could not decode content` });
      }
    }

    // Keep backward-compatible by using the old structure for images
    const response = await getClient().messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          ...messageContent,
          { type: "text", text: extractionPrompt },
        ],
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    let parsed: any;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch { parsed = {}; }

    // Resolve target profile (for linking the document), but do NOT update profile fields yet
    let linkedProfiles: string[] = [];
    let existingProfileId: string | undefined;

    if (profileId) {
      const explicitProfile = await storage.getProfile(profileId);
      if (explicitProfile) {
        linkedProfiles = [profileId];
        existingProfileId = profileId;
      }
    } else if (parsed.targetProfile?.name) {
      const profiles = await storage.getProfiles();
      const targetLower = parsed.targetProfile.name.toLowerCase().trim();
      const existing = profiles.find((p: any) => {
        const pLower = p.name.toLowerCase().trim();
        // Exact match or word-boundary match (avoid "John" matching "Johnson")
        if (pLower === targetLower) return true;
        // Check if the target is a complete word within the profile name or vice versa
        const targetRegex = new RegExp(`\\b${targetLower.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
        const profileRegex = new RegExp(`\\b${pLower.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
        return targetRegex.test(pLower) || profileRegex.test(targetLower);
      });
      if (existing) {
        linkedProfiles = [existing.id];
        existingProfileId = existing.id;
      }
      // Do NOT create new profiles automatically — defer to confirmation
    }

    // Store the document (always save the file)
    const document = await storage.createDocument({
      name: parsed.label || fileName,
      type: parsed.documentType || "other",
      mimeType,
      fileData: base64Data,
      extractedData: parsed.extractedData || {},
      linkedProfiles,
      tags: [parsed.documentType || "uploaded"],
    });
    results.push(document);

    // === AUTO-SAVE: Write extracted data to profile + create trackers immediately ===
    const savedItems: string[] = [];

    // 1. Save extracted fields to profile automatically
    if (existingProfileId && parsed.extractedData && Object.keys(parsed.extractedData).length > 0) {
      try {
        const existingProfile = await storage.getProfile(existingProfileId);
        if (existingProfile) {
          const fieldUpdates: Record<string, any> = {};
          for (const [key, value] of Object.entries(parsed.extractedData)) {
            fieldUpdates[key] = value;
          }
          await storage.updateProfile(existingProfileId, {
            fields: { ...(existingProfile.fields || {}), ...fieldUpdates },
          });
          savedItems.push(`Saved ${Object.keys(fieldUpdates).length} fields to ${existingProfile.name}'s profile`);
        }
      } catch (err: any) {
        console.error("Auto-save profile fields failed:", err.message);
      }
    }

    // 2. Auto-create trackers from extracted health/lab data
    if (parsed.trackerEntries && parsed.trackerEntries.length > 0) {
      for (const entry of parsed.trackerEntries) {
        try {
          const allTrackers = await storage.getTrackers();
          const humanName = (entry.trackerName || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
          let tracker = allTrackers.find(
            (t: any) => t.name.toLowerCase().replace(/[_\s]/g, "") === (entry.trackerName || "").toLowerCase().replace(/[_\s]/g, "")
          );
          if (!tracker) {
            const fieldKeys = Object.keys(entry.values || {});
            tracker = await storage.createTracker({
              name: humanName,
              unit: entry.unit || "",
              category: entry.category || "health",
              fields: fieldKeys.length > 0
                ? fieldKeys.map((k: string, i: number) => ({ name: k, type: "number" as const, unit: entry.unit || "", isPrimary: i === 0, options: [] }))
                : [{ name: "value", type: "number" as const, unit: entry.unit || "", isPrimary: true, options: [] }],
            });
            if (existingProfileId && tracker) {
              try { await storage.updateTracker(tracker.id, { linkedProfiles: [existingProfileId] } as any); } catch { /* non-critical */ }
            }
            savedItems.push(`Created tracker: ${humanName}`);
          }
          const entryValues = entry.values && typeof entry.values === "object" ? entry.values : { value: entry.values || 0 };
          await storage.logEntry({ trackerId: tracker.id, values: entryValues, notes: `From document: ${parsed.label || fileName}` });
          savedItems.push(`Logged ${humanName}: ${Object.values(entryValues).join(", ")} ${entry.unit || ""}`);
        } catch (err: any) {
          console.error("Auto-create tracker failed:", err.message);
        }
      }
    }

    // Build extraction fields list for the pending extraction UI
    const extractedFields: Array<{key: string; label: string; value: any; selected: boolean; isDate: boolean; suggestedEvent?: string}> = [];

    if (parsed.extractedData) {
      const DATE_PATTERNS = /\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4}/;
      for (const [key, value] of Object.entries(parsed.extractedData)) {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
        const strVal = String(value);
        const isDate = DATE_PATTERNS.test(strVal) || /expir|renew|due|valid|issued|birth|appoint/i.test(key);
        let suggestedEvent: string | undefined;
        if (isDate) {
          if (/expir/i.test(key)) suggestedEvent = `⚠️ ${parsed.label || fileName} — Expiration`;
          else if (/renew/i.test(key)) suggestedEvent = `🔄 ${parsed.label || fileName} — Renewal`;
          else if (/due/i.test(key)) suggestedEvent = `📅 ${parsed.label || fileName} — Due Date`;
          else if (/appoint/i.test(key)) suggestedEvent = `🗓️ ${parsed.label || fileName} — Appointment`;
          else if (/valid|issued/i.test(key)) suggestedEvent = undefined;
          else suggestedEvent = `📅 ${label}: ${strVal}`;
        }
        DATE_PATTERNS.lastIndex = 0; // reset regex state
        extractedFields.push({ key, label, value, selected: true, isDate, suggestedEvent });
      }
    }

    const pendingExtraction = {
      extractionId: document.id,
      fileName,
      documentType: parsed.documentType || "other",
      label: parsed.label || fileName,
      extractedFields,
      targetProfile: parsed.targetProfile ? {
        name: parsed.targetProfile.name,
        id: existingProfileId || undefined,
        type: parsed.targetProfile.type,
        isNew: !existingProfileId,
      } : undefined,
      trackerEntries: parsed.trackerEntries || [],
      documentPreview: { id: document.id, name: document.name, mimeType: document.mimeType, data: document.fileData },
    };

    let reply = parsed.summary || `Processed "${fileName}"`;
    if (savedItems.length > 0) {
      reply += `\n\n\u2705 Auto-saved:\n\u2022 ${savedItems.join("\n\u2022 ")}`;
    }
    if (existingProfileId) {
      const profileName = (await storage.getProfile(existingProfileId))?.name;
      reply += `\n\n\ud83d\udcce Linked to ${profileName || "profile"}.`;
    }
    reply += `\n\nDocument saved. Say "open ${parsed.label || fileName}" anytime to view it.`;

    const documentPreview = {
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      data: document.fileData,
    };

    return { reply, actions, results, documentId: document.id, documentPreview, pendingExtraction };
  } catch (err: any) {
    console.error("File extraction error:", err.message);
    // Still store the document even if AI fails
    const document = await storage.createDocument({
      name: fileName,
      type: "other",
      mimeType,
      fileData: base64Data,
      extractedData: {},
      linkedProfiles: profileId ? [profileId] : [],
      tags: ["uploaded"],
    });
    const documentPreview = {
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      data: document.fileData,
    };
    return {
      reply: `Saved "${fileName}" but couldn't extract data automatically. You can link it to a profile manually.`,
      actions: [],
      results: [document],
      documentId: document.id,
      documentPreview,
    };
  }
}

// ============================================================
// ANTHROPIC TOOL DEFINITIONS
// ============================================================

const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  // --- Data Query Tools ---
  {
    name: "search",
    description: "Search across all entities (profiles, trackers, tasks, expenses, events, habits, obligations, documents, memories). Use when the user asks to find something or asks about existing data.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        forProfile: { type: "string", description: "Filter search results to a specific profile. Use when searching for a specific person's data." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_profile_data",
    description: "Get ALL data for a specific person or pet profile — their tasks, expenses, trackers, events, documents, obligations, child profiles (assets/subscriptions), and timeline. Use when the user asks about a specific person's data like 'What does Rex have?', 'Show me Mom's stuff', 'What's going on with Luna?'",
    input_schema: {
      type: "object" as const,
      properties: {
        profileName: { type: "string", description: "Name of the profile (person/pet) to get data for. Partial match is fine." },
      },
      required: ["profileName"],
    },
  },
  {
    name: "get_summary",
    description: "Get summary statistics for a specific entity type or all data. Use when the user asks for an overview, stats, totals, or 'how many'. Supports filtering by profile — e.g., 'How many tasks does Rex have?' → forProfile: 'Rex'.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_type: {
          type: "string",
          enum: ["profiles", "trackers", "tasks", "expenses", "events", "habits", "obligations", "journal", "documents", "all"],
          description: "Which entity type to summarize",
        },
        time_range: {
          type: "string",
          enum: ["today", "week", "month", "all"],
          description: "Time range for the summary",
        },
        forProfile: {
          type: "string",
          description: "Filter results to a specific profile (person, pet, etc.). Use when the user asks about a specific person's data — e.g., 'Rex's expenses', 'Mom's tasks'. Set to the profile name.",
        },
      },
      required: ["entity_type"],
    },
  },
  {
    name: "recall_memory",
    description: "Recall previously saved facts/memories about the user. Use when user asks 'do you remember...', 'what's my...', or references previously stored info.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "What to recall" },
      },
      required: ["query"],
    },
  },

  // --- CRUD: Profiles ---
  {
    name: "create_profile",
    description: "Create a new profile. Choose the right type and include entity-specific fields. Pet: breed, species, color, birthday, weight. Vehicle: make, model, year, VIN, mileage, color. Loan: lender, amount, apr, term, monthlyPayment. Property: address, type, sqft, bedrooms. Asset: brand, model, purchaseDate, purchasePrice, serialNumber, warranty. Subscription: provider, plan, cost, renewalDate. Medical: specialty, clinic, phone. Person: phone, email, relationship, birthday.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["person", "pet", "vehicle", "account", "property", "subscription", "medical", "self", "loan", "investment", "asset"],
          description: "Profile type — choose based on what the entity IS, not what the user calls it. Dog/cat/bird → pet. Car/truck → vehicle. Laptop/phone → asset. Netflix/Spotify → subscription. Doctor → medical.",
        },
        name: { type: "string", description: "Name of the profile" },
        fields: { type: "object", description: "Entity-specific fields. Include ALL known info in the right keys." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        notes: { type: "string", description: "Additional notes" },
      },
      required: ["type", "name"],
    },
  },
  {
    name: "update_profile",
    description: "Update an existing profile's data. Use this for personal info (blood type, allergies, height, birthday, phone number), pet info (breed, weight, microchip), vehicle info (VIN, mileage, insurance), or any profile field update. Find by name, then apply changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the profile to update (partial match). Use 'Me' for self profile." },
        changes: { type: "object", description: "Fields to update — use 'fields' object for data like { bloodType: 'O+', allergies: 'penicillin', height: '5\'10\"' }. Can also include 'notes' (string) or 'tags' (array)." },
      },
      required: ["name", "changes"],
    },
  },
  {
    name: "delete_profile",
    description: "Delete a profile by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the profile to delete (partial match)" },
      },
      required: ["name"],
    },
  },

  // --- CRUD: Tasks ---
  {
    name: "create_task",
    description: "Create a new task or reminder.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Task title" },
        priority: { type: "string", enum: ["low", "medium", "high"], description: "Priority level" },
        dueDate: { type: "string", description: "Due date (YYYY-MM-DD)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        forProfile: { type: "string", description: "Name of the profile this task belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this when the user mentions a specific person, pet, vehicle, or entity." },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as complete. Find by title (partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the task to complete (partial match)" },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a task by title.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the task to delete (partial match)" },
      },
      required: ["title"],
    },
  },

  // --- CRUD: Trackers ---
  {
    name: "log_tracker_entry",
    description: "Log values to an existing tracker. Use for health data (weight, blood pressure, sleep), fitness (running, cycling), nutrition, or any custom tracker.",
    input_schema: {
      type: "object" as const,
      properties: {
        trackerName: { type: "string", description: "Name of the tracker (partial match)" },
        values: { type: "object", description: "Key-value pairs to log. Include ALL relevant fields. For nutrition: { calories, protein, carbs, fat, sugar, fiber, item }. For running: { distance, duration, pace, caloriesBurned }. For BP: { systolic, diastolic }. For weight: { weight }. For sleep: { hours, quality }." },
        notes: { type: "string", description: "Optional context notes for this entry (e.g., 'morning reading', 'after workout', 'chicken sandwich from subway')" },
        forProfile: { type: "string", description: "Name of the profile this entry belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this when the user mentions a specific person, pet, vehicle, or entity." },
      },
      required: ["trackerName", "values"],
    },
  },
  {
    name: "create_tracker",
    description: "Create a new tracker. Use smart field definitions: Blood Pressure needs fields [systolic:number, diastolic:number, pulse:number]. Weight needs [weight:number]. Running needs [distance:number, duration:number, pace:number, caloriesBurned:number]. Sleep needs [hours:number, quality:text]. Nutrition needs [calories:number, protein:number, carbs:number, fat:number, sugar:number, fiber:number, item:text]. Medication needs [medication:text, dosage:text, time:text]. Always create compound fields for compound measurements.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tracker name" },
        category: { type: "string", description: "Category (health, fitness, nutrition, sleep, finance, custom)" },
        unit: { type: "string", description: "Unit of measurement" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["number", "text", "boolean", "select", "duration"] },
            },
          },
          description: "Field definitions",
        },
        forProfile: { type: "string", description: "Name of the profile this tracker belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this when the user mentions a specific person, pet, vehicle, or entity." },
      },
      required: ["name"],
    },
  },

  // --- CRUD: Expenses ---
  {
    name: "create_expense",
    description: "Log a financial expense.",
    input_schema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Amount in dollars" },
        description: { type: "string", description: "What was purchased" },
        category: { type: "string", description: "Category. MUST be one of: food, transport, health, pet, vehicle, entertainment, shopping, utilities, housing, insurance, subscription, education, personal, general. Auto-detect from context (e.g., vet visit → pet, oil change → vehicle, groceries → food)." },
        vendor: { type: "string", description: "Store or vendor name" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        forProfile: { type: "string", description: "Name of the profile this expense belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this when the user mentions a specific person, pet, vehicle, or entity." },
      },
      required: ["amount", "description"],
    },
  },
  {
    name: "delete_expense",
    description: "Delete an expense by description.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Description of the expense to delete (partial match)" },
      },
      required: ["description"],
    },
  },

  // --- CRUD: Events ---
  {
    name: "create_event",
    description: "Create a calendar event.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date (YYYY-MM-DD)" },
        time: { type: "string", description: "Start time (HH:MM)" },
        endTime: { type: "string", description: "End time (HH:MM)" },
        location: { type: "string", description: "Location" },
        description: { type: "string", description: "Description" },
        recurrence: { type: "string", enum: ["none", "daily", "weekly", "biweekly", "monthly", "yearly"], description: "Recurrence pattern" },
        forProfile: { type: "string", description: "Name of the profile this event belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this when the user mentions a specific person, pet, vehicle, or entity." },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "update_event",
    description: "Update an existing calendar event. Find by title, then apply changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the event to update (partial match)" },
        changes: { type: "object", description: "Fields to update (date, time, location, description, recurrence, etc.)" },
      },
      required: ["title", "changes"],
    },
  },

  // --- CRUD: Habits ---
  {
    name: "create_habit",
    description: "Create a new habit to track.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Habit name" },
        frequency: { type: "string", enum: ["daily", "weekly", "custom"], description: "Frequency" },
        icon: { type: "string", description: "Emoji icon" },
        color: { type: "string", description: "Color hex" },
      },
      required: ["name"],
    },
  },
  {
    name: "checkin_habit",
    description: "Check in to a habit (mark it done for today). Find by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Habit name (partial match)" },
      },
      required: ["name"],
    },
  },

  // --- CRUD: Obligations ---
  {
    name: "create_obligation",
    description: "Create a recurring bill, subscription, or financial obligation. A subscription profile is auto-created and linked to the specified person/pet.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Obligation name" },
        amount: { type: "number", description: "Amount" },
        frequency: { type: "string", enum: ["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"], description: "Payment frequency" },
        nextDueDate: { type: "string", description: "Next due date (YYYY-MM-DD)" },
        category: { type: "string", description: "Category (rent, utilities, insurance, subscription, loan, etc.)" },
        autopay: { type: "boolean", description: "Whether this is on autopay" },
        forProfile: { type: "string", description: "Name of the person/pet this obligation belongs to (e.g. 'Max', 'Mom', 'Luna'). The auto-created subscription profile will be nested under this person/pet. ALWAYS set this when the user mentions a specific person or pet." },
      },
      required: ["name", "amount", "frequency"],
    },
  },
  {
    name: "pay_obligation",
    description: "Record a payment for an obligation. Find by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Obligation name (partial match)" },
        amount: { type: "number", description: "Amount paid (defaults to obligation amount)" },
        method: { type: "string", description: "Payment method" },
        confirmationNumber: { type: "string", description: "Confirmation number" },
      },
      required: ["name"],
    },
  },

  // --- Journal ---
  {
    name: "journal_entry",
    description: "Create a journal/mood entry.",
    input_schema: {
      type: "object" as const,
      properties: {
        mood: { type: "string", enum: ["amazing", "great", "good", "neutral", "bad", "awful"], description: "Mood level. Map user's words: 'amazing/incredible/fantastic' → amazing, 'great/wonderful/excellent' → great, 'good/fine/okay' → good, 'meh/so-so/alright' → neutral, 'bad/rough/down' → bad, 'awful/terrible/horrible' → awful" },
        content: { type: "string", description: "Journal content" },
        energy: { type: "number", description: "Energy level 1-5" },
        gratitude: { type: "array", items: { type: "string" }, description: "Things grateful for" },
        highlights: { type: "array", items: { type: "string" }, description: "Day highlights" },
      },
      required: ["mood"],
    },
  },

  // --- Artifacts ---
  {
    name: "create_artifact",
    description: "Create a checklist or note.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["checklist", "note"], description: "Artifact type" },
        title: { type: "string", description: "Title" },
        content: { type: "string", description: "Content (for notes)" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
          description: "Checklist items",
        },
      },
      required: ["type", "title"],
    },
  },

  // --- Memory ---
  {
    name: "save_memory",
    description: "Save a fact or piece of information about the user for later recall. Use when user says 'remember that...' or states a personal fact.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Short identifier key (e.g., 'favorite_food', 'doctor_name')" },
        value: { type: "string", description: "The fact to remember" },
        category: { type: "string", description: "Category (preferences, facts, health, goals, general)" },
      },
      required: ["key", "value"],
    },
  },

  // --- Documents ---
  {
    name: "open_document",
    description: "Search for and open a stored document. Returns document data for display.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query to find the document" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_document",
    description: "Create a new text document.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Document name" },
        content: { type: "string", description: "Document content (text)" },
        forProfile: { type: "string", description: "Name of profile to link this document to" },
      },
      required: ["name"],
    },
  },

  // --- Navigation ---
  {
    name: "navigate",
    description: "Navigate the UI to a specific page. Use when user says 'go to...', 'show me...', 'open dashboard', etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        page: {
          type: "string",
          enum: ["dashboard", "chat", "trackers", "profiles", "profile_detail"],
          description: "Page to navigate to",
        },
        profileId: { type: "string", description: "Profile ID (only for profile_detail)" },
      },
      required: ["page"],
    },
  },

  // --- Goals ---
  {
    name: "create_goal",
    description: "Create a new measurable goal. Use when user says things like 'I want to lose 10 lbs by June' or 'My goal is to run 100 miles this quarter' or 'I want to save $5000'.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Goal title" },
        type: { type: "string", enum: ["weight_loss", "weight_gain", "savings", "habit_streak", "spending_limit", "fitness_distance", "fitness_frequency", "tracker_target", "custom"], description: "Goal type" },
        target: { type: "number", description: "Target value" },
        unit: { type: "string", description: "Unit of measurement (lbs, $, miles, days, entries)" },
        startValue: { type: "number", description: "Starting value (for weight goals, current weight)" },
        deadline: { type: "string", description: "ISO date deadline (YYYY-MM-DD)" },
        trackerId: { type: "string", description: "Linked tracker name (will be resolved to ID)" },
        habitId: { type: "string", description: "Linked habit name (will be resolved to ID)" },
        category: { type: "string", description: "Expense category for spending goals" },
      },
      required: ["title", "type", "target", "unit"],
    },
  },
  {
    name: "get_goal_progress",
    description: "Check progress on goals. Use when user asks 'How am I doing on my goals?' or 'What's my goal progress?' or mentions a specific goal.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional search query to find specific goal" },
      },
    },
  },
  {
    name: "update_goal",
    description: "Update or complete a goal. Use when user wants to mark a goal complete, change the target, or abandon a goal.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Goal title to find (partial match)" },
        status: { type: "string", enum: ["active", "completed", "abandoned"], description: "New status" },
        target: { type: "number", description: "New target value" },
        deadline: { type: "string", description: "New deadline (ISO date)" },
      },
      required: ["title"],
    },
  },

  // --- Entity Links ---
  {
    name: "link_entities",
    description: "Create a link between two entities. Use when the user says 'link X to Y', 'X belongs to Y', or when you detect a relationship between entities (e.g., an expense is for a profile).",
    input_schema: {
      type: "object" as const,
      properties: {
        source_type: { type: "string", enum: ["profile", "document", "expense", "task", "tracker", "event", "habit", "obligation"], description: "Source entity type" },
        source_id: { type: "string", description: "Source entity ID" },
        target_type: { type: "string", enum: ["profile", "document", "expense", "task", "tracker", "event", "habit", "obligation"], description: "Target entity type" },
        target_id: { type: "string", description: "Target entity ID" },
        relationship: { type: "string", enum: ["belongs_to", "paid_for", "tracks", "document_for", "related_to"], description: "Type of relationship" },
      },
      required: ["source_type", "source_id", "target_type", "target_id", "relationship"],
    },
  },
  {
    name: "get_related",
    description: "Get all entities related/linked to a given entity. Use when user asks 'what's related to X', 'show everything for my Tesla', 'what expenses are linked to Max'.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_type: { type: "string", enum: ["profile", "document", "expense", "task", "tracker", "event", "habit", "obligation"], description: "Entity type" },
        entity_id: { type: "string", description: "Entity ID" },
      },
      required: ["entity_type", "entity_id"],
    },
  },
  {
    name: "update_task",
    description: "Update an existing task. Find by title (partial match), then apply changes like new title, description, priority, due date, or status.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the task to update (partial match)" },
        changes: { type: "object", description: "Fields to update — can include 'title', 'description', 'priority', 'dueDate', 'status', 'tags'" },
      },
      required: ["title", "changes"],
    },
  },
  {
    name: "update_expense",
    description: "Update an existing expense. Find by description (partial match), then apply changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Description of the expense to find (partial match)" },
        changes: { type: "object", description: "Fields to update — can include 'amount', 'category', 'description', 'vendor', 'date'" },
      },
      required: ["description", "changes"],
    },
  },
  {
    name: "update_obligation",
    description: "Update a recurring obligation/bill. Find by name (partial match), then apply changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the obligation (partial match)" },
        changes: { type: "object", description: "Fields to update — can include 'name', 'amount', 'frequency', 'nextDueDate', 'category', 'autopay', 'notes'" },
      },
      required: ["name", "changes"],
    },
  },
  {
    name: "update_habit",
    description: "Update a habit. Find by name (partial match), then apply changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Habit name (partial match)" },
        changes: { type: "object", description: "Fields to update — can include 'name', 'icon', 'color', 'frequency', 'targetDays'" },
      },
      required: ["name", "changes"],
    },
  },
  {
    name: "delete_habit",
    description: "Delete a habit by name. This also removes all check-in history.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Habit name (partial match)" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_obligation",
    description: "Delete a recurring obligation/bill by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Obligation name (partial match)" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event by title.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title (partial match)" },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_tracker",
    description: "Delete a tracker and ALL its entries. This is irreversible.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tracker name (partial match)" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_tracker",
    description: "Update an existing tracker's name, category, or unit.",
    input_schema: {
      type: "object" as const,
      properties: {
        trackerName: { type: "string", description: "Current name of the tracker (partial match)" },
        changes: { type: "object", description: "Fields to update: name, category, unit" },
      },
      required: ["trackerName", "changes"],
    },
  },
  {
    name: "delete_journal",
    description: "Delete a journal entry by date.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Date of the entry (YYYY-MM-DD)" },
      },
      required: ["date"],
    },
  },
  {
    name: "update_journal",
    description: "Update an existing journal entry's content, mood, or tags.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Date of the journal entry to update (YYYY-MM-DD)" },
        changes: { type: "object", description: "Fields to update: content, mood, tags" },
      },
      required: ["date", "changes"],
    },
  },
  {
    name: "delete_artifact",
    description: "Delete an artifact (note, checklist, etc.) by title.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Artifact title (partial match)" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_artifact",
    description: "Update an existing artifact's title or content.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Current title of the artifact (partial match)" },
        changes: { type: "object", description: "Fields to update: title, content, items (for checklists)" },
      },
      required: ["title", "changes"],
    },
  },
  {
    name: "delete_goal",
    description: "Delete a goal by title.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Goal title (partial match)" },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_memory",
    description: "Delete a saved memory/fact by key or content match.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Memory key or content to search for (partial match)" },
      },
      required: ["query"],
    },
  },
  {
    name: "bulk_complete_tasks",
    description: "Mark multiple tasks as complete at once. Use when user says 'complete all tasks', 'mark everything done', or 'finish all overdue tasks'.",
    input_schema: {
      type: "object" as const,
      properties: {
        filter: { type: "string", enum: ["all", "overdue", "today"], description: "Which tasks to complete" },
      },
      required: ["filter"],
    },
  },
  {
    name: "undo_last",
    description: "Undo the last action. Use when user says 'undo', 'undo that', 'take that back', 'revert'.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "recall_actions",
    description: "Recall recent actions — shows the last N things you did in Portol. Use when user asks 'what did I just do?', 'show recent actions', 'what happened?', or 'my recent activity'.",
    input_schema: {
      type: "object" as const,
      properties: {
        count: { type: "number", description: "How many recent actions to show (default 10, max 20)" },
      },
      required: [],
    },
  },
  {
    name: "sync_calendar",
    description: "Sync events with Google Calendar. Imports new events from Google Calendar into Portol. Use when the user asks to sync, import, or pull their Google Calendar events.",
    input_schema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["import", "both"],
          description: "Sync direction — 'import' to pull from Google Calendar (default), 'both' for bidirectional",
        },
      },
      required: [],
    },
  },
  {
    name: "create_domain",
    description: "Create a new custom domain/category for tracking custom data.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Domain name" },
        description: { type: "string", description: "Domain description" },
        fields: { type: "array", items: { type: "object" }, description: "Field definitions: [{name, type}]" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_domain",
    description: "Update an existing domain's name or description.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Current name of the domain (partial match)" },
        changes: { type: "object", description: "Fields to update: name, description" },
      },
      required: ["name", "changes"],
    },
  },
  {
    name: "delete_domain",
    description: "Delete a domain by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the domain to delete (partial match)" },
      },
      required: ["name"],
    },
  },
  {
    name: "retrieve_document",
    description: "Retrieve and display a document. Use when user asks to see, open, show, or view a document. Understands ownership — e.g., 'show my mom\\'s birth certificate' resolves Mom profile then finds linked documents. Also works by document name or type.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language description of the document to find" },
        profileName: { type: "string", description: "Name of the person/entity who owns the document (e.g., 'Mom', 'Max', 'Tesla')" },
        documentType: { type: "string", description: "Document type filter (drivers_license, medical_report, insurance_card, passport, etc.)" },
      },
      required: ["query"],
    },
  },
];

// ============================================================
// SYSTEM PROMPT (simplified — no JSON format instructions)
// ============================================================

function buildSystemPrompt(context: string): string {
  return `You are Portol AI — the brain of a centralized personal life operating system. You help users manage their entire life: profiles (people, pets, vehicles, accounts), health tracking, tasks, expenses, calendar events, habits, obligations, journal entries, memories, and documents.

EXISTING DATA (reference these when the user mentions them):
${context}

BEHAVIOR:
- Be concise and confirm what you did after each action.
- Handle multiple actions in one message when appropriate.
- When the user mentions an existing entity, match it by name (partial matching is fine).
- CRITICAL NUTRITION DETECTION: When a user mentions ANY food or drink consumption, ALWAYS log it as a NUTRITION tracker entry with estimated calories, protein, carbs, fat, sugar — NOT as an expense. This includes:
  - Eating: "ate a sandwich", "had lunch", "ate chicken", "had pizza"
  - Drinking: "drank a Coke", "had coffee", "drank a smoothie", "had a beer", "drank water"
  - Snacking: "had some chips", "ate candy", "grabbed a donut"
  Only create an expense if the user explicitly mentions a dollar amount ("$12 lunch").
  Example: "I ate a chicken sandwich and ran 2 miles" → log_tracker_entry for Nutrition (calories, protein, carbs, fat) + log_tracker_entry for Running (distance, estimated calories burned). TWO separate tracker entries.
  Example: "I drank a Coke" → log_tracker_entry for Nutrition with: calories: ~140, sugar: 39g, carbs: 39g, protein: 0, fat: 0. Include the item name in notes.
  Example: "Had a grande latte from Starbucks" → log_tracker_entry for Nutrition with estimated macros for a 16oz latte.
- When creating tracker entries, use MULTIPLE tracker calls if the message describes multiple different activities (eating + exercise = 2 separate entries to 2 different trackers).
- RECURRING EXPENSES / SUBSCRIPTIONS: When a user mentions a recurring payment, subscription, or bill ("I pay $X per month for Y", "subscription costs $X", "$11 Spotify every month"), use create_obligation ONLY. Do NOT also call create_event or create_expense for the same item. A subscription profile is automatically created behind the scenes — do NOT call create_profile separately. Obligations automatically generate recurring calendar entries on their due dates. Creating an event AND an obligation for the same bill causes DUPLICATE calendar entries — this is a critical bug to avoid. ONE tool call (create_obligation) handles everything: obligation + profile + calendar entries.
  In your response, mention that both a profile and a bill were created. Example: "Created Spotify subscription profile + $11/month bill — will show on Calendar every month."
- EVENT NAMING: ALWAYS include the full detail in event titles. "Meeting with Dr. Chan" not "Meeting". "Tesla Model 3 Oil Change" not "Oil Change". Preserve names, entities, and context in all titles.
- MULTI-ACTION: When a message contains multiple actions (e.g., "schedule X and also add expense Y"), execute ALL of them — never drop an action. If a user sends 10 actions, you MUST execute exactly 10 tool calls. Do not merge or skip any.
- For conversational messages with no actions needed, just respond naturally without calling any tools.
- When creating tasks from reminders, extract the due date if mentioned.
- When searching, use the search tool to find relevant data before answering.

TOOL CHOICE RULES — CRITICAL:
- "X owes me $Y" or "collect $Y from X" → ALWAYS create_task with title like "Collect $Y from X for Z" and forProfile: "X". NEVER use save_memory for debts/money owed.
- "My blood type is X" or personal health facts about me (allergies, height, etc.) → ALWAYS update_profile on the "self" profile to add/update the field. NEVER use save_memory for profile-level health data.
- "X's birthday is Y" → create_event (yearly recurring) AND update_profile to set birthday field on X's profile.
- save_memory should ONLY be used for abstract preferences, facts, or context that doesn't fit any structured data type (e.g., "Remember that I prefer window seats", "I'm vegetarian").

SECONDARY DATA EXTRACTION — critical. When logging tracker entries, compute all possible secondary data:

For EXERCISE entries (running, cycling, swimming, etc.):
- Always estimate calories burned (running: ~100cal/mi, cycling: ~50cal/mi, swimming: ~10cal/min, walking: ~80cal/mi, weights: ~7cal/min)
- Calculate pace if distance + duration given
- Estimate heart rate zone from intensity
- Include these estimates in your reply

For FOOD/NUTRITION entries:
- Always estimate calories if not given
- Estimate macros (protein, carbs, fat in grams) when possible

For SLEEP: Calculate sleep quality (≥8h: excellent, ≥7h: good, ≥6h: fair, <6h: poor)
For BLOOD PRESSURE: Classify per AHA guidelines:
  - Normal: systolic < 120 AND diastolic < 80
  - Elevated: systolic 120-129 AND diastolic < 80
  - High Stage 1: systolic 130-139 OR diastolic 80-89 (note: 120/80 is borderline normal — mention it's at the upper edge of normal, don't alarm the user)
  - High Stage 2: systolic >= 140 OR diastolic >= 90
  - Crisis: systolic >= 180 OR diastolic >= 120
For WEIGHT: Note trend direction if previous entries exist

TRACKER FIELD MATCHING — CRITICAL:
When logging to an existing tracker, check its field names in the EXISTING DATA context. Only send values with keys that match the tracker's defined fields. For example:
- Sleep tracker has fields [hours] → send {"hours": 6.5}, NOT {"duration": 6.5}
- Weight tracker has fields [weight] → send {"weight": 183}, NOT {"value": 183}
- If you need to store extra data that doesn't match a field, use the "notes" parameter instead

MULTI-PROFILE AWARENESS — CRITICAL:
The system manages data for MULTIPLE people and pets. Each person/pet has their own tasks, expenses, trackers, events, documents, subscriptions, and assets. Data must NEVER cross between profiles.

When the user mentions a specific person, pet, or entity, you MUST:
1. Set "forProfile" on ALL tool calls involving that person/pet
2. Use get_profile_data to retrieve a specific person's full data when asked
3. Use get_summary with forProfile to get stats filtered to that person
4. Use search with forProfile to search within a person's data

PROFILE RESOLUTION:
- "Mom's iPhone" → resolve Mom as the profile, iPhone as a child asset under Mom
- "Rex's vet records" → resolve Rex as the profile, search his documents
- "Luna's weight" → resolve Luna, query her weight tracker
- "What does Rex have?" → get_profile_data with profileName: "Rex"
- "How much have I spent on Luna?" → get_summary type: "expenses" forProfile: "Luna"
- "Show Mom's calendar" → get_summary type: "events" forProfile: "Mom"

ACTION EXAMPLES:
- "Create a task for Max to get groomed" → create_task with forProfile: "Max"
- "Log $50 expense for Tesla oil change" → create_expense with forProfile: "Tesla"
- "Create a blood pressure tracker for Mom" → create_tracker with forProfile: "Mom"
- "Log Max's weight at 32 lbs" → log_tracker_entry with forProfile: "Max"
- "Schedule a vet appointment for Max" → create_event with forProfile: "Max"
- "Schedule an oil change for my Tesla" → create_event with forProfile: "Tesla" (vehicle profile)
- "My car needs maintenance next month" → create_event with forProfile matching the vehicle profile name
- "What are Rex's upcoming events?" → get_summary type: "events" forProfile: "Rex"
- "Tell me about Luna" → get_profile_data profileName: "Luna"

VEHICLE/ASSET LINKING: When creating events, tasks, or expenses that mention a vehicle, car, or asset, ALWAYS set forProfile to the vehicle's profile name. This ensures the item appears on the vehicle's timeline. Example: "oil change for the Honda" → forProfile: "Honda Civic" (or whatever the vehicle profile is named).

For multi-action messages like "Create a task for Max and log an expense for my car", set the correct forProfile on EACH tool call separately ("Max" for the task, "Tesla" for the expense).

GOOGLE CALENDAR: Events can be synced with Google Calendar. If the user asks to sync or import their calendar, tell them to click the "Sync Google Calendar" button on the dashboard or calendar view. You can create/update events in Portol which can then be exported to Google Calendar via the export button. Events imported from Google Calendar are tagged with "google-calendar".

DOCUMENT RETRIEVAL — intelligent & relationship-aware:
When a user asks to see, open, show, or view a document, use the retrieve_document tool. You understand ownership and relationships:
- "Show my mom's birth certificate" → retrieve_document with profileName: "Mom", documentType: "birth_certificate"
- "Open Max's vaccination records" → retrieve_document with profileName: "Max", documentType: "pet_record"
- "Pull up my driver's license" → retrieve_document with query: "driver's license"
- "Show all medical records for Mom" → retrieve_document with profileName: "Mom", documentType: "medical_report"
Always resolve the owner (person, pet, vehicle) from context before searching documents.

DATE AWARENESS — route dates to the calendar:
Whenever you encounter dates in ANY context (document extraction, user messages, data entry), identify and call out actionable dates:
- Expiration dates → suggest creating a reminder event
- Due dates → suggest creating a task or event
- Appointment dates → create an event
- Renewal dates → create a recurring event
For document extractions, dates are automatically detected and presented to the user for calendar routing.

CHAT-FIRST PHILOSOPHY:
You are the universal interface to ALL data in Portol. Every piece of data — documents, events, finances, health, profiles — is accessible through you. When users ask questions about their data, search proactively. When they mention documents, retrieve them. When they mention dates, route them to the calendar. You are the single point of intelligence for the user's entire life data.

RESPONSE FORMAT:
After completing actions, confirm EACH one with WHERE to find it:
- Expense → "Saved to Finance page + [Profile]'s Expenses tab"
- Task → "Added to Tasks page + Calendar on [date]"
- Event → "Scheduled in Calendar on [date] at [time]"
- Tracker entry → "Logged to [Tracker] in Trackers page + [Profile]'s Health tab"
- Obligation → "Added to Bills — will show on Calendar every [frequency]"
- Profile update → "Updated [Profile] → visible in Profiles page"
This helps the user trust and verify the data.

Current date/time: ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' })} (Pacific Time).
Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles' })}.
CRITICAL DATE RULES:
- "tomorrow" = the day AFTER today in Pacific Time. Calculate carefully.
- "by Friday" or "this Friday" = if today IS Friday, that means TODAY. If today is before Friday, it means the upcoming Friday of this week. NEVER push to next week.
- "next Friday" = the Friday of NEXT week (7+ days away).
- "this Saturday", "this Monday", etc. = the nearest upcoming occurrence. If today IS that day, it means TODAY.
- "before May 10" = set the due date to May 9.
- ALWAYS double-check: what day of the week is today? Then count forward from there.
- If today is Friday and the user says "by Friday", the date is TODAY's date, not tomorrow.
- ALWAYS double-check your date math. If today is Wednesday March 26, then tomorrow is Thursday March 27 — NOT March 28.
- When creating events or tasks with dates, state the resolved date explicitly in your response so the user can verify.`;
}

// ============================================================
// RESULT SUMMARIZATION — don't send huge objects back to Claude
// ============================================================

function summarizeResult(result: any): any {
  if (!result) return { status: "not_found" };

  // Arrays (e.g., search results, memory recall)
  if (Array.isArray(result)) {
    return result.slice(0, 10).map((item: any) => {
      if (item.fileData) {
        const { fileData, ...rest } = item;
        return { ...rest, hasFileData: true };
      }
      return summarizeSingleItem(item);
    });
  }

  return summarizeSingleItem(result);
}

function summarizeSingleItem(item: any): any {
  if (!item) return item;

  // Never send fileData to Claude
  if (item.fileData) {
    const { fileData, ...rest } = item;
    return {
      ...rest,
      hasFileData: true,
      extractedDataKeys: item.extractedData ? Object.keys(item.extractedData) : [],
    };
  }

  // Trim tracker entries for summaries (don't send all entries)
  if (item.entries && Array.isArray(item.entries)) {
    return {
      ...item,
      entries: item.entries.slice(-3).map((e: any) => ({
        id: e.id,
        values: e.values,
        computed: e.computed,
        timestamp: e.timestamp,
      })),
      totalEntries: item.entries.length,
    };
  }

  // For payment results, checkin results, etc. — they're already small
  return item;
}

// ============================================================
// TOOL EXECUTION — maps tool names to storage operations
// ============================================================

async function executeTool(name: string, input: any): Promise<any> {
  switch (name) {
    case "search": {
      const results = await storage.search(input.query);
      // Filter by profile if specified
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const matchedProfile = profiles.find(p => p.name.toLowerCase().includes(input.forProfile.toLowerCase()));
        if (matchedProfile) {
          const pid = matchedProfile.id;
          return results.filter((r: any) => {
            if (r.linkedProfiles && Array.isArray(r.linkedProfiles)) return r.linkedProfiles.includes(pid);
            return true; // Keep items without linkedProfiles
          });
        }
      }
      return results;
    }

    case "get_profile_data": {
      const profiles = await storage.getProfiles();
      const profile = profiles.find(p => p.name.toLowerCase().includes((input.profileName || "").toLowerCase()));
      if (!profile) return { error: `No profile found matching "${input.profileName}"` };
      const detail = await storage.getProfileDetail(profile.id);
      if (!detail) return { error: "Could not load profile data" };
      return {
        name: detail.name,
        type: detail.type,
        fields: detail.fields,
        tasks: detail.relatedTasks.map(t => ({ title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate })),
        expenses: detail.relatedExpenses.map(e => ({ description: e.description, amount: e.amount, category: e.category, date: e.date })),
        trackers: detail.relatedTrackers.map(t => ({ name: t.name, category: t.category, entryCount: t.entries.length, latestEntry: t.entries[t.entries.length - 1]?.values })),
        events: detail.relatedEvents.map(e => ({ title: e.title, date: e.date, time: e.time })),
        documents: detail.relatedDocuments.map(d => ({ name: d.name, type: d.type })),
        obligations: detail.relatedObligations.map(o => ({ name: o.name, amount: o.amount, frequency: o.frequency, nextDue: o.nextDueDate })),
        childProfiles: (detail.childProfiles || []).map(c => ({ name: c.name, type: c.type, fields: c.fields })),
        recentTimeline: detail.timeline.slice(0, 10).map(t => ({ type: t.type, title: t.title, description: t.description, timestamp: t.timestamp })),
      };
    }

    case "get_summary": {
      const entityType = input.entity_type;
      const summary: Record<string, any> = {};
      // Resolve profile filter
      let filterProfileId: string | undefined;
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const matched = profiles.find(p => p.name.toLowerCase().includes(input.forProfile.toLowerCase()));
        if (matched) filterProfileId = matched.id;
      }

      if (entityType === "all" || entityType === "profiles") {
        const profiles = await storage.getProfiles();
        summary.profiles = { count: profiles.length, items: profiles.map(p => ({ id: p.id, name: p.name, type: p.type })) };
      }
      if (entityType === "all" || entityType === "trackers") {
        const allTrackers = await storage.getTrackers();
        const trackers = filterProfileId ? allTrackers.filter(t => t.linkedProfiles.includes(filterProfileId!)) : allTrackers;
        summary.trackers = {
          count: trackers.length,
          items: trackers.map(t => ({ id: t.id, name: t.name, category: t.category, entryCount: t.entries.length })),
        };
      }
      if (entityType === "all" || entityType === "tasks") {
        const allTasks = await storage.getTasks();
        const tasks = filterProfileId ? allTasks.filter(t => t.linkedProfiles.includes(filterProfileId!)) : allTasks;
        const active = tasks.filter(t => t.status !== "done");
        summary.tasks = { total: tasks.length, active: active.length, done: tasks.length - active.length, items: active.map(t => ({ id: t.id, title: t.title, priority: t.priority, dueDate: t.dueDate })) };
      }
      if (entityType === "all" || entityType === "expenses") {
        const allExpenses = await storage.getExpenses();
        const expenses = filterProfileId ? allExpenses.filter(e => e.linkedProfiles.includes(filterProfileId!)) : allExpenses;
        const total = expenses.reduce((s, e) => s + e.amount, 0);
        summary.expenses = { count: expenses.length, totalAmount: total, recent: expenses.slice(-5).map(e => ({ amount: e.amount, description: e.description, date: e.date })) };
      }
      if (entityType === "all" || entityType === "events") {
        const allEvents = await storage.getEvents();
        const events = filterProfileId ? allEvents.filter(e => e.linkedProfiles.includes(filterProfileId!)) : allEvents;
        summary.events = { count: events.length, items: events.slice(-5).map(e => ({ id: e.id, title: e.title, date: e.date, time: e.time })) };
      }
      if (entityType === "all" || entityType === "habits") {
        const habits = await storage.getHabits();
        summary.habits = { count: habits.length, items: habits.map(h => ({ id: h.id, name: h.name, streak: h.currentStreak, frequency: h.frequency })) };
      }
      if (entityType === "all" || entityType === "obligations") {
        const allObligations = await storage.getObligations();
        const obligations = filterProfileId ? allObligations.filter(o => o.linkedProfiles.includes(filterProfileId!)) : allObligations;
        const monthlyTotal = obligations.reduce((s, o) => s + o.amount, 0);
        summary.obligations = { count: obligations.length, monthlyTotal, items: obligations.map(o => ({ id: o.id, name: o.name, amount: o.amount, nextDue: o.nextDueDate })) };
      }
      if (entityType === "all" || entityType === "journal") {
        const entries = await storage.getJournalEntries();
        summary.journal = { count: entries.length, recent: entries.slice(-3).map(e => ({ mood: e.mood, date: e.date })) };
      }
      if (entityType === "all" || entityType === "documents") {
        const docs = await storage.getDocuments();
        summary.documents = { count: docs.length, items: docs.map(d => ({ id: d.id, name: d.name, type: d.type })) };
      }

      // Include last 3 actions for context
      summary.recentActions = getActionLog(3);

      return summary;
    }

    case "recall_memory":
      return storage.recallMemory(input.query);

    case "create_profile": {
      // Auto-detect parent profile for non-primary profile types
      let parentProfileId = input.parentProfileId;
      const childTypes = ["vehicle", "asset", "subscription", "loan", "investment", "account", "property"];
      if (!parentProfileId && childTypes.includes(input.type || "")) {
        const profiles = await storage.getProfiles();
        // If forProfile is specified, find that profile as parent
        if (input.forProfile) {
          const parent = profiles.find(p => p.name.toLowerCase().includes(input.forProfile.toLowerCase()));
          if (parent) parentProfileId = parent.id;
        }
        // Default: link to self profile
        if (!parentProfileId) {
          const selfProfile = profiles.find(p => p.type === "self");
          if (selfProfile) parentProfileId = selfProfile.id;
        }
      }
      return storage.createProfile({
        type: input.type || "person",
        name: input.name,
        fields: input.fields || {},
        tags: input.tags || [],
        notes: input.notes || "",
        parentProfileId,
      });
    }

    case "update_profile": {
      const profiles = await storage.getProfiles();
      const profile = profiles.find(p => p.name.toLowerCase().includes((input.name || "").toLowerCase()));
      if (!profile) return null;
      const changes: any = {};
      if (input.changes.fields) changes.fields = { ...profile.fields, ...input.changes.fields };
      if (input.changes.notes !== undefined) changes.notes = input.changes.notes;
      if (input.changes.tags) changes.tags = input.changes.tags;
      if (input.changes.type) changes.type = input.changes.type;
      return storage.updateProfile(profile.id, changes);
    }

    case "delete_profile": {
      const profiles = await storage.getProfiles();
      const profile = profiles.find(p => p.name.toLowerCase().includes((input.name || "").toLowerCase()));
      if (!profile) return null;
      await storage.deleteProfile(profile.id);
      return { deleted: true, name: profile.name, id: profile.id };
    }

    case "create_task": {
      // Dedup: skip if a very similar active task already exists
      const existingTasks = await storage.getTasks();
      const dupTask = existingTasks.find(t =>
        t.status !== "done" &&
        t.title.toLowerCase().trim() === (input.title || "").toLowerCase().trim()
      );
      if (dupTask) return dupTask; // Return existing instead of creating duplicate

      const newTask = await storage.createTask({
        title: input.title,
        priority: input.priority || "medium",
        dueDate: input.dueDate,
        description: input.description,
        tags: input.tags || [],
      });
      // Auto-link: scan title for profile names + explicit forProfile
      await autoLinkToProfiles("task", newTask.id, input.title || "", input.forProfile);
      return newTask;
    }

    case "complete_task": {
      const tasks = await storage.getTasks();
      const task = tasks.find(t => t.title.toLowerCase().includes((input.title || "").toLowerCase()) && t.status !== "done");
      if (!task) return null;
      return storage.updateTask(task.id, { status: "done" });
    }

    case "delete_task": {
      const tasks = await storage.getTasks();
      const task = tasks.find(t => t.title.toLowerCase().includes((input.title || "").toLowerCase()));
      if (!task) return null;
      await storage.deleteTask(task.id);
      return { deleted: true, title: task.title, id: task.id };
    }

    case "log_tracker_entry": {
      const trackers = await storage.getTrackers();
      const trackerName = (input.trackerName || "").toLowerCase();
      const tracker = trackers.find(
        t => t.name.toLowerCase() === trackerName || t.name.toLowerCase().includes(trackerName)
      );
      // Merge notes into values if provided
      const entryValues = { ...input.values };
      if (input.notes) entryValues._notes = input.notes;
      if (tracker) {
        // Dedup: check if nearly identical entry was logged in the last 2 minutes
        const twoMinAgo = Date.now() - 120000;
        const recentDup = tracker.entries.find(e => {
          if (new Date(e.timestamp).getTime() < twoMinAgo) return false;
          // Compare primary numeric values
          const existingNums = Object.entries(e.values).filter(([k, v]) => typeof v === 'number' && k !== '_notes');
          const newNums = Object.entries(entryValues).filter(([k, v]) => typeof v === 'number' && k !== '_notes');
          if (existingNums.length === 0 || newNums.length === 0) return false;
          return newNums.every(([k, v]) => e.values[k] === v);
        });
        if (recentDup) {
          logger.info("ai", `Skipped duplicate ${tracker.name} entry (matches ${recentDup.id.slice(0,8)})`);
          return recentDup; // Return existing instead of creating duplicate
        }
        const entry = await storage.logEntry({ trackerId: tracker.id, values: entryValues });
        await autoLinkToProfiles("tracker", tracker.id, tracker.name, input.forProfile);
        // Auto-update any linked goals (e.g., running 1.5 mi updates 5K goal progress)
        await autoUpdateGoalProgress(tracker.id, entryValues);
        return entry;
      }
      // Auto-create tracker if not found — infer category from name
      const nameLC = (input.trackerName || "").toLowerCase();
      let autoCategory = "custom";
      if (["nutrition","food","diet","meal","calories"].some(k => nameLC.includes(k))) autoCategory = "nutrition";
      else if (["running","cycling","swimming","workout","exercise","walk"].some(k => nameLC.includes(k))) autoCategory = "fitness";
      else if (["weight","blood","bp","sleep","heart","cholesterol"].some(k => nameLC.includes(k))) autoCategory = "health";
      const newTracker = await storage.createTracker({
        name: input.trackerName || "Custom",
        category: autoCategory,
        fields: Object.keys(input.values || {}).filter(k => k !== '_notes').map(k => ({
          name: k,
          type: typeof input.values[k] === "number" ? "number" as const : "text" as const,
        })),
      });
      const entry = await storage.logEntry({ trackerId: newTracker.id, values: entryValues });
      await autoLinkToProfiles("tracker", newTracker.id, input.trackerName || "", input.forProfile);
      return entry;
    }

    case "create_tracker": {
      // Dedup: check for existing tracker with same name
      const existingTrackers = await storage.getTrackers();
      const dupTracker = existingTrackers.find(t => t.name.toLowerCase() === (input.name || "").toLowerCase());
      if (dupTracker) return dupTracker;

      const newTracker = await storage.createTracker({
        name: input.name,
        category: input.category || "custom",
        unit: input.unit,
        fields: input.fields || [{ name: "value", type: "number" }],
      });
      // Auto-link: scan tracker name for profile names + explicit forProfile
      await autoLinkToProfiles("tracker", newTracker.id, input.name || "", input.forProfile);
      return newTracker;
    }

    case "create_expense": {
      // Dedup: check if same amount + similar description was created in last 2 minutes
      const allExpenses = await storage.getExpenses();
      const twoMinAgoExp = Date.now() - 120000;
      const dupExpense = allExpenses.find(e => {
        if (new Date(e.date).getTime() < twoMinAgoExp) return false;
        return e.amount === (parseFloat(input.amount) || 0) &&
          e.description.toLowerCase().includes((input.description || "").toLowerCase().slice(0, 20));
      });
      if (dupExpense) {
        logger.info("ai", `Skipped duplicate expense: $${dupExpense.amount} ${dupExpense.description}`);
        return dupExpense;
      }
      const newExpense = await storage.createExpense({
        amount: parseFloat(input.amount) || 0,
        category: input.category || "general",
        description: input.description || "Expense",
        vendor: input.vendor,
        tags: input.tags || [],
      });
      // Auto-link: scan description and vendor for profile names + explicit forProfile
      await autoLinkToProfiles("expense", newExpense.id, `${input.description || ""} ${input.vendor || ""}`, input.forProfile);
      return newExpense;
    }

    case "delete_expense": {
      const expenses = await storage.getExpenses();
      const expense = expenses.find(e => e.description.toLowerCase().includes((input.description || "").toLowerCase()));
      if (!expense) return null;
      await storage.deleteExpense(expense.id);
      return { deleted: true, description: expense.description, id: expense.id };
    }

    case "create_event": {
      const newEvent = await storage.createEvent({
        title: input.title,
        date: input.date,
        time: input.time,
        endTime: input.endTime,
        allDay: input.allDay || false,
        location: input.location,
        description: input.description,
        recurrence: input.recurrence || "none",
        category: input.category || "personal",
        source: "chat",
        linkedProfiles: [],
        linkedDocuments: [],
        tags: [],
      });
      // Auto-link: scan title and description for profile names + explicit forProfile
      await autoLinkToProfiles("event", newEvent.id, `${input.title || ""} ${input.description || ""}`, input.forProfile);
      return newEvent;
    }

    case "update_event": {
      const events = await storage.getEvents();
      const event = events.find(e => e.title.toLowerCase().includes((input.title || "").toLowerCase()));
      if (!event) return null;
      return storage.updateEvent(event.id, input.changes);
    }

    case "create_habit":
      return storage.createHabit({
        name: input.name,
        frequency: input.frequency || "daily",
        icon: input.icon,
        color: input.color,
      });

    case "checkin_habit": {
      const habits = await storage.getHabits();
      const habit = habits.find(h => h.name.toLowerCase().includes((input.name || "").toLowerCase()));
      if (!habit) return null;
      return storage.checkinHabit(habit.id);
    }

    case "create_obligation": {
      const newObligation = await storage.createObligation({
        name: input.name,
        amount: parseFloat(input.amount) || 0,
        frequency: input.frequency || "monthly",
        category: input.category || "general",
        nextDueDate: input.nextDueDate || new Date().toISOString().split("T")[0],
        autopay: input.autopay ?? false,
      });

      // Auto-create subscription profile if this looks like a subscription/service
      // and no matching profile already exists
      const isSubscriptionLike = (input.category === "subscription") ||
        (input.frequency === "monthly" || input.frequency === "yearly" || input.frequency === "quarterly") ||
        /subscription|premium|plus|pro|membership|plan/i.test(input.name || "");
      if (isSubscriptionLike) {
        const profiles = await storage.getProfiles();
        const obNameLower = (input.name || "").toLowerCase();
        // Extract the service name (strip common suffixes like "subscription", "premium", "payment")
        const serviceName = (input.name || "").replace(/\s*(subscription|premium|plus|pro|payment|bill|membership|plan|monthly|annual|yearly)\s*/gi, "").trim() || input.name || "";
        const serviceNameLower = serviceName.toLowerCase();
        const existingProfile = profiles.find(p => {
          const pName = p.name.toLowerCase();
          return pName === serviceNameLower || pName.includes(serviceNameLower) || serviceNameLower.includes(pName) ||
            pName === obNameLower || obNameLower.includes(pName);
        });
        if (!existingProfile && serviceName.length > 0) {
          try {
            // Determine parent: use forProfile's profile if specified, otherwise self
            const selfProfile = profiles.find(p => p.type === "self");
            let parentId = selfProfile?.id;
            if (input.forProfile) {
              const targetProfile = profiles.find(p => p.name.toLowerCase().includes(input.forProfile.toLowerCase()));
              if (targetProfile) parentId = targetProfile.id;
            }
            const newProfile = await storage.createProfile({
              type: "subscription",
              name: serviceName,
              fields: {
                cost: parseFloat(input.amount) || 0,
                frequency: input.frequency || "monthly",
                provider: serviceName,
                renewalDate: input.nextDueDate || "",
              },
              tags: ["subscription"],
              notes: `${input.frequency || "monthly"} subscription — $${input.amount}`,
              parentProfileId: parentId,
            });
            // Link the obligation to the new profile
            await autoLinkToProfiles("obligation", newObligation.id, serviceName);
            // Also link obligation directly to the new profile
            try { await storage.linkProfileTo(newProfile.id, "obligation", newObligation.id); } catch { /* non-critical */ }
            try { await updateEntityLinkedProfiles("obligation", newObligation.id, newProfile.id); } catch { /* non-critical */ }
          } catch (e) {
            console.error("Auto-create subscription profile failed:", e);
          }
        } else {
          // Link to existing profile
          await autoLinkToProfiles("obligation", newObligation.id, input.name || "", input.forProfile);
        }
      } else {
        await autoLinkToProfiles("obligation", newObligation.id, input.name || "", input.forProfile);
      }

      return newObligation;
    }

    case "pay_obligation": {
      const obligations = await storage.getObligations();
      const ob = obligations.find(o => o.name.toLowerCase().includes((input.name || "").toLowerCase()));
      if (!ob) return null;
      return storage.payObligation(ob.id, parseFloat(input.amount) || ob.amount, input.method, input.confirmationNumber);
    }

    case "journal_entry":
      return storage.createJournalEntry({
        mood: input.mood || "neutral",
        content: input.content || "",
        energy: input.energy,
        gratitude: input.gratitude,
        highlights: input.highlights,
        tags: [],
      });

    case "create_artifact":
      return storage.createArtifact({
        type: input.type || "note",
        title: input.title,
        content: input.content || "",
        items: input.items || [],
        tags: [],
        pinned: false,
      });

    case "save_memory":
      return storage.saveMemory({
        key: input.key,
        value: input.value,
        category: input.category || "general",
      });

    case "open_document": {
      const searchTerm = (input.query || "").toLowerCase();
      if (!searchTerm) return null;
      const allDocs = await storage.getDocuments();
      const found = allDocs.find(doc => {
        const dName = doc.name.toLowerCase();
        return dName.includes(searchTerm) || searchTerm.split(/\s+/).every((w: string) => dName.includes(w));
      });
      if (!found) return null;
      return storage.getDocument(found.id);
    }

    case "create_document": {
      const doc = await storage.createDocument({
        name: input.name,
        type: "document",
        mimeType: "text/plain",
        fileData: Buffer.from(input.content || "").toString("base64"),
        size: input.content?.length || 0,
      });
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const profile = profiles.find((p: any) => p.name.toLowerCase().includes(input.forProfile.toLowerCase()));
        if (profile) await storage.linkProfileTo(profile.id, "document", doc.id);
      }
      return doc;
    }

    case "navigate":
      return { navigateTo: input.page, profileId: input.profileId };

    case "create_goal": {
      // Resolve tracker name to ID
      let trackerId = input.trackerId;
      if (trackerId) {
        const trackers = await storage.getTrackers();
        const found = trackers.find(t => t.name.toLowerCase().includes(trackerId.toLowerCase()));
        trackerId = found?.id || undefined;
      }
      // Resolve habit name to ID
      let habitId = input.habitId;
      if (habitId) {
        const habits = await storage.getHabits();
        const found = habits.find(h => h.name.toLowerCase().includes(habitId.toLowerCase()));
        habitId = found?.id || undefined;
      }
      return storage.createGoal({
        title: input.title,
        type: input.type,
        target: input.target,
        unit: input.unit,
        startValue: input.startValue,
        deadline: input.deadline,
        trackerId,
        habitId,
        category: input.category,
      });
    }

    case "get_goal_progress": {
      const goals = await storage.getGoals();
      if (input.query) {
        const q = input.query.toLowerCase();
        const filtered = goals.filter(g => g.title.toLowerCase().includes(q) || g.type.includes(q));
        return filtered.length > 0 ? filtered : goals;
      }
      return goals;
    }

    case "update_goal": {
      const goals = await storage.getGoals();
      const goal = goals.find(g => g.title.toLowerCase().includes((input.title || "").toLowerCase()));
      if (!goal) return null;
      const changes: any = {};
      if (input.status) changes.status = input.status;
      if (input.target) changes.target = input.target;
      if (input.deadline) changes.deadline = input.deadline;
      return storage.updateGoal(goal.id, changes);
    }

    case "link_entities": {
      const linkResult = await storage.createEntityLink({
        sourceType: input.source_type,
        sourceId: input.source_id,
        targetType: input.target_type,
        targetId: input.target_id,
        relationship: input.relationship,
        confidence: 1,
      });
      // Also update the profile arrays for proper display
      if (input.target_type === "profile") {
        try {
          await storage.linkProfileTo(input.target_id, input.source_type, input.source_id);
          await updateEntityLinkedProfiles(input.source_type, input.source_id, input.target_id);
        } catch (e) { console.error("link_entities profile update failed:", e); }
      }
      if (input.source_type === "profile") {
        try {
          await storage.linkProfileTo(input.source_id, input.target_type, input.target_id);
          await updateEntityLinkedProfiles(input.target_type, input.target_id, input.source_id);
        } catch (e) { console.error("link_entities profile update failed:", e); }
      }
      return linkResult;
    }

    case "get_related":
      return storage.getRelatedEntities(input.entity_type, input.entity_id);

    case "update_task": {
      const tasks = await storage.getTasks();
      const match = tasks.find(t => t.title.toLowerCase().includes(input.title.toLowerCase()));
      if (!match) return { error: `No task found matching "${input.title}"` };
      const updated = await storage.updateTask(match.id, input.changes);
      return { updated: true, task: updated };
    }

    case "update_expense": {
      const expenses = await storage.getExpenses();
      const match = expenses.find(e => e.description.toLowerCase().includes(input.description.toLowerCase()));
      if (!match) return { error: `No expense found matching "${input.description}"` };
      const updated = await storage.updateExpense(match.id, input.changes);
      return { updated: true, expense: updated };
    }

    case "update_obligation": {
      const obligations = await storage.getObligations();
      const match = obligations.find(o => o.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!match) return { error: `No obligation found matching "${input.name}"` };
      const updated = await storage.updateObligation(match.id, input.changes);
      return { updated: true, obligation: updated };
    }

    case "update_habit": {
      const habits = await storage.getHabits();
      const match = habits.find(h => h.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!match) return { error: `No habit found matching "${input.name}"` };
      const updated = await storage.updateHabit(match.id, input.changes);
      return { updated: true, habit: updated };
    }

    case "delete_habit": {
      const habits = await storage.getHabits();
      const match = habits.find(h => h.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!match) return { error: `No habit found matching "${input.name}"` };
      await storage.deleteHabit(match.id);
      return { deleted: true, name: match.name, id: match.id };
    }

    case "delete_obligation": {
      const obligations = await storage.getObligations();
      const match = obligations.find(o => o.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!match) return { error: `No obligation found matching "${input.name}"` };
      await storage.deleteObligation(match.id);
      return { deleted: true, name: match.name, id: match.id };
    }

    case "delete_event": {
      const events = await storage.getEvents();
      const match = events.find(e => e.title.toLowerCase().includes(input.title.toLowerCase()));
      if (!match) return { error: `No event found matching "${input.title}"` };
      await storage.deleteEvent(match.id);
      return { deleted: true, title: match.title, id: match.id };
    }

    case "delete_tracker": {
      const trackers = await storage.getTrackers();
      const match = trackers.find(t => t.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!match) return { error: `No tracker found matching "${input.name}"` };
      await storage.deleteTracker(match.id);
      return { deleted: true, name: match.name, id: match.id };
    }

    case "update_tracker": {
      const trackers = await storage.getTrackers();
      const tracker = trackers.find(t => t.name.toLowerCase().includes(input.trackerName.toLowerCase()));
      if (!tracker) return { error: `No tracker found matching "${input.trackerName}"` };
      const updated = await storage.updateTracker(tracker.id, input.changes);
      return { updated: true, tracker: updated };
    }

    case "delete_journal": {
      const entries = await storage.getJournalEntries();
      const match = entries.find(e => e.date === input.date);
      if (!match) return { error: `No journal entry found for date "${input.date}"` };
      await storage.deleteJournalEntry(match.id);
      return { deleted: true, date: match.date, id: match.id };
    }

    case "update_journal": {
      const entries = await storage.getJournalEntries();
      const entry = entries.find(e => e.date === input.date);
      if (!entry) return { error: `No journal entry found for date "${input.date}"` };
      const updated = await storage.updateJournalEntry(entry.id, input.changes);
      return { updated: true, journal: updated };
    }

    case "delete_artifact": {
      const artifacts = await storage.getArtifacts();
      const match = artifacts.find(a => a.title.toLowerCase().includes(input.title.toLowerCase()));
      if (!match) return { error: `No artifact found matching "${input.title}"` };
      await storage.deleteArtifact(match.id);
      return { deleted: true, title: match.title, id: match.id };
    }

    case "update_artifact": {
      const artifacts = await storage.getArtifacts();
      const artifact = artifacts.find(a => a.title.toLowerCase().includes(input.title.toLowerCase()));
      if (!artifact) return { error: `No artifact found matching "${input.title}"` };
      const updated = await storage.updateArtifact(artifact.id, input.changes);
      return { updated: true, artifact: updated };
    }

    case "delete_goal": {
      const goals = await storage.getGoals();
      const match = goals.find(g => g.title.toLowerCase().includes(input.title.toLowerCase()));
      if (!match) return { error: `No goal found matching "${input.title}"` };
      await storage.deleteGoal(match.id);
      return { deleted: true, title: match.title, id: match.id };
    }

    case "delete_memory": {
      const memories = await storage.getMemories();
      const match = memories.find(m =>
        m.key.toLowerCase().includes(input.query.toLowerCase()) ||
        m.value.toLowerCase().includes(input.query.toLowerCase())
      );
      if (!match) return { error: `No memory found matching "${input.query}"` };
      await storage.deleteMemory(match.id);
      return { deleted: true, key: match.key, id: match.id };
    }

    case "bulk_complete_tasks": {
      const tasks = await storage.getTasks();
      const now = new Date().toISOString().slice(0, 10);
      let toComplete: typeof tasks;
      if (input.filter === "all") {
        toComplete = tasks.filter(t => t.status !== "done");
      } else if (input.filter === "overdue") {
        toComplete = tasks.filter(t => t.status !== "done" && t.dueDate && t.dueDate < now);
      } else {
        toComplete = tasks.filter(t => t.status !== "done" && t.dueDate && t.dueDate === now);
      }
      for (const task of toComplete) {
        await storage.updateTask(task.id, { status: "done" });
      }
      return { completed: toComplete.length, titles: toComplete.map(t => t.title) };
    }

    case "recall_actions": {
      const count = Math.min(input.count || 10, 20);
      return { actions: getActionLog(count), total: actionLog.length };
    }

    case "undo_last": {
      return { message: "Undo is not yet available for this action. Please manually revert the change." };
    }

    case "sync_calendar": {
      try {
        const { execSync } = require("child_process");
        const now = new Date();
        const startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 1);
        const endDate = new Date(now);
        endDate.setMonth(endDate.getMonth() + 1);

        const params = JSON.stringify({
          source_id: "gcal",
          tool_name: "search_calendar",
          arguments: {
            start_date: startDate.toISOString().replace("Z", "-07:00"),
            end_date: endDate.toISOString().replace("Z", "-07:00"),
            queries: [""],
          },
        });

        const stdout = execSync(`external-tool call '${params.replace(/'/g, "'\\''")}'`, {
          timeout: 30000,
          encoding: "utf-8",
        });
        const gcalResult = JSON.parse(stdout);
        const gcalEvents = gcalResult?.calendar_event_list?.events || [];

        if (gcalEvents.length === 0) {
          return { synced: 0, message: "No events found in Google Calendar for this period." };
        }

        const existingEvents = await storage.getEvents();
        const gcalMappings = new Set<string>();
        for (const e of existingEvents) {
          const mapped = await storage.getPreference(`gcal_map_${e.id}`);
          if (mapped) gcalMappings.add(mapped);
        }

        let imported = 0;
        const importedTitles: string[] = [];

        for (const gcEvent of gcalEvents) {
          const gEventId = gcEvent.event_id || "";
          if (gcalMappings.has(gEventId)) continue;

          const startParsed = new Date(gcEvent.start);
          const eventDate = startParsed.toISOString().slice(0, 10);
          const isDuplicate = existingEvents.some(
            (e: any) => e.title === gcEvent.title && e.date === eventDate
          );
          if (isDuplicate) continue;

          const startTime = gcEvent.is_all_day ? undefined : startParsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles" });
          const endParsed = gcEvent.end ? new Date(gcEvent.end) : null;
          const endTime = (gcEvent.is_all_day || !endParsed) ? undefined : endParsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles" });

          let category: "personal" | "work" | "health" | "social" | "travel" | "finance" | "family" | "education" | "other" = "personal";
          const combined = ((gcEvent.title || "") + " " + (gcEvent.description || "")).toLowerCase();
          if (/meeting|standup|sprint|retro|1:1|sync|planning|review/.test(combined)) category = "work";
          else if (/doctor|dentist|medical|appointment|therapy|vet|checkup/.test(combined)) category = "health";
          else if (/birthday|party|dinner|lunch|brunch|wedding|anniversary/.test(combined)) category = "social";
          else if (/gym|workout|run|yoga|fitness|exercise/.test(combined)) category = "health";
          else if (/flight|hotel|trip|travel|vacation/.test(combined)) category = "travel";

          try {
            const created = await storage.createEvent({
              title: gcEvent.title || "Untitled Event",
              date: eventDate,
              time: startTime,
              endTime: endTime,
              allDay: gcEvent.is_all_day || false,
              description: gcEvent.description || undefined,
              location: gcEvent.location || undefined,
              category,
              source: "external",
              tags: ["google-calendar"],
              linkedProfiles: [],
              linkedDocuments: [],
              recurrence: "none",
            });
            await storage.setPreference(`gcal_map_${created.id}`, gEventId);
            imported++;
            importedTitles.push(gcEvent.title || "Untitled");
          } catch (err: any) {
            console.error("Failed to import event:", gcEvent.title, err.message);
          }
        }

        await storage.setPreference("gcal_last_sync", new Date().toISOString());
        return {
          synced: imported,
          total: gcalEvents.length,
          importedTitles,
          message: imported > 0
            ? `Imported ${imported} new events from Google Calendar.`
            : "All Google Calendar events are already synced.",
        };
      } catch (err: any) {
        return { error: "Google Calendar sync failed. Make sure the external-tool CLI is configured.", details: err.message };
      }
    }

    case "create_domain": {
      const domain = await storage.createDomain({
        name: input.name,
        description: input.description || "",
        fields: input.fields || [],
      });
      return domain;
    }

    case "update_domain": {
      const domains = await storage.getDomains();
      const domain = domains.find((d: any) => d.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!domain) return { error: `No domain found matching "${input.name}"` };
      const updated = await storage.updateDomain(domain.id, input.changes);
      return { updated: true, domain: updated };
    }

    case "delete_domain": {
      const domains = await storage.getDomains();
      const domain = domains.find((d: any) => d.name.toLowerCase().includes(input.name.toLowerCase()));
      if (!domain) return { error: `No domain found matching "${input.name}"` };
      await storage.deleteDomain(domain.id);
      return { deleted: true, name: domain.name, id: domain.id };
    }

    case "retrieve_document": {
      const allDocs = await storage.getDocuments();
      const profiles = await storage.getProfiles();
      let candidates = [...allDocs];

      // Filter by profile if specified
      if (input.profileName) {
        const profile = profiles.find((p: any) =>
          p.name.toLowerCase().includes(input.profileName.toLowerCase())
        );
        if (profile) {
          candidates = candidates.filter((d: any) =>
            d.linkedProfiles?.includes(profile.id)
          );
        }
      }

      // Filter by document type if specified
      if (input.documentType) {
        const typeQuery = input.documentType.toLowerCase().replace(/[_\s-]/g, "");
        candidates = candidates.filter((d: any) => {
          const docType = (d.type || "").toLowerCase().replace(/[_\s-]/g, "");
          return docType.includes(typeQuery) || typeQuery.includes(docType);
        });
      }

      // Text search across name, type, tags, extracted data
      if (input.query) {
        const q = input.query.toLowerCase();
        candidates = candidates.filter((d: any) => {
          const searchable = [
            d.name, d.type, ...(d.tags || []),
            ...Object.keys(d.extractedData || {}),
            ...Object.values(d.extractedData || {}).map((v: any) => String(v)),
          ].join(" ").toLowerCase();
          return q.split(/\s+/).some((word: string) => searchable.includes(word));
        });
      }

      if (candidates.length === 0) return { found: false, message: "No matching documents found." };

      // Return top match with full data for preview
      const doc = candidates[0];
      const fullDoc = await storage.getDocument(doc.id);
      if (!fullDoc) return { found: false, message: "Document not found." };
      return {
        found: true,
        document: {
          id: fullDoc.id,
          name: fullDoc.name,
          type: fullDoc.type,
          mimeType: fullDoc.mimeType,
          extractedData: fullDoc.extractedData,
          linkedProfiles: fullDoc.linkedProfiles,
          tags: fullDoc.tags,
          hasFileData: true,
        },
        documentPreview: {
          id: fullDoc.id,
          name: fullDoc.name,
          mimeType: fullDoc.mimeType,
          data: fullDoc.fileData,
        },
        totalMatches: candidates.length,
      };
    }

    default:
      return null;
  }
}

// ============================================================
// AUTO-UPDATE GOAL PROGRESS when tracker entries are logged
// ============================================================

async function autoUpdateGoalProgress(trackerId: string, values: Record<string, any>): Promise<void> {
  try {
    const goals = await storage.getGoals();
    const linkedGoals = goals.filter(g => g.trackerId === trackerId && g.status === 'active');
    for (const goal of linkedGoals) {
      // Determine the increment from the entry values
      let increment = 0;
      // For distance goals (running, cycling): use distance field
      if (values.distance && typeof values.distance === 'number') {
        increment = values.distance;
      } else if (values.value && typeof values.value === 'number') {
        increment = values.value;
      } else {
        // Use the first numeric value
        const numVals = Object.entries(values)
          .filter(([k, v]) => typeof v === 'number' && !k.startsWith('_'))
          .map(([, v]) => v as number);
        if (numVals.length > 0) increment = numVals[0];
      }
      if (increment > 0) {
        const newCurrent = (goal.current || 0) + increment;
        await storage.updateGoal(goal.id, { current: Math.min(newCurrent, goal.target * 2) }); // cap at 2x target
        logger.info("goal", `Auto-updated "${goal.title}": ${goal.current} → ${newCurrent} ${goal.unit}`);
      }
    }
  } catch (e) {
    console.error('[goal] autoUpdateGoalProgress failed:', e);
  }
}

// ============================================================
// AUTO-LINKING — scan created entities for profile name matches
// ============================================================

async function autoLinkToProfiles(entityType: string, entityId: string, text: string, explicitProfileName?: string): Promise<void> {
  if (!text && !explicitProfileName) return;
  try {
    const profiles = await storage.getProfiles();
    const lower = (text || "").toLowerCase();
    const selfProfile = profiles.find(p => p.type === "self");
    const matchedNonSelfIds: string[] = [];

    for (const profile of profiles) {
      const name = profile.name.toLowerCase();
      if (name.length < 2) continue; // Skip very short names
      if (profile.type === "self") continue; // Skip self — handled separately

      let matched = false;

      // 1. Explicit profile name match (from forProfile parameter)
      if (explicitProfileName) {
        const explicit = explicitProfileName.toLowerCase();
        if (name === explicit || name.includes(explicit) || explicit.includes(name)) {
          matched = true;
        }
        // Also match first significant word (e.g. "Tesla" matches "Tesla Model 3")
        const explicitWords = explicit.split(/\s+/).filter(w => w.length > 2);
        const nameWords = name.split(/\s+/).filter(w => w.length > 2);
        if (explicitWords.some(w => nameWords.includes(w))) {
          matched = true;
        }
      }

      // 2. Text-based matching: full name match OR significant word match
      if (!matched && lower) {
        // Full name in text
        if (lower.includes(name)) {
          matched = true;
        }
        // Word-level match: any significant word (3+ chars) from profile name appears in text
        if (!matched) {
          const nameWords = name.split(/\s+/).filter(w => w.length > 2);
          // Skip common words that would cause false matches
          const skipWords = new Set(["the", "and", "for", "new", "old", "my", "our", "dr.", "auto", "self"]);
          const significantWords = nameWords.filter(w => !skipWords.has(w));
          if (significantWords.length > 0 && significantWords.some(w => {
            // Word boundary match to avoid partial matches like "max" in "maximum"
            const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
            return regex.test(lower);
          })) {
            matched = true;
          }
        }
      }

      if (matched) {
        matchedNonSelfIds.push(profile.id);
        // 1. Create entity_link record
        const relationship = entityType === "expense" ? "paid_for" : "related_to";
        try {
          await storage.createEntityLink({
            sourceType: entityType,
            sourceId: entityId,
            targetType: "profile",
            targetId: profile.id,
            relationship,
            confidence: 0.7,
          });
        } catch (e) { /* ignore duplicate link errors */ }

        // 2. Update profile's linked arrays (linkedTrackers, linkedExpenses, etc.)
        try {
          await storage.linkProfileTo(profile.id, entityType, entityId);
        } catch (e) { console.error("linkProfileTo failed:", e); }

        // 3. Update the entity's own linkedProfiles array
        try {
          await updateEntityLinkedProfiles(entityType, entityId, profile.id);
        } catch (e) { console.error("updateEntityLinkedProfiles failed:", e); }
      }
    }

    // If no profile matched at all, link to self (so the item shows up in YOUR profile)
    if (matchedNonSelfIds.length === 0 && selfProfile) {
      try {
        await storage.linkProfileTo(selfProfile.id, entityType, entityId);
        await updateEntityLinkedProfiles(entityType, entityId, selfProfile.id);
      } catch (e) { /* non-critical */ }
    }

    // If a non-self profile was explicitly matched via forProfile, remove the auto self-link
    const hasExplicitNonSelf = explicitProfileName && matchedNonSelfIds.length > 0;
    if (hasExplicitNonSelf && selfProfile) {
      try {
        if (entityType === "tracker") {
          const tracker = await storage.getTracker(entityId);
          if (tracker && tracker.linkedProfiles.includes(selfProfile.id)) {
            const newLinked = tracker.linkedProfiles.filter(pid => pid !== selfProfile.id);
            await storage.updateTracker(entityId, { linkedProfiles: newLinked } as any);
            await storage.unlinkProfileFrom(selfProfile.id, "tracker", entityId);
          }
        } else {
          await storage.unlinkProfileFrom(selfProfile.id, entityType, entityId);
        }
      } catch (e) { console.error("Remove self-link failed:", e); }
    }
  } catch (err) {
    console.error("Auto-link failed:", err);
  }
}

// Audit and fix cross-linked trackers: if a tracker is explicitly linked to a non-self
// profile, remove the self-profile link unless the tracker name suggests it's personal
async function cleanupCrossLinks(): Promise<{ fixed: number; audited: number }> {
  let fixed = 0;
  let audited = 0;
  try {
    const profiles = await storage.getProfiles();
    const selfProfile = profiles.find(p => p.type === "self");
    if (!selfProfile) return { fixed: 0, audited: 0 };

    const trackers = await storage.getTrackers();
    const personalKeywords = ["my", "weight", "sleep", "mood", "blood pressure", "bp", "run", "walk", "step", "calorie", "water", "meditation"];

    for (const tracker of trackers) {
      audited++;
      const linked = tracker.linkedProfiles || [];
      const hasSelf = linked.includes(selfProfile.id);
      const hasNonSelf = linked.some(pid => pid !== selfProfile.id);

      if (hasSelf && hasNonSelf) {
        // Check if tracker name suggests personal use
        const lowerName = tracker.name.toLowerCase();
        const isPersonal = personalKeywords.some(kw => lowerName.includes(kw));
        if (!isPersonal) {
          // Remove self-link — this tracker belongs to another entity
          const newLinked = linked.filter(pid => pid !== selfProfile.id);
          await storage.updateTracker(tracker.id, { linkedProfiles: newLinked } as any);
          await storage.unlinkProfileFrom(selfProfile.id, "tracker", tracker.id);
          fixed++;
        }
      }
    }
  } catch (err) {
    console.error("cleanupCrossLinks failed:", err);
  }
  return { fixed, audited };
}

// Helper: update an entity's linkedProfiles array to include a profile ID
async function updateEntityLinkedProfiles(entityType: string, entityId: string, profileId: string): Promise<void> {
  switch (entityType) {
    case "tracker": {
      const tracker = await storage.getTracker(entityId);
      if (tracker && !tracker.linkedProfiles.includes(profileId)) {
        tracker.linkedProfiles.push(profileId);
        await storage.updateTracker(entityId, { linkedProfiles: tracker.linkedProfiles } as any);
      }
      break;
    }
    case "task": {
      const tasks = await storage.getTasks();
      const task = tasks.find(t => t.id === entityId);
      if (task && !task.linkedProfiles.includes(profileId)) {
        task.linkedProfiles.push(profileId);
        await storage.updateTask(entityId, { linkedProfiles: task.linkedProfiles } as any);
      }
      break;
    }
    case "expense": {
      const expenses = await storage.getExpenses();
      const expense = expenses.find(e => e.id === entityId);
      if (expense && !expense.linkedProfiles.includes(profileId)) {
        expense.linkedProfiles.push(profileId);
        await storage.updateExpense(entityId, { linkedProfiles: expense.linkedProfiles } as any);
      }
      break;
    }
    case "event": {
      const events = await storage.getEvents();
      const evt = events.find(e => e.id === entityId);
      if (evt && !evt.linkedProfiles.includes(profileId)) {
        evt.linkedProfiles.push(profileId);
        await storage.updateEvent(entityId, { linkedProfiles: evt.linkedProfiles } as any);
      }
      break;
    }
    case "obligation": {
      const obligations = await storage.getObligations();
      const ob = obligations.find(o => o.id === entityId);
      if (ob && !ob.linkedProfiles.includes(profileId)) {
        ob.linkedProfiles.push(profileId);
        await storage.updateObligation(entityId, { linkedProfiles: ob.linkedProfiles } as any);
      }
      break;
    }
  }
}

// ============================================================
// MAIN AI PROCESSING — tool_use loop
// ============================================================

export async function processMessage(userMessage: string, conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>): Promise<{
  reply: string;
  actions: ParsedAction[];
  results: any[];
  documentPreview?: { id: string; name: string; mimeType: string; data: string };
  documentPreviews?: Array<{ id: string; name: string; mimeType: string; data: string }>;
}> {
  // Try fast-path first
  const fast = await tryFastPath(userMessage);
  if (fast.matched) return { reply: fast.reply, actions: fast.actions, results: fast.results, documentPreview: (fast as any).documentPreview, documentPreviews: (fast as any).documentPreviews };

  // Build rich context from current data (uses short-lived cache to avoid redundant DB hits)
  const [profiles, trackers, tasks, expenses, events, habits, obligations, memories, documents, goals] = await getCachedContextData() as [any[], any[], any[], any[], any[], any[], any[], any[], any[], any[]];

  // Build COMPACT context — only summaries, no raw entry data (prevents token overflow)
  const context = [
    `Profiles: ${profiles.map(p => `${p.name} (${p.type}, id:${p.id.slice(0,8)})`).join("; ") || "none"}`,
    `Trackers: ${trackers.map(t => {
      const last = t.entries[t.entries.length - 1];
      return `${t.name} (${t.category}, ${t.entries.length} entries${last ? `, latest: ${JSON.stringify(last.values).slice(0,60)}` : ""})`;
    }).join("; ") || "none"}`,
    `Active Tasks: ${tasks.filter(t => t.status !== "done").slice(0, 15).map(t => `${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ""}`).join("; ") || "none"}`,
    `Recent Expenses (last 5): ${expenses.slice(-5).map(e => `$${e.amount} - ${e.description}`).join("; ") || "none"}`,
    `Upcoming Events (next 5): ${events.filter(e => new Date(e.date) >= new Date()).slice(0, 5).map(e => `${e.title} on ${e.date}`).join("; ") || "none"}`,
    `Habits: ${habits.map(h => `${h.name} (${h.frequency}, ${h.currentStreak}d streak)`).join("; ") || "none"}`,
    `Obligations: ${obligations.map(o => `${o.name}: $${o.amount}/${o.frequency}`).join("; ") || "none"}`,
    `Memories: ${memories.slice(0, 20).map(m => `${m.key}: ${String(m.value).slice(0,50)}`).join("; ") || "none"}`,
    `Documents: ${documents.map(d => `"${d.name}" (${d.type})`).join("; ") || "none"}`,
    `Goals: ${goals.filter(g => g.status === "active").map(g => `${g.title} (${g.current}/${g.target} ${g.unit})`).join("; ") || "none"}`,
  ].join("\n");

  const systemPrompt = buildSystemPrompt(context);

  try {
    // Build the tool_use conversation loop — prepend up to 5 history pairs for multi-step context
    let messages: Anthropic.Messages.MessageParam[] = [];
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-10); // last 10 messages (up to 5 pairs)
      for (const msg of recent) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: userMessage });
    const allActions: ParsedAction[] = [];
    const allResults: any[] = [];
    let textReply = "";
    let documentPreview: { id: string; name: string; mimeType: string; data: string } | undefined;
    const documentPreviews: Array<{ id: string; name: string; mimeType: string; data: string }> = [];
    let iterations = 0;
    const MAX_ITERATIONS = 15;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Retry on overloaded/rate-limit errors
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await getClient().messages.create({
            model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
            max_tokens: 2048,
            system: systemPrompt,
            tools: TOOL_DEFINITIONS,
            messages,
          });
          break; // Success
        } catch (retryErr: any) {
          const status = retryErr?.status || retryErr?.error?.status || 0;
          if ((status === 529 || status === 429 || status === 503) && attempt < 2) {
            await new Promise(r => setTimeout(r, (attempt + 1) * 2000)); // Wait 2s, 4s
            continue;
          }
          throw retryErr;
        }
      }
      if (!response) throw new Error("Failed after retries");

      // Extract text blocks for the reply
      for (const block of response.content) {
        if (block.type === "text") {
          textReply += block.text;
        }
      }

      // Collect tool_use blocks
      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );

      // If no tool calls or stop_reason is end_turn with no pending tools, we're done
      if (toolUses.length === 0 || response.stop_reason === "end_turn") {
        break;
      }

      // Execute each tool call and collect results
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        try {
          const result = await executeTool(toolUse.name, toolUse.input);
          
          // Invalidate context cache after any write operation
          const readOnlyToolNames = ["search", "get_summary", "get_profile_data", "recall_memory", "recall_actions", "get_goal_progress", "get_related", "navigate", "open_document", "retrieve_document"];
          if (!readOnlyToolNames.includes(toolUse.name)) {
            invalidateContextCache();
          }

          // Map tool name to a ParsedAction type for backwards compat
          const actionType = mapToolToActionType(toolUse.name);
          allActions.push({ type: actionType, category: "ai", data: toolUse.input as Record<string, any> });
          if (result) allResults.push(result);

          // Log the action to in-memory history
          const inp = toolUse.input as Record<string, any>;
          const entityName = inp.name || inp.title || inp.description || inp.key || inp.query || inp.trackerName || toolUse.name;
          const entityId = result?.id || result?.task?.id || result?.expense?.id || result?.habit?.id || result?.obligation?.id;
          const readOnlyTools = ["search", "get_summary", "get_profile_data", "recall_memory", "recall_actions", "get_goal_progress", "get_related", "navigate", "open_document", "retrieve_document"];
          if (!readOnlyTools.includes(toolUse.name) && result && !result.error) {
            logAction(toolUse.name, actionType, String(entityName), entityId);
          }

          // Handle document previews
          if (toolUse.name === "open_document" && result?.fileData) {
            const preview = { id: result.id, name: result.name, mimeType: result.mimeType, data: result.fileData };
            if (!documentPreview) documentPreview = preview;
            documentPreviews.push(preview);
          }

          // Handle retrieve_document — attach document preview
          if (toolUse.name === "retrieve_document" && result?.documentPreview) {
            const preview = { id: result.documentPreview.id, name: result.documentPreview.name, mimeType: result.documentPreview.mimeType, data: result.documentPreview.data };
            documentPreviews.push(preview);
            if (!documentPreview) documentPreview = preview;
          }

          // If result is null/undefined, report failure to AI so it doesn't claim success
          const isSuccess = result !== null && result !== undefined;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(isSuccess ? summarizeResult(result) : { error: "Action failed — data was not saved. Tell the user it didn't work." }),
            is_error: !isSuccess,
          });
        } catch (err: any) {
          console.error(`Tool ${toolUse.name} failed:`, err.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: err.message }),
          });
        }
      }

      // Add assistant response + tool results to messages for next iteration
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    // If no text reply was generated but we did actions, create a summary
    if (!textReply && allActions.length > 0) {
      textReply = `Done — executed ${allActions.length} action${allActions.length > 1 ? "s" : ""}.`;
    }

    return {
      reply: textReply || "I'm not sure how to help with that. Try asking me to track something, create a task, log an expense, or manage your data.",
      actions: allActions,
      results: allResults,
      documentPreview,
      documentPreviews: documentPreviews.length > 0 ? documentPreviews : undefined,
    };
  } catch (err: any) {
    console.error("AI engine error:", err.message);
    return fallbackParse(userMessage);
  }
}

// Map tool names to legacy ParsedAction types for backwards compatibility
function mapToolToActionType(toolName: string): ParsedAction["type"] {
  const mapping: Record<string, ParsedAction["type"]> = {
    search: "retrieve",
    get_summary: "retrieve",
    get_profile_data: "retrieve",
    recall_memory: "recall_memory",
    create_profile: "create_profile",
    update_profile: "update_profile",
    delete_profile: "retrieve",
    create_task: "create_task",
    complete_task: "create_task",
    delete_task: "create_task",
    log_tracker_entry: "log_entry",
    create_tracker: "create_tracker",
    create_expense: "log_expense",
    delete_expense: "log_expense",
    create_event: "create_event",
    update_event: "create_event",
    create_habit: "create_habit",
    checkin_habit: "checkin_habit",
    create_obligation: "create_obligation",
    pay_obligation: "pay_obligation",
    journal_entry: "journal_entry",
    create_artifact: "create_artifact",
    save_memory: "save_memory",
    open_document: "retrieve",
    navigate: "retrieve",
    link_entities: "retrieve",
    get_related: "retrieve",
    create_goal: "create_goal",
    update_goal: "create_goal",
    delete_goal: "create_goal",
    retrieve_document: "retrieve",
  };
  return mapping[toolName] || "retrieve";
}

// Fallback rule-based parsing when AI is unavailable
async function fallbackParse(message: string): Promise<{ reply: string; actions: ParsedAction[]; results: any[] }> {
  const lower = message.toLowerCase();
  const actions: ParsedAction[] = [];
  const results: any[] = [];
  let reply = "";

  if (lower.startsWith("track ") || lower.startsWith("create tracker ")) {
    const name = message.replace(/^(track|create tracker)\s+/i, "").replace(/^my\s+/i, "");
    // Dedup: check for existing tracker with same name
    const allTrackers = await storage.getTrackers();
    const dupTracker = allTrackers.find(t => t.name.toLowerCase() === name.toLowerCase());
    const tracker = dupTracker || await storage.createTracker({ name, category: "custom", fields: [{ name: "value", type: "number" }] });
    actions.push({ type: "create_tracker", category: "custom", data: { name } });
    results.push(tracker);
    reply = dupTracker
      ? `Found existing tracker "${tracker.name}". You can log entries to it.`
      : `Created a new tracker for "${name}". You can now log entries to it.`;
  } else if (lower.includes("spent") || lower.includes("bought") || lower.match(/\$\d+/)) {
    const amountMatch = message.match(/\$?([\d.]+)/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    const desc = message.replace(/\$[\d.]+/, "").replace(/spent|bought|on/gi, "").trim();
    if (amount > 0) {
      const expense = await storage.createExpense({ amount, category: "general", description: desc || "Expense", tags: [] });
      // Auto-link to self profile so it shows in Finance tab
      await autoLinkToProfiles("expense", expense.id, desc || "Expense");
      actions.push({ type: "log_expense", category: "finance", data: { amount, description: desc } });
      results.push(expense);
      reply = `Logged expense: $${amount} — ${desc || "Expense"}`;
    }
  } else if (lower.startsWith("remind") || lower.startsWith("todo") || lower.startsWith("task")) {
    const title = message.replace(/^(remind me to|remind|todo|task)\s*/i, "").trim();
    const task = await storage.createTask({ title, priority: "medium", tags: [] });
    // Auto-link to self profile so it shows in Tasks tab
    await autoLinkToProfiles("task", task.id, title);
    actions.push({ type: "create_task", category: "task", data: { title } });
    results.push(task);
    reply = `Created task: "${title}"`;
  } else {
    // Try to handle as AI message — don't show offline mode
    reply = `I couldn't process that right now — the AI is temporarily unavailable. Try simple commands like:\n• "weight 183" • "bp 120/80" • "$50 groceries"\n• "mood good" • "remind me to call mom"\n• "open my drivers license"\nOr refresh and try again.`;
  }

  return { reply, actions, results };
}
