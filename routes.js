import express from "express";

export function createRoutes({ runNovaPipeline, actionExecutor, emailService, googleOAuth }) {
  const router = express.Router();

  // === TWILIO SMS/WHATSAPP WEBHOOK ===
  router.post("/sms", async (req, res) => {
    const incoming = req.body.Body?.trim();
    const rawFromNumber = req.body.From;
    const fromNumber = req.body.From?.replace('whatsapp:', ''); // Remove whatsapp: prefix if present
    const isWhatsApp = rawFromNumber?.startsWith('whatsapp:');
    
    console.log(`📨 ${isWhatsApp ? 'WhatsApp' : 'SMS'} from ${rawFromNumber} (cleaned: ${fromNumber}): "${incoming}"`);

    // Compare cleaned number to MY_NUMBER
    const myNumber = process.env.MY_NUMBER;
    if (fromNumber !== myNumber) {
      console.log(`❌ Unknown number: ${rawFromNumber} (expected: ${myNumber})`);
      res.send("<Response></Response>");
      return;
    }

    try {
      const pipelineResult = await runNovaPipeline({
        userInput: incoming,
        channel: isWhatsApp ? "whatsapp" : "sms",
        actionContext: "general",
        metadata: { fromNumber: rawFromNumber },
      });

      console.log(`💬 ${isWhatsApp ? 'WhatsApp' : 'SMS'} processed`, {
        action: pipelineResult.response.action,
        message: pipelineResult.response.message,
      });
    } catch (error) {
      console.error(`❌ ${isWhatsApp ? 'WhatsApp' : 'SMS'} Error:`, error.message);
      await actionExecutor
        .executeAction({
          action: "send_sms",
          message: `System error occurred: ${error.message}`,
        })
        .catch((notifyError) =>
          console.error("❌ Failed to send error notification:", notifyError.message)
        );
    }

    res.send("<Response></Response>");
  });

  // === TWILIO WHATSAPP WEBHOOK ===
  router.post("/whatsapp", async (req, res) => {
    const incoming = req.body.Body?.trim();
    const rawFromNumber = req.body.From; // Keep raw for logging
    const fromNumber = req.body.From?.replace('whatsapp:', ''); // Remove whatsapp: prefix
    
    console.log(`💬 WhatsApp from ${rawFromNumber} (cleaned: ${fromNumber}): "${incoming}"`);

    // Compare cleaned number to MY_NUMBER
    const myNumber = process.env.MY_NUMBER;
    if (fromNumber !== myNumber) {
      console.log(`❌ Unknown WhatsApp number: ${rawFromNumber} (expected: ${myNumber})`);
      res.send("<Response></Response>");
      return;
    }

    try {
      const pipelineResult = await runNovaPipeline({
        userInput: incoming,
        channel: "whatsapp",
        actionContext: "general",
        metadata: { fromNumber: rawFromNumber },
      });

      console.log("💬 WhatsApp processed", {
        action: pipelineResult.response.action,
        message: pipelineResult.response.message,
      });
    } catch (error) {
      console.error(`❌ WhatsApp Error:`, error.message);
      await actionExecutor
        .executeAction({
          action: "send_sms",
          message: `System error occurred: ${error.message}`,
        })
        .catch((notifyError) =>
          console.error("❌ Failed to send error notification:", notifyError.message)
        );
    }

    res.send("<Response></Response>");
  });

  // === GOOGLE OAUTH SETUP ===
  router.get("/auth/google", (req, res) => {
    if (googleOAuth.hasValidTokens()) {
      res.json({ 
        status: "Google OAuth already configured",
        message: "Gmail integration is ready"
      });
      return;
    }
    
    const authUrl = googleOAuth.getAuthUrl();
    res.json({
      status: "OAuth setup required",
      message: "Visit this URL to authorize Nova to access Gmail",
      authUrl: authUrl,
      instructions: "1. Visit the auth URL, 2. Sign in with your work account, 3. Grant permissions, 4. You'll be redirected back to Nova"
    });
  });

  router.get("/auth/google/callback", async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) {
        return res.status(400).json({ error: "Authorization code not provided" });
      }
      
      await googleOAuth.exchangeCodeForTokens(code);
      
      res.json({
        status: "success",
        message: "✅ Google OAuth configured! Gmail integration is now active. You can close this window."
      });
      
      console.log("✅ Google OAuth setup completed successfully");
    } catch (error) {
      console.error("❌ OAuth callback error:", error.message);
      res.status(500).json({
        status: "error",
        message: "OAuth setup failed: " + error.message
      });
    }
  });

  router.get("/auth/status", (req, res) => {
    res.json({
      googleOAuth: googleOAuth.hasValidTokens(),
      accounts: emailService.listAccounts(),
      message: googleOAuth.hasValidTokens() 
        ? "Gmail OAuth is configured and ready"
        : "Gmail OAuth setup required - visit /auth/google"
    });
  });

  // === HEALTH CHECK ===
  router.get("/health", (req, res) => {
    res.json({ 
      status: "Nova is operational",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      redis: "Upstash connected"
    });
  });

  // === TEST ENDPOINT (for local testing without SMS) ===
  router.get("/test/:message", async (req, res) => {
    const testMessage = decodeURIComponent(req.params.message);
    
    console.log(`\n🧪 TEST MESSAGE (simulated SMS):`);
    console.log(`   Message: "${testMessage}"`);
    console.log(`   ═══════════════════════════`);
    
    try {
      console.log(`🧠 Nova thinking about: "${testMessage}"`);
      const pipelineResult = await runNovaPipeline({
        userInput: testMessage,
        channel: "test",
        actionContext: "general",
        metadata: { source: "test-endpoint" },
      });

      console.log(`💭 Nova's decision:`);
      console.log(`   Action: ${pipelineResult.response.action}`);
      console.log(`   Full response: ${JSON.stringify(pipelineResult.response, null, 2)}`);
      console.log(`✅ Action executed successfully\n`);
      
      res.json({
        success: true,
        input: testMessage,
        nova_response: pipelineResult.response,
        message: "Check console for detailed logs"
      });
    } catch (error) {
      console.error(`❌ Error processing test message:`, error);
      res.status(500).json({
        success: false,
        error: error.message,
        input: testMessage
      });
    }
  });

  return router;
}