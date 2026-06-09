/**
 * PM2 Ecosystem — AI Brain v5
 *
 * Services:
 *   - AI_Brain: Gateway (discord, restApi, scheduler, watcher, webhook)
 *     Port 3000: Health check + Webhook endpoints
 *     Port 3005: REST API
 *     Port 4002: Feedback Server
 *
 * Webhook endpoints (port 3000):
 *   POST /webhook/pipeline  — Pipeline completion
 *   POST /webhook/alert     — Error alerts
 *   POST /webhook/health    — System health reports
 *   POST /webhook/debate    — Debate results
 *   POST /webhook/security  — Security audit results
 *   POST /webhook/analyze   — Code analysis results
 *   POST /webhook/profile   — Performance profile results
 *   POST /webhook/logs      — Log analysis results
 *   GET  /health            — Health check
 *   POST /restart           — Restart all services
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
        DISCORD_WEBHOOK: "https://discord.com/api/webhooks/1510728361385791718/0tEYWDB1s-sYYUH543p0fLcd7A4FF8aJ5lUXNMjcwmA7B-P7lR3zn-FJGy5OrTEWH3fm",
        WEBHOOK_SECRET: "B70DDC6EA58A6AD9458ABBBC9405D6D6CDD570E92543204C41876269D36D0E9F",
      }
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
        GEMINI_API_KEY: "AQ.Ab8RN6LEccXWkPoNxixZSUnp-c_hTbQXtZuciyx1a8G581Xbqw",
        GOOGLE_API_KEY: "AQ.Ab8RN6LEccXWkPoNxixZSUnp-c_hTbQXtZuciyx1a8G581Xbqw",
        GEMINI_MODEL: "gemini-2.5-flash",
        GEMINI_VISION_MODEL: "gemini-2.5-flash",
        OPENROUTER_API_KEY: "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",
        OPENROUTER_MODEL_NAME: "google/gemini-2.5-flash",
        TAVILY_API_KEY: "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",
        YOUTUBE_API_KEY: "AIzaSyDc-VL9Vl1tWaCE-G0-iHM1Mnm0Z1AYZAY",
        GITHUB_TOKEN: "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",
        GOOGLE_SEARCH_API_KEY: "AIzaSyD74zxWjqCmjSxuE-kFwZzLkVoonGjITW0",
        GOOGLE_SEARCH_CX_ID: "6061773af5d1a401c",
        DISCORD_BOT_TOKEN: "MTUxMTIwNTk5ODM3MzkwMDQwOQ.GSWcOv.93urdUAHTotjC6tulVXqRIcFXjZLshSLTki5n4",
        DISCORD_WEBHOOK: "https://discord.com/api/webhooks/1510728361385791718/0tEYWDB1s-sYYUH543p0fLcd7A4FF8aJ5lUXNMjcwmA7B-P7lR3zn-FJGy5OrTEWH3fm",
        REST_API_KEY: "B70DDC6EA58A6AD9458ABBBC9405D6D6CDD570E92543204C41876269D36D0E9F",
        GRAPH_ENHANCED_RAG: "true",
        USE_LOCAL_LLM: "false",
        GITHUB_MIN_STARS: "10",
        GITHUB_CREATED_AFTER: "2020-01-01",
        YOUTUBE_MIN_VIEWS: "1000",
      },
    },
  ],
};
