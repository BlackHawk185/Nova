import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'production',
  openaiApiKey: process.env.OPENAI_API_KEY || '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',
  mem0ApiKey: process.env.MEM0_API_KEY || process.env.MEM0_TOKEN || 'm0-3717ZQLmjea107fARZebIojz3gC9M8sDCryRnMVC',
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || 'https://touching-molly-11902.upstash.io',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || 'AS5-AAIncDJjNDY3NWI4Yjg5M2U0ZjZlYjkyNzkyYjJhZDAzYWMzYXAyMTE5MDI',
  myNumber: process.env.MY_NUMBER || '+13072750181',
};

export function dumpConfigSummary() {
  const redacted = (val) => (val ? 'set' : 'missing');
  return {
    port: config.port,
    env: config.nodeEnv,
    services: {
      openai: redacted(config.openaiApiKey),
      mem0: redacted(config.mem0ApiKey),
      upstash: redacted(config.upstashUrl) && redacted(config.upstashToken),
      myNumber: redacted(config.myNumber),
    },
  };
}

export default config;
