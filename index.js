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
    
    const curatedMemories = await memory.curateMemories(memoryResults);
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

    console.log(`💭 Nova's decision:`, {
      action: response.action || 'none',
      message: response.message,
      confidence: response.confidence,
      memoryOps: {
        add: response.memory?.add?.length || 0,
        update: response.memory?.update?.length || 0,
        delete: response.memory?.delete?.length || 0
      }
    });

    const memoryOps = await applyMemoryUpdates(response.memory);
    await conversationHistory.addToConversationHistory(trimmedInput, response.message);

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
      action: "send_sms",
      message: `Nova hit a snag while processing: ${error.message}`,
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
    console.log(`📧 NEW EMAIL RECEIVED: From ${email.from} - Subject: ${email.subject}`);
    
    // Create detailed context for Nova about the incoming email with limited action set
    const emailContext = `NEW EMAIL RECEIVED in ${accountId} account:
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}
Content: ${email.text?.replace(/--[0-9a-f]+/g, '').replace(/Content-Type:[^\n]+/g, '').replace(/boundary="[^"]*"/g, '').trim().substring(0, 500) || 'No content available'}

AUTONOMOUS EMAIL PROCESSING: You can take these actions:
1. SEND_SMS: Notify Stephen about this email with details
2. MARK_SPAM: Mark this email as spam if it's clearly promotional/unwanted
3. ORGANIZE_EMAIL: Intelligently move this email to an appropriate folder based on content
4. SCHEDULE_REMINDER: Schedule yourself to follow up on this email later

For ORGANIZE_EMAIL: I'll analyze the email content and available folders to move it to the most appropriate location automatically.

For SCHEDULE_REMINDER, decide the appropriate timeframe based on:
- Email urgency (immediate, hours, days, weeks)
- Sender importance (VIP, work contact, unknown, spam)
- Content type (meeting request, deadline, FYI, promotional)

Examples of good actions:
- ORGANIZE_EMAIL for newsletters, promotions, work emails that can be automatically filed
- MARK_SPAM for obvious junk/promotional emails
- SEND_SMS for important emails that need immediate attention
- SCHEDULE_REMINDER for emails that need follow-up but aren't urgent

Analyze this email and decide the best action with clear reasoning.`;
    
    console.log(`🧠 Nova analyzing email with context:`);
    console.log(`   Sender: ${email.from}`);
    console.log(`   Subject: ${email.subject}`);
    console.log(`   Account: ${accountId}`);
    console.log(`   Content: ${email.text?.replace(/--[0-9a-f]+/g, '').replace(/Content-Type:[^\n]+/g, '').replace(/boundary="[^"]*"/g, '').trim().substring(0, 150) || 'No content'}...`);
    console.log(`   Action Context: EMAIL (limited actions)`);
    
    // Let Nova decide how to handle the incoming email with limited action set
    const pipelineResult = await runNovaPipeline({
      userInput: emailContext,
      channel: "email",
      actionContext: "email",
      metadata: { accountId, subject: email.subject },
    });
    
    console.log(`💭 Nova's decision for email "${email.subject}":`);
    console.log(`   Action: ${pipelineResult.response.action}`);
    console.log(`   Message: ${pipelineResult.response.message}`);
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
