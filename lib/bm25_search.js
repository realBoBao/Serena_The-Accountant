/**
 * BM25 Keyword Search Engine
 * Lightweight in-memory + SQLite-backed full-text search.
 * Complements vector search with exact keyword matching.
 *
 * Usage:
 *   import { indexDocument, searchBm25, removeDocument } from './bm25_search.js';
 *   await indexDocument('doc1', 'Title', 'chunk text...');
 *   const results = await searchBm25('keyword query', 5);
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const BM25_DB = path.resolve('./bm25_index.db');

// BM25 parameters
const K1 = 1.5;
const B = 0.75;

let dbPromise = null;
let statsCache = { avgDl: 0, totalDocs: 0, dirty: true };

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await open({ filename: BM25_DB, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS bm25_docs (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        chunk_index INTEGER DEFAULT 0,
        chunk_text TEXT NOT NULL,
        url TEXT DEFAULT '',
        project TEXT DEFAULT '',
        category TEXT DEFAULT 'General',
        metadata TEXT DEFAULT '{}',
        term_count INTEGER DEFAULT 0,
        added_at TEXT
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS bm25_terms (
        term TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        freq INTEGER DEFAULT 1,
        PRIMARY KEY (term, doc_id)
      ) WITHOUT ROWID
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_bm25_terms_term ON bm25_terms(term)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_bm25_docs_doc_id ON bm25_docs(doc_id)`);
    return db;
  })();
  return dbPromise;
}

// ── Tokenization ──

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'it',
  'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom',
  // Vietnamese stop words
  'của', 'và', 'các', 'là', 'được', 'cho', 'với', 'một', 'có', 'đã',
  'sẽ', 'những', 'này', 'từ', 'trong', 'đến', 'về', 'như', 'khi', 'nếu',
  'thì', 'mà', 'cũng', 'để', 'rất', 'nên', 'hay', 'hoặc', 'tại', 'bị',
  'lại', 'theo', 'đó', 'nào', 'ai', 'gì', 'sao', 'bao', 'nhiều', 'hơn',
]);

function tokenize(text) {
  if (!text) return [];
  // Lowercase, split on non-alphanumeric (keep Vietnamese diacritics)
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
  return tokens;
}

function computeTf(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  return tf;
}

// ── Stats ──

async function refreshStats() {
  if (!statsCache.dirty) return;
  try {
    const db = await getDb();
    const row = await db.get('SELECT COUNT(*) as n, AVG(term_count) as avgDl FROM bm25_docs');
    statsCache.totalDocs = row?.n || 0;
    statsCache.avgDl = row?.avgDl || 0;
    statsCache.dirty = false;
  } catch (_) {
    statsCache = { avgDl: 0, totalDocs: 0, dirty: false };
  }
}

// ── Public API ──

/**
 * Index a document chunk for BM25 search.
 */
export async function indexDocument(docId, metadata = {}, chunks = []) {
  if (!docId || !chunks?.length) return;

  const db = await getDb();
  const addedAt = new Date().toISOString();

  // Remove old entries for this doc
  await db.run('DELETE FROM bm25_docs WHERE doc_id = ?', docId);
  await db.run('DELETE FROM bm25_terms WHERE doc_id = ?', docId);

  const docStmt = await db.prepare(
    'INSERT INTO bm25_docs (id, doc_id, chunk_index, chunk_text, url, project, category, metadata, term_count, added_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  const termStmt = await db.prepare(
    'INSERT OR REPLACE INTO bm25_terms (term, doc_id, freq) VALUES (?,?,?)'
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tokens = tokenize(chunk);
    const tf = computeTf(tokens);
    const termCount = tokens.length;
    const id = `${docId}::${i}`;

    await docStmt.run(
      id, docId, i, chunk,
      metadata?.url || '', metadata?.project || '',
      metadata?.category || 'General',
      JSON.stringify(metadata || {}),
      termCount, addedAt
    );

    for (const [term, freq] of Object.entries(tf)) {
      await termStmt.run(term, id, freq);
    }
  }

  await docStmt.finalize();
  await termStmt.finalize();
  statsCache.dirty = true;
}

/**
 * Remove a document from the BM25 index.
 */
export async function removeDocument(docId) {
  try {
    const db = await getDb();
    await db.run('DELETE FROM bm25_docs WHERE doc_id = ?', docId);
    await db.run('DELETE FROM bm25_terms WHERE doc_id LIKE ?', `${docId}::%`);
    statsCache.dirty = true;
  } catch (_) {
    // no-op
  }
}

/**
 * Search BM25 index. Returns [{ score, doc_id, chunk_index, chunk_text, url, project, category, metadata }].
 */
export async function searchBm25(query, topK = 5) {
  try {
    const db = await getDb();
    await refreshStats();

    if (statsCache.totalDocs === 0) return [];

    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    // Build score map: docId -> score
    const scores = {};

    for (const term of queryTokens) {
      // Get document frequency for this term
      const dfRow = await db.get(
        'SELECT COUNT(DISTINCT doc_id) as df FROM bm25_terms WHERE term = ?',
        term
      );
      const df = dfRow?.df || 0;
      if (df === 0) continue;

      // IDF calculation
      const idf = Math.log((statsCache.totalDocs - df + 0.5) / (df + 0.5) + 1);

      // Get term frequencies in each document
      const termRows = await db.all(
        'SELECT doc_id, freq FROM bm25_terms WHERE term = ?',
        term
      );

      for (const { doc_id: docTermId, freq } of termRows) {
        // Get document length
        const docRow = await db.get(
          'SELECT term_count FROM bm25_docs WHERE id = ?',
          docTermId
        );
        const dl = docRow?.term_count || 0;
        const avgDl = statsCache.avgDl || 1;

        // BM25 score
        const numerator = freq * (K1 + 1);
        const denominator = freq + K1 * (1 - B + B * (dl / avgDl));
        const score = idf * (numerator / denominator);

        scores[docTermId] = (scores[docTermId] || 0) + score;
      }
    }

    // Sort and get topK
    const sorted = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    if (!sorted.length) return [];

    // Fetch full document data
    const results = [];
    for (const [id, score] of sorted) {
      const row = await db.get('SELECT * FROM bm25_docs WHERE id = ?', id);
      if (!row) continue;
      let meta = {};
      try { meta = JSON.parse(row.metadata || '{}'); } catch (_) {}
      results.push({
        score: Number(score.toFixed(4)),
        doc_id: row.doc_id,
        chunk_index: row.chunk_index,
        chunk_text: row.chunk_text,
        url: row.url,
        project: row.project,
        category: row.category,
        metadata: meta,
        added_at: row.added_at,
      });
    }

    return results;
  } catch (err) {
    return [];
  }
}

/**
 * Get BM25 index stats.
 */
export async function getBm25Stats() {
  try {
    const db = await getDb();
    const row = await db.get('SELECT COUNT(DISTINCT doc_id) as docs, COUNT(*) as chunks FROM bm25_docs');
    const termRow = await db.get('SELECT COUNT(DISTINCT term) as terms FROM bm25_terms');
    return {
      documents: row?.docs || 0,
      chunks: row?.chunks || 0,
      uniqueTerms: termRow?.terms || 0,
    };
  } catch (_) {
    return { documents: 0, chunks: 0, uniqueTerms: 0 };
  }
}
