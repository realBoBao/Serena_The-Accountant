/**
 * PM2 Ecosystem — AI Brain v8 (Optimized for 2GB RAM)
 *
 * Chỉ chạy 2 services:
 *   AI_Brain       — Gateway (discord + restApi + scheduler + watcher)
 *   AI_WebhookBot  — Cron push tech/news/job/algo webhooks
 *
 * KHÔNG spawn AI_Scheduler (gateway đã có scheduler)
 * KHÔNG spawn AI_AgentWorker (RouterAgent chạy trong gateway)
 *
 * ⚠️ SECURITY: All API keys are loaded from .env file via dotenv.
 */
module.exports = {
  apps: [
    {
      name: "AI_Brain",
      script: "./gateway.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "700M",
      node_args: "--max-old-space-size=600",
      env: {
        NODE_ENV: "production",
        DISCORD_COMMAND_PREFIX: "!ask ",
        REST_API_PORT: "3005",
        FEEDBACK_PORT: "4002",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        ...(process.env.GOOGLE_API_KEY ? { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY } : {}),
        ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
      },
    },
    {
      name: "AI_WebhookBot",
      script: "./webhook_bot.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "150M",
      node_args: "--max-old-space-size=128",
      env: {
        NODE_ENV: "production",
        WEBHOOK_BOT_PORT: "3007",
      },
    },
  ],
};
