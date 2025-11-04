import { Redis } from "@upstash/redis";
import config from "./config.js";

export default class SchedulingService {
  constructor() {
    // Use config with hardcoded fallbacks
    const url = config.upstashUrl || process.env.UPSTASH_REDIS_REST_URL;
    const token = config.upstashToken || process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (url && token) {
      this.redis = new Redis({ url, token });
    } else {
      console.warn('⚠️ Redis not configured - scheduling will use in-memory fallback');
      this.redis = null;
    }
    
    this.wakeupProcessor = null;
    // Default merge window - can be overridden based on Nova's learned preferences
    this.mergeWindowMs = 2 * 60 * 60 * 1000; // 2 hours default
  }

  async scheduleWakeup(task, delayMs, context = "Scheduled follow-up", category = null) {
    if (!this.redis) {
      console.warn('⚠️ Redis not available - reminder not persisted');
      return null;
    }
    
    const wakeupTime = Date.now() + delayMs;
    
    // Check for nearby reminders to merge with (regardless of category)
    const nearbyReminderId = await this.findNearbyReminder(wakeupTime);
    if (nearbyReminderId) {
      return await this.mergeIntoExistingReminder(nearbyReminderId, task, context, wakeupTime);
    }

    // Create new reminder
    const wakeupData = {
      task,
      context,
      category,
      originalTime: new Date().toISOString(),
      wakeupTime,
      mergedTasks: [{ 
        task, 
        context, 
        time: new Date().toISOString(),
        scheduledFor: wakeupTime
      }]
    };
    
    const taskId = `wakeup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await this.redis.set(taskId, JSON.stringify(wakeupData));
    await this.redis.zadd("nova_wakeups", { score: wakeupTime, member: taskId });
    
    console.log(`⏰ Reminder scheduled: ${task} at ${new Date(wakeupTime).toISOString()}${category ? ` (${category})` : ''}`);
    return taskId;
  }

  async findNearbyReminder(targetTime) {
    if (!this.redis) return null;
    
    // Look for reminders within the merge window
    const windowStart = targetTime - this.mergeWindowMs;
    const windowEnd = targetTime + this.mergeWindowMs;
    
    const nearbyTasks = await this.redis.zrange("nova_wakeups", windowStart, windowEnd, { byScore: true });
    
    // Return the closest existing reminder
    let closestId = null;
    let closestDistance = Infinity;
    
    for (const taskId of nearbyTasks) {
      const taskData = await this.redis.get(taskId);
      if (taskData) {
        try {
          const wakeupData = typeof taskData === 'string' ? JSON.parse(taskData) : taskData;
          const distance = Math.abs(wakeupData.wakeupTime - targetTime);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestId = taskId;
          }
        } catch (e) {
          console.error("Error parsing task data during merge search:", e);
        }
      }
    }
    
    return closestId;
  }

  async mergeIntoExistingReminder(existingTaskId, newTask, newContext, newWakeupTime) {
    const taskData = await this.redis.get(existingTaskId);
    if (!taskData) return null;

    let wakeupData;
    try {
      wakeupData = typeof taskData === 'string' ? JSON.parse(taskData) : taskData;
    } catch (e) {
      console.error("Error parsing existing task data:", e);
      return null;
    }

    // Add the new task to the merged list
    if (!wakeupData.mergedTasks) {
      wakeupData.mergedTasks = [];
    }
    
    wakeupData.mergedTasks.push({
      task: newTask,
      context: newContext,
      time: new Date().toISOString(),
      scheduledFor: newWakeupTime
    });

    // Update the combined task description and timing
    const taskCount = wakeupData.mergedTasks.length;
    wakeupData.task = `Combined reminder (${taskCount} tasks)`;
    
    // Adjust timing to the earliest requested time for urgency
    const earliestTime = Math.min(wakeupData.wakeupTime, newWakeupTime);
    if (earliestTime !== wakeupData.wakeupTime) {
      // Remove old entry and add with new time
      await this.redis.zrem("nova_wakeups", existingTaskId);
      wakeupData.wakeupTime = earliestTime;
      await this.redis.zadd("nova_wakeups", { score: earliestTime, member: existingTaskId });
    }

    await this.redis.set(existingTaskId, JSON.stringify(wakeupData));
    console.log(`🔄 Merged reminder: ${newTask} into existing reminder (${taskCount} total tasks)`);
    return existingTaskId;
  }

  // Configure merge window based on Nova's learned preferences
  setMergeWindow(hours) {
    this.mergeWindowMs = hours * 60 * 60 * 1000;
    console.log(`⚙️ Merge window updated to ${hours} hours`);
  }

  // Helper to get delay until a specific time of day (flexible replacement for hardcoded 6PM)
  static getDelayUntilTime(targetHour, targetMinute = 0) {
    const now = new Date();
    const target = new Date();
    target.setHours(targetHour, targetMinute, 0, 0);
    
    // If it's already past target time today, schedule for target time tomorrow
    if (now > target) {
      target.setDate(target.getDate() + 1);
    }
    
    return target.getTime() - now.getTime();
  }

  // Legacy helper for backwards compatibility - but Nova should learn preferred times
  static getDelayUntilSixPM() {
    return SchedulingService.getDelayUntilTime(18, 0);
  }

  // Get all pending reminders for debugging/management
  async getPendingReminders() {
    if (!this.redis) return [];
    
    const now = Date.now();
    const allTasks = await this.redis.zrange("nova_wakeups", now, "+inf", { byScore: true });
    
    const reminders = [];
    for (const taskId of allTasks) {
      const taskData = await this.redis.get(taskId);
      if (taskData) {
        try {
          const wakeupData = typeof taskData === 'string' ? JSON.parse(taskData) : taskData;
          reminders.push({
            id: taskId,
            scheduledFor: new Date(wakeupData.wakeupTime).toLocaleString(),
            task: wakeupData.task,
            mergedCount: wakeupData.mergedTasks ? wakeupData.mergedTasks.length : 1,
            timeUntil: Math.round((wakeupData.wakeupTime - now) / 1000 / 60) + ' minutes'
          });
        } catch (e) {
          console.error("Error parsing reminder:", e);
        }
      }
    }
    
    return reminders.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));
  }

  // Cancel a specific reminder
  async cancelReminder(taskId) {
    await this.redis.zrem("nova_wakeups", taskId);
    await this.redis.del(taskId);
    console.log(`❌ Cancelled reminder: ${taskId}`);
  }

  async processWakeups(novaCallback) {
    if (!this.redis) return;
    
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
            
            let followUpPrompt;
            
            // Handle merged tasks with combined context
            if (wakeupData.mergedTasks && wakeupData.mergedTasks.length > 1) {
              const taskDetails = wakeupData.mergedTasks.map((task, index) => 
                `${index + 1}. "${task.task}" (scheduled ${new Date(task.scheduledFor).toLocaleString()}) - Context: ${task.context}`
              ).join('\n');
              
              followUpPrompt = `SCHEDULED REMINDER - COMBINED TASKS: You have ${wakeupData.mergedTasks.length} scheduled tasks that were merged for efficiency:

${taskDetails}

This is the combined follow-up you committed to. Address all tasks in your response to Stephen (use notify_owner action) and reference that you're following up on multiple scheduled items.`;
            } else {
              // Handle single task (legacy format or single task)
              const taskInfo = wakeupData.mergedTasks?.[0] || wakeupData;
              followUpPrompt = `SCHEDULED REMINDER: You previously scheduled this task: "${taskInfo.task}". Context: ${taskInfo.context}. Originally requested at: ${wakeupData.originalTime}. This is the follow-up you committed to. Fulfill the task now by delivering your response to Stephen (use notify_owner action) and reference why you're contacting him (e.g., "As requested..." or "You asked me to...").`;
            }
            
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