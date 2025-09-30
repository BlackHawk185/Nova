#!/usr/bin/env node

/**
 * OAuth2 setup for nova806a6bd1@gmail.com (nova-sms account)
 * This generates a refresh token for the nova-sms Gmail account
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

async function setupNovaOAuth() {
  console.log('🔐 Setting up OAuth2 for nova806a6bd1@gmail.com...');
  
  const CLIENT_ID = process.env.EMAIL_3_CLIENT_ID;
  const CLIENT_SECRET = process.env.EMAIL_3_CLIENT_SECRET;
  
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing EMAIL_3_CLIENT_ID or EMAIL_3_CLIENT_SECRET in .env');
    console.log('   Using the same credentials as EMAIL_2 (work account)');
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'http://localhost:3000/auth/google/callback'
  );

  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('\n🌐 STEP 1: Open this URL in your browser:');
  console.log('   (Make sure to sign in with nova806a6bd1@gmail.com)');
  console.log('\n' + authUrl + '\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise((resolve) => {
    rl.question('📋 STEP 2: Paste the authorization code here: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  try {
    console.log('\n🔄 Exchanging code for tokens...');
    const { tokens } = await oauth2Client.getToken(code);
    
    console.log('✅ Success! Here is your refresh token:');
    console.log(`\nEMAIL_3_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    
    console.log('📝 STEP 3: Update your .env file:');
    console.log('   Replace "EMAIL_3_REFRESH_TOKEN=needs_oauth_setup"');
    console.log(`   With: "EMAIL_3_REFRESH_TOKEN=${tokens.refresh_token}"`);
    
    console.log('\n🎉 OAuth setup complete for nova-sms account!');
    
  } catch (error) {
    console.error('❌ Error exchanging code for tokens:', error.message);
  }
}

setupNovaOAuth().catch(console.error);