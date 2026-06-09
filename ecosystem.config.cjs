/**
 * PM2 Ecosystem — AI Brain v5
 *
 * Services:
 *   - AI_Brain: Gateway (discord, restApi, scheduler, watcher, webhook)
 *   - AI_WebhookBot: Discord webhook notification service (port 3007)
 *   - AI_Admin_Dashboard: Web UI (port 3003)
 *
 * ⚠️ SECURITY: All API keys are loaded from .env file via dotenv.
 *    NEVER hardcode keys in this file.
 */
module.exports = {
  apps: [
    {
      name: "AI_WebhookBot",
      script: "./webhook_bot.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        WEBHOOK_BOT_PORT: "3007",
      },
    },
    {
      name: "AI_Brain",
      script: "./gateway.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        DISCORD_COMMAND_PREFIX: "!ask ",
        REST_API_PORT: "3005",
        FEEDBACK_PORT: "4002",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
      },
    },
    {
      name: "AI_Admin_Dashboard",
      script: "./admin_dashboard.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        ADMIN_PORT: "3003",
      },
    },
  ],
};
