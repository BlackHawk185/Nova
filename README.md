# Nova - AI Secretary

A no-nonsense AI assistant that manages emails, schedules reminders, and handles communications autonomously.

## Features

- **Email Management**: IMAP IDLE monitoring for real-time email processing
- **Smart Filtering**: Automatically marks spam, organizes emails, and notifies you of important messages
- **Scheduling**: Reminder system with intelligent merging and time-based triggers
- **Multi-Account**: Supports multiple email accounts (personal, work, SMS gateway)
- **OpenAI Assistants**: Powered by GPT-4 with function calling for reliable action execution
- **Persistent Context**: Thread-based conversation history with automatic rotation

## Quick Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

See [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md) for detailed deployment instructions.

## Local Development

### Prerequisites

- Node.js 18+
- OpenAI API key
- Email account(s) with IMAP/SMTP access
- (Optional) Upstash Redis for persistence
- (Optional) Mem0 API key for semantic memory

### Setup

1. **Clone and install:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Set up OpenAI Assistant:**
   ```bash
   npm run setup-assistant
   # Copy the NOVA_ASSISTANT_ID to your .env
   ```

4. **Run locally:**
   ```bash
   npm start
   ```

5. **Test in debug mode:**
   Type messages directly in the terminal to chat with Nova.

## Environment Variables

See [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md) for the complete list of required and optional environment variables.

### Essential Variables

- `OPENAI_API_KEY` - Your OpenAI API key
- `NOVA_ASSISTANT_ID` - OpenAI Assistant ID (created via `npm run setup-assistant`)
- `MY_NUMBER` - Your phone number for notifications
- `EMAIL_USER`, `EMAIL_PASS` - Primary email credentials
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` - Redis for persistence

## Architecture

Nova uses a two-layer architecture:

1. **Logic Layer** (code): Handles IMAP/SMTP, polling, scheduling, and side effects
2. **Reasoning Layer** (LLM): OpenAI Assistant handles decision-making and communication

### Key Components

- `index.js` - Main app and pipeline orchestration
- `assistant-pipeline.js` - OpenAI Assistants integration with function calling
- `action-executor.js` - Executes email/scheduling actions from tool calls
- `email.js` - Multi-account IMAP/SMTP with OAuth2 support
- `thread-manager.js` - Thread lifecycle with inactivity rotation
- `scheduling.js` - Reminder system with intelligent merging

## Usage

### Email Processing

Nova automatically processes incoming emails based on account context:
- **Personal/Work emails**: Can mark spam, notify owner, schedule reminders
- **SMS gateway (nova-sms)**: Full access to all actions

### Commands (Debug Mode)

In the terminal debug interface:
- Type any message to chat with Nova
- `reset` - Start a new conversation thread
- `exit` or `quit` - Shutdown

### Testing

```bash
# Test via HTTP endpoint
curl http://localhost:3000/test/hello%20nova

# Check health
curl http://localhost:3000/health
```

## Available Actions

Nova can execute these actions via function calling:
- `send_email` - Send emails
- `notify_owner` - Send SMS via Google Fi gateway
- `check_email` - Fetch recent emails
- `search_email` - Search for specific emails
- `mark_spam` - Mark as spam/junk
- `mark_read` / `mark_unread` - Update read status
- `delete_email` - Delete emails
- `move_email` - Move to folder
- `unsubscribe_email` - Extract unsubscribe options
- `schedule_reminder` - Schedule follow-ups
- `check_reminders` - List pending reminders

## Security Notes

- Never commit `.env` file
- Use OAuth2 for Gmail accounts (more secure than passwords)
- Restrict email processing context to prevent unauthorized deletions
- SMS gateway uses Google Fi email-to-SMS (@msg.fi.google.com)

## License

ISC

## Author

Stephen
