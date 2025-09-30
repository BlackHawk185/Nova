import OpenAI from "openai";
import { NOVA_SYSTEM_PROMPT, NOVA_MEMORY_SEARCH_PROMPT, NOVA_MEMORY_CURATION_PROMPT } from "./prompt.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BASE_ALLOWED_ACTIONS = new Set([
  "send_email",
  "check_email",
  "search_email",
  "mark_spam",
  "mark_read",
  "mark_unread",
  "delete_email",
  "move_email",
  "unsubscribe_email",
  "schedule_reminder",
  "add_task",
  "check_calendar",
  "web_search"
]);

const EMAIL_CONTEXT_ACTIONS = new Set([
  "send_email",
  "search_email",
  "mark_spam",
  "delete_email",
  "move_email",
  "unsubscribe_email",
  "mark_read",
  "mark_unread",
  "schedule_reminder"
]);

const ERROR_CONTEXT_ACTIONS = new Set(["send_email"]);

export default class NovaBrain {
  constructor({ model } = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ OPENAI_API_KEY missing. NovaBrain will throw on first LLM call.');
    }
    this.openai = new OpenAI({ apiKey });
    this.model = model || DEFAULT_MODEL;
  }

  async generateMemoryQueries({ userInput, recentConversation = [] }) {
    const formattedConversation = this.formatConversation(recentConversation) || "None";
    const userContent = [
      `USER_INPUT: ${userInput}`,
      `RECENT_CONVERSATION:\n${formattedConversation}`
    ].join("\n\n");

    console.log(`🧠 Memory search prompt:`, {
      userInput,
      conversationLength: recentConversation?.length || 0
    });

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: NOVA_MEMORY_SEARCH_PROMPT },
        { role: "user", content: userContent }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const parsed = this.safeJsonParse(response.choices?.[0]?.message?.content);
    const queries = Array.isArray(parsed?.queries)
      ? parsed.queries.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim())
      : [];

    return {
      queries,
      reasoning: parsed?.reasoning || ""
    };
  }

  async curateMemories(memories) {
    if (!memories || memories.length === 0) {
      return { curatedMemories: [], memoryOperations: { delete: [], update: [] } };
    }

    const formattedMemories = this.formatMemories(memories);
    const payload = `<MEMORIES>\n${formattedMemories}\n</MEMORIES>`;

    console.log(`🧠 Memory curation prompt:`, {
      memoriesCount: memories.length
    });

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: NOVA_MEMORY_CURATION_PROMPT },
        { role: "user", content: payload }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const result = this.safeJsonParse(response.choices?.[0]?.message?.content);
    
    console.log(`🔍 Memory curation result:`, {
      kept: result?.curated_memories?.length || 0,
      deleted: result?.memory_operations?.delete?.length || 0,
      updated: result?.memory_operations?.update?.length || 0,
      reasoning: result?.reasoning || "No reasoning provided"
    });

    // Log details of deleted memories
    if (result?.memory_operations?.delete?.length > 0) {
      console.log(`🗑️ Memories being deleted:`);
      result.memory_operations.delete.forEach(deleteId => {
        const originalMemory = memories.find(m => 
          m.id === deleteId || m.memory_id === deleteId || m.uuid === deleteId
        );
        if (originalMemory) {
          const text = originalMemory.text || originalMemory.memory || originalMemory.content || 'No text';
          console.log(`   [${deleteId}] ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
        } else {
          console.log(`   [${deleteId}] Memory not found in original set`);
        }
      });
    }

    // Log details of updated memories
    if (result?.memory_operations?.update?.length > 0) {
      console.log(`✏️ Memories being updated:`);
      result.memory_operations.update.forEach(update => {
        console.log(`   [${update.id}] NEW: ${update.text.substring(0, 100)}${update.text.length > 100 ? '...' : ''}`);
      });
    }

    return {
      curatedMemories: result?.curated_memories || memories,
      memoryOperations: result?.memory_operations || { delete: [], update: [] }
    };
  }

  async respond({
    userInput,
    recentConversation = [],
    memories = [],
    actionContext = "general"
  }) {
    const formattedConversation = this.formatConversation(recentConversation) || "None";
    const formattedMemories = this.formatMemories(memories) || "None";

    const payload = [
      `<USER_INPUT>${userInput}</USER_INPUT>`,
      `<RECENT_CONVERSATION>${formattedConversation}</RECENT_CONVERSATION>`,
      `<MEMORIES>\n${formattedMemories}\n</MEMORIES>`,
      `<ACTION_CONTEXT>${actionContext}</ACTION_CONTEXT>`
    ].join("\n\n");

    console.log(`� Nova reasoning prompt:`, {
      userInput,
      actionContext,
      memoriesCount: memories?.length || 0,
      conversationLength: recentConversation?.length || 0,
      payloadLength: payload.length
    });

    if (process.env.NOVA_DEBUG === '1') {
      console.log(`📝 Full prompt payload:\n${payload}`);
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: NOVA_SYSTEM_PROMPT },
        { role: "user", content: payload }
      ],
      response_format: { type: "json_object" },
      temperature: 0.4
    });

    const raw = this.safeJsonParse(response.choices?.[0]?.message?.content);
    
    // Minimal validation - only security-critical checks
    const result = raw && typeof raw === "object" ? { ...raw } : {};
    
    // Fix nested action structure if present
    if (result.action && typeof result.action === "object" && result.action.action) {
      // Flatten nested action: { action: { action: 'mark_spam', ... } } -> { action: 'mark_spam', ... }
      const actionName = result.action.action;
      const actionParams = { ...result.action };
      delete actionParams.action;
      result.action = actionName;
      Object.assign(result, actionParams);
    }
    
    // Validate action is allowed in current context
    if (result.action && typeof result.action === "string") {
      const allowed = this.getAllowedActionsForContext(actionContext);
      if (!allowed.has(result.action)) {
        console.warn(`❌ Action '${result.action}' not allowed in context '${actionContext}', removing action`);
        delete result.action;
      }
    }

    // Enforce dual action sets rule: must have either a direct response OR a schedule_reminder action
    // If no action or action is 'none', this must be a direct user response
    if (!result.action || result.action === 'none') {
      if (!result.response || typeof result.response !== "string") {
        result.response = "I understand. Let me think about the best way to help.";
      }
      // Remove 'none' action - it's not a real action
      if (result.action === 'none') {
        delete result.action;
      }
      
      // CRITICAL: If we have a response but no action, Nova likely forgot to choose send_email
      // This violates the dual action sets rule - responses need delivery mechanisms
      console.warn(`⚠️ Nova provided response without delivery action. Response: "${result.response?.substring(0, 100)}..."`);
      
      // For scheduled reminders or direct user communication, default to send_email
      if (result.response && actionContext !== 'email') {
        console.log(`🔧 Auto-adding send_email action for response delivery`);
        result.action = 'send_email';
        result.to = process.env.MY_NUMBER ? `${process.env.MY_NUMBER}@msg.fi.google.com` : 'stephen@valenceapp.net';
        result.subject = 'Nova Update';
        result.body = result.response;
        result.account = 'nova-sms';
      }
    }

    // Ensure response exists (required field)
    if (!result.response || typeof result.response !== "string") {
      result.response = result.action ? 
        `I'll handle that ${result.action.replace('_', ' ')} for you.` :
        "I understand. Let me think about the best way to help.";
    }    // Log the final decision
    console.log(`💭 Nova's decision:`, {
      action: result.action || 'none',
      response: result.response,
      confidence: result.confidence,
      memoryOps: {
        add: result.memory?.add?.length || 0,
        update: result.memory?.update?.length || 0,
        delete: result.memory?.delete?.length || 0
      }
    });

    return result;
  }

  formatConversation(conversation) {
    if (!conversation || conversation.length === 0) return "";

    if (Array.isArray(conversation)) {
      return conversation
        .map((entry) => {
          if (typeof entry === "string") return entry;
          const role = entry.role || "speaker";
          return `${role.toUpperCase()}: ${entry.content || ""}`.trim();
        })
        .join("\n");
    }

    return String(conversation);
  }

  formatMemories(memories) {
    if (!memories || memories.length === 0) return "";

    return memories
      .map((memory, index) => {
        const id = memory.id || memory.memory_id || memory.uuid || `auto_${index}`;
        const text = memory.text || memory.memory || memory.content || JSON.stringify(memory);
        return `- [id: ${id}] ${text}`;
      })
      .join("\n");
  }

  getAllowedActionsForContext(context) {
    switch ((context || "").toLowerCase()) {
      case "email":
      case "incoming_email":
        return EMAIL_CONTEXT_ACTIONS;
      case "error":
        return ERROR_CONTEXT_ACTIONS;
      default:
        return BASE_ALLOWED_ACTIONS;
    }
  }

  safeJsonParse(text) {
    if (!text || typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error("Failed to parse LLM JSON response:", error.message, text);
      return null;
    }
  }
}