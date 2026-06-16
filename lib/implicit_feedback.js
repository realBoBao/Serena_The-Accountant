/**
 * lib/implicit_feedback.js — Implicit Feedback Loop (Tier 1)
 *
 * Thuật toán Lắng nghe Ngầm: đo lường hành vi vô thức của user
 * thay vì hỏi trực tiếp "có thích không".
 *
 * Theo dõi:
 * - Click-through rate (CTR): user có click link bot gửi không
 * - Dwell time: thời gian giữa bot gửi → user reply (proxy cho mức độ quan tâm)
 * - Response latency pattern: reply nhanh = engaged, reply chậm = distracted
 * - Skip rate: user ignore hoàn toàn → negative signal
 * - Category affinity: tổng hợp implicit score theo category (video, repo, article...)
 *
 * Lưu trữ SQLite — không cần dependency mới.
 *
 * Usage:
 *   import { implicitFeedback } from './implicit_feedback.js';
 *   const linkId = implicitFeedback.trackOutbound(userId, { url, category, messageId });
 *   implicitFeedback.recordClick(linkId, userId);
 *   implicitFeedback.recordDwellTime(linkId, userId, ms);
 *   const affinity = implicitFeedback.getCategoryAffinity(userId);
 *   const signals = implicitFeedback.getImplicitSignals(userId);
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getLogger } from './logger.js';

const logger = getLogger('ImplicitFeedback');

const DB_PATH = path.join(process.cwd(), 'data', 'implicit_feedback.db');

// ── SQLite wrapper (sync via sqlite3, same pattern as user_profile.js) ──
let db = null;

function getDb() {
  if (db) return db;
  try {
    const sqlite3 = require('sqlite3').verbose();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new sqlite3.Database(DB_PATH);
    _init(db);
    logger.info('[ImplicitFeedback] SQLite initialized at', DB_PATH);
    return db;
  } catch (err) {
    logger.warn('[ImplicitFeedback] SQLite unavailable:', err.message);
    return null;
  }
}

function _init(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_links (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      url           TEXT,
      category      TEXT DEFAULT 'unknown',
      message_id    TEXT,
      sent_at       TEXT DEFAULT (datetime('now')),
      clicked       INTEGER DEFAULT 0,
      click_at      TEXT,
      dwell_time_ms INTEGER,
      replied       INTEGER DEFAULT 0,
      reply_at      TEXT,
      reply_latency_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS category_affinity (
      user_id       TEXT NOT NULL,
      category      TEXT NOT NULL,
      implicit_score REAL DEFAULT 0.5,
      click_count   INTEGER DEFAULT 0,
      skip_count    INTEGER DEFAULT 0,
      total_sent    INTEGER DEFAULT 0,
      last_updated  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, category)
    );

    CREATE TABLE IF NOT EXISTS dwell_time_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      link_id       TEXT,
      dwell_time_ms INTEGER NOT NULL,
      category      TEXT,
      recorded_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_user ON outbound_links(user_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_msg  ON outbound_links(message_id);
    CREATE INDEX IF NOT EXISTS idx_affinity_user ON category_affinity(user_id);
    CREATE INDEX IF NOT EXISTS idx_dwell_user    ON dwell_time_log(user_id);
  `);
}

function dbRun(sql, params = []) {
  const d = getDb();
  if (!d) return;
  try { d.run(sql, params); } catch (err) { logger.warn('[IF] dbRun error:', err.message); }
}

function dbGet(sql, params = []) {
  const d = getDb();
  if (!d) return null;
  let result = null;
  try { d.get(sql, params, (err, row) => { if (!err && row) result = row; }); } catch { /* */ }
  return result;
}

function dbAll(sql, params = []) {
  const d = getDb();
  if (!d) return [];
  let results = [];
  try { d.all(sql, params, (err, rows) => { if (!err && rows) results = rows; }); } catch { /* */ }
  return results;
}

// ── Helpers ──

function _now() {
  return new Date().toISOString();
}

/** Generate short tracking ID */
function _genId() {
  return 'if_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Compute implicit score from behavioral signals.
 *
 * Signals:
 *   click         → +0.30  (strongest positive)
 *   fast reply    → +0.20  (dwell < 30s = engaged)
 *   medium reply  → +0.05  (dwell 30s–5m = neutral)
 *   slow reply    → -0.05  (dwell > 5m = distracted)
 *   no reply      → -0.15  (skip = negative)
 *
 * Score clamped to [0, 1].
 */
function _computeImplicitSignal(clicked, replyLatencyMs) {
  let score = 0.5; // neutral baseline
  if (clicked) score += 0.30;
  if (replyLatencyMs !== null && replyLatencyMs !== undefined) {
    if (replyLatencyMs < 30000) score += 0.20;        // < 30s: engaged
    else if (replyLatencyMs < 300000) score += 0.05;   // 30s–5m: neutral
    else score -= 0.05;                                 // > 5m: distracted
  } else {
    score -= 0.15; // no reply at all
  }
  return Math.max(0, Math.min(1, score));
}

// ── ImplicitFeedback Manager ──

class ImplicitFeedbackManager {

  /**
   * Track a link/content piece sent to user.
   * Returns tracking ID for later correlation.
   *
   * @param {string} userId
   * @param {Object} opts
   * @param {string} opts.url         — URL gửi đi (có thể null cho non-link content)
   * @param {string} opts.category    — 'video' | 'repo' | 'article' | 'book' | 'evo' | ...
   * @param {string} opts.messageId   — Discord message ID (for reply correlation)
   * @returns {string} tracking ID
   */
  trackOutbound(userId, { url = null, category = 'unknown', messageId = null } = {}) {
    const id = _genId();
    dbRun(
      'INSERT INTO outbound_links (id, user_id, url, category, message_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, userId, url, category, messageId, _now()]
    );

    // Upsert category affinity: increment total_sent
    dbRun(`INSERT INTO category_affinity (user_id, category, total_sent)
           VALUES (?, ?, 1)
           ON CONFLICT(user_id, category) DO UPDATE SET
             total_sent = total_sent + 1,
             last_updated = datetime('now')`,
      [userId, category]
    );

    logger.info(`[IF] Tracked outbound → ${userId} [${category}] id=${id.slice(0, 20)}…`);
    return id;
  }

  /**
   * Record that user clicked a tracked link.
   * @param {string} linkId  — tracking ID from trackOutbound
   * @param {string} userId
   */
  recordClick(linkId, userId) {
    dbRun(
      'UPDATE outbound_links SET clicked = 1, click_at = ? WHERE id = ? AND user_id = ?',
      [_now(), linkId, userId]
    );

    // Update category affinity
    const row = dbGet('SELECT category FROM outbound_links WHERE id = ?', [linkId]);
    if (row) {
      dbRun(`UPDATE category_affinity SET
               click_count = click_count + 1,
               last_updated = datetime('now')
             WHERE user_id = ? AND category = ?`,
        [userId, row.category]
      );
    }
    logger.info(`[IF] Click recorded: ${linkId.slice(0, 20)}… user=${userId}`);
  }

  /**
   * Record dwell time — thời gian từ khi bot gửi → user reply.
   * @param {string} linkId
   * @param {string} userId
   * @param {number} dwellTimeMs
   */
  recordDwellTime(linkId, userId, dwellTimeMs) {
    dbRun(
      'UPDATE outbound_links SET replied = 1, reply_at = ?, dwell_time_ms = ?, reply_latency_ms = ? WHERE id = ? AND user_id = ?',
      [_now(), dwellTimeMs, dwellTimeMs, linkId, userId]
    );

    dbRun(
      'INSERT INTO dwell_time_log (user_id, link_id, dwell_time_ms, category) SELECT ?, ?, ?, category FROM outbound_links WHERE id = ?',
      [userId, linkId, dwellTimeMs, linkId]
    );

    // Recompute category affinity score
    const row = dbGet('SELECT category FROM outbound_links WHERE id = ?', [linkId]);
    if (row) {
      this._recomputeAffinity(userId, row.category);
    }
  }

  /**
   * Record skip — user received but never replied/clicked.
   * Called by cron job for old unclicked links.
   * @param {string} userId
   * @param {string} category
   */
  recordSkip(userId, category) {
    dbRun(`UPDATE category_affinity SET
             skip_count = skip_count + 1,
             last_updated = datetime('now')
           WHERE user_id = ? AND category = ?`,
      [userId, category]
    );
    this._recomputeAffinity(userId, category);
  }

  /**
   * Get category affinity scores for a user.
   * Returns array sorted by implicit_score descending.
   */
  getCategoryAffinity(userId) {
    return dbAll(
      'SELECT category, implicit_score, click_count, skip_count, total_sent FROM category_affinity WHERE user_id = ? ORDER BY implicit_score DESC',
      [userId]
    );
  }

  /**
   * Get aggregated implicit signals for a user.
   * Returns summary object for EvoAgent / SuggestionAgent.
   */
  getImplicitSignals(userId) {
    const affinity = this.getCategoryAffinity(userId);

    const avgDwell = dbGet(
      'SELECT AVG(dwell_time_ms) as avg_dwell, COUNT(*) as total_replies FROM dwell_time_log WHERE user_id = ?',
      [userId]
    );

    const totalSent = affinity.reduce((s, a) => s + (a.total_sent || 0), 0);
    const totalClicks = affinity.reduce((s, a) => s + (a.click_count || 0), 0);
    const ctr = totalSent > 0 ? totalClicks / totalSent : 0;

    // Top category = highest implicit score
    const topCategory = affinity.length > 0 ? affinity[0].category : null;
    const bottomCategory = affinity.length > 0 ? affinity[affinity.length - 1].category : null;

    return {
      userId,
      categoryAffinity: affinity,
      topCategory,
      bottomCategory,
      clickThroughRate: parseFloat(ctr.toFixed(3)),
      avgDwellTimeMs: avgDwell?.avg_dwell || null,
      totalReplies: avgDwell?.total_replies || 0,
      totalSent,
      computedAt: _now(),
    };
  }

  /**
   * Mark old unclicked links as skips (for cron cleanup).
   * @param {number} olderThanHours — default 48h
   * @returns {number} count of newly marked skips
   */
  markOldUnclickedAsSkipped(olderThanHours = 48) {
    const old = dbAll(
      `SELECT id, user_id, category FROM outbound_links
       WHERE clicked = 0 AND replied = 0 AND sent_at < datetime('now', ?)`,
      [`-${olderThanHours} hours`]
    );

    for (const row of old) {
      this.recordSkip(row.user_id, row.category);
    }

    if (old.length > 0) {
      logger.info(`[IF] Marked ${old.length} old unclicked links as skipped`);
    }
    return old.length;
  }

  /**
   * Internal: recompute implicit_score for a (user, category) pair.
   */
  _recomputeAffinity(userId, category) {
    const stats = dbGet(
      `SELECT
         COUNT(*) as total,
         SUM(clicked) as clicks,
         SUM(replied) as replies,
         AVG(CASE WHEN reply_latency_ms > 0 THEN reply_latency_ms END) as avg_latency
       FROM outbound_links
       WHERE user_id = ? AND category = ?`,
      [userId, category]
    );

    if (!stats || stats.total === 0) return;

    const clicked = stats.clicks > 0;
    const avgLatency = stats.avg_latency;
    const score = _computeImplicitSignal(clicked, avgLatency);

    dbRun(
      `UPDATE category_affinity SET implicit_score = ?, last_updated = datetime('now')
       WHERE user_id = ? AND category = ?`,
      [score, userId, category]
    );
  }

  /**
   * Cleanup old records (keep 90 days).
   */
  cleanup(daysToKeep = 90) {
    dbRun("DELETE FROM outbound_links WHERE sent_at < datetime('now', ?)", [`-${daysToKeep} days`]);
    dbRun("DELETE FROM dwell_time_log WHERE recorded_at < datetime('now', ?)", [`-${daysToKeep} days`]);
    logger.info(`[ImplicitFeedback] Cleaned up records older than ${daysToKeep} days`);
  }
}

// ── Singleton export ──
export const implicitFeedback = new ImplicitFeedbackManager();
export default implicitFeedback;
