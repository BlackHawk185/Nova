import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

class GoogleOAuth {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI
    );
    
    this.tokenPath = path.join(process.cwd(), 'google-tokens.json');
    this.loadTokens();
  }

  /**
   * Load stored tokens from file
   */
  loadTokens() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        const tokens = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        this.oauth2Client.setCredentials(tokens);
        console.log('✅ Google OAuth tokens loaded');
      }
    } catch (error) {
      console.log('⚠️ No valid Google OAuth tokens found');
    }
  }

  /**
   * Save tokens to file
   */
  saveTokens(tokens) {
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));
      console.log('✅ Google OAuth tokens saved');
    } catch (error) {
      console.error('❌ Failed to save OAuth tokens:', error.message);
    }
  }

  /**
   * Get authorization URL for initial setup
   */
  getAuthUrl() {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify'
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent' // Forces refresh token
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code) {
    try {
      const { tokens } = await this.oauth2Client.getAccessToken(code);
      this.oauth2Client.setCredentials(tokens);
      this.saveTokens(tokens);
      return tokens;
    } catch (error) {
      console.error('❌ OAuth token exchange failed:', error.message);
      throw error;
    }
  }

  /**
   * Check if we have valid tokens
   */
  hasValidTokens() {
    const credentials = this.oauth2Client.credentials;
    return !!(credentials && credentials.access_token);
  }

  /**
   * Get access token for IMAP authentication
   */
  async getAccessToken() {
    try {
      // Refresh token if needed
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.oauth2Client.setCredentials(credentials);
      this.saveTokens(credentials);
      
      return credentials.access_token;
    } catch (error) {
      console.error('❌ Failed to get access token:', error.message);
      throw error;
    }
  }

  /**
   * Get Gmail API client
   */
  getGmailClient() {
    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }
}

export default GoogleOAuth;