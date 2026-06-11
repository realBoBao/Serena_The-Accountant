/**
 * lib/user_profile.js — User Mental Model & Learning Profile
 *
 * Quản lý profile học tập của mỗi user:
 * - Phong cách học (example_first, theory_first, code_heavy, visual)
 * - Tốc độ tiếp thu (learn_speed 0-1)
 * - Điểm mạnh/yếu theo topic
 * - Lịch sử sự kiện (quiz, follow-up, re-ask)
 *
 * Lưu trữ SQLite — không cần dependency mới.
 * Bắt đầu học ngay từ ngày đầu tiên.
 *
 * Usage:
 *   import { userProfileManager } from './user_profile.js';
 *   const profile = userProfileManager.getProfile(userId, username);
 *   userProfileManager.recordQuizResult(userId, topic, isCorrect, responseTimeMs);
 *   const context = userProfileManager.buildSystemContext(userId);
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getLogger } from './logger.js';

const logger = getLogger('UserProfile');

const DB_PATH = path.join(process.cwd(), 'data', 'user_profiles.db');

// ── SQLite wrapper (không dùng better-sqlite3 vì có thể chưa cài) ──
// Dùng sqlite3 package đã có trong dependencies
let db = null;

function getDb() {
  if (db) return db;
  try {
    const sqlite3 = require('sqlite3').verbose();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new sqlite3.Database(DB_PATH);
    _init(db);
    return db;
  } catch (err) {
    logger.warn('[UserProfile] SQLite unavailable:', err.message);
    return null;
  }
}

function _init(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id     TEXT PRIMARY KEY,
      username    TEXT,
      learn_style TEXT DEFAULT 'example_first',
      learn_speed REAL DEFAULT 0.5,
      depth_pref  TEXT DEFAULT 'auto',
      strengths   TEXT DEFAULT '{}',
      weak_areas  TEXT DEFAULT '{}',
      topic_stats TEXT DEFAULT '{}',
      session_count INTEGER DEFAULT 0,
      last_seen   TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT,
      event_type  TEXT,
      topic       TEXT,
      payload     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ── Helpers ──
function dbRun(sql, params = []) {
  const d = getDb();
  if (!d) return;
  d.run(sql, params);
}
function dbGet(sql, params = []) {
  const d = getDb();
  if (!d) return null;
  // Synchronous get using sqlite3
  let result = null;
  d.get(sql, params, (err, row) => { if (!err) result = row; });
  return result;
}

// ── UserProfileManager ──
class UserProfileManager {
  getProfile(userId, username = '') {
    let row = dbGet('SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
    if (!row) {
      dbRun(
        'INSERT INTO user_profiles (user_id, username, last_seen) VALUES (?, ?, datetime("now"))',
        [userId, username]
      );
      row = dbGet('SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
    }
    if (!row) return null;
    return {
      ...row,
      strengths:   JSON.parse(row.strengths   || '{}'),
      weak_areas:  JSON.parse(row.weak_areas  || '{}'),
      topic_stats: JSON.parse(row.topic_stats || '{}'),
    };
  }

  recordQuizResult(userId, topic, isCorrect, responseTimeMs) {
    const profile = this.getProfile(userId);
    if (!profile) return;

    const stats = profile.topic_stats;
    if (!stats[topic]) stats[topic] = { asked: 0, correct: 0, last_seen: null };
    stats[topic].asked++;
    stats[topic].last_seen = new Date().toISOString();
    if (isCorrect) stats[topic].correct++;

    const accuracy = stats[topic].correct / stats[topic].asked;
    const strengths = profile.strengths;
    strengths[topic] = parseFloat(accuracy.toFixed(3));

    const speedSignal = isCorrect
      ? Math.max(0, 1 - (responseTimeMs / 20000))
      : 0;
    const newSpeed = (profile.learn_speed * 0.85) + (speedSignal * 0.15);

    dbRun(
      'UPDATE user_profiles SET strengths = ?, topic_stats = ?, learn_speed = ?, last_seen = datetime("now") WHERE user_id = ?',
      [JSON.stringify(strengths), JSON.stringify(stats), newSpeed, userId]
    );

    this._logEvent(userId, 'quiz_result', topic, { isCorrect, responseTimeMs, accuracy });
  }

  recordFollowUp(userId, topic) {
    const profile = this.getProfile(userId);
    if (!profile) return;

    const weak = profile.weak_areas;
    weak[topic] = (weak[topic] || 0) + 1;

    dbRun('UPDATE user_profiles SET weak_areas = ? WHERE user_id = ?', [JSON.stringify(weak), userId]);
    this._logEvent(userId, 'follow_up', topic, { count: weak[topic] });
  }

  setPreference(userId, type, value) {
    const col = type === 'style' ? 'learn_style' : 'depth_pref';
    dbRun(`UPDATE user_profiles SET ${col} = ? WHERE user_id = ?`, [value, userId]);
    logger.info(`[UserProfile] ${userId} set ${col} = ${value}`);
  }

  incrementSession(userId) {
    dbRun('UPDATE user_profiles SET session_count = session_count + 1, last_seen = datetime("now") WHERE user_id = ?', [userId]);
  }

  buildSystemContext(userId) {
    const p = this.getProfile(userId);
    if (!p) return '';

    const topStrengths = Object.entries(p.strengths)
      .sort(([,a],[,b]) => b - a).slice(0, 3)
      .map(([t, s]) => `${t} (${Math.round(s * 100)}%)').join(', ');

    const topWeak = Object.entries(p.weak_areas)
      .sort(([,a],[,b]) => b - a).slice(0, 3)
      .map(([t]) => t).join(', ');

    const speedLabel = p.learn_speed > 0.7 ? 'nhanh' : p.learn_speed > 0.4 ? 'trung bình' : 'cần giải thích kỹ';

    const depthNote = p.depth_pref === 'concise'
      ? 'Trả lời ngắn gọn, thẳng vào điểm chính.'
      : p.depth_pref === 'detailed'
      ? 'Trả lời chi tiết, đầy đủ ví dụ.'
      : 'Tự điều chỉnh độ dài phù hợp.';

    return `
[USER PROFILE - ${p.username || userId}]
- Phong cách học: ${p.learn_style} (ưu tiên ${p.learn_style === 'example_first' ? 'ví dụ trước lý thuyết' : p.learn_style === 'code_heavy' ? 'code thực tế' : 'lý thuyết rõ ràng'})
- Tốc độ tiếp thu: ${speedLabel} (score: ${p.learn_speed.toFixed(2)})
- Điểm mạnh: ${topStrengths || 'chưa đủ dữ liệu'}
- Cần chú ý thêm: ${topWeak || 'không có'}
- ${depthNote}
`.trim();
  }

  _logEvent(userId, type, topic, payload) {
    dbRun(
      'INSERT INTO profile_events (user_id, event_type, topic, payload) VALUES (?, ?, ?, ?)',
      [userId, type, topic, JSON.stringify(payload)]
    );
  }
}

export const userProfileManager = new UserProfileManager();
export default userProfileManager;
