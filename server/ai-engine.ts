import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import type { ParsedAction } from "@shared/schema";

const client = new Anthropic();

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

  // ---- Open document command: "open my drivers license", "show max's vaccination record" ----
  // Also handles multiple documents: "open my insurance and my license"
  const openDocPattern = /^(?:open|show|view|pull up|display|get)\s+/i;
  if (openDocPattern.test(lower)) {
    const searchPart = lower.replace(openDocPattern, "").trim();
    // Split on "and", commas, "&" to handle multiple docs
    const searchTerms = searchPart.split(/\s*(?:,|\band\b|&)\s*/).map(s => s.replace(/^(?:my|the|also)\s+/i, "").trim()).filter(Boolean);
    
    const allDocuments = await storage.getDocuments();
    const foundDocs: any[] = [];
    const documentPreviews: any[] = [];
    
    for (const term of searchTerms) {
      // Strip possessive and trailing type words
      const cleaned = term.replace(/(?:'s|s')\s+/g, " ").replace(/\s+(?:document|file|record|report|pdf|photo|image)$/i, "").trim();
      const doc = allDocuments.find(d => {
        const dName = d.name.toLowerCase();
        return dName.includes(cleaned) || cleaned.split(/\s+/).every(w => dName.includes(w));
      });
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

  // ---- Quick expense: "$45 groceries", "spent $120 on gas" ----
  const quickExpenseMatch = lower.match(/(?:spent\s+)?\$(\d+(?:\.\d{1,2})?)\s*(?:on\s+)?(.+)/);
  if (quickExpenseMatch && !lower.includes("track") && !lower.includes("log")) {
    const amount = parseFloat(quickExpenseMatch[1]);
    const desc = quickExpenseMatch[2].replace(/^(?:at|for|on)\s+/i, "").trim();
    if (amount > 0 && desc) {
      const expense = await storage.createExpense({ amount, category: "general", description: desc, tags: [] });
      // Auto-link to profiles
      autoLinkToProfiles("expense", expense.id, desc);
      actions.push({ type: "log_expense", category: "finance", data: { amount, description: desc } });
      results.push(expense);
      return { matched: true, reply: `Logged: $${amount} — ${desc}`, actions, results };
    }
  }

  // ---- Quick task: "remind me to X", "todo X" ----
  const taskMatch = lower.match(/^(?:remind\s+me\s+to|todo|task:?)\s+(.+)/);
  if (taskMatch) {
    const title = taskMatch[1].replace(/^\s+/, "");
    const task = await storage.createTask({ title, priority: "medium", tags: [] });
    actions.push({ type: "create_task", category: "task", data: { title } });
    results.push(task);
    return { matched: true, reply: `Created task: "${title}"`, actions, results };
  }

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
  const moodMatch = lower.match(/^(?:mood|feeling|i\s+feel)\s+(amazing|good|neutral|bad|awful)/);
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
}> {
  const actions: ParsedAction[] = [];
  const results: any[] = [];

  // Use Claude vision to analyze the image/document
  const extractionPrompt = `You are LifeOS AI — analyzing an uploaded file. Extract ALL useful data from this image/document.

Determine:
1. DOCUMENT TYPE: What kind of document is this? (drivers_license, medical_report, receipt, insurance_card, passport, vehicle_registration, prescription, lab_results, utility_bill, bank_statement, warranty, pet_record, school_record, tax_document, other)
2. EXTRACTED DATA: Pull out every field you can see — names, dates, numbers, addresses, IDs, amounts, readings, etc.
3. TARGET PROFILE: Who does this belong to? Look for names. If it's a medical report, whose is it? If it's for a vehicle, which one?
4. TRACKER DATA: Any numeric health readings (blood pressure, cholesterol, glucose, weight, etc.) that should be logged as tracker entries?
5. DOCUMENT LABEL: A short human-readable label for this document.

${userMessage ? `User context: "${userMessage}"` : ""}

Respond with JSON:
{
  "documentType": "drivers_license",
  "label": "John's Driver's License",
  "extractedData": { "field1": "value1", "field2": "value2" },
  "targetProfile": { "name": "John", "type": "person", "matchExisting": true },
  "trackerEntries": [ { "trackerName": "blood_pressure", "values": { "systolic": 120, "diastolic": 80 } } ],
  "summary": "Brief human-readable summary of what was extracted"
}`;

  try {
    const mediaType = mimeType.startsWith("image/") ? mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" : "image/jpeg";
    
    const response = await client.messages.create({
      model: "claude_sonnet_4_6",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Data },
          },
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

    // Determine linked profiles: explicit profileId takes priority over AI-detected profile
    let linkedProfiles: string[] = [];

    if (profileId) {
      // Explicit profile selection from user
      const explicitProfile = await storage.getProfile(profileId);
      if (explicitProfile) {
        linkedProfiles = [profileId];
        // Merge extracted fields into this profile
        if (parsed.extractedData && Object.keys(parsed.extractedData).length > 0) {
          await storage.updateProfile(profileId, {
            fields: { ...explicitProfile.fields, ...parsed.extractedData },
          });
          actions.push({ type: "update_profile", category: "profile", data: { name: explicitProfile.name, fields: parsed.extractedData } });
        }
      }
    } else if (parsed.targetProfile?.name) {
      // AI-detected profile — try to match existing
      const profiles = await storage.getProfiles();
      const existing = profiles.find(p =>
        p.name.toLowerCase().includes(parsed.targetProfile.name.toLowerCase()) ||
        parsed.targetProfile.name.toLowerCase().includes(p.name.toLowerCase())
      );
      if (existing) {
        linkedProfiles = [existing.id];
        // Update profile with extracted fields if relevant
        if (parsed.extractedData && Object.keys(parsed.extractedData).length > 0) {
          await storage.updateProfile(existing.id, {
            fields: { ...existing.fields, ...parsed.extractedData },
          });
          actions.push({ type: "update_profile", category: "profile", data: { name: existing.name, fields: parsed.extractedData } });
        }
      } else {
        // Create new profile
        const newProfile = await storage.createProfile({
          type: parsed.targetProfile.type || "person",
          name: parsed.targetProfile.name,
          fields: parsed.extractedData || {},
          tags: [parsed.documentType || "uploaded"],
          notes: "",
        });
        linkedProfiles = [newProfile.id];
        actions.push({ type: "create_profile", category: "profile", data: { name: newProfile.name, type: newProfile.type } });
        results.push(newProfile);
      }
    }

    // Store the document
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

    // Log tracker entries if any numeric data was extracted
    if (parsed.trackerEntries && Array.isArray(parsed.trackerEntries)) {
      for (const entry of parsed.trackerEntries) {
        const trackers = await storage.getTrackers();
        const trackerName = (entry.trackerName || "").toLowerCase().replace(/_/g, " ");
        const tracker = trackers.find(t => t.name.toLowerCase().includes(trackerName));
        if (tracker) {
          const logged = await storage.logEntry({ trackerId: tracker.id, values: entry.values });
          if (logged) {
            actions.push({ type: "log_entry", category: "health", data: { trackerName: tracker.name, ...entry.values } });
            results.push(logged);
          }
        }
      }
    }

    let reply = parsed.summary || `Processed "${fileName}"`;
    if (linkedProfiles.length > 0) {
      const profiles = await storage.getProfiles();
      const profileName = profiles.find(p => p.id === linkedProfiles[0])?.name;
      if (profileName) reply += `\n\nLinked to profile: ${profileName}`;
    }
    if (parsed.extractedData && Object.keys(parsed.extractedData).length > 0) {
      const fields = Object.entries(parsed.extractedData)
        .map(([k, v]) => `• ${k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n');
      reply += `\n\nExtracted:\n${fields}`;
    }
    reply += `\n\nDocument saved. Say "open ${parsed.label || fileName}" anytime to view it.`;

    const documentPreview = {
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      data: document.fileData,
    };

    return { reply, actions, results, documentId: document.id, documentPreview };
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
    // Link to explicit profile if provided
    if (profileId) {
      const profile = await storage.getProfile(profileId);
      if (profile) {
        await storage.updateProfile(profileId, { documents: [...(profile.documents || []), document.id] });
      }
    }
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
      },
      required: ["query"],
    },
  },
  {
    name: "get_summary",
    description: "Get summary statistics for a specific entity type or all data. Use when the user asks for an overview, stats, totals, or 'how many'.",
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
    description: "Create a new profile for a person, pet, vehicle, account, property, subscription, medical record, self, loan, investment, or asset.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["person", "pet", "vehicle", "account", "property", "subscription", "medical", "self", "loan", "investment", "asset"],
          description: "Profile type",
        },
        name: { type: "string", description: "Name of the profile" },
        fields: { type: "object", description: "Key-value fields for the profile" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        notes: { type: "string", description: "Additional notes" },
      },
      required: ["type", "name"],
    },
  },
  {
    name: "update_profile",
    description: "Update an existing profile. Find by name, then apply changes to fields or notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the profile to update (partial match)" },
        changes: { type: "object", description: "Fields to update — can include 'fields' (object), 'notes' (string), 'tags' (array)" },
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
        values: { type: "object", description: "Key-value pairs to log (e.g., { weight: 183 } or { systolic: 120, diastolic: 80 })" },
      },
      required: ["trackerName", "values"],
    },
  },
  {
    name: "create_tracker",
    description: "Create a new tracker for tracking any kind of data over time.",
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
        category: { type: "string", description: "Category (food, transport, entertainment, utilities, general, etc.)" },
        vendor: { type: "string", description: "Store or vendor name" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
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
    description: "Create a recurring bill, subscription, or financial obligation.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Obligation name" },
        amount: { type: "number", description: "Amount" },
        frequency: { type: "string", enum: ["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"], description: "Payment frequency" },
        nextDueDate: { type: "string", description: "Next due date (YYYY-MM-DD)" },
        category: { type: "string", description: "Category (rent, utilities, insurance, subscription, loan, etc.)" },
        autopay: { type: "boolean", description: "Whether this is on autopay" },
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
        mood: { type: "string", enum: ["amazing", "good", "neutral", "bad", "awful"], description: "Mood level" },
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
    description: "Recall recent actions — shows the last N things you did in LifeOS. Use when user asks 'what did I just do?', 'show recent actions', 'what happened?', or 'my recent activity'.",
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
    description: "Sync events with Google Calendar. Imports new events from Google Calendar into LifeOS. Use when the user asks to sync, import, or pull their Google Calendar events.",
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
];

// ============================================================
// SYSTEM PROMPT (simplified — no JSON format instructions)
// ============================================================

function buildSystemPrompt(context: string): string {
  return `You are LifeOS AI — the brain of a centralized personal life operating system. You help users manage their entire life: profiles (people, pets, vehicles, accounts), health tracking, tasks, expenses, calendar events, habits, obligations, journal entries, memories, and documents.

EXISTING DATA (reference these when the user mentions them):
${context}

BEHAVIOR:
- Be concise and confirm what you did after each action.
- Handle multiple actions in one message when appropriate (e.g., "I ate lunch for $12 and ran 3 miles" → create_expense + log_tracker_entry).
- When the user mentions an existing entity, match it by name (partial matching is fine).
- For conversational messages with no actions needed, just respond naturally without calling any tools.
- When creating tasks from reminders, extract the due date if mentioned.
- When searching, use the search tool to find relevant data before answering.

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
For BLOOD PRESSURE: Classify per AHA guidelines (normal, elevated, high_stage1, high_stage2, crisis)
For WEIGHT: Note trend direction if previous entries exist

SMART LINKING: When actions relate to an existing profile, note the connection.

GOOGLE CALENDAR: Events can be synced with Google Calendar. If the user asks to sync or import their calendar, tell them to click the "Sync Google Calendar" button on the dashboard or calendar view. You can create/update events in LifeOS which can then be exported to Google Calendar via the export button. Events imported from Google Calendar are tagged with "google-calendar".

Today's date: ${new Date().toISOString().split("T")[0]}`;
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
    case "search":
      return storage.search(input.query);

    case "get_summary": {
      const entityType = input.entity_type;
      const summary: Record<string, any> = {};

      if (entityType === "all" || entityType === "profiles") {
        const profiles = await storage.getProfiles();
        summary.profiles = { count: profiles.length, items: profiles.map(p => ({ id: p.id, name: p.name, type: p.type })) };
      }
      if (entityType === "all" || entityType === "trackers") {
        const trackers = await storage.getTrackers();
        summary.trackers = {
          count: trackers.length,
          items: trackers.map(t => ({ id: t.id, name: t.name, category: t.category, entryCount: t.entries.length })),
        };
      }
      if (entityType === "all" || entityType === "tasks") {
        const tasks = await storage.getTasks();
        const active = tasks.filter(t => t.status !== "done");
        summary.tasks = { total: tasks.length, active: active.length, done: tasks.length - active.length, items: active.map(t => ({ id: t.id, title: t.title, priority: t.priority, dueDate: t.dueDate })) };
      }
      if (entityType === "all" || entityType === "expenses") {
        const expenses = await storage.getExpenses();
        const total = expenses.reduce((s, e) => s + e.amount, 0);
        summary.expenses = { count: expenses.length, totalAmount: total, recent: expenses.slice(-5).map(e => ({ amount: e.amount, description: e.description, date: e.date })) };
      }
      if (entityType === "all" || entityType === "events") {
        const events = await storage.getEvents();
        summary.events = { count: events.length, items: events.slice(-5).map(e => ({ id: e.id, title: e.title, date: e.date, time: e.time })) };
      }
      if (entityType === "all" || entityType === "habits") {
        const habits = await storage.getHabits();
        summary.habits = { count: habits.length, items: habits.map(h => ({ id: h.id, name: h.name, streak: h.currentStreak, frequency: h.frequency })) };
      }
      if (entityType === "all" || entityType === "obligations") {
        const obligations = await storage.getObligations();
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

    case "create_profile":
      return storage.createProfile({
        type: input.type || "person",
        name: input.name,
        fields: input.fields || {},
        tags: input.tags || [],
        notes: input.notes || "",
      });

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
      const newTask = await storage.createTask({
        title: input.title,
        priority: input.priority || "medium",
        dueDate: input.dueDate,
        tags: input.tags || [],
      });
      // Auto-link: scan title for profile names
      autoLinkToProfiles("task", newTask.id, input.title || "");
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
      if (tracker) {
        return storage.logEntry({ trackerId: tracker.id, values: input.values });
      }
      // Auto-create tracker if not found
      const newTracker = await storage.createTracker({
        name: input.trackerName || "Custom",
        category: "custom",
        fields: Object.keys(input.values || {}).map(k => ({
          name: k,
          type: typeof input.values[k] === "number" ? "number" as const : "text" as const,
        })),
      });
      return storage.logEntry({ trackerId: newTracker.id, values: input.values });
    }

    case "create_tracker":
      return storage.createTracker({
        name: input.name,
        category: input.category || "custom",
        unit: input.unit,
        fields: input.fields || [{ name: "value", type: "number" }],
      });

    case "create_expense": {
      const newExpense = await storage.createExpense({
        amount: parseFloat(input.amount) || 0,
        category: input.category || "general",
        description: input.description || "Expense",
        vendor: input.vendor,
        tags: input.tags || [],
      });
      // Auto-link: scan description and vendor for profile names
      autoLinkToProfiles("expense", newExpense.id, `${input.description || ""} ${input.vendor || ""}`);
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
        location: input.location,
        description: input.description,
        recurrence: input.recurrence || "none",
        tags: [],
      });
      // Auto-link: scan title and description for profile names
      autoLinkToProfiles("event", newEvent.id, `${input.title || ""} ${input.description || ""}`);
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

    case "create_obligation":
      return storage.createObligation({
        name: input.name,
        amount: parseFloat(input.amount) || 0,
        frequency: input.frequency || "monthly",
        category: input.category || "general",
        nextDueDate: input.nextDueDate || new Date().toISOString().split("T")[0],
        autopay: input.autopay ?? false,
      });

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

    case "link_entities":
      return storage.createEntityLink({
        sourceType: input.source_type,
        sourceId: input.source_id,
        targetType: input.target_type,
        targetId: input.target_id,
        relationship: input.relationship,
        confidence: 1,
      });

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

    case "delete_journal": {
      const entries = await storage.getJournalEntries();
      const match = entries.find(e => e.date === input.date);
      if (!match) return { error: `No journal entry found for date "${input.date}"` };
      await storage.deleteJournalEntry(match.id);
      return { deleted: true, date: match.date, id: match.id };
    }

    case "delete_artifact": {
      const artifacts = await storage.getArtifacts();
      const match = artifacts.find(a => a.title.toLowerCase().includes(input.title.toLowerCase()));
      if (!match) return { error: `No artifact found matching "${input.title}"` };
      await storage.deleteArtifact(match.id);
      return { deleted: true, title: match.title, id: match.id };
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

    default:
      return null;
  }
}

// ============================================================
// AUTO-LINKING — scan created entities for profile name matches
// ============================================================

async function autoLinkToProfiles(entityType: string, entityId: string, text: string): Promise<void> {
  if (!text) return;
  try {
    const profiles = await storage.getProfiles();
    const lower = text.toLowerCase();
    for (const profile of profiles) {
      const name = profile.name.toLowerCase();
      if (name.length < 2) continue; // Skip very short names
      if (lower.includes(name)) {
        const relationship = entityType === "expense" ? "paid_for" : "related_to";
        await storage.createEntityLink({
          sourceType: entityType,
          sourceId: entityId,
          targetType: "profile",
          targetId: profile.id,
          relationship,
          confidence: 0.7,
        });
      }
    }
  } catch (err) {
    console.error("Auto-link failed:", err);
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

  // Build rich context from current data
  const [profiles, trackers, tasks, expenses, events, habits, obligations, memories, documents, goals] = await Promise.all([
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

  const context = [
    `Profiles: ${profiles.map(p => `${p.name} (${p.type}, tags: ${p.tags.join(",") || "none"})`).join("; ") || "none"}`,
    `Trackers: ${trackers.map(t => {
      const lastEntry = t.entries[t.entries.length - 1];
      const lastVal = lastEntry ? JSON.stringify(lastEntry.values) : "no entries";
      return `${t.name} (${t.category}, ${t.entries.length} entries, last: ${lastVal})`;
    }).join("; ") || "none"}`,
    `Active Tasks: ${tasks.filter(t => t.status !== "done").map(t => `${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ""}`).join("; ") || "none"}`,
    `Recent Expenses: ${expenses.slice(-5).map(e => `$${e.amount} - ${e.description}${e.vendor ? ` at ${e.vendor}` : ""}`).join("; ") || "none"}`,
    `Upcoming Events: ${events.slice(-3).map(e => `${e.title} on ${e.date}${e.recurrence !== "none" ? ` (${e.recurrence})` : ""}`).join("; ") || "none"}`,
    `Habits: ${habits.map(h => `${h.name} (${h.frequency}, ${h.currentStreak}-day streak)`).join("; ") || "none"}`,
    `Obligations: ${obligations.map(o => `${o.name}: $${o.amount}/${o.frequency}, due ${o.nextDueDate}${o.autopay ? " (autopay)" : ""}`).join("; ") || "none"}`,
    `Memories: ${memories.map(m => `${m.key}: ${m.value}`).join("; ") || "none"}`,
    `Documents: ${documents.map(d => `"${d.name}" (${d.type}, linked: ${d.linkedProfiles.length > 0 ? "yes" : "no"})`).join("; ") || "none"}`,
    `Goals: ${goals.filter(g => g.status === "active").map(g => `${g.title} (${g.type}, ${g.current}/${g.target} ${g.unit}, ${g.deadline ? `deadline: ${g.deadline}` : "no deadline"})`).join("; ") || "none"}`,
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
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await client.messages.create({
        model: "claude_sonnet_4_6",
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOL_DEFINITIONS,
        messages,
      });

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

          // Map tool name to a ParsedAction type for backwards compat
          const actionType = mapToolToActionType(toolUse.name);
          allActions.push({ type: actionType, category: "ai", data: toolUse.input as Record<string, any> });
          if (result) allResults.push(result);

          // Log the action to in-memory history
          const inp = toolUse.input as Record<string, any>;
          const entityName = inp.name || inp.title || inp.description || inp.key || inp.query || inp.trackerName || toolUse.name;
          const entityId = result?.id || result?.task?.id || result?.expense?.id || result?.habit?.id || result?.obligation?.id;
          const readOnlyTools = ["search", "get_summary", "recall_memory", "recall_actions", "get_goal_progress", "get_related", "navigate", "open_document"];
          if (!readOnlyTools.includes(toolUse.name) && result && !result.error) {
            logAction(toolUse.name, actionType, String(entityName), entityId);
          }

          // Handle document previews
          if (toolUse.name === "open_document" && result?.fileData) {
            const preview = { id: result.id, name: result.name, mimeType: result.mimeType, data: result.fileData };
            if (!documentPreview) documentPreview = preview;
            documentPreviews.push(preview);
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result ? summarizeResult(result) : { error: "Not found" }),
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
  };
  return mapping[toolName] || "unknown";
}

// Fallback rule-based parsing when AI is unavailable
async function fallbackParse(message: string): Promise<{ reply: string; actions: ParsedAction[]; results: any[] }> {
  const lower = message.toLowerCase();
  const actions: ParsedAction[] = [];
  const results: any[] = [];
  let reply = "";

  if (lower.startsWith("track ") || lower.startsWith("create tracker ")) {
    const name = message.replace(/^(track|create tracker)\s+/i, "").replace(/^my\s+/i, "");
    const tracker = await storage.createTracker({ name, category: "custom", fields: [{ name: "value", type: "number" }] });
    actions.push({ type: "create_tracker", category: "custom", data: { name } });
    results.push(tracker);
    reply = `Created a new tracker for "${name}". You can now log entries to it.`;
  } else if (lower.includes("spent") || lower.includes("bought") || lower.match(/\$\d+/)) {
    const amountMatch = message.match(/\$?([\d.]+)/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    const desc = message.replace(/\$[\d.]+/, "").replace(/spent|bought|on/gi, "").trim();
    if (amount > 0) {
      const expense = await storage.createExpense({ amount, category: "general", description: desc || "Expense", tags: [] });
      actions.push({ type: "log_expense", category: "finance", data: { amount, description: desc } });
      results.push(expense);
      reply = `Logged expense: $${amount} — ${desc || "Expense"}`;
    }
  } else if (lower.startsWith("remind") || lower.startsWith("todo") || lower.startsWith("task")) {
    const title = message.replace(/^(remind me to|remind|todo|task)\s*/i, "").trim();
    const task = await storage.createTask({ title, priority: "medium", tags: [] });
    actions.push({ type: "create_task", category: "task", data: { title } });
    results.push(task);
    reply = `Created task: "${title}"`;
  } else {
    reply = `I'm running in offline mode. Try commands like:\n• "ran 3 miles in 25:00"\n• "weight 183"\n• "bp 120/80"\n• "slept 7.5 hours"\n• "$50 groceries"\n• "mood good"\n• "done meditation"\n• "remind me to call mom"\n• "open my drivers license"`;
  }

  return { reply, actions, results };
}
