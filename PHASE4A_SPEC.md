# Phase 4A: Smart AI Chat — Anthropic tool_use Upgrade

## Objective
Rewrite `server/ai-engine.ts` to use Anthropic's native `tool_use` (function calling) instead of asking Claude to output JSON that we then parse. This makes the AI chat dramatically more reliable and capable.

## Architecture

### Keep
- **Fast-path regex** (lines 18-201) — keep ALL of these for instant responses. They bypass the AI entirely.
- **processFileUpload** function — no changes needed.
- **Return format** — `processMessage()` must continue returning `{ reply, actions, results, documentPreview?, documentPreviews? }` exactly as it does now.
- The `executeAction()` function stays mostly the same — it's the execution layer.

### Replace
- The `SYSTEM_PROMPT` and the `processMessage()` AI call (lines 407-574). Instead of asking Claude to return a JSON `{ message, actions }` object, we use Anthropic's `tool_use` feature where Claude calls functions directly.

## How tool_use Works

```typescript
const response = await client.messages.create({
  model: "claude_sonnet_4_6",
  max_tokens: 1024,
  system: SYSTEM_PROMPT, // simplified — no JSON format instructions needed
  tools: TOOL_DEFINITIONS, // array of tool definitions
  messages: [{ role: "user", content: userMessage }],
});

// Response contains content blocks:
// - type: "text" → the AI's conversational reply
// - type: "tool_use" → a tool call with { id, name, input }
```

## Tool Definitions

Define these as Anthropic tool schemas (JSON Schema for input):

### Data Query Tools
1. **search** — `{ query: string }` — Search across all entities
2. **get_summary** — `{ entity_type: "profiles"|"trackers"|"tasks"|"expenses"|"events"|"habits"|"obligations"|"journal"|"documents"|"all", time_range?: "today"|"week"|"month"|"all" }` — Get summary/stats
3. **recall_memory** — `{ query: string }` — Recall saved facts

### CRUD Tools
4. **create_profile** — `{ type, name, fields?, tags?, notes? }`
5. **update_profile** — `{ name: string, changes: object }` — Find by name, apply changes
6. **delete_profile** — `{ name: string }` — Find by name, delete
7. **create_task** — `{ title, priority?, dueDate?, tags? }`
8. **complete_task** — `{ title: string }` — Find by title, mark complete
9. **delete_task** — `{ title: string }`
10. **log_tracker_entry** — `{ trackerName: string, values: object }` — Log values to existing tracker
11. **create_tracker** — `{ name, category?, unit?, fields? }`
12. **create_expense** — `{ amount, description, category?, vendor?, tags? }`
13. **delete_expense** — `{ description: string }` — Find by description
14. **create_event** — `{ title, date, time?, endTime?, location?, description?, recurrence? }`
15. **update_event** — `{ title: string, changes: object }`
16. **create_habit** — `{ name, frequency?, icon?, color? }`
17. **checkin_habit** — `{ name: string }` — Check in to habit by name
18. **create_obligation** — `{ name, amount, frequency, nextDueDate?, category?, autopay? }`
19. **pay_obligation** — `{ name: string, amount?, method?, confirmationNumber? }`
20. **journal_entry** — `{ mood, content?, energy?, gratitude?, highlights? }`
21. **create_artifact** — `{ type: "checklist"|"note", title, content?, items? }`
22. **save_memory** — `{ key, value, category? }`
23. **open_document** — `{ query: string }` — Search and return document

### Navigation Tool
24. **navigate** — `{ page: "dashboard"|"chat"|"trackers"|"profiles"|"profile_detail", profileId? }` — Tell the UI to navigate

## Implementation Details

### System Prompt (Simplified)
The system prompt no longer needs JSON format instructions. It should:
- Describe the app ("You are LifeOS AI, the brain of a personal life OS")
- Include the existing data context (same format as now — profiles, trackers, etc.)
- Give personality/behavior guidelines ("Be concise, confirm what you did, handle multiple actions")
- Include the secondary data extraction rules (calorie estimates, BMI, BP classification, etc.)

### Processing Loop
When Claude returns tool_use blocks, we need to execute them in a loop:

```typescript
let messages = [{ role: "user", content: userMessage }];
let allActions = [];
let allResults = [];
let textReply = "";
let documentPreview, documentPreviews = [];

while (true) {
  const response = await client.messages.create({ ... messages, tools });
  
  // Extract text blocks for the reply
  for (const block of response.content) {
    if (block.type === "text") textReply += block.text;
  }
  
  // If no tool_use blocks, we're done
  const toolUses = response.content.filter(b => b.type === "tool_use");
  if (toolUses.length === 0 || response.stop_reason === "end_turn") break;
  
  // Execute each tool call
  const toolResults = [];
  for (const toolUse of toolUses) {
    const result = await executeTool(toolUse.name, toolUse.input);
    allActions.push({ type: toolUse.name, category: "ai", data: toolUse.input });
    if (result) allResults.push(result);
    
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
  }
  
  // Add assistant response + tool results to messages for next iteration
  messages.push({ role: "assistant", content: response.content });
  messages.push({ role: "user", content: toolResults });
  
  // Safety: max 5 iterations
  if (messages.length > 12) break;
}

return { reply: textReply, actions: allActions, results: allResults, documentPreview, documentPreviews };
```

### Tool Execution Function
Create a new `executeTool(name, input)` function that maps tool names to storage operations. It's similar to the existing `executeAction()` but uses the tool names and input format.

### Result Summarization
Don't send the entire result back to Claude (especially not document fileData). Create a `summarizeResult()` function that returns a concise summary:
- For profiles: `{ id, name, type, fieldCount }`
- For tracker entries: `{ trackerId, values, computed }`
- For documents: `{ id, name, type, extractedDataKeys }` (NOT the fileData)
- For tasks: `{ id, title, status }`
- etc.

## Files to Modify
- `server/ai-engine.ts` — MAJOR REWRITE of `processMessage()`, new tool definitions, new `executeTool()`, keep fast-path and `processFileUpload` unchanged.
- NO changes to routes.ts — the return format stays the same.
- NO changes to any frontend files — the API contract is preserved.

## Important Constraints
- `import Anthropic from "@anthropic-ai/sdk"` — already installed
- Model name: `"claude_sonnet_4_6"` (this is what works in this environment)
- Keep `max_tokens: 1024` for the main response
- The `storage` import stays the same
- MUST keep the fast-path regex — it's faster and free (no AI call)
- MUST keep `processFileUpload` — it handles vision/extraction for uploads
- The `fallbackParse` function should remain as a safety net if the AI call fails entirely
