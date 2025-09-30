/**
 * Centralized email formatting utilities
 * Eliminates duplicate context building and formatting across the codebase
 */

class EmailFormatter {
  
  /**
   * Clean email content by removing technical headers and boundaries
   */
  static cleanEmailContent(text) {
    if (!text) return 'No content available';
    return text
      .replace(/--[0-9a-f]+/g, '')
      .replace(/Content-Type:[^\n]+/g, '')
      .replace(/boundary="[^"]*"/g, '')
      .trim();
  }

  /**
   * Format single email for display
   */
  static formatSingleEmail(email, options = {}) {
    const { includePreview = false, maxPreviewLength = 120 } = options;
    
    const subject = email.subject || "(no subject)";
    const from = email.from || "unknown sender";
    const dateLabel = email.date ? new Date(email.date).toLocaleString() : "unknown date";
    
    let formatted = `• ${subject} — ${from} (${dateLabel})`;
    
    if (email.seqno) {
      formatted += ` [${email.seqno}]`;
    }
    
    if (includePreview && email.text) {
      const cleanContent = this.cleanEmailContent(email.text);
      const preview = cleanContent.replace(/\s+/g, " ").trim().slice(0, maxPreviewLength);
      if (preview) {
        formatted += `\n    ${preview}${preview.length === maxPreviewLength ? "…" : ""}`;
      }
    }
    
    return formatted;
  }

  /**
   * Format email list for summaries
   */
  static formatEmailList(emails, options = {}) {
    if (!emails || emails.length === 0) {
      return "No emails found.";
    }

    const { limit = 10, includePreview = false } = options;
    
    return emails
      .slice(0, limit)
      .map(email => this.formatSingleEmail(email, { includePreview }))
      .join("\n");
  }

  /**
   * Format email thread for conversation display
   */
  static formatEmailThread(emailThread) {
    if (!emailThread || emailThread.length === 0) {
      return "No emails in thread.";
    }

    const latestEmail = emailThread[emailThread.length - 1];
    const threadSubject = latestEmail.subject;
    
    let formatted = `=== EMAIL CONVERSATION THREAD ===\n`;
    formatted += `Subject: ${threadSubject}\n`;
    formatted += `Total Messages: ${emailThread.length}\n\n`;
    
    emailThread.forEach((email, index) => {
      formatted += `--- Message ${index + 1} ---\n`;
      formatted += `From: ${email.from}\n`;
      formatted += `Date: ${email.date}\n`;
      formatted += `Content: ${this.cleanEmailContent(email.text)}\n\n`;
    });
    
    return formatted;
  }

  /**
   * Build context for incoming email processing
   */
  static buildIncomingEmailContext(email, accountId) {
    if (email.isThread) {
      return `EMAIL CONVERSATION THREAD RECEIVED in ${accountId} account:
Subject: ${email.subject}
Thread Length: ${email.threadLength} messages
Conversation:
${email.text}

AUTONOMOUS EMAIL PROCESSING: You can take these actions:
1. NOTIFY_OWNER: Notify Stephen about this email conversation with details
2. MARK_SPAM: Mark this email thread as spam if it's clearly promotional/unwanted
3. SCHEDULE_REMINDER: Schedule yourself to follow up on this conversation later, at a suitable time for Stephen

Examples of good actions:
- MARK_SPAM for obvious junk/promotional email threads
- NOTIFY_OWNER for important conversations that need immediate attention
- SCHEDULE_REMINDER for conversations that need follow-up but aren't urgent

Analyze this email conversation and decide the best action with clear reasoning.`;
    } else {
      const cleanContent = this.cleanEmailContent(email.text).substring(0, 500);
      
      return `NEW EMAIL RECEIVED in ${accountId} account:
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}
Content: ${cleanContent}

AUTONOMOUS EMAIL PROCESSING: You can take these actions:
1. NOTIFY_OWNER: Notify Stephen about this email with details
2. MARK_SPAM: Mark this email as spam if it's clearly promotional/unwanted
3. SCHEDULE_REMINDER: Schedule yourself to follow up on this email later, at a suitable time for Stephen

Examples of good actions:
- MARK_SPAM for obvious junk/promotional emails
- NOTIFY_OWNER for important emails that need immediate attention
- SCHEDULE_REMINDER for emails that need follow-up but aren't urgent

Analyze this email and decide the best action with clear reasoning.`;
    }
  }

  /**
   * Build context summary for recent emails across accounts
   */
  static buildRecentEmailContext(accountsData) {
    if (!accountsData || accountsData.length === 0) {
      return null;
    }

    const sections = accountsData
      .filter(account => account.emails && account.emails.length > 0)
      .map(account => {
        const emailList = account.emails.map((email, index) => {
          const from = email.from || 'Unknown';
          const subject = email.subject || 'No Subject';
          const date = email.date ? new Date(email.date).toLocaleDateString() : 'Unknown Date';
          return `${index + 1}. From: ${from} | Subject: "${subject}" | Date: ${date}`;
        }).join('\n');
        
        return `${account.accountId.toUpperCase()} ACCOUNT:\n${emailList}`;
      });

    return sections.length > 0 ? sections.join('\n\n') : null;
  }
}

export default EmailFormatter;