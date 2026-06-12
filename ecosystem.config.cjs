/**
 * PM2 Ecosystem — AI Brain v6 (Full Stack)
 *
 * 7 Services:
 *   AI_Brain          — Gateway (discord bot + REST API + scheduler + watcher)
 *   AI_WebhookBot     — Discord webhook notification service (port 3007)
 *   AI_Admin_Dashboard — Web UI (port 3003)
 *   AI_EvoAgent       — Self-evolution background agent (BullMQ worker)
 *   AI_GraphAgent     — Knowledge graph agent (BullMQ worker)
 *   AI_PlannerWorker  — OODA task planner (BullMQ worker)
 *   AI_AgentWorker    — Agent job processor (BullMQ cluster, 2 instances)
 *   AI_Scheduler      — Cron job scheduler (pipeline, backup, memory consolidation)
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
    {
      name: "AI_EvoAgent",
      script: "./agents/EvoAgent.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "250M",
      env: {
        NODE_ENV: "production",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
      },
    },
    {
      name: "AI_GraphAgent",
      script: "./agents/GraphAgentLauncher.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "500M",
      min_uptime: "10s",
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        NEO4J_DISABLED: "true",
      },
    },
    {
      name: "AI_PlannerWorker",
      script: "./agents/PlannerAgent.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        OPENROUTER_API_KEY: "",
        OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
        LLM_MODEL: "openrouter/auto",
        LOCAL_LLM_URL: "http://127.0.0.1:3001",
      },
    },
    {
      name: "AI_AgentWorker",
      script: "./agents/RouterAgent.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        OPENROUTER_API_KEY: "",
        OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
        LLM_MODEL: "openrouter/auto",
      },
    },
    {
      name: "AI_Scheduler",
      script: "./scheduler.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
      },
    },
  ],
};
