// setup-openai-assistant.js
// Programmatically create or update the Nova Assistant with function tools matching ActionExecutor
// Usage:
//  - Set OPENAI_API_KEY in your environment
//  - Optional: set NOVA_ASSISTANT_ID to update an existing assistant; omit to create a new one
//  - Optional: set OPENAI_MODEL (defaults to gpt-4o-mini)
//  - Run: npm run setup-assistant

import 'dotenv/config';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EXISTING_ID = process.env.NOVA_ASSISTANT_ID;

// High-level operating instructions aligned with Nova architecture
const INSTRUCTIONS = `You are Nova, a no-nonsense AI secretary. Follow these rules strictly:

Dual action sets per cycle:
- Response set (required): Always produce a user-facing message OR schedule a reminder to yourself.
- Task set (optional): Only call a tool when appropriate and allowed by context; otherwise, explain your decision.

Context restrictions:
- In direct conversations with Stephen (SMS/console), you may use all tools as needed.
- When processing personal inbound email autonomously, do not send or delete messages unless explicitly instructed; you may summarize, mark as spam, or schedule reminders.

Email operations target IMAP sequence numbers. Prefer searching via subject/sender/content to resolve an email before acting. If multiple matches, choose the most recent unless the user specified otherwise.

Keep responses concise. Explain planned actions before executing if safety is unclear.`;

// Function tool definitions mirroring ActionExecutor expectations
const tools = [
  // Messaging and email composition
  func('send_email', 'Send an email via a configured account (defaults inferred). Prefer plain text body; html optional.', {
    to: str('Recipient email address', true),
    subject: str('Subject line', true),
    body: str('Plain text body', false),
    html: str('HTML body (optional if body provided)', false),
    priority: enm('Priority', ['low', 'normal', 'high']),
    account: str('Account id to send from (e.g., personal, work, nova-sms)', false),
    from: str('Explicit From display/email if supported by account', false)
  }),
  func('notify_owner', 'Send a short message to Stephen via the Google Fi SMS gateway. Keep it SMS-length unless asked for more.', {
    message: str('Message to deliver to Stephen', true)
  }),

  // Email reading/searching
  func('check_email', 'Fetch and summarize recent emails for an account.', {
    account: str('Account id to check (required)', true),
    limit: int('Max emails to fetch (default 5)', false)
  }),
  func('search_email', 'Search for matching emails and return a recent summary. Use before acting on an email when you have only partial details.', {
    account: str('Account id', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    limit: int('Max results (default 5)', false)
  }),

  // Email state changes (identify email by subject/sender/content or by emailId seqno)
  func('mark_spam', 'Move the email to Spam/Junk. Use only for clear junk/promotional mail.', {
    account: str('Account id', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    emailId: int('IMAP sequence number if known', false)
  }),
  func('mark_read', 'Mark a specific email as read.', {
    account: str('Account id', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    emailId: int('IMAP sequence number if known', false)
  }),
  func('mark_unread', 'Mark a specific email as unread.', {
    account: str('Account id', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    emailId: int('IMAP sequence number if known', false)
  }),
  func('delete_email', 'Delete an email (Gmail: move to [Gmail]/Trash; fallbacks applied). Use carefully and prefer confirmation.', {
    account: str('Account id', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    emailId: int('IMAP sequence number if known', false)
  }),
  func('move_email', 'Move an email to a specific folder/label.', {
    account: str('Account id', true),
    folder: str('Target folder/label (e.g., Archive, Receipts, [Gmail]/Starred)', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    emailId: int('IMAP sequence number if known', false)
  }),
  func('unsubscribe_email', 'Extract and present unsubscribe options from an email. Use for marketing/newsletter senders.', {
    account: str('Account id', true),
    subject: str('Subject contains...', false),
    sender: str('Sender email contains or equals...', false),
    content: str('Body contains...', false),
    emailId: int('IMAP sequence number if known', false)
  }),

  // Scheduling and tasks
  func('schedule_reminder', 'Schedule a reminder/wakeup for yourself to follow up later. Prefer natural times like "6pm".', {
    task: str('Short description of what to follow up on', true),
    when: str('Natural language time like "6pm", "in 2 hours", or "tomorrow 9am"', false),
    delayMs: int('Explicit delay in milliseconds (alternative to "when")', false),
    delay_ms: int('Alias of delayMs', false),
    context: str('Context label for the reminder (e.g., "Daily summary")', false),
    category: str('Optional category key to merge similar reminders', false)
  }),
  func('check_reminders', 'List upcoming reminders that have been scheduled.', {}),

  // Optional: requires memory integration to be enabled
  func('add_task', 'Add a task to the task/memory system (disabled unless memory is configured).', {
    task: str('Task description', true),
    due_date: str('Due date/time (optional)', false),
    priority: enm('Priority', ['low', 'medium', 'high'])
  })
].map(wrapAsTool);

function wrapAsTool(fnDef) {
  return { type: 'function', function: fnDef };
}

function func(name, description, properties) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: Object.entries(properties)
        .filter(([_, v]) => v && v.__required)
        .map(([k]) => k)
    }
  };
}

function str(description, required = false) {
  return { type: 'string', description, __required: required };
}

function int(description, required = false) {
  return { type: 'integer', description, __required: required };
}

function enm(description, values, required = false) {
  return { type: 'string', description, enum: values, __required: required };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  try {
    if (EXISTING_ID) {
      // Update existing assistant
      const updated = await openai.beta.assistants.update(EXISTING_ID, {
        name: 'Nova (AI Secretary)',
        model: MODEL,
        instructions: INSTRUCTIONS,
        tools
      });
      console.log('✅ Assistant updated:', { id: updated.id, model: updated.model, tools: updated.tools?.length });
    } else {
      // Create new assistant
      const created = await openai.beta.assistants.create({
        name: 'Nova (AI Secretary)',
        model: MODEL,
        instructions: INSTRUCTIONS,
        tools
      });
      console.log('✅ Assistant created:', { id: created.id, model: created.model, tools: created.tools?.length });
      console.log('\nSet NOVA_ASSISTANT_ID to:', created.id);
    }
  } catch (err) {
    console.error('❌ Failed to create/update assistant:', err.response?.data || err.message);
    process.exit(1);
  }
}

main();
