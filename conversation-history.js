import { Redis } from "@upstash/redis";

export default class ConversationHistory {
  constructor() {
    try {
      this.redis = Redis.fromEnv();
      this.redisAvailable = true;
    } catch (err) {
      console.warn('⚠️ Upstash Redis not configured. Using in-memory conversation history.');
      this.redisAvailable = false;
      this._memoryHistory = [];
    }
    this.conversationKey = "nova_conversation_history";
    this.maxHistoryLength = 6; // 3 exchanges (user + nova pairs)
  }

  async addToConversationHistory(userInput, novaResponse) {
    try {
      // Get current history with defensive parsing
      let history = await this.getConversationHistory();
      
      // Ensure novaResponse is serializable
      const responseText = typeof novaResponse === 'string' 
        ? novaResponse 
        : (novaResponse.message || JSON.stringify(novaResponse));
      
      // Add new exchange
      history.push(
        { role: "user", content: userInput },
        { role: "assistant", content: responseText }
      );
      
      // Keep only recent history
      if (history.length > this.maxHistoryLength) {
        history = history.slice(-this.maxHistoryLength);
      }
      
      if (this.redisAvailable) {
        await this.redis.set(this.conversationKey, JSON.stringify(history));
      } else {
        this._memoryHistory = history;
      }
    } catch (error) {
      console.error("Error storing conversation history, resetting:", error.message);
      // Reset history on error
      if (this.redisAvailable) {
        await this.redis.del(this.conversationKey);
      } else {
        this._memoryHistory = [];
      }
    }
  }

  async getConversationHistory() {
    try {
      if (!this.redisAvailable) {
        return Array.isArray(this._memoryHistory) ? this._memoryHistory : [];
      }
      const historyJson = await this.redis.get(this.conversationKey);
      if (!historyJson) return [];
      
      // Handle both string and object responses from Redis
      if (typeof historyJson === 'string') {
        return JSON.parse(historyJson);
      } else if (Array.isArray(historyJson)) {
        return historyJson;
      } else {
        console.log("Unexpected history format, resetting:", typeof historyJson);
        if (this.redisAvailable) await this.redis.del(this.conversationKey);
        return [];
      }
    } catch (error) {
      console.error("Error retrieving conversation history, resetting:", error.message);
      // Clear corrupted history and start fresh
      if (this.redisAvailable) {
        await this.redis.del(this.conversationKey);
        return [];
      } else {
        this._memoryHistory = [];
        return [];
      }
    }
  }
}