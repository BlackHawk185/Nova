import express from "express";

export function createRoutes({ runNovaPipeline, actionExecutor, emailService }) {
  const router = express.Router();

  // === HEALTH CHECK (for Railway/monitoring) ===
  router.get("/", (req, res) => {
    res.json({
      status: "ok",
      service: "Nova AI Secretary",
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  router.get("/health", (req, res) => {
    res.json({
      status: "healthy",
      accounts: emailService.listAccounts().length,
      uptime: process.uptime()
    });
  });

  // === AUTH STATUS ===
  router.get("/auth/status", (req, res) => {
    res.json({
      accounts: emailService.listAccounts(),
      message: "Email service is ready"
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