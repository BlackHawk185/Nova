import config from "./config.js";
import EmailFormatter from "./email-formatter.js";
import SchedulingService from "./scheduling.js";

const DEFAULT_EMAIL_LIMIT = 5;

function normalizePhone(value) {
	return value ? value.replace(/[^0-9+]/g, "") : "";
}

export default class ActionExecutor {
	constructor({ emailService, schedulingService, logger = console } = {}) {
		this.emailService = emailService;
		this.schedulingService = schedulingService;
		this.logger = logger;

		this.ownerNumber = process.env.MY_NUMBER;

		this.actionHandlers = {
			send_email: this.handleSendEmail.bind(this),
			notify_owner: this.handleNotifyOwner.bind(this),
			check_email: this.handleCheckEmail.bind(this),
			search_email: this.handleSearchEmail.bind(this),
			mark_spam: this.handleMarkSpam.bind(this),
			mark_read: this.handleMarkRead.bind(this),
			mark_unread: this.handleMarkUnread.bind(this),
			delete_email: this.handleDeleteEmail.bind(this),
			move_email: this.handleMoveEmail.bind(this),
			unsubscribe_email: this.handleUnsubscribeEmail.bind(this),
			schedule_reminder: this.handleScheduleReminder.bind(this),
			check_reminders: this.handleCheckReminders.bind(this),
			add_task: this.handleAddTask.bind(this),
		};
	}

	async executeAction(plan = {}) {
		const actionName = typeof plan.action === "string" ? plan.action.trim() : "";

		if (!actionName) {
			this.logger.warn("No action provided to ActionExecutor", plan);
			return { success: false, error: "missing_action" };
		}

		const handler = this.actionHandlers[actionName];
		if (!handler) {
			this.logger.warn(`Unsupported action requested: ${actionName}`);
			await this.notifyOwner(
				plan.response || `Nova planned unsupported action "${actionName}".`
			);
			return { success: false, action: actionName, error: "unsupported_action" };
		}

		try {
			const details = await handler(plan);
			await this.notifyOwnerIfNeeded(plan, details);
			return { success: true, action: actionName, details };
		} catch (error) {
			this.logger.error(`Action execution failed for ${actionName}:`, error);
			await this.notifyOwner(
				`I hit an error while executing ${actionName}: ${error.message}`
			);
			return { success: false, action: actionName, error: error.message };
		}
	}



	async handleSendEmail(plan) {
		if (!this.emailService) {
			throw new Error("Email service not configured");
		}

		const { to, subject, body, html, priority, account, from } = plan;

		if (!to) throw new Error("send_email requires a 'to' address");
		if (!subject) throw new Error("send_email requires a subject");
		if (!body && !html) throw new Error("send_email requires body or html content");

		const result = await this.emailService.sendEmail({
			to,
			subject,
			body,
			html,
			priority,
			accountId: account,
			from,
		});

		return { email: result };
	}

	async handleNotifyOwner(plan) {
		// Notify Stephen via nova-sms account (email-to-SMS gateway)
		const message = plan.message || plan.body || plan.response;
		if (!message) throw new Error("notify_owner requires a 'message' field");

		const result = await this.emailService.sendEmail({
			to: process.env.MY_NUMBER ? `${process.env.MY_NUMBER}@msg.fi.google.com` : 'stephen@valenceapp.net',
			subject: '', // Blank subject for natural SMS-like conversation
			body: message,
			accountId: 'nova-sms'
		});

		return { notification: result };
	}

	async handleCheckEmail(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for check_email");

		const limit = Number.isInteger(plan.limit) ? plan.limit : DEFAULT_EMAIL_LIMIT;
		const emails = await this.emailService.getRecentEmails(accountId, limit);

		const summary = EmailFormatter.formatEmailList(emails, { limit: DEFAULT_EMAIL_LIMIT });
		
		if (summary) {
			await this.notifyOwner(summary, { force: true });
		}

		return { accountId, emails, skipOwnerNotification: true };
	}

	async handleSearchEmail(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for search_email");

		// Build search criteria from plan
		const criteria = {};
		if (typeof plan.subject === "string" && plan.subject.trim()) criteria.subject = plan.subject.trim();
		if (typeof plan.sender === "string" && plan.sender.trim()) criteria.sender = plan.sender.trim();
		if (typeof plan.content === "string" && plan.content.trim()) criteria.content = plan.content.trim();

		// If no search criteria provided, we can't search effectively
		if (Object.keys(criteria).length === 0) {
			throw new Error("search_email requires at least one search criterion (subject, sender, or content)");
		}

		const limit = Number.isInteger(plan.limit) ? plan.limit : DEFAULT_EMAIL_LIMIT;
		const seqnos = await this.emailService.searchEmailsForSeqno(accountId, criteria, limit);

		let results = [];
		if (seqnos && seqnos.length > 0) {
			// Fetch a batch of recent emails and filter by seqno for summary purposes
			const recent = await this.emailService.getRecentEmails(accountId, Math.max(25, limit));
			const set = new Set(seqnos);
			results = (recent || []).filter(e => set.has(e.seqno)).sort((a, b) => b.seqno - a.seqno);
		}

		const summary = EmailFormatter.formatEmailList(results, { 
			limit: DEFAULT_EMAIL_LIMIT, 
			includePreview: true 
		});
		
		// Send the summary to the owner
		if (summary) {
			await this.notifyOwner(summary, { force: true });
		}

		return { accountId, results, criteria, skipOwnerNotification: true };
	}

	async handleMarkSpam(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for mark_spam");

		const emailId = await this.resolveEmailIdentifier(accountId, plan);
		await this.emailService.markAsSpam(accountId, emailId);
		return { accountId, emailId };
	}

	async handleMarkRead(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for mark_read");

		const emailId = await this.resolveEmailIdentifier(accountId, plan);
		await this.emailService.markAsRead(accountId, emailId);
		return { accountId, emailId };
	}

	async handleMarkUnread(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for mark_unread");

		const emailId = await this.resolveEmailIdentifier(accountId, plan);
		await this.emailService.markAsUnread(accountId, emailId);
		return { accountId, emailId };
	}

	async handleDeleteEmail(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for delete_email");

		const emailId = await this.resolveEmailIdentifier(accountId, plan);
		await this.emailService.deleteEmail(accountId, emailId);
		return { accountId, emailId };
	}

	async handleMoveEmail(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for move_email");
		if (!plan.folder) throw new Error("move_email requires target folder");

		const emailId = await this.resolveEmailIdentifier(accountId, plan);
		await this.emailService.moveEmail(accountId, emailId, plan.folder);
		return { accountId, emailId, folder: plan.folder };
	}

	async handleUnsubscribeEmail(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for unsubscribe_email");

		const emailId = await this.resolveEmailIdentifier(accountId, plan);
		const info = await this.emailService.unsubscribeFromEmail(accountId, emailId);
		const summary = this.buildUnsubscribeSummary(info);
		if (summary) {
			await this.notifyOwner(summary, { force: true });
		}

		return { accountId, emailId, info, skipOwnerNotification: true };
	}

	async handleScheduleReminder(plan) {
		if (!this.schedulingService) {
			throw new Error("Scheduling service not configured");
		}

		const task = plan.task || plan.prompt || "Untitled reminder";
		const context = plan.context || "Scheduled follow-up";
		const category = plan.category || null;
		const delayMs = this.parseDelay(plan.when) ?? plan.delayMs ?? plan.delay_ms ?? 15 * 60 * 1000;

		const id = await this.schedulingService.scheduleWakeup(task, delayMs, context, category);
		return { task, delayMs, context, category, id };
	}

	async handleCheckReminders(plan) {
		if (!this.schedulingService) {
			throw new Error("Scheduling service not configured");
		}

		const reminders = await this.schedulingService.getPendingReminders();
		
		if (reminders.length === 0) {
			return { 
				success: true, 
				reminders: [], 
				message: "You have no upcoming reminders scheduled." 
			};
		}

		// Format reminders for Nova's response
		const formattedReminders = reminders.map(r => ({
			task: r.task,
			scheduledFor: r.scheduledFor,
			mergedCount: r.mergedCount,
			timeUntil: r.timeUntil,
			details: r.details || null
		}));

		return { 
			success: true, 
			reminders: formattedReminders,
			count: reminders.length,
			message: `You have ${reminders.length} upcoming reminder${reminders.length > 1 ? 's' : ''}.`
		};
	}

	// Helper method for scheduling daily summaries at 6 PM
	async scheduleDailySummary(task, category = "daily_summary") {
		if (!this.schedulingService) {
			throw new Error("Scheduling service not configured");
		}
		
		const delayMs = this.schedulingService.constructor.getDelayUntilSixPM();
		const context = "Daily summary";
		
		const id = await this.schedulingService.scheduleWakeup(task, delayMs, context, category);
		return { task, delayMs: delayMs, context, category, id };
	}

	async handleAddTask(plan) {
		if (!this.memory) {
			throw new Error("Memory service not configured");
		}

		const task = plan.task || plan.description;
		if (!task) throw new Error("add_task requires task description");

		await this.memory.addTask(task, plan.due_date || plan.dueDate, plan.priority || "medium");
		return { task, dueDate: plan.due_date || plan.dueDate, priority: plan.priority || "medium" };
	}

	async notifyOwnerIfNeeded(plan, handlerResult = {}) {
		if (!plan || !plan.response || !this.ownerNumber) return;
		if (handlerResult.skipOwnerNotification) return;

		// Skip notification if this is an email response to SMS (avoid loops)
		if (plan.action === 'send_email' && plan.to && plan.to.includes('@msg.fi.google.com')) {
			console.log('📧 Skipping owner notification to avoid SMS response loop');
			return;
		}

		await this.notifyOwner(plan.response);
	}

	async notifyOwner(message, { force = false } = {}) {
		if (!message || (!force && !this.ownerNumber)) return;
		
		if (!this.ownerNumber) {
			throw new Error("No owner number configured for notification");
		}

		try {
			// Send notification via email to Google Fi SMS gateway
			const googleFiEmail = `${this.ownerNumber}@msg.fi.google.com`;
			console.log(`📱 Sending owner notification via Google Fi gateway: ${googleFiEmail}`);
			
			await this.emailService.sendEmail({
				accountId: 'nova-sms',
				to: googleFiEmail,
				subject: '', // Blank subject for natural SMS-like conversation
				body: message
			});
			
			console.log(`✅ Owner notification sent: ${message.substring(0, 50)}...`);
		} catch (error) {
			console.error(`❌ Failed to send owner notification:`, error.message);
			// Don't throw - notification failures shouldn't break the main action
		}
	}

	buildUnsubscribeSummary(info) {
		if (!info) return "Unable to extract unsubscribe options.";

		const lines = [];
		if (info.subject) lines.push(`Subject: ${info.subject}`);
		if (info.from) lines.push(`From: ${info.from}`);
		if (info.listUnsubscribe) lines.push(`List-Unsubscribe: ${info.listUnsubscribe}`);
		if (info.links && info.links.length > 0) {
			lines.push("Links:");
			info.links.slice(0, 3).forEach((link, idx) => {
				lines.push(`  ${idx + 1}. ${link}`);
			});
		}

		return lines.join("\n");
	}

	parseDelay(text) {
		if (!text || typeof text !== "string") return null;

		// Handle specific times like "6pm", "18:00", "9am"
		const timePattern = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
		const timeMatch = text.toLowerCase().match(timePattern);
		if (timeMatch) {
			let hour = parseInt(timeMatch[1]);
			const minute = parseInt(timeMatch[2] || "0");
			const period = timeMatch[3]?.toLowerCase();
			
			// Convert to 24-hour format
			if (period === "pm" && hour !== 12) hour += 12;
			if (period === "am" && hour === 12) hour = 0;
			
			// Import SchedulingService to use the time helper
			return SchedulingService.getDelayUntilTime(hour, minute);
		}
		
		// Handle relative delays like "2 hours", "30 minutes"
		const pattern = /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month)s?/i;
		const match = text.match(pattern);
		if (match) {
			const value = parseFloat(match[1]);
			const unit = match[2].toLowerCase();
			const multipliers = {
				second: 1000,
				minute: 60 * 1000,
				hour: 60 * 60 * 1000,
				day: 24 * 60 * 60 * 1000,
				week: 7 * 24 * 60 * 60 * 1000,
				month: 30 * 24 * 60 * 60 * 1000,
			};
			return Math.round(value * (multipliers[unit] || multipliers.minute));
		}

		const minutes = parseInt(text, 10);
		if (!Number.isNaN(minutes)) {
			return minutes * 60 * 1000;
		}

		return null;
	}

	async resolveEmailIdentifier(accountId, plan) {
		// Simple, direct email resolution - LLM should provide clean criteria
		const criteria = {};
		
		// Only accept standard, clear field names
		if (plan.subject) criteria.subject = plan.subject;
		if (plan.sender) criteria.sender = plan.sender;
		if (plan.content) criteria.content = plan.content;
		
		// Accept sequence number directly if provided
		if (plan.emailId && typeof plan.emailId === 'number') {
			return plan.emailId;
		}

		if (Object.keys(criteria).length === 0) {
			throw new Error("Need email identification: provide 'subject', 'sender', or 'content' fields");
		}

		// Use email service search - let the logic layer handle the actual search
		const results = await this.emailService.searchEmailsForSeqno(accountId, criteria, 1);
		if (!results || results.length === 0) {
			throw new Error(`No email found matching criteria: ${JSON.stringify(criteria)}`);
		}

		console.log(`📧 Found email with seqno ${results[0]} using criteria:`, criteria);
		return results[0];
	}

	resolveAccountId(accountName) {
		// Simple account validation - LLM must provide exact account name
		if (!accountName || typeof accountName !== "string") {
			const available = this.emailService?.listAccounts()?.map(a => a.id) || [];
			throw new Error(`Account required. Available: ${available.join(', ')}`);
		}

		const accounts = this.emailService?.listAccounts() || [];
		const validAccount = accounts.find(a => a.id === accountName);
		if (!validAccount) {
			const available = accounts.map(a => a.id);
			throw new Error(`Account "${accountName}" not found. Available: ${available.join(', ')}`);
		}

		return accountName;
	}

	isOwner(number) {
		return number && this.ownerNumber && number.toString() === this.ownerNumber.toString();
	}
}

