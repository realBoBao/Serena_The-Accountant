/**
 * ═══════════════════════════════════════════════════════════════
 * LogAnalyzer — Phân tích Log Patterns, Error Clustering & Alerting
 * ═══════════════════════════════════════════════════════════════
 *
 * Cung cấp:
 *   - parseLogLine(line) → Parse một dòng log
 *   - analyzeLog(logText) → Phân tích block log
 *   - clusterErrors(errors) → Nhóm lỗi theo pattern
 *   - detectAnomalies(logs) → Phát hiện bất thường
 *   - getErrorTrends(logs, timeWindow) → Xu hướng lỗi theo thời gian
 *   - generateAlert(analysis) → Tạo alert nếu cần
 *
 * Được gọi bởi:
 * - discord_bot.js (!logs)
 * - REST API (/api/logs/analyze)
 * - EvoAgent (giám sát system health)
 * - scheduler.js (cron log analysis)
 */

import { getLogger } from './logger.js';
import { ask as llmAsk } from './llm.js';

const logger = getLogger('LogAnalyzer');

// ── Log Parsing ───────────────────────────────────────────────────

/**
 * Parse một dòng log thành structured object
 */
export function parseLogLine(line) {
  // Common log formats
  const patterns = [
    // ISO timestamp + level + message
    /^(\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+)\s+\[?(\w+)\]?\s+(.*)$/,
    // Simple timestamp + level
    /^(\d{4}-\d{2}-\d{2}\s+[\d:]+)\s+\[?(\w+)\]?\s+(.*)$/,
    // PM2 format
    /^\d+\|[\w\-]+\s+\|\s+(.*)$/,
    // JSON log
    /^(\{.*\})$/,
    // Fallback: treat entire line as message
    /^(.*)$/,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      if (pattern.source === '(\\{.*\\})$') {
        try {
          const json = JSON.parse(match[1]);
          return { timestamp: json.ts || json.timestamp, level: json.level || 'info', message: json.msg || json.message || line, raw: json };
        } catch {
          return { timestamp: null, level: 'info', message: line };
        }
      }
      if (pattern.source === '(\\\\d\\|\\[\\w\\-\\]\\+\\s+\\|\\s+(.*))') {
        return { timestamp: new Date().toISOString(), level: 'info', message: match[1] };
      }
      return { timestamp: match[1], level: (match[2] || 'info').toLowerCase(), message: match[3] || match[1] };
    }
  }

  return { timestamp: null, level: 'info', message: line };
}

// ── Error Clustering ──────────────────────────────────────────────

/**
 * Nhóm lỗi theo pattern (loại bỏ giá trị cụ thể)
 */
export function clusterErrors(errors) {
  const clusters = new Map();

  for (const error of errors) {
    // Normalize error message: remove specific values
    const normalized = error
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+\b/g, '<TIMESTAMP>')
      .replace(/\b0x[0-9a-f]+\b/gi, '<ADDR>')
      .replace(/\b\d+\b/g, '<N>')
      .replace(/['"][^'"]*['"]/g, '<STR>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    const key = normalized;
    if (!clusters.has(key)) {
      clusters.set(key, { pattern: normalized, count: 0, examples: [], firstSeen: null, lastSeen: null });
    }
    const cluster = clusters.get(key);
    cluster.count++;
    if (cluster.examples.length < 3) cluster.examples.push(error.slice(0, 150));
  }

  return [...clusters.values()].sort((a, b) => b.count - a.count);
}

// ── Anomaly Detection ─────────────────────────────────────────────

/**
 * Phát hiện bất thường trong logs
 */
export function detectAnomalies(logs) {
  const anomalies = [];
  const errorCounts = new Map();
  const hourlyBuckets = new Map();

  for (const log of logs) {
    const parsed = typeof log === 'string' ? parseLogLine(log) : log;
    const hour = parsed.timestamp ? parsed.timestamp.slice(0, 13) : 'unknown';

    // Count errors per hour
    if (['error', 'critical', 'fatal'].includes(parsed.level)) {
      hourlyBuckets.set(hour, (hourlyBuckets.get(hour) || 0) + 1);
      errorCounts.set(parsed.message, (errorCounts.get(parsed.message) || 0) + 1);
    }
  }

  // Detect error spikes
  const counts = [...hourlyBuckets.values()];
  if (counts.length > 2) {
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const max = Math.max(...counts);
    if (max > avg * 3) {
      anomalies.push({
        type: 'error_spike',
        severity: 'high',
        message: `Error spike detected: ${max} errors (avg: ${Math.round(avg)})`,
        details: { max, average: Math.round(avg) },
      });
    }
  }

  // Detect repeated errors
  for (const [msg, count] of errorCounts) {
    if (count > 10) {
      anomalies.push({
        type: 'repeated_error',
        severity: count > 50 ? 'critical' : 'warning',
        message: `Repeated error (${count}x): ${msg.slice(0, 100)}`,
        count,
      });
    }
  }

  return anomalies;
}

// ── Log Analysis ──────────────────────────────────────────────────

/**
 * Phân tích block log hoàn chỉnh
 */
export function analyzeLog(logText) {
  const lines = logText.split('\n').filter(l => l.trim());
  const parsed = lines.map(parseLogLine);

  // Count by level
  const levelCounts = {};
  const errors = [];
  const warnings = [];

  for (const p of parsed) {
    levelCounts[p.level] = (levelCounts[p.level] || 0) + 1;
    if (['error', 'critical', 'fatal'].includes(p.level)) {
      errors.push(p.message);
    } else if (p.level === 'warning' || p.level === 'warn') {
      warnings.push(p.message);
    }
  }

  // Cluster errors
  const errorClusters = clusterErrors(errors);

  // Detect anomalies
  const anomalies = detectAnomalies(parsed);

  // Calculate health score
  const totalLines = lines.length;
  const errorRate = errors.length / totalLines;
  const healthScore = Math.max(0, Math.round(100 - errorRate * 100 - anomalies.length * 10));

  return {
    totalLines,
    levelCounts,
    errorCount: errors.length,
    warningCount: warnings.length,
    errorRate: Math.round(errorRate * 10000) / 100, // percentage
    errorClusters: errorClusters.slice(0, 10),
    anomalies,
    healthScore,
    rating: healthScore >= 90 ? 'healthy' : healthScore >= 70 ? 'warning' : 'critical',
    topErrors: errorClusters.slice(0, 5).map(c => ({ pattern: c.pattern, count: c.count })),
  };
}

// ── LLM Log Analysis ─────────────────────────────────────────────

export async function analyzeLogsWithLlm(logText) {
  const prompt = `You are a system administrator analyzing application logs. Review the following logs and provide:

1. **Health Status**: healthy / warning / critical
2. **Top Issues**: 3-5 most important issues
3. **Root Cause Analysis**: Likely causes of errors
4. **Recommendations**: Actionable fixes
5. **Urgency**: low / medium / high / critical

Recent logs:
\`\`
${logText.slice(0, 4000)}
\`\`

Respond in JSON format:
{"health": string, "issues": string[], "root_causes": string[], "recommendations": string[], "urgency": string}`;

  try {
    const { answer } = await llmAsk(prompt, {
      systemPrompt: 'You are a senior SRE. Always respond in valid JSON.',
      temperature: 0.2,
      maxTokens: 1024,
    });

    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { raw: answer };
  } catch (err) {
    logger.warn('[LogAnalyzer] LLM analysis failed:', err?.message);
    return { error: 'LLM analysis unavailable' };
  }
}

// ── Main Entry Point ──────────────────────────────────────────────

export async function analyzeLogs(logText, options = {}) {
  const staticAnalysis = analyzeLog(logText);
  let llmReport = null;

  if (options.useLlm !== false && logText.length < 20000) {
    llmReport = await analyzeLogsWithLlm(logText);
  }

  return {
    static: staticAnalysis,
    llm: llmReport,
    timestamp: new Date().toISOString(),
  };
}
