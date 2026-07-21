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

## What does NOT route (by design)

The main agentic chat loop in `server/ai-engine.ts` stays on Claude. It is built on
Anthropic's native tool-use protocol (`tool_use` / `tool_result` blocks), which
does not map one-to-one onto OpenAI's or Gemini's tool formats. Migrating it is a
separate, larger project; the router is the reusable foundation for doing that
later.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables Claude. Already required app-wide. |
| `OPENAI_API_KEY` | Enables GPT. Get one at platform.openai.com/api-keys (starts with `sk-`). |
| `GEMINI_API_KEY` | Enables Gemini. Get one at aistudio.google.com/apikey (**starts with `AIza`**). |
| `AI_ROUTER_DISABLE=1` | Escape hatch — forces Claude-only, ignores the other keys. |
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
