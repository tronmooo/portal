import { logger } from "./logger";
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import type { ParsedAction } from "@shared/schema";

// Rich visual output types (inline — shared/schema was reverted)
type ChartType = "line" | "bar" | "area" | "pie" | "scatter" | "composed" | "radar";
interface ChartSeries { dataKey: string; name: string; color?: string; type?: "line"|"bar"|"area"; stackId?: string; }
interface ChartSpec { type: ChartType; title: string; subtitle?: string; data: Array<Record<string, any>>; series: ChartSeries[]; xAxisKey: string; xAxisLabel?: string; yAxisLabel?: string; showLegend?: boolean; showGrid?: boolean; height?: number; nameKey?: string; valueKey?: string; }
interface TableColumn { key: string; label: string; align?: "left"|"center"|"right"; format?: "currency"|"date"|"number"|"percent"|"text"; }
interface TableSpec { title: string; subtitle?: string; columns: TableColumn[]; rows: Array<Record<string, any>>; summary?: Record<string, any>; }
interface ReportMetric { label: string; value: string | number; change?: string; changeType?: "positive"|"negative"|"neutral"; }
interface ReportSection { heading: string; content?: string; chart?: ChartSpec; table?: TableSpec; metrics?: ReportMetric[]; }
interface ReportSpec { title: string; subtitle?: string; sections: ReportSection[]; generatedAt: string; }

// Lazy-init: dotenv.config() runs after ESM imports resolve,
// so we defer client creation until first use.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ============================================================
// ASSET VALUATION — AI-powered market value estimation
// ============================================================

// Live web search for current market data — tries multiple sources
async function webSearch(query: string, numResults = 5): Promise<string> {
  // Helper: fetch URL and return body text
  const fetchUrl = (url: string): Promise<string> => {
    return new Promise(async (resolve) => {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          signal: AbortSignal.timeout(8000),
          redirect: "follow",
        });
        resolve(await resp.text());
      } catch { resolve(""); }
    });
  };

  // Try DuckDuckGo HTML search
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let html = await fetchUrl(ddgUrl);
  if (html) {
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gs)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
    const titles = [...html.matchAll(/class="result__a"[^>]*>(.*?)<\/a>/gs)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
    const results: string[] = [];
    for (let i = 0; i < Math.min(titles.length, snippets.length, numResults); i++) {
      if (snippets[i]) results.push(`${titles[i]}: ${snippets[i]}`);
    }
    if (results.length > 0) return results.join("\n");
  }

  // Fallback: try Brave Search (works from cloud IPs unlike DDG)
  const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  html = await fetchUrl(braveUrl);
  if (html && html.length > 1000) {
    // Brave uses 'snippet' classes for result content — extract all substantial snippets
    const allSnippets = [...html.matchAll(/class="[^"]*snippet[^"]*"[^>]*>(.*?)<\//gs)]
      .map(m => m[1].replace(/<[^>]+>/g, "").trim())
      .filter(s => s.length > 30);
    if (allSnippets.length > 0) {
      return allSnippets.slice(0, numResults * 2).join("\n");
    }
  }

  return "";
}

async function estimateAssetValue(profile: { type: string; name: string; fields: Record<string, any> }): Promise<{ estimatedValue: number; confidence: string; method: string; details: string } | null> {
  const valuableTypes = ["vehicle", "asset", "property", "investment"];
  if (!valuableTypes.includes(profile.type)) return null;

  const fieldDesc = Object.entries(profile.fields || {})
    .filter(([k, v]) => v && !k.startsWith("_"))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  if (!fieldDesc && !profile.name) return null;

  // Build search query based on asset type
  let searchQuery = "";
  const f = profile.fields || {};
  if (profile.type === "vehicle") {
    const year = f.year || f.modelYear || "";
    const make = f.make || "";
    const model = f.model || "";
    const mileage = f.mileage || "";
    searchQuery = `${year} ${make} ${model} used car value price ${mileage ? mileage + " miles" : ""} 2026 Kelley Blue Book`.trim();
  } else if (profile.type === "property") {
    const address = f.address || "";
    const city = f.city || "";
    const state = f.state || "";
    const zip = f.zip || f.zipCode || "";
    searchQuery = `${address} ${city} ${state} ${zip} home value estimate 2026 Zillow`.trim();
    if (searchQuery.length < 15) searchQuery = `${profile.name} home value estimate 2026`;
  } else if (f.assetSubtype === "collectible" || f.assetSubtype === "business") {
    searchQuery = `${profile.name} ${f.brand || ""} ${f.category || ""} value price estimate 2026`.trim();
  } else {
    // Electronics, generic assets
    const brand = f.brand || "";
    const model = f.model || "";
    searchQuery = `${brand} ${model || profile.name} used resale value price 2026`.trim();
  }

  // Do live web search
  let searchResults = "";
  try {
    searchResults = await webSearch(searchQuery);
    console.log(`[Valuation] Search query: "${searchQuery}" → ${searchResults.length} chars`);
  } catch (e) {
    console.warn("[Valuation] Web search failed:", e);
  }

  try {
    const prompt = searchResults
      ? `You have LIVE web search results for pricing this ${profile.type}. Use ONLY the search data to determine the value — do NOT guess or use outdated knowledge.\n\nAsset: "${profile.name}"\nDetails: ${fieldDesc}\n\n--- LIVE SEARCH RESULTS ---\n${searchResults}\n--- END SEARCH RESULTS ---\n\nBased on the search results above, return ONLY a JSON object:\n{"value": <number — the most accurate current value from search results>, "confidence": "high|medium|low", "method": "<source used, e.g. Zillow, Edmunds, KBB>", "range": "$X - $Y"}\n\nRules:\n- Use the EXACT prices from search results when available\n- For vehicles, use the fair market/trade-in range from the results\n- For homes, use the Zillow or Redfin estimate from search results\n- Return 0 only if search results have NO pricing data at all\n- confidence=high if exact match found, medium if similar model/area, low if rough estimate`
      : `Estimate the current US market value of this ${profile.type}: "${profile.name}". Details: ${fieldDesc}.\n\nReturn ONLY a JSON object: {"value": <number>, "confidence": "high|medium|low", "method": "<brief method>", "range": "<low-high range>"}\n\nBe realistic. Return 0 if you truly cannot estimate.`;

    const response = await getClient().messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const method = searchResults
        ? `Live search: ${parsed.method || "web data"}`
        : `AI estimate: ${parsed.method || "general knowledge"}`;
      return {
        estimatedValue: Number(parsed.value) || 0,
        confidence: parsed.confidence || "low",
        method,
        details: parsed.range || "",
      };
    }
  } catch (e) {
    console.error("[Valuation] Failed:", e);
  }
  return null;
}

// ============================================================
// CONTEXT CACHE — short-lived cache for AI context data (avoids repeated DB queries)
// ============================================================

interface ContextCache {
  data: any[] | null;
  timestamp: number;
}

// Per-user context cache — prevents cross-user data leakage (C-2 security fix)
// Each userId gets its own cache entry with independent TTL.
const contextCacheMap = new Map<string, ContextCache>();
const CONTEXT_CACHE_TTL = 5000; // 5 seconds

function invalidateContextCache(userId?: string) {
  if (userId) {
    contextCacheMap.delete(userId);
  } else {
    contextCacheMap.clear();
  }
}

async function getCachedContextData(userId?: string): Promise<any[]> {
  const cacheKey = userId || '_global';
  const now = Date.now();
  const cached = contextCacheMap.get(cacheKey);
  if (cached?.data && (now - cached.timestamp) < CONTEXT_CACHE_TTL) {
    return cached.data;
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
    storage.getJournalEntries(), // index 10
  ]);
  contextCacheMap.set(cacheKey, { data, timestamp: now });
  // Evict old entries to prevent memory leak
  if (contextCacheMap.size > 100) {
    const oldest = [...contextCacheMap.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 50; i++) contextCacheMap.delete(oldest[i][0]);
  }
  return data;
}

// ============================================================
// SAFE ENTITY MATCHING — prevents wrong-entity deletes/updates
// ============================================================

/**
 * Safely match an entity by name/title.
 * Prefers exact match, then starts-with, then contains.
 * For destructive operations (delete/update), returns error with candidates when ambiguous.
 */
function safeMatchEntity<T extends { id: string }>(
  items: T[],
  searchText: string,
  getField: (item: T) => string,
  opts?: { isDestructive?: boolean; filter?: (item: T) => boolean }
): { match?: T; error?: string; candidates?: Array<{ id: string; name: string }> } {
  const search = searchText.toLowerCase().trim();
  if (!search) return { error: "No search text provided" };

  const eligible = opts?.filter ? items.filter(opts.filter) : items;

  // 1. Exact match
  const exact = eligible.find(item => getField(item).toLowerCase().trim() === search);
  if (exact) return { match: exact };

  // 2. Starts-with match
  const startsWith = eligible.filter(item => getField(item).toLowerCase().trim().startsWith(search));
  if (startsWith.length === 1) return { match: startsWith[0] };

  // 3. Contains match
  const contains = eligible.filter(item => getField(item).toLowerCase().includes(search));
  if (contains.length === 1) return { match: contains[0] };
  if (contains.length === 0) return { error: `Not found: "${searchText}"` };

  // Multiple matches — for destructive ops, don't guess
  if (opts?.isDestructive || contains.length > 3) {
    return {
      error: `Multiple matches for "${searchText}". Please be more specific.`,
      candidates: contains.slice(0, 5).map(item => ({ id: item.id, name: getField(item) })),
    };
  }

  // For non-destructive, return the best match (shortest name = most specific)
  const best = contains.sort((a, b) => getField(a).length - getField(b).length)[0];
  return { match: best };
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

// Per-user action log — prevents cross-user activity leakage (C-3 security fix)
const actionLogMap = new Map<string, ActionLogEntry[]>();

function logAction(action: string, type: string, entityName: string, entityId?: string, userId?: string) {
  const key = userId || '_global';
  if (!actionLogMap.has(key)) actionLogMap.set(key, []);
  const log = actionLogMap.get(key)!;
  log.push({ timestamp: new Date().toISOString(), action, type, entityName, entityId });
  if (log.length > 20) log.shift();
}

export function getActionLog(count = 10, userId?: string): ActionLogEntry[] {
  const key = userId || '_global';
  return (actionLogMap.get(key) || []).slice(-count);
}

// ============================================================
// DEDUP LOCK — in-memory guard against concurrent duplicate creation
// ============================================================

const recentCreations = new Map<string, Map<string, number>>(); // userId -> (key -> timestamp)

function isDuplicateCreation(userId: string, key: string, windowMs = 30000): boolean {
  const userMap = recentCreations.get(userId);
  if (!userMap) return false;
  const ts = userMap.get(key);
  if (!ts) return false;
  return Date.now() - ts < windowMs;
}

function markCreation(userId: string, key: string) {
  if (!recentCreations.has(userId)) recentCreations.set(userId, new Map());
  const userMap = recentCreations.get(userId);
  if (userMap) userMap.set(key, Date.now());
  // Cleanup old entries
  setTimeout(() => {
    const userMap = recentCreations.get(userId);
    userMap?.delete(key);
    // Clean up empty user maps to prevent unbounded memory growth
    if (userMap && userMap.size === 0) recentCreations.delete(userId);
  }, 60000);
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

  // ┌─ JOURNAL FAST-PATH (runs BEFORE multi-intent guard) ─────────────────────┐
  // This bypasses the AI entirely for journal entries because the AI
  // persistently hallucinates that profiles "already have entries."
  const journalForMatch = lower.match(/(?:add|create|write|log)\s+(?:a\s+)?journal\s+(?:entry\s+)?for\s+(\w+)(?:\s*[:\-—]+\s*|\s+(?:saying|about|that|he|she|they)\s+)(.+)/i);
  if (journalForMatch) {
    const profileName = journalForMatch[1].trim();
    const content = journalForMatch[2].trim();
    const contentLC = content.toLowerCase();
    let mood: string = 'neutral';
    if (/amazing|incredible|fantastic|best/.test(contentLC)) mood = 'amazing';
    else if (/great|wonderful|excellent|energized|motivated|awesome/.test(contentLC)) mood = 'great';
    else if (/good|fine|nice|happy|pleasant/.test(contentLC)) mood = 'good';
    else if (/okay|alright|decent/.test(contentLC)) mood = 'okay';
    else if (/bad|rough|sore|tired|down|upset|stressed/.test(contentLC)) mood = 'bad';
    else if (/awful|horrible|dreadful|sick/.test(contentLC)) mood = 'awful';
    else if (/terrible|miserable|worst/.test(contentLC)) mood = 'terrible';
    const profiles = await storage.getProfiles();
    const profile = profiles.find(p => p.name.toLowerCase() === profileName.toLowerCase())
      || profiles.find(p => p.name.toLowerCase().includes(profileName.toLowerCase()));
    const entry = await storage.createJournalEntry({ mood: mood as any, content, tags: [] });
    if (profile) {
      try {
        await storage.updateJournalEntry(entry.id, { linkedProfiles: [profile.id] } as any);
        await storage.linkProfileTo(profile.id, "journal", entry.id).catch(() => {});
      } catch {}
    }
    actions.push({ type: "journal_entry", category: "journal", data: { mood, content, forProfile: profileName } });
    results.push(entry);
    return { matched: true, reply: `Journal entry saved for ${profile?.name || profileName}. Mood: ${mood}. "${content.slice(0, 100)}"`, actions, results };
  }
  // └─ END JOURNAL FAST-PATH ──────────────────────────────────────────┘

  // GUARD: Skip fast-path for multi-intent messages.
  // If the message contains multiple verbs/actions, conjunctions, or multiple sentences,
  // let the AI handle it to preserve all intents.
  const multiIntentSignals = [
    /\band\s+(?:also|then|i|my|please|add|log|create|set|track|record|remind|play|spent|bought|ate|drank|took|went)/i,
    /\band\s+\w+ed\b/i,  // "and played", "and spent", "and walked"
    /[.!?]\s+[A-Z]/,     // Multiple sentences
    /,\s*(?:also|then|and|plus)/i,  // Comma-separated actions
    /\balso\b.*\b(?:add|log|create|set|track|remind|save|record)\b/i,
  ];
  if (multiIntentSignals.some(re => re.test(message))) {
    return { matched: false, reply: "", actions: [], results: [] };
  }

  // Count distinct action verbs — if 2+, it's multi-intent, let the AI handle it
  const actionVerbs = lower.match(/\b(?:ran|run|walked|walk|played|play|spent|bought|ate|drank|slept|logged|tracked|created|added|reminded|weight|bp|mood|feeling|swam|cycled|biked|lifted|meditated|practiced|cooked|read|studied|worked)\b/gi) || [];
  const uniqueVerbs = new Set(actionVerbs.map(v => v.toLowerCase()));
  if (uniqueVerbs.size >= 2) {
    return { matched: false, reply: "", actions: [], results: [] };
  }

  // PROFILE DETECTION: If message starts with a non-self profile name, bail to AI.
  // The AI path has robust profile resolution (tracker ownership, forProfile routing).
  // Fast-path has zero profile awareness, so any profile-prefixed message must go to AI.
  try {
    const profiles = await storage.getProfiles();
    const nonSelfProfiles = profiles.filter(p => p.type !== "self" && p.name.length >= 2);
    // Sort longest name first to avoid "Rex" matching before "Rex Jr."
    nonSelfProfiles.sort((a, b) => b.name.length - a.name.length);
    for (const p of nonSelfProfiles) {
      const nameLC = p.name.toLowerCase();
      // Check: "Rex ran...", "Rex's weight...", "mom ran...", "Mom's bp..."
      if (lower.startsWith(nameLC + " ") || lower.startsWith(nameLC + "'") || lower.startsWith(nameLC + "\u2019")) {
        logger.info("ai", `Fast-path bail: message starts with profile "${p.name}" — routing to AI for profile-aware handling`);
        return { matched: false, reply: "", actions: [], results: [] };
      }
    }
  } catch { /* if profile fetch fails, continue with fast-path */ }

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

  // ---- Habit check-in (expanded): "done meditation", "mark off my run", "I went on my morning run" ----
  const habitCheckinMatch = lower.match(/^(?:done|did|completed?|checked?\s*in|✓|✅)\s+(.+)/)
    || lower.match(/^(?:mark|check)\s+off\s+(?:my\s+|that\s+(?:i\s+)?)?(.+?)(?:\s+(?:habit|today|for today|on my (?:habits?|list)))?$/)
    || lower.match(/^i\s+(?:went\s+on|did|completed|finished)\s+(?:my\s+)?(.+?)(?:\s+today|\s+this morning|\s+tonight)?$/)
    || lower.match(/^(?:more often (?:that|than)\s+)?i\s+went\s+(?:on|for)\s+(?:my\s+)?(.+?)$/);
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
      // Bail to AI if multiple weight trackers exist (ambiguous)
      const weightTrackers = trackers.filter(t => t.name.toLowerCase().includes("weight"));
      if (weightTrackers.length > 1) return { matched: false, reply: "", actions: [], results: [] };
      const weightTracker = weightTrackers[0] || trackers.find(t => t.name.toLowerCase() === "weight");
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
    // Bail to AI if multiple BP trackers exist (ambiguous)
    const bpTrackers = trackers.filter(t => t.name.toLowerCase().includes("blood pressure"));
    if (bpTrackers.length > 1) return { matched: false, reply: "", actions: [], results: [] };
    const bpTracker = bpTrackers[0];
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
    const sleepTrackers = trackers.filter(t => t.name.toLowerCase().includes("sleep"));
    if (sleepTrackers.length > 1) return { matched: false, reply: "", actions: [], results: [] };
    const sleepTracker = sleepTrackers[0] || trackers.find(t => t.name.toLowerCase() === "sleep");
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
    const entry = await storage.createJournalEntry({ mood, content: "", tags: [] });
    actions.push({ type: "journal_entry", category: "journal", data: { mood } });
    results.push(entry);
    return { matched: true, reply: `Logged mood: ${mood}. Add more thoughts whenever you want.`, actions, results };
  }

  // (Journal fast-path for profiles moved to top of tryFastPath — before multi-intent guard)

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
  const extractionPrompt = `Extract every data point you can read from this document. Return valid JSON:

{"documentType": "<type>", "label": "<short title>", "extractedData": {<every field you can read>}, "targetProfile": null, "trackerEntries": [], "summary": "<one line>"}

Document types: drivers_license, medical_report, lab_results, prescription, insurance_card, insurance_policy, receipt, invoice, bank_statement, vehicle_registration, warranty, pet_record, vaccination_record, or other.

For lab reports, also fill trackerEntries: [{"trackerName": "<test>", "values": {"value": <number>}, "unit": "<unit>", "category": "health"}]

${userMessage ? `User said: "${userMessage}"` : ""}

Extract every single field. Do not skip anything. Do not make up data — only return what you actually read from the document.`;

  try {
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";
    const mediaType = isImage ? mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" : "image/jpeg";

    // Send the raw image directly to the API — no preprocessing.
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,")
    let cleanBase64 = base64Data;
    if (cleanBase64.includes(',')) {
      cleanBase64 = cleanBase64.split(',').pop() || cleanBase64;
    }
    // Strip any whitespace/newlines that could corrupt the base64
    cleanBase64 = cleanBase64.replace(/\s/g, '');
    console.log(`[extraction] Sending to Claude: type=${isImage ? 'image' : isPdf ? 'pdf' : 'text'}, mime=${mimeType}, base64 length=${cleanBase64?.length}, first 30 chars=${cleanBase64?.slice(0, 30)}`);
    const messageContent: any[] = [];
    if (isImage || isPdf) {
      messageContent.push({
        type: isPdf ? "document" : "image",
        source: { type: "base64", media_type: isPdf ? "application/pdf" : mediaType, data: cleanBase64 },
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
      model: "claude-sonnet-4-5-20250929", // Sonnet 4.5/4.6 — same model as Claude app, best vision accuracy
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          ...messageContent,
          { type: "text", text: extractionPrompt },
        ],
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    console.log(`[extraction] Claude response (first 500 chars): ${text.slice(0, 500)}`);
    let parsed: any;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch { parsed = {}; }
    console.log(`[extraction] Parsed fields: ${Object.keys(parsed.extractedData || {}).join(', ')}`);

    // === TWO-PASS LAB EXTRACTION ===
    // If this is a lab report/medical document but Haiku missed the lab values, do a focused second pass
    const isLabType = /lab|medical|blood|panel|cbc|metabolic|lipid|results/i.test(parsed.documentType || '') || /lab|medical|blood|panel|results/i.test(parsed.label || '');
    if (isLabType && (!parsed.trackerEntries || parsed.trackerEntries.length < 3)) {
      console.log(`[extraction] Lab report detected with only ${parsed.trackerEntries?.length || 0} tracker entries. Running focused second pass...`);
      try {
        const labPrompt = `This is a lab report or medical document. Your ONLY job is to extract ALL numeric test results.

Look at EVERY row in the results table. For each test, extract the test name, the numeric result value, and the unit.

Return ONLY a JSON array. Each element: {"trackerName": "<test name>", "values": {"value": <number>}, "unit": "<unit>", "category": "health"}

Rules:
- Read EVERY line of the results table from top to bottom
- Only include tests that have a numeric value
- Use the EXACT numbers printed in the document
- Common tests: WBC, RBC, Hemoglobin, Hematocrit, Platelets, MCV, MCH, MCHC, Glucose, BUN, Creatinine, Sodium, Potassium, Chloride, CO2, Calcium, Total Protein, Albumin, Bilirubin, ALT, AST, Cholesterol, Triglycerides, HDL, LDL, A1C, TSH
- Return [] if you cannot read any values

Return ONLY the JSON array, nothing else.`;

        const labResponse = await getClient().messages.create({
          model: process.env.ANTHROPIC_EXTRACTION_MODEL || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          messages: [{
            role: "user",
            content: [
              ...messageContent,
              { type: "text", text: labPrompt },
            ],
          }],
        });

        const labText = labResponse.content[0].type === "text" ? labResponse.content[0].text : "[]";
        try {
          const arrayMatch = labText.match(/\[[\s\S]*\]/);
          const labEntries = arrayMatch ? JSON.parse(arrayMatch[0]) : [];
          if (Array.isArray(labEntries) && labEntries.length > 0) {
            // Validate entries: must have trackerName, numeric value, unit
            const validEntries = labEntries.filter((e: any) => 
              e.trackerName && 
              typeof e.values?.value === 'number' && 
              e.values.value !== 0 &&
              e.unit
            );
            if (validEntries.length > (parsed.trackerEntries?.length || 0)) {
              console.log(`[extraction] Second pass found ${validEntries.length} lab values (vs ${parsed.trackerEntries?.length || 0} from first pass)`);
              parsed.trackerEntries = validEntries;
            }
          }
        } catch (e) {
          console.error('[extraction] Failed to parse second-pass lab results:', e);
        }
      } catch (e) {
        console.error('[extraction] Second-pass lab extraction failed:', e);
      }
    }

    // Date sanity check: if this is a license/ID and expiration looks wrong (same as issue or too close), re-query for dates
    if (parsed.documentType?.includes('license') || parsed.documentType?.includes('passport') || parsed.documentType?.includes('registration')) {
      const exp = parsed.extractedData?.expirationDate;
      const iss = parsed.extractedData?.issueDate;
      // If expiration equals issue date, or expiration is less than 2 years from issue, it's likely wrong
      // Keep the potentially-wrong expiration but mark it as uncertain
      if (exp && iss && (exp === iss || (new Date(exp).getTime() - new Date(iss).getTime()) < 2 * 365 * 86400000)) {
        // The expiration date is likely wrong (same as issue date) — add a note
        console.log(`[extraction] Suspicious expiration: ${exp} is same/close to issue ${iss}. Keeping but flagging.`);
        // Don't remove it, but the user can correct it via inline edit
      }
    }

    // Resolve target profile (for linking the document), but do NOT update profile fields yet
    let linkedProfiles: string[] = [];
    let existingProfileId: string | undefined;

    if (profileId) {
      // Support comma-separated profile IDs for multi-select linking
      const profileIds = profileId.split(",").filter(Boolean);
      const validIds: string[] = [];
      for (const pid of profileIds) {
        const p = await storage.getProfile(pid);
        if (p) validIds.push(pid);
      }
      if (validIds.length > 0) {
        linkedProfiles = validIds;
        existingProfileId = validIds[0];
      }
    } else if (parsed.targetProfile?.name) {
      const profiles = await storage.getProfiles();
      const targetLower = parsed.targetProfile.name.toLowerCase().trim();
      // Only match profiles with high confidence — exact name match or very close match
      // Avoid matching "Dr. Alex Thomson" to "Alex Williams" (partial first-name matches)
      const existing = profiles.find((p: any) => {
        const pLower = p.name.toLowerCase().trim();
        // Exact match
        if (pLower === targetLower) return true;
        // One name contains the other fully (e.g., "Jane Doe" contains "Jane Doe")
        if (pLower.includes(targetLower) || targetLower.includes(pLower)) return true;
        // Skip single-word partial matches (too many false positives like Alex→Alex Williams)
        return false;
      });
      if (existing) {
        linkedProfiles = [existing.id];
        existingProfileId = existing.id;
      }
      // Do NOT create new profiles automatically — defer to confirmation
    }

    // Store the document (always save the file)
    // Deduplicate: if a document with the same name already exists for the same profiles, update it instead
    const docName = parsed.label || fileName;
    let document: any = null;
    const existingDocs = await storage.getDocuments();
    const existingDoc = existingDocs.find((d: any) => {
      if (d.name !== docName) return false;
      // Must share at least one linked profile (or both have none)
      if (linkedProfiles.length === 0 && d.linkedProfiles.length === 0) return true;
      return linkedProfiles.some((pid: string) => d.linkedProfiles.includes(pid));
    });
    if (existingDoc) {
      // Update existing document instead of creating a duplicate
      document = await storage.updateDocument(existingDoc.id, {
        mimeType,
        fileData: base64Data,
        extractedData: parsed.extractedData || {},
        linkedProfiles: Array.from(new Set([...existingDoc.linkedProfiles, ...linkedProfiles])),
        tags: Array.from(new Set([...(existingDoc.tags || []), parsed.documentType || "uploaded"])),
      });
      console.log(`[Upload] Updated existing document "${docName}" (${existingDoc.id}) instead of creating duplicate`);
    } else {
      document = await storage.createDocument({
        name: docName,
        type: parsed.documentType || "other",
        mimeType,
        fileData: base64Data,
        extractedData: parsed.extractedData || {},
        linkedProfiles,
        tags: [parsed.documentType || "uploaded"],
      });
    }
    results.push(document);

    // === AUTO-PROPAGATE: Link document to parent profiles up the chain ===
    // e.g., warranty uploaded to "Tesla Model S" also shows under "Me" profile
    if (existingProfileId && document?.id) {
      try {
        const propagated = await storage.propagateDocumentToAncestors(document.id, existingProfileId);
        if (propagated.length > 0) {
          console.log(`[Upload] Document auto-propagated to: ${propagated.join(', ')}`);
        }
      } catch (err: any) {
        console.error("Document propagation failed:", err.message);
      }
    }

    // === EXTRACTION: Profile fields are NOT auto-saved here anymore (M-4 fix). ===
    // The user reviews extracted data in the pending extraction UI and confirms.
    // Only the /api/chat/confirm-extraction endpoint writes to the profile.
    const savedItems: string[] = [];

    // Note what will be available for the user to confirm
    if (existingProfileId && parsed.extractedData && Object.keys(parsed.extractedData).length > 0) {
      const profileName = (await storage.getProfile(existingProfileId))?.name || "profile";
      savedItems.push(`${Object.keys(parsed.extractedData).length} fields ready for ${profileName} (confirm to save)`);
    }

    // Auto-create expense if the document has any dollar amount
    // Helper to unwrap {value, confidence} objects
    const unwrapVal = (v: any) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;
    const rawAmount = unwrapVal(parsed.extractedData?.totalAmount) || unwrapVal(parsed.extractedData?.totalAmountDue) || unwrapVal(parsed.extractedData?.totalDue) || unwrapVal(parsed.extractedData?.amountDue) || unwrapVal(parsed.extractedData?.amountPaid) || unwrapVal(parsed.extractedData?.balance) || unwrapVal(parsed.extractedData?.total_amount) || unwrapVal(parsed.extractedData?.amount_due) || unwrapVal(parsed.extractedData?.totalDispCD);
    const numAmount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount));
    if (numAmount && isFinite(numAmount) && numAmount > 0) {
      try {
        const docType = (parsed.documentType || "receipt").toLowerCase();
        const category = ["vehicle", "registration", "citation", "parking", "toll", "dmv"].some(t => docType.includes(t)) ? "vehicle"
          : ["medical", "prescription", "lab", "health", "doctor", "hospital"].some(t => docType.includes(t)) ? "health"
          : ["utility", "bill", "electric", "water", "gas"].some(t => docType.includes(t)) ? "utilities"
          : ["insurance"].some(t => docType.includes(t)) ? "insurance"
          : ["bank", "loan", "statement"].some(t => docType.includes(t)) ? "general"
          : "general";
        const desc = parsed.label || parsed.summary || fileName;
        const expenseDate = parsed.extractedData?.issueDate || parsed.extractedData?.dateIssued || parsed.extractedData?.serviceDate || parsed.extractedData?.statementDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const expense = await storage.createExpense({
          amount: numAmount,
          category,
          description: desc,
          date: typeof expenseDate === 'string' && expenseDate.match(/^\d{4}-\d{2}-\d{2}/) ? expenseDate : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
          tags: ["from-document"],
        });
        // Link to the asset/profile AND propagate up to the self (Me) profile
        if (existingProfileId) {
          await storage.linkProfileTo(existingProfileId, "expense", expense.id);
          // Propagate up: Honda → Me, so it shows in Me's Finance tab too
          try { await storage.propagateEntityToAncestors("expense", expense.id, existingProfileId); } catch (e: any) { logger.warn("ai", `Fast-path propagate failed for expense ${expense.id}: ${e?.message}`); }
        }
        // Also always link to self profile so it appears in the main Finance view
        const profiles = await storage.getProfiles();
        const selfProfile = profiles.find(p => p.type === 'self');
        if (selfProfile && selfProfile.id !== existingProfileId) {
          try { await storage.linkProfileTo(selfProfile.id, "expense", expense.id); } catch (e: any) { logger.warn("ai", `Fast-path self-link failed for expense ${expense.id}: ${e?.message}`); }
        }
        savedItems.push(`$${numAmount} expense saved to Finance`);
        actions.push({ type: "log_expense" as const, category: "finance" as const, data: { amount: numAmount, description: desc } });
        results.push(expense);
      } catch (e) {
        console.error("Auto-expense from document failed:", e);
      }
    }

    // NOTE: Calendar events are NO LONGER auto-created from extracted dates.
    // Extracted dates are presented in the pending extraction UI for user review.
    // Users confirm which dates should become calendar events via the review flow.

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
              try { await storage.updateTracker(tracker.id, { linkedProfiles: [existingProfileId] } as any); } catch (e: any) { logger.warn("ai", `Fast-path tracker link failed for ${tracker.id}: ${e?.message}`); }
            }
            savedItems.push(`Created tracker: ${humanName}`);
          } else if (existingProfileId) {
            // Tracker exists — ensure it's linked to the target profile (not just "Me")
            const currentLinked = tracker.linkedProfiles || [];
            if (!currentLinked.includes(existingProfileId)) {
              try {
                await storage.updateTracker(tracker.id, { linkedProfiles: [...currentLinked, existingProfileId] } as any);
                console.log(`[extraction] Linked existing tracker ${tracker.name} to profile ${existingProfileId}`);
              } catch (e: any) { logger.warn("ai", `Tracker link update failed for ${tracker.id}: ${e?.message}`); }
            }
          }
          const entryValues = entry.values && typeof entry.values === "object" ? entry.values : { value: entry.values || 0 };
          await storage.logEntry({ trackerId: tracker.id, values: entryValues, notes: `From document: ${parsed.label || fileName}` });
          savedItems.push(`Logged ${humanName}: ${Object.values(entryValues).join(", ")} ${entry.unit || ""}`);
        } catch (err: any) {
          console.error("Auto-create tracker failed:", err.message);
        }
      }
    }

    // Calendar events from extracted dates are NO LONGER auto-created.
    // Dates are presented in the extraction review UI for user confirmation.

    // Build extraction fields list for the pending extraction UI
    const extractedFields: Array<{key: string; label: string; value: any; selected: boolean; isDate: boolean; suggestedEvent?: string}> = [];

    if (parsed.extractedData) {
      const DATE_PATTERNS = /\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4}/;
      for (const [key, rawValue] of Object.entries(parsed.extractedData)) {
        // Unwrap {value, confidence} objects from the AI response
        const value = (rawValue && typeof rawValue === 'object' && 'value' in (rawValue as any)) ? (rawValue as any).value : rawValue;
        // Replace the extractedData entry with the unwrapped value too
        parsed.extractedData[key] = value;
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

    // Sort extracted fields alphabetically by label for consistent UI display
    extractedFields.sort((a, b) => a.label.localeCompare(b.label));

    // The photo's linked profile (from user selection) is the default destination.
    // If the AI also detected a target profile, include that info too.
    // Priority: user-selected profileId > AI-detected targetProfile
    let resolvedTargetProfile: { name: string; id?: string; type?: string; isNew: boolean } | undefined;
    if (existingProfileId) {
      // User explicitly linked the photo to a profile — use that as default
      const linkedProfile = await storage.getProfile(existingProfileId);
      resolvedTargetProfile = {
        name: linkedProfile?.name || parsed.targetProfile?.name || 'Unknown',
        id: existingProfileId,
        type: linkedProfile?.type || parsed.targetProfile?.type,
        isNew: false,
      };
    } else if (parsed.targetProfile) {
      // AI detected a target but user didn't select one — show AI suggestion
      resolvedTargetProfile = {
        name: parsed.targetProfile.name,
        id: undefined,
        type: parsed.targetProfile.type,
        isNew: true,
      };
    }

    const pendingExtraction = {
      extractionId: document.id,
      fileName,
      documentType: parsed.documentType || "other",
      label: parsed.label || fileName,
      extractedFields,
      targetProfile: resolvedTargetProfile,
      trackerEntries: parsed.trackerEntries || [],
      documentPreview: { id: document.id, name: document.name, mimeType: document.mimeType },
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
    const errMsg = err?.message || String(err);
    console.error("File extraction error:", errMsg);
    console.error("File extraction stack:", err?.stack);
    // Still store the document even if AI fails
    const document = await storage.createDocument({
      name: fileName,
      type: "other",
      mimeType,
      fileData: base64Data,
      extractedData: {},
      linkedProfiles: profileId ? profileId.split(",").filter(Boolean) : [],
      tags: ["uploaded"],
    });
    const documentPreview = {
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      data: document.fileData,
    };
    // Provide a more informative error message
    let reply = `Saved "${fileName}"`;
    if (errMsg.includes('Could not process image') || errMsg.includes('invalid_image') || errMsg.includes('too large')) {
      reply += ` but the image couldn't be processed (it may be too large or in an unsupported format). You can link it to a profile manually.`;
    } else if (errMsg.includes('rate_limit') || errMsg.includes('429')) {
      reply += ` but extraction is temporarily unavailable (rate limited). Try again in a minute.`;
    } else if (errMsg.includes('overloaded') || errMsg.includes('529')) {
      reply += ` but the AI service is busy right now. Try again shortly.`;
    } else {
      reply += ` but couldn't extract data automatically. You can link it to a profile manually.`;
    }
    return {
      reply,
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
    description: "Create a new profile. Choose the right type and include entity-specific fields. Pet: breed, species, color, birthday, weight. Vehicle: make, model, year, VIN, mileage, color. Loan: lender, amount, apr, term, monthlyPayment. Property: address, type, sqft, bedrooms. Asset: brand, model, purchaseDate, purchasePrice, serialNumber, warranty (subtype auto-detected: high_value_item, bank_account, credit_card, digital_asset, business, collectible, loan_receivable). Subscription: provider, plan, cost, renewalDate. Medical: specialty, clinic, phone. Person: phone, email, relationship, birthday. IMPORTANT: When creating a vehicle, asset, subscription, loan, investment, account, or property FOR a specific person (e.g. \"Bob Johnson's Honda\"), set forProfile to that person's name so the asset is linked as their child profile.",
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
        forProfile: { type: "string", description: "Owner profile name. When creating a vehicle/asset/subscription/loan/investment/property FOR someone (e.g. 'Bob Johnson's car'), set this to the owner's name. The created profile will be a child of that person." },
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
        forProfile: { type: "string", description: "Name of an EXISTING profile to link this task to (e.g. 'Max', 'Mom', 'Tesla'). Only set this if the person/entity already exists as a profile. If the user just mentions someone by name in the task (e.g. 'return book to Sarah'), put the name in the title instead — do NOT create a profile for them." },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as DONE/COMPLETE. Use this when user says 'I completed X', 'mark X as done', 'finished X task', 'checked off X', 'did X', 'I did the X task'. Find by title. NEVER use create_task when the user is referring to completing an EXISTING task. If task is not found, say so — do NOT create a new one.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the task to complete (partial match)" },
        forProfile: { type: "string", description: "Profile name to narrow the search when the user mentions whose task it is (e.g. 'Joe', 'Mom')." },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task by title. Use when user says 'delete X task', 'remove X', 'get rid of X task'. NEVER use this when user says 'complete' or 'done' — those use complete_task instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the task to delete (partial match)" },
        forProfile: { type: "string", description: "Profile name to narrow the search." },
      },
      required: ["title"],
    },
  },

  // --- CRUD: Trackers ---
  {
    name: "log_tracker_entry",
    description: "Log values to a tracker. CRITICAL: trackerName MUST match the actual activity — use 'Basketball' for basketball (not 'Running'), 'Tennis' for tennis, 'Soccer' for soccer, 'Swimming' for swimming, etc. Each sport has its own tracker. Never log basketball into a Running tracker. If no matching tracker exists, one will be auto-created with the correct name.",
    input_schema: {
      type: "object" as const,
      properties: {
        trackerName: { type: "string", description: "Name of the tracker — MUST be the specific activity: 'Basketball' for basketball, 'Tennis' for tennis, 'Running' for running, 'Soccer' for soccer, 'Swimming' for swimming, 'Yoga' for yoga. Never use 'Running' for a non-running sport." },
        values: { type: "object", description: "Key-value pairs to log. ALWAYS include all relevant derived fields. FITNESS (any sport): { activityType, duration, caloriesBurned, intensity } + sport-specific fields (distance for running, sets for tennis, etc.). Nutrition: { calories, protein, carbs, fat, item }. BP: { systolic, diastolic }. Weight: { weight }. Sleep: { hours, quality }. The activityType field is REQUIRED for any fitness/sport entry." },
        notes: { type: "string", description: "Optional context notes for this entry (e.g., 'morning reading', 'after workout', 'chicken sandwich from subway')" },
        forProfile: { type: "string", description: "Name of the profile this entry belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this for any person, pet, vehicle, asset, or subscription mentioned." },
      },
      required: ["trackerName", "values"],
    },
  },
  {
    name: "create_tracker",
    description: `Create a smart tracker that auto-generates the right fields for ANY domain. YOU decide the fields based on what the user wants to track.

FIELD INFERENCE RULES — generate fields dynamically:
• HEALTH: Blood Pressure → [systolic:number, diastolic:number, pulse:number, position:select(sitting,standing,lying)]. Blood Glucose → [reading:number, context:select(fasting,post-meal,bedtime), insulinDose:number]. Symptoms → [symptom:text, severity:number(1-10), duration:text, triggers:text]. Pain → [level:number(1-10), location:text, type:select(sharp,dull,throbbing,burning), triggers:text].
• MEDICATION: [drugName:text, dosage:text, timeTaken:text, adherence:select(taken,skipped,missed), sideEffects:text, notes:text]. Category MUST be "medication".
• FITNESS: Running → [distance:number, duration:number, pace:number, caloriesBurned:number, intensity:select(easy,moderate,hard)]. Strength → [exercise:text, sets:number, reps:number, weight:number]. Yoga → [duration:number, poses:text, flexibility:number(1-10)].
• NUTRITION: [item:text, calories:number, protein:number, carbs:number, fat:number, mealType:select(breakfast,lunch,dinner,snack)].
• SLEEP: [hours:number, quality:select(poor,fair,good,excellent), bedtime:text, wakeTime:text, disturbances:number].
• MENTAL: Mood → [mood:select(great,good,okay,bad,awful), energy:number(1-5), anxiety:number(1-10), triggers:text]. Meditation → [duration:number, type:select(guided,breathing,body-scan,unguided), focusQuality:number(1-10)].
• LIFESTYLE: Screen Time → [totalMinutes:number, category:select(social,work,entertainment), focusSessions:number]. Reading → [pages:number, minutes:number, book:text]. Pet Care → [activity:select(feeding,walking,grooming,medication), duration:number, notes:text].
• FINANCE: Spending → [amount:number, category:text, description:text]. Savings → [amount:number, goal:text, method:text].
• CUSTOM: For anything else, infer 3-6 relevant fields. Use number for measurable values, select for predefined options, text for free-form, boolean for yes/no.

RULES: Always include at least 2 fields. Use select type with options in parentheses for categorical data. Use number for anything measurable. Include a notes:text field for complex trackers. Set category to the best match: health, fitness, nutrition, sleep, mental, lifestyle, finance, medication, custom.`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tracker name (e.g. 'Blood Pressure', 'Tylenol', 'Running')" },
        category: { type: "string", description: "Category: health | fitness | nutrition | sleep | mental | lifestyle | finance | medication | custom" },
        unit: { type: "string", description: "Primary unit if applicable (mg/dL, lbs, miles, minutes, etc.)" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Field key (camelCase)" },
              type: { type: "string", enum: ["number", "text", "boolean", "select", "duration"], description: "Field type" },
              label: { type: "string", description: "Human-readable label" },
              unit: { type: "string", description: "Unit for this field (mg, lbs, min, etc.)" },
              options: { type: "array", items: { type: "string" }, description: "Options for select fields" },
              min: { type: "number", description: "Min value for number fields" },
              max: { type: "number", description: "Max value for number fields" },
            },
          },
          description: "Smart field definitions — generate these dynamically based on what the user wants to track",
        },
        forProfile: { type: "string", description: "Profile name this tracker belongs to (e.g. 'Joe', 'Mom', 'Max'). ALWAYS set for person/pet/vehicle." },
      },
      required: ["name", "fields"],
    },
  },

  // --- CRUD: Budgets ---
  {
    name: "set_budget",
    description: "Set or update a monthly budget for a spending category. Creates or updates the budget amount for a specific category and month.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Budget category. MUST be one of: food, transport, health, pet, vehicle, entertainment, shopping, utilities, housing, insurance, subscription, education, personal, general" },
        amount: { type: "number", description: "Monthly budget amount in dollars" },
        month: { type: "string", description: "Month in YYYY-MM format. Use current month if not specified." },
        notes: { type: "string", description: "Optional notes about this budget" },
      },
      required: ["category", "amount"],
    },
  },
  {
    name: "delete_budget",
    description: "Delete a budget for a specific category and month.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Budget category to delete" },
        month: { type: "string", description: "Month in YYYY-MM format. Use current month if not specified." },
      },
      required: ["category"],
    },
  },
  {
    name: "get_budget_summary",
    description: "Get the budget vs actual spending summary for a month. Shows all budget categories with budgeted amounts and actual spending.",
    input_schema: {
      type: "object" as const,
      properties: {
        month: { type: "string", description: "Month in YYYY-MM format. Use current month if not specified." },
      },
      required: [],
    },
  },

  // --- Paychecks, Loans, Cashflow ---
  {
    name: "log_expected_paycheck",
    description: "Log an expected paycheck with source, amount, and expected date",
    input_schema: {
      type: "object" as const,
      properties: {
        source: { type: "string", description: "Paycheck source (employer name, freelance client, etc.)" },
        amount: { type: "number", description: "Expected amount" },
        expected_date: { type: "string", description: "Expected date (YYYY-MM-DD)" },
        notes: { type: "string", description: "Optional notes" }
      },
      required: ["source", "amount", "expected_date"]
    }
  },
  {
    name: "confirm_paycheck_received",
    description: "Confirm a paycheck was received. Marks it as confirmed with the actual received date and amount.",
    input_schema: {
      type: "object" as const,
      properties: {
        paycheck_id: { type: "string", description: "ID of the paycheck to confirm" },
        actual_amount: { type: "number", description: "Actual amount received (if different from expected)" }
      },
      required: ["paycheck_id"]
    }
  },
  {
    name: "get_loan_schedule",
    description: "Get the full amortization schedule for a loan, showing each payment with principal, interest, and remaining balance",
    input_schema: {
      type: "object" as const,
      properties: {
        loan_id: { type: "string", description: "ID of the loan profile" }
      },
      required: ["loan_id"]
    }
  },
  {
    name: "get_cashflow",
    description: "Get weekly cash flow projections vs actuals for a given month. Shows projected and actual income/expenses by week.",
    input_schema: {
      type: "object" as const,
      properties: {
        month: { type: "string", description: "Month in YYYY-MM format (defaults to current month)" }
      },
      required: []
    }
  },

  // --- CRUD: Expenses ---
  {
    name: "create_expense",
    description: "Log a one-time financial expense. Use this when the user says 'spent X on Y', 'paid X for Y', 'bought X', or mentions any one-time payment. This includes rent payments (e.g. 'paid rent $1500'), groceries, gas, dining, utilities, medical bills, etc. If the user just spent money on something — use this, not create_obligation.",
    input_schema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Amount in dollars" },
        description: { type: "string", description: "What was purchased" },
        category: { type: "string", description: "Category. MUST be one of: food, transport, health, pet, vehicle, entertainment, shopping, utilities, housing, insurance, subscription, education, personal, general. You MUST infer the best category from context — NEVER default to 'general' if ANY other category fits. Examples: groceries/restaurant/coffee → food, uber/gas/parking → transport, vet/pet food/grooming → pet, oil change/tires/car wash → vehicle, gym/doctor/pharmacy → health, Netflix/Spotify → subscription, rent/mortgage → housing, electric/water/internet → utilities, Amazon/clothes/electronics → shopping, movies/games/concerts → entertainment." },
        date: { type: "string", description: "Date of the expense in YYYY-MM-DD format. Use today's date if not specified. Use the actual date the expense occurred if the user says 'yesterday', 'last Tuesday', etc." },
        vendor: { type: "string", description: "Store or vendor name" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        forProfile: { type: "string", description: "REQUIRED when expense is for a specific entity. Set to the EXACT profile name. Examples: 'Mom', 'Rex', 'Honda CR-V 2021', 'iPhone 17 Pro Max', 'Tesla Model S'. ALWAYS set this for expenses tied to any person, pet, vehicle, asset, or subscription. If the user says 'bought X for my iPhone', forProfile MUST be 'iPhone 17 Pro Max' (the full profile name)." },
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
        forProfile: { type: "string", description: "Name of the profile this event belongs to (e.g. 'Max', 'Mom', 'Tesla'). ALWAYS set this for any person, pet, vehicle, asset, or subscription mentioned." },
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
        forProfile: { type: "string", description: "Name of the profile this habit belongs to. ALWAYS set when the user mentions a specific person or pet." },
      },
      required: ["name"],
    },
  },
  {
    name: "checkin_habit",
    description: "Check in to a habit — mark it DONE for today. Use this whenever the user says 'I did X', 'mark X done', 'completed X habit', 'checked off X'. Find by habit name. Set forProfile when checking in someone else's habit (e.g. 'Joe', 'Rex', 'Mom').",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Habit name (partial match)" },
        forProfile: { type: "string", description: "Profile name if this habit belongs to someone other than the user (e.g. 'Joe', 'Rex', 'Mom'). Omit for user's own habits." },
      },
      required: ["name"],
    },
  },

  // --- CRUD: Obligations ---
  {
    name: "create_obligation",
    description: "Create a RECURRING bill, subscription, loan payment, or ongoing financial obligation that repeats on a schedule. ONLY use this when the user explicitly mentions recurring/monthly/weekly/yearly payments, subscriptions, or bills. DO NOT use for one-time expenses. 'Spent $1500 on rent' = expense (use create_expense). 'I pay $1500 rent every month' = obligation. 'Netflix subscription' = obligation. 'Spent $50 on groceries' = expense.",
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
    description: "Create a journal/mood entry for the user or for a specific profile. Use when user says 'add a journal entry', 'log that X felt Y', 'write that X happened', 'journal entry for Joe'. mood is optional — infer it from context (sore/tired → 'bad', motivated/energetic → 'great', neutral/normal → 'neutral'). Defaults to 'neutral' if unknown.",
    input_schema: {
      type: "object" as const,
      properties: {
        mood: { type: "string", enum: ["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"], description: "Mood level (optional — infer from context). 'amazing/incredible' → amazing, 'great/wonderful' → great, 'good/fine' → good, 'okay/alright' → okay, 'meh/indifferent' → neutral, 'bad/rough/sore/tired' → bad, 'awful/horrible' → awful, 'terrible/miserable' → terrible. Default: 'neutral'" },
        content: { type: "string", description: "Journal content. Write a full sentence summarizing what the user said." },
        energy: { type: "number", description: "Energy level 1-5" },
        gratitude: { type: "array", items: { type: "string" }, description: "Things grateful for" },
        highlights: { type: "array", items: { type: "string" }, description: "Day highlights" },
        forProfile: { type: "string", description: "Set to the EXACT profile name when the journal entry is for someone else (e.g. 'Joe', 'Mom'). Creates a separate entry linked to that profile." },
      },
      required: [],
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
        startValue: { type: "number", description: "Current progress / starting value. For savings: amount already saved. For weight loss: current weight. For any goal: how much progress has already been made toward the target." },
        deadline: { type: "string", description: "ISO date deadline (YYYY-MM-DD)" },
        trackerId: { type: "string", description: "Linked tracker name (will be resolved to ID)" },
        habitId: { type: "string", description: "Linked habit name (will be resolved to ID)" },
        category: { type: "string", description: "Expense category for spending goals" },
        forProfile: { type: "string", description: "REQUIRED when goal is for a specific person/pet/entity. Set to the EXACT profile name (e.g. 'Rex', 'Mom', 'Honda CR-V 2021'). If the user says 'Create a goal for Rex', forProfile MUST be 'Rex'. NEVER omit this when the goal is about someone/something other than the user themselves." },
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
    description: "Update or complete a goal. Use when user wants to: mark a goal complete/done/achieved ('I finished my goal', 'mark goal as done'), change the target, abandon a goal, link it to a tracker, or update current progress. NEVER use create_goal when user is referring to an EXISTING goal.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Goal title to find (partial match)" },
        status: { type: "string", enum: ["active", "completed", "abandoned"], description: "New status. Use 'completed' when user says they finished/achieved/completed the goal." },
        target: { type: "number", description: "New target value" },
        deadline: { type: "string", description: "New deadline (ISO date)" },
        trackerId: { type: "string", description: "Tracker name to link this goal to (partial match). Use when user says 'add my goal to the X tracker' or 'link my goal to X'." },
        currentProgress: { type: "number", description: "Set current progress value. Use when user says 'I've done X of my goal' or 'I'm at X on my goal'." },
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
  // ─── MISSING TOOLS: uncomplete_habit, complete_event, tracker entry CRUD ───
  {
    name: "uncomplete_habit",
    description: "Remove/undo a habit check-in for today (or a specific date). Use when user says 'unmark X habit', 'undo my X checkin', 'I didn't actually do X', 'remove today's X checkin'. This is the OPPOSITE of checkin_habit.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Habit name (partial match)" },
        forProfile: { type: "string", description: "Profile name if unchecking someone else's habit." },
        date: { type: "string", description: "Date to uncheck (YYYY-MM-DD). Defaults to today." },
      },
      required: ["name"],
    },
  },
  {
    name: "complete_event",
    description: "Mark a calendar event as completed/attended. Use when user says 'I went to X', 'I attended X', 'X is done', 'mark X event complete', 'I completed my X appointment'. This marks it done WITHOUT deleting it. Different from delete_event which removes it entirely.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title (partial match)" },
        forProfile: { type: "string", description: "Profile name to narrow search." },
        removeFromSchedule: { type: "boolean", description: "If true, also removes the event from the upcoming calendar view. Default false." },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_tracker_entry",
    description: "Delete a specific logged entry from a tracker. Use when user says 'remove my X entry', 'delete that X log', 'undo my X log from today'. Removes a single data point, not the whole tracker.",
    input_schema: {
      type: "object" as const,
      properties: {
        trackerName: { type: "string", description: "Name of the tracker (partial match)" },
        forProfile: { type: "string", description: "Profile name to narrow tracker search." },
        entryIndex: { type: "number", description: "0 = most recent entry (default). 1 = second most recent, etc." },
      },
      required: ["trackerName"],
    },
  },
  {
    name: "update_tracker_entry",
    description: "Update/edit a previously logged tracker entry. Use when user says 'change my X log to Y', 'I actually slept 8 hours not 7', 'update today's weight to X', 'correct my X entry'. Edits the most recent entry by default.",
    input_schema: {
      type: "object" as const,
      properties: {
        trackerName: { type: "string", description: "Name of the tracker (partial match)" },
        forProfile: { type: "string", description: "Profile name to narrow tracker search." },
        values: { type: "object", description: "New values to set for the entry (replaces old values)." },
        entryIndex: { type: "number", description: "0 = most recent entry (default). 1 = second most recent, etc." },
      },
      required: ["trackerName", "values"],
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
  // undo_last removed — was a fake/placeholder tool that lied to users
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
  {
    name: "revalue_asset",
    description: "Re-estimate the current market value of a vehicle, asset, or property profile using LIVE web search data from Zillow, KBB, Edmunds, etc. Use when the user asks 'what is my car worth?', 'update value of my house', 'how much is my iPhone worth now?'",
    input_schema: {
      type: "object" as const,
      properties: {
        profileName: { type: "string", description: "Name of the asset/vehicle/property profile to revalue" },
      },
      required: ["profileName"],
    },
  },
  {
    name: "generate_chart",
    description: "Generate a REAL VISUAL CHART rendered directly in the chat. USE THIS whenever the user says 'show', 'chart', 'graph', 'visualize', 'plot', 'trend', 'pie chart', 'compare', or asks to SEE data visually. DO NOT describe what a chart would look like \u2014 call this tool and it will render an actual interactive chart inline.\n\nChart types: 'line'=trends over time, 'bar'=categories, 'area'=cumulative, 'pie'=breakdown, 'scatter'=correlation, 'composed'=multi-metric, 'radar'=scores\n\nExamples:\n- 'Show my spending as a pie chart' \u2192 chartType:'pie', dataSource:'expenses'\n- 'Show my weight trend' \u2192 chartType:'line', dataSource:'trackers', trackerName:'weight'\n- 'Compare spending this month vs last' \u2192 chartType:'bar', dataSource:'expenses', dateRange:'3months'",
    input_schema: {
      type: "object" as const,
      properties: {
        chartType: { type: "string", enum: ["line","bar","area","pie","scatter","composed","radar"], description: "Type of chart" },
        title: { type: "string", description: "Chart title" },
        subtitle: { type: "string", description: "Optional subtitle" },
        dataSource: { type: "string", enum: ["trackers","expenses","tasks","habits","journal","obligations","goals","custom"], description: "Data source" },
        trackerName: { type: "string", description: "For trackers: tracker name(s), comma-separated for multiple" },
        valueField: { type: "string", description: "Field to plot on Y axis" },
        dateRange: { type: "string", enum: ["week","month","3months","6months","year","all"], description: "Time period" },
        forProfile: { type: "string", description: "Filter to specific profile name" },
        groupBy: { type: "string", description: "How to group: 'category', 'day', 'week', 'month'" },
        showLegend: { type: "boolean", description: "Show legend" },
      },
      required: ["chartType","title","dataSource"],
    },
  },
  {
    name: "generate_table",
    description: "Generate a formatted interactive data table in the chat. Use for 'show all', 'list', 'table of', or structured data requests.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        dataSource: { type: "string", enum: ["trackers","expenses","tasks","habits","journal","obligations","goals","events","profiles"] },
        columns: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, format: { type: "string" }, align: { type: "string" } } } },
        filters: { type: "object", description: "{ minAmount, maxAmount, category, status, forProfile, dateRange }" },
        sortBy: { type: "string" },
        sortDir: { type: "string", enum: ["asc","desc"] },
        limit: { type: "number" },
        includeSummary: { type: "boolean" },
      },
      required: ["title","dataSource","columns"],
    },
  },
  {
    name: "generate_report",
    description: "Generate a comprehensive multi-section report with charts, tables, and metrics. Use for 'report', 'summary', 'scorecard', 'digest', 'overview'.",
    input_schema: {
      type: "object" as const,
      properties: {
        reportType: { type: "string", enum: ["financial","health","life_scorecard","profile","goal_progress","weekly_digest"] },
        title: { type: "string" },
        dateRange: { type: "string", enum: ["week","month","3months","6months","year","all"] },
        forProfile: { type: "string" },
      },
      required: ["reportType"],
    },
  },
];

// ============================================================
// SYSTEM PROMPT (simplified — no JSON format instructions)
// ============================================================

function buildSystemPrompt(context: string): string {
  return `You are Portol AI — the intelligent brain of a unified personal life operating system. You have FULL access to the user's data: health trackers, finances, calendar, profiles, documents, habits, tasks, medications, and more. Your job is to both act on commands AND generate real, data-driven insights.

EXISTING DATA (this is fresh from the database — use it for every answer):
${context}

DIAGNOSTICS & INSIGHTS MODE:
When the user asks questions like "how am I doing?", "give me a health summary", "what's my financial situation?", "diagnose my habits", "what do I need to focus on?", or any open-ended question about their status:
- Cross-reference ALL data sources (trackers, expenses, calendar, habits, goals) to form real observations
- Call out specific numbers, trends, and anomalies
- Prioritize actionable insights over generic statements
- Example: instead of "You have 2 open tasks", say "You have 2 tasks due today: [title 1] and [title 2]. Based on your calendar, you have 3 hours free this afternoon."
- Example: instead of "Your spending this month is $X", say "$1,862 spent this month — shopping is 63% ($1,179) which is abnormally high vs your 6-month average of ~$800/month."

MEDICATION TRACKING (separate system from habits):
- When users mention taking, logging, or tracking medication, prescription drugs, or supplements, use create_tracker with category="medication" if no tracker exists yet
- Medication tracker fields MUST include: { drug: "Name", dosage: "Xmg", taken: true/false, time: "HH:MM", notes: "..." }
- Medication adherence = entries where taken=true / total entries × 100%
- NEVER lump medications into habit check-ins. Medications are structured data, not binary check-offs.
- If a user says "I took my Metformin 500mg" → log_tracker_entry to the Metformin tracker (or create it) with { drug: "Metformin", dosage: "500mg", taken: true }
- If a user says "set up a medication tracker for Lisinopril 10mg daily" → create_tracker with name="Lisinopril", category="medication", fields including drug, dosage, frequency, prescriber, startDate

CALENDAR DATA ACCURACY:
- All events MUST include correct ownership (who it belongs to), correct date and time (timezone-aware), and correct category
- Tasks with a due date appear on the calendar automatically — do NOT also create an event for the same task
- Subscriptions/obligations appear on the calendar on their due dates automatically — do NOT create events for them
- Only create calendar events for actual scheduled occurrences (appointments, meetings, activities)

BEHAVIOR:
- Be concise and confirm what you did after each action.
- Handle multiple actions in one message when appropriate.
- When the user mentions an existing entity, match it by name (partial matching is fine).
- CRITICAL NUTRITION DETECTION: When a user mentions ANY food or drink consumption for ANY profile (person, pet, or self), ALWAYS log it to that profile's NUTRITION/CALORIES tracker. Each profile has their OWN nutrition tracker — NEVER log Rex's food to your Calories tracker or vice versa.
  ROUTING RULES:
  - "I ate X" → trackerName: "Calories" (your tracker), forProfile: omit or "Me"
  - "Rex ate X" / "Rex's food" → trackerName: "Calories", forProfile: "Rex" (the system will find or create Rex's own tracker)
  - "Mom ate X" → trackerName: "Calories", forProfile: "Mom"
  NEVER route food/nutrition to a Weight tracker, Running tracker, or any non-nutrition tracker. Food = nutrition/calories tracker ALWAYS.
  This includes:
  - Eating: "ate a sandwich", "had lunch", "ate chicken", "had pizza"
  - Drinking: "drank a Coke", "had coffee", "drank a smoothie", "had a beer", "drank water"
  - Snacking: "had some chips", "ate candy", "grabbed a donut"
  Only create an expense if the user explicitly mentions a dollar amount ("$12 lunch").
  ACCURACY IS CRITICAL — use these reference values (per standard serving) and scale proportionally:
  - Mac & cheese (1 cup/bowl): 380-420 cal, 48g carbs, 10-11g protein, 17-18g fat
  - Chicken sandwich: 400-450 cal, 40g carbs, 28-32g protein, 14-18g fat
  - Cheese pizza (1 slice): 270 cal, 33g carbs, 12g protein, 10g fat
  - Hamburger: 350 cal, 28g carbs, 20g protein, 17g fat
  - Coke (12oz): 140 cal, 39g carbs/sugar, 0g protein, 0g fat
  - Grande latte (16oz): 190 cal, 18g carbs, 13g protein, 7g fat
  - Salad (garden): 150 cal, 12g carbs, 5g protein, 9g fat
  - Rice (1 cup cooked): 210 cal, 45g carbs, 4g protein, 0.5g fat
  - Pasta (1 cup cooked): 220 cal, 43g carbs, 8g protein, 1.3g fat
  - Egg (1 large): 70 cal, 0.5g carbs, 6g protein, 5g fat
  - Steak (6oz): 420 cal, 0g carbs, 42g protein, 28g fat
  - Protein shake: 200 cal, 8g carbs, 25g protein, 5g fat
  - Beer (12oz): 150 cal, 13g carbs, 2g protein, 0g fat
  - Donut: 250 cal, 31g carbs, 3g protein, 13g fat
  When estimating, prioritize accuracy over round numbers. Carbs should dominate in grain/starch dishes. Protein should be HIGH only for meat/fish/protein-rich foods. Fat should be high for fried/cheesy foods. Do NOT overestimate protein for carb-heavy foods.
  CRITICAL: The "item" field in nutrition tracker entries MUST contain the food/drink name (e.g., "Blueberries", "Cheeseburger", "Grande Latte"). This is what displays as the entry label. WITHOUT the item field, entries just show a calorie number with no context.
  Example: "I ate a chicken sandwich and ran 2 miles" → log_tracker_entry for Nutrition with values: { item: "Chicken Sandwich", calories: 430, protein: 30, carbs: 40, fat: 16 } + log_tracker_entry for Running with values: { distance: 2, caloriesBurned: 200, pace: "10:00" }. TWO separate tracker entries.
  Example: "I drank a Coke" → log_tracker_entry for Nutrition with values: { item: "Coca-Cola", calories: 140, sugar: 39, carbs: 39, protein: 0, fat: 0 }.
  Example: "Had a grande latte from Starbucks" → log_tracker_entry for Nutrition with values: { item: "Grande Latte (Starbucks)", calories: 190, protein: 13, carbs: 18, fat: 7 }.
  ALWAYS set the "item" field to a human-readable food name. Capitalize it. This is the most visible part of the entry.
- When creating tracker entries, use MULTIPLE tracker calls if the message describes multiple different activities (eating + exercise = 2 separate entries to 2 different trackers).
- RECURRING EXPENSES / SUBSCRIPTIONS: When a user mentions a recurring payment, subscription, or bill ("I pay $X per month for Y", "subscription costs $X", "$11 Spotify every month"), use create_obligation ONLY. Do NOT also call create_event or create_expense for the same item. A subscription profile is automatically created behind the scenes — do NOT call create_profile separately. Obligations automatically generate recurring calendar entries on their due dates. Creating an event AND an obligation for the same bill causes DUPLICATE calendar entries — this is a critical bug to avoid. ONE tool call (create_obligation) handles everything: obligation + profile + calendar entries.
  In your response, mention that both a profile and a bill were created. Example: "Created Spotify subscription profile + $11/month bill — will show on Calendar every month."
- EVENT NAMING: ALWAYS include the full detail in event titles. "Meeting with Dr. Chan" not "Meeting". "Tesla Model 3 Oil Change" not "Oil Change". Preserve names, entities, and context in all titles.
- PROFILE NAMING ACCURACY: Use EXACTLY the details the user provides. If the user says "2022 Tesla Model 3", the profile name and year field MUST say 2022, not 2023 or any other year. Never change, round, or guess details — use the user's exact words for names, years, models, and other specifics.
- SINGLE ACTION PER ENTITY: When the user asks to create ONE subscription, obligation, or profile, make exactly ONE tool call. Do NOT call create_obligation multiple times for the same subscription. Do NOT call create_profile AND create_obligation for the same item (create_obligation auto-creates the subscription profile).
- MULTI-ACTION: When a message contains multiple actions (e.g., "schedule X and also add expense Y"), execute ALL of them — never drop an action. If a user sends 10 or even 20 actions, you MUST execute ALL of them as separate tool calls. Do not merge or skip any. You can handle up to 20 tool calls in a single response.
- ACTION COUNTING: In your response, accurately count how many distinct actions you performed. Count each tool call separately. If the user sent 10 items and you performed 10 tool calls, say "I've handled all 10 items." Never undercount.
- TOOL RESULT HONESTY: If a tool returns an error object (e.g., {error: "Profile not found"}), you MUST tell the user it failed. NEVER say "Done!" or "Updated!" or show checkmarks when a tool returned an error. Admit the failure and offer to fix it (e.g., "I couldn't find that profile. Would you like me to create one?").
- ABSOLUTE ZERO FABRICATION: NEVER invent, guess, or fabricate data. This is the #1 rule.
  * If the user asks for a VIN, license plate, account number, or ANY stored value and it's NOT in the data snapshot above, say: "I don't have that saved yet. Would you like to add it?"
  * NEVER generate fake numbers, dates, names, addresses, or identifiers.
  * NEVER claim to read data from an image unless the user JUST uploaded one in THIS message.
  * NEVER claim a tool succeeded unless you actually called it AND the result confirmed success.
  * If a profile field is empty/null/missing, say it's not stored — do NOT fill it with a made-up value.
  * When updating a profile, ONLY use values the user explicitly provided or that exist in the data snapshot. NEVER auto-generate values like VIN numbers, serial numbers, policy numbers, etc.
- LIVE DATABASE CONTEXT: The data snapshot above (Profiles, Trackers, Tasks, etc.) is fetched FRESH from the database at the start of every message. It reflects ALL manual edits, deletions, and UI changes. Trust THIS data over conversation history. If the data snapshot doesn't list something, it does NOT exist — even if conversation history says you created it. Conversation history can be stale; the data snapshot is always current.
- ANSWERING DATA QUESTIONS: When the user asks about their data ("what's my expiration date?", "how much is my car worth?", "what's Joe's birthday?", "how much do I spend on subscriptions?"), ALWAYS look up the answer from the data snapshot above. Documents include extracted fields in curly braces {field: value}. Profiles include fields like height, weight, birthday. Assets include currentValue, make, model, year. Subscriptions include cost, frequency. Trackers include latest values. NEVER guess or approximate — cite the exact data you see. If the data seems wrong, tell the user what you found and suggest they update it.
- NEVER ASSUME PAST ACTIONS STILL EXIST: If conversation history shows you previously created something but it's NOT in the data snapshot above, it was DELETED. ALWAYS call the tool again. The dedup check inside the tool will prevent actual duplicates. You must call create_profile/create_task/etc. every time the user asks, regardless of what conversation history shows.
- For conversational messages with no actions needed, just respond naturally without calling any tools.
- When creating tasks from reminders, extract the due date if mentioned.
- BIAS TO ACTION: When the user asks to create, schedule, add, mark off, complete, or check in something, DO IT immediately. NEVER ask clarifying questions for simple CRUD. Just execute.
  - "I went on my morning run" → checkin_habit(name: "Morning Run") — DO NOT ask 3 options
  - "Mark off my run" → checkin_habit(name: "Running" or "Morning Run" — find closest match) — DO NOT ask which one
  - "schedule a doctor appointment" → create_task immediately
  - If ambiguous between 2 items with similar names, pick the closest match and do it. You can mention in your response what you picked.
  - NEVER present numbered options for simple check-ins, completions, or mark-offs. That is hostile UX.
  - The ONLY time you should ask is if the user's message is genuinely unclear about WHAT action they want (not which entity).
- When searching, use the search tool to find relevant data before answering.

PROFILE CREATION — CRITICAL RULE:
NEVER create a profile unless the user EXPLICITLY asks to create one. Phrases that mean "create a profile":
- "create a profile for Hop"
- "add Hop as a person/pet/contact"
- "track Hop" (meaning track them as a person)
- "add my brother Hop"

Phrases that do NOT mean "create a profile" — just include the name in the task/event/expense title:
- "return stethoscope to Hop" → create_task with title "Return stethoscope to Hop". Do NOT create a profile for Hop.
- "collect $50 from Hop" → create_task with title "Collect $50 from Hop". Do NOT create a profile.
- "buy gift for Sarah" → create_task with title "Buy gift for Sarah". Do NOT create a profile.
- "call Hop about dinner" → create_task with title "Call Hop about dinner".
- "$30 dinner with Hop" → create_expense with description "Dinner with Hop".

The rule is simple: if the user is describing an ACTION (task, expense, event) that MENTIONS a person, just put the name in the title. Only use forProfile if that person ALREADY EXISTS as a profile. If they don't exist as a profile, leave forProfile empty — the task will be linked to the self (Me) profile automatically.

═══════════════════════════════════════════════════════════════════════
UNIVERSAL ACTION LAYER — EXACT TOOL ROUTING (ZERO TOLERANCE RULES)
═══════════════════════════════════════════════════════════════════════

THE PIPELINE: User message → parse ALL intents → execute each tool → report exact truth.
NEVER ask clarifying questions for CRUD operations. Just execute. If it fails, report the failure.

━━━ COMPLETION vs DELETION vs UPDATE (DIFFERENT THINGS) ━━━
- "mark X done" / "I completed X" / "finished X" / "checked off X" → complete_task OR checkin_habit OR update_goal(status:completed) OR complete_event
- "delete X" / "remove X" / "get rid of X" → delete_task OR delete_habit OR delete_event OR delete_goal OR delete_tracker
- "update X" / "change X to" / "edit X" → update_task OR update_habit OR update_goal OR update_event OR update_tracker_entry
- "undo X" / "unmark X" / "I didn't do X" → uncomplete_habit (remove checkin)
- NEVER use create_* when user says complete/done/finished for an EXISTING item
- NEVER use delete_* when user says complete/done/mark

━━━ TASK CRUD ━━━
- create: create_task → status defaults to pending
- complete: complete_task(title, forProfile?) → sets status=done, NEVER create a new task instead
- update: update_task(title, changes)
- delete: delete_task(title, forProfile?)
- If complete_task returns not-found: say "Task not found" — do NOT create_task as a fallback

━━━ HABIT CRUD ━━━
- create: create_habit(name, forProfile?)
- mark done TODAY: checkin_habit(name, forProfile?) → adds today's check-in
- undo/unmark: uncomplete_habit(name, forProfile?, date?) → removes check-in
- update: update_habit(name, changes)
- delete: delete_habit(name)

━━━ GOAL CRUD ━━━
- create: create_goal(title, type, target, unit, deadline, forProfile?, trackerId?, habitId?)
- check progress: get_goal_progress(query?)
- mark ACHIEVED/DONE: update_goal(title, status:"completed") — NEVER use delete_goal for this
- update target/deadline: update_goal(title, target?, deadline?)
- link to tracker: update_goal(title, trackerId:"tracker name")
- set progress manually: update_goal(title, currentProgress:N)
- delete: delete_goal(title)

━━━ EVENT CRUD ━━━
- create: create_event(title, date, time?, forProfile?)
- update (change time/date): update_event(title, changes)
- mark attended/done: complete_event(title, forProfile?, removeFromSchedule?)
  - removeFromSchedule=true → marks done AND removes from calendar
  - removeFromSchedule=false → marks done, stays on calendar
- delete: delete_event(title, forProfile?) → fully removes
- "I went to X" / "I attended X" → complete_event
- "remove X from my schedule" → complete_event(removeFromSchedule:true)
- "cancel X" → delete_event OR update_event(changes:{status:"cancelled"})

━━━ TRACKER CRUD ━━━
- create tracker: create_tracker(name, category, fields, forProfile?)
- log entry: log_tracker_entry(trackerName, values, forProfile?)
- update most recent entry: update_tracker_entry(trackerName, values, forProfile?, entryIndex?)
- delete most recent entry: delete_tracker_entry(trackerName, forProfile?, entryIndex?)
- rename/update tracker: update_tracker(trackerName, changes)
- delete entire tracker: delete_tracker(name)

━━━ JOURNAL CRUD ━━━
- create: journal_entry(mood, content, forProfile?)
- update today's: update_journal(date:"today's date", changes)
- delete: delete_journal(date)
CRITICAL: "Add a journal entry for X saying Y" → ALWAYS journal_entry(content:Y, forProfile:X). NEVER create_task for journal entries.
NEVER say "X already has a journal entry" unless the Journal Entries context above explicitly shows an entry "for:X". If the context shows no entry for X, just call journal_entry — do NOT assume one exists.
"X felt Y" / "X was feeling Y" / "note that X felt Y" → journal_entry. Infer mood: sore/tired/rough=bad, happy/good=good, motivated/energized=great, neutral/normal=okay.
If journal_entry succeeds, say "Journal entry saved for [name]."
NEVER substitute a create_task when the user explicitly asks for a journal entry.

━━━ MULTI-ACTION COMPOUND COMMANDS ━━━
When user says MULTIPLE things in one message, execute ALL of them as SEPARATE tool calls.
Example: "Joe completed his water habit, delete his stretching task, create a goal to lose 5 pounds"
→ Tool 1: checkin_habit(name:"Water", forProfile:"Joe")
→ Tool 2: delete_habit(name:"Stretching") OR delete_task(title:"Stretching") — if ambiguous, DELETE BOTH and say so
→ Tool 3: create_goal(title:"Lose 5 pounds", type:"weight_loss", target:5, unit:"lbs", forProfile:"Joe")
All 3 must execute. Report: ✅ Water habit checked in for Joe, ✅ Stretching deleted, ✅ Goal created.

PROFILE CONTEXT INHERITANCE: If the user sets a profile context ("Joe completed..., his task..., his habit..."),
apply forProfile:"Joe" to ALL subsequent actions in the same message until profile changes.

━━━ AMBIGUITY RESOLUTION ━━━
If "delete Joe's running thing" could match habit OR tracker OR event:
1. Look at the data context above — see what actually exists for Joe with "running" in the name
2. If only ONE type matches → do it
3. If multiple types match → tell user: "I found a Running habit AND a Running tracker for Joe. Which one should I delete?"
NEVER delete randomly. NEVER delete the wrong item.

━━━ HONESTY RULES ━━━
- If a tool returns {error: "..."} → tell the user it FAILED. Never say "Done!" on failure.
- If item not found → say "I couldn't find [X]" with specific name. Offer to search.
- If action succeeded → confirm with: what was done, for whom, the item name, and the new state.
- Example success: "✅ Marked Joe's Water habit done for today (April 9). His streak is now 3 days."
- Example failure: "❌ Couldn't find a task called 'stretching' for Joe. Do you want to check all his tasks?"

TOOL CHOICE RULES — CRITICAL:
DATA CLASSIFICATION RULES (NEVER VIOLATE):
- MEDICATION: When a user mentions medication ("take Heartgard", "give Max his meds", "prescribed lisinopril"), update the PROFILE with medication info in their health fields (update_profile with fields: { medications: "..." }). Do NOT create a "Medication" tracker. Medications are profile data, not time-series tracker data.
- WATER INTAKE / HYDRATION: If a user says "drank 8 glasses of water" or "8oz water", log to the existing Hydration/Water tracker if one exists. If none exists, create a habit ("Drink water") rather than a tracker — daily water goals are habits, not measurements.
- HABITS vs TRACKERS: Habits are binary daily actions (did it / didn't). Trackers are numeric measurements over time. "Take medication" = habit. "Blood pressure 120/80" = tracker. "Drank 8 glasses" = habit check-in. "Weight 180 lbs" = tracker.
- LOANS/BILLS: When a user mentions rent, bills, or debts, use create_obligation. Do NOT create a "loan" profile for recurring bills. Loans are only for actual loan instruments (mortgage, car loan, student loan) with APR, term, and principal.
- GOALS + HABITS: When creating a daily or recurring goal tied to a tracker (e.g., "run every day", "drink 8 glasses of water daily", "meditate 10 min daily"), ALSO create a companion habit via create_habit so the user gets daily check-in tracking. The goal tracks progress toward the target; the habit tracks daily consistency. Always do BOTH calls when the goal implies a daily action.

CRITICAL ROUTING RULES (NEVER VIOLATE):
- "X owes me $Y" or "collect $Y from X" or "X owes me $Y for Z" → ALWAYS create_task with title like "Collect $Y from X for Z" and forProfile: "X". NEVER EVER use save_memory for debts/money owed. This applies to ALL variations: "owes me", "owes us", "I lent X $Y", "X hasn't paid me back".
- "My blood type is X" or personal health info (allergies, height, weight, etc.) → ALWAYS update_profile on the self/Me profile with fields: { bloodType: "O+" } (or the appropriate field). NEVER use save_memory for profile-level data. Same for any profile: "Mom's blood type", "Max's breed".
- "X's birthday is Y" → ALWAYS do BOTH: (1) update_profile with name: "X" and changes: { fields: { birthday: "Y" } } — if the profile doesn't exist, it will be auto-created. (2) create_event with title: "🎂 X's Birthday", date: Y (with correct year), recurrence: "yearly". Do NOT ask for confirmation. Just do it.
- save_memory is ONLY for abstract facts/preferences, NOT for concrete data that belongs in a profile field, task, expense, or event.
- save_memory should ONLY be used for abstract preferences, facts, or context that doesn't fit any structured data type (e.g., "Remember that I prefer window seats", "I'm vegetarian").

ASSET & SUBSCRIPTION CRUD via chat:
- WARRANTY CLAIMS: "Filed a warranty claim for my MacBook" → create_expense with category: "warranty", description: "Warranty claim - MacBook", forProfile: "MacBook" (or the asset name)
- REWARDS: "Redeemed 5000 points on my Visa" → create_expense with category: "rewards", description: "Points redemption", forProfile: "Visa credit card"
- CREDENTIALS: "Save my Netflix login - user: john@email.com, url: netflix.com" → update_profile with name: "Netflix" and changes: { fields: { credentials: [{ label: "Netflix", username: "john@email.com", url: "netflix.com" }] } }
- APPRAISALS: "My painting was appraised at $5000" → update_profile with name: "Painting" and changes: { fields: { appraisals: [{ date: "today", value: 5000, source: "appraiser" }], currentValue: 5000 } }
- LOAN PAYMENTS: "Made a $500 payment on my car loan" → pay_obligation with the obligation name
- SUBSCRIPTION PAYMENTS: "Paid $15 for Netflix" → create_expense with category: "subscription", forProfile: "Netflix"

SECONDARY DATA EXTRACTION — critical. When logging tracker entries, compute all possible secondary data:

ACTIVITY TRACKING ARCHITECTURE — follow exactly:

1. CLASSIFY FIRST, DERIVE SECOND.
   - Identify the literal activity (basketball, running, tennis, yoga, etc.)
   - Store to THAT tracker (Basketball → Basketball tracker, Running → Running tracker)
   - NEVER merge activities: basketball is not "running", tennis is not "cardio", swimming is not "exercise"
   - Derived metrics (calories, cardio load, intensity) are CALCULATED FROM the activity and attached as fields to that specific entry

2. TRACKER NAME = LITERAL ACTIVITY.
   - Basketball → trackerName: "Basketball"
   - Running → trackerName: "Running"
   - Tennis → trackerName: "Tennis"
   - Soccer → trackerName: "Soccer"
   - Swimming → trackerName: "Swimming"
   - Yoga → trackerName: "Yoga"
   - Weight Lifting → trackerName: "Lifting"
   - Walking → trackerName: "Walking" (separate from Running)
   - Cycling → trackerName: "Cycling"
   NEVER use "Running" for basketball, tennis, soccer, or any non-running activity.

3. EVERY FITNESS ENTRY MUST INCLUDE activityType in values:
   Basketball example values: { activityType: "basketball", duration: 30, caloriesBurned: 210, intensity: "moderate" }
   Running example values: { activityType: "running", distance: 5, duration: 50, pace: "10:00", caloriesBurned: 500 }
   Tennis example values: { activityType: "tennis", duration: 60, caloriesBurned: 480, intensity: "high" }
   Yoga example values: { activityType: "yoga", duration: 45, caloriesBurned: 135, style: "vinyasa" }
   The activityType field preserves identity so summaries ("cardio this week") can aggregate across Basketball + Running + Tennis WITHOUT merging their trackers.

4. CALORIE ESTIMATION by activity:
   - Running: ~100 cal/mile or ~10 cal/min
   - Walking: ~80 cal/mile or ~5 cal/min
   - Cycling: ~50 cal/mile or ~8 cal/min
   - Swimming: ~10 cal/min
   - Basketball: ~7 cal/min (moderate), ~9 cal/min (intense game)
   - Tennis: ~8 cal/min
   - Soccer: ~8 cal/min
   - Weight lifting: ~5-7 cal/min
   - Yoga: ~3 cal/min
   - HIIT: ~12 cal/min
   - Hiking: ~6 cal/min
   Always include caloriesBurned as a derived field.

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

MULTI-PROFILE AWARENESS — CRITICAL (ZERO TOLERANCE FOR DATA LEAKS):
The system manages data for MULTIPLE people, pets, vehicles, and assets. Each entity has its own tasks, expenses, trackers, events, documents, subscriptions, and assets. Data must ABSOLUTELY NEVER cross between profiles.

DATA ISOLATION RULES:
1. ALWAYS set "forProfile" with the EXACT FULL NAME of the target profile on EVERY tool call.
2. If the user says "Craig Isolation Test's blood pressure", forProfile MUST be "Craig Isolation Test" — NOT just "Craig".
3. NEVER use a partial name that could match multiple profiles. Use the FULL profile name.
4. If unsure which profile the user means, ASK instead of guessing.
5. Data for Person A must NEVER appear under Person B, Pet C, or Vehicle D.
6. When creating trackers, tasks, expenses, events, goals, or habits for a specific entity, the forProfile field is MANDATORY.
7. Use get_profile_data to retrieve a specific person's full data when asked.
8. Use get_summary with forProfile to get stats filtered to that person.
9. Use search with forProfile to search within a person's data.

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

CRITICAL ANTI-HALLUCINATION RULE FOR DOCUMENTS:
If retrieve_document returns { found: false }, you MUST tell the user the document was NOT found. NEVER say "Here's your [document]" if the tool returned found:false. Say something like: "I couldn't find that document. You can upload it through chat by attaching the file, or through the Documents section." This is a HARD rule — fabricating document retrieval results destroys user trust.

DOCUMENT DISPLAY RULE — let the viewer show the image:
When retrieve_document returns { found: true }, the actual document IMAGE will be displayed automatically by the app below your message. Do NOT list extracted fields as bullet points — the user wants to SEE the document, not read a text dump. Just say something brief like "Here's your [document name]." and let the image viewer do its job. If the user specifically asks about a data field (e.g., "what's my license plate?"), THEN you can mention the specific field value from the extracted data in your response text.

DATE AWARENESS — route dates to the calendar:
Whenever you encounter dates in ANY context (document extraction, user messages, data entry), identify and call out actionable dates:
- Expiration dates → suggest creating a reminder event
- Due dates → suggest creating a task or event
- Appointment dates → create an event
- Renewal dates → create a recurring event
For document extractions, dates are automatically detected and presented to the user for calendar routing.

CRITICAL — VISUAL OUTPUT RULES:
When the user asks to SEE, VISUALIZE, CHART, GRAPH, PLOT, or SHOW data visually, you MUST call generate_chart. Do NOT describe what a chart would look like. Do NOT say "navigate to the finance dashboard to see a chart." CALL THE TOOL and it will render an actual chart inline in the chat.

MANDATORY chart triggers: "show me", "chart", "graph", "visualize", "pie chart", "plot", "trend", "compare X vs Y"
- "Show my spending as a pie chart" → CALL generate_chart(chartType:"pie", dataSource:"expenses")
- "Show my weight trend" → CALL generate_chart(chartType:"line", dataSource:"trackers", trackerName:"weight")
- "Financial report" → CALL generate_report(reportType:"financial")
- "Life scorecard" → CALL generate_report(reportType:"life_scorecard")
- "Table of my expenses" → CALL generate_table(dataSource:"expenses")

If chart data is empty, say so specifically: "You haven't logged any [type] yet."

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
Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' })}. Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles' })}.
${(() => { const now = new Date(); const ref: string[] = []; for (let i = 0; i < 7; i++) { const d = new Date(now.getTime() + i * 86400000); ref.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) + ' = ' + d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })); } return 'Reference: ' + ref.join(', '); })()}
CRITICAL DATE RULES:
- "tomorrow" = the day AFTER today in Pacific Time. Calculate carefully.
- "by Friday" or "this Friday" = if today IS Friday, that means TODAY. If today is before Friday, it means the upcoming Friday of this week. NEVER push to next week.
- "next Friday" = the Friday of NEXT week (7+ days away).
- "this Saturday", "this Monday", etc. = the nearest upcoming occurrence. If today IS that day, it means TODAY.
- "before May 10" = set the due date to May 9.
- ALWAYS double-check: what day of the week is today? Then count forward from there.
- If today is Friday and the user says "by Friday", the date is TODAY's date, not tomorrow.
- ALWAYS double-check your date math. If today is Wednesday March 26, then tomorrow is Thursday March 27 — NOT March 28.
- When mentioning dates in your response, ALWAYS verify the day of the week is correct. Use the reference dates above and count forward/backward. For example, if the reference shows "Sat Apr 12", then Apr 19 is also a Saturday (7 days later). Do NOT guess the day name — calculate it from the known reference.
- NEVER say "Friday, April 18" if April 18 is actually a Saturday. Getting the day name wrong destroys user trust.
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

  // For retrieve_document results: strip extractedData details and documentPreview
  // The image viewer will display the document — AI just needs to know it was found
  if (item.found !== undefined && item.documentPreview) {
    return {
      found: item.found,
      documentName: item.document?.name,
      documentType: item.document?.type,
      imageWillBeDisplayed: true, // tells AI the image is auto-shown
      totalMatches: item.totalMatches,
    };
  }

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
// SCHEMA VALIDATION — enforce data structure before DB writes
// ============================================================
interface ValidationResult {
  valid: boolean;
  normalized: Record<string, any>;
  warnings: string[];
  errors: string[];
}

function validateToolInput(toolName: string, input: Record<string, any>): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const normalized = { ...input };

  switch (toolName) {
    case "create_expense": {
      // Amount must be a positive number
      const amt = Number(normalized.amount);
      if (!amt || amt <= 0 || !isFinite(amt)) errors.push(`Invalid amount: ${normalized.amount}`);
      else normalized.amount = Math.round(amt * 100) / 100; // Round to cents
      // Description required
      if (!normalized.description?.trim()) errors.push("Description is required");
      else normalized.description = normalized.description.trim();
      // Date must be valid YYYY-MM-DD
      if (normalized.date && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.date)) {
        warnings.push(`Date "${normalized.date}" is not YYYY-MM-DD format — using today`);
        normalized.date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      }
      if (!normalized.date) normalized.date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      // Category must be from allowed list
      const validCategories = ["food", "transport", "health", "pet", "vehicle", "entertainment", "shopping", "utilities", "housing", "insurance", "subscription", "education", "personal", "general", "warranty", "rewards"];
      if (normalized.category && !validCategories.includes(normalized.category)) {
        warnings.push(`Category "${normalized.category}" is not standard — defaulting to "general"`);
        normalized.category = "general";
      }
      if (!normalized.category) normalized.category = "general";
      break;
    }
    case "create_task": {
      if (!normalized.title?.trim()) errors.push("Task title is required");
      else normalized.title = normalized.title.trim();
      if (normalized.dueDate && !/^\d{4}-\d{2}-\d{2}/.test(normalized.dueDate)) {
        warnings.push(`Due date "${normalized.dueDate}" is not valid — clearing`);
        normalized.dueDate = undefined;
      }
      if (!normalized.priority) normalized.priority = "medium";
      const validPriorities = ["low", "medium", "high", "urgent"];
      if (!validPriorities.includes(normalized.priority)) {
        warnings.push(`Priority "${normalized.priority}" is not valid — defaulting to "medium"`);
        normalized.priority = "medium";
      }
      break;
    }
    case "create_event": {
      if (!normalized.title?.trim()) errors.push("Event title is required");
      else normalized.title = normalized.title.trim();
      if (!normalized.date) errors.push("Event date is required");
      else if (!/^\d{4}-\d{2}-\d{2}/.test(normalized.date)) {
        errors.push(`Event date "${normalized.date}" is not valid YYYY-MM-DD format`);
      }
      break;
    }
    case "create_habit": {
      if (!normalized.name?.trim()) errors.push("Habit name is required");
      else normalized.name = normalized.name.trim();
      const validFreqs = ["daily", "weekly", "weekdays", "weekends", "custom"];
      if (normalized.frequency && !validFreqs.includes(normalized.frequency)) {
        warnings.push(`Frequency "${normalized.frequency}" is not standard — defaulting to "daily"`);
        normalized.frequency = "daily";
      }
      if (!normalized.frequency) normalized.frequency = "daily";
      break;
    }
    case "create_obligation": {
      if (!normalized.name?.trim()) errors.push("Obligation name is required");
      else normalized.name = normalized.name.trim();
      const amt2 = Number(normalized.amount);
      if (!amt2 || amt2 <= 0) errors.push(`Invalid amount: ${normalized.amount}`);
      else normalized.amount = Math.round(amt2 * 100) / 100;
      const validFreqs2 = ["monthly", "yearly", "weekly", "biweekly", "quarterly", "one-time"];
      if (normalized.frequency && !validFreqs2.includes(normalized.frequency)) {
        warnings.push(`Frequency "${normalized.frequency}" — defaulting to "monthly"`);
        normalized.frequency = "monthly";
      }
      if (!normalized.frequency) normalized.frequency = "monthly";
      break;
    }
    case "log_tracker_entry": {
      if (!normalized.trackerName?.trim()) errors.push("Tracker name is required");
      if (!normalized.values || Object.keys(normalized.values).length === 0) errors.push("Entry values are required");
      // Ensure numeric values are actually numbers
      if (normalized.values) {
        for (const [k, v] of Object.entries(normalized.values)) {
          if (k === "_notes" || k === "item") continue;
          if (typeof v === "string" && !isNaN(Number(v))) {
            normalized.values[k] = Number(v);
          }
        }
      }
      break;
    }
    case "create_profile": {
      if (!normalized.name?.trim()) errors.push("Profile name is required");
      else normalized.name = normalized.name.trim();
      const validTypes = ["self", "person", "pet", "vehicle", "asset", "subscription", "loan", "investment", "property", "account", "insurance", "medical"];
      if (normalized.type && !validTypes.includes(normalized.type)) {
        warnings.push(`Type "${normalized.type}" is not standard — defaulting to "person"`);
        normalized.type = "person";
      }
      break;
    }
    case "create_goal": {
      if (!normalized.title?.trim()) errors.push("Goal title is required");
      else normalized.title = normalized.title.trim();
      if (normalized.target != null) {
        const t = Number(normalized.target);
        if (isNaN(t)) warnings.push(`Target "${normalized.target}" is not a number`);
        else normalized.target = t;
      }
      break;
    }
    case "journal_entry": {
      if (!normalized.content?.trim() && !normalized.mood) errors.push("Journal entry needs content or mood");
      break;
    }
    // Read-only tools and updates don't need strict validation
    default:
      break;
  }

  return {
    valid: errors.length === 0,
    normalized,
    warnings,
    errors,
  };
}

// ============================================================
// TOOL EXECUTION — maps tool names to storage operations
// ============================================================

/** Safe lowercase — returns "" for null/undefined/non-string values */
function safeLC(val: any): string {
  return (typeof val === "string" ? val : "").toLowerCase();
}


async function executeTool(name: string, input: any): Promise<any> {
  switch (name) {
    case "search": {
      const results = await storage.search(input.query);
      // Filter by profile if specified
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const matchedProfile = profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile)));
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
        const matched = profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile)));
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
      // DEDUP: Check if profile with same name already exists
      const existingProfiles = await storage.getProfiles();
      const childTypes = ["vehicle", "asset", "subscription", "loan", "investment", "account", "property"];
      const isChildType = childTypes.includes(input.type || "");
      // Resolve intended parent for child types
      let intendedParentId: string | undefined;
      if (isChildType && input.forProfile) {
        const parentMatch = existingProfiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile)));
        if (parentMatch) intendedParentId = parentMatch.id;
      }
      const existingProfile = existingProfiles.find(p => {
        if (p.name.toLowerCase() !== (input.name || "").toLowerCase().trim()) return false;
        // For child types with a specific owner, only dedup against profiles owned by the SAME person
        if (isChildType && intendedParentId) {
          return p.parentProfileId === intendedParentId;
        }
        return true;
      });
      if (existingProfile) {
        // Update existing instead of creating duplicate
        logger.info("ai", `Profile "${input.name}" already exists (${existingProfile.id}) — updating instead of creating`);
        const mergedFields = { ...existingProfile.fields, ...(input.fields || {}) };
        return storage.updateProfile(existingProfile.id, {
          fields: mergedFields,
          notes: input.notes || existingProfile.notes,
          tags: input.tags?.length ? input.tags : existingProfile.tags,
          type: input.type || existingProfile.type,
        });
      }
      // Auto-detect parent profile for non-primary profile types
      let parentProfileId = input.parentProfileId || (intendedParentId ?? undefined);
      if (!parentProfileId && isChildType) {
        const profiles = await storage.getProfiles();
        // If forProfile is specified, find that profile as parent
        if (input.forProfile) {
          const parent = profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile)));
          if (parent) parentProfileId = parent.id;
        }
        // Default: link to self profile
        if (!parentProfileId) {
          const selfProfile = profiles.find(p => p.type === "self");
          if (selfProfile) parentProfileId = selfProfile.id;
        }
      }
      // Auto-detect asset subtype based on name and context
      const finalFields = { ...(input.fields || {}) };
      if ((input.type === "asset" || (!input.type && isChildType)) && !finalFields.assetSubtype) {
        const nameLC = (input.name || "").toLowerCase();
        const allText = `${nameLC} ${(input.notes || "").toLowerCase()}`;
        if (/\b(credit\s*card|visa|mastercard|amex|discover|card\s*ending)\b/.test(allText)) {
          finalFields.assetSubtype = "credit_card";
        } else if (/\b(checking|savings|bank\s*account|debit|banking)\b/.test(allText)) {
          finalFields.assetSubtype = "bank_account";
        } else if (/\b(domain|website|app|saas|hosting|url|\.(com|io|net|org))\b/.test(allText)) {
          finalFields.assetSubtype = "digital_asset";
        } else if (/\b(business|company|llc|corp|inc|venture|startup|enterprise)\b/.test(allText)) {
          finalFields.assetSubtype = "business";
        } else if (/\b(collectible|art|painting|nft|card\s*collection|coin|stamp|antique|memorabilia|rare|vintage|figurine)\b/.test(allText)) {
          finalFields.assetSubtype = "collectible";
        } else if (/\b(owe|lent|receivable|loan\s*to|money\s*owed)\b/.test(allText)) {
          finalFields.assetSubtype = "loan_receivable";
        } else {
          finalFields.assetSubtype = "high_value_item";
        }
        logger.info("ai", `Auto-detected asset subtype: ${finalFields.assetSubtype} for "${input.name}"`);
      }

      const newProfile = await storage.createProfile({
        type: input.type || "person",
        name: input.name,
        fields: finalFields,
        tags: input.tags || [],
        notes: input.notes || "",
        parentProfileId,
      });

      // Auto-create purchase expense for assets/vehicles with a purchase price
      const purchasePrice = finalFields?.purchasePrice || finalFields?.cost || finalFields?.price;
      if (purchasePrice && Number(purchasePrice) > 0 && childTypes.includes(input.type || "")) {
        try {
          const expCategory = input.type === "vehicle" ? "vehicle" : "shopping";
          const expense = await storage.createExpense({
            amount: Number(purchasePrice),
            category: expCategory,
            description: `${input.name} purchase`,
            date: input.fields?.purchaseDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
            vendor: input.fields?.brand || "",
            tags: ["purchase"],
          });
          // Link to both the new asset profile and the self/owner profile
          const linkIds = [newProfile.id];
          if (parentProfileId) linkIds.push(parentProfileId);
          else {
            const selfP = (await storage.getProfiles()).find(p => p.type === "self");
            if (selfP) linkIds.push(selfP.id);
          }
          await updateEntityLinkedProfiles("expense", expense.id, linkIds[0]);
          for (const lid of linkIds) {
            await storage.linkProfileTo(lid, "expense", expense.id).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
            await updateEntityLinkedProfiles("expense", expense.id, lid).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
          }
          logger.info("ai", `Auto-created purchase expense $${purchasePrice} for ${input.name}`);
        } catch (e) {
          logger.warn("ai", `Failed to auto-create purchase expense: ${e}`);
        }
      }

      // Auto-estimate asset value for valuable profile types (best-effort, non-blocking)
      try {
        const valuation = await estimateAssetValue({ type: input.type || "asset", name: input.name, fields: finalFields });
        if (valuation && valuation.estimatedValue > 0) {
          await storage.updateProfile(newProfile.id, {
            fields: {
              ...newProfile.fields,
              currentValue: valuation.estimatedValue,
              valuationMethod: valuation.method,
              valuationConfidence: valuation.confidence,
              valuationRange: valuation.details,
              valuationDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
            },
          });
          logger.info("ai", `Auto-valued "${input.name}" at $${valuation.estimatedValue} (${valuation.confidence})`);
        }
      } catch (e) {
        logger.warn("ai", `Auto-valuation failed for "${input.name}": ${e}`);
      }

      return newProfile;
    }

    case "update_profile": {
      const profiles = await storage.getProfiles();
      const searchName = (input.name || "").toLowerCase().trim();
      // Smart matching: exact name first, then partial. Prefer primary types (vehicle > asset, person > subscription)
      const typeWeight: Record<string, number> = { self: 10, person: 9, pet: 8, vehicle: 7, property: 6, asset: 5, medical: 4, investment: 3, loan: 2, subscription: 1, account: 1 };
      let profile = profiles.find(p => p.name.toLowerCase() === searchName);
      if (!profile) {
        // Partial match — pick the highest-weight type when multiple match
        const matches = profiles.filter(p => p.name.toLowerCase().includes(searchName) || searchName.includes(p.name.toLowerCase()));
        if (matches.length > 0) {
          profile = matches.sort((a, b) => (typeWeight[b.type] || 0) - (typeWeight[a.type] || 0))[0];
        }
      }
      
      // If profile not found, return error with suggestions (don't auto-create on typos)
      if (!profile) {
        const suggestions = profiles
          .filter(p => {
            const pn = p.name.toLowerCase();
            const sn = searchName;
            return pn.includes(sn.slice(0, 3)) || sn.includes(pn.slice(0, 3));
          })
          .slice(0, 5)
          .map(p => p.name);
        return { error: `Profile "${input.name}" not found.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : " Use create_profile to create a new one."}` };
      }
      
      const changes: any = {};
      if (input.changes.fields) changes.fields = { ...profile.fields, ...input.changes.fields };
      if (input.changes.notes !== undefined) changes.notes = input.changes.notes;
      if (input.changes.tags) changes.tags = input.changes.tags;
      if (input.changes.type) changes.type = input.changes.type;
      return storage.updateProfile(profile.id, changes);
    }

    case "delete_profile": {
      const profiles = await storage.getProfiles();
      const dpResult = safeMatchEntity(profiles, input.name || "", p => p.name, { isDestructive: true });
      if (!dpResult.match) return { error: dpResult.error || "Profile not found", candidates: dpResult.candidates };
      const profile = dpResult.match;
      await storage.deleteProfile(profile.id);
      return { deleted: true, name: profile.name, id: profile.id };
    }

    case "create_task": {
      // Resolve target profile BEFORE dedup so we can match by profile too
      let taskLinkedProfiles: string[] = [];
      const taskForProfile = await resolveForProfile(input.forProfile, input.title || "");
      if (taskForProfile) {
        const profiles = await storage.getProfiles();
        const target = profiles.find(p => p.name.toLowerCase() === safeLC(taskForProfile).trim())
          || profiles.find(p => p.name.toLowerCase().includes(safeLC(taskForProfile).trim()));
        if (target) taskLinkedProfiles.push(target.id);
      }

      // Dedup: skip if a very similar active task exists FOR THE SAME PROFILE
      const existingTasks = await storage.getTasks();
      const dupTask = existingTasks.find(t =>
        t.status !== "done" &&
        t.title.toLowerCase().trim() === (input.title || "").toLowerCase().trim() &&
        (taskLinkedProfiles.length === 0 || t.linkedProfiles.some(p => taskLinkedProfiles.includes(p)))
      );
      if (dupTask) return dupTask; // Return existing instead of creating duplicate

      // In-memory dedup lock (includes profile for cross-profile dedup safety)
      const taskDedupKey = `task:${safeLC(input.title)}:${taskLinkedProfiles.join(",")}`;
      if (isDuplicateCreation("_global", taskDedupKey)) {
        logger.info("ai", `Dedup lock: skipped duplicate task "${input.title}"`);
        return { error: "Duplicate task detected — skipped" };
      }
      const newTask = await storage.createTask({
        title: input.title,
        priority: input.priority || "medium",
        dueDate: input.dueDate,
        description: input.description,
        tags: input.tags || [],
        linkedProfiles: taskLinkedProfiles.length > 0 ? taskLinkedProfiles : undefined,
      });
      markCreation("_global", taskDedupKey);
      // Ensure junction table is set
      for (const pid of taskLinkedProfiles) {
        await storage.linkProfileTo(pid, "task", newTask.id).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
      }
      if (taskLinkedProfiles.length === 0) {
        await autoLinkToProfiles("task", newTask.id, input.title || "", input.forProfile);
      }
      return newTask;
    }

    case "complete_task": {
      const tasks = await storage.getTasks();
      // Filter by profile if specified
      let taskPool = tasks.filter(t => t.status !== "done");
      if (input.forProfile) {
        const allProfs = await storage.getProfiles();
        const prof = allProfs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) taskPool = taskPool.filter(t => (t.linkedProfiles || []).includes(prof.id));
      }
      const result = safeMatchEntity(taskPool, input.title || "", t => t.title);
      if (!result.match) {
        // fallback: search all tasks (any profile, any status)
        const fallback = safeMatchEntity(tasks, input.title || "", t => t.title);
        if (fallback.match && fallback.match.status === "done") return { alreadyDone: true, title: fallback.match.title };
        return { error: result.error || "Task not found", candidates: result.candidates };
      }
      return storage.updateTask(result.match.id, { status: "done" });
    }

    case "delete_task": {
      const tasks = await storage.getTasks();
      let taskPool = tasks;
      if (input.forProfile) {
        const allProfs = await storage.getProfiles();
        const prof = allProfs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) taskPool = tasks.filter(t => (t.linkedProfiles || []).includes(prof.id));
      }
      const result = safeMatchEntity(taskPool, input.title || "", t => t.title, { isDestructive: true });
      if (!result.match) return { error: result.error || "Task not found", candidates: result.candidates };
      await storage.deleteTask(result.match.id);
      return { deleted: true, title: result.match.title, id: result.match.id };
    }

    case "log_tracker_entry": {
      const trackers = await storage.getTrackers();
      const trackerName = (input.trackerName || "").toLowerCase();

      // Resolve forProfile FIRST so we can match the right tracker
      const profiles = await storage.getProfiles();
      let targetProfileId: string | undefined;
      if (input.forProfile) {
        const match = profiles.find(p => p.name.toLowerCase() === (input.forProfile || "").toLowerCase());
        if (match) targetProfileId = match.id;
      }
      // If no forProfile specified, default to self
      if (!targetProfileId) {
        const selfProfile = profiles.find(p => p.type === "self");
        if (selfProfile) targetProfileId = selfProfile.id;
      }

      // Find the right tracker: prefer one linked to the target profile
      // Nutrition aliases: "Calories", "Nutrition", "Food" all match each other
      const nutritionAliases = ["calories", "nutrition", "food", "diet", "meal"];
      const isNutritionSearch = nutritionAliases.some(a => trackerName.includes(a));
      const nameMatches = trackers.filter(t => {
        const tn = t.name.toLowerCase();
        // Exact or contains match
        if (tn === trackerName || tn.includes(trackerName)) return true;
        // Nutrition alias matching: searching for "Calories" also matches "Nutrition" trackers and vice versa
        if (isNutritionSearch && (nutritionAliases.some(a => tn.includes(a)) || t.category === "nutrition")) return true;
        return false;
      });
      let tracker = nameMatches.length <= 1 ? nameMatches[0]
        : (targetProfileId
            ? nameMatches.find(t => (t.linkedProfiles || []).includes(targetProfileId!))
              || nameMatches[0] // fallback to first match if none linked to target
            : nameMatches[0]);

      // If the found tracker belongs to a DIFFERENT profile, create a new one for the target
      if (tracker && targetProfileId && nameMatches.length > 0) {
        const trackerProfiles = tracker.linkedProfiles || [];
        const belongsToOther = trackerProfiles.length > 0 && !trackerProfiles.includes(targetProfileId);
        if (belongsToOther) {
          // Check if there's already a tracker for this profile
          const ownTracker = nameMatches.find(t => (t.linkedProfiles || []).includes(targetProfileId!));
          if (ownTracker) {
            tracker = ownTracker;
          } else {
            // Create a new tracker for the target profile instead of using someone else's
            logger.info("ai", `Tracker "${tracker.name}" belongs to another profile — creating one for target profile`);
            tracker = undefined as any; // fall through to auto-create below
          }
        }
      }

      // Merge notes into values if provided
      const entryValues = { ...input.values };
      if (input.notes) entryValues._notes = input.notes;
      if (tracker) {
        // Dedup: check if nearly identical entry was logged in the last 2 minutes
        const twoMinAgo = Date.now() - 120000;
        const recentDup = tracker.entries.find(e => {
          if (new Date(e.timestamp).getTime() < twoMinAgo) return false;
          const existingNums = Object.entries(e.values).filter(([k, v]) => typeof v === 'number' && k !== '_notes');
          const newNums = Object.entries(entryValues).filter(([k, v]) => typeof v === 'number' && k !== '_notes');
          if (existingNums.length === 0 || newNums.length === 0) return false;
          return newNums.every(([k, v]) => e.values[k] === v);
        });
        if (recentDup) {
          logger.info("ai", `Skipped duplicate ${tracker.name} entry (matches ${recentDup.id.slice(0,8)})`);
          return recentDup;
        }
        const entry = await storage.logEntry({ trackerId: tracker.id, values: entryValues, forProfile: targetProfileId });
        // Do NOT call autoLinkToProfiles for existing trackers — they already have their profile set.
        // Adding profiles here causes cross-contamination (Rex's entry adds Rex to Me's tracker).
        await autoUpdateGoalProgress(tracker.id, entryValues);
        return entry;
      }
      // Auto-create tracker if not found — infer category from name
      const nameLC = (input.trackerName || "").toLowerCase();
      let autoCategory = "custom";
      // Smart category inference — order matters (most specific first)
      if (["nutrition","food","diet","meal","calories","protein","carbs","fat","macros","intake","eating"].some(k => nameLC.includes(k))) autoCategory = "nutrition";
      else if (["running","cycling","swimming","workout","exercise","walk","basketball","tennis","soccer","football","volleyball","baseball","hockey","golf","yoga","pilates","lifting","weights","gym","crossfit","hiit","rowing","skating","skiing","surfing","martial","boxing","wrestling","climbing","hiking","dancing","sport","game","match","practice","drill","steps","miles","cardio","strength","training","reps","sets","pace","distance","sprint","push-up","pullup","squat","deadlift","bench"].some(k => nameLC.includes(k))) autoCategory = "fitness";
      else if (["weight","blood","bp","sleep","heart","cholesterol","glucose","sugar","oxygen","spo2","pulse","temperature","fever","pain","hydration","water","vitamin","medication","med","dose","symptom","mood","stress","anxiety","mental","creatinine","a1c","bmi"].some(k => nameLC.includes(k))) autoCategory = "health";
      else if (["spending","expense","budget","saving","invest","portfolio","net worth","income","salary","revenue","profit","debt","loan","mortgage","credit","crypto","stock","dividend","rent","bill","subscription","dollar","cash"].some(k => nameLC.includes(k))) autoCategory = "finance";
      else if (["habit","routine","streak","daily","checkin","check-in","morning","evening","meditation","gratitude","journaling","reading","journaling","screen time","phone usage","bedtime"].some(k => nameLC.includes(k))) autoCategory = "habit";
      else if (["productivity","focus","work","study","learn","task","project","meeting","call","email","pomodoro","deep work","code","write","create"].some(k => nameLC.includes(k))) autoCategory = "productivity";

      // Resolve display name — handle DB unique constraint (user_id, name)
      let trackerDisplayName = input.trackerName || "Custom";
      const selfProfileId = profiles.find(p => p.type === "self")?.id;
      const isForSelf = !targetProfileId || targetProfileId === selfProfileId;

      if (isForSelf) {
        // Self profile gets the clean name. If another profile already owns it, rename that one first.
        const conflictTracker = nameMatches.find(t => t.name.toLowerCase() === trackerDisplayName.toLowerCase());
        if (conflictTracker) {
          // Find the other profile's name to use as suffix
          const otherProfileId = (conflictTracker.linkedProfiles || [])[0];
          const otherProfile = otherProfileId ? profiles.find(p => p.id === otherProfileId) : null;
          const suffix = otherProfile ? ` - ${otherProfile.name}` : ` - Other`;
          const renamedName = `${conflictTracker.name}${suffix}`;
          logger.info("ai", `Renaming "${conflictTracker.name}" to "${renamedName}" so self profile can have clean name`);
          await storage.updateTracker(conflictTracker.id, { name: renamedName }).catch(() => {});
        }
      } else {
        // Non-self profile: append the profile name to avoid conflicts
        const targetProfile = profiles.find(p => p.id === targetProfileId);
        if (targetProfile && !trackerDisplayName.toLowerCase().endsWith(targetProfile.name.toLowerCase())) {
          trackerDisplayName = `${trackerDisplayName} - ${targetProfile.name}`;
        }
      }

      const newTracker = await storage.createTracker({
        name: trackerDisplayName,
        category: autoCategory,
        linkedProfiles: targetProfileId ? [targetProfileId] : undefined,
        fields: Object.keys(input.values || {}).filter(k => k !== '_notes').map(k => ({
          name: k,
          type: typeof input.values[k] === "number" ? "number" as const : "text" as const,
        })),
      } as any);
      const entry = await storage.logEntry({ trackerId: newTracker.id, values: entryValues, forProfile: targetProfileId });
      return entry;
    }

    case "create_tracker": {
      // Dedup: check for existing tracker with same name AND same profile
      const existingTrackers = await storage.getTrackers();
      const ctProfiles = await storage.getProfiles();
      let ctTargetId: string | undefined;
      if (input.forProfile) {
        const match = ctProfiles.find(p => p.name.toLowerCase() === (input.forProfile || "").toLowerCase());
        if (match) ctTargetId = match.id;
      }
      if (!ctTargetId) {
        const selfP = ctProfiles.find(p => p.type === "self");
        if (selfP) ctTargetId = selfP.id;
      }
      // Only match duplicates within the same profile — different profiles can have same tracker names
      const dupTracker = existingTrackers.find(t => {
        if (t.name.toLowerCase() !== (input.name || "").toLowerCase()) return false;
        const lp = t.linkedProfiles || [];
        if (lp.length === 0) return true; // unowned tracker = global match
        return ctTargetId ? lp.includes(ctTargetId) : true;
      });
      if (dupTracker) return dupTracker;

      const newTracker = await storage.createTracker({
        name: input.name,
        category: input.category || "custom",
        unit: input.unit,
        fields: input.fields || [{ name: "value", type: "number" }],
      });
      // Link tracker ONLY to the resolved target profile — never use autoLinkToProfiles for trackers
      if (ctTargetId) {
        try { await storage.linkProfileTo(ctTargetId, "tracker", newTracker.id); } catch (e: any) { /* ignore dup */ }
        try { await updateEntityLinkedProfiles("tracker", newTracker.id, ctTargetId); } catch (e: any) { /* ignore */ }
      }
      return newTracker;
    }

    case "set_budget": {
      const month = input.month || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);
      const budget = await storage.addBudget(month, input.category, input.amount, input.notes);
      return { ...budget, month, message: `Budget set: $${input.amount} for ${input.category} in ${month}` };
    }

    case "delete_budget": {
      const month = input.month || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);
      const budgets = await storage.getBudgets(month);
      const target = budgets.find(b => b.category.toLowerCase() === safeLC(input.category));
      if (!target) return { error: `No budget found for category "${input.category}" in ${month}` };
      await storage.deleteBudget(month, target.id);
      return { deleted: true, category: target.category, month };
    }

    case "get_budget_summary": {
      const month = input.month || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);
      const budgets = await storage.getBudgets(month);
      const expenses = await storage.getExpenses();
      const monthExpenses = expenses.filter(e => e.date?.startsWith(month));
      const byCategory: Record<string, number> = {};
      monthExpenses.forEach(e => { byCategory[e.category || "general"] = (byCategory[e.category || "general"] || 0) + e.amount; });
      const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
      const totalSpent = Object.values(byCategory).reduce((s, v) => s + v, 0);
      const categories = budgets.map(b => ({
        category: b.category,
        budgeted: b.amount,
        actual: byCategory[b.category] || 0,
        remaining: b.amount - (byCategory[b.category] || 0),
        percentUsed: b.amount > 0 ? Math.round(((byCategory[b.category] || 0) / b.amount) * 100) : 0,
      }));
      return { month, totalBudget, totalSpent, remaining: totalBudget - totalSpent, categories };
    }

    case "log_expected_paycheck": {
      const r = await storage.createPaycheck({ source: input.source, amount: input.amount, expected_date: input.expected_date, notes: input.notes });
      return { result: r, actions: [{ type: "create", category: "paycheck", data: r }] };
    }
    case "confirm_paycheck_received": {
      const r = await storage.confirmPaycheck(input.paycheck_id, input.actual_amount);
      return { result: r, actions: [{ type: "update", category: "paycheck", data: r }] };
    }
    case "get_loan_schedule": {
      const schedule = await storage.getLoanSchedule(input.loan_id);
      return { result: { loan_id: input.loan_id, payments: schedule.length, schedule: schedule.slice(0, 60) } };
    }
    case "get_cashflow": {
      const cf = await storage.getCashflow(input.month);
      return { result: { month: input.month || new Date().toISOString().slice(0, 7), weeks: cf } };
    }

    case "create_expense": {
      logger.info("ai", `create_expense input: desc="${input.description}" forProfile="${input.forProfile}" amount=${input.amount}`);
      // Validate amount — reject invalid/zero amounts instead of silently logging $0
      const parsedAmount = typeof input.amount === 'number' && isFinite(input.amount) ? input.amount : parseFloat(input.amount);
      if (!parsedAmount || parsedAmount <= 0) {
        return { error: `Invalid expense amount: ${input.amount}. Please provide a positive number.` };
      }
      if (parsedAmount > 1000000) {
        return { error: `Amount $${parsedAmount.toLocaleString()} seems unusually high. Please confirm the amount.` };
      }
      // In-memory dedup lock — catches concurrent requests before DB persistence
      const expDedupKey = `expense:${safeLC(input.description)}:${parsedAmount}:${input.date || ""}:${safeLC(input.forProfile || "")}`;
      if (isDuplicateCreation("_global", expDedupKey)) {
        logger.info("ai", `Dedup lock: skipped duplicate expense $${parsedAmount} ${input.description}`);
        return { error: "Duplicate expense detected — skipped" };
      }
      // Dedup: check if same amount + similar description was created in last 2 minutes
      const allExpenses = await storage.getExpenses();
      const twoMinAgoExp = Date.now() - 120000;
      const dupExpense = allExpenses.find(e => {
        if (new Date(e.createdAt).getTime() < twoMinAgoExp) return false;
        return e.amount === parsedAmount &&
          e.description.toLowerCase().includes((input.description || "").toLowerCase().slice(0, 20));
      });
      if (dupExpense) {
        logger.info("ai", `Skipped duplicate expense: $${dupExpense.amount} ${dupExpense.description}`);
        return dupExpense;
      }
      // Server-side category inference fallback when AI sends 'general'
      let inferredCategory = input.category || "general";
      if (inferredCategory === "general") {
        const desc = (input.description || "").toLowerCase();
        const vendor = (input.vendor || "").toLowerCase();
        const combined = `${desc} ${vendor}`;
        if (/vet|pet food|dog food|cat food|grooming|flea|treats|chewy/.test(combined)) inferredCategory = "pet";
        else if (/groceries|restaurant|food|coffee|lunch|dinner|breakfast|pizza|burger|sandwich|sushi|taco|donut|latte|starbucks|mcdonald|chipotle|uber eats|doordash/.test(combined)) inferredCategory = "food";
        else if (/uber|lyft|gas|fuel|parking|toll|transit|bus|train|flight|airline/.test(combined)) inferredCategory = "transport";
        else if (/oil change|tire|car wash|mechanic|auto|vehicle|detailing/.test(combined)) inferredCategory = "vehicle";
        else if (/doctor|pharmacy|cvs|walgreens|gym|dentist|hospital|medical|prescription|copay/.test(combined)) inferredCategory = "health";
        else if (/netflix|spotify|hulu|disney|apple music|youtube|subscription/.test(combined)) inferredCategory = "subscription";
        else if (/rent|mortgage|hoa/.test(combined)) inferredCategory = "housing";
        else if (/electric|water|internet|phone|cable|utility|att|verizon|comcast/.test(combined)) inferredCategory = "utilities";
        else if (/amazon|walmart|target|clothes|shoes|electronics|bestbuy|apple store/.test(combined)) inferredCategory = "shopping";
        else if (/movie|game|concert|ticket|bar|drinks|bowling|arcade/.test(combined)) inferredCategory = "entertainment";
        else if (/school|tuition|textbook|course|udemy/.test(combined)) inferredCategory = "education";
        else if (/insurance|geico|allstate|progressive|state farm/.test(combined)) inferredCategory = "insurance";
      }
      // Resolve the target profile BEFORE creating the expense so linkedProfiles is set correctly
      let expenseLinkedProfiles: string[] = [];
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const target = profiles.find(p => p.name.toLowerCase() === safeLC(input.forProfile).trim())
          || profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (target) expenseLinkedProfiles.push(target.id);
      }
      const newExpense = await storage.createExpense({
        amount: parsedAmount,
        category: inferredCategory,
        description: input.description || "Expense",
        date: input.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        vendor: input.vendor,
        tags: input.tags || [],
        linkedProfiles: expenseLinkedProfiles.length > 0 ? expenseLinkedProfiles : undefined,
      } as any);
      markCreation("_global", expDedupKey);
      // If we already linked above, just ensure junction table is set. Otherwise auto-link.
      if (expenseLinkedProfiles.length > 0) {
        for (const pid of expenseLinkedProfiles) {
          await storage.linkProfileTo(pid, "expense", newExpense.id).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
        }
      } else {
        await autoLinkToProfiles("expense", newExpense.id, `${input.description || ""} ${input.vendor || ""}`, input.forProfile);
      }
      return newExpense;
    }

    case "delete_expense": {
      const expenses = await storage.getExpenses();
      const dResult = safeMatchEntity(expenses, input.description || "", e => e.description, { isDestructive: true });
      if (!dResult.match) return { error: dResult.error || "Expense not found", candidates: dResult.candidates };
      const expense = dResult.match;
      await storage.deleteExpense(expense.id);
      return { deleted: true, description: expense.description, id: expense.id };
    }

    case "create_event": {
      // Validate required fields
      if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
        return { error: "Event title is required" };
      }
      if (!input.date || typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(input.date)) {
        return { error: "Valid event date (YYYY-MM-DD) is required" };
      }
      // In-memory dedup lock
      const evtDedupKey = `event:${safeLC(input.title)}:${input.date}`;
      if (isDuplicateCreation("_global", evtDedupKey)) {
        logger.info("ai", `Dedup lock: skipped duplicate event "${input.title}" on ${input.date}`);
        return { error: "Duplicate event detected — skipped" };
      }
      // Dedup: skip if a very similar event exists on the same date
      const allEvents = await storage.getEvents();
      const dupEvent = allEvents.find(e =>
        e.title.toLowerCase() === safeLC(input.title) &&
        e.date === input.date
      );
      if (dupEvent) {
        logger.info("ai", `Skipped duplicate event: "${dupEvent.title}" on ${dupEvent.date}`);
        return dupEvent;
      }
      // Resolve target profile BEFORE creating the event
      let eventLinkedProfiles: string[] = [];
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const target = profiles.find(p => p.name.toLowerCase() === safeLC(input.forProfile).trim())
          || profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (target) eventLinkedProfiles.push(target.id);
      }
      const newEvent = await storage.createEvent({
        title: input.title.trim(),
        date: input.date,
        time: input.time,
        endTime: input.endTime,
        allDay: input.allDay || false,
        location: input.location,
        description: input.description,
        recurrence: input.recurrence || "none",
        category: input.category || "personal",
        source: "chat",
        linkedProfiles: eventLinkedProfiles.length > 0 ? eventLinkedProfiles : [],
        linkedDocuments: [],
        tags: [],
      });
      markCreation("_global", evtDedupKey);
      // Only auto-link if we didn't already resolve a profile pre-creation
      if (eventLinkedProfiles.length > 0) {
        for (const pid of eventLinkedProfiles) {
          await storage.linkProfileTo(pid, "event", newEvent.id).catch((e: any) => { console.warn("[AI] Event linking failed:", e?.message); });
        }
      } else {
        const evtForProfile = await resolveForProfile(input.forProfile, `${input.title || ""} ${input.description || ""}`);
        const evtLinked = await directLinkToProfile("event", newEvent.id, evtForProfile);
        if (!evtLinked) await autoLinkToProfiles("event", newEvent.id, `${input.title || ""} ${input.description || ""}`, input.forProfile);
      }
      return newEvent;
    }

    case "update_event": {
      const events = await storage.getEvents();
      const ueResult = safeMatchEntity(events, input.title || "", e => e.title);
      if (!ueResult.match) return { error: ueResult.error || "Event not found", candidates: ueResult.candidates };
      return storage.updateEvent(ueResult.match.id, input.changes);
    }

    case "create_habit": {
      // Deduplication: check if a habit with the same name already exists for the same profile
      const existingHabits = await storage.getHabits();
      let targetProfileId: string | undefined;
      if (input.forProfile) {
        const allProfiles = await storage.getProfiles();
        const targetP = allProfiles.find(p => p.name.toLowerCase() === safeLC(input.forProfile).trim())
          || allProfiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (targetP) targetProfileId = targetP.id;
      }
      const dupHabit = existingHabits.find(h => {
        if (h.name.toLowerCase() !== (input.name || "").toLowerCase()) return false;
        // If forProfile is set, check if this habit is linked to the same profile
        if (targetProfileId) {
          return (h.linkedProfiles || []).includes(targetProfileId);
        }
        return true; // same name, no specific profile filter
      });
      if (dupHabit) {
        logger.info("ai", `Skipped duplicate habit: "${dupHabit.name}" already exists${targetProfileId ? " for this profile" : ""}`);
        return dupHabit;
      }

      const habit = await storage.createHabit({
        name: input.name,
        frequency: input.frequency || "daily",
        icon: input.icon,
        color: input.color,
      });
      // Direct profile linking — don't rely solely on text matching
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const target = profiles.find(p => p.name.toLowerCase() === safeLC(input.forProfile).trim())
          || profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (target) {
          await storage.updateHabit(habit.id, { linkedProfiles: [target.id] } as any);
          await storage.linkProfileTo(target.id, "habit", habit.id).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
          logger.info("ai", `Linked habit "${input.name}" to profile "${target.name}"`);
        }
      }
      // Also run general auto-link for text-based matching
      await autoLinkToProfiles("habit", habit.id, `${input.name || ""} ${input.forProfile || ""}`, input.forProfile);
      return await storage.getHabit(habit.id) || habit;
    }

    case "checkin_habit": {
      const habits = await storage.getHabits();
      const nameQuery = (input.name || "").toLowerCase();
      // Filter by profile if specified
      let eligible = habits;
      if (input.forProfile) {
        const allProfs = await storage.getProfiles();
        const prof = allProfs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) eligible = habits.filter(h => (h.linkedProfiles || []).includes(prof.id));
      } else {
        // Default: prefer habits linked to self profile
        const selfProf = (await storage.getProfiles()).find(p => p.type === "self");
        if (selfProf) {
          const selfHabits = habits.filter(h => (h.linkedProfiles || []).includes(selfProf.id));
          if (selfHabits.length > 0) eligible = selfHabits;
        }
      }
      const habit = eligible.find(h => h.name.toLowerCase().includes(nameQuery))
        ?? habits.find(h => h.name.toLowerCase().includes(nameQuery)); // fallback to any
      if (!habit) return { error: "Habit not found: " + (input.name || "unknown") };
      return storage.checkinHabit(habit.id);
    }

    case "create_obligation": {
      // Dedup: check if an obligation with the same name already exists
      const existingObs = await storage.getObligations();
      const dupOb = existingObs.find(o => o.name.toLowerCase() === (input.name || "").toLowerCase());
      if (dupOb) {
        logger.info("ai", `Skipped duplicate obligation: ${dupOb.name}`);
        return dupOb;
      }
      const newObligation = await storage.createObligation({
        name: input.name,
        amount: parseFloat(input.amount) || 0,
        frequency: input.frequency || "monthly",
        category: input.category || "general",
        nextDueDate: input.nextDueDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
        autopay: input.autopay ?? false,
      });

      // DIRECT link to profile FIRST (before any auto-subscription logic)
      // Also scan the obligation name for profile names as a fallback
      let oblForProfile = input.forProfile;
      if (!oblForProfile) {
        const allProfiles = await storage.getProfiles();
        for (const p of allProfiles) {
          if (p.type === 'self') continue;
          if ((input.name || '').toLowerCase().includes(p.name.toLowerCase())) {
            oblForProfile = p.name;
            break;
          }
        }
      }
      await directLinkToProfile("obligation", newObligation.id, oblForProfile);

      // Auto-create subscription profile if this looks like a subscription/service
      // and no matching profile already exists
      const isSubscriptionLike = (input.category === "subscription") ||
        (input.frequency === "monthly" || input.frequency === "yearly" || input.frequency === "quarterly") ||
        /subscription|premium|plus|pro|membership|plan/i.test(input.name || "");
      if (isSubscriptionLike) {
        const profiles = await storage.getProfiles();
        const obNameLower = (input.name || "").toLowerCase();
        // Extract the service name (strip common suffixes like "subscription", "premium", "payment")
        // Use word boundaries (\b) so we don't accidentally strip parts of words (e.g. "Planet" contains "plan")
        const serviceName = (input.name || "").replace(/\b(subscription|premium|plus|pro|payment|bill|membership|plan|monthly|annual|yearly)\b/gi, "").replace(/\s{2,}/g, " ").trim() || input.name || "";
        const serviceNameLower = serviceName.toLowerCase();
        // When creating for a specific person, only match existing profiles owned by THAT person
        let targetParentId: string | undefined;
        if (input.forProfile) {
          const targetProfile = profiles.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile)));
          if (targetProfile) targetParentId = targetProfile.id;
        }
        const existingProfile = profiles.find(p => {
          const pName = p.name.toLowerCase();
          const nameMatch = pName === serviceNameLower || pName.includes(serviceNameLower) || serviceNameLower.includes(pName) ||
            pName === obNameLower || obNameLower.includes(pName);
          if (!nameMatch) return false;
          // If creating for a specific person, only match profiles belonging to that person
          if (targetParentId) {
            return p.parentProfileId === targetParentId;
          }
          return true;
        });
        if (!existingProfile && serviceName.length > 0) {
          try {
            // Determine parent: use forProfile's profile if specified, otherwise self
            const selfProfile = profiles.find(p => p.type === "self");
            const parentId = targetParentId || selfProfile?.id;
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
            // Link the obligation to the new profile + set the FK for dedup
            // Pass the forProfile so autoLink knows NOT to also link to self
            await autoLinkToProfiles("obligation", newObligation.id, serviceName, input.forProfile);
            try { await storage.linkProfileTo(newProfile.id, "obligation", newObligation.id); } catch (linkErr: any) { logger.warn("ai", `Failed to link obligation ${newObligation.id} to profile ${newProfile.id}: ${linkErr?.message}`); }
            try { await updateEntityLinkedProfiles("obligation", newObligation.id, newProfile.id); } catch (linkErr: any) { logger.warn("ai", `Failed to update linked profiles for obligation ${newObligation.id}: ${linkErr?.message}`); }
            // Set linked_obligation_id for subscription/loan dedup (Phase 7)
            try { await storage.updateProfile(newProfile.id, { linkedObligationId: newObligation.id } as any); } catch (linkErr: any) { logger.warn("ai", `Failed to set linkedObligationId on profile ${newProfile.id}: ${linkErr?.message}`); }
          } catch (e) {
            console.error("Auto-create subscription profile failed:", e);
          }
        } else if (!oblForProfile) {
          // Link to existing profile only if directLink didn't already handle it
          await autoLinkToProfiles("obligation", newObligation.id, input.name || "", input.forProfile);
        }
      } else if (!oblForProfile) {
        await autoLinkToProfiles("obligation", newObligation.id, input.name || "", input.forProfile);
      }

      return newObligation;
    }

    case "pay_obligation": {
      const obligations = await storage.getObligations();
      const ob = obligations.find(o => o.name.toLowerCase().includes((input.name || "").toLowerCase()));
      if (!ob) return { error: "Obligation not found: " + (input.name || "unknown") };
      return storage.payObligation(ob.id, parseFloat(input.amount) || ob.amount, input.method, input.confirmationNumber);
    }

    case "journal_entry": {
      const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      // When forProfile is set: ALWAYS create a new entry for that profile (no de-dup).
      // De-dup only applies to self-profile entries.
      let existingToday: any = null;
      if (!input.forProfile) {
        const allJournalEntries = await storage.getJournalEntries();
        existingToday = allJournalEntries.find(j => j.date === todayDate) || null;
      }

      let entry: any;
      if (existingToday) {
        // APPEND to existing entry instead of blocking
        const appendedContent = existingToday.content
          ? existingToday.content + "\n\n" + (input.content || "")
          : (input.content || "");
        entry = await storage.updateJournalEntry(existingToday.id, {
          content: appendedContent,
          mood: input.mood || existingToday.mood,
          energy: input.energy ?? existingToday.energy,
          gratitude: input.gratitude || existingToday.gratitude,
          highlights: input.highlights || existingToday.highlights,
        } as any);
        if (!entry) entry = existingToday;
      } else {
        entry = await storage.createJournalEntry({
          mood: input.mood || "neutral",
          content: input.content || "",
          energy: input.energy,
          gratitude: input.gratitude,
          highlights: input.highlights,
          tags: [],
        });
      }

      // Direct profile linking for forProfile
      if (input.forProfile) {
        const profiles = await storage.getProfiles();
        const target = profiles.find((p: any) => p.name.toLowerCase() === safeLC(input.forProfile).trim())
          || profiles.find((p: any) => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (target) {
          await storage.updateJournalEntry(entry.id, { linkedProfiles: [target.id] } as any);
          await storage.linkProfileTo(target.id, "journal", entry.id).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
        }
      }

      return entry;
    }

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
      const searchWords = searchTerm.split(/\s+/).filter(Boolean);
      // Score each doc by match quality
      let bestDoc: any = null;
      let bestScore = 0;
      for (const doc of allDocs) {
        const dName = doc.name.toLowerCase();
        const dType = (doc.type || "").toLowerCase().replace(/_/g, " ");
        const dTags = (doc.tags || []).join(" ").toLowerCase();
        const searchable = `${dName} ${dType} ${dTags}`;
        let score = 0;
        // Exact name match
        if (dName.includes(searchTerm)) score += 10;
        // Type match (e.g., "drivers license" matches type "drivers_license")
        if (dType.includes(searchTerm.replace(/[_\s]+/g, " "))) score += 8;
        // Word-level fuzzy matching
        for (const w of searchWords) {
          if (searchable.includes(w)) score += 2;
          // Stem matching: "drivers" matches "driver", "license" matches "licence"
          const stem = w.replace(/s$|'s$/i, "");
          if (stem.length >= 3 && searchable.includes(stem)) score += 1.5;
        }
        if (score > bestScore) { bestScore = score; bestDoc = doc; }
      }
      if (!bestDoc || bestScore < 2) return null;
      return storage.getDocument(bestDoc.id);
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
        const profile = profiles.find((p: any) => p.name.toLowerCase().includes(safeLC(input.forProfile)));
        if (profile) await storage.linkProfileTo(profile.id, "document", doc.id);
      }
      return doc;
    }

    case "navigate":
      return { navigateTo: input.page, profileId: input.profileId };

    case "create_goal": {
      // Dedup: skip if a goal with the same title already exists
      const allGoals = await storage.getGoals();
      const dupGoal = allGoals.find(g => g.title.toLowerCase() === (input.title || "").toLowerCase() && g.status === "active");
      if (dupGoal) {
        logger.info("ai", `Skipped duplicate goal: "${dupGoal.title}"`);
        return dupGoal;
      }
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
      const goal = await storage.createGoal({
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
      // Link goal to profile (via tracker's profile or explicit name)
      if (trackerId) {
        const trackers = await storage.getTrackers();
        const linkedTracker = trackers.find(t => t.id === trackerId);
        if (linkedTracker?.linkedProfiles?.[0]) {
          await autoLinkToProfiles("goal", goal.id, input.title || "", undefined);
        }
      } else {
        // Direct profile linking for goals
        if (input.forProfile) {
          const targetProfile = (await storage.getProfiles()).find(p => 
            p.name.toLowerCase() === safeLC(input.forProfile).trim() ||
            p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
          if (targetProfile) {
            await storage.updateGoal(goal.id, { linkedProfiles: [targetProfile.id] } as any);
            await storage.linkProfileTo(targetProfile.id, "goal", goal.id).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
          }
        }
        await autoLinkToProfiles("goal", goal.id, `${input.title || ""} ${input.forProfile || ""}`, input.forProfile);
      }

      // Auto-create companion habit for daily/frequency-based goals
      // (e.g., "run every day", "drink water daily", "meditate 10 min")
      const dailyTypes = ["fitness_frequency", "habit_streak", "tracker_target"];
      const titleLower = (input.title || "").toLowerCase();
      const impliesDaily = dailyTypes.includes(input.type) ||
        titleLower.includes("daily") || titleLower.includes("every day") ||
        titleLower.includes("per day") || (input.unit || "").toLowerCase().includes("day");
      if (impliesDaily && !habitId) {
        try {
          // Check if a matching habit already exists
          const existingHabits = await storage.getHabits();
          const alreadyExists = existingHabits.some(h =>
            h.name.toLowerCase().includes(titleLower.split(" ").slice(0, 2).join(" ")) ||
            titleLower.includes(h.name.toLowerCase())
          );
          if (!alreadyExists) {
            const habit = await storage.createHabit({ name: input.title, frequency: "daily" });
            // Link the habit to the goal
            await storage.updateGoal(goal.id, { habitId: habit.id });
            logger.info("ai", `Auto-created companion habit "${input.title}" for goal ${goal.id}`);
          }
        } catch (e) {
          logger.warn("ai", `Failed to auto-create companion habit for goal: ${e}`);
        }
      }
      return goal;
    }

    case "get_goal_progress": {
      const goals = await storage.getGoals();
      if (input.query) {
        const q = safeLC(input.query);
        const filtered = goals.filter(g => g.title.toLowerCase().includes(q) || g.type.includes(q));
        return filtered.length > 0 ? filtered : goals;
      }
      return goals;
    }

    case "update_goal": {
      const goals = await storage.getGoals();
      const goal = goals.find(g => g.title.toLowerCase().includes((input.title || "").toLowerCase()));
      if (!goal) return { error: "Goal not found: " + (input.title || "unknown") };
      const changes: any = {};
      if (input.status) changes.status = input.status;
      if (input.target) changes.target = input.target;
      if (input.deadline) changes.deadline = input.deadline;
      if (input.currentProgress !== undefined && input.currentProgress !== null) changes.current = input.currentProgress;
      // Link to tracker by name
      if (input.trackerId) {
        const trackers = await storage.getTrackers();
        const found = trackers.find(t => t.name.toLowerCase().includes((input.trackerId || "").toLowerCase()));
        if (found) {
          changes.trackerId = found.id;
          logger.info("ai", `Linked goal "${goal.title}" to tracker "${found.name}"`);
        } else {
          logger.warn("ai", `Tracker not found for goal link: ${input.trackerId}`);
        }
      }
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
      const match = tasks.find(t => t.title.toLowerCase().includes(safeLC(input.title)));
      if (!match) return { error: `No task found matching "${input.title}"` };
      const updated = await storage.updateTask(match.id, input.changes);
      return { updated: true, task: updated };
    }

    case "update_expense": {
      const expenses = await storage.getExpenses();
      const match = expenses.find(e => e.description.toLowerCase().includes(safeLC(input.description)));
      if (!match) return { error: `No expense found matching "${input.description}"` };
      const updated = await storage.updateExpense(match.id, input.changes);
      return { updated: true, expense: updated };
    }

    case "update_obligation": {
      const obligations = await storage.getObligations();
      const match = obligations.find(o => o.name.toLowerCase().includes(safeLC(input.name)));
      if (!match) return { error: `No obligation found matching "${input.name}"` };
      const updated = await storage.updateObligation(match.id, input.changes);
      return { updated: true, obligation: updated };
    }

    case "update_habit": {
      const habits = await storage.getHabits();
      const uhResult = safeMatchEntity(habits, input.name || "", h => h.name);
      if (!uhResult.match) return { error: uhResult.error || "Habit not found", candidates: uhResult.candidates };
      const updated = await storage.updateHabit(uhResult.match.id, input.changes);
      return { updated: true, habit: updated };
    }

    case "delete_habit": {
      const habits = await storage.getHabits();
      const dhResult = safeMatchEntity(habits, input.name || "", h => h.name, { isDestructive: true });
      if (!dhResult.match) return { error: dhResult.error || "Habit not found", candidates: dhResult.candidates };
      await storage.deleteHabit(dhResult.match.id);
      return { deleted: true, name: dhResult.match.name, id: dhResult.match.id };
    }

    case "delete_obligation": {
      const obligations = await storage.getObligations();
      const doResult = safeMatchEntity(obligations, input.name || "", o => o.name, { isDestructive: true });
      if (!doResult.match) return { error: doResult.error || "Obligation not found", candidates: doResult.candidates };
      await storage.deleteObligation(doResult.match.id);
      return { deleted: true, name: doResult.match.name, id: doResult.match.id };
    }

    case "delete_event": {
      const events = await storage.getEvents();
      const deResult = safeMatchEntity(events, input.title || "", e => e.title, { isDestructive: true });
      if (!deResult.match) return { error: deResult.error || "Event not found", candidates: deResult.candidates };
      await storage.deleteEvent(deResult.match.id);
      return { deleted: true, title: deResult.match.title, id: deResult.match.id };
    }

    // ─── NEW HANDLERS ─────────────────────────────────────────────────────────

    case "uncomplete_habit": {
      const habits = await storage.getHabits();
      const nameQ = (input.name || "").toLowerCase();
      let eligible = habits;
      if (input.forProfile) {
        const profs = await storage.getProfiles();
        const prof = profs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) eligible = habits.filter(h => (h.linkedProfiles || []).includes(prof.id));
      } else {
        const selfProf = (await storage.getProfiles()).find(p => p.type === "self");
        if (selfProf) { const sh = habits.filter(h => (h.linkedProfiles||[]).includes(selfProf.id)); if (sh.length > 0) eligible = sh; }
      }
      const habit = eligible.find(h => h.name.toLowerCase().includes(nameQ)) ?? habits.find(h => h.name.toLowerCase().includes(nameQ));
      if (!habit) return { error: "Habit not found: " + (input.name || "unknown") };
      const targetDate = input.date || new Date().toLocaleDateString('en-CA');
      // Find and delete today's checkin
      const fullHabit = await storage.getHabit(habit.id);
      const checkin = (fullHabit?.checkins || []).find((c: any) => c.date === targetDate);
      if (!checkin) return { error: `No check-in found for "${habit.name}" on ${targetDate}` };
      await storage.deleteHabitCheckin(habit.id, checkin.id);
      return { uncompleted: true, habitName: habit.name, date: targetDate };
    }

    case "complete_event": {
      const events = await storage.getEvents();
      let evtPool = events;
      if (input.forProfile) {
        const profs = await storage.getProfiles();
        const prof = profs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) evtPool = events.filter(e => (e.linkedProfiles || []).includes(prof.id));
      }
      const ceResult = safeMatchEntity(evtPool, input.title || "", e => e.title);
      if (!ceResult.match) return { error: ceResult.error || "Event not found", candidates: ceResult.candidates };
      const completed = await storage.updateEvent(ceResult.match.id, { status: "completed" } as any);
      if (input.removeFromSchedule) {
        // Also mark as hidden from upcoming by setting date to past
        await storage.deleteEvent(ceResult.match.id);
        return { completed: true, deleted: true, title: ceResult.match.title };
      }
      return { completed: true, title: ceResult.match.title, event: completed };
    }

    case "delete_tracker_entry": {
      const trackers = await storage.getTrackers();
      let trackerPool = trackers;
      if (input.forProfile) {
        const profs = await storage.getProfiles();
        const prof = profs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) trackerPool = trackers.filter(t => (t.linkedProfiles || []).includes(prof.id));
      }
      const dteResult = safeMatchEntity(trackerPool, input.trackerName || "", t => t.name);
      if (!dteResult.match) return { error: dteResult.error || "Tracker not found", candidates: dteResult.candidates };
      const tracker = dteResult.match;
      const entries = tracker.entries || [];
      if (entries.length === 0) return { error: `Tracker "${tracker.name}" has no entries to delete.` };
      const idx = input.entryIndex ?? 0;
      const entry = entries[entries.length - 1 - idx]; // 0 = most recent
      if (!entry) return { error: `No entry found at index ${idx}` };
      await storage.deleteTrackerEntry(tracker.id, entry.id);
      return { deleted: true, trackerName: tracker.name, entryId: entry.id, values: entry.values };
    }

    case "update_tracker_entry": {
      const trackers = await storage.getTrackers();
      let trackerPool2 = trackers;
      if (input.forProfile) {
        const profs = await storage.getProfiles();
        const prof = profs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) trackerPool2 = trackers.filter(t => (t.linkedProfiles || []).includes(prof.id));
      }
      const uteResult = safeMatchEntity(trackerPool2, input.trackerName || "", t => t.name);
      if (!uteResult.match) return { error: uteResult.error || "Tracker not found", candidates: uteResult.candidates };
      const uTracker = uteResult.match;
      const uEntries = uTracker.entries || [];
      if (uEntries.length === 0) return { error: `Tracker "${uTracker.name}" has no entries to update.` };
      const uIdx = input.entryIndex ?? 0;
      const uEntry = uEntries[uEntries.length - 1 - uIdx];
      if (!uEntry) return { error: `No entry found at index ${uIdx}` };
      // Delete old entry and re-log with new values (storage doesn't have updateTrackerEntry)
      await storage.deleteTrackerEntry(uTracker.id, uEntry.id);
      const newEntry = await storage.logEntry({ trackerId: uTracker.id, values: { ...uEntry.values, ...input.values }, notes: uEntry.notes });
      return { updated: true, trackerName: uTracker.name, oldValues: uEntry.values, newValues: input.values, newEntry };
    }

    // ─── END NEW HANDLERS ─────────────────────────────────────────────────────

    case "delete_tracker": {
      const trackers = await storage.getTrackers();
      const dtResult = safeMatchEntity(trackers, input.name || "", t => t.name, { isDestructive: true });
      if (!dtResult.match) return { error: dtResult.error || "Tracker not found", candidates: dtResult.candidates };
      await storage.deleteTracker(dtResult.match.id);
      return { deleted: true, name: dtResult.match.name, id: dtResult.match.id };
    }

    case "update_tracker": {
      const trackers = await storage.getTrackers();
      const utResult = safeMatchEntity(trackers, input.trackerName || "", t => t.name);
      if (!utResult.match) return { error: utResult.error || "Tracker not found", candidates: utResult.candidates };
      const updated = await storage.updateTracker(utResult.match.id, input.changes);
      return { updated: true, tracker: updated };
    }

    case "delete_journal": {
      const entries = await storage.getJournalEntries();
      const today = new Date().toLocaleDateString('en-CA');
      // Match by date (today/yesterday shorthand) or most recent if no date given
      let matchEntry = input.date ? entries.find(e => e.date === input.date) : null;
      if (!matchEntry) matchEntry = entries.find(e => e.date === today) ?? entries[entries.length - 1] ?? null;
      // Also filter by profile if specified
      if (input.forProfile && matchEntry) {
        const profs = await storage.getProfiles();
        const prof = profs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) {
          const profEntry = entries.filter(e => ((e as any).linkedProfiles || []).includes(prof.id))
            .sort((a, b) => b.date.localeCompare(a.date))[0];
          if (profEntry) matchEntry = profEntry;
        }
      }
      if (!matchEntry) return { error: `No journal entry found for date "${input.date || today}"` };
      await storage.deleteJournalEntry(matchEntry.id);
      return { deleted: true, date: matchEntry.date, id: matchEntry.id };
    }

    case "update_journal": {
      const entries = await storage.getJournalEntries();
      const today2 = new Date().toLocaleDateString('en-CA');
      let matchEntry2 = input.date ? entries.find(e => e.date === input.date) : null;
      if (!matchEntry2) matchEntry2 = entries.find(e => e.date === today2) ?? entries[entries.length - 1] ?? null;
      if (input.forProfile && matchEntry2) {
        const profs = await storage.getProfiles();
        const prof = profs.find(p => p.name.toLowerCase().includes(safeLC(input.forProfile).trim()));
        if (prof) {
          const profEntry = entries.filter(e => ((e as any).linkedProfiles || []).includes(prof.id))
            .sort((a, b) => b.date.localeCompare(a.date))[0];
          if (profEntry) matchEntry2 = profEntry;
        }
      }
      if (!matchEntry2) return { error: `No journal entry found for date "${input.date || today2}"` };
      const updated = await storage.updateJournalEntry(matchEntry2.id, input.changes);
      return { updated: true, journal: updated };
    }

    case "delete_artifact": {
      const artifacts = await storage.getArtifacts();
      const daResult = safeMatchEntity(artifacts, input.title || "", a => a.title, { isDestructive: true });
      if (!daResult.match) return { error: daResult.error || "Artifact not found", candidates: daResult.candidates };
      const match = daResult.match;
      await storage.deleteArtifact(match.id);
      return { deleted: true, title: match.title, id: match.id };
    }

    case "update_artifact": {
      const artifacts = await storage.getArtifacts();
      const artifact = artifacts.find(a => a.title.toLowerCase().includes(safeLC(input.title)));
      if (!artifact) return { error: `No artifact found matching "${input.title}"` };
      const updated = await storage.updateArtifact(artifact.id, input.changes);
      return { updated: true, artifact: updated };
    }

    case "delete_goal": {
      const goals = await storage.getGoals();
      const match = goals.find(g => g.title.toLowerCase().includes(safeLC(input.title)));
      if (!match) return { error: `No goal found matching "${input.title}"` };
      await storage.deleteGoal(match.id);
      return { deleted: true, title: match.title, id: match.id };
    }

    case "delete_memory": {
      const memories = await storage.getMemories();
      const match = memories.find(m =>
        m.key.toLowerCase().includes(safeLC(input.query)) ||
        m.value.toLowerCase().includes(safeLC(input.query))
      );
      if (!match) return { error: `No memory found matching "${input.query}"` };
      await storage.deleteMemory(match.id);
      return { deleted: true, key: match.key, id: match.id };
    }

    case "bulk_complete_tasks": {
      const tasks = await storage.getTasks();
      const now = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
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
      const recentActions = getActionLog(count);
      return { actions: recentActions, total: recentActions.length };
    }

    case "sync_calendar": {
      try {
        const { execFile } = require("child_process");
        const { promisify } = require("util");
        const execFileAsync = promisify(execFile);
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

        const { stdout } = await execFileAsync("external-tool", ["call", params], {
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
          const eventDate = startParsed.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
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
      const domain = domains.find((d: any) => d.name.toLowerCase().includes(safeLC(input.name)));
      if (!domain) return { error: `No domain found matching "${input.name}"` };
      const updated = await storage.updateDomain(domain.id, input.changes);
      return { updated: true, domain: updated };
    }

    case "delete_domain": {
      const domains = await storage.getDomains();
      const domain = domains.find((d: any) => d.name.toLowerCase().includes(safeLC(input.name)));
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
          p.name.toLowerCase().includes(safeLC(input.profileName))
        );
        if (profile) {
          candidates = candidates.filter((d: any) =>
            d.linkedProfiles?.includes(profile.id)
          );
        }
      }

      // Filter by document type if specified
      if (input.documentType) {
        const typeQuery = safeLC(input.documentType).replace(/[_\s-]/g, "");
        candidates = candidates.filter((d: any) => {
          const docType = (d.type || "").toLowerCase().replace(/[_\s-]/g, "");
          return docType.includes(typeQuery) || typeQuery.includes(docType);
        });
      }

      // Text search across name, type, tags, extracted data — with fuzzy stemming
      if (input.query) {
        const q = safeLC(input.query);
        const qWords = q.split(/\s+/).filter(Boolean);
        // Score and sort rather than hard-filter
        const scored = candidates.map((d: any) => {
          const searchable = [
            d.name, (d.type || "").replace(/_/g, " "), ...(d.tags || []),
            ...Object.keys(d.extractedData || {}),
            ...Object.values(d.extractedData || {}).map((v: any) => String(v)),
          ].join(" ").toLowerCase();
          let score = 0;
          if (searchable.includes(q)) score += 10;
          for (const w of qWords) {
            if (searchable.includes(w)) score += 2;
            const stem = w.replace(/s$|'s$/i, "");
            if (stem.length >= 3 && searchable.includes(stem)) score += 1.5;
          }
          return { doc: d, score };
        }).filter(s => s.score >= 2).sort((a, b) => b.score - a.score);
        candidates = scored.map(s => s.doc);
      }

      if (candidates.length === 0) return { found: false, message: "No matching documents found." };

      // Return top match — use __LAZY_LOAD__ so client fetches file on-demand
      // (avoids embedding multi-MB base64 in the AI JSON response which can blow up Vercel limits)
      const doc = candidates[0];
      return {
        found: true,
        document: {
          id: doc.id,
          name: doc.name,
          type: doc.type,
          mimeType: doc.mimeType,
          extractedData: doc.extractedData,
          linkedProfiles: doc.linkedProfiles,
          tags: doc.tags,
          hasFileData: true,
        },
        documentPreview: {
          id: doc.id,
          name: doc.name,
          mimeType: doc.mimeType,
          data: "__LAZY_LOAD__",
        },
        totalMatches: candidates.length,
      };
    }

    case "revalue_asset": {
      const profiles = await storage.getProfiles();
      const profile = profiles.find(p => p.name.toLowerCase().includes(safeLC(input.profileName)));
      if (!profile) return { error: "Profile not found: " + input.profileName };

      const valuation = await estimateAssetValue({ type: profile.type, name: profile.name, fields: profile.fields });
      if (!valuation || valuation.estimatedValue === 0) {
        return { error: "Could not estimate value for " + profile.name };
      }

      const oldValue = profile.fields?.currentValue || profile.fields?.purchasePrice || 0;
      await storage.updateProfile(profile.id, {
        fields: {
          ...profile.fields,
          currentValue: valuation.estimatedValue,
          valuationMethod: valuation.method,
          valuationConfidence: valuation.confidence,
          valuationRange: valuation.details,
          valuationDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
          previousValue: oldValue,
        },
      });

      return {
        name: profile.name,
        previousValue: oldValue,
        currentValue: valuation.estimatedValue,
        confidence: valuation.confidence,
        method: valuation.method,
        range: valuation.details,
        change: valuation.estimatedValue - Number(oldValue),
      };
    }

    case "generate_chart": {
      try { const chart = await buildChartSpec(input); return { chart, generated: true }; }
      catch (e: any) { return { error: "Chart generation failed: " + e.message }; }
    }
    case "generate_table": {
      try { const table = await buildTableSpec(input); return { table, generated: true }; }
      catch (e: any) { return { error: "Table generation failed: " + e.message }; }
    }
    case "generate_report": {
      try { const report = await buildReportSpec(input); return { report, generated: true }; }
      catch (e: any) { return { error: "Report generation failed: " + e.message }; }
    }

    default:
      return null;
  }
}

// ─── Chart/Table/Report Builders ────────────────────────────────────────────────────────────────────────

const CHART_COLORS = ["hsl(188 55% 50%)","#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16","#f97316","#ec4899"];

function dateRangeStart(dateRange?: string): Date {
  const now = new Date();
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  switch (dateRange) {
    case "week": return new Date(now.getTime() - 7*86400000);
    case "month": return new Date(todayStr.slice(0,7) + '-01T12:00:00');
    case "3months": return new Date(now.getTime() - 90*86400000);
    case "6months": return new Date(now.getTime() - 180*86400000);
    case "year": return new Date(todayStr.slice(0,4) + '-01-01T12:00:00');
    default: return new Date(0);
  }
}

async function resolveProfileId(name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const profiles = await storage.getProfiles();
  const lc = name.toLowerCase();
  return profiles.find(p => p.name.toLowerCase() === lc || (p.type === 'self' && lc === 'me'))?.id;
}

async function buildChartSpec(input: Record<string, any>): Promise<ChartSpec> {
  const { chartType, title, subtitle, dataSource, trackerName, dateRange, forProfile, groupBy, showLegend } = input;
  const since = dateRangeStart(dateRange);
  const profileId = await resolveProfileId(forProfile);

  if (dataSource === "expenses") {
    const expenses = await storage.getExpenses();
    const filtered = expenses.filter(e => {
      if (new Date(e.date || e.createdAt) < since) return false;
      if (profileId && !e.linkedProfiles?.includes(profileId)) return false;
      return true;
    });
    if (filtered.length === 0) throw new Error("No expense data found for the selected period.");

    if (chartType === "pie" || groupBy === "category") {
      const grouped: Record<string, number> = {};
      for (const e of filtered) { const cat = e.category || "general"; grouped[cat] = (grouped[cat]||0) + e.amount; }
      const data = Object.entries(grouped).sort((a,b) => b[1]-a[1]).map(([category, amount], i) => ({ category, amount: Math.round(amount*100)/100, fill: CHART_COLORS[i%CHART_COLORS.length] }));
      return { type:"pie", title, subtitle: subtitle || `${filtered.length} expenses \u00b7 $${filtered.reduce((s,e)=>s+e.amount,0).toFixed(2)} total`, data, series:[{dataKey:"amount",name:"Amount"}], xAxisKey:"category", nameKey:"category", valueKey:"amount", showLegend: showLegend !== false, height:300 };
    }
    // Bar by month
    const grouped: Record<string, number> = {};
    for (const e of filtered) { const d = new Date(e.date || e.createdAt); const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; grouped[k] = (grouped[k]||0)+e.amount; }
    const data = Object.entries(grouped).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,amount])=>({month,amount:Math.round(amount*100)/100}));
    return { type:"bar", title, subtitle, data, series:[{dataKey:"amount",name:"Spending",color:CHART_COLORS[0]}], xAxisKey:"month", yAxisLabel:"Amount ($)", showLegend:false, showGrid:true, height:260 };
  }

  if (dataSource === "trackers" && trackerName) {
    const allTrackers = await storage.getTrackers();
    const names = trackerName.split(",").map((n:string)=>n.trim().toLowerCase());
    const trackers = allTrackers.filter(t => names.some((n:string) => t.name.toLowerCase().includes(n)));
    if (trackers.length === 0) throw new Error(`Tracker "${trackerName}" not found.`);

    const tracker = trackers[0];
    const entries = tracker.entries.filter(e => new Date(e.timestamp) >= since).sort((a,b)=>new Date(a.timestamp).getTime()-new Date(b.timestamp).getTime());
    if (entries.length === 0) throw new Error(`No entries found for "${tracker.name}" in this period.`);

    if (/blood.?pressure|bp/i.test(tracker.name) || entries[0]?.values?.systolic !== undefined) {
      const data = entries.map(e => ({ date: new Date(e.timestamp).toLocaleDateString("en-US",{month:"short",day:"numeric"}), Systolic: e.values.systolic, Diastolic: e.values.diastolic }));
      return { type:"line", title, subtitle, data, series:[{dataKey:"Systolic",name:"Systolic",color:CHART_COLORS[0]},{dataKey:"Diastolic",name:"Diastolic",color:CHART_COLORS[1]}], xAxisKey:"date", showLegend:true, showGrid:true, height:260 };
    }
    const primaryField = tracker.fields.find(f=>f.isPrimary)?.name || Object.keys(entries[0].values)[0] || "value";
    const data = entries.map(e => ({ date: new Date(e.timestamp).toLocaleDateString("en-US",{month:"short",day:"numeric"}), [primaryField]: typeof e.values[primaryField]==="number"?e.values[primaryField]:0 }));
    // Don't render a chart if all data points are zero (no meaningful data)
    const hasNonZero = data.some(d => typeof d[primaryField] === "number" && d[primaryField] !== 0);
    if (!hasNonZero) throw new Error(`No meaningful data found for "${tracker.name}" — all values are zero.`);
    return { type: chartType||"line", title, subtitle, data, series:[{dataKey:primaryField,name:tracker.name,color:CHART_COLORS[0]}], xAxisKey:"date", yAxisLabel:`${tracker.unit||primaryField}`, showLegend:false, showGrid:true, height:260 };
  }

  if (dataSource === "habits") {
    const habits = await storage.getHabits();
    const now = new Date();
    const data = Array.from({length:7},(_,i) => {
      const d = new Date(now.getTime()-(6-i)*86400000);
      const ds = d.toLocaleDateString('en-CA');
      return { day: d.toLocaleDateString("en-US",{weekday:"short"}), completed: habits.filter(h=>h.checkins?.some(c=>c.date===ds)).length, total: habits.length };
    });
    return { type:"bar", title, subtitle: subtitle||`${habits.length} habits tracked`, data, series:[{dataKey:"completed",name:"Completed",color:CHART_COLORS[2]}], xAxisKey:"day", showLegend:false, showGrid:true, height:220 };
  }

  if (dataSource === "goals") {
    const goals = await storage.getGoals();
    if (goals.length === 0) throw new Error("No goals found.");
    const data = goals.map(g => ({ goal: g.title.slice(0,20), progress: Math.min(100,Math.round((g.current/g.target)*100)) }));
    return { type:"radar", title, subtitle, data, series:[{dataKey:"progress",name:"Progress %",color:CHART_COLORS[0]}], xAxisKey:"goal", showLegend:false, height:280 };
  }

  throw new Error(`Cannot build chart: dataSource="${dataSource}", chartType="${chartType}"`);
}

async function buildTableSpec(input: Record<string, any>): Promise<TableSpec> {
  const { title, subtitle, dataSource, columns: inputColumns, filters={}, sortBy, sortDir="desc", limit=50, includeSummary } = input;
  const since = dateRangeStart(filters.dateRange);
  const profileId = await resolveProfileId(filters.forProfile);
  let rows: Array<Record<string,any>> = [];
  let columns = inputColumns || [];

  if (dataSource === "expenses") {
    const all = await storage.getExpenses();
    rows = all.filter(e => {
      if (new Date(e.date||e.createdAt) < since) return false;
      if (filters.category && e.category !== filters.category) return false;
      if (filters.minAmount && e.amount < filters.minAmount) return false;
      if (filters.maxAmount && e.amount > filters.maxAmount) return false;
      if (profileId && !e.linkedProfiles?.includes(profileId)) return false;
      return true;
    }).map(e => ({ date:e.date, description:e.description, category:e.category, amount:e.amount, vendor:e.vendor||"", id:e.id }));
    if (!inputColumns?.length) columns = [
      {key:"date",label:"Date",format:"date"},
      {key:"description",label:"Description",align:"left"},
      {key:"category",label:"Category"},
      {key:"amount",label:"Amount",format:"currency",align:"right"},
    ];
  } else if (dataSource === "tasks") {
    const all = await storage.getTasks();
    rows = all.filter(t => (!filters.status||t.status===filters.status)).map(t=>({title:t.title,status:t.status,priority:t.priority,dueDate:t.dueDate||"",id:t.id}));
    if (!inputColumns?.length) columns = [{key:"title",label:"Task",align:"left"},{key:"priority",label:"Priority"},{key:"status",label:"Status"},{key:"dueDate",label:"Due",format:"date"}];
  } else if (dataSource === "habits") {
    const all = await storage.getHabits();
    rows = all.map(h=>({name:h.name,frequency:h.frequency,streak:h.currentStreak,best:h.longestStreak,id:h.id}));
    if (!inputColumns?.length) columns = [{key:"name",label:"Habit",align:"left"},{key:"frequency",label:"Frequency"},{key:"streak",label:"Streak",align:"center"},{key:"best",label:"Best",align:"center"}];
  }

  if (rows.length === 0) throw new Error(`No ${dataSource} data found.`);
  if (sortBy) rows.sort((a,b) => { const av=a[sortBy],bv=b[sortBy]; if(typeof av==="number"&&typeof bv==="number") return sortDir==="asc"?av-bv:bv-av; return sortDir==="asc"?String(av).localeCompare(String(bv)):String(bv).localeCompare(String(av)); });
  rows = rows.slice(0, limit);
  const summary = (includeSummary && dataSource==="expenses") ? { description:`Total (${rows.length} items)`, amount:rows.reduce((s,r)=>s+(r.amount||0),0) } : undefined;
  return { title, subtitle, columns, rows, summary };
}

async function buildReportSpec(input: Record<string, any>): Promise<ReportSpec> {
  const { reportType, title: customTitle, dateRange="month", forProfile } = input;
  const now = new Date();
  const since = dateRangeStart(dateRange);
  const profileId = await resolveProfileId(forProfile);
  const sections: ReportSection[] = [];

  if (reportType === "financial") {
    const expenses = await storage.getExpenses();
    const filtered = expenses.filter(e => new Date(e.date||e.createdAt) >= since && (!profileId || e.linkedProfiles?.includes(profileId)));
    const total = filtered.reduce((s,e)=>s+e.amount,0);
    const byCategory: Record<string,number> = {};
    for (const e of filtered) byCategory[e.category||"general"] = (byCategory[e.category||"general"]||0)+e.amount;
    const topCategory = Object.entries(byCategory).sort((a,b)=>b[1]-a[1])[0]?.[0] || "\u2014";
    sections.push({ heading:"Summary", metrics:[
      {label:"Total Spent",value:`$${total.toFixed(2)}`,changeType:"neutral"},
      {label:"Transactions",value:filtered.length},
      {label:"Top Category",value:topCategory},
      {label:"Avg/Day",value:`$${(total/Math.max(1,(now.getTime()-since.getTime())/86400000)).toFixed(2)}`},
    ]});
    if (filtered.length > 0) {
      try { const chart = await buildChartSpec({chartType:"pie",title:"Spending by Category",dataSource:"expenses",dateRange,forProfile}); sections.push({heading:"Breakdown",chart}); } catch {}
    }
    try { const table = await buildTableSpec({title:"Recent Expenses",dataSource:"expenses",columns:[],filters:{dateRange},sortBy:"amount",sortDir:"desc",limit:15,includeSummary:true}); sections.push({heading:"Expenses",table}); } catch {}
    return {title:customTitle||`Financial Report \u2014 ${dateRange}`,sections,generatedAt:now.toISOString()};
  }

  if (reportType === "life_scorecard") {
    const [tasks,habits,expenses,trackers,goals] = await Promise.all([storage.getTasks(),storage.getHabits(),storage.getExpenses(),storage.getTrackers(),storage.getGoals()]);
    const taskScore = Math.min(100,Math.round((tasks.filter(t=>t.status==="done").length/Math.max(1,tasks.length))*100));
    const habitScore = Math.min(100,Math.round(habits.reduce((s,h)=>s+Math.min(100,h.currentStreak*10),0)/Math.max(1,habits.length)));
    const recentExpenses = expenses.filter(e=>new Date(e.date||e.createdAt)>=since);
    const budgetScore = Math.max(0,100-Math.min(100,Math.round(recentExpenses.length*2)));
    const fitnessTrackers = trackers.filter(t=>/run|walk|swim|bike|exercise|fitness|gym|sport/i.test(t.name));
    const fitnessScore = Math.min(100,fitnessTrackers.reduce((s,t)=>s+Math.min(100,t.entries.filter(e=>new Date(e.timestamp)>=since).length*15),0));
    const goalScore = goals.length>0 ? Math.round(goals.reduce((s,g)=>s+Math.min(100,(g.current/g.target)*100),0)/goals.length) : 50;
    const radarData = [{area:"Tasks",score:taskScore},{area:"Habits",score:habitScore},{area:"Budget",score:budgetScore},{area:"Fitness",score:fitnessScore},{area:"Goals",score:goalScore}];
    sections.push({heading:"Life Balance",chart:{type:"radar",title:"Life Scorecard",data:radarData,series:[{dataKey:"score",name:"Score",color:CHART_COLORS[0]}],xAxisKey:"area",showLegend:false,height:300}});
    sections.push({heading:"Scores",metrics:radarData.map(d=>({label:d.area,value:d.score,changeType:d.score>=70?"positive":d.score>=40?"neutral":"negative" as "positive"|"negative"|"neutral"}))});
    return {title:customTitle||"Life Scorecard",sections,generatedAt:now.toISOString()};
  }

  if (reportType === "weekly_digest") {
    const weekSince = dateRangeStart("week");
    const [tasks,habits,expenses] = await Promise.all([storage.getTasks(),storage.getHabits(),storage.getExpenses()]);
    const weeklyExpenses = expenses.filter(e=>new Date(e.date||e.createdAt)>=weekSince);
    sections.push({heading:"This Week",metrics:[
      {label:"Tasks Done",value:tasks.filter(t=>t.status==="done").length},
      {label:"Spent",value:`$${weeklyExpenses.reduce((s,e)=>s+e.amount,0).toFixed(2)}`},
      {label:"Habits",value:habits.reduce((s,h)=>s+(h.checkins?.filter(c=>new Date(c.date)>=weekSince).length||0),0)+" check-ins"},
    ]});
    if (weeklyExpenses.length > 0) { try { const chart = await buildChartSpec({chartType:"pie",title:"Week Spending",dataSource:"expenses",dateRange:"week"}); sections.push({heading:"Spending",chart}); } catch {} }
    return {title:customTitle||"Weekly Digest",sections,generatedAt:now.toISOString()};
  }

  throw new Error(`Unknown report type: ${reportType}`);
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
        const cappedCurrent = Math.min(newCurrent, goal.target);
        const update: Record<string, any> = { current: cappedCurrent };
        // Auto-complete the goal when target is reached
        if (newCurrent >= goal.target) {
          update.status = "completed";
        }
        await storage.updateGoal(goal.id, update);
        logger.info("goal", `Auto-updated "${goal.title}": ${goal.current} → ${cappedCurrent} ${goal.unit}${newCurrent >= goal.target ? ' (COMPLETED!)' : ''}`);
      }
    }
  } catch (e) {
    console.error('[goal] autoUpdateGoalProgress failed:', e);
  }
}

// ============================================================
// AUTO-LINKING — scan created entities for profile name matches
// ============================================================

// ═══════════════════════════════════════════════════════════════
// DIRECT PROFILE LINKING — the ONLY reliable way to link entities
// Called by every create_* tool when forProfile is set.
// This bypasses all the scoring/text-matching complexity.
// ═══════════════════════════════════════════════════════════════
async function directLinkToProfile(entityType: string, entityId: string, forProfile: string | undefined): Promise<string | undefined> {
  if (!forProfile) return undefined;
  const profiles = await storage.getProfiles();
  const searchName = forProfile.toLowerCase().trim();
  // Exact match first, then partial
  const target = profiles.find(p => p.name.toLowerCase() === searchName)
    || profiles.find(p => p.name.toLowerCase().includes(searchName) || searchName.includes(p.name.toLowerCase()));
  if (!target) {
    logger.warn("ai", `directLinkToProfile: profile "${forProfile}" not found`);
    return undefined;
  }
  // Set linkedProfiles on the entity
  await updateEntityLinkedProfiles(entityType, entityId, target.id);
  await storage.linkProfileTo(target.id, entityType, entityId).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
  
  // For expenses ONLY: also link to self so it shows in owner's finance
  if (entityType === "expense") {
    const self = profiles.find(p => p.type === "self");
    if (self && self.id !== target.id) {
      await updateEntityLinkedProfiles(entityType, entityId, self.id);
      await storage.linkProfileTo(self.id, entityType, entityId).catch((e: any) => { console.warn("[AI] Profile linking failed:", e?.message); });
    }
  }
  
  logger.info("ai", `directLinkToProfile: linked ${entityType} to "${target.name}" (${target.id.substring(0, 8)})`);
  return target.id;
}


// Scan text for profile names when forProfile wasn't explicitly set
async function resolveForProfile(forProfile: string | undefined, text: string): Promise<string | undefined> {
  if (forProfile) return forProfile;
  const profiles = await storage.getProfiles();
  // Sort by name length descending — prefer longest match first to avoid "Rex" matching before "Rex Jr."
  const candidates = profiles
    .filter(p => p.type !== 'self' && p.name.length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  for (const p of candidates) {
    if (text.toLowerCase().includes(p.name.toLowerCase())) {
      return p.name;
    }
  }
  return undefined;
}

async function autoLinkToProfiles(entityType: string, entityId: string, text: string, explicitProfileName?: string): Promise<void> {
  // HARD BLOCK: Profile-exclusive types are NEVER auto-linked.
  // They get their profile set exactly once at creation time.
  // This function should never be called for them, but guard anyway.
  if (PROFILE_EXCLUSIVE_TYPES.has(entityType)) {
    logger.warn("ai", `autoLinkToProfiles BLOCKED for profile-exclusive type: ${entityType}`);
    return;
  }
  logger.info("ai", `autoLinkToProfiles: type=${entityType} text="${text?.substring(0, 50)}" explicit="${explicitProfileName}"`);
  if (!text && !explicitProfileName) return;
  try {
    const profiles = await storage.getProfiles();
    const lower = (text || "").toLowerCase();
    const selfProfile = profiles.find(p => p.type === "self");
    const matchedNonSelfIds: string[] = [];

    // SCORING-BASED MATCHING: score each profile and pick the BEST match only.
    // This prevents "Craig" from matching both "Craig Isolation Test" AND "Craig Rent Obligation".
    const scored: Array<{ id: string; score: number }> = [];

    for (const profile of profiles) {
      const name = profile.name.toLowerCase();
      if (name.length < 2) continue;
      if (profile.type === "self") continue;

      let score = 0;

      // 1. Explicit profile name match (from forProfile parameter) — highest priority
      if (explicitProfileName) {
        const explicit = explicitProfileName.toLowerCase().trim();
        // Exact match → 100 points
        if (name === explicit) {
          score += 100;
        }
        // Full name contained in explicit or vice versa → 50 points
        else if (name.includes(explicit) || explicit.includes(name)) {
          score += 50;
        }
        // Word overlap scoring: count how many words match (not just "any single word")
        else {
          const explicitWords = explicit.split(/\s+/).filter(w => w.length > 2);
          const nameWords = name.split(/\s+/).filter(w => w.length > 2);
          const skipWords = new Set(["the", "and", "for", "new", "old", "my", "our", "dr.", "auto", "self", "test", "isolation"]);
          let wordMatches = 0;
          for (const ew of explicitWords) {
            if (skipWords.has(ew)) continue;
            if (nameWords.includes(ew)) wordMatches++;
          }
          // Only count if majority of significant words match (not just one)
          const significantExplicit = explicitWords.filter(w => !skipWords.has(w)).length;
          if (wordMatches > 0 && significantExplicit > 0) {
            const overlapRatio = wordMatches / significantExplicit;
            if (overlapRatio >= 0.5) {
              score += Math.round(overlapRatio * 30);
            }
          }
        }
      }

      // 2. Text-based matching — only if no explicit name was provided
      if (score === 0 && !explicitProfileName && lower) {
        // Full name in text → strong match
        if (lower.includes(name)) {
          score += 40;
        }
        // Word overlap — require majority match, not just one word
        else {
          const nameWords = name.split(/\s+/).filter(w => w.length > 2);
          const skipWords = new Set(["the", "and", "for", "new", "old", "my", "our", "dr.", "auto", "self", "track", "log", "add", "create"]);
          const significantWords = nameWords.filter(w => !skipWords.has(w));
          let wordMatches = 0;
          for (const w of significantWords) {
            const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(lower)) wordMatches++;
          }
          // Require at least 50% of significant words to match
          if (significantWords.length > 0 && wordMatches / significantWords.length >= 0.5) {
            score += Math.round((wordMatches / significantWords.length) * 20);
          }
        }
      }

      if (score > 0) {
        scored.push({ id: profile.id, score });
      }
    }

    // Sort by score descending and pick ONLY the best match
    // (unless there's an exact tie at the top, then take both)
    scored.sort((a, b) => b.score - a.score);
    const topScore = scored[0]?.score || 0;
    // When explicit name is given, require higher confidence to prevent wrong matches
    const minScore = explicitProfileName ? 30 : 10;
    const bestMatches = scored.filter(s => s.score === topScore && s.score >= minScore);
    if (explicitProfileName && bestMatches.length > 1) {
      // Ambiguous match with explicit name — log warning and take none (link to self)
      logger.warn("ai", `Ambiguous profile match for "${explicitProfileName}": ${bestMatches.map(m => `${profiles.find(p => p.id === m.id)?.name}(${m.score})`).join(", ")} — skipping to avoid data leak`);
      bestMatches.length = 0; // Clear — will fall through to self-link
    }

    for (const match of bestMatches) {
      matchedNonSelfIds.push(match.id);
      const relationship = entityType === "expense" ? "paid_for" : "related_to";
      try {
        await storage.createEntityLink({
          sourceType: entityType, sourceId: entityId,
          targetType: "profile", targetId: match.id,
          relationship, confidence: Math.min(1, match.score / 100),
        });
      } catch (e: any) { logger.warn("ai", `Duplicate entity link for ${entityType} ${entityId}: ${e?.message}`); }
      try { await storage.linkProfileTo(match.id, entityType, entityId); } catch (e: any) { logger.warn("ai", `linkProfileTo failed for ${entityType} ${entityId} → profile ${match.id}: ${e?.message}`); }
      try { await updateEntityLinkedProfiles(entityType, entityId, match.id); } catch (e: any) { logger.warn("ai", `updateEntityLinkedProfiles failed for ${entityType} ${entityId}: ${e?.message}`); }
    }

    // If no profile matched at all, link to self (so the item shows up in YOUR profile)
    if (matchedNonSelfIds.length === 0 && selfProfile) {
      try {
        await storage.linkProfileTo(selfProfile.id, entityType, entityId);
        await updateEntityLinkedProfiles(entityType, entityId, selfProfile.id);
      } catch (e: any) { logger.warn("ai", `Self-link failed for ${entityType} ${entityId}: ${e?.message}`); }
    }

    // When an entity is linked to an asset/child profile (Honda, Tesla, etc.),
    // ALSO ensure it's linked to the self profile so it appears in the main Finance/Tasks view.
    // EXCEPTION: When forProfile is explicitly set for non-expense entities (tasks, events, habits, goals, journal),
    // do NOT auto-link to self — the item belongs to the target profile only.
    if (matchedNonSelfIds.length > 0 && selfProfile) {
      // PROFILE-EXCLUSIVE entities: trackers, habits, goals, journal
      // These belong to ONE profile only — never propagate up the chain or auto-link to self
      const profileExclusive = ["tracker", "habit", "goal", "journal"];

      if (!profileExclusive.includes(entityType)) {
        for (const matchedId of matchedNonSelfIds) {
          // Propagate up the parent chain (Honda → Me) — only for expenses, tasks, events, obligations
          try { await storage.propagateEntityToAncestors(entityType, entityId, matchedId); } catch (e: any) { logger.warn("ai", `propagateEntityToAncestors failed for ${entityType} ${entityId}: ${e?.message}`); }
        }
        // Auto-link to self when:
        // - The entity is an expense (always shows in owner's finance)
        // - OR no explicit forProfile was provided (implicit text match)
        const shouldLinkToSelf = entityType === "expense" || !explicitProfileName;
        if (shouldLinkToSelf) {
          try {
            await storage.linkProfileTo(selfProfile.id, entityType, entityId);
            await updateEntityLinkedProfiles(entityType, entityId, selfProfile.id);
          } catch (e: any) { logger.warn("ai", `Self-link (shouldLinkToSelf) failed for ${entityType} ${entityId}: ${e?.message}`); }
        }
      }
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
// Profile-exclusive types: ONE owner only. Same set as SupabaseStorage.PROFILE_EXCLUSIVE.
const PROFILE_EXCLUSIVE_TYPES = new Set(["tracker", "habit", "goal", "journal"]);

async function getEntityLinkedProfiles(entityType: string, entityId: string): Promise<string[]> {
  try {
    switch (entityType) {
      case "tracker": { const t = await storage.getTracker(entityId); return t?.linkedProfiles || []; }
      case "habit": { const h = (await storage.getHabits()).find(h => h.id === entityId); return (h as any)?.linkedProfiles || []; }
      case "goal": { const g = (await storage.getGoals()).find(g => g.id === entityId); return (g as any)?.linkedProfiles || []; }
      case "journal": { const j = (await storage.getJournalEntries()).find(j => j.id === entityId); return (j as any)?.linkedProfiles || []; }
      default: return [];
    }
  } catch { return []; }
}

async function updateEntityLinkedProfiles(entityType: string, entityId: string, profileId: string): Promise<void> {
  // ENFORCEMENT: For profile-exclusive types, check if entity already has a different owner.
  // If it does, REJECT the link silently — this prevents all cross-profile contamination.
  if (PROFILE_EXCLUSIVE_TYPES.has(entityType)) {
    const existing = await getEntityLinkedProfiles(entityType, entityId);
    if (existing.length > 0 && !existing.includes(profileId)) {
      console.warn(`[ISOLATION] BLOCKED updateEntityLinkedProfiles: ${entityType} ${entityId.slice(0,8)} already owned by ${existing[0].slice(0,8)}, rejecting ${profileId.slice(0,8)}`);
      return;
    }
  }

  // Also sync to junction table via linkProfileTo (which has its own guard)
  try { await storage.linkProfileTo(profileId, entityType, entityId); } catch (e: any) { /* dup OK */ }

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
    case "habit": {
      const habits = await storage.getHabits();
      const habit = habits.find(h => h.id === entityId);
      if (habit) {
        const existing = habit.linkedProfiles || [];
        if (!existing.includes(profileId)) {
          existing.push(profileId);
          await storage.updateHabit(entityId, { linkedProfiles: existing } as any);
        }
      }
      break;
    }
    case "goal": {
      const goals = await storage.getGoals();
      const goal = goals.find(g => g.id === entityId);
      if (goal) {
        const existing = goal.linkedProfiles || [];
        if (!existing.includes(profileId)) {
          existing.push(profileId);
          await storage.updateGoal(entityId, { linkedProfiles: existing } as any);
        }
      }
      break;
    }
    case "journal": {
      const entries = await storage.getJournalEntries();
      const entry = entries.find(j => j.id === entityId);
      if (entry) {
        const existing = (entry as any).linkedProfiles || [];
        if (!existing.includes(profileId)) {
          existing.push(profileId);
          await storage.updateJournalEntry(entityId, { linkedProfiles: existing } as any);
        }
      }
      break;
    }
    case "document": {
      const docs = await storage.getDocuments();
      const doc = docs.find(d => d.id === entityId);
      if (doc) {
        const existing = doc.linkedProfiles || [];
        if (!existing.includes(profileId)) {
          existing.push(profileId);
          await storage.updateDocument(entityId, { linkedProfiles: existing } as any);
        }
      }
      break;
    }
  }

  // Also sync to junction table (secondary index)
  try {
    await storage.linkProfileTo(profileId, entityType, entityId);
  } catch (e: any) {
    // Non-fatal: JSONB is the source of truth, junction is secondary
    console.error(`[updateEntityLinkedProfiles] junction sync failed for ${entityType}/${entityId}:`, e.message);
  }
}

// ============================================================
// MAIN AI PROCESSING — tool_use loop
// ============================================================

export async function processMessage(userMessage: string, conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>, userId?: string): Promise<{
  reply: string;
  actions: ParsedAction[];
  results: any[];
  documentPreview?: { id: string; name: string; mimeType: string; data: string };
  documentPreviews?: Array<{ id: string; name: string; mimeType: string; data: string }>;
  charts?: ChartSpec[];
  tables?: TableSpec[];
  report?: ReportSpec;
}> {
  // ─── Pre-AI fast-path: handle operations that DON'T need the AI ───
  // These run instantly without calling Anthropic, making the app snappy even when the API is down.
  const lower = userMessage.toLowerCase().trim();

  // FAST-PATH: "open [document name]" — direct DB lookup, no AI needed
  // Only trigger for "open" / "pull up" / "view" (not "show" which is ambiguous with "show me my tasks")
  // Skip if it looks like a general query: "show me", "show my tasks", "get my tasks"
  const isDocOpen = lower.match(/^(?:open|pull up)\s+(?:up\s+)?(?:my\s+)?(.+)/) ||
    (lower.match(/^(?:view|show|find|get)\s+(?:my\s+)?(.+)/) && 
     !lower.match(/\b(?:tasks?|expenses?|trackers?|habits?|events?|calendar|bills?|obligations?|goals?|spending|journal|mood|summary|data|stats|schedule)\b/));
  if (isDocOpen) {
    const searchTerm = lower.replace(/^(?:open|show|view|pull up|find|get)\s+(?:up\s+)?(?:my\s+)?/, "").trim();
    try {
      const allDocs = await storage.getDocuments(); // Note: fileData is excluded from list queries for performance
      // Bidirectional synonym groups — every word in a group maps to all others
      const synonymGroups: string[][] = [
        ["car", "vehicle", "auto", "automobile"],
        ["registration", "reg"],
        ["license", "licence", "dl"],
        ["insurance", "policy", "coverage"],
        ["citation", "ticket", "toll", "parking"],
        ["passport", "travel document"],
        ["birth", "born"],
        ["id", "identification"],
        ["bank", "statement"],
      ];
      // Build bidirectional map from groups
      const synonymMap: Record<string, string[]> = {};
      for (const group of synonymGroups) {
        for (const word of group) {
          synonymMap[word] = group.filter(w => w !== word);
        }
      }
      // Expand search term with synonyms
      const expandWithSynonyms = (term: string): string[] => {
        const words = term.split(/\s+/);
        const expanded: string[] = [term];
        for (let i = 0; i < words.length; i++) {
          const syns = synonymMap[words[i]];
          if (syns) {
            for (const syn of syns) {
              expanded.push([...words.slice(0, i), syn, ...words.slice(i + 1)].join(" "));
            }
          }
        }
        return expanded;
      };
      // Strip filler words like "for my", "of my", etc. for cleaner matching
      const cleanSearch = searchTerm.replace(/\b(for|of|the|a|an|my)\b\s*/g, "").replace(/\s+/g, " ").trim();
      const searchVariants = expandWithSynonyms(cleanSearch);
      // Simple stem: strip trailing s/ing/ed/tion for prefix matching
      const stem = (w: string) => w.replace(/(ing|tion|ed|s)$/i, "");

      // Fuzzy match: search in document name, type, and extracted data
      const scored = allDocs.map(d => {
        const nameLC = d.name.toLowerCase();
        const typeLC = (d.type || "").toLowerCase().replace(/_/g, " ");
        // Normalize: remove punctuation and collapse whitespace
        const nameNorm = nameLC.replace(/[''\-_–—]/g, " ").replace(/\s+/g, " ");
        const searchable = `${nameNorm} ${typeLC}`;
        let score = 0;
        // Check each search variant (original + synonym-expanded)
        for (const variant of searchVariants) {
          const vNorm = variant.replace(/[''\-_]/g, "").replace(/s\s/g, " ");
          if (searchable.includes(vNorm)) score += 10;
          // Check individual words — exact match or prefix/stem match
          const vWords = vNorm.split(/\s+/).filter(w => w.length >= 2);
          for (const w of vWords) {
            if (searchable.includes(w)) {
              score += 2;
            } else {
              // Stem match: "parking" → "park", "registration" → "registra" 
              const ws = stem(w);
              if (ws.length >= 3 && searchable.includes(ws)) score += 1.5;
            }
          }
        }
        // Also check extracted data values for profile-specific queries (e.g., "honda")
        const ed = d.extractedData || {};
        const edText = Object.values(ed).map(v => {
          const val = (v && typeof v === 'object' && 'value' in (v as any)) ? (v as any).value : v;
          return String(val).toLowerCase();
        }).join(" ");
        const cleanWords = cleanSearch.split(/\s+/).filter(w => w.length >= 2);
        for (const w of cleanWords) {
          if (edText.includes(w)) score += 1;
          else {
            const ws = stem(w);
            if (ws.length >= 3 && edText.includes(ws)) score += 0.5;
          }
        }
        return { doc: d, score };
      }).filter(s => s.score >= 4).sort((a, b) => b.score - a.score);
      const matches = scored.map(s => s.doc);

      // Check if the user asked for MULTIPLE documents (e.g., "open my registration, license, and birth certificate")
      // Split on commas / "and" to find multiple search terms
      const multiParts = cleanSearch.split(/\s*(?:,|\band\b)\s*/).filter(p => p.trim().length >= 2);
      if (multiParts.length > 1) {
        // Search each part separately against all docs
        const multiMatches: Array<{ doc: any; part: string }> = [];
        const usedIds = new Set<string>();
        for (const part of multiParts) {
          const partVariants = expandWithSynonyms(part.trim());
          const partScored = allDocs.filter(d => !usedIds.has(d.id)).map(d => {
            const nLC = d.name.toLowerCase();
            const tLC = (d.type || "").toLowerCase().replace(/_/g, " ");
            const nNorm = nLC.replace(/[''\-_\u2013\u2014]/g, " ").replace(/\s+/g, " ");
            const s = `${nNorm} ${tLC}`;
            let sc = 0;
            for (const v of partVariants) {
              const vn = v.replace(/[''\-_]/g, "");
              if (s.includes(vn)) sc += 10;
              for (const w of vn.split(/\s+/).filter(x => x.length >= 2)) {
                if (s.includes(w)) sc += 2;
                else { const ws = stem(w); if (ws.length >= 3 && s.includes(ws)) sc += 1.5; }
              }
            }
            return { doc: d, score: sc };
          }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score);
          if (partScored.length > 0) {
            multiMatches.push({ doc: partScored[0].doc, part: part.trim() });
            usedIds.add(partScored[0].doc.id);
          }
        }
        if (multiMatches.length > 1) {
          const names = multiMatches.map(m => m.doc.name);
          const previews = multiMatches.map(m => ({ id: m.doc.id, name: m.doc.name, mimeType: m.doc.mimeType, data: "__LAZY_LOAD__" }));
          return {
            reply: `Here are your ${multiMatches.length} documents: ${names.join(", ")}.`,
            actions: multiMatches.map(m => ({ type: "retrieve" as const, category: "ai" as const, data: { documentId: m.doc.id } })),
            results: multiMatches.map(m => ({ id: m.doc.id, name: m.doc.name, type: m.doc.type, mimeType: m.doc.mimeType })),
            documentPreview: previews[0],
            documentPreviews: previews,
          };
        }
      }

      // Single document match
      if (matches.length > 0) {
        const doc = matches[0];
        return {
          reply: `Here's your ${doc.name}.${matches.length > 1 ? ` (Found ${matches.length} matches — showing the first one.)` : ""}`,
          actions: [{ type: "retrieve" as const, category: "ai" as const, data: { documentId: doc.id } }],
          results: [{ id: doc.id, name: doc.name, type: doc.type, mimeType: doc.mimeType }],
          documentPreview: { id: doc.id, name: doc.name, mimeType: doc.mimeType, data: "__LAZY_LOAD__" },
        };
      }
      // No match found — fall through to AI to try harder
    } catch { /* fall through to AI */ }
  }

  // FAST-PATH: Quick logging (weight, BP, sleep, mood, run, expense)
  // These bypass the AI entirely for instant response times.
  try {
    const fp = await tryFastPath(userMessage);
    if (fp.matched) {
      return { reply: fp.reply, actions: fp.actions, results: fp.results };
    }
  } catch { /* fall through to AI */ }

  // ALWAYS invalidate cache at the start of every chat request so AI sees the CURRENT database state.
  // This ensures manual UI edits (creates, deletes, updates) are reflected immediately.
  invalidateContextCache(userId);
  const [profiles, trackers, tasks, expenses, events, habits, obligations, memories, documents, goals, journalEntries] = await getCachedContextData(userId) as [any[], any[], any[], any[], any[], any[], any[], any[], any[], any[], any[]];

  // Build COMPACT context — only summaries, no raw entry data (prevents token overflow)
  const context = [
    `Profiles (${profiles.length}): ${profiles.slice(0, 30).map(p => {
      const fields = p.fields || {};
      const keyFields = Object.entries(fields).filter(([k, v]) => v && !k.startsWith('_') && k !== 'notes').slice(0, 10).map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`).join(', ');
      const childCount = profiles.filter((c: any) => c.fields?._parentProfileId === p.id).length;
      return `${p.name} (${p.type}, id:${p.id.slice(0,8)}${keyFields ? `, ${keyFields}` : ''}${childCount > 0 ? `, ${childCount} sub-profiles` : ''})`;
    }).join("; ") || "none"}`,
    `Trackers (${trackers.length}): ${trackers.slice(0, 25).map(t => {
      const last = t.entries[t.entries.length - 1];
      const ownerNames = (t.linkedProfiles || []).map((pid: string) => profiles.find((p: any) => p.id === pid)?.name || pid.slice(0,8)).join(",");
      return `${t.name} (${t.category}, owner:${ownerNames || "unlinked"}, ${t.entries.length} entries${last ? `, latest: ${JSON.stringify(last.values).slice(0,60)}` : ""})`;
    }).join("; ") || "none"}`,
    `Active Tasks: ${tasks.filter(t => t.status !== "done").slice(0, 15).map(t => `${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ""}`).join("; ") || "none"}`,
    `Recent Expenses (last 10): ${expenses.slice(-10).map(e => `$${e.amount} - ${e.description} (${e.date?.slice(0,10)})`).join("; ") || "none"}`,
    `Upcoming Events (next 10): ${events.filter(e => new Date(e.date) >= new Date()).slice(0, 10).map(e => `${e.title} on ${e.date}`).join("; ") || "none"}`,
    `Habits (${habits.length}): ${habits.slice(0, 20).map(h => {
      const hOwner = (h.linkedProfiles || []).map((pid: string) => profiles.find((p: any) => p.id === pid)?.name || pid.slice(0,8)).join(",");
      return `${h.name} (${h.frequency}, ${h.currentStreak}d streak, owner:${hOwner || "unlinked"})`;
    }).join("; ") || "none"}`,
    `Obligations (${obligations.length}): ${obligations.filter((o: any) => o.status !== "cancelled").slice(0, 20).map(o => `${o.name}: $${o.amount}/${o.frequency}`).join("; ") || "none"}`,
    // Assets & vehicles with full field data
    (() => {
      const assetProfiles = profiles.filter((p: any) => ['vehicle', 'asset', 'investment', 'property'].includes(p.type));
      if (assetProfiles.length === 0) return '';
      return `Assets & Vehicles (${assetProfiles.length}): ${assetProfiles.slice(0, 20).map(a => {
        const f = a.fields || {};
        const details = Object.entries(f).filter(([k, v]) => v && !k.startsWith('_')).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(', ');
        return `${a.name} (${a.type}) {${details}}`;
      }).join('; ')}`;
    })(),
    // Subscriptions with full field data
    (() => {
      const subProfiles = profiles.filter((p: any) => p.type === 'subscription');
      if (subProfiles.length === 0) return '';
      return `Subscriptions (${subProfiles.length}): ${subProfiles.slice(0, 20).map(s => {
        const f = s.fields || {};
        const details = Object.entries(f).filter(([k, v]) => v && !k.startsWith('_')).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(', ');
        return `${s.name} {${details}}`;
      }).join('; ')}`;
    })(),
    `Memories: ${memories.slice(0, 25).map(m => `${m.key}: ${String(m.value).slice(0,50)}`).join("; ") || "none"}`,
    `Documents (${documents.length}): ${documents.slice(0, 25).map(d => {
      const ed = d.extractedData || {};
      // Include ALL extracted fields without truncation for accurate answers
      const allFields = Object.entries(ed).filter(([k]) => k !== 'rawText' && !k.startsWith('_')).map(([k, v]) => {
        const val = (v && typeof v === 'object' && 'value' in (v as any)) ? (v as any).value : v;
        return `${k}: ${String(val)}`;
      }).join(', ');
      const linkedNames = (d.linkedProfiles || []).map((pid: string) => profiles.find((p: any) => p.id === pid)?.name).filter(Boolean).join(',');
      return `"${d.name}" (${d.type}${linkedNames ? `, owner:${linkedNames}` : ''})${allFields ? ` {${allFields}}` : ''}`;
    }).join("; ") || "none"}`,
    `Goals: ${goals.filter(g => g.status === "active").slice(0, 15).map(g => `${g.title} (${g.current}/${g.target} ${g.unit})`).join("; ") || "none"}`,
    // Journal entries intentionally EXCLUDED from context — the journal_entry tool handles all checks.
    // Including them caused the AI to hallucinate that profiles "already have entries" based on content similarity.
    // Financial intelligence — net worth and burn rate for AI diagnostics
    (() => {
      const selfProf = profiles.find((p: any) => p.type === "self");
      if (!selfProf) return "";
      const children = profiles.filter((p: any) => p.fields?._parentProfileId === selfProf.id);
      const assetTypes = ["vehicle","property","investment","asset","account","banking"];
      const totalAssets = children.filter((c: any) => assetTypes.includes(c.type))
        .reduce((s, c) => s + Number(c.fields?.currentValue || c.fields?.value || c.fields?.purchasePrice || c.fields?.balance || 0), 0);
      const totalLiabs = children.filter((c: any) => c.type === "loan" || c.fields?.loanBalance)
        .reduce((s, c) => s + Number(c.fields?.remainingBalance || c.fields?.loanBalance || 0), 0);
      const monthlySubs = obligations.filter((o: any) => o.status !== "cancelled")
        .reduce((s, o) => {
          const amt = Number(o.amount || 0);
          const f = (o.frequency || "").toLowerCase();
          if (f === "weekly") return s + amt * 4.33;
          if (f === "annual" || f === "yearly") return s + amt / 12;
          return s + amt;
        }, 0);
      const thisMonthSpend = expenses.filter(e => e.date?.startsWith(new Date().toISOString().slice(0,7)))
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      return `Financial Snapshot: Net Worth ~$${(totalAssets - totalLiabs).toLocaleString()}, Assets $${totalAssets.toLocaleString()}, Liabilities $${totalLiabs.toLocaleString()}, Monthly subscriptions $${Math.round(monthlySubs)}/mo, This month's spending $${Math.round(thisMonthSpend)}`;
    })(),
    // Medication trackers — special category for the AI to reference
    (() => {
      const medTrackers = trackers.filter((t: any) => t.category === "medication" || t.name.toLowerCase().includes("medication") || t.name.toLowerCase().includes("prescri"));
      if (medTrackers.length === 0) return "";
      return `Medications (${medTrackers.length}): ${medTrackers.map((t: any) => {
        const latest = t.entries[t.entries.length - 1];
        return `${t.name}${latest ? ` (last taken: ${latest.timestamp?.slice(0,10)}, dosage: ${JSON.stringify(latest.values).slice(0,60)})` : " (no entries yet)"}`;
      }).join("; ")}`;
    })(),
  ].filter(Boolean).join("\n");

  const systemPrompt = buildSystemPrompt(context);

  // Read user's preferred chat model from preferences
  let preferredModel: string | null = null;
  try {
    preferredModel = await storage.getPreference("ai_chat_model");
  } catch { /* ignore — use default */ }
  const chatModel = preferredModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

  try {
    // Build the tool_use conversation loop — prepend up to 5 history pairs for multi-step context
    let messages: Anthropic.Messages.MessageParam[] = [];
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-6); // last 6 messages (3 pairs) to control token usage
      for (const msg of recent) {
        // Truncate long messages to avoid blowing up the context window
        const content = msg.content.length > 1500 ? msg.content.slice(0, 1500) + "\n[...truncated]" : msg.content;
        messages.push({ role: msg.role, content });
      }
    }
    messages.push({ role: "user", content: userMessage });
    const allActions: ParsedAction[] = [];
    const allResults: any[] = [];
    const richCharts: ChartSpec[] = [];
    const richTables: TableSpec[] = [];
    let richReport: ReportSpec | undefined;
    let textReply = "";
    let documentPreview: { id: string; name: string; mimeType: string; data: string } | undefined;
    const documentPreviews: Array<{ id: string; name: string; mimeType: string; data: string }> = [];
    let iterations = 0;
    let totalToolCalls = 0;
    const MAX_ITERATIONS = 15; // Each iteration is a full AI round-trip; increased to handle 10+ action messages
    const MAX_TOOL_CALLS = 30; // Safety limit on total tool executions per message

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Retry on overloaded/rate-limit errors
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await getClient().messages.create({
            model: chatModel,
            max_tokens: 4096,
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

      // Track creates within this response to deduplicate
      const seenCreates = new Set<string>();

      // Execute each tool call and collect results
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        // Safety limit: stop executing tools if we've hit the per-message cap
        if (totalToolCalls >= MAX_TOOL_CALLS) {
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify({ error: "Tool call limit reached for this message. Please send a new message for additional actions." }), is_error: true });
          continue;
        }
        totalToolCalls++;

        // Dedup: skip duplicate create calls for the same entity within this response
        const inp = toolUse.input as Record<string, any>;
        const createToolNames = ["create_obligation", "create_expense", "create_event", "create_task", "create_profile"];
        if (createToolNames.includes(toolUse.name)) {
          const key = `${toolUse.name}:${(inp.name || inp.title || inp.description || "").toLowerCase().trim()}`;
          if (seenCreates.has(key)) {
            logger.info("ai", `Deduped tool call: ${key}`);
            toolResults.push({ type: "tool_result" as const, tool_use_id: toolUse.id, content: JSON.stringify({ skipped: true, reason: "duplicate call" }) });
            continue;
          }
          seenCreates.add(key);
        }
        try {
          // Validate input before executing
          const validation = validateToolInput(toolUse.name, toolUse.input as Record<string, any>);
          if (!validation.valid) {
            logger.warn("ai", `Validation failed for ${toolUse.name}: ${validation.errors.join(", ")}`);
            const errorResult = { error: `Validation failed: ${validation.errors.join(". ")}`, validationErrors: validation.errors };
            toolResults.push({ type: "tool_result" as const, tool_use_id: toolUse.id, content: JSON.stringify(errorResult), is_error: true });
            // Don't push to allActions for validation failures — nothing was actually done
            continue;
          }
          if (validation.warnings.length > 0) {
            logger.info("ai", `Validation warnings for ${toolUse.name}: ${validation.warnings.join(", ")}`);
          }
          const result = await executeTool(toolUse.name, validation.normalized);
          
          // Invalidate context cache after any write operation
          const readOnlyToolNames = ["search", "get_summary", "get_profile_data", "recall_memory", "recall_actions", "get_goal_progress", "get_related", "navigate", "open_document", "retrieve_document"];
          if (!readOnlyToolNames.includes(toolUse.name)) {
            invalidateContextCache(userId);
          }

          // Map tool name to a ParsedAction type for backwards compat
          const actionType = mapToolToActionType(toolUse.name);
          const inp = toolUse.input as Record<string, any>;
          const entityId = result?.id || result?.task?.id || result?.expense?.id || result?.habit?.id || result?.obligation?.id;
          // Only count as a real action if it succeeded (no error field)
          if (result && !result.error) {
            allActions.push({ type: actionType, category: "ai", data: { ...inp, _entityId: entityId || undefined } });
            allResults.push(result);
          }
          if (validation.warnings.length > 0 && result) {
            result._validationWarnings = validation.warnings;
          }

          // Log the action to in-memory history
          const entityName = inp.name || inp.title || inp.description || inp.key || inp.query || inp.trackerName || toolUse.name;
          const readOnlyTools = ["search", "get_summary", "get_profile_data", "recall_memory", "recall_actions", "get_goal_progress", "get_related", "navigate", "open_document", "retrieve_document"];
          if (!readOnlyTools.includes(toolUse.name) && result && !result.error) {
            logAction(toolUse.name, actionType, String(entityName), entityId, userId);
          }

          // Handle document previews
          if (toolUse.name === "open_document" && result?.fileData) {
            const preview = { id: result.id, name: result.name, mimeType: result.mimeType, data: result.fileData };
            if (!documentPreview) documentPreview = preview;
            documentPreviews.push(preview);
          }

          // Collect visual output
          if (toolUse.name === "generate_chart" && result?.chart && !result.error) richCharts.push(result.chart as ChartSpec);
          if (toolUse.name === "generate_table" && result?.table && !result.error) richTables.push(result.table as TableSpec);
          if (toolUse.name === "generate_report" && result?.report && !result.error) richReport = result.report as ReportSpec;

          // Handle retrieve_document — attach document preview
          if (toolUse.name === "retrieve_document" && result?.documentPreview) {
            const preview = { id: result.documentPreview.id, name: result.documentPreview.name, mimeType: result.documentPreview.mimeType, data: result.documentPreview.data };
            documentPreviews.push(preview);
            if (!documentPreview) documentPreview = preview;
          }

          // If result is null/undefined OR contains an error field, report failure to AI so it doesn't claim success
          const isSuccess = result !== null && result !== undefined && !result.error;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(isSuccess ? summarizeResult(result) : (result?.error ? { error: result.error } : { error: "Action failed — data was not saved. Tell the user it didn't work." })),
            is_error: !isSuccess,
          });
        } catch (err: any) {
          console.error(`Tool ${toolUse.name} failed:`, err.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
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

    // SAFETY NET: If document previews are attached, the image viewer will show the doc.
    // Strip any verbose field-listing from the AI reply — user wants to SEE the doc, not read text.
    if (documentPreviews.length > 0 && textReply) {
      // If the reply has bullet-point field listings (• field: value), replace with a brief message
      const bulletCount = (textReply.match(/[•\-\*]\s+\w+.*:/g) || []).length;
      if (bulletCount >= 3) {
        // AI listed 3+ fields as bullets — replace with brief message
        const docName = documentPreviews[0].name;
        textReply = `Here's your "${docName}".`;
      }
    }

    // CHART SAFETY NET: If the user explicitly asked for a chart/visualization but the AI
    // described it instead of calling generate_chart, force-generate the chart now.
    // Skip the safety net if the AI already indicated there's no data — don't generate an empty/zero chart.
    const replyLower = textReply.toLowerCase();
    const aiSaysNoData = /don't have any|no .* entries|no .* data|no .* found|haven't logged|no .* recorded|no .* tracked|no tracked|not .* any .* data|not .* any .* entries|you haven't/.test(replyLower);
    if (richCharts.length === 0 && !richReport && !aiSaysNoData) {
      const msgLower = userMessage.toLowerCase();
      const wantsPie = /pie chart|spending.*chart|chart.*spending|breakdown.*chart|spending breakdown/.test(msgLower);
      const wantsLine = /trend|over time|history|line chart|weight.*chart|chart.*weight/.test(msgLower);
      const wantsBar = /bar chart|compare|comparison|vs\.?\s/.test(msgLower);
      const wantsChart = wantsPie || wantsLine || wantsBar || /\b(chart|graph|visualize|visualization|plot)\b/.test(msgLower);
      const wantsReport = /\b(report|scorecard|digest|overview|summary)\b/.test(msgLower);
      const wantsTable = /\b(table|list all|show all|all my)\b/.test(msgLower);

      if (wantsChart) {
        try {
          let chartInput: Record<string, any>;
          if (wantsPie || /spend|expense|money|budget|cost|financ/.test(msgLower)) {
            chartInput = { chartType: "pie", title: "Spending Breakdown", dataSource: "expenses" };
          } else if (/weight|mass|body/.test(msgLower)) {
            chartInput = { chartType: "line", title: "Weight Trend", dataSource: "trackers", trackerName: "weight" };
          } else if (/habit/.test(msgLower)) {
            chartInput = { chartType: "bar", title: "Habit Streaks", dataSource: "habits" };
          } else if (/goal/.test(msgLower)) {
            chartInput = { chartType: "radar", title: "Goal Progress", dataSource: "goals" };
          } else {
            // Generic expense chart fallback
            chartInput = { chartType: wantsPie ? "pie" : wantsLine ? "line" : "bar", title: "Data Overview", dataSource: "expenses" };
          }
          const chart = await buildChartSpec(chartInput);
          // Don't push charts with empty data or all-zero values
          if (chart.data && chart.data.length > 0) {
            const dataKeys = chart.series.map(s => s.dataKey);
            const hasRealData = chart.data.some(row => dataKeys.some(k => typeof row[k] === "number" && row[k] !== 0));
            if (hasRealData) {
              richCharts.push(chart);
              logger.info("ai", `[chart-fallback] Auto-generated ${chart.type} chart for "${userMessage.slice(0,40)}"`);
            } else {
              logger.info("ai", `[chart-fallback] Skipped chart with all-zero data for "${userMessage.slice(0,40)}"`);
            }
          }
        } catch (e: any) {
          logger.warn("ai", `[chart-fallback] Could not generate chart: ${e.message}`);
        }
      } else if (wantsReport) {
        try {
          let reportType = "financial";
          if (/life|score|balance/.test(msgLower)) reportType = "life_scorecard";
          else if (/health|medical|fitness/.test(msgLower)) reportType = "health";
          else if (/week/.test(msgLower)) reportType = "weekly_digest";
          else if (/goal/.test(msgLower)) reportType = "goal_progress";
          richReport = await buildReportSpec({ reportType });
          logger.info("ai", `[report-fallback] Auto-generated ${reportType} report`);
        } catch (e: any) {
          logger.warn("ai", `[report-fallback] Could not generate report: ${e.message}`);
        }
      } else if (wantsTable) {
        try {
          let ds = "expenses";
          if (/task/.test(msgLower)) ds = "tasks";
          else if (/habit/.test(msgLower)) ds = "habits";
          else if (/goal/.test(msgLower)) ds = "goals";
          else if (/bill|obligat/.test(msgLower)) ds = "obligations";
          const table = await buildTableSpec({ title: `Your ${ds}`, dataSource: ds, columns: [] });
          richTables.push(table);
          logger.info("ai", `[table-fallback] Auto-generated ${ds} table`);
        } catch (e: any) {
          logger.warn("ai", `[table-fallback] Could not generate table: ${e.message}`);
        }
      }
    }

    return {
      reply: textReply || "I'm not sure how to help with that. Try asking me to track something, create a task, log an expense, or manage your data.",
      actions: allActions,
      results: allResults,
      documentPreview,
      documentPreviews: documentPreviews.length > 0 ? documentPreviews : undefined,
      charts: richCharts.length > 0 ? richCharts : undefined,
      tables: richTables.length > 0 ? richTables : undefined,
      report: richReport,
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
    complete_task: "complete_task",
    delete_task: "delete_task",
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
    uncomplete_habit: "checkin_habit",
    complete_event: "complete_event",
    delete_tracker_entry: "log_entry",
    update_tracker_entry: "log_entry",
    retrieve_document: "retrieve",
    generate_chart: "retrieve",
    generate_table: "retrieve",
    generate_report: "retrieve",
  };
  return mapping[toolName] || "retrieve";
}

// Fallback rule-based parsing when AI is unavailable
async function fallbackParse(message: string): Promise<{ reply: string; actions: ParsedAction[]; results: any[]; documentPreview?: { id: string; name: string; mimeType: string; data: string } }> {
  const lower = message.toLowerCase();
  const actions: ParsedAction[] = [];
  const results: any[] = [];
  let reply = "";

  // Document retrieval — works even when AI is completely down
  if (lower.match(/^(?:open|show|view|pull up|find|get)\s+(?:my\s+)?(.+)/)) {
    const searchTerm = lower.replace(/^(?:open|show|view|pull up|find|get)\s+(?:my\s+)?/, "").trim();
    try {
      const allDocs = await storage.getDocuments();
      const normalized = searchTerm.replace(/[''\-_]/g, "").replace(/s\s/g, " ");
      const matches = allDocs.filter(d => {
        const nameNorm = d.name.toLowerCase().replace(/[''\-_]/g, "").replace(/s\s/g, " ");
        return nameNorm.includes(normalized) || normalized.includes(nameNorm) || d.name.toLowerCase().includes(searchTerm);
      });
      if (matches.length > 0) {
        // Fetch full document with fileData for the actual preview
        const fullDoc = await storage.getDocument(matches[0].id);
        if (fullDoc) {
          return {
            reply: `Here's your ${fullDoc.name}.`,
            actions: [{ type: "retrieve" as const, category: "ai" as const, data: { documentId: fullDoc.id } }],
            results: [{ id: fullDoc.id, name: fullDoc.name, type: fullDoc.type }],
            documentPreview: fullDoc.fileData ? { id: fullDoc.id, name: fullDoc.name, mimeType: fullDoc.mimeType, data: fullDoc.fileData } : undefined,
          };
        }
      }
    } catch { /* continue to other handlers */ }
  }

  // Quick mood logging
  const moodMatch = lower.match(/^(?:mood|feeling|i feel|i'm feeling)\s+(amazing|great|good|okay|neutral|bad|awful|terrible)/);
  if (moodMatch) {
    try {
      const mood = moodMatch[1] as any;
      const entry = await storage.createJournalEntry({ mood, content: "", tags: [] });
      return { reply: `Logged mood: ${mood}`, actions: [{ type: "journal_entry" as const, category: "journal" as const, data: { mood } }], results: [entry] };
    } catch { /* continue */ }
  }

  if (lower.startsWith("track ") || lower.startsWith("create tracker ")) {
    const name = message.replace(/^(track|create tracker)\s+/i, "").replace(/^my\s+/i, "");
    // Dedup: check for existing tracker with same name
    const allTrackers = await storage.getTrackers();
    const dupTracker = allTrackers.find(t => t.name.toLowerCase() === name.toLowerCase());
    const tracker = dupTracker || await storage.createTracker({ name, category: "custom", fields: [{ name: "value", type: "number" }] });
    actions.push({ type: "create_tracker", category: "custom", data: { name, _entityId: tracker.id } });
    results.push(tracker);
    reply = dupTracker
      ? `Found existing tracker "${tracker.name}". You can log entries to it.`
      : `Created a new tracker for "${name}". You can now log entries to it.`;
  } else if (lower.includes("spent") || lower.includes("bought") || lower.match(/\$\d+/)) {
    const amountMatch = message.match(/\$?([\d.]+)/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    const desc = message.replace(/\$[\d.]+/, "").replace(/spent|bought|on/gi, "").trim();
    if (amount > 0) {
      const expense = await storage.createExpense({ amount, category: "general", description: desc || "Expense", tags: [], source: "chat" } as any);
      // Auto-link to self profile so it shows in Finance tab
      await autoLinkToProfiles("expense", expense.id, desc || "Expense");
      actions.push({ type: "log_expense", category: "finance", data: { amount, description: desc, _entityId: expense.id } });
      results.push(expense);
      reply = `Logged expense: $${amount} — ${desc || "Expense"}`;
    }
  } else if (lower.startsWith("remind") || lower.startsWith("todo") || lower.startsWith("task")) {
    const title = message.replace(/^(remind me to|remind|todo|task)\s*/i, "").trim();
    const task = await storage.createTask({ title, priority: "medium", tags: [], source: "chat" } as any);
    // Auto-link to self profile so it shows in Tasks tab
    await autoLinkToProfiles("task", task.id, title);
    actions.push({ type: "create_task", category: "task", data: { title, _entityId: task.id } });
    results.push(task);
    reply = `Created task: "${title}"`;
  } else {
    // Try to handle as AI message — don't show offline mode
    reply = `I couldn't process that right now — the AI is temporarily unavailable. Try simple commands like:\n• "weight 183" • "bp 120/80" • "$50 groceries"\n• "mood good" • "remind me to call mom"\n• "open my drivers license"\nOr refresh and try again.`;
  }

  return { reply, actions, results };
}
