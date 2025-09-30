import { Redis } from "@upstash/redis";

export default class SchedulingService {
  constructor() {
    this.redis = Redis.fromEnv();
    this.wakeupProcessor = null;
  }

  async scheduleWakeup(task, delayMs, context = "Scheduled follow-up", category = null) {
    // If category is provided, check for existing aggregatable reminders
    if (category) {
      const existingAggregateId = await this.findExistingAggregate(category);
      if (existingAggregateId) {
        return await this.appendToAggregate(existingAggregateId, task, context);
      }
    }

    const wakeupTime = Date.now() + delayMs;
    const wakeupData = {
      task,
      context,
      category,
      originalTime: new Date().toISOString(),
      wakeupTime,
      aggregatedTasks: category ? [{ task, context, time: new Date().toISOString() }] : null
    };
    
    // Store the scheduled task in Redis
    const taskId = `wakeup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await this.redis.set(taskId, JSON.stringify(wakeupData));
    // Upstash SDK expects objects { score, member }
    await this.redis.zadd("nova_wakeups", { score: wakeupTime, member: taskId });
    
    console.log(`Wake-up scheduled: ${task} at ${new Date(wakeupTime).toISOString()}${category ? ` (category: ${category})` : ''}`);
    return taskId;
  }

  async findExistingAggregate(category) {
    // Look for existing reminders in the same category scheduled for today
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    
    const allTasks = await this.redis.zrange("nova_wakeups", Date.now(), todayEnd.getTime(), { byScore: true });
    
    for (const taskId of allTasks) {
      const taskData = await this.redis.get(taskId);
      if (taskData) {
        let wakeupData;
        try {
          wakeupData = typeof taskData === 'string' ? JSON.parse(taskData) : taskData;
          if (wakeupData.category === category) {
            return taskId;
          }
        } catch (e) {
          console.error("Error parsing task data:", e);
        }
      }
    }
    return null;
  }

  async appendToAggregate(existingTaskId, newTask, newContext) {
    const taskData = await this.redis.get(existingTaskId);
    if (!taskData) return null;

    let wakeupData;
    try {
      wakeupData = typeof taskData === 'string' ? JSON.parse(taskData) : taskData;
    } catch (e) {
      console.error("Error parsing existing task data:", e);
      return null;
    }

    // Add the new task to the aggregated list
    if (!wakeupData.aggregatedTasks) {
      wakeupData.aggregatedTasks = [];
    }
    wakeupData.aggregatedTasks.push({
      task: newTask,
      context: newContext,
      time: new Date().toISOString()
    });

    // Update the main task description to reflect multiple items
    wakeupData.task = `${wakeupData.category} summary (${wakeupData.aggregatedTasks.length} items)`;

    await this.redis.set(existingTaskId, JSON.stringify(wakeupData));
    console.log(`Aggregated task added to existing reminder: ${newTask}`);
    return existingTaskId;
  }

  // Helper to schedule daily summary at 6 PM
  static getDelayUntilSixPM() {
    const now = new Date();
    const sixPM = new Date();
    sixPM.setHours(18, 0, 0, 0);
    
    // If it's already past 6 PM today, schedule for 6 PM tomorrow
    if (now > sixPM) {
      sixPM.setDate(sixPM.getDate() + 1);
    }
    
    return sixPM.getTime() - now.getTime();
  }

  async processWakeups(novaCallback) {
    try {
      const now = Date.now();
      // Get all tasks that should wake up now using ZRANGE BYSCORE
      const readyTasks = await this.redis.zrange("nova_wakeups", 0, now, { byScore: true });
      
      for (const taskId of readyTasks) {
        try {
          const taskData = await this.redis.get(taskId);
          if (taskData) {
            let wakeupData;
            try {
              // Handle both string and object responses from Redis
              if (typeof taskData === 'string') {
                wakeupData = JSON.parse(taskData);
              } else if (typeof taskData === 'object') {
                // If Redis returned an object directly, use it (shouldn't happen but defensive)
                wakeupData = taskData;
              } else {
                console.error("Unexpected taskData type:", typeof taskData, taskData);
                continue;
              }
            } catch (parseError) {
              console.error("Failed to parse wakeup data for", taskId, ":", parseError.message);
              // Clean up corrupted task
              await this.redis.zrem("nova_wakeups", taskId);
              await this.redis.del(taskId);
              continue;
            }
            
            console.log("Nova waking up for:", wakeupData.task);
            
            const followUpPrompt = `SCHEDULED REMINDER: You previously scheduled this task: "${wakeupData.task}". Context: ${wakeupData.context}. Originally requested at: ${wakeupData.originalTime}. This is the follow-up you committed to. Fulfill the task now by delivering your response to Stephen (use send_email action to nova-sms account) and reference why you're contacting him (e.g., "As requested..." or "You asked me to...").`;
            
            // Call the callback function to process the wakeup
            if (novaCallback) {
              await novaCallback(followUpPrompt);
            }
          }
          
          // Clean up completed task
          await this.redis.zrem("nova_wakeups", taskId);
          await this.redis.del(taskId);
        } catch (error) {
          console.error("Error processing wakeup:", taskId, error);
        }
      }
    } catch (error) {
      console.error("Error in processWakeups:", error);
    }
  }

  startWakeupProcessor(novaCallback) {
    // Run wake-up processor every 30 seconds
    this.wakeupProcessor = setInterval(() => {
      this.processWakeups(novaCallback);
    }, 30000);
  }

  stopWakeupProcessor() {
    if (this.wakeupProcessor) {
      clearInterval(this.wakeupProcessor);
      this.wakeupProcessor = null;
    }
  }
}