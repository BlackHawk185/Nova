
# Copilot instructions for Nova (AI secretary)

Purpose: give AI codin- Gmail delete prefers moving to `[Gmail]/Trash` with fallbacks (see `email.js`).
- No Upstash? History/scheduler use in-memory; don't rely on persistence.ents the essential context to be productive in this repo quickly.

## Architecture Overview

Nova is built with a **two-layer architecture**:

1. **Logic Layer** (code): Handles all deterministic operations—IMAP/SMTP, polling, memory, scheduling, and effectful actions. This is implemented in code (e.g., `email.js`, `action-executor.js`).
2. **Reasoning Layer** (LLM): Handles all decision-making, reasoning, and user-facing communication. This is implemented via LLM calls (e.g., `nova-brain.js` with prompts from `prompt.js`).

## Reasoning Layer: Dual Action Sets

Every LLM cycle must produce **at least one response** (either a direct message to the user, or a scheduled reminder to itself for follow-up). Optionally, it can also produce a **task** (an action to execute, such as deleting or marking an email).

- **Response Set** (required):
  - Send a message to the user (e.g., reply, notify, acknowledge)
  - Or, schedule a reminder to itself for future reconsideration (e.g., "remind me to check this later")
- **Task Set** (optional):
  - Actions like delete_email, mark_spam, move_email, etc.
  - These are only allowed in certain contexts (see below)

**Context-based restrictions:**
- Some actions are only allowed in specific contexts (e.g., Nova cannot delete or reply to personal emails without explicit user consent; she may only mark as spam, notify the user, or schedule a reminder for herself).
- The LLM must always decide on a response (message or reminder), even if no task/action is allowed.

## Pipeline Flow
- Inbound event (HTTP/SMS/WhatsApp/email) →
  - Logic layer loads context, history, and memories
  - Reasoning layer (LLM) receives structured prompt and returns JSON with:
    - `response`: user-facing reply or reminder (required)
    - `action`: task to execute (optional, context-dependent)
    - `memory`: memory operations (optional)
  - Logic layer applies memory ops, appends conversation, executes action if allowed, and delivers response/reminder

## Boundaries
- `nova-brain.js`: calls OpenAI with prompts from `prompt.js`; outputs strict JSON with `{ action, response, memory }` (response is always required, action is optional)
- `action-executor.js`: performs side-effects (IMAP/SMTP email ops, scheduling, Mem0 tasks)
- `email.js`: IMAP/SMTP (multi-account) + polling/search helpers. Env-driven `EMAIL[_2|_3|_4]_*` config
- `memory.js`: Mem0-based semantic memory. Can be disabled if no key
- `conversation-history.js`: short rolling history in Upstash Redis (in-memory fallback)
- `scheduling.js`: wakeups saved in Redis ZSET; calls back into Nova to run follow-ups

## Request → Reasoning → Action
- `index.js` defines `runNovaPipeline({ userInput, channel, actionContext, metadata })`:
  1) Load recent conversation history
  2) `nova-brain.generateMemoryQueries` → search Mem0 via `memory.searchMemories` → `memory.curateMemories`
  3) `nova-brain.respond` with input + memories + context; JSON normalized and action filtered by context
  4) Apply memory deltas (add/update/delete) and append conversation
  5) Execute action via `ActionExecutor.executeAction` and optionally notify owner


## Conventions and patterns
- LLM response must be valid JSON per `prompt.js`; `nova-brain.normalizeResult` enforces required/allowed fields and context-based restrictions. Set `NOVA_DEBUG=1` to log full prompt.
- Every LLM cycle must produce a `response` (message to user or reminder to self). `action` is optional and context-restricted.
- Email actions target IMAP sequence numbers. Resolve via `email.searchEmailsForSeqno(account, { subject|sender|content }, limit)` then operate (mark/move/delete/etc.).
- Conversation history length is 6 entries by design—keep prompts lean.
- Memory ops: the model proposes deltas; `index.js` applies with `memory.add/update/delete`.

## Environment and secrets
- Key env: OPENAI_API_KEY, OPENAI_MODEL (opt), NOVA_DEBUG (opt), MEM0_API_KEY or MEM0_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, MY_NUMBER, EMAIL_* (per-account), GOOGLE_OAUTH_* (for `google-oauth.js`), PORT.
- Missing creds degrade gracefully (warnings); features become no-ops where possible.

## Dev workflows
- Run: `npm start` (or `npm run dev`). Quick test: `GET /test/hello%20world`.
- Email OAuth helper: run `setup-oauth.js` to obtain a refresh token for Google accounts; `routes.js` also exposes `/auth/google` and `/auth/google/callback`.
- Public webhooks: `start-nova.bat` launches the server and a localtunnel (Windows).

## Adding/changing actions
- Add action: extend allowed sets in `nova-brain.js` → implement handler + register in `action-executor.js` → update `prompt.js` templates.
- For email features: prefer search-to-seqno via `email.searchEmailsForSeqno` before acting.

## Gotchas
- Gmail delete prefers moving to `[Gmail]/Trash` with fallbacks (see `email.js`).
- No Upstash? History/scheduler use in-memory; don’t rely on persistence.
- No Twilio? SMS/WhatsApp are logged only—owner notifications won’t deliver.
- `routes.js` rejects messages not from `MY_NUMBER`.


Key files: `index.js` (pipeline), `prompt.js` (LLM contracts), `nova-brain.js` (LLM I/O), `action-executor.js` (effects), `email.js` (IMAP/SMTP), `memory.js` (Mem0), `conversation-history.js` (Redis history), `scheduling.js` (wakeups), `routes.js` (HTTP ingress).