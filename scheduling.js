import { Redis } from "@upstash/redis";

export default class SchedulingService {
  constructor() {
    this.redis = Redis.fromEnv();
    this.wakeupProcessor = null;
  }

  async scheduleWakeup(task, delayMs, context = "Scheduled follow-up") {
    const wakeupTime = Date.now() + delayMs;
    const wakeupData = {
      task,
      context,
      originalTime: new Date().toISOString(),
      wakeupTime
    };
    
    // Store the scheduled task in Redis
    const taskId = `wakeup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await this.redis.set(taskId, JSON.stringify(wakeupData));
    // Upstash SDK expects objects { score, member }
    await this.redis.zadd("nova_wakeups", { score: wakeupTime, member: taskId });
    
    console.log(`Wake-up scheduled: ${task} at ${new Date(wakeupTime).toISOString()}`);
    return taskId;
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
            
            const followUpPrompt = `SCHEDULED REMINDER: You previously scheduled this task: "${wakeupData.task}". Context: ${wakeupData.context}. Originally requested at: ${wakeupData.originalTime}. This is the follow-up you committed to. Fulfill the task now and reference why you're contacting the user (e.g., "As requested..." or "You asked me to...").`;
            
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