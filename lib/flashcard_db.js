import { open } from './sqlite_adapter.js';
import path from 'path';
import { fsrsSchedule, booleanToRating } from './fsrs.js';
import { onFlashcardReview } from './gap_router.js';

const FLASHCARD_DB = path.resolve('./flashcards.db');

// Spaced repetition intervals (in days)
export const SPACED_INTERVALS = [1, 3, 7, 14, 30, 60, 180];

// ── Singleton connection pool ──
let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const db = await open({ filename: FLASHCARD_DB, driver: null });

    // ── WAL mode: better concurrent access & crash safety for Cloud Run ──
    await db.exec('PRAGMA journal_mode=WAL');
    await db.exec('PRAGMA synchronous=NORMAL');
    await db.exec('PRAGMA foreign_keys=ON');

    await db.exec(`CREATE TABLE IF NOT EXISTS flashcards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT,
      category TEXT DEFAULT 'general',
      difficulty INTEGER DEFAULT 1,
      next_review TEXT,
      review_count INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      fsrs_state TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_next_review ON flashcards(next_review)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_category ON flashcards(category)`);

    // ── F1 Evaluation tables ──
    await db.exec(`CREATE TABLE IF NOT EXISTS f1_metrics_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT NOT NULL,
      precision REAL DEFAULT 0,
      recall REAL DEFAULT 0,
      f1 REAL DEFAULT 0,
      tp INTEGER DEFAULT 0,
      fp INTEGER DEFAULT 0,
      fn INTEGER DEFAULT 0,
      context TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS f1_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_f1_component ON f1_metrics_log(component)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_f1_feedback_user ON f1_feedback(user_id)`);

    return db;
  })();

  return _dbPromise;
}

/**
 * Close the singleton connection (for graceful shutdown)
 */
export async function closeDb() {
  if (_dbPromise) {
    const db = await _dbPromise;
    await db.close();
    _dbPromise = null;
  }
}

/**
 * Add a new flashcard
 */
async function addFlashcard({ question, answer, source, category = 'general' }) {
  const db = await getDb();
  const result = db.prepare(
    `INSERT INTO flashcards (question, answer, source, category, difficulty, next_review, review_count, correct_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), 0, 0, datetime('now'), datetime('now'))`
  ).run(question, answer, source, category);
  return result.lastInsertRowid || 1;
}

/**
 * Get due flashcards for review (sorted by next_review)
 */
async function getDueFlashcards(limit = 10) {
  const db = await getDb();
  const rows = await db.prepare(
    `SELECT * FROM flashcards WHERE next_review IS NULL OR next_review <= datetime('now') ORDER BY next_review ASC LIMIT ?`
  ).all(limit);
  return rows;
}

/**
 * Get random flashcards for quiz mode
 */
async function getRandomFlashcards(limit = 10, category = null) {
  const db = await getDb();
  let query = `SELECT * FROM flashcards`;
  const params = [];
  
  if (category) {
    query += ` WHERE category = ?`;
    params.push(category);
  }
  
  query += ` ORDER BY RANDOM() LIMIT ?`;
  params.push(limit);
  
  const rows = await db.prepare(query).all(...params);
  return rows;
}

/**
 * Update flashcard after review (spaced repetition)
 */
async function reviewFlashcard(id, correct) {
  const db = await getDb();
  
  // Get current flashcard
  const card = await db.prepare(`SELECT * FROM flashcards WHERE id = ?`).get(id);
  if (!card) {
    return null;
  }
  
  const newReviewCount = card.review_count + 1;
  const newCorrectCount = correct ? card.correct_count + 1 : card.correct_count;

  // ── FSRS: Load existing state or initialize ──
  let fsrsState = {};
  try {
    fsrsState = JSON.parse(card.fsrs_state || '{}');
  } catch { fsrsState = {}; }

  const stability = fsrsState.stability || 1;
  const difficulty = fsrsState.difficulty || 5;
  const elapsedDays = fsrsState.last_review
    ? Math.max(0, Math.floor((Date.now() - new Date(fsrsState.last_review).getTime()) / 86400000))
    : 0;

  // Calculate next review using FSRS
  const rating = booleanToRating(correct, correct ? 3 : 1);
  const result = fsrsSchedule(stability, difficulty, rating, elapsedDays);

  // Save updated FSRS state
  const newFsrsState = {
    stability: result.stability,
    difficulty: result.difficulty,
    last_review: new Date().toISOString(),
    reps: (fsrsState.reps || 0) + 1,
    lapses: (fsrsState.lapses || 0) + (correct ? 0 : 1),
  };

db.prepare(
    `UPDATE flashcards
     SET next_review = ?,
         review_count = ?,
         correct_count = ?,
         fsrs_state = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(result.due.toISOString(), newReviewCount, newCorrectCount, JSON.stringify(newFsrsState), id);

  // ── Tier 2: Weighted Gap Routing — propagate gap on wrong answer ──
  let gapAdvice = null;
  if (!correct && card.category) {
    try {
      gapAdvice = await onFlashcardReview(card.category, false);
    } catch { /* ignore gap routing errors */ }
  }

  return {
    id,
    intervalDays: result.interval,
    reviewCount: newReviewCount,
    correctCount: newCorrectCount,
    fsrs: { stability: result.stability, difficulty: result.difficulty },
    gapAdvice, // Strategic advice if gap was detected
  };
}

/**
 * Get flashcard statistics
 */
async function getStats() {
  const db = await getDb();
  const stats = await db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN next_review <= datetime('now') THEN 1 ELSE 0 END) as due,
      SUM(correct_count) as total_correct,
      SUM(review_count) as total_reviews
    FROM flashcards
  `).get();
  return {
    total: stats?.total ?? 0,
    due: stats?.due ?? 0,
    total_correct: stats?.total_correct ?? 0,
    total_reviews: stats?.total_reviews ?? 0,
  };
}

/**
 * Delete a flashcard
 */
async function deleteFlashcard(id) {
  const db = await getDb();
  const result = db.prepare(`DELETE FROM flashcards WHERE id = ?`).run(id);
  return result.changes > 0;
}

/**
 * Clear all flashcards
 */
async function clearAll() {
  const db = await getDb();
  db.exec(`DELETE FROM flashcards`);
  return true;
}

/**
 * Clear flashcards by source
 */
async function clearBySource(source) {
  const db = await getDb();
  const result = db.prepare(`DELETE FROM flashcards WHERE source = ?`).run(source);
  return result.changes || 0;
}

/**
 * Get count of due flashcards (lightweight)
 */
export async function getDueCount() {
  const db = await getDb();
  const row = await db.prepare(
    `SELECT COUNT(*) as count FROM flashcards WHERE next_review IS NULL OR next_review <= datetime('now')`
  ).get();
  return row?.count ?? 0;
}

/**
 * Get recent review stats (for EvoAgent monitoring)
 * @param {number} days - Number of days to look back
 */
export async function getRecentStats(days = 7) {
  const db = await getDb();
  const row = await db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN correct_count > 0 THEN 1 ELSE 0 END) as attempted,
       ROUND(AVG(CAST(correct_count AS FLOAT) / MAX(review_count, 1)), 3) as avgScore
     FROM flashcards
     WHERE updated_at >= datetime('now', ?)`
  ).get(`-${days} days`);
  return {
    total: row?.total ?? 0,
    attempted: row?.attempted ?? 0,
    avgScore: row?.avgScore ?? 0,
  };
}

export {
  getDb,
  addFlashcard,
  getDueFlashcards,
  getRandomFlashcards,
  reviewFlashcard,
  getStats,
  deleteFlashcard,
  clearAll,
  clearBySource,
};