import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import config, { dumpConfigSummary } from "./config.js";
import NovaMemory from "./memory.js";
import UniversalEmailService from "./email.js";
import GoogleOAuth from "./google-oauth.js";
import NovaBrain from "./nova-brain.js";
import SchedulingService from "./scheduling.js";
import ActionExecutor from "./action-executor.js";
import ConversationHistory from "./conversation-history.js";
import EmailFormatter from "./email-formatter.js";
import { createRoutes } from "./routes.js";

dotenv.config();

// Init services
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const memory = new NovaMemory();
const emailService = new UniversalEmailService();
const googleOAuth = new GoogleOAuth();
const novaBrain = new NovaBrain();
const schedulingService = new SchedulingService();
const conversationHistory = new ConversationHistory();

const actionExecutor = new ActionExecutor({
  emailService,
  memory,
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
    console.log(`🧠 Nova pipeline started: "${trimmedInput}" (${channel})`);
    
    const recentConversation = await conversationHistory.getConversationHistory();
    console.log(`📖 Recent conversation context: ${recentConversation ? 'loaded' : 'empty'}`);
    
    const memoryQueryResult = await novaBrain.generateMemoryQueries({
      userInput: trimmedInput,
      recentConversation,
    });
    
    console.log(`🔍 Memory queries generated:`, {
      queries: memoryQueryResult.queries,
      reasoning: memoryQueryResult.reasoning
    });

    const memoryResults = await fetchRelevantMemories(memoryQueryResult.queries || []);
    console.log(`💭 Retrieved ${memoryResults.length} memory snippets`);
    
    // Use Nova's AI-powered memory curation
    const curationResult = await novaBrain.curateMemories(memoryResults);
    const curatedMemories = curationResult.curatedMemories;
    
    // Apply memory deletions/updates from curation
    if (curationResult.memoryOperations) {
      await applyMemoryUpdates(curationResult.memoryOperations);
    }
    
    console.log(`✨ Curated to ${curatedMemories.length} relevant memories`);

    console.log(`🤖 Nova reasoning with context:`, {
      input: trimmedInput,
      actionContext,
      memoriesCount: curatedMemories.length,
      hasConversation: !!recentConversation
    });

    const response = await novaBrain.respond({
      userInput: trimmedInput,
      recentConversation,
      memories: curatedMemories,
      actionContext,
    });

    const memoryOps = await applyMemoryUpdates(response.memory);
    await conversationHistory.addToConversationHistory(trimmedInput, response.response);

    const execution = await actionExecutor.executeAction(response);

    return {
      channel,
      actionContext,
      response,
      execution,
      memoryQueries: memoryQueryResult.queries,
      memoryReasoning: memoryQueryResult.reasoning,
      memoriesUsed: curatedMemories,
      memoryOps,
      metadata,
    };
  } catch (error) {
    console.error("❌ Nova pipeline error:", error);
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

async function fetchRelevantMemories(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return [];
  }

  const seen = new Set();
  const collected = [];

  for (const query of queries) {
    if (!query || !query.trim()) continue;

    try {
      const results = await memory.searchMemories(query.trim(), 8);
      for (const item of results || []) {
        const id = item.id || item.memory_id || item.uuid || item._id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        collected.push(item);
      }
    } catch (error) {
      console.error("Error searching memories for query", query, error.message);
    }
  }

  return collected;
}

async function applyMemoryUpdates(delta = {}) {
  const summary = {
    added: [],
    updated: [],
    deleted: [],
  };

  if (!delta || typeof delta !== "object") {
    return summary;
  }

  if (Array.isArray(delta.add)) {
    for (const text of delta.add) {
      if (typeof text !== "string" || text.trim() === "") continue;
      try {
        const result = await memory.addMemory(text.trim());
        summary.added.push({ text, result });
      } catch (error) {
        console.error("Failed to add memory:", error.message);
      }
    }
  }

  if (Array.isArray(delta.update)) {
    for (const entry of delta.update) {
      if (!entry || !entry.id || typeof entry.text !== "string") continue;
      const trimmed = entry.text.trim();
      if (!trimmed) continue;
      try {
        const result = await memory.updateMemory(entry.id, trimmed);
        summary.updated.push({ id: entry.id, result });
      } catch (error) {
        console.error("Failed to update memory:", entry.id, error.message);
      }
    }
  }

  if (Array.isArray(delta.delete)) {
    for (const id of delta.delete) {
      if (!id) continue;
      try {
        const result = await memory.deleteMemory(id);
        summary.deleted.push({ id, result });
      } catch (error) {
        console.error("Failed to delete memory:", id, error.message);
      }
    }
  }

  return summary;
}

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
    console.log(`   Action Context: EMAIL (limited actions)`);
    
    // Let Nova decide how to handle the incoming email with limited action set
    const pipelineResult = await runNovaPipeline({
      userInput: emailContext,
      channel: "email",
      actionContext: "email",
      metadata: { accountId, subject: email.subject, isThread: email.isThread, threadLength: email.threadLength },
    });
    console.log(`💭 Nova's decision for ${email.isThread ? 'email thread' : 'email'} "${email.subject}":`);
    console.log(`   Action: ${pipelineResult.response.action}`);
    console.log(`   Message: ${pipelineResult.response.response}`);
    console.log(`   Context: Email processing (restricted actions)`);
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
  googleOAuth,
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
      console.log("Memory: Mem0 + Upstash Redis");
      console.log("Ready to serve Stephen with no-nonsense efficiency");
    });
  } catch (error) {
    console.error('❌ Failed to start Nova AI Secretary:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

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
