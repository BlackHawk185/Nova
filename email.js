import nodemailer from 'nodemailer';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { google } from 'googleapis';

class UniversalEmailService {
  constructor() {
    this.accounts = this.loadAccounts();
    this.transporters = new Map();
    this.imapClients = new Map();
    this.idleConnections = new Map(); // Track IDLE connections
    this.emailCallback = null; // Callback for new emails
    this.oauth2Clients = new Map(); // OAuth2 clients for Google accounts
    this.isInitialized = false;
    
    console.log('✅ Universal email service initialized');
    
    // Don't auto-initialize - wait for explicit initialize() call
  }

  async initialize() {
    // Prevent multiple initializations
    if (this.isInitialized) {
      console.log('✅ Email service already initialized, skipping...');
      return;
    }
    
    try {
      // Initialize OAuth2 clients for Google accounts
      await this.initializeOAuthClients();
      
      // Start IDLE monitoring for all accounts
      await this.startEmailMonitoring();
      
      this.isInitialized = true;
      console.log('✅ Email service fully initialized and monitoring started');
    } catch (error) {
      console.error('❌ Failed to initialize email service:', error);
      throw error;
    }
  }

  /**
   * Initialize OAuth2 clients for Google Workspace accounts
   */
  async initializeOAuthClients() {
    for (const account of this.accounts) {
      if (account.authType === 'oauth2' && account.clientId) {
        try {
          const oauth2Client = new google.auth.OAuth2(
            account.clientId,
            account.clientSecret,
            'http://localhost:3000/oauth/callback'
          );
          
          if (account.refreshToken) {
            oauth2Client.setCredentials({
              refresh_token: account.refreshToken
            });
            
            // Get fresh access token
            const { credentials } = await oauth2Client.refreshAccessToken();
            oauth2Client.setCredentials(credentials);
            
            this.oauth2Clients.set(account.id, oauth2Client);
            console.log(`🔐 OAuth2 initialized for ${account.id}`);
          } else {
            console.warn(`⚠️ No refresh token for ${account.id} - OAuth setup needed`);
          }
        } catch (error) {
          console.error(`❌ OAuth2 setup failed for ${account.id}:`, error.message);
        }
      }
    }
  }

  /**
   * Load email accounts from environment variables
   */
  loadAccounts() {
    const accounts = [];
    
    // Check for up to 4 email accounts in .env
    for (let i = 1; i <= 4; i++) {
      const prefix = i === 1 ? '' : `_${i}`;
      
      const config = {
        id: process.env[`EMAIL${prefix}_ID`],
        name: process.env[`EMAIL${prefix}_NAME`],
        host: process.env[`EMAIL${prefix}_HOST`],
        port: parseInt(process.env[`EMAIL${prefix}_PORT`] || '993'),
        secure: process.env[`EMAIL${prefix}_SECURE`] !== 'false',
        user: process.env[`EMAIL${prefix}_USER`],
        pass: process.env[`EMAIL${prefix}_PASS`],
        smtpHost: process.env[`EMAIL${prefix}_SMTP_HOST`],
        smtpPort: parseInt(process.env[`EMAIL${prefix}_SMTP_PORT`] || '587'),
        smtpSecure: process.env[`EMAIL${prefix}_SMTP_SECURE`] === 'true',
        // OAuth2 fields
        authType: process.env[`EMAIL${prefix}_AUTH_TYPE`] || 'password',
        clientId: process.env[`EMAIL${prefix}_CLIENT_ID`],
        clientSecret: process.env[`EMAIL${prefix}_CLIENT_SECRET`],
        refreshToken: process.env[`EMAIL${prefix}_REFRESH_TOKEN`],
        // IMAP IDLE flag
        useIdle: process.env[`EMAIL${prefix}_USE_IDLE`] === 'true'
      };

      // Account is valid if it has either password auth or OAuth2 credentials
      const hasPasswordAuth = config.id && config.user && config.pass;
      const hasOAuth2 = config.id && config.user && config.clientId && config.clientSecret;
      
      if (hasPasswordAuth || hasOAuth2) {
        accounts.push(config);
        const authMethod = config.authType === 'oauth2' ? 'OAuth2' : 'Password';
        console.log(`📧 Loaded email account: ${config.id} (${config.user}) [${authMethod}]`);
      }
    }

    if (accounts.length === 0) {
      console.warn('⚠️ No email accounts configured. Add EMAIL_* variables to .env');
    }

    return accounts;
  }

  /**
   * Get SMTP transporter for an account
   */
  async getTransporter(accountId) {
    if (this.transporters.has(accountId)) {
      return this.transporters.get(accountId);
    }

    const account = this.accounts.find(acc => acc.id === accountId);
    if (!account) {
      throw new Error(`Email account '${accountId}' not found`);
    }

    let authConfig;
    
    if (account.authType === 'oauth2') {
      // OAuth2 authentication
      const oauth2Client = this.oauth2Clients.get(accountId);
      if (!oauth2Client) {
        throw new Error(`OAuth2 client not initialized for ${accountId}`);
      }
      
      const { credentials } = await oauth2Client.refreshAccessToken();
      
      authConfig = {
        type: 'OAuth2',
        user: account.user,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        refreshToken: account.refreshToken,
        accessToken: credentials.access_token
      };
    } else {
      // Password authentication
      authConfig = {
        user: account.user,
        pass: account.pass
      };
    }

    const transporter = nodemailer.createTransport({
      host: account.smtpHost || account.host,
      port: account.smtpPort || 587,
      secure: account.smtpSecure || false,
      auth: authConfig,
      tls: {
        rejectUnauthorized: false,
        servername: account.smtpHost || account.host
      }
    });

    this.transporters.set(accountId, transporter);
    return transporter;
  }

  /**
   * Send email from specified account
   */
  async sendEmail(options) {
    const { from, to, subject, body, html, priority = 'normal', accountId } = options;

    // Determine which account to use
    let selectedAccount;
    if (accountId) {
      selectedAccount = this.accounts.find(acc => acc.id === accountId);
    } else if (from) {
      // Try to match by email address
      selectedAccount = this.accounts.find(acc => acc.user.toLowerCase() === from.toLowerCase());
    }

    if (!selectedAccount) {
      throw new Error(`Cannot determine email account for: ${from || accountId}. Available accounts: ${this.accounts.map(a => a.id).join(', ')}`);
    }

    const transporter = await this.getTransporter(selectedAccount.id);

    const mailOptions = {
      from: `${selectedAccount.name || selectedAccount.user} <${selectedAccount.user}>`,
      to,
      subject,
      text: body,
      html: html || body,
      priority: priority === 'high' ? 'high' : 'normal'
    };

    try {
      const result = await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent via ${selectedAccount.id}: ${subject}`);
      return {
        success: true,
        messageId: result.messageId,
        account: selectedAccount.id,
        from: selectedAccount.user,
        to,
        subject
      };
    } catch (error) {
      console.error(`❌ Email send failed via ${selectedAccount.id}:`, error.message);
      throw error;
    }
  }

  /**
   * Get IMAP client for an account
   */
  async getImapClient(accountId) {
    const account = this.accounts.find(acc => acc.id === accountId);
    if (!account) {
      throw new Error(`Email account '${accountId}' not found`);
    }

    let imapConfig = {
      host: account.host,
      port: account.port,
      tls: account.secure,
      user: account.user,
      tlsOptions: {
        rejectUnauthorized: false,
        servername: account.host
      }
    };

    if (account.authType === 'oauth2') {
      // OAuth2 authentication for IMAP
      const oauth2Client = this.oauth2Clients.get(accountId);
      if (!oauth2Client) {
        throw new Error(`OAuth2 client not initialized for ${accountId}`);
      }
      
      const { credentials } = await oauth2Client.refreshAccessToken();
      
      // Use proper XOAUTH2 format with Base64 encoding
      const authString = `user=${account.user}\x01auth=Bearer ${credentials.access_token}\x01\x01`;
      imapConfig.xoauth2 = Buffer.from(authString).toString('base64');
    } else {
      // Password authentication
      imapConfig.password = account.pass;
    }

    return new Imap(imapConfig);
  }

  /**
   * Get available folders for an account
   */
  async getAvailableFolders(accountId) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);

      imap.once('ready', () => {
        imap.getBoxes((err, boxes) => {
          imap.end();
          if (err) {
            console.error(`📧 Error getting folders:`, err);
            return reject(err);
          }
          
          // Flatten the folder structure into a simple list
          const flattenFolders = (boxObj, prefix = '') => {
            const folders = [];
            for (const [name, box] of Object.entries(boxObj)) {
              const fullName = prefix ? `${prefix}${box.delimiter || '.'}${name}` : name;
              folders.push({
                name: fullName,
                displayName: name,
                hasChildren: box.children && Object.keys(box.children).length > 0,
                special: box.special_use || null
              });
              
              // Recursively get child folders
              if (box.children) {
                folders.push(...flattenFolders(box.children, fullName));
              }
            }
            return folders;
          };

          const folders = flattenFolders(boxes);
          console.log(`📧 Found ${folders.length} folders for ${accountId}`);
          resolve(folders);
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Read recent emails from specified account
   */
  async getRecentEmails(accountId, limit = 10) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);
      const emails = [];

      // Only log if needed for debugging
      // console.log(`📧 Connecting to IMAP for account: ${accountId}`);

      imap.once('ready', () => {
        // console.log(`📧 IMAP connected, opening INBOX`);
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX:`, err);
            return reject(err);
          }

          // console.log(`📧 INBOX opened, total messages: ${box.messages.total}`);
          
          if (box.messages.total === 0) {
            // console.log(`📧 No messages in inbox`);
            imap.end();
            return resolve([]);
          }

          const total = box.messages.total;
          const start = Math.max(1, total - limit + 1);
          const range = `${start}:${total}`;
          
          // console.log(`📧 Fetching messages in range: ${range}`);

          const fetch = imap.seq.fetch(range, {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
            struct: true
          });

          fetch.on('message', (msg, seqno) => {
            // console.log(`📧 Processing message ${seqno}`);
            let email = { seqno };
            let headers = {};
            let textBody = '';
            
            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk.toString();
              });
              stream.once('end', () => {
                if (info.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE)') {
                  // Parse headers
                  const lines = buffer.split('\n');
                  lines.forEach(line => {
                    const [key, ...value] = line.split(': ');
                    if (key && value.length) {
                      headers[key.toLowerCase()] = value.join(': ').trim();
                    }
                  });
                } else if (info.which === 'TEXT') {
                  // Store text content
                  textBody = buffer;
                }
              });
            });

            msg.once('end', () => {
              emails.push({
                from: headers.from,
                to: headers.to,
                subject: headers.subject,
                date: new Date(headers.date),
                text: textBody,
                seqno: seqno
              });
            });
          });

          fetch.once('end', () => {
            // Only log when we actually find emails
            // console.log(`📧 Fetch complete, found ${emails.length} emails`);
            imap.end();
            resolve(emails.sort((a, b) => b.seqno - a.seqno)); // Most recent first
          });

          fetch.once('error', (err) => {
            console.error(`📧 Fetch error:`, err);
            imap.end();
            reject(err);
          });
        });
      });

      imap.once('error', (err) => {
        console.error(`📧 IMAP connection error:`, err);
        reject(err);
      });

      imap.connect();
    });
  }

  /**
   * List all configured accounts
   */
  listAccounts() {
    return this.accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      email: acc.user
    }));
  }

  /**
   * Determine best account for sending based on context
   */
  selectAccountForContext(context = '') {
    const contextLower = context.toLowerCase();
    
    // Simple heuristics - you can customize these
    if (contextLower.includes('work') || contextLower.includes('business')) {
      const workAccount = this.accounts.find(acc => 
        acc.id.toLowerCase().includes('work') || 
        acc.id.toLowerCase().includes('business')
      );
      if (workAccount) return workAccount;
    }
    
    if (contextLower.includes('side') || contextLower.includes('hustle')) {
      const sideAccount = this.accounts.find(acc => 
        acc.id.toLowerCase().includes('side') || 
        acc.id.toLowerCase().includes('hustle')
      );
      if (sideAccount) return sideAccount;
    }
    
    // No fallback - require explicit account selection
    throw new Error(`Cannot determine email account for context: "${context}". Available accounts: ${this.accounts.map(a => a.id).join(', ')}`);
  }

  /**
   * Mark email as read by UID or sequence number
   */
  async markAsRead(accountId, emailId) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);

      console.log(`📧 Marking email ${emailId} as read in account: ${accountId}`);

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX:`, err);
            return reject(err);
          }

          imap.addFlags(emailId, ['\\Seen'], (err) => {
            imap.end();
            if (err) {
              console.error(`📧 Error marking as read:`, err);
              return reject(err);
            }
            console.log(`📧 Email ${emailId} marked as read`);
            resolve(true);
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Mark email as unread by UID or sequence number
   */
  async markAsUnread(accountId, emailId) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);

      console.log(`📧 Marking email ${emailId} as unread in account: ${accountId}`);

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX:`, err);
            return reject(err);
          }

          imap.delFlags(emailId, ['\\Seen'], (err) => {
            imap.end();
            if (err) {
              console.error(`📧 Error marking as unread:`, err);
              return reject(err);
            }
            console.log(`📧 Email ${emailId} marked as unread`);
            resolve(true);
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Delete email by moving to Trash or marking as deleted
   */
  async deleteEmail(accountId, emailId) {
    return new Promise(async (resolve, reject) => {
      let imap;
      try {
        imap = await this.getImapClient(accountId);
        console.log(`📧 Deleting email ${emailId} in account: ${accountId}`);

        imap.once('ready', () => {
          imap.openBox('INBOX', false, (err, box) => {
            if (err) {
              console.error(`📧 Error opening INBOX:`, err);
              imap.end();
              return reject(err);
            }

            console.log(`📧 INBOX opened, total messages: ${box.messages.total}`);

            // First, verify the email exists
            const fetch = imap.seq.fetch(emailId, { bodies: 'HEADER.FIELDS (SUBJECT)' });
            
            fetch.on('message', (msg, seqno) => {
              console.log(`📧 Found email ${seqno} to delete`);
              
              // For Gmail, move to [Gmail]/Trash instead of expunging
              if (this.accounts.find(acc => acc.id === accountId)?.host?.includes('gmail')) {
                console.log(`📧 Gmail detected, moving to [Gmail]/Trash...`);
                imap.move(emailId, '[Gmail]/Trash', (moveErr) => {
                  if (moveErr) {
                    console.error(`📧 Error moving Gmail email to trash:`, moveErr);
                    // Fallback: try marking as deleted and expunging
                    imap.addFlags(emailId, ['\\Deleted'], (flagErr) => {
                      if (flagErr) {
                        console.error(`📧 Error marking Gmail email as deleted:`, flagErr);
                        imap.end();
                        return reject(flagErr);
                      }
                      
                      console.log(`📧 Email ${emailId} marked as deleted, expunging...`);
                      imap.expunge((expErr) => {
                        if (expErr) {
                          console.error(`📧 Error expunging Gmail email:`, expErr);
                          imap.end();
                          return reject(expErr);
                        }
                        console.log(`📧 Gmail email ${emailId} deleted (expunged as fallback)`);
                        imap.end();
                        resolve(true);
                      });
                    });
                  } else {
                    console.log(`📧 Gmail email ${emailId} moved to [Gmail]/Trash`);
                    imap.end();
                    resolve(true);
                  }
                });
              } else {
                // For other providers, try moving to trash first
                const trashFolders = ['Trash', 'INBOX.Trash', '[Gmail]/Trash', 'Deleted Items'];
                
                const tryMoveToTrash = (folders, index = 0) => {
                  if (index >= folders.length) {
                    // No trash folder found, mark as deleted and expunge
                    console.log(`📧 No trash folder found, marking as deleted and expunging...`);
                    imap.addFlags(emailId, ['\\Deleted'], (flagErr) => {
                      if (flagErr) {
                        console.error(`📧 Error marking as deleted:`, flagErr);
                        imap.end();
                        return reject(flagErr);
                      }
                      
                      imap.expunge((expErr) => {
                        if (expErr) {
                          console.error(`📧 Error expunging:`, expErr);
                          imap.end();
                          return reject(expErr);
                        }
                        console.log(`📧 Email ${emailId} deleted (expunged)`);
                        imap.end();
                        resolve(true);
                      });
                    });
                    return;
                  }

                  console.log(`📧 Trying to move to trash folder: ${folders[index]}`);
                  imap.move(emailId, folders[index], (moveErr) => {
                    if (moveErr) {
                      console.log(`📧 Failed to move to ${folders[index]}: ${moveErr.message}`);
                      // Try next folder
                      tryMoveToTrash(folders, index + 1);
                    } else {
                      console.log(`📧 Email ${emailId} moved to trash: ${folders[index]}`);
                      imap.end();
                      resolve(true);
                    }
                  });
                };

                tryMoveToTrash(trashFolders);
              }
            });

            fetch.on('error', (fetchErr) => {
              console.error(`📧 Error fetching email ${emailId}:`, fetchErr);
              imap.end();
              reject(fetchErr);
            });

            fetch.on('end', () => {
              // If no messages were found
              console.log(`📧 Fetch completed for email ${emailId}`);
            });
          });
        });

        imap.once('error', (imapErr) => {
          console.error(`📧 IMAP error during delete:`, imapErr);
          if (imap) imap.end();
          reject(imapErr);
        });

        imap.connect();
      } catch (error) {
        console.error(`📧 Error creating IMAP client for delete:`, error);
        if (imap) imap.end();
        reject(error);
      }
    });
  }

  /**
   * Move email to spam/junk folder
   */
  async markAsSpam(accountId, emailId) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);

      console.log(`📧 Marking email ${emailId} as spam in account: ${accountId}`);

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX:`, err);
            return reject(err);
          }

          // Simple approach: try common spam folder names in order
          const spamFolders = ['Spam', 'Junk', 'INBOX.Spam', 'INBOX.Junk', '[Gmail]/Spam'];
          
          const tryMoveToSpam = (folders, index = 0) => {
            if (index >= folders.length) {
              // No spam folder found, just mark as deleted
              imap.addFlags(emailId, ['\\Deleted'], (flagErr) => {
                if (flagErr) {
                  imap.end();
                  console.error(`📧 Error marking spam as deleted:`, flagErr);
                  return reject(flagErr);
                }
                
                imap.expunge((expErr) => {
                  imap.end();
                  if (expErr) {
                    console.error(`📧 Error expunging spam:`, expErr);
                    return reject(expErr);
                  }
                  console.log(`📧 Email ${emailId} marked as spam (deleted)`);
                  resolve(true);
                });
              });
              return;
            }

            imap.move(emailId, folders[index], (err) => {
              if (err) {
                // Try next folder
                tryMoveToSpam(folders, index + 1);
              } else {
                imap.end();
                console.log(`📧 Email ${emailId} moved to spam folder: ${folders[index]}`);
                resolve(true);
              }
            });
          };

          tryMoveToSpam(spamFolders);
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Move email to a specific folder
   */
  async moveEmail(accountId, emailId, folder) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);

      console.log(`📧 Moving email ${emailId} to folder ${folder} in account: ${accountId}`);

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX:`, err);
            return reject(err);
          }

          imap.move(emailId, folder, (err) => {
            imap.end();
            if (err) {
              console.error(`📧 Error moving to folder:`, err);
              return reject(err);
            }
            console.log(`📧 Email ${emailId} moved to ${folder}`);
            resolve(true);
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Smart unsubscribe - finds and clicks unsubscribe links or replies with UNSUBSCRIBE
   */
  async unsubscribeFromEmail(accountId, emailId) {
    return new Promise(async (resolve, reject) => {
      const imap = this.getImapClient(accountId);

      console.log(`📧 Getting full email content for unsubscribe: ${emailId} in account: ${accountId}`);

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX:`, err);
            return reject(err);
          }

          // Fetch full email content
          const fetch = imap.seq.fetch(emailId, {
            bodies: '',
            struct: true
          });

          fetch.on('message', (msg) => {
            let emailContent = '';
            
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => {
                emailContent += chunk.toString();
              });
              
              stream.once('end', async () => {
                try {
                  const parsed = await simpleParser(emailContent);
                  
                  // Look for unsubscribe links and information
                  const unsubscribeInfo = this.findUnsubscribeOptions(parsed);
                  
                  imap.end();
                  resolve(unsubscribeInfo);
                } catch (parseErr) {
                  console.error('📧 Error parsing email for unsubscribe:', parseErr);
                  imap.end();
                  reject(parseErr);
                }
              });
            });
          });

          fetch.once('error', (err) => {
            console.error(`📧 Fetch error:`, err);
            imap.end();
            reject(err);
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  /**
   * Find unsubscribe options in email content
   */
  findUnsubscribeOptions(parsedEmail) {
    const unsubscribeOptions = {
      links: [],
      listUnsubscribe: null,
      replyTo: null,
      from: parsedEmail.from?.text || parsedEmail.from,
      subject: parsedEmail.subject
    };

    // Check List-Unsubscribe header (RFC standard)
    if (parsedEmail.headers && parsedEmail.headers['list-unsubscribe']) {
      unsubscribeOptions.listUnsubscribe = parsedEmail.headers['list-unsubscribe'];
      console.log('📧 Found List-Unsubscribe header:', unsubscribeOptions.listUnsubscribe);
    }

    // Search email content for unsubscribe links
    const content = parsedEmail.html || parsedEmail.text || '';
    const linkRegex = /https?:\/\/[^\s<>"']+(?:unsubscribe|opt-out|remove)[^\s<>"']*/gi;
    const matches = content.match(linkRegex);
    
    if (matches) {
      unsubscribeOptions.links = [...new Set(matches)]; // Remove duplicates
      console.log('📧 Found unsubscribe links:', unsubscribeOptions.links);
    }

    // Look for unsubscribe text patterns
    const unsubPatterns = [
      /unsubscribe/gi,
      /opt-out/gi,
      /remove.*list/gi,
      /stop.*email/gi
    ];

    const hasUnsubscribeText = unsubPatterns.some(pattern => pattern.test(content));
    if (hasUnsubscribeText) {
      console.log('📧 Found unsubscribe text in email');
    }

    return unsubscribeOptions;
  }

  /**
   * Set callback for new email notifications
   */
  setEmailCallback(callback) {
    this.emailCallback = callback;
  }

  /**
   * Start email monitoring for all email accounts using IMAP IDLE
   */
  startEmailMonitoring() {
    console.log('📧 Starting IMAP IDLE monitoring for all accounts...');
    
    this.accounts.forEach(account => {
      console.log(`📧 Using IMAP IDLE for ${account.id} (real-time)`);
      this.startIdleForAccount(account.id);
    });
  }

  /**
   * Handle new email notification - updated to accept email object
   */
  async handleNewEmail(accountId, numNewMsgs, emailObj = null) {
    try {
      console.log(`📧 Processing ${numNewMsgs} new email(s) from ${accountId}`);
      let emails = [];
      if (emailObj) {
        emails = [emailObj];
      } else {
        emails = await this.getRecentEmails(accountId, numNewMsgs);
      }
      if (emails.length > 0 && this.emailCallback) {
        for (const email of emails) {
          console.log(`📧 Processing email: From="${email.from}" Subject="${email.subject}" Account="${accountId}"`);
          
          // Special handling for nova-sms: only process SMS-gateway messages
          if (accountId === 'nova-sms') {
            // Accept only Google Fi SMS gateway or whitelisted senders
            const from = (email.from || '').toLowerCase();
            console.log(`📧 Checking nova-sms filter: from="${from}"`);
            
            if (from.endsWith('@msg.fi.google.com') || from.includes('sms gateway') || from.includes('msg.fi.google.com')) {
              console.log(`📧 ✅ SMS message accepted from ${email.from}`);
              await this.emailCallback({
                accountId,
                email,
                type: 'new_message',
                channel: 'inbox'
              });
            } else {
              console.log(`📧 ❌ Ignoring non-SMS email in nova-sms inbox: from=${email.from}`);
            }
          } else {
            // Normal email processing for other accounts
            console.log(`📧 ✅ Regular email processing for ${accountId}`);
            await this.emailCallback({
              accountId,
              email,
              type: 'new_email',
              channel: accountId
            });
          }
        }
      } else {
        console.log(`📧 No emails to process or no callback set (emails: ${emails.length}, callback: ${!!this.emailCallback})`);
      }
    } catch (error) {
      console.error(`📧 Error handling new email for ${accountId}:`, error);
    }
  }

  /**
   * Start IMAP IDLE for real-time email detection (for accounts with USE_IDLE=true)
   */
  startIdleForAccount(accountId) {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) {
      console.error(`❌ Account ${accountId} not found for IDLE`);
      return;
    }

    console.log(`📧 Starting IMAP IDLE for ${accountId} (real-time)`);
    this.setupIdleConnection(accountId, account);
  }

  async setupIdleConnection(accountId, account) {
    try {
      const imap = await this.getImapClient(accountId);

      console.log(`📧 Setting up IDLE connection for ${accountId}`);

      imap.once('ready', () => {
        console.log(`📧 IMAP IDLE connection ready for ${accountId}`);
        
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error(`❌ Failed to open INBOX for ${accountId}:`, err);
            return;
          }

          console.log(`📧 INBOX opened for ${accountId}, listening for new mail...`);
          
          // Listen for new mail events (this is automatic IDLE)
          imap.on('mail', (numNewMsgs) => {
            console.log(`📧 IDLE: ${numNewMsgs} new message(s) detected in ${accountId}`);
            this.handleNewEmailFromIdle(accountId, numNewMsgs, imap);
          });

          // Listen for connection events
          imap.on('close', () => {
            console.log(`📧 IDLE connection closed for ${accountId}`);
            // Attempt to reconnect after delay
            setTimeout(() => {
              console.log(`📧 Attempting to reconnect IDLE for ${accountId}`);
              this.startIdleForAccount(accountId);
            }, 30000);
          });

          console.log(`📧 IDLE monitoring active for ${accountId}`);
        });
      });

      imap.once('error', (err) => {
        console.error(`❌ IMAP IDLE error for ${accountId}:`, err);
        // Reconnect after delay
        setTimeout(() => {
          console.log(`📧 Reconnecting IDLE after error for ${accountId}`);
          this.startIdleForAccount(accountId);
        }, 60000);
      });

      // Store the IMAP connection
      this.idleConnections.set(accountId, { 
        type: 'idle',
        imap: imap,
        account: account
      });

      // Connect to start IDLE monitoring
      imap.connect();
      
    } catch (error) {
      console.error(`❌ Error setting up IDLE connection for ${accountId}:`, error);
      console.error(`📧 IDLE monitoring failed for ${accountId} - no fallback available`);
    }
  }

  /**
   * Handle new email detected via IDLE
   */
  async handleNewEmailFromIdle(accountId, numNewMsgs, imap) {
    try {
      console.log(`📧 Fetching ${numNewMsgs} new emails from ${accountId}`);
      
      // Search for recent emails
      imap.search(['ALL'], (err, results) => {
        if (err) {
          console.error(`❌ IDLE search error for ${accountId}:`, err);
          return;
        }

        if (results.length === 0) {
          console.log(`📧 No emails found for ${accountId}`);
          return;
        }

        // Get the most recent emails
        const latestUids = results.slice(-numNewMsgs);
        console.log(`📧 Fetching emails with UIDs:`, latestUids);
        
        const fetch = imap.fetch(latestUids, { bodies: '', markSeen: false });
        const emails = [];
        let processedCount = 0;
        const totalEmails = latestUids.length;

        fetch.on('message', (msg, seqno) => {
          let emailData = { seqno };
          
          msg.on('body', (stream, info) => {
            let buffer = '';
            stream.on('data', (chunk) => {
              buffer += chunk.toString('utf8');
            });
            stream.once('end', () => {
              simpleParser(buffer, (err, parsed) => {
                if (err) {
                  console.error(`❌ Failed to parse email for ${accountId}:`, err);
                } else {
                  emailData = {
                    ...emailData,
                    messageId: parsed.messageId,
                    inReplyTo: parsed.inReplyTo,
                    references: parsed.references,
                    subject: parsed.subject,
                    from: parsed.from?.text || parsed.from,
                    to: parsed.to?.text || parsed.to,
                    date: parsed.date,
                    text: parsed.text,
                    html: parsed.html
                  };
                  emails.push(emailData);
                  console.log(`📧 IDLE: Parsed email from ${emailData.from} - Subject: ${emailData.subject}`);
                }
                
                processedCount++;
                // Process emails after all are parsed
                if (processedCount === totalEmails) {
                  console.log(`📧 IDLE: Processed ${emails.length} new emails for ${accountId}`);
                  
                  // Group emails by conversation thread
                  const emailThreads = this.groupEmailsByThread(emails);
                  
                  // Process each thread as a unit
                  emailThreads.forEach((thread, index) => {
                    setTimeout(() => {
                      if (thread.length === 1) {
                        // Single email - process normally
                        this.handleNewEmail(accountId, 1, thread[0]);
                      } else {
                        // Email thread - process as conversation
                        this.handleEmailThread(accountId, thread);
                      }
                    }, index * 500); // Small delay between processing
                  });
                }
              });
            });
          });
        });

        fetch.once('end', () => {
          // This event fires when fetch is complete, but parsing may still be in progress
          console.log(`📧 IDLE: Fetch completed for ${accountId}, waiting for email parsing...`);
        });

        fetch.once('error', (err) => {
          console.error(`❌ IDLE fetch error for ${accountId}:`, err);
        });
      });
      
    } catch (error) {
      console.error(`❌ Error handling IDLE email for ${accountId}:`, error);
    }
  }

  /**
   * Search emails and return just sequence numbers (simpler, more reliable)
   */
  async searchEmailsForSeqno(accountId, criteria = {}, limit = 10) {
    return new Promise(async (resolve, reject) => {
      const imap = await this.getImapClient(accountId);

      console.log(`📧 Simple search for sequence numbers in account: ${accountId}`, criteria);

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            console.error(`📧 Error opening INBOX for seqno search:`, err);
            return reject(err);
          }

          if (box.messages.total === 0) {
            console.log(`📧 No messages in inbox to search`);
            imap.end();
            return resolve([]);
          }

          // Build IMAP search criteria
          let searchCriteria;
          
          if (criteria.subject) {
            searchCriteria = [['SUBJECT', criteria.subject]];
          } else if (criteria.sender) {
            searchCriteria = [['FROM', criteria.sender]];
          } else if (criteria.content) {
            searchCriteria = [['TEXT', criteria.content]];
          } else {
            searchCriteria = ['ALL'];
          }

          console.log(`📧 Simple IMAP search criteria:`, searchCriteria);

          imap.search(searchCriteria, (err, results) => {
            imap.end();
            
            if (err) {
              console.error(`📧 Simple search error:`, err);
              return reject(err);
            }

            if (!results || results.length === 0) {
              console.log(`📧 No emails found in simple search`);
              return resolve([]);
            }

            // Return sequence numbers directly, most recent first
            const limitedResults = results.slice(-limit).reverse();
            console.log(`📧 Simple search found ${results.length} matches, returning ${limitedResults.length} sequence numbers`);
            resolve(limitedResults);
          });
        });
      });

      imap.once('error', (err) => {
        console.error(`📧 IMAP connection error during simple search:`, err);
        reject(err);
      });

      imap.connect();
    });
  }

  /**
   * Stop all email monitoring
   */
  stopEmailMonitoring() {
    console.log('📧 Stopping all email monitoring...');
    this.idleConnections.forEach((connection, accountId) => {
      if (connection.imap) {
        console.log(`📧 Closing IDLE connection for ${accountId}`);
        connection.imap.end();
      }
      this.idleConnections.delete(accountId);
    });
  }

  /**
   * Group emails by conversation thread using message IDs and references
   */
  groupEmailsByThread(emails) {
    const threads = [];
    const emailMap = new Map();
    
    // First pass: create map of all emails by message ID
    emails.forEach(email => {
      if (email.messageId) {
        emailMap.set(email.messageId, email);
      }
    });
    
    // Second pass: group emails into threads
    const processedEmails = new Set();
    
    emails.forEach(email => {
      if (processedEmails.has(email.messageId)) return;
      
      const thread = [];
      const visited = new Set();
      
      // Find all emails in this thread
      const findRelatedEmails = (currentEmail) => {
        if (!currentEmail || visited.has(currentEmail.messageId)) return;
        
        visited.add(currentEmail.messageId);
        thread.push(currentEmail);
        processedEmails.add(currentEmail.messageId);
        
        // Find emails that reference this one
        emails.forEach(otherEmail => {
          if (otherEmail.inReplyTo === currentEmail.messageId || 
              (otherEmail.references && otherEmail.references.includes(currentEmail.messageId))) {
            findRelatedEmails(otherEmail);
          }
        });
        
        // Find emails this one references
        if (currentEmail.inReplyTo && emailMap.has(currentEmail.inReplyTo)) {
          findRelatedEmails(emailMap.get(currentEmail.inReplyTo));
        }
        
        if (currentEmail.references) {
          currentEmail.references.forEach(refId => {
            if (emailMap.has(refId)) {
              findRelatedEmails(emailMap.get(refId));
            }
          });
        }
      };
      
      findRelatedEmails(email);
      
      if (thread.length > 0) {
        // Sort thread by date
        thread.sort((a, b) => new Date(a.date) - new Date(b.date));
        threads.push(thread);
      }
    });
    
    console.log(`📧 Grouped ${emails.length} emails into ${threads.length} conversation threads`);
    return threads;
  }

  /**
   * Handle an email thread as a single conversation
   */
  async handleEmailThread(accountId, emailThread) {
    try {
      console.log(`📧 Processing email thread with ${emailThread.length} messages from ${accountId}`);
      
      if (this.emailCallback) {
        // Create a combined email object representing the entire thread
        const latestEmail = emailThread[emailThread.length - 1]; // Most recent email
        const threadSubject = latestEmail.subject;
        
        // Combine all email contents into conversation format
        let conversationText = `=== EMAIL CONVERSATION THREAD ===\n`;
        conversationText += `Subject: ${threadSubject}\n`;
        conversationText += `Total Messages: ${emailThread.length}\n\n`;
        
        emailThread.forEach((email, index) => {
          conversationText += `--- Message ${index + 1} ---\n`;
          conversationText += `From: ${email.from}\n`;
          conversationText += `Date: ${email.date}\n`;
          conversationText += `Content: ${email.text?.replace(/--[0-9a-f]+/g, '').replace(/Content-Type:[^\n]+/g, '').replace(/boundary="[^"]*"/g, '').trim() || 'No content'}\n\n`;
        });
        
        console.log(`📧 ✅ Processing email thread as single conversation`);
        
        // Create a combined email object for the callback
        const threadEmail = {
          ...latestEmail,
          text: conversationText,
          isThread: true,
          threadLength: emailThread.length
        };
        
        await this.emailCallback({
          accountId,
          email: threadEmail,
          type: 'email_thread',
          channel: accountId
        });
      } else {
        console.log(`📧 No callback set for email thread processing`);
      }
    } catch (error) {
      console.error(`📧 Error handling email thread for ${accountId}:`, error);
    }
  }
}

export default UniversalEmailService;