# Railway Deployment Guide for Nova

## Quick Deploy Steps

### 1. Push to GitHub
```bash
git add .
git commit -m "Add Railway deployment config"
git push origin main
```

### 2. Deploy on Railway
1. Go to [railway.app](https://railway.app)
2. Sign in with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your `Nova` repository
5. Railway will auto-detect Node.js and deploy

### 3. Add Environment Variables
In Railway dashboard, go to your project → Variables tab and add:

**Required:**
- `OPENAI_API_KEY` - Your OpenAI API key
- `NOVA_ASSISTANT_ID` - Your assistant ID (asst_gNwlaKVPMnTeORVkbXs5EqeV)
- `MY_NUMBER` - Your phone number for notifications

**Email Accounts (Personal):**
- `EMAIL_USER` - stephenmichaud@email.com
- `EMAIL_PASS` - Your email password
- `EMAIL_IMAP_HOST` - imap.email.com
- `EMAIL_IMAP_PORT` - 993
- `EMAIL_SMTP_HOST` - smtp.email.com
- `EMAIL_SMTP_PORT` - 465

**Email Accounts (Work - OAuth2):**
- `EMAIL_2_USER` - stephen@valenceapp.net
- `EMAIL_2_SMTP_HOST` - smtp.gmail.com
- `EMAIL_2_SMTP_PORT` - 465
- `EMAIL_2_IMAP_HOST` - imap.gmail.com
- `EMAIL_2_IMAP_PORT` - 993
- `GOOGLE_OAUTH_CLIENT_ID` - Your Google OAuth client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` - Your Google OAuth client secret
- `GOOGLE_OAUTH_REFRESH_TOKEN_WORK` - Your refresh token for work account

**Email Accounts (Nova SMS - OAuth2):**
- `EMAIL_3_USER` - nova806a6bd1@gmail.com
- `EMAIL_3_SMTP_HOST` - smtp.gmail.com
- `EMAIL_3_SMTP_PORT` - 465
- `EMAIL_3_IMAP_HOST` - imap.gmail.com
- `EMAIL_3_IMAP_PORT` - 993
- `GOOGLE_OAUTH_REFRESH_TOKEN_NOVA_SMS` - Your refresh token for nova-sms account

**Optional (Mem0 - if you want semantic memory):**
- `MEM0_API_KEY` - Your Mem0 API key

**Optional (custom model):**
- `OPENAI_MODEL` - Default is gpt-4o-mini
- `PORT` - Default is 3000

### 4. Add Redis (for threads & scheduling)

In Railway dashboard:
1. Click "New" → "Database" → "Add Redis"
2. Railway will auto-generate these variables:
   - `REDIS_URL` (Railway provides this automatically)
3. You need to manually set these based on the REDIS_URL:
   - `UPSTASH_REDIS_REST_URL` - Copy from Railway Redis connection URL
   - `UPSTASH_REDIS_REST_TOKEN` - Copy from Railway Redis password

**Note:** Railway's Redis uses a standard `redis://` URL. You may need to use the standard Redis client instead of Upstash REST API, or use a service like Upstash directly.

### 5. Deploy & Monitor

- Railway auto-deploys on every push to main
- View logs in Railway dashboard → Deployments tab
- Check health at: `https://your-app.up.railway.app/`

## Alternative: Use Upstash Redis (Recommended)

Instead of Railway's Redis, use Upstash (better for serverless):

1. Go to [upstash.com](https://upstash.com)
2. Create a free Redis database
3. Copy the REST URL and token
4. Add to Railway env vars:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## Webhooks for SMS/WhatsApp (Optional)

If you need external webhooks (Twilio, etc.):
1. Railway provides a public URL automatically
2. Use Railway's generated URL as your webhook endpoint
3. Example: `https://your-app.up.railway.app/sms/incoming`

## Cost Estimate

- **Starter plan**: $5/month in free credits
- **Pro plan** (if needed): ~$5-10/month for this app
- Nova is lightweight and should run on free tier

## Troubleshooting

**App crashes on startup:**
- Check logs in Railway dashboard
- Verify all required env vars are set
- Look for OAuth/IMAP connection errors

**IMAP IDLE not working:**
- Railway doesn't kill long-running connections
- Should work fine for email monitoring

**Redis connection issues:**
- Use Upstash Redis REST API (already configured in code)
- Don't use Railway Redis unless you switch to standard Redis client

## Health Check Endpoint

Railway will ping your app to keep it alive. The current setup listens on the PORT that Railway provides.
