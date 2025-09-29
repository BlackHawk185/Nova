import twilio from 'twilio';

class TwilioPollingService {
  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.client = accountSid && authToken ? twilio(accountSid, authToken) : null;
    this.myNumber = process.env.MY_NUMBER;
    this.lastMessageSid = null;
    this.pollingInterval = null;
    this.messageCallback = null;
  }

  setMessageCallback(callback) {
    this.messageCallback = callback;
  }

  async startPolling(intervalMs = 10000) {
    if (!this.client) {
      console.log('🔇 Twilio not configured - skipping message polling');
      return;
    }

    console.log(`📱 Starting Twilio message polling (${intervalMs/1000}s intervals)`);
    
    // Get initial baseline
    try {
      const messages = await this.client.messages.list({ 
        to: this.myNumber,
        limit: 1 
      });
      
      if (messages.length > 0) {
        this.lastMessageSid = messages[0].sid;
        console.log(`📱 Polling baseline set: ${this.lastMessageSid}`);
      }
    } catch (error) {
      console.error('📱 Failed to set polling baseline:', error.message);
    }

    // Start polling
    this.pollingInterval = setInterval(() => {
      this.checkForNewMessages();
    }, intervalMs);
  }

  async checkForNewMessages() {
    if (!this.client) return;

    try {
      // Get messages sent to our number
      const messages = await this.client.messages.list({
        to: this.myNumber,
        limit: 10
      });

      // Find new messages (after our last processed message)
      const newMessages = [];
      for (const message of messages) {
        if (message.sid === this.lastMessageSid) break;
        newMessages.push(message);
      }

      // Process new messages in chronological order (oldest first)
      newMessages.reverse();
      
      for (const message of newMessages) {
        await this.processMessage(message);
        this.lastMessageSid = message.sid;
      }

    } catch (error) {
      console.error('📱 Polling error:', error.message);
    }
  }

  async processMessage(message) {
    const isWhatsApp = message.from.startsWith('whatsapp:');
    const cleanFrom = message.from.replace('whatsapp:', '');
    
    console.log(`📱 ${isWhatsApp ? 'WhatsApp' : 'SMS'} from ${message.from}: "${message.body}"`);

    // Only process messages from our number
    if (cleanFrom !== this.myNumber) {
      console.log(`❌ Ignoring message from unknown number: ${cleanFrom}`);
      return;
    }

    // Call the message callback if set
    if (this.messageCallback) {
      try {
        await this.messageCallback({
          body: message.body?.trim(),
          from: message.from,
          channel: isWhatsApp ? 'whatsapp' : 'sms',
          timestamp: message.dateCreated,
          sid: message.sid
        });
      } catch (error) {
        console.error('📱 Error processing message:', error.message);
      }
    }
  }

  stopPolling() {
    if (this.pollingInterval) {
      console.log('📱 Stopping Twilio message polling');
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}

export default TwilioPollingService;