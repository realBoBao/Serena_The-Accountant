#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * WebhookBot — Discord Webhook Notification Service v2
 * ═══════════════════════════════════════════════════════════════
 *
 * Fixes:
 * 1. API Authentication middleware (Bearer token)
 * 2. Exponential backoff retry for Discord rate limits (429)
 * 3. Link buttons for critical alerts (Call to Action)
 * 4. DRY — unified executeDiscordWebhook function
 *
 * Usage: node webhook_bot.js
 * Port: 3007
 */

import 'dotenv/config';
import express from 'express';
import { getLogger } from './lib/logger.js';

const logger = getLogger('WebhookBot');
const PORT = process.env.WEBHOOK_BOT_PORT || 3007;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ═══════════════════════════════════════════════════════════
//  1. API AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use('/webhook', (req, res, next) => {
  // Skip auth nếu không có WEBHOOK_SECRET configured
  if (!WEBHOOK_SECRET) {
    logger.warn('[WebhookBot] WEBHOOK_SECRET not set — skipping auth (dev mode)');
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
    logger.warn(`[WebhookBot] Unauthorized access from ${req.ip} — path: ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ═══════════════════════════════════════════════════════════
//  2. UNIFIED DISCORD WEBHOOK SENDER (DRY + Retry)
// ═══════════════════════════════════════════════════════════

/**
 * Gửi webhook đến Discord với exponential backoff retry.
 * Xử lý rate limit (429) bằng cách đọc header Retry-After.
 *
 * @param {Object} payload — Discord webhook payload
 * @param {Object} [opts] — Options
 * @param {number} [opts.maxRetries=3] — Số lần retry tối đa
 * @param {string} [opts.actionUrl] — URL cho nút Call to Action (critical alerts)
 * @param {string} [opts.actionLabel] — Label cho nút CTA
 * @returns {Promise<{ sent: boolean, status?: number, error?: string }>}
 */
async function executeDiscordWebhook(payload, opts = {}) {
  if (!DISCORD_WEBHOOK) {
    logger.warn('[WebhookBot] DISCORD_WEBHOOK not configured');
    return { sent: false, reason: 'no webhook URL' };
  }

  const { maxRetries = 3, actionUrl, actionLabel } = opts;

  // Thêm Call to Action button nếu có actionUrl
  if (actionUrl) {
    payload.components = [
      {
        type: 1, // ActionRow
        components: [
          {
            type: 2, // Button
            style: 5, // Link
            label: actionLabel || '🔍 Xem chi tiết',
            url: actionUrl,
          },
        ],
      },
    ];
  }

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // Success
      if (res.ok) {
        return { sent: true };
      }

      // Rate limited (429) — đọc Retry-After header
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
        logger.warn(`[WebhookBot] Rate limited (429), retry in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
      }

      // Other error
      const errText = await res.text().catch(() => '');
      logger.error(`[WebhookBot] Discord returned ${res.status}: ${errText.slice(0, 200)}`);
      return { sent: false, status: res.status, error: errText.slice(0, 200) };

    } catch (err) {
      lastError = err.message;
      logger.error(`[WebhookBot] Send failed (attempt ${attempt + 1}): ${err.message}`);
      
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  return { sent: false, error: lastError || 'max retries exceeded' };
}

// ═══════════════════════════════════════════════════════════
//  EMBED BUILDERS
// ═══════════════════════════════════════════════════════════

function buildEmbed({ title, description, color = 0x00ff00, fields = [], footer = '' }) {
  return {
    embeds: [{
      title: title.slice(0, 256),
      description: description.slice(0, 4096),
      color,
      fields: fields.slice(0, 25).map(f => ({
        name: String(f.name || '').slice(0, 256),
        value: String(f.value || '').slice(0, 1024),
        inline: f.inline !== false,
      })),
      footer: { text: footer.slice(0, 2048) },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ═══════════════════════════════════════════════════════════
//  EVENT HANDLERS
// ═══════════════════════════════════════════════════════════

// Pipeline completion
app.post('/webhook/pipeline', async (req, res) => {
  const { status, topic, results, duration, error } = req.body;

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

  const result = await executeDiscordWebhook(buildEmbed({
    title: `🔄 Pipeline ${status === 'success' ? 'Complete' : 'Failed'}`,
    description: `Pipeline execution finished with status: **${status}**`,
    color,
    fields,
    footer: 'AI Brain Pipeline',
  }));

  res.json(result);
});

// Error alert (với CTA button cho critical)
app.post('/webhook/alert', async (req, res) => {
  const { severity = 'warning', title, message, source, details, actionUrl } = req.body;

  const colors = { info: 0x00ff00, warning: 0xffaa00, error: 0xff0000, critical: 0xff0000 };
  const icons = { info: 'ℹ️', warning: '⚠️', error: '❌', critical: '🚨' };

  const fields = [];
  if (source) fields.push({ name: '📍 Source', value: source, inline: true });
  if (details) fields.push({ name: '📋 Details', value: String(details).slice(0, 500) });

  const result = await executeDiscordWebhook(
    buildEmbed({
      title: `${icons[severity] || '⚠️'} ${title || 'Alert'}`,
      description: String(message || '').slice(0, 4096),
      color: colors[severity] || 0xffaa00,
      fields,
      footer: 'AI Brain Alert System',
    }),
    {
      // Critical alerts có nút Call to Action
      actionUrl: severity === 'critical' ? actionUrl : undefined,
      actionLabel: severity === 'critical' ? '🔍 Xem chi tiết Logs' : undefined,
    }
  );

  res.json(result);
});

// System health report
app.post('/webhook/health', async (req, res) => {
  const { cpu, memory, uptime, services, alerts } = req.body;

  const fields = [];
  if (cpu !== undefined) fields.push({ name: '🖥️ CPU', value: `${cpu}%`, inline: true });
  if (memory !== undefined) fields.push({ name: '💾 Memory', value: `${memory}%`, inline: true });
  if (uptime) fields.push({ name: '⏱️ Uptime', value: `${uptime}h`, inline: true });
  if (services) {
    for (const [name, status] of Object.entries(services)) {
      fields.push({ name: `⚙️ ${name}`, value: status === 'online' ? '🟢 Online' : '🔴 Offline', inline: true });
    }
  }

  const color = alerts > 0 ? 0xffaa00 : 0x00ff00;

  const result = await executeDiscordWebhook(buildEmbed({
    title: '📊 System Health Report',
    description: alerts > 0 ? `⚠️ ${alerts} active alert(s)` : '✅ All systems operational',
    color,
    fields,
    footer: 'AI Brain Monitoring',
  }));

  res.json(result);
});

// Debate result
app.post('/webhook/debate', async (req, res) => {
  const { problem, winner, summary, metrics } = req.body;

  const fields = [];
  if (winner) fields.push({ name: '🏆 Winner', value: winner, inline: true });
  if (metrics) {
    if (metrics.latency) fields.push({ name: '⏱️ Latency', value: `${metrics.latency}ms`, inline: true });
    if (metrics.memory) fields.push({ name: '💾 Memory', value: `${metrics.memory}KB`, inline: true });
    if (metrics.score) fields.push({ name: '📊 Score', value: String(metrics.score), inline: true });
  }

  const result = await executeDiscordWebhook(buildEmbed({
    title: '🏛️ Debate Result',
    description: `**Problem:** ${String(problem || '').slice(0, 200)}\n\n**Summary:** ${String(summary || '').slice(0, 1000)}`,
    color: 0x5865f2,
    fields,
    footer: 'DebateAgent — Tòa Án Trọng Tài',
  }));

  res.json(result);
});

// Security audit result
app.post('/webhook/security', async (req, res) => {
  const { score, riskLevel, secrets, vulnerabilities, summary, dashboardUrl } = req.body;

  const colors = { low: 0x00ff00, medium: 0xffaa00, high: 0xff6600, critical: 0xff0000 };
  const fields = [];

  if (score !== undefined) fields.push({ name: '🛡️ Score', value: `${score}/100`, inline: true });
  if (riskLevel) fields.push({ name: '⚠️ Risk', value: riskLevel.toUpperCase(), inline: true });
  if (secrets !== undefined) fields.push({ name: '🔑 Secrets', value: String(secrets), inline: true });
  if (vulnerabilities !== undefined) fields.push({ name: '🐛 Vulns', value: String(vulnerabilities), inline: true });

  const result = await executeDiscordWebhook(
    buildEmbed({
      title: '🔒 Security Audit Report',
      description: String(summary || '').slice(0, 2000),
      color: colors[riskLevel] || 0xffaa00,
      fields,
      footer: 'SecurityAuditor',
    }),
    {
      // High/Critical risk có nút CTA
      actionUrl: ['high', 'critical'].includes(riskLevel) ? dashboardUrl : undefined,
      actionLabel: ['high', 'critical'].includes(riskLevel) ? '🔍 Xem Security Dashboard' : undefined,
    }
  );

  res.json(result);
});

// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'webhook-bot', uptime: process.uptime() });
});

// ═══════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  logger.info(`[WebhookBot] Listening on port ${PORT}`);
  logger.info(`[WebhookBot] Auth: ${WEBHOOK_SECRET ? 'ENABLED' : 'DISABLED (dev mode)'}`);
  logger.info(`[WebhookBot] Discord Webhook: ${DISCORD_WEBHOOK ? 'CONFIGURED' : 'NOT SET'}`);
});

export { executeDiscordWebhook, buildEmbed };
