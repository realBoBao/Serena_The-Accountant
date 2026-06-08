/**
 * ═══════════════════════════════════════════════════════════════
 * Observability & Telemetry — System Monitoring & Alerting
 * ═══════════════════════════════════════════════════════════════
 *
 * Cung cấp:
 *   - Metrics collection (latency, success rate, resource usage)
 *   - Health scoring
 *   - Alert webhook (auto-notify Discord on critical issues)
 *   - Prometheus-compatible metrics endpoint
 *
 * Được gọi bởi:
 * - gateway.js (health check)
 * - discord_bot.js (command metrics)
 * - scheduler.js (pipeline metrics)
 * - webhook_bot.js (alert notifications)
 */

import { getLogger } from './logger.js';
import os from 'os';

const logger = getLogger('Observability');

// ── Metrics Store (in-memory, reset on restart) ──
const metrics = {
  commands: {},       // { prefix: { count, errors, totalLatency } }
  agents: {},         // { name: { count, errors, totalLatency } }
  sandbox: { count: 0, errors: 0, totalLatency: 0 },
  llm: { count: 0, errors: 0, totalLatency: 0, byProvider: {} },
  webhooks: { count: 0, errors: 0 },
  startTime: Date.now(),
  alerts: [],
};

// ── Command Metrics ──
export function recordCommand(prefix, latencyMs, success) {
  if (!metrics.commands[prefix]) {
    metrics.commands[prefix] = { count: 0, errors: 0, totalLatency: 0, avgLatency: 0 };
  }
  const m = metrics.commands[prefix];
  m.count++;
  m.totalLatency += latencyMs;
  m.avgLatency = Math.round(m.totalLatency / m.count);
  if (!success) m.errors++;
}

// ── Agent Metrics ──
export function recordAgent(name, latencyMs, success) {
  if (!metrics.agents[name]) {
    metrics.agents[name] = { count: 0, errors: 0, totalLatency: 0, avgLatency: 0 };
  }
  const m = metrics.agents[name];
  m.count++;
  m.totalLatency += latencyMs;
  m.avgLatency = Math.round(m.totalLatency / m.count);
  if (!success) m.errors++;
}

// ── LLM Metrics ──
export function recordLlmCall(provider, latencyMs, success) {
  metrics.llm.count++;
  metrics.llm.totalLatency += latencyMs;
  if (!success) metrics.llm.errors++;

  if (!metrics.llm.byProvider[provider]) {
    metrics.llm.byProvider[provider] = { count: 0, errors: 0, totalLatency: 0 };
  }
  const p = metrics.llm.byProvider[provider];
  p.count++;
  p.totalLatency += latencyMs;
  if (!success) p.errors++;
}

// ── Sandbox Metrics ──
export function recordSandbox(latencyMs, success) {
  metrics.sandbox.count++;
  metrics.sandbox.totalLatency += latencyMs;
  if (!success) metrics.sandbox.errors++;
}

// ── Webhook Metrics ──
export function recordWebhook(success) {
  metrics.webhooks.count++;
  if (!success) metrics.webhooks.errors++;
}

// ── System Health ──
export function getSystemHealth() {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let totalIdle = 0, totalTick = 0;
  for (const cpu of os.cpus()) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }

  const cpuUsage = Math.round((1 - totalIdle / totalTick) * 100);
  const memUsage = Math.round((usedMem / totalMem) * 100);
  const processMemMB = Math.round(mem.rss / 1024 / 1024);

  // Health score (0-100)
  let score = 100;
  if (cpuUsage > 80) score -= 20;
  else if (cpuUsage > 60) score -= 10;
  if (memUsage > 90) score -= 20;
  else if (memUsage > 75) score -= 10;
  if (processMemMB > 500) score -= 15;
  else if (processMemMB > 300) score -= 5;

  // Check error rates
  const totalCommands = Object.values(metrics.commands).reduce((s, m) => s + m.count, 0);
  const totalErrors = Object.values(metrics.commands).reduce((s, m) => s + m.errors, 0);
  if (totalCommands > 10) {
    const errorRate = totalErrors / totalCommands;
    if (errorRate > 0.3) score -= 20;
    else if (errorRate > 0.1) score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    rating: score >= 80 ? 'healthy' : score >= 60 ? 'warning' : score >= 40 ? 'degraded' : 'critical',
    cpu: { usage: cpuUsage, cores: os.cpus().length },
    memory: {
      system: { total: Math.round(totalMem / 1024 / 1024), used: Math.round(usedMem / 1024 / 1024), usage: memUsage },
      process: { rss: processMemMB, heapUsed: Math.round(mem.heapUsed / 1024 / 1024) },
    },
    uptime: { system: Math.round(os.uptime() / 3600 * 10) / 10, process: Math.round(process.uptime() / 3600 * 10) / 10 },
  };
}

// ── Full Metrics Report ──
export function getMetricsReport() {
  const health = getSystemHealth();
  const uptime = Math.round((Date.now() - metrics.startTime) / 1000);

  return {
    uptime,
    health,
    commands: { ...metrics.commands },
    agents: { ...metrics.agents },
    sandbox: { ...metrics.sandbox },
    llm: {
      ...metrics.llm,
      avgLatency: metrics.llm.count > 0 ? Math.round(metrics.llm.totalLatency / metrics.llm.count) : 0,
      errorRate: metrics.llm.count > 0 ? Math.round(metrics.llm.errors / metrics.llm.count * 100) : 0,
    },
    webhooks: { ...metrics.webhooks },
    timestamp: new Date().toISOString(),
  };
}

// ── Alert System ──
export async function sendAlert({ severity, title, message, source, details }) {
  const alert = { severity, title, message, source, details, timestamp: Date.now() };
  metrics.alerts.push(alert);

  // Keep only last 100 alerts
  if (metrics.alerts.length > 100) metrics.alerts = metrics.alerts.slice(-100);

  logger.warn(`[Alert] ${severity.toUpperCase()}: ${title} — ${message}`);

  // Send to Discord webhook if configured
  const webhookUrl = process.env.DISCORD_WEBHOOK || '';
  if (!webhookUrl) return;

  const colors = { info: 0x00ff00, warning: 0xffaa00, error: 0xff0000, critical: 0xff0000 };
  const icons = { info: 'ℹ️', warning: '⚠️', error: '❌', critical: '🚨' };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `${icons[severity] || '⚠️'} ${title}`,
          description: String(message || '').slice(0, 4096),
          color: colors[severity] || 0xffaa00,
          fields: [
            ...(source ? [{ name: '📍 Source', value: source, inline: true }] : []),
            ...(details ? [{ name: '📋 Details', value: String(details).slice(0, 500) }] : []),
          ],
          footer: { text: 'AI Brain Alert System' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (err) {
    logger.error('[Alert] Failed to send webhook:', err.message);
  }
}

// ── Auto-alert on critical conditions ──
export function checkAndAlert() {
  const health = getSystemHealth();

  if (health.rating === 'critical') {
    sendAlert({
      severity: 'critical',
      title: '🚨 System Critical',
      message: `Health score: ${health.score}/100. CPU: ${health.cpu.usage}%, RAM: ${health.memory.system.usage}%`,
      source: 'Observability',
    });
  } else if (health.rating === 'degraded') {
    sendAlert({
      severity: 'warning',
      title: '⚠️ System Degraded',
      message: `Health score: ${health.score}/100. Process RAM: ${health.memory.process.rss}MB`,
      source: 'Observability',
    });
  }

  return health;
}

// ── Prometheus-compatible metrics (text format) ──
export function getPrometheusMetrics() {
  const lines = [];
  const report = getMetricsReport();

  lines.push('# HELP ai_brain_uptime_seconds Total uptime in seconds');
  lines.push('# TYPE ai_brain_uptime_seconds gauge');
  lines.push(`ai_brain_uptime_seconds ${report.uptime}`);

  lines.push('# HELP ai_brain_health_score System health score (0-100)');
  lines.push('# TYPE ai_brain_health_score gauge');
  lines.push(`ai_brain_health_score ${report.health.score}`);

  lines.push('# HELP ai_brain_cpu_usage CPU usage percentage');
  lines.push('# TYPE ai_brain_cpu_usage gauge');
  lines.push(`ai_brain_cpu_usage ${report.health.cpu.usage}`);

  lines.push('# HELP ai_brain_memory_usage System memory usage percentage');
  lines.push('# TYPE ai_brain_memory_usage gauge');
  lines.push(`ai_brain_memory_usage ${report.health.memory.system.usage}`);

  lines.push('# HELP ai_brain_commands_total Total commands executed');
  lines.push('# TYPE ai_brain_commands_total counter');
  for (const [prefix, m] of Object.entries(report.commands)) {
    lines.push(`ai_brain_commands_total{prefix="${prefix}"} ${m.count}`);
  }

  lines.push('# HELP ai_brain_command_errors_total Total command errors');
  lines.push('# TYPE ai_brain_command_errors_total counter');
  for (const [prefix, m] of Object.entries(report.commands)) {
    lines.push(`ai_brain_command_errors_total{prefix="${prefix}"} ${m.errors}`);
  }

  lines.push('# HELP ai_brain_llm_calls_total Total LLM API calls');
  lines.push('# TYPE ai_brain_llm_calls_total counter');
  lines.push(`ai_brain_llm_calls_total ${report.llm.count}`);

  lines.push('# HELP ai_brain_llm_errors_total Total LLM API errors');
  lines.push('# TYPE ai_brain_llm_errors_total counter');
  lines.push(`ai_brain_llm_errors_total ${report.llm.errors}`);

  return lines.join('\n');
}

export { metrics };
