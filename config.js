import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  mem0ApiKey: process.env.MEM0_API_KEY || process.env.MEM0_TOKEN || '',
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  myNumber: process.env.MY_NUMBER || '',
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
