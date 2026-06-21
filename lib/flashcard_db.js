import { getDb, openDb } from './sqlite_adapter.js';
import { fsrsSchedule, booleanToRating } from './fsrs.js';
import { onFlashcardReview } from './gap_router.js';

// Spaced repetition intervals (in days)
export const SPACED_INTERVALS = [1, 3, 7, 14, 30, 60, 180];

// ── Use shared DB from sqlite_adapter ──
function runSql(db, sql) {
  if (db.prepare) return db.prepare(sql).run();
  return db.exec(sql);
}

let _schemaReady = false;

async function ensureSchema() {
  if (_schemaReady) return;
  const db = await getDb();
  if (!db) throw new Error('DB not initialized. Call openDb() first.');

  runSql(db, `CREATE TABLE IF NOT EXISTS flashcards (
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
  runSql(db, `CREATE INDEX IF NOT EXISTS idx_next_review ON flashcards(next_review)`);
  runSql(db, `CREATE INDEX IF NOT EXISTS idx_category ON flashcards(category)`);

  _schemaReady = true;
}

async function _getFlashDb() {
  await ensureSchema();
  return openDb();
}

export async function closeDb() {}

export async function addCard(question, answer, source = 'general', category = 'general') {
  const db = await getDb();
  db.prepare(
    `INSERT INTO flashcards (question, answer, source, category, difficulty, next_review, review_count, correct_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), 0, 0, datetime('now'), datetime('now'))`
  ).run(question, answer, source, category);
  onFlashcardReview(category);
}

export async function getCards(category = null) {
  const db = await getDb();
  if (category) return db.prepare(`SELECT * FROM flashcards WHERE category = ? ORDER BY created_at DESC`).all(category);
  return db.prepare(`SELECT * FROM flashcards ORDER BY created_at DESC`).all();
}

export async function getDueCards(category = null, limit = 20) {
  const db = await getDb();
  if (category) {
    return db.prepare(`SELECT * FROM flashcards WHERE category = ? AND (next_review IS NULL OR next_review <= datetime('now')) ORDER BY RANDOM() LIMIT ?`).all(category, limit);
  }
  return db.prepare(`SELECT * FROM flashcards WHERE next_review IS NULL OR next_review <= datetime('now') ORDER BY RANDOM() LIMIT ?`).all(limit);
}

export async function getDueCount(category = null) {
  const db = await getDb();
  if (category) return db.prepare(`SELECT COUNT(*) as count FROM flashcards WHERE category = ? AND (next_review IS NULL OR next_review <= datetime('now'))`).get(category).count;
  return db.prepare(`SELECT COUNT(*) as count FROM flashcards WHERE next_review IS NULL OR next_review <= datetime('now')`).get().count;
}

export async function getRecentStats(days = 7) {
  const db = await getDb();
  return db.prepare(`SELECT category, COUNT(*) as total, SUM(correct_count) as correct, SUM(review_count) as reviews FROM flashcards WHERE updated_at >= datetime('now', ?) GROUP BY category`).all(`-${days} days`);
}

export async function updateCard(id, correct, fsrsState = null) {
  const db = await getDb();
  const card = db.prepare(`SELECT * FROM flashcards WHERE id = ?`).get(id);
  if (!card) return null;
  const rating = booleanToRating(correct);
  const scheduling = fsrsSchedule(card.fsrs_state ? JSON.parse(card.fsrs_state) : null, rating);
  const nextReview = scheduling ? scheduling.due : new Date(Date.now() + 86400000).toISOString();
  db.prepare(`UPDATE flashcards SET review_count = review_count + 1, correct_count = correct_count + ?, fsrs_state = ?, next_review = ?, updated_at = datetime('now') WHERE id = ?`).run(correct ? 1 : 0, JSON.stringify(scheduling), nextReview, id);
  return { ...card, next_review: nextReview };
}

export { getDb };
