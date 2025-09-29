import OpenAI from "openai";
import { NOVA_SYSTEM_PROMPT, NOVA_MEMORY_SEARCH_PROMPT } from "./prompt.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BASE_ALLOWED_ACTIONS = new Set([
  "send_sms",
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
  "send_sms",
  "search_email",
  "mark_spam",
  "delete_email",
  "move_email",
  "unsubscribe_email",
  "mark_read",
  "mark_unread",
  "schedule_reminder"
]);

const ERROR_CONTEXT_ACTIONS = new Set(["send_sms"]);

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

    console.log(`🔍 LLM memory search result:`, parsed);

    return {
      queries,
      reasoning: parsed?.reasoning || ""
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
    
    console.log(`🧠 Raw LLM response:`, raw);
    
    const normalized = this.normalizeResult(raw, actionContext);
    
    console.log(`✅ Normalized Nova response:`, {
      action: normalized.action,
      message: normalized.message,
      confidence: normalized.confidence,
      hasMemoryOps: !!(normalized.memory?.add || normalized.memory?.update || normalized.memory?.delete)
    });

    return normalized;
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

  normalizeResult(raw, actionContext) {
    const result = raw && typeof raw === "object" ? { ...raw } : {};

    if (!result.action || typeof result.action !== "string") {
      result.action = "send_sms";
    } else {
      result.action = result.action.trim();
    }

    const allowed = this.getAllowedActionsForContext(actionContext);
    if (!allowed.has(result.action)) {
      result.action = "send_sms";
    }

    if (typeof result.message !== "string" || result.message.trim() === "") {
      result.message = "I'm on it.";
    } else {
      result.message = result.message.trim();
    }

    result.memory = this.normalizeMemoryPayload(result.memory);

    return result;
  }

  normalizeMemoryPayload(memoryPayload) {
    const base = {
      add: [],
      update: [],
      delete: []
    };

    if (!memoryPayload || typeof memoryPayload !== "object") {
      return base;
    }

    return {
      add: Array.isArray(memoryPayload.add)
        ? memoryPayload.add.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : [],
      update: Array.isArray(memoryPayload.update)
        ? memoryPayload.update
            .filter((item) => item && typeof item === "object" && item.id && item.text)
            .map((item) => ({ id: String(item.id), text: String(item.text).trim() }))
        : [],
      delete: Array.isArray(memoryPayload.delete)
        ? memoryPayload.delete.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : []
    };
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