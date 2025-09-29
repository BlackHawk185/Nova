import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import open from 'open';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Google OAuth2 Setup Helper for Nova Email Integration
 * 
 * This script helps set up OAuth2 for Google Workspace email accounts.
 * 
 * SETUP STEPS:
 * 1. Go to Google Cloud Console (console.cloud.google.com)
 * 2. Create a new project or select existing one
 * 3. Enable Gmail API
 * 4. Create OAuth 2.0 credentials (Desktop application)
 * 5. Copy Client ID and Client Secret to .env file
 * 6. Run this script to get refresh token
 */

// Configuration - these will be read from .env
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://mail.google.com/' // Full Gmail access for IMAP
];

const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

async function setupOAuth2() {
  console.log('🔐 Google OAuth2 Setup for Nova Email Integration\n');
  
  console.log('PREREQUISITES:');
  console.log('1. Google Cloud project created');
  console.log('2. Gmail API enabled');
  console.log('3. OAuth 2.0 credentials created (Desktop app)');
  console.log('4. Client ID and Secret added to .env file\n');
  
  // Read from env (you'll need to update these)
  const CLIENT_ID = process.env.EMAIL_2_CLIENT_ID || 'your_client_id_here';
  const CLIENT_SECRET = process.env.EMAIL_2_CLIENT_SECRET || 'your_client_secret_here';
  
  if (CLIENT_ID === 'your_client_id_here' || CLIENT_SECRET === 'your_client_secret_here') {
    console.log('❌ Please update your .env file with Google OAuth credentials first!');
    console.log('\nUpdate these fields in .env:');
    console.log('EMAIL_2_CLIENT_ID=your_actual_client_id');
    console.log('EMAIL_2_CLIENT_SECRET=your_actual_client_secret');
    return;
  }
  
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  
  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Forces refresh token
  });
  
  console.log('🌐 Opening authorization URL in your browser...');
  console.log('URL:', authUrl);
  
  try {
    await open(authUrl);
  } catch (error) {
    console.log('Could not auto-open browser. Please manually visit the URL above.');
  }
  
  // Start local server to capture redirect
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/oauth/callback')) {
      const url = new URL(req.url, `http://localhost:3000`);
      const code = url.searchParams.get('code');
      
      if (code) {
        try {
          const { tokens } = await oauth2Client.getToken(code);
          
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>✅ Authorization Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);
          
          console.log('\n🎉 OAuth2 setup complete!');
          console.log('\nAdd this to your .env file:');
          console.log(`EMAIL_2_REFRESH_TOKEN=${tokens.refresh_token}`);
          
          server.close();
          
        } catch (error) {
          console.error('❌ Error getting tokens:', error);
          res.writeHead(500);
          res.end('Error during authorization');
          server.close();
        }
      } else {
        res.writeHead(400);
        res.end('No authorization code received');
        server.close();
      }
    }
  });
  
  server.listen(3000, () => {
    console.log('\n⏳ Waiting for authorization... (Server running on port 3000)');
  });
}

if (process.env.NODE_ENV !== 'test') {
  setupOAuth2().catch(console.error);
}

export default setupOAuth2;