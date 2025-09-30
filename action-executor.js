const DEFAULT_EMAIL_LIMIT = 5;

function normalizePhone(value) {
	return value ? value.replace(/[^0-9+]/g, "") : "";
}

export default class ActionExecutor {
	constructor({ emailService, memory, schedulingService, logger = console } = {}) {
		this.emailService = emailService;
		this.memory = memory;
		this.schedulingService = schedulingService;
		this.logger = logger;

		this.ownerNumber = process.env.MY_NUMBER;

		this.actionHandlers = {
			send_email: this.handleSendEmail.bind(this),
			check_email: this.handleCheckEmail.bind(this),
			search_email: this.handleSearchEmail.bind(this),
			mark_spam: this.handleMarkSpam.bind(this),
			mark_read: this.handleMarkRead.bind(this),
			mark_unread: this.handleMarkUnread.bind(this),
			delete_email: this.handleDeleteEmail.bind(this),
			move_email: this.handleMoveEmail.bind(this),
			unsubscribe_email: this.handleUnsubscribeEmail.bind(this),
			schedule_reminder: this.handleScheduleReminder.bind(this),
			add_task: this.handleAddTask.bind(this),
			check_calendar: this.handleUnsupportedAction.bind(this, "Calendar checks are not implemented yet."),
			web_search: this.handleUnsupportedAction.bind(this, "Web search is not available in this build."),
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

	async handleCheckEmail(plan) {
		const accountId = this.resolveAccountId(plan.account);
		if (!accountId) throw new Error("No email account available for check_email");

		const limit = Number.isInteger(plan.limit) ? plan.limit : DEFAULT_EMAIL_LIMIT;
		const emails = await this.emailService.getRecentEmails(accountId, limit);

		const summary = this.summarizeEmails(emails);
		
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

		const summary = this.summarizeEmails(results, { includePreview: true });
		
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

	async handleUnsupportedAction(message, plan) {
		await this.notifyOwner(message || "Action not available", { force: true });
		return { warning: message, skipOwnerNotification: true };
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
				subject: 'Nova Update',
				body: message
			});
			
			console.log(`✅ Owner notification sent: ${message.substring(0, 50)}...`);
		} catch (error) {
			console.error(`❌ Failed to send owner notification:`, error.message);
			// Don't throw - notification failures shouldn't break the main action
		}
	}



	summarizeEmails(emails = [], { includePreview = false } = {}) {
		if (!emails || emails.length === 0) {
			return "No matching emails found.";
		}

		const lines = emails.slice(0, DEFAULT_EMAIL_LIMIT).map((email) => {
			const subject = email.subject || "(no subject)";
			const from = email.from || "unknown sender";
			const dateLabel = email.date ? new Date(email.date).toLocaleString() : "unknown date";
			let line = `• ${subject} — ${from} (${dateLabel}) [${email.seqno ?? "?"}]`;
			if (includePreview && email.text) {
				const preview = email.text.replace(/\s+/g, " ").trim().slice(0, 120);
				if (preview) {
					line += `\n    ${preview}${preview.length === 120 ? "…" : ""}`;
				}
			}
			return line;
		});

		return lines.join("\n");
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
		const candidateKeys = [
			"emailId",
			"emailID",
			"email_id",
			"uid",
			"messageId",
			"message_id",
		];

		const fallbackStrings = [];

		for (const key of candidateKeys) {
			if (Object.prototype.hasOwnProperty.call(plan, key)) {
				const raw = plan[key];
				const parsed = this.parseEmailSequence(raw);
				if (parsed !== null) {
					return parsed;
				}
				if (typeof raw === "string" && raw.trim()) {
					fallbackStrings.push(raw.trim());
				}
			}
		}

		const criteria = {};
		const addCriterion = (field, value) => {
			if (typeof value === "string" && value.trim()) {
				const trimmed = value.trim();
				if (!criteria[field]) {
					criteria[field] = trimmed;
				}
			}
		};

		addCriterion("subject", plan.subject);
		addCriterion("subject", plan.subject_line);
		addCriterion("subject", plan.emailSubject);
		addCriterion("subject", plan.title);
		
		addCriterion("sender", plan.sender);
		addCriterion("sender", plan.from);
		addCriterion("sender", plan.author);
		addCriterion("sender", plan.fromEmail);
		addCriterion("sender", plan.fromAddress);
		
		addCriterion("content", plan.content);
		addCriterion("content", plan.snippet);
		addCriterion("content", plan.body);
		addCriterion("content", plan.preview);
		addCriterion("content", plan.text);
		// Note: removed plan.message as it's now plan.response and shouldn't be used for search criteria

		if (Object.keys(criteria).length === 0 && fallbackStrings.length > 0) {
			const fallback = fallbackStrings[0];
			
			if (this.looksLikeSender(fallback)) {
				criteria.sender = fallback;
			} else if (this.looksLikeSubject(fallback)) {
				criteria.subject = fallback;
			} else {
				criteria.content = fallback;
			}
		}

		if (Object.keys(criteria).length === 0) {
			throw new Error("Need email identification (emailId, subject, sender, or content)");
		}

		// Use simple sequence number search - sufficient for all email operations
		const directResults = await this.emailService.searchEmailsForSeqno(accountId, criteria, 3);
		if (!directResults || directResults.length === 0) {
			throw new Error("Unable to locate email matching the provided criteria");
		}

		console.log(`📧 Found ${directResults.length} matches, using seqno ${directResults[0]}`);
		return directResults[0];
	}

	parseEmailSequence(value) {
		if (value === undefined || value === null) return null;
		const trimmed = String(value).trim();
		if (!trimmed) return null;
		if (/^\d+$/.test(trimmed)) {
			return Number.parseInt(trimmed, 10);
		}
		return null;
	}

	looksLikeSender(text) {
		if (!text || typeof text !== "string") return false;
		const normalized = text.toLowerCase();
		
		// Contains @ symbol (email address)
		if (normalized.includes("@")) return true;
		
		// Common sender patterns
		const senderPatterns = [
			/^from\s+/i,
			/\b(sent by|from|by)\b/i,
			/\b(support|service|team|noreply|no-reply)\b/i,
		];
		
		return senderPatterns.some(pattern => pattern.test(text));
	}

	looksLikeSubject(text) {
		if (!text || typeof text !== "string") return false;
		const normalized = text.toLowerCase();
		
		// Subject-like patterns
		const subjectPatterns = [
			/^(re:|fwd?:|subject:)/i,
			/\b(urgent|important|meeting|reminder|invoice|receipt|confirmation)\b/i,
			/^[A-Z][a-z]+\s+(meeting|call|update|report)/i,
		];
		
		return subjectPatterns.some(pattern => pattern.test(text));
	}

	extractEmailCriteria(text) {
		if (!text || typeof text !== "string") return {};
		
		const criteria = {};
		const normalized = text.toLowerCase();
		
		// Extract sender from common patterns
		const senderMatches = [
			/\bfrom\s+([a-zA-Z][\w\s@.-]+?)(?:\s+(?:in|out|from|to|about|regarding)|$)/i,
			/\b(?:email|message)\s+from\s+([a-zA-Z][\w\s@.-]+?)(?:\s|$)/i,
			/\bsender[:\s]+([a-zA-Z][\w\s@.-]+?)(?:\s|$)/i,
		];
		
		for (const pattern of senderMatches) {
			const match = text.match(pattern);
			if (match && match[1]) {
				const sender = match[1].trim();
				if (sender.length > 0 && sender.length < 50) {
					criteria.sender = sender;
					break;
				}
			}
		}
		
		// Extract subject from common patterns
		const subjectMatches = [
			/\b(?:subject|titled?|about|regarding)[:\s]+"([^"]+)"/i,
			/\b(?:subject|titled?|about|regarding)[:\s]+([^,.\n]+)/i,
			/\bemail\s+titled?\s+"([^"]+)"/i,
		];
		
		for (const pattern of subjectMatches) {
			const match = text.match(pattern);
			if (match && match[1]) {
				const subject = match[1].trim();
				if (subject.length > 0 && subject.length < 100) {
					criteria.subject = subject;
					break;
				}
			}
		}
		
		return criteria;
	}

	resolveAccountId(preferred) {
		const accounts = this.emailService?.accounts || [];
		if (accounts.length === 0) {
			return null;
		}

		if (!preferred || typeof preferred !== "string") {
			throw new Error("No email account specified. Available accounts: " + accounts.map(a => a.id).join(', '));
		}

		const normalized = preferred.trim().toLowerCase();
		if (!normalized) {
			throw new Error("No email account specified. Available accounts: " + accounts.map(a => a.id).join(', '));
		}

		// Try to find exact match by email or ID
		for (const account of accounts) {
			if (account.id.toLowerCase() === normalized) {
				return account.id;
			}
			if (account.email && account.email.toLowerCase() === normalized) {
				return account.id;
			}
		}

		// No fallback - require exact match
		throw new Error(`Email account "${preferred}" not found. Available accounts: ${accounts.map(a => a.id).join(', ')}`);
	}

	isOwner(number) {
		return number && this.ownerNumber && number.toString() === this.ownerNumber.toString();
	}
}

