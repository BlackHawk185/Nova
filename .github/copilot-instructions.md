# Copilot instructions for Nova (AI secretary)

Purpose: give AI coding agents the essential context to be productive in this repo quickly.

## Big picture
- Node.js ESM app ("type": "module"). Entry: `index.js`; server via Express on `PORT` (3000 by default).
- Flow: inbound event (HTTP/SMS/WhatsApp/email) → LLM reasoning (`nova-brain.js`) → action execution (`action-executor.js`) → memory + conversation updates.
- Boundaries:
  - `nova-brain.js`: calls OpenAI with prompts from `prompt.js`; outputs strict JSON with { action, message, memory }.
  - `action-executor.js`: performs side-effects (Twilio WhatsApp/SMS, IMAP/SMTP email ops, scheduling, Mem0 tasks).
  - `email.js`: IMAP/SMTP (multi-account) + polling/search helpers. Env-driven `EMAIL[_2|_3|_4]_*` config.
  - `memory.js`: Mem0-based semantic memory. Can be disabled if no key.
  - `conversation-history.js`: short rolling history in Upstash Redis (in-memory fallback).
  - `scheduling.js`: wakeups saved in Redis ZSET; calls back into Nova to run follow-ups.

## Request → decision → action
- `index.js` defines `runNovaPipeline({ userInput, channel, actionContext, metadata })`:
  1) Load recent conversation history.
  2) `nova-brain.generateMemoryQueries` → search Mem0 via `memory.searchMemories` → `memory.curateMemories`.
  3) `nova-brain.respond` with input + memories + context; JSON normalized and action filtered by context.
  4) Apply memory deltas (add/update/delete) and append conversation.
  5) Execute action via `ActionExecutor.executeAction` and optionally notify owner.

## Conventions and patterns
- LLM response must be valid JSON per `prompt.js`; `nova-brain.normalizeResult` enforces defaults and allowed actions (context: general/email/error). Set `NOVA_DEBUG=1` to log full prompt.
- Phone number checks: `routes.js` compares incoming `From` (without `whatsapp:`) to `MY_NUMBER`. Twilio sends use `whatsapp:${number}`.
- Email actions target IMAP sequence numbers. Resolve via `email.searchEmailsForSeqno(account, { subject|sender|content }, limit)` then operate (mark/move/delete/etc.).
- Conversation history length is 6 entries by design—keep prompts lean.
- Memory ops: the model proposes deltas; `index.js` applies with `memory.add/update/delete`.

## Environment and secrets
- Key env: OPENAI_API_KEY, OPENAI_MODEL (opt), NOVA_DEBUG (opt), MEM0_API_KEY or MEM0_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, MY_NUMBER, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (or TWILIO_NUMBER), EMAIL_* (per-account), GOOGLE_OAUTH_* (for `google-oauth.js`), PORT.
- Missing creds degrade gracefully (warnings); features become no-ops where possible.

## Dev workflows
- Run: `npm start` (or `npm run dev`). Health: `GET /health`. Quick test w/o Twilio: `GET /test/hello%20world`.
- Email OAuth helper: run `setup-oauth.js` to obtain a refresh token for Google accounts; `routes.js` also exposes `/auth/google` and `/auth/google/callback`.
- Public webhooks: `start-nova.bat` launches the server and a localtunnel (Windows).
- Twilio webhooks: point SMS → `POST /sms`, WhatsApp → `POST /whatsapp`.

## Adding/changing actions
- Add action: extend allowed sets in `nova-brain.js` → implement handler + register in `action-executor.js` → update `prompt.js` templates.
- For email features: prefer search-to-seqno via `email.searchEmailsForSeqno` before acting.

## Gotchas
- Gmail delete prefers moving to `[Gmail]/Trash` with fallbacks (see `email.js`).
- No Upstash? History/scheduler use in-memory; don’t rely on persistence.
- No Twilio? SMS/WhatsApp are logged only—owner notifications won’t deliver.
- `routes.js` rejects messages not from `MY_NUMBER`.

Key files: `index.js` (pipeline), `prompt.js` (LLM contracts), `nova-brain.js` (LLM I/O), `action-executor.js` (effects), `email.js` (IMAP/SMTP), `memory.js` (Mem0), `conversation-history.js` (Redis history), `scheduling.js` (wakeups), `routes.js` (HTTP ingress).