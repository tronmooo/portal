# Multi-provider model routing

The app can pick the **best available model per task** across Anthropic (Claude),
OpenAI (GPT), and Google (Gemini). Providers are turned on purely by the presence
of their API key — add a key in Vercel and that provider comes online with no code
change or redeploy of logic.

## What routes today

Routing is wired into the **structured-decision layer** (`server/ai-decide.ts` →
`server/model-router.ts`). These are the cheap, fast, JSON-only calls the app makes
constantly — categorising an expense, picking the best-matching profile, ranking
candidates, etc. Every such call already validates the model's JSON and falls back
to a deterministic result, so routing to another provider degrades gracefully
instead of breaking.

## Chat: the hybrid front door

`server/chat-frontdoor.ts` sits in front of the main chat agent in
`processMessage`. A **deterministic classifier** (`needsAgent`) inspects each
message:

- **Mutation or personal-data intent** (log/add/update/delete, or any reference to
  the user's own tasks/expenses/net worth/documents/…) → stays on the **Claude
  tool-agent**, exactly as before. This is the reliability-critical path and never
  changes.
- **Self-contained conversational/advisory messages** (explain, advise, draft,
  brainstorm — needing neither stored data nor a mutation) → routed to the **best
  available provider** as a tool-free completion. By default this uses the **fast
  tier** (Gemini Flash → GPT-mini → Claude Haiku) so quick answers come back fast.
  Set `AI_FRONTDOOR_TIER=reasoning` to prefer the strongest model instead
  (Claude → GPT → Gemini).

The front door **fails over across providers**: it tries them in preference order
and, if the top pick errors (bad key, retired model id, timeout), moves to the next
one instead of giving up. Only if every provider fails does it fall through to the
Claude tool-agent. This means a single bad key (e.g. a Gemini value that isn't a real
`AIza…` key) no longer disables the feature — OpenAI/Claude still answer.

Every reply that goes through the front door carries a `meta` field in the JSON
response — `{"route":"frontdoor","model":"gemini:gemini-1.5-flash"}` — so the client
(or a probe) can see exactly which provider answered. Agent-path replies omit `meta`.

**Diagnostics:** POST `/api/chat` with `{ "message": "...", "debug": true }`. On a
conversational message the response's `meta.attempts` lists every provider tried and
the error that knocked each one out — the fastest way to tell whether a key is
invalid. The same detail is logged server-side as `[chat-trace] path="frontdoor-failed"`.

> ⚠️ **Why the front door is OFF by default.** A life-logging app expresses logging
> as open-ended natural language — "I ate a chicken sandwich and ran 2 miles", "had a
> coffee", "weighed 180". No keyword classifier can reliably tell these apart from
> questions, and a wrong guess sends a *log* to a tool-less model that cannot write it
> — silently dropping the user's data while replying as if it logged. That regression
> is why the front door now requires an explicit `AI_CHAT_FRONTDOOR=1` **and**
> `AI_ROUTER_ENABLE=1`. Leaving it off means every chat message goes to the Claude
> tool-agent, exactly as the app always worked.

Guarantees:

- **Default off.** Both `AI_ROUTER_ENABLE=1` and `AI_CHAT_FRONTDOOR=1` are required to
  divert anything. Otherwise the chat is 100% the Claude tool-agent.
- The classifier is biased **very broad toward the agent** — natural logging verbs
  ("ate", "ran", "had", "drank", "took", "slept", "weighed"), meal/activity nouns, and
  any first-person/`my` reference all route to the agent. A false positive just keeps a
  message on Claude; it never sends a data operation to a tool-less model.
- Any failure falls through to the Claude agent.
- The routed prompt forbids inventing the user's figures, so a model that can't see
  their data won't fabricate balances or entries.

The `[chat-trace]` log line records `path:"frontdoor"` and the model used, so you can
confirm in Vercel runtime logs which provider answered.

## What does NOT route (by design)

The main agentic **tool-use loop** in `server/ai-engine.ts` stays on Claude. It is
built on Anthropic's native tool-use protocol (`tool_use` / `tool_result` blocks),
which does not map one-to-one onto OpenAI's or Gemini's tool formats. Every CRUD
operation and every read of the user's data runs there. Migrating that loop to be
cross-provider is a separate, larger project; the router is the reusable foundation
for doing it later.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables Claude. Already required app-wide. |
| `AI_ROUTER_ENABLE=1` | **Master opt-in.** Without it, routing is Claude-only and the app behaves exactly as it did before routing existed — a bad or missing OpenAI/Gemini key can never change existing behaviour. |
| `OPENAI_API_KEY` | GPT key (needs `AI_ROUTER_ENABLE=1`). platform.openai.com/api-keys (starts with `sk-`). |
| `GEMINI_API_KEY` | Gemini key (needs `AI_ROUTER_ENABLE=1`). aistudio.google.com/apikey (**must start with `AIza`**). |
| `AI_CHAT_FRONTDOOR=1` | **Separately** opt into the chat front door (see below). Off by default. |
| `AI_ROUTER_DISABLE=1` | Hard kill — forces Claude-only regardless of the above. |
| `OPENAI_MODEL` / `OPENAI_MODEL_FAST` | Override GPT model ids (defaults `gpt-4o` / `gpt-4o-mini`). |
| `GEMINI_MODEL` / `GEMINI_MODEL_FAST` | Override Gemini model ids (defaults `gemini-1.5-pro` / `gemini-1.5-flash`). |

The model-id overrides exist so you can adopt a newer or renamed model without
touching code — just set the env var to the current id.

## Selection policy

Each decision is tagged with a `taskKind`. The router walks a preference list and
returns the first provider whose key is set; Claude is always in the list as the
guaranteed fallback.

| taskKind | Preference order | Rationale |
| --- | --- | --- |
| `reasoning` | Claude → GPT → Gemini | Strongest reasoning first; the app is Claude-native. |
| `fast` / `extract` | Gemini → GPT → Claude | Fastest, cheapest first for high-volume JSON. |

`ai-decide` defaults to `fast`. Pass `taskKind: "reasoning"` on a specific call to
send it to the strongest available model. Passing an explicit `model:` still forces
that exact Claude model (backward compatible with existing callers).

## Setting the keys in Vercel

Dashboard → your project → **Settings → Environment Variables** → add
`OPENAI_API_KEY` and `GEMINI_API_KEY` for the **Production** (and Preview) scope →
**Save** → redeploy so the running functions pick them up.

> Rotate any key that has ever been pasted into a chat, issue, or commit — treat it
> as compromised and generate a fresh one.
