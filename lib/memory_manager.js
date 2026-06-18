import { getDb } from './sqlite_adapter.js';
import path from 'path';
import { LSMTree } from './lsm_tree.js';

const MEMORY_DB_PATH = path.resolve('./memory.db');

/**
 * Safe JSON.parse — trả về default value nếu parse lỗi.
 * Dùng cho tất cả DB reads để tránh crash khi data bị corrupt.
 */
function safeJsonParse(str, defaultValue = {}) {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

// ── LSM-Tree Storage Backend ──────────────────────────────
// High-performance write-optimized storage for high-volume data.
// Falls back to SQLite for complex queries (JOIN, LIKE, etc).
let _lsmTree = null;

/**
 * Get or initialize the LSM-Tree instance.
 */
export async function getLsmTree() {
  if (!_lsmTree) {
    _lsmTree = new LSMTree({
      dataDir: './data/lsm-memory',
      memTableSize: 500,
      memTableBytes: 2 * 1024 * 1024, // 2MB
      compactionInterval: 30000, // 30s
    });
    await _lsmTree.open();
  }
  return _lsmTree;
}

/**
 * Close the LSM-Tree (for graceful shutdown).
 */
export async function closeLsmTree() {
  if (_lsmTree) {
    await _lsmTree.close();
    _lsmTree = null;
  }
}

async function getMemoryDb() {
  const db = await getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    type TEXT,
    source TEXT,
    source_url TEXT,
    content TEXT,
    tags TEXT,
    created_at TEXT,
    archived INTEGER DEFAULT 0,
    archived_at TEXT
  )`);
  return db;
}

function normalizeTags(tags) {
  if (!tags) return JSON.stringify([]);
  return JSON.stringify(Array.isArray(tags) ? tags : [tags]);
}

export async function addMemory({ id, type = 'memory', source = '', sourceUrl = '', content = '', tags = [], createdAt = new Date().toISOString() }) {
  const db = await getMemoryDb();
  await db.prepare(
    `INSERT OR REPLACE INTO memory_entries (id, type, source, source_url, content, tags, created_at, archived, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`
  ).run(id, type, source, sourceUrl, content, normalizeTags(tags), createdAt);
  return true;
}

export async function getRecentMemory(days = 7) {
  const db = await getMemoryDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    `SELECT * FROM memory_entries WHERE archived = 0 AND created_at >= ? ORDER BY created_at DESC`
  ).all(cutoff);
  return rows.map((row) => ({ ...row, tags: safeJsonParse(row.tags, []) }));
}

export async function getArchivedMemory() {
  const db = await getMemoryDb();
  const rows = db.prepare(`SELECT * FROM memory_entries WHERE archived = 1 ORDER BY archived_at DESC`).all();
  return rows.map((row) => ({ ...row, tags: safeJsonParse(row.tags, []) }));
}

export async function archiveOldMemories(retentionDays = 7) {
  const db = await getMemoryDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE memory_entries SET archived = 1, archived_at = ? WHERE archived = 0 AND created_at < ?`
  ).run(now, cutoff);
  return true;
}

export async function searchMemory(keyword, includeArchived = false) {
  const db = await getMemoryDb();
  const likeKeyword = `%${keyword}%`;
  const rows = db.prepare(
    `SELECT * FROM memory_entries WHERE content LIKE ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY created_at DESC`
  ).all(likeKeyword);
  return rows.map((row) => ({ ...row, tags: safeJsonParse(row.tags, []) }));
}

// ═══════════════════════════════════════════════════════════
//  LSM-Tree Storage — High-throughput write path
// ═══════════════════════════════════════════════════════════

/**
 * Store a memory entry in LSM-Tree (O(1) write).
 * Use for high-volume writes: chat logs, PDF chunks, system events.
 *
 * @param {string} id
 * @param {Object} data — { type, source, content, tags, createdAt, ... }
 */
export async function addMemoryLsm(id, data) {
  const lsm = await getLsmTree();
  await lsm.put(id, {
    ...data,
    storedAt: Date.now(),
  });
  return true;
}

/**
 * Retrieve a memory entry from LSM-Tree by ID (O(log n) read).
 */
export async function getMemoryLsm(id) {
  const lsm = await getLsmTree();
  return lsm.get(id);
}

/**
 * Batch write multiple entries to LSM-Tree (high throughput).
 * @param {Array} entries — [{ id, data }]
 */
export async function batchAddMemoryLsm(entries) {
  const lsm = await getLsmTree();
  for (const { id, data } of entries) {
    await lsm.put(id, { ...data, storedAt: Date.now() });
  }
  return entries.length;
}

/**
 * Delete from LSM-Tree (tombstone).
 */
export async function deleteMemoryLsm(id) {
  const lsm = await getLsmTree();
  await lsm.delete(id);
  return true;
}

/**
 * Get LSM-Tree statistics.
 */
export async function getLsmStats() {
  const lsm = await getLsmTree();
  return lsm.getStats();
}
