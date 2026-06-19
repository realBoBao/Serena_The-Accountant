/**
 * lib/behavioral_predictor.js — Behavioral Predictor (Tier 4: Orwell's Vision)
 *
 * "Who controls the past controls the future."
 *
 * Dựa trên lịch sử chuỗi hành vi trong quá khứ, module này:
 * 1. Tìm patterns lặp lại (A → B trong X giờ)
 * 2. Dự đoán rủi ro khi event mới xảy ra
 * 3. Gửi cảnh báo chủ động qua Discord
 *
 * Không cần Markov Chain phức tạp — chỉ cần sequence matching trong SQLite.
 *
 * Usage:
 *   import { BehavioralPredictor } from './behavioral_predictor.js';
 *   const risks = await BehavioralPredictor.checkRisk('deploy', 'production');
 */

import { getLogger } from './logger.js';

const logger = getLogger('BehavioralPredictor');

// ── In-memory cache ─────────────────────────────────────────────────────────
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Lấy DB instance (lazy load)
 */
function getDb() {
  // Dynamic import to avoid circular dependency
  const { getDb: _getDb } = require('./sqlite_adapter.js');
  return _getDb();
}

/**
 * Tìm patterns lặp lại trong lịch sử events.
 * Pattern: "mỗi lần A xảy ra, B thường theo sau trong vòng X giờ"
 *
 * @param {string|null} userId — Filter by user (null = all users)
 * @param {number} lookbackDays — Số ngày nhìn lại
 * @returns {Array<{key, count, avgGapHours, triggerSource, triggerTopic, predictedSource, predictedTopic}>}
 */
export function findRiskPatterns(userId = null, lookbackDays = 30) {
  // Check cache
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    return _cache;
  }

  try {
    const db = getDb();

    // Try to get events from knowledge graph episodes or memory_entries
    let episodes = [];
    try {
      episodes = db.prepare(`
        SELECT source, topic, created_at FROM kg_episodes
        WHERE created_at >= datetime('now', '-${lookbackDays} days')
        ORDER BY created_at ASC
      `).all();
    } catch {
      // kg_episodes not available, try memory_entries
      try {
        episodes = db.prepare(`
          SELECT source, tags as topic, created_at FROM memory_entries
          WHERE archived = 0 AND created_at >= datetime('now', '-${lookbackDays} days')
          ORDER BY created_at ASC
        `).all();
      } catch {
        // No episode data available
        return [];
      }
    }

    if (episodes.length < 2) return [];

    const patterns = [];

    // Sliding window: tìm cặp (A → B) xảy ra >= 2 lần
    for (let i = 0; i < episodes.length - 1; i++) {
      const current = episodes[i];
      const next = episodes[i + 1];

      // Khoảng cách thời gian giữa 2 events
      const gapMs = new Date(next.created_at) - new Date(current.created_at);
      const gapHours = gapMs / 3_600_000;

      if (gapHours > 48 || gapHours < 0) continue; // quá xa hoặc reverse

      const currentTopic = (current.topic || 'unknown').slice(0, 50);
      const nextTopic = (next.topic || 'unknown').slice(0, 50);
      const patternKey = `${currentTopic} → ${nextTopic}`;

      const existing = patterns.find(p => p.key === patternKey);
      if (existing) {
        existing.count++;
        existing.avgGapHours = (existing.avgGapHours * (existing.count - 1) + gapHours) / existing.count;
      } else {
        patterns.push({
          key: patternKey,
          count: 1,
          avgGapHours: gapHours,
          triggerSource: current.source || 'unknown',
          triggerTopic: currentTopic,
          predictedSource: next.source || 'unknown',
          predictedTopic: nextTopic,
        });
      }
    }

    // Chỉ return patterns đã xảy ra >= 2 lần
    const result = patterns
      .filter(p => p.count >= 2)
      .sort((a, b) => b.count - a.count);

    // Cache result
    _cache = result;
    _cacheTime = Date.now();

    return result;
  } catch (err) {
    logger.warn(`[BehavioralPredictor] findRiskPatterns failed: ${err.message}`);
    return [];
  }
}

/**
 * Khi event mới xảy ra, check xem có pattern nào predict rủi ro không.
 *
 * @param {string} currentSource — Nguồn event hiện tại (ví dụ: 'deploy', 'scheduler')
 * @param {string} currentTopic — Chủ đề event hiện tại
 * @returns {Array<{warning, confidence}>} — Cảnh báo rủi ro
 */
export function checkRisk(currentSource, currentTopic) {
  try {
    const patterns = findRiskPatterns(null, 30);

    const triggered = patterns.filter(p => {
      // Match trigger topic (fuzzy)
      const topicLower = currentTopic.toLowerCase();
      const triggerLower = p.triggerTopic.toLowerCase();
      return triggerLower.includes(topicLower) || topicLower.includes(triggerLower);
    });

    return triggered.map(p => ({
      warning: `⚠️ Dựa trên ${p.count} lần trước: sau "${p.triggerTopic}", thường xảy ra "${p.predictedTopic}" trong ~${Math.round(p.avgGapHours)}h`,
      confidence: Math.min(p.count / 5, 1.0), // 5+ lần = 100% confidence
      predictedTopic: p.predictedTopic,
      avgGapHours: Math.round(p.avgGapHours),
    }));
  } catch (err) {
    logger.warn(`[BehavioralPredictor] checkRisk failed: ${err.message}`);
    return [];
  }
}

/**
 * Gửi cảnh báo rủi ro qua Discord webhook.
 *
 * @param {Array<{warning, confidence}>} risks
 * @param {string} source — Nguồn cảnh báo (ví dụ: 'scheduler', 'deploy')
 * @returns {Promise<boolean>} true nếu gửi thành công
 */
export async function sendRiskAlert(risks, source = 'system') {
  if (!risks || risks.length === 0) return false;

  const highConfidence = risks.filter(r => r.confidence > 0.6);
  if (highConfidence.length === 0) return false;

  try {
    const webhook = process.env.DISCORD_WEBHOOK;
    if (!webhook) return false;

    const lines = highConfidence.map(r => r.warning);
    const payload = {
      embeds: [{
        title: `🔮 Cảnh báo rủi ro — ${source}`,
        description: lines.join('\n'),
        color: 0xff6600,
        timestamp: new Date().toISOString(),
        footer: { text: `Behavioral Predictor • ${highConfidence.length} pattern(s) matched` },
      }],
    };

    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      logger.info(`[BehavioralPredictor] Sent ${highConfidence.length} risk alerts to Discord`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Clear cache (useful for testing)
 */
export function clearCache() {
  _cache = null;
  _cacheTime = 0;
}
