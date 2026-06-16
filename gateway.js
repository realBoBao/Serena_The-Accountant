/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Gateway — Process Manager cho toàn bộ AI Brain
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * KIẾN TRÚC: Child Process Manager (KHÔNG merge code)
 *
 * Mỗi service chạy riêng biệt qua spawn() → không conflict biến/hàm.
 * Gateway chỉ làm nhiệm vụ: start/stop/restart + health check.
 *
 * Ưu điểm:
 *   ✅ Mỗi service isolated — không name collision
 *   ✅ Auto-restart khi crash
 *   ✅ Health check tập trung
 *   ✅ Quản lý 1 lệnh
 *
 * Ports:
 *   3000  — Health Check (Gateway)
 *   3005  — REST API
 *   4002  — Feedback Server
 */

'use strict';

import 'dotenv/config';
import { spawn } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getSystemHealth, getPrometheusMetrics, checkAndAlert } from './lib/observability.js';
import { info as logInfo, warn as logWarn, error as logError } from './lib/structured_logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Cấu hình services ───────────────────────────────────────────────────────
const SERVICES = [
  { name: 'discord',  script: './discord_bot.js',       restart: true,  env: { DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '', DISCORD_COMMAND_PREFIX: process.env.DISCORD_COMMAND_PREFIX || '!ask ' } },
  { name: 'restApi',  script: './rest_api_server.js',   restart: true,  env: { REST_API_PORT: '3005', REST_API_KEY: process.env.REST_API_KEY || '' }, healthUrl: 'http://localhost:3005/health' },
  { name: 'scheduler',script: './scheduler.js',         restart: true,  env: { ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}), ...(process.env.GOOGLE_API_KEY ? { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY } : {}) } },
  { name: 'watcher',  script: './watch_library.js',     restart: true,  env: {} },
];

const serviceState = {};
const GATEWAY_VERSION = '2.1.0';
const startTime = Date.now();

for (const svc of SERVICES) {
  serviceState[svc.name] = { status: 'stopped', process: null, restarts: 0, startedAt: null };
}

// ── Spawn service ───────────────────────────────────────────────────────────

function startService(svc) {
  const state = serviceState[svc.name];
  if (state.process) return;

  const child = spawn(process.execPath, [svc.script], {
    cwd: __dirname,
    env: { ...process.env, ...svc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  state.process = child;
  state.status = 'starting';
  state.startedAt = Date.now();

  child.stdout.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line.trim()) logInfo(svc.name, line.trim());
    }
  });

  child.stderr.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line.trim()) logError(svc.name, line.trim());
    }
  });

  child.on('exit', (code) => {
    const wasRunning = state.status === 'online';
    state.process = null;
    state.status = 'stopped';
    if (code !== 0 && code !== null) {
      logError('Gateway', 'service exited', { service: svc.name, code });
    }
    if (svc.restart && wasRunning && code !== 0) {
      state.restarts++;
      const delay = Math.min(state.restarts * 2000, 30000);
      logInfo('Gateway', 'service restart scheduled', { service: svc.name, delay_ms: delay, restart_count: state.restarts });
      setTimeout(() => startService(svc), delay);
    }
  });

  setTimeout(() => {
    if (state.process && state.status === 'starting') {
      state.status = 'online';
      logInfo('Gateway', 'service online', { service: svc.name, pid: child.pid });
    }
  }, 3000);

  logInfo('Gateway', 'service starting', { service: svc.name, pid: child.pid });
}

// ── Health Check (port 3000) ────────────────────────────────────────────────

// ── Webhook Sender (shared by gateway + webhook routes) ──
async function sendWebhook(payload) {
  const webhook = process.env.DISCORD_WEBHOOK || '';
  if (!webhook) return { sent: false, reason: 'no webhook URL' };
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok ? { sent: true } : { sent: false, status: res.status };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

function buildEmbed({ title, description, color = 0x00ff00, fields = [], footer = '' }) {
  return {
    embeds: [{
      title: String(title || '').slice(0, 256),
      description: String(description || '').slice(0, 4096),
      color,
      fields: (fields || []).slice(0, 25).map(f => ({
        name: String(f.name || '').slice(0, 256),
        value: String(f.value || '').slice(0, 1024),
        inline: f.inline !== false,
      })),
      footer: { text: String(footer || '').slice(0, 2048) },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Read helper for POST body ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function startHealthCheck() {
  const server = http.createServer(async (req, res) => {
    // ── Health check ──
    if (req.url === '/health') {
      const mem = process.memoryUsage();
      const modules = {};
      for (const [n, s] of Object.entries(serviceState)) {
        modules[n] = { status: s.status, restarts: s.restarts, pid: s.process?.pid || null };
      }
      const allOk = SERVICES.every(s => serviceState[s.name].status === 'online');
      const sysHealth = getSystemHealth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: allOk ? 'healthy' : 'degraded',
        version: GATEWAY_VERSION,
        uptime: Math.round((Date.now() - startTime) / 1000),
        memory: { rss: Math.round(mem.rss / 1024 / 1024) + 'MB' },
        health: { score: sysHealth.score, rating: sysHealth.rating },
        modules,
      }, null, 2));
      return;
    }

    // ── Prometheus metrics ──
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(getPrometheusMetrics());
      return;
    }

    // ── Restart all services ──
    if (req.url === '/restart' && req.method === 'POST') {
      res.writeHead(200); res.end('Restarting...');
      for (const svc of SERVICES) {
        if (serviceState[svc.name].process) serviceState[svc.name].process.kill('SIGTERM');
        setTimeout(() => startService(svc), 1000);
      }
      return;
    }

    // ── Webhook: Pipeline completion ──
    if (req.url === '/webhook/pipeline' && req.method === 'POST') {
      const body = await readBody(req);
      const { status, topic, results, duration, error } = body;
      const color = status === 'success' ? 0x00ff00 : status === 'partial' ? 0xffaa00 : 0xff0000;
      const fields = [];
      if (topic) fields.push({ name: '📌 Topic', value: topic, inline: true });
      if (duration) fields.push({ name: '⏱️ Duration', value: `${duration}ms`, inline: true });
      if (results) {
        if (results.videos) fields.push({ name: '🎬 Videos', value: String(results.videos), inline: true });
        if (results.repos) fields.push({ name: '📦 Repos', value: String(results.repos), inline: true });
        if (results.flashcards) fields.push({ name: '📚 Flashcards', value: String(results.flashcards), inline: true });
      }
      if (error) fields.push({ name: '❌ Error', value: String(error).slice(0, 500) });
      const result = await sendWebhook(buildEmbed({
        title: `🔄 Pipeline ${status === 'success' ? 'Complete' : 'Failed'}`,
        description: `Pipeline execution finished with status: **${status}**`,
        color, fields, footer: 'AI Brain Pipeline',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: Alert ──
    if (req.url === '/webhook/alert' && req.method === 'POST') {
      const body = await readBody(req);
      const { severity = 'warning', title, message, source, details } = body;
      const colors = { info: 0x00ff00, warning: 0xffaa00, error: 0xff0000, critical: 0xff0000 };
      const icons = { info: 'ℹ️', warning: '⚠️', error: '❌', critical: '🚨' };
      const fields = [];
      if (source) fields.push({ name: '📍 Source', value: source, inline: true });
      if (details) fields.push({ name: '📋 Details', value: String(details).slice(0, 500) });
      const result = await sendWebhook(buildEmbed({
        title: `${icons[severity] || '⚠️'} ${title || 'Alert'}`,
        description: String(message || '').slice(0, 4096),
        color: colors[severity] || 0xffaa00, fields, footer: 'AI Brain Alert System',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: System health ──
    if (req.url === '/webhook/health' && req.method === 'POST') {
      const body = await readBody(req);
      const { cpu, memory, uptime, services, alerts } = body;
      const fields = [];
      if (cpu !== undefined) fields.push({ name: '🖥️ CPU', value: `${cpu}%`, inline: true });
      if (memory !== undefined) fields.push({ name: '💾 Memory', value: `${memory}%`, inline: true });
      if (uptime) fields.push({ name: '⏱️ Uptime', value: `${uptime}h`, inline: true });
      if (services) {
        for (const [name, status] of Object.entries(services)) {
          fields.push({ name: `⚙️ ${name}`, value: status === 'online' ? '🟢 Online' : '🔴 Offline', inline: true });
        }
      }
      const color = (alerts || 0) > 0 ? 0xffaa00 : 0x00ff00;
      const result = await sendWebhook(buildEmbed({
        title: '📊 System Health Report',
        description: (alerts || 0) > 0 ? `⚠️ ${alerts} active alert(s)` : '✅ All systems operational',
        color, fields, footer: 'AI Brain Monitoring',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: Debate result ──
    if (req.url === '/webhook/debate' && req.method === 'POST') {
      const body = await readBody(req);
      const { problem, winner, summary, metrics } = body;
      const fields = [];
      if (winner) fields.push({ name: '🏆 Winner', value: winner, inline: true });
      if (metrics) {
        if (metrics.latency) fields.push({ name: '⏱️ Latency', value: `${metrics.latency}ms`, inline: true });
        if (metrics.memory) fields.push({ name: '💾 Memory', value: `${metrics.memory}KB`, inline: true });
        if (metrics.score) fields.push({ name: '📊 Score', value: String(metrics.score), inline: true });
      }
      const result = await sendWebhook(buildEmbed({
        title: '🏛️ Debate Result',
        description: `**Problem:** ${String(problem || '').slice(0, 200)}\n\n**Summary:** ${String(summary || '').slice(0, 1000)}`,
        color: 0x5865f2, fields, footer: 'DebateAgent — Tòa Án Trọng Tài',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: Security audit ──
    if (req.url === '/webhook/security' && req.method === 'POST') {
      const body = await readBody(req);
      const { score, riskLevel, secrets, vulnerabilities, summary } = body;
      const colors = { low: 0x00ff00, medium: 0xffaa00, high: 0xff6600, critical: 0xff0000 };
      const fields = [];
      if (score !== undefined) fields.push({ name: '🛡️ Score', value: `${score}/100`, inline: true });
      if (riskLevel) fields.push({ name: '⚠️ Risk', value: riskLevel.toUpperCase(), inline: true });
      if (secrets !== undefined) fields.push({ name: '🔑 Secrets', value: String(secrets), inline: true });
      if (vulnerabilities !== undefined) fields.push({ name: '🐛 Vulns', value: String(vulnerabilities), inline: true });
      const result = await sendWebhook(buildEmbed({
        title: '🔒 Security Audit Report',
        description: String(summary || '').slice(0, 2000),
        color: colors[riskLevel] || 0xffaa00, fields, footer: 'SecurityAuditor',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: Code analysis ──
    if (req.url === '/webhook/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const { language, score, grade, issues, summary } = body;
      const colors = { A: 0x00ff00, B: 0x88ff00, C: 0xffaa00, D: 0xff6600, F: 0xff0000 };
      const fields = [];
      if (language) fields.push({ name: '📝 Language', value: language, inline: true });
      if (grade) fields.push({ name: '📊 Grade', value: grade, inline: true });
      if (issues !== undefined) fields.push({ name: '⚠️ Issues', value: String(issues), inline: true });
      const result = await sendWebhook(buildEmbed({
        title: '🔍 Code Analysis Report',
        description: String(summary || '').slice(0, 2000),
        color: colors[grade] || 0xffaa00, fields, footer: 'CodeAnalyzer',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: Performance profile ──
    if (req.url === '/webhook/profile' && req.method === 'POST') {
      const body = await readBody(req);
      const { language, rating, issues, summary } = body;
      const colors = { A: 0x00ff00, B: 0x88ff00, C: 0xffaa00, D: 0xff6600, F: 0xff0000 };
      const fields = [];
      if (language) fields.push({ name: '📝 Language', value: language, inline: true });
      if (rating) fields.push({ name: '⚡ Rating', value: rating, inline: true });
      if (issues !== undefined) fields.push({ name: '⚠️ Issues', value: String(issues), inline: true });
      const result = await sendWebhook(buildEmbed({
        title: '⚡ Performance Profile',
        description: String(summary || '').slice(0, 2000),
        color: colors[rating] || 0xffaa00, fields, footer: 'PerformanceProfiler',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Webhook: Log analysis ──
    if (req.url === '/webhook/logs' && req.method === 'POST') {
      const body = await readBody(req);
      const { healthScore, rating, errorCount, warningCount, summary } = body;
      const colors = { healthy: 0x00ff00, warning: 0xffaa00, critical: 0xff0000 };
      const fields = [];
      if (healthScore !== undefined) fields.push({ name: '💚 Health', value: `${healthScore}/100`, inline: true });
      if (rating) fields.push({ name: '📊 Status', value: rating, inline: true });
      if (errorCount !== undefined) fields.push({ name: '🔴 Errors', value: String(errorCount), inline: true });
      if (warningCount !== undefined) fields.push({ name: '⚠️ Warnings', value: String(warningCount), inline: true });
      const result = await sendWebhook(buildEmbed({
        title: '📋 Log Analysis Report',
        description: String(summary || '').slice(0, 2000),
        color: colors[rating] || 0xffaa00, fields, footer: 'LogAnalyzer',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── 404 ──
    res.writeHead(404); res.end('Not found');
  });
  server.listen(3000, () => logInfo('Gateway', 'health server listening', { port: 3000 }));
}

// ── Shutdown ────────────────────────────────────────────────────────────────

function shutdown(signal) {
  logInfo('Gateway', 'shutdown signal received', { signal });
  for (const svc of SERVICES) {
    if (serviceState[svc.name].process) serviceState[svc.name].process.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  logInfo('Gateway', 'AI Brain Gateway starting', { version: GATEWAY_VERSION, services: SERVICES.length });

  startHealthCheck();

  logInfo('Gateway', 'starting services', { count: SERVICES.length });
  for (const svc of SERVICES) startService(svc);

  setTimeout(() => {
    const mem = process.memoryUsage();
    const svcReport = {};
    for (const [n, s] of Object.entries(serviceState)) {
      svcReport[n] = { status: s.status, pid: s.process?.pid || null };
    }
    logInfo('Gateway', 'status report', {
      services: svcReport,
      gateway_ram_mb: Math.round(mem.rss / 1024 / 1024),
      ports: { health: 3000, rest_api: 3005, feedback: 4002 },
    });
  }, 5000);

  // Memory watchdog — log warning if gateway itself uses too much
  setInterval(() => {
    const mem = process.memoryUsage();
    const rssMB = mem.rss / 1024 / 1024;
    if (rssMB > 200) {
    logWarn('Gateway', 'high memory usage', { rss_mb: Math.round(rssMB) });
      if (global.gc) global.gc();
    }
  }, 60000);

  // Observability — periodic health check + auto-alert (every 5 minutes)
  setInterval(() => {
    try {
      checkAndAlert();
    } catch (err) {
      logError('Gateway', 'health check error', { error: err.message });
    }
  }, 5 * 60 * 1000);
}

main().catch((err) => { logError('Gateway', 'fatal error', { error: err.message, stack: err.stack }); process.exit(1); });
