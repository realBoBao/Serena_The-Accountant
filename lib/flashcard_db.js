import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const FLASHCARD_DB = path.resolve('./flashcards.db');

// Spaced repetition intervals (in days)
const SPACED_INTERVALS = [1, 3, 7, 14, 30, 60, 180];

// ── Singleton connection pool ──
let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const db = await open({ filename: FLASHCARD_DB, driver: sqlite3.Database });
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_next_review ON flashcards(next_review)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_category ON flashcards(category)`);

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
  const result = await db.run(
    `INSERT INTO flashcards (question, answer, source, category, difficulty, next_review, review_count, correct_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), 0, 0, datetime('now'), datetime('now'))`,
    [question, answer, source, category]
  );
  return result.lastID;
}

/**
 * Get due flashcards for review (sorted by next_review)
 */
async function getDueFlashcards(limit = 10) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT * FROM flashcards WHERE next_review IS NULL OR next_review <= datetime('now') ORDER BY next_review ASC LIMIT ?`,
    [limit]
  );
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
  
  const rows = await db.all(query, params);
  return rows;
}

/**
 * Update flashcard after review (spaced repetition)
 */
async function reviewFlashcard(id, correct) {
  const db = await getDb();
  
  // Get current flashcard
  const card = await db.get(`SELECT * FROM flashcards WHERE id = ?`, [id]);
  if (!card) {
    return null;
  }
  
  const newReviewCount = card.review_count + 1;
  const newCorrectCount = correct ? card.correct_count + 1 : card.correct_count;
  
  // Calculate next review date based on spaced repetition
  let intervalDays;
  if (correct) {
    const intervalIndex = Math.min(Math.floor(newCorrectCount / 2), SPACED_INTERVALS.length - 1);
    intervalDays = SPACED_INTERVALS[intervalIndex];
  } else {
    // Reset to 1 day if incorrect
    intervalDays = 1;
  }
  
  await db.run(
    `UPDATE flashcards 
     SET next_review = datetime('now', '+' || ? || ' days'), 
         review_count = ?, 
         correct_count = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
    [intervalDays, newReviewCount, newCorrectCount, id]
  );
  
  return { id, intervalDays, reviewCount: newReviewCount, correctCount: newCorrectCount };
}

/**
 * Get flashcard statistics
 */
async function getStats() {
  const db = await getDb();
  const stats = await db.get(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN next_review <= datetime('now') THEN 1 ELSE 0 END) as due,
      SUM(correct_count) as total_correct,
      SUM(review_count) as total_reviews
    FROM flashcards
  `);
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
  const result = await db.run(`DELETE FROM flashcards WHERE id = ?`, [id]);
  return result.changes > 0;
}

/**
 * Clear all flashcards
 */
async function clearAll() {
  const db = await getDb();
  await db.run(`DELETE FROM flashcards`);
  return true;
}

/**
 * Clear flashcards by source
 */
async function clearBySource(source) {
  const db = await getDb();
  const result = await db.run(`DELETE FROM flashcards WHERE source = ?`, [source]);
  return result.changes || 0;
}

/**
 * Get count of due flashcards (lightweight)
 */
export async function getDueCount() {
  const db = await getDb();
  const row = await db.get(
    `SELECT COUNT(*) as count FROM flashcards WHERE next_review IS NULL OR next_review <= datetime('now')`
  );
  return row?.count ?? 0;
}

/**
 * Get recent review stats (for EvoAgent monitoring)
 * @param {number} days - Number of days to look back
 */
export async function getRecentStats(days = 7) {
  const db = await getDb();
  const row = await db.get(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN correct_count > 0 THEN 1 ELSE 0 END) as attempted,
       ROUND(AVG(CAST(correct_count AS FLOAT) / MAX(review_count, 1)), 3) as avgScore
     FROM flashcards
     WHERE updated_at >= datetime('now', ?)`,
    [`-${days} days`]
  );
  return {
    total: row?.total ?? 0,
    attempted: row?.attempted ?? 0,
    avgScore: row?.avgScore ?? 0,
  };
}

export {
  addFlashcard,
  getDueFlashcards,
  getRandomFlashcards,
  reviewFlashcard,
  getStats,
  deleteFlashcard,
  clearAll,
  clearBySource,
  SPACED_INTERVALS
};