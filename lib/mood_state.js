/**
 * lib/mood_state.js — Contextual Mood & Energy State Machine (Tier 2)
 *
 * Máy trạng thái Cảm xúc & Ngữ cảnh:
 * Phân tích tone giọng + thời gian trong ngày + interaction pattern
 * → xác định trạng thái tâm lý hiện tại của user.
 *
 * States:
 *   focused     — Tập trung, sẵn sàng học/code
 *   curious     — Tò muốn, đặt nhiều câu hỏi
 *   tired       — Mệt mỏi, cần nội dung nhẹ nhàng
 *   burnout     — Kiệt sức, cần dopamine recovery
 *   stressed    — Căng thẳng, cần giải tỏa
 *   celebrating — Vui vỡi, vừa giải được vấn đề
 *
 * Signals:
 *   message tone (keyword-based sentiment)
 *   time of day (late night = tired/burnout risk)
 *   typing speed proxy (message length / assumed typing time)
 *   streak behavior (many wrong answers → frustrated)
 *   emoji usage (😂😤🎉 etc.)
 *
 * Usage:
 *   import { moodState } from './mood_state.js';
 *   const state = moodState.analyze(userId, messageText, metadata);
 *   const recommendation = moodState.getRecommendation(state);
 *   moodState.recordState(userId, state);
 *   const history = moodState.getStateHistory(userId, 7);
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getLogger } from './logger.js';

const logger = getLogger('MoodState');

const DB_PATH = path.join(process.cwd(), 'data', 'mood_state.db');

// ── SQLite wrapper ──
let db = null;

function getDb() {
  if (db) return db;
  try {
    const sqlite3 = require('sqlite3').verbose();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new sqlite3.Database(DB_PATH);
    _init(db);
    logger.info('[MoodState] SQLite initialized at', DB_PATH);
    return db;
  } catch (err) {
    logger.warn('[MoodState] SQLite unavailable:', err.message);
    return null;
  }
}

function _init(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mood_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT NOT NULL,
      state           TEXT NOT NULL,
      confidence      REAL DEFAULT 0.5,
      signals         TEXT DEFAULT '{}',
      hour_of_day     INTEGER,
      day_of_week     INTEGER,
      recorded_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mood_transitions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT NOT NULL,
      from_state      TEXT,
      to_state        TEXT NOT NULL,
      trigger         TEXT,
      recorded_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_mood_user    ON mood_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_mood_time    ON mood_history(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_trans_user   ON mood_transitions(user_id);
  `);
}

function dbRun(sql, params = []) {
  const d = getDb();
  if (!d) return;
  try { d.run(sql, params); } catch (err) { logger.warn('[Mood] dbRun error:', err.message); }
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

// ── Sentiment keyword maps (Vietnamese + English) ──
const SENTIMENT_POSITIVE = [
  'thanks', 'cảm ơn', 'hay', 'tuyệt', 'được', 'ok', 'good', 'great',
  'awesome', 'cool', 'nice', 'perfect', '🎉', '😂', '👍', '❤️', '🔥',
  'giỏi', 'xịn', 'chất', 'vl', 'đỉnh', 'pro', 'master', 'slay',
  'hiểu rồi', 'rõ ràng', 'clear', 'đúng', 'correct', 'yes', 'yep',
];

const SENTIMENT_NEGATIVE = [
  'không hiểu', 'confused', 'lỗi', 'error', 'bug', 'sai', 'wrong',
  'stuck', 'kẹt', 'khó', 'hard', 'difficult', 'frustrated', '😤',
  '💩', '🤬', '😡', 'ugh', 'wtf', 'fuck', 'shit', 'damn',
  'chán', 'boring', 'nhàm', 'useless', 'vô dụng', 'tệ', 'bad',
  'không được', 'fail', 'failed', 'timeout', 'crash', 'oom',
];

const SENTIMENT_STRESSED = [
  'deadline', 'gấp', 'urgent', 'asap', 'help', 'cứu', ' SOS',
  'không kịp', 'overwhelm', 'quá tải', 'nhiều quá', 'mệt',
  'exhausted', 'burnout', 'kiệt sức', '2am', '3am', 'đêm',
  'trễ', 'late', 'miss', 'thi', 'exam', 'test', 'interview',
];

const SENTIMENT_CELEBRATING = [
  'giải được', 'solved', 'ac', 'accepted', 'passed', 'đậu',
  'xong', 'done', 'hoàn thành', 'complete', 'ship', 'deploy',
  'merge', 'promoted', 'tuyển', 'offer', '🎉', '🥳', '🏆',
];

// ── State definitions ──
export const MOOD_STATES = {
  focused:     { emoji: '🎯', label: 'Tập trung',    energy: 0.8, valence: 0.6 },
  curious:     { emoji: '🔍', label: 'Tò mò',         energy: 0.7, valence: 0.7 },
  tired:       { emoji: '😴', label: 'Mệt mỏi',       energy: 0.3, valence: 0.4 },
  burnout:     { emoji: '🔥', label: 'Kiệt sức',      energy: 0.1, valence: 0.2 },
  stressed:    { emoji: '😤', label: 'Căng thẳng',    energy: 0.4, valence: 0.2 },
  celebrating: { emoji: '🎉', label: 'Vui vẻ',         energy: 0.9, valence: 0.9 },
  neutral:     { emoji: '😐', label: 'Bình thường',   energy: 0.5, valence: 0.5 },
};

// ── MoodStateManager ──

class MoodStateManager {

  /**
   * Analyze message text + metadata → mood state.
   *
   * @param {string} userId
   * @param {string} text       — message content
   * @param {Object} meta       — { hour?: number, messageLength?: number, recentAccuracy?: number }
   * @returns {{ state, confidence, signals }}
   */
  analyze(userId, text, meta = {}) {
    const lower = (text || '').toLowerCase();
    const hour = meta.hour ?? new Date().getHours();
    const signals = {};

    // ── 1. Keyword sentiment scoring ──
    let positiveHits = 0;
    let negativeHits = 0;
    let stressedHits = 0;
    let celebratingHits = 0;

    for (const kw of SENTIMENT_POSITIVE) if (lower.includes(kw)) positiveHits++;
    for (const kw of SENTIMENT_NEGATIVE) if (lower.includes(kw)) negativeHits++;
    for (const kw of SENTIMENT_STRESSED) if (lower.includes(kw)) stressedHits++;
    for (const kw of SENTIMENT_CELEBRATING) if (lower.includes(kw)) celebratingHits++;

    signals.positiveHits = positiveHits;
    signals.negativeHits = negativeHits;
    signals.stressedHits = stressedHits;
    signals.celebratingHits = celebratingHits;

    // ── 2. Time-of-day heuristic ──
    // Late night (0–5h) → tired/burnout risk
    // Early morning (5–8h) → fresh
    // Work hours (9–17h) → focused
    // Evening (18–22h) → winding down
    // Late evening (23–24h) → tired
    let timeSignal = 'neutral';
    if (hour >= 0 && hour < 5) timeSignal = 'late_night';
    else if (hour >= 5 && hour < 8) timeSignal = 'early_morning';
    else if (hour >= 8 && hour < 12) timeSignal = 'morning';
    else if (hour >= 12 && hour < 14) timeSignal = 'lunch';
    else if (hour >= 14 && hour < 18) timeSignal = 'afternoon';
    else if (hour >= 18 && hour < 22) timeSignal = 'evening';
    else if (hour >= 22) timeSignal = 'late_evening';
    signals.timeSignal = timeSignal;
    signals.hour = hour;

    // ── 3. Message length proxy (short = rushed/frustrated, long = engaged) ──
    const msgLen = meta.messageLength ?? text.length;
    signals.messageLength = msgLen;
    const lengthSignal = msgLen < 10 ? 'short' : msgLen > 200 ? 'long' : 'medium';
    signals.lengthSignal = lengthSignal;

    // ── 4. Recent accuracy (from meta, if available) ──
    if (meta.recentAccuracy !== undefined) {
      signals.recentAccuracy = meta.recentAccuracy;
    }

    // ── State determination ──
    let state = 'neutral';
    let confidence = 0.5;

    // Priority: celebrating > stressed > burnout > tired > curious > focused
    if (celebratingHits > 0) {
      state = 'celebrating';
      confidence = 0.6 + Math.min(0.3, celebratingHits * 0.1);
    } else if (stressedHits >= 2 || (stressedHits > 0 && negativeHits > 0)) {
      state = 'stressed';
      confidence = 0.55 + Math.min(0.3, stressedHits * 0.1);
    } else if (timeSignal === 'late_night' && (negativeHits > 0 || lengthSignal === 'short')) {
      state = 'burnout';
      confidence = 0.6;
    } else if (timeSignal === 'late_night' || timeSignal === 'late_evening') {
      state = 'tired';
      confidence = 0.5 + (negativeHits > 0 ? 0.15 : 0);
    } else if (positiveHits > negativeHits && lengthSignal === 'long') {
      state = 'curious';
      confidence = 0.5 + Math.min(0.3, positiveHits * 0.08);
    } else if (positiveHits > 0 || (lengthSignal === 'long' && negativeHits === 0)) {
      state = 'focused';
      confidence = 0.5;
    }

    // Low accuracy → frustrated → stressed
    if (signals.recentAccuracy !== undefined && signals.recentAccuracy < 0.3 && state === 'neutral') {
      state = 'stressed';
      confidence = 0.55;
    }

    confidence = Math.min(0.95, confidence);

    logger.info(`[Mood] ${userId} → ${state} (conf: ${confidence.toFixed(2)}) signals:`, signals);

    return { state, confidence, signals };
  }

  /**
   * Record a mood state transition.
   */
  recordState(userId, { state, confidence, signals }) {
    const now = new Date();
    const prev = this.getLastState(userId);

    dbRun(
      'INSERT INTO mood_history (user_id, state, confidence, signals, hour_of_day, day_of_week, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, state, confidence, JSON.stringify(signals), now.getHours(), now.getDay(), now.toISOString()]
    );

    if (prev && prev.state !== state) {
      dbRun(
        'INSERT INTO mood_transitions (user_id, from_state, to_state, trigger, recorded_at) VALUES (?, ?, ?, ?, ?)',
        [userId, prev.state, state, JSON.stringify(signals).slice(0, 200), now.toISOString()]
      );
      logger.info(`[Mood] ${userId} transitioned: ${prev.state} → ${state}`);
    }
  }

  /**
   * Get last recorded state for a user.
   */
  getLastState(userId) {
    return dbGet(
      'SELECT state, confidence, signals, recorded_at FROM mood_history WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1',
      [userId]
    );
  }

  /**
   * Get mood history for past N days.
   */
  getStateHistory(userId, days = 7) {
    return dbAll(
      `SELECT state, confidence, signals, hour_of_day, recorded_at
       FROM mood_history
       WHERE user_id = ? AND recorded_at > datetime('now', ?)
       ORDER BY recorded_at DESC`,
      [userId, `-${days} days`]
    );
  }

  /**
   * Get dominant mood over past N days (mode of states).
   */
  getDominantMood(userId, days = 7) {
    const rows = dbAll(
      `SELECT state, COUNT(*) as count
       FROM mood_history
       WHERE user_id = ? AND recorded_at > datetime('now', ?)
       GROUP BY state ORDER BY count DESC LIMIT 1`,
      [userId, `-${days} days`]
    );
    return rows.length > 0 ? rows[0].state : 'neutral';
  }

  /**
   * Get recommendation based on current mood state.
   * Returns suggestion for what type of content/interaction to offer.
   */
  getRecommendation(state) {
    const recs = {
      focused: {
        actions: ['deep_dive', 'code_challenge', 'system_design'],
        tone: 'technical',
        maxSuggestions: 3,
        message: '🎯 Bạn đang tập trung tốt! Đây là lúc code/tìm kiếm sâu.',
      },
      curious: {
        actions: ['explore_topic', 'related_links', 'socratic_question'],
        tone: 'engaging',
        maxSuggestions: 5,
        message: '🔍 Bạn đang tò mò! Để mở rộng chủ đề này…',
      },
      tired: {
        actions: ['quick_tip', 'fun_fact', 'light_reading'],
        tone: 'gentle',
        maxSuggestions: 2,
        message: '😴 Có vẻ bạn hơi mệt. Nội dung nhẹ nhàng thôi nhé.',
      },
      burnout: {
        actions: ['dopamine_menu', 'lofi_music', 'walk_reminder', 'meme_break', 'breathing'],
        tone: 'caring',
        maxSuggestions: 7,
        message: '🔥 Burnout alert! Để mình gợi ý vài thứ giúp recharge năng lượng…',
        // ponytail: 21 activities mentioned in spec, starting with 7 core ones.
        // Expand to full dopamine menu when this proves useful.
      },
      stressed: {
        actions: ['debug_help', 'break_down_problem', 'encouragement'],
        tone: 'supportive',
        maxSuggestions: 3,
        message: '😤 Có vẻ bạn đang căng thẳng. Mình giúp gỡ rối nhé.',
      },
      celebrating: {
        actions: ['share_win', 'next_challenge', 'streak_bonus'],
        tone: 'enthusiastic',
        maxSuggestions: 3,
        message: '🎉 Nice! Giải được rồi! Tiếp tục phát huy nhé.',
      },
      neutral: {
        actions: ['general_suggestion'],
        tone: 'friendly',
        maxSuggestions: 3,
        message: '',
      },
    };
    return recs[state] || recs.neutral;
  }

  /**
   * Cleanup old records (keep 90 days).
   */
  cleanup(daysToKeep = 90) {
    dbRun("DELETE FROM mood_history WHERE recorded_at < datetime('now', ?)", [`-${daysToKeep} days`]);
    dbRun("DELETE FROM mood_transitions WHERE recorded_at < datetime('now', ?)", [`-${daysToKeep} days`]);
    logger.info(`[MoodState] Cleaned up records older than ${daysToKeep} days`);
  }
}

// ── Singleton export ──
export const moodState = new MoodStateManager();
export default moodState;
