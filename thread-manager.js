import { Redis } from "@upstash/redis";
import OpenAI from "openai";
import config from "./config.js";

// Simple Assistants Thread Manager with inactivity timeout and message cap
export default class ThreadManager {
  constructor({ prefix = "nova:threads", inactivityMs = 12 * 60 * 60 * 1000, maxMessages = 60 } = {}) {
    this.prefix = prefix;
    this.inactivityMs = inactivityMs;
    this.maxMessages = maxMessages;

    // Redis optional - use config with hardcoded fallbacks
    try {
      const url = config.upstashUrl || process.env.UPSTASH_REDIS_REST_URL;
      const token = config.upstashToken || process.env.UPSTASH_REDIS_REST_TOKEN;
      
      if (url && token) {
        this.redis = new Redis({ url, token });
        this.redisAvailable = true;
      } else {
        throw new Error('Redis credentials not available');
      }
    } catch (err) {
      this.redisAvailable = false;
      this._store = new Map();
      console.warn("⚠️ Upstash Redis not configured for ThreadManager. Using in-memory store.");
    }

    // OpenAI for thread operations (delete, create)
    const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  keyFor(id) {
    return `${this.prefix}:${id}`;
  }

  async getState(id) {
    const key = this.keyFor(id);
    if (this.redisAvailable) {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    }
    return this._store.get(key) || null;
  }

  async setState(id, state) {
    const key = this.keyFor(id);
    const value = JSON.stringify(state);
    if (this.redisAvailable) {
      await this.redis.set(key, value);
    } else {
      this._store.set(key, state);
    }
  }

  async clear(id) {
    const key = this.keyFor(id);
    if (this.redisAvailable) {
      await this.redis.del(key);
    } else {
      this._store.delete(key);
    }
  }

  // Get an existing thread for the context or create a new one if expired or missing
  async getOrCreateThread(contextId) {
    const now = Date.now();
    const state = (await this.getState(contextId)) || {};
    const { threadId, lastUsed = 0, messageCount = 0 } = state;

    const expired = !threadId || (now - lastUsed > this.inactivityMs) || (messageCount >= this.maxMessages);
    if (!expired) {
      return { threadId, rotated: false };
    }

    // Create a new thread
    if (!this.openai) throw new Error("OpenAI not configured for thread creation");
    const thread = await this.openai.beta.threads.create();
    const newState = { threadId: thread.id, lastUsed: now, messageCount: 0 };
    await this.setState(contextId, newState);
    return { threadId: thread.id, rotated: true };
  }

  // Update usage stats after a message is added
  async touch(contextId, { threadId, messagesDelta = 1 } = {}) {
    const now = Date.now();
    const state = (await this.getState(contextId)) || { threadId, lastUsed: 0, messageCount: 0 };
    if (!state.threadId && threadId) state.threadId = threadId;
    state.lastUsed = now;
    state.messageCount = (state.messageCount || 0) + (Number.isFinite(messagesDelta) ? messagesDelta : 1);
    await this.setState(contextId, state);
    return state;
  }

  // Force rotation: delete the existing thread (best-effort) and create a new one
  async reset(contextId) {
    const state = await this.getState(contextId);
    if (state?.threadId && this.openai) {
      try { await this.openai.beta.threads.delete(state.threadId); } catch (e) { /* ignore */ }
    }
    await this.clear(contextId);
    return this.getOrCreateThread(contextId);
  }
}
