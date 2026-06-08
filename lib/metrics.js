/**
 * Prometheus Metrics Collector
 * Thu thập metrics từ các microservice để giám sát hiệu suất
 */

import { register, Counter, Histogram, Gauge } from 'prom-client';

// ── Discord Bot Metrics ──
export const discordMessagesTotal = new Counter({
  name: 'discord_messages_total',
  help: 'Total number of Discord messages processed',
  labelNames: ['intent', 'status'],
});

export const discordResponseTime = new Histogram({
  name: 'discord_response_duration_seconds',
  help: 'Discord bot response time in seconds',
  labelNames: ['intent'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

// ── RAG Metrics ──
export const ragQueriesTotal = new Counter({
  name: 'rag_queries_total',
  help: 'Total number of RAG queries',
  labelNames: ['source', 'status'],
});

export const ragQueryDuration = new Histogram({
  name: 'rag_query_duration_seconds',
  help: 'RAG query processing time',
  labelNames: ['source'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// ── Vector Search Metrics ──
export const vectorSearchDuration = new Histogram({
  name: 'vector_search_duration_seconds',
  help: 'Vector search latency',
  labelNames: ['collection'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
});

export const vectorSearchTotal = new Counter({
  name: 'vector_search_total',
  help: 'Total vector searches',
  labelNames: ['collection'],
});

// ── Flashcard Metrics ──
export const flashcardsReviewed = new Counter({
  name: 'flashcards_reviewed_total',
  help: 'Total flashcards reviewed',
  labelNames: ['result'],
});

export const flashcardsDue = new Gauge({
  name: 'flashcards_due',
  help: 'Number of flashcards due for review',
});

// ── Sandbox Metrics ──
export const sandboxExecutions = new Counter({
  name: 'sandbox_executions_total',
  help: 'Total code executions in sandbox',
  labelNames: ['language', 'status'],
});

export const sandboxExecutionTime = new Histogram({
  name: 'sandbox_execution_duration_seconds',
  help: 'Code execution time in sandbox',
  labelNames: ['language'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// ── System Health Metrics ──
export const serviceUptime = new Gauge({
  name: 'service_uptime_seconds',
  help: 'Service uptime in seconds',
  labelNames: ['service'],
});

export const memoryUsage = new Gauge({
  name: 'process_memory_bytes',
  help: 'Process memory usage',
  labelNames: ['type'],
});

// ── PM2 Process Metrics ──
export const pm2Restarts = new Counter({
  name: 'pm2_process_restart_count',
  help: 'PM2 process restart count',
  labelNames: ['instance'],
});

// ── Helper Functions ──
export function startMetricsCollection() {
  // Collect memory usage every 30s
  setInterval(() => {
    const mem = process.memoryUsage();
    memoryUsage.set({ type: 'rss' }, mem.rss);
    memoryUsage.set({ type: 'heapUsed' }, mem.heapUsed);
    memoryUsage.set({ type: 'heapTotal' }, mem.heapTotal);
  }, 30000);

  // Collect uptime every 10s
  const startTime = Date.now();
  setInterval(() => {
    serviceUptime.set({ service: 'ai-brain' }, (Date.now() - startTime) / 1000);
  }, 10000);
}

export function getMetrics() {
  return register.metrics();
}

export function getRegister() {
  return register;
}
