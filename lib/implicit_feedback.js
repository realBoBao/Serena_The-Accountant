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
 * Lưu trữ SQLite (async via 'sqlite' package) — không cần dependency mới.
 *
 * Usage:
 *   import { implicitFeedback } from './implicit_feedback.js';
 *   const linkId = await implicitFeedback.trackOutbound(userId, { url, category, messageId });
 *   await implicitFeedback.recordClick(linkId, userId);
 *   await implicitFeedback.recordDwellTime(linkId, userId, ms);
 *   const affinity = await implicitFeedback.getCategoryAffinity(userId);
 *   const signals = await implicitFeedback.getImplicitSignals(userId);
 */

import 'dotenv/config';
import path from 'path';
import { open } from './sqlite_adapter.js';
import { getLogger } from './logger.js';

const logger = getLogger('ImplicitFeedback');

const DB_PATH = path.join(process.cwd(), 'data', 'implicit_feedback.db');

// ── Singleton DB connection ──
let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    try {
      const db = await open({ filename: DB_PATH });
      await db.exec(`
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
      logger.info('[ImplicitFeedback] SQLite initialized at', DB_PATH);
      return db;
    } catch (err) {
      logger.warn('[ImplicitFeedback] SQLite unavailable:', err.message);
      return null;
    }
  })();
  return _dbPromise;
}

// ── Helpers ──

function _now() {
  return new Date().toISOString();
}

function _genId() {
  return 'if_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Compute implicit signal from behavioral signals.
 * click → +0.30, fast reply <30s → +0.20, medium 30s–5m → +0.05,
 * slow >5m → -0.05, no reply → -0.15. Clamped [0, 1].
 */
function _computeImplicitSignal(clicked, replyLatencyMs) {
  let score = 0.5;
  if (clicked) score += 0.30;
  if (replyLatencyMs !== null && replyLatencyMs !== undefined) {
    if (replyLatencyMs < 30000) score += 0.20;
    else if (replyLatencyMs < 300000) score += 0.05;
    else score -= 0.05;
  } else {
    score -= 0.15;
  }
  return Math.max(0, Math.min(1, score));
}

// ── ImplicitFeedback Manager ──

class ImplicitFeedbackManager {

  /** Track a link/content piece sent to user. @returns {Promise<string>} tracking ID */
  async trackOutbound(userId, { url = null, category = 'unknown', messageId = null } = {}) {
    const id = _genId();
    const db = await getDb();
    if (!db) return id;
    db.prepare(
      'INSERT INTO outbound_links (id, user_id, url, category, message_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, userId, url, category, messageId, _now());
    db.prepare(
      `INSERT INTO category_affinity (user_id, category, total_sent) VALUES (?, ?, 1)
       ON CONFLICT(user_id, category) DO UPDATE SET total_sent = total_sent + 1, last_updated = datetime('now')`
    ).run(userId, category);
    logger.info(`[IF] Tracked outbound → ${userId} [${category}] id=${id.slice(0, 20)}…`);
    return id;
  }

  /** Record that user clicked a tracked link. */
  async recordClick(linkId, userId) {
    const db = await getDb();
    if (!db) return;
    db.prepare('UPDATE outbound_links SET clicked = 1, click_at = ? WHERE id = ? AND user_id = ?').run(_now(), linkId, userId);
    const row = db.prepare('SELECT category FROM outbound_links WHERE id = ?').get(linkId);
    if (row) {
      db.prepare(`UPDATE category_affinity SET click_count = click_count + 1, last_updated = datetime('now') WHERE user_id = ? AND category = ?`).run(userId, row.category);
    }
  }

  /** Record dwell time from bot send → user reply. */
  async recordDwellTime(linkId, userId, dwellTimeMs) {
    const db = await getDb();
    if (!db) return;
    db.prepare('UPDATE outbound_links SET replied = 1, reply_at = ?, dwell_time_ms = ?, reply_latency_ms = ? WHERE id = ? AND user_id = ?').run(_now(), dwellTimeMs, dwellTimeMs, linkId, userId);
    db.prepare(`INSERT INTO dwell_time_log (user_id, link_id, dwell_time_ms, category) SELECT ?, ?, ?, category FROM outbound_links WHERE id = ?`).run(userId, linkId, dwellTimeMs, linkId);
    const row = db.prepare('SELECT category FROM outbound_links WHERE id = ?').get(linkId);
    if (row) await this._recomputeAffinity(userId, row.category);
  }

  /** Record skip — user received but never replied/clicked. */
  async recordSkip(userId, category) {
    const db = await getDb();
    if (!db) return;
    db.prepare(`UPDATE category_affinity SET skip_count = skip_count + 1, last_updated = datetime('now') WHERE user_id = ? AND category = ?`).run(userId, category);
    await this._recomputeAffinity(userId, category);
  }

  /** Get recent unreplied outbound links (for discord_bot dwell time calc). */
  async _getRecentUnreplied(userId, limit = 5) {
    const db = await getDb();
    if (!db) return [];
    return db.prepare(`SELECT id, user_id, url, category, message_id, sent_at, clicked FROM outbound_links WHERE user_id = ? AND replied = 0 ORDER BY sent_at DESC LIMIT ?`).all(userId, limit);
  }

  /** Get category affinity scores sorted by implicit_score descending. */
  async getCategoryAffinity(userId) {
    const db = await getDb();
    if (!db) return [];
    return db.prepare('SELECT category, implicit_score, click_count, skip_count, total_sent FROM category_affinity WHERE user_id = ? ORDER BY implicit_score DESC').all(userId);
  }

  /** Get aggregated implicit signals summary. */
  async getImplicitSignals(userId) {
    const db = await getDb();
    if (!db) return { userId, categoryAffinity: [], topCategory: null, bottomCategory: null, clickThroughRate: 0, avgDwellTimeMs: null, totalReplies: 0, totalSent: 0, computedAt: _now() };
    const affinity = await this.getCategoryAffinity(userId);
    const avgDwell = db.prepare('SELECT AVG(dwell_time_ms) as avg_dwell, COUNT(*) as total_replies FROM dwell_time_log WHERE user_id = ?').get(userId);
    const totalSent = affinity.reduce((s, a) => s + (a.total_sent || 0), 0);
    const totalClicks = affinity.reduce((s, a) => s + (a.click_count || 0), 0);
    const ctr = totalSent > 0 ? totalClicks / totalSent : 0;
    return { userId, categoryAffinity: affinity, topCategory: affinity.length > 0 ? affinity[0].category : null, bottomCategory: affinity.length > 0 ? affinity[affinity.length - 1].category : null, clickThroughRate: parseFloat(ctr.toFixed(3)), avgDwellTimeMs: avgDwell?.avg_dwell || null, totalReplies: avgDwell?.total_replies || 0, totalSent, computedAt: _now() };
  }

  /** Mark old unclicked links as skips (cron cleanup). */
  async markOldUnclickedAsSkipped(olderThanHours = 48) {
    const db = await getDb();
    if (!db) return 0;
    const old = db.prepare(`SELECT id, user_id, category FROM outbound_links WHERE clicked = 0 AND replied = 0 AND sent_at < datetime('now', ?)`).all(`-${olderThanHours} hours`);
    for (const row of old) await this.recordSkip(row.user_id, row.category);
    if (old.length > 0) logger.info(`[IF] Marked ${old.length} old unclicked links as skipped`);
    return old.length;
  }

  /** Internal: recompute implicit_score for a (user, category). */
  async _recomputeAffinity(userId, category) {
    const db = await getDb();
    if (!db) return;
    const stats = db.prepare(`SELECT COUNT(*) as total, SUM(clicked) as clicks, SUM(replied) as replies, AVG(CASE WHEN reply_latency_ms > 0 THEN reply_latency_ms END) as avg_latency FROM outbound_links WHERE user_id = ? AND category = ?`).get(userId, category);
    if (!stats || stats.total === 0) return;
    const score = _computeImplicitSignal(stats.clicks > 0, stats.avg_latency);
    db.prepare(`UPDATE category_affinity SET implicit_score = ?, last_updated = datetime('now') WHERE user_id = ? AND category = ?`).run(score, userId, category);
  }

  /** Cleanup old records. */
  async cleanup(daysToKeep = 90) {
    const db = await getDb();
    if (!db) return;
    db.prepare("DELETE FROM outbound_links WHERE sent_at < datetime('now', ?)").run(`-${daysToKeep} days`);
    db.prepare("DELETE FROM dwell_time_log WHERE recorded_at < datetime('now', ?)").run(`-${daysToKeep} days`);
    logger.info(`[ImplicitFeedback] Cleaned up records older than ${daysToKeep} days`);
  }
}

export const implicitFeedback = new ImplicitFeedbackManager();
export default implicitFeedback;
