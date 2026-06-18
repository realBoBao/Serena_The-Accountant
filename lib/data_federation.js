/**
 * Hot/Cold Data Federation — Tier 4 (Simplified)
 *
 * Chia dữ liệu thành:
 *   - HOT  : SQLite chính (flashcards.db) — dữ liệu 30 ngày gần nhất
 *   - COLD : SQLite archive (archive.db) — dữ liệu cũ hơn
 *
 * Flow:
 *   1. Cron job chạy hàng ngày, move records cũ >30 ngày sang archive.db
 *   2. Query wrapper tìm trong cả hot + cold khi cần
 *   3. Khi user dùng !ask --deep, query cả 2 DB
 *
 * ponytail: SQLite-to-SQLite federation, không dùng BigQuery.
 *   Đủ cho single-instance Cloud Run. Nếu data > 1GB, cần chuyển sang
 *   BigQuery hoặc Cloud Storage cho cold tier.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { info, warn, error } from './structured_logger.js';

const HOT_DB = path.resolve('./flashcards.db');
const COLD_DB = path.resolve('./archive.db');
const RETENTION_DAYS = 30;

let _hotDb = null;
let _coldDb = null;

async function getHotDb() {
  if (!_hotDb) {
    _hotDb = new DatabaseSync(HOT_DB);
    _hotDb.exec('PRAGMA journal_mode=WAL');
  }
  return _hotDb;
}

async function getColdDb() {
  if (!_coldDb) {
    _coldDb = new DatabaseSync(COLD_DB);
    _coldDb.exec('PRAGMA journal_mode=WAL');
    // Tạo archive tables nếu chưa có
    await _coldDb.exec(`CREATE TABLE IF NOT EXISTS flashcards_archive (
      id INTEGER PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT,
      category TEXT DEFAULT 'general',
      difficulty INTEGER DEFAULT 1,
      next_review TEXT,
      review_count INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      fsrs_state TEXT DEFAULT '{}',
      created_at TEXT,
      updated_at TEXT,
      archived_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await _coldDb.exec(`CREATE TABLE IF NOT EXISTS chat_history_archive (
      id INTEGER PRIMARY KEY,
      user_id TEXT,
      query TEXT,
      answer TEXT,
      sources TEXT,
      created_at TEXT,
      archived_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  return _coldDb;
}

/**
 * Archive dữ liệu cũ từ hot DB sang cold DB.
 * Move tất cả flashcards không được review trong RETENTION_DAYS ngày.
 *
 * @returns {object} { flashcards_archived, errors }
 */
export async function archiveOldData() {
  const hot = await getHotDb();
  const cold = await getColdDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();

  let archived = 0;
  let errs = 0;

  try {
    // Tìm flashcards cũ (không review trong 30 ngày, không phải due)
    const oldCards = hot.prepare(
      `SELECT * FROM flashcards
       WHERE updated_at < ?
       AND (next_review IS NULL OR next_review > ?)
       AND review_count > 0`
    ).all(cutoff, cutoff);

    for (const card of oldCards) {
      try {
        await cold.run(
          `INSERT OR REPLACE INTO flashcards_archive
           (id, question, answer, source, category, difficulty, next_review,
            review_count, correct_count, fsrs_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          card.id, card.question, card.answer, card.source, card.category,
          card.difficulty, card.next_review, card.review_count, card.correct_count,
          card.fsrs_state, card.created_at, card.updated_at
        );
        await hot.run('DELETE FROM flashcards WHERE id = ?', card.id);
        archived++;
      } catch (err) {
        errs++;
        error('DataFederation', 'archive failed for card', { id: card.id, error: err.message });
      }
    }

    if (archived > 0) {
      info('DataFederation', 'archive complete', { archived, errors: errs, cutoff });
    }
  } catch (err) {
    error('DataFederation', 'archive job failed', { error: err.message });
  }

  return { flashcards_archived: archived, errors: errs };
}

/**
 * Query unified — tìm trong cả hot và cold.
 * @param {string} table — 'flashcards' | 'chat_history'
 * @param {string} whereClause — SQL WHERE clause
 * @param {Array} params — query params
 * @param {object} options — { limit, offset, order }
 * @returns {Array} merged results (cold records have _archived: true)
 */
export async function queryUnified(table, whereClause, params = [], options = {}) {
  const { limit = 50, offset = 0, order = 'id DESC' } = options;
  const hot = await getHotDb();
  const cold = await getColdDb();

  const archiveTable = `${table}_archive`;

  // Query hot
  let hotResults = [];
  try {
    hotResults = await hot.all(
      `SELECT *, 0 as _archived FROM ${table} WHERE ${whereClause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
  } catch (err) {
    warn('DataFederation', 'hot query failed', { table, error: err.message });
  }

  // Query cold (nếu chưa đủ results)
  let coldResults = [];
  const remaining = limit - hotResults.length;
  if (remaining > 0) {
    try {
      coldResults = await cold.all(
        `SELECT *, 1 as _archived FROM ${archiveTable} WHERE ${whereClause} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...params, remaining, Math.max(0, offset - hotResults.length)]
      );
    } catch (err) {
      // Archive table có thể chưa tồn tại — OK
    }
  }

  return [...hotResults, ...coldResults];
}

/**
 * Get data tier stats.
 */
export async function getTierStats() {
  const hot = await getHotDb();
  const cold = await getColdDb();

  const hotCount = await hot.get('SELECT COUNT(*) as n FROM flashcards').catch(() => ({ n: 0 }));
  const coldCount = await cold.get('SELECT COUNT(*) as n FROM flashcards_archive').catch(() => ({ n: 0 }));

  // DB file sizes
  const fs = await import('fs');
  const hotSize = fs.existsSync(HOT_DB) ? fs.statSync(HOT_DB).size : 0;
  const coldSize = fs.existsSync(COLD_DB) ? fs.statSync(COLD_DB).size : 0;

  return {
    hot: { records: hotCount.n, size_mb: Math.round(hotSize / 1024 / 1024 * 100) / 100 },
    cold: { records: coldCount.n, size_mb: Math.round(coldSize / 1024 / 1024 * 100) / 100 },
    retention_days: RETENTION_DAYS,
  };
}

/**
 * Restore từ archive về hot DB.
 * @param {number} id — flashcard id
 */
export async function restoreFromArchive(id) {
  const hot = await getHotDb();
  const cold = await getColdDb();

  const card = await cold.get('SELECT * FROM flashcards_archive WHERE id = ?', id);
  if (!card) return false;

  await hot.run(
    `INSERT OR REPLACE INTO flashcards
     (id, question, answer, source, category, difficulty, next_review,
      review_count, correct_count, fsrs_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    card.id, card.question, card.answer, card.source, card.category,
    card.difficulty, card.next_review, card.review_count, card.correct_count,
    card.fsrs_state, card.created_at, card.updated_at
  );

  await cold.run('DELETE FROM flashcards_archive WHERE id = ?', card.id);
  info('DataFederation', 'restored from archive', { id });
  return true;
}
