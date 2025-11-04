import express from "express";
import bodyParser from "body-parser";
import config, { dumpConfigSummary } from "./config.js";
import UniversalEmailService from "./email.js";
import SchedulingService from "./scheduling.js";
import ActionExecutor from "./action-executor.js";
import EmailFormatter from "./email-formatter.js";
import { createRoutes } from "./routes.js";
import { runAssistantPipeline } from "./assistant-pipeline.js";
import ThreadManager from "./thread-manager.js";

// dotenv is already loaded by config.js

// Init services
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const emailService = new UniversalEmailService();
const schedulingService = new SchedulingService();
const threadManager = new ThreadManager();

const actionExecutor = new ActionExecutor({
  emailService,
  schedulingService,
});

// Get recent email context to help Nova understand references like "newest email from Ryan"
async function getRecentEmailContext() {
  try {
    // Get recent emails from all accounts to provide context
    const accounts = emailService.listAccounts();
    const accountsData = [];
    
    for (const account of accounts) {
      try {
        const recentEmails = await emailService.getRecentEmails(account.id, 5);
        if (recentEmails && recentEmails.length > 0) {
          accountsData.push({ accountId: account.id, emails: recentEmails });
        }
      } catch (accountError) {
        console.warn(`Failed to get recent emails for ${account.id}:`, accountError.message);
      }
    }
    
    return EmailFormatter.buildRecentEmailContext(accountsData);
  } catch (error) {
    console.error("Error getting recent email context:", error.message);
    return null;
  }
}

// Simplified pipeline using OpenAI Assistants API
async function runNovaPipeline({
  userInput,
  channel = "sms",
  actionContext = "general",
  metadata = {},
}) {
  if (!userInput || !userInput.toString().trim()) {
    throw new Error("Nova pipeline requires non-empty user input");
  }

  const trimmedInput = userInput.toString().trim();

  try {
    console.log(`� Assistant pipeline started: "${trimmedInput}" (${channel})`);
    
    // Use OpenAI Assistant for reasoning and tool calls
    const result = await runAssistantPipeline({ 
      userInput: trimmedInput,
      threadId: metadata.threadId, // Persistent conversation context
      toolExecutor: (plan) => actionExecutor.executeAction(plan),
      actionContext,
      metadata
    });
    
    console.log(`✅ Assistant responded: ${result.text}`);
    
    return {
      channel,
      actionContext,
      response: { response: result.text, action: (result.actions && result.actions[0]) || undefined },
      threadId: result.threadId,
      metadata,
    };
  } catch (error) {
    console.error("❌ Assistant pipeline error:", error);
    await actionExecutor.executeAction({
      action: "send_email",
      to: `${process.env.MY_NUMBER}@msg.fi.google.com`,
      subject: "Nova Error",
      body: `Nova hit a snag while processing: ${error.message}`,
      account: "nova-sms"
    }).catch((notifyError) => {
      console.error("❌ Failed to notify owner about pipeline error:", notifyError);
    });
    throw error;
  }
}

// Old memory functions removed - OpenAI Assistant handles memory natively

// === INCOMING EMAIL HANDLER ===
async function handleIncomingEmail({ accountId, email, type }) {
  try {
    if (email.isThread) {
      console.log(`📧 EMAIL THREAD RECEIVED: ${email.threadLength} messages - Subject: ${email.subject}`);
    } else {
      console.log(`📧 NEW EMAIL RECEIVED: From ${email.from} - Subject: ${email.subject}`);
    }
    
    // Unified email processing for all accounts
    const emailContext = EmailFormatter.buildIncomingEmailContext(email, accountId);
    
    console.log(`🧠 Nova analyzing ${email.isThread ? 'email thread' : 'email'} with context:`);
    console.log(`   Sender: ${email.from}`);
    console.log(`   Subject: ${email.subject}`);
    console.log(`   Account: ${accountId}`);
    if (email.isThread) {
      console.log(`   Thread Length: ${email.threadLength} messages`);
    }
    console.log(`   Content: ${email.text?.replace(/--[0-9a-f]+/g, '').replace(/Content-Type:[^\n]+/g, '').replace(/boundary="[^"]*"/g, '').trim().substring(0, 150) || 'No content'}...`);
    
    // nova-sms should be treated as direct messages (inbox), not emails to manage
    const isDirectMessage = accountId === 'nova-sms';
    const channel = isDirectMessage ? "inbox" : "email";
    const actionContext = isDirectMessage ? "general" : "email";
    
    console.log(`   Action Context: ${actionContext.toUpperCase()} (${isDirectMessage ? 'direct conversation' : 'limited actions'})`);
    
    // Let Nova decide how to handle the incoming email/message
    const pipelineResult = await runNovaPipeline({
      userInput: emailContext,
      channel,
      actionContext,
      metadata: { accountId, subject: email.subject, isThread: email.isThread, threadLength: email.threadLength },
    });
    console.log(`💭 Nova processed email: "${email.subject}"`);
    console.log(`   Decision: ${pipelineResult.response.action ? `Execute ${pipelineResult.response.action}` : 'No action taken'}`);
    console.log(`   Reasoning: ${pipelineResult.response.response}`);
    console.log(`   Context: ${accountId === 'nova-sms' ? 'Direct conversation (full actions)' : 'Email processing (restricted actions)'}`);
    console.log(`   Memory queries: ${JSON.stringify(pipelineResult.memoryQueries)}`);
    
  } catch (error) {
    console.error('❌ Error handling incoming email:', error);
  }
}

// Set up wakeup processor with Nova callback
schedulingService.startWakeupProcessor(async (followUpPrompt) => {
  await runNovaPipeline({
    userInput: followUpPrompt,
    channel: "scheduler",
    actionContext: "general",
  });
});

// Set up routes
const routes = createRoutes({
  runNovaPipeline,
  actionExecutor,
  emailService,
  handleIncomingEmail,
});
app.use('/', routes);

// === SERVER STARTUP ===
async function startServer() {
  try {
    // Wait for email service to fully initialize
    console.log('🚀 Initializing email service...');
    await emailService.initialize();
    
    // Set up email monitoring callback after initialization
    emailService.setEmailCallback(handleIncomingEmail);
    
    // Start the server
    const PORT = config.port;
    console.log('🧩 Service configuration summary:', dumpConfigSummary());
    app.listen(PORT, () => {
      console.log(`Nova AI Secretary running on port ${PORT}`);
      console.log("Personality: Skeptical, dry-witted, concise");
      console.log("Context: OpenAI Assistants threads (ThreadManager + Redis)");
      console.log("Ready to serve Stephen with no-nonsense efficiency");
    });
  } catch (error) {
    console.error('❌ Failed to start Nova AI Secretary:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

// === INTERACTIVE DEBUG MODE ===
if (process.env.NODE_ENV !== 'production') {
  import('readline').then((readline) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Nova> '
    });

    console.log('\n🔧 DEBUG MODE: Type messages to send to Nova (or "exit" to quit)');
    rl.prompt();

  // Persist a thread across debug messages using ThreadManager with inactivity expiry
  const debugContextId = 'terminal-debug';
  let debugThreadId = null; // stored for quick display; authoritative state kept in ThreadManager

  rl.on('line', async (input) => {
      const trimmed = input.trim();
      
      if (trimmed === 'exit' || trimmed === 'quit') {
        console.log('👋 Exiting Nova...');
        process.exit(0);
      }
      
      if (trimmed) {
        // Support a manual reset command
        if (trimmed.toLowerCase() === 'reset') {
          const rotated = await threadManager.reset(debugContextId);
          debugThreadId = rotated.threadId;
          console.log(`🔄 Thread reset. New thread: ${debugThreadId}`);
          console.log('');
          rl.prompt();
          return;
        }

        try {
          console.log(`\n📤 Sending to Nova: "${trimmed}"`);
          // Acquire or rotate thread based on inactivity/message count
          const { threadId } = await threadManager.getOrCreateThread(debugContextId);
          const result = await runNovaPipeline({
            userInput: trimmed,
            channel: "inbox",
            actionContext: "general",
            metadata: { source: "terminal-debug", threadId }
          });
          console.log(`✅ Nova responded: ${result.response.response}`);
          if (result.response.action) {
            console.log(`🎯 Action taken: ${result.response.action}`);
          }
          // Update usage stats and cache threadId for display
          await threadManager.touch(debugContextId, { threadId: result.threadId, messagesDelta: 1 });
          debugThreadId = result.threadId || threadId || debugThreadId;
          console.log(`🧵 Thread: ${debugThreadId}`);
        } catch (error) {
          console.error(`❌ Error: ${error.message}`);
        }
      }
      
      console.log(''); // blank line for readability
      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\n👋 Nova debug session ended');
      process.exit(0);
    });
  });
}

// === GRACEFUL SHUTDOWN ===
process.on('SIGINT', () => {
  console.log('📧 Shutting down Nova AI Secretary...');
  emailService.stopEmailMonitoring();
  schedulingService.stopWakeupProcessor();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('📧 Shutting down Nova AI Secretary...');
  emailService.stopEmailMonitoring();
  schedulingService.stopWakeupProcessor();
    process.exit(0);
  });
