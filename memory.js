
import { MemoryClient } from 'mem0ai';

class NovaMemory {
  constructor() {
    const apiKey = (process.env.MEM0_API_KEY || process.env.MEM0_TOKEN || '').trim();
    this._apiKey = apiKey;
    this.client = apiKey ? new MemoryClient({ apiKey }) : null;
    this.userId = 'stephen';
    if (apiKey) {
      console.log('✅ Mem0 client initialized (env)');
    } else {
      console.warn('⚠️ Mem0 API key not found. Memory features will be disabled. Set MEM0_API_KEY in your .env');
    }
  }

  // === STEP 1: Generate a semantic search query for memory ===
  /**
   * Given user input, use LLM to generate a concise search string for semantic memory.
   * (This is handled outside this class, but this is the entry point for the pipeline.)
   */
  async generateSearchQuery(userInput, conversationHistory = []) {
    // This method is a placeholder for the LLM call that generates a search query.
    // In your pipeline, call the LLM with a prompt like:
    // "Given the following user input and recent conversation, generate a concise search query to retrieve the most relevant memories."
    // Return the LLM's output here.
    throw new Error('generateSearchQuery should be implemented in the pipeline, not in NovaMemory.');
  }

  // === STEP 2: Retrieve and curate memories ===
  async searchMemories(query, limit = 10) {
    if (!this.client) {
      console.warn('🧠 Mem0 disabled: searchMemories skipped');
      return [];
    }
    try {
      const results = await this.client.search(query, {
        user_id: this.userId,
        limit
      });
      return results;
    } catch (error) {
      console.error('Error searching memories:', error);
      throw error;
    }
  }

  async curateMemories(memories, curationInstructions = null) {
    console.log(`🔍 curateMemories INPUT: ${memories?.length || 0} memories received`);
    
    // Debug: if we got memories when we shouldn't have, log them
    if (memories && memories.length > 0) {
      console.log(`🔍 Memories received:`, memories.map(m => ({
        id: m.id || m.memory_id,
        text: (m.text || m.memory || m.content || '').substring(0, 50) + '...'
      })));
    }
    
    // Optionally, use LLM to decide which memories to keep, update, or delete.
    // This method can be expanded to:
    // - Remove irrelevant or outdated memories
    // - Update memories with new info
    // - Return only the most useful memories for prompt context
    // For now, just return all memories as-is.
    
    console.log(`✨ curateMemories OUTPUT: ${memories?.length || 0} memories returned`);
    return memories;
  }

  // === STEP 3: Add, update, delete, and manage memories ===
  async addMemory(text, metadata = {}) {
    if (!this.client) {
      console.warn('🧠 Mem0 disabled: addMemory skipped');
      return null;
    }
    try {
      const result = await this.client.add(
        [{ role: 'user', content: text }],
        {
          user_id: this.userId,
          metadata: {
            timestamp: new Date().toISOString(),
            source: 'nova',
            ...metadata
          }
        }
      );
      return result;
    } catch (error) {
      console.error('Error adding memory:', error);
      return null;
    }
  }

  async updateMemory(memoryId, text) {
    if (!this.client) {
      console.warn('🧠 Mem0 disabled: updateMemory skipped');
      return null;
    }
    try {
      const result = await this.client.update(memoryId, text, {
        user_id: this.userId
      });
      return result;
    } catch (error) {
      console.error('Error updating memory:', error);
      throw error;
    }
  }

  async deleteMemory(memoryId) {
    if (!this.client) {
      console.warn('🧠 Mem0 disabled: deleteMemory skipped');
      return null;
    }
    try {
      const result = await this.client.delete(memoryId, {
        user_id: this.userId
      });
      return result;
    } catch (error) {
      console.error('Error deleting memory:', error);
      throw error;
    }
  }

  async getAllMemories() {
    if (!this.client) {
      console.warn('🧠 Mem0 disabled: getAllMemories skipped');
      return [];
    }
    try {
      const memories = await this.client.getAll({ user_id: this.userId });
      return memories;
    } catch (error) {
      console.error('Error getting all memories:', error);
      throw error;
    }
  }

  // === Utility: Format memories for LLM prompt ===
  formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    return memories
      .map((memory, i) => {
        const text = memory.text || memory.memory || memory.content || JSON.stringify(memory);
        return `MEMORY ${i + 1}: ${text}`;
      })
      .join('\n');
  }

  // === Logging and specialized memory helpers (optional, can be expanded) ===
  async logConversation(userInput, novaAction) {
    const conversationText = `User: "${userInput}" | Nova action: ${JSON.stringify(novaAction)}`;
    await this.addMemory(conversationText, {
      category: 'conversation',
      user_input: userInput,
      nova_action: novaAction.action,
      timestamp: new Date().toISOString(),
      importance: 'medium'
    });
  }

  async addInsight(insight, category = 'general', priority = 'medium') {
    await this.addMemory(insight, {
      category: `insight_${category}`,
      priority,
      importance: priority,
      timestamp: new Date().toISOString()
    });
  }

  async setPreference(preference, value) {
    const preferenceText = `Stephen prefers ${preference}: ${value}`;
    await this.addMemory(preferenceText, {
      category: 'preference',
      preference_key: preference,
      preference_value: value
    });
  }

  async addTask(task, dueDate = null, priority = 'medium') {
    const taskText = `Task: ${task}` + (dueDate ? ` (due: ${dueDate})` : '');
    await this.addMemory(taskText, {
      category: 'task',
      task_description: task,
      due_date: dueDate,
      priority,
      status: 'pending'
    });
  }
}

export default NovaMemory;