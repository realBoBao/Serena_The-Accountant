/**
 * Embedding Cache — SQLite-backed LRU cache
 * Compatible với cả node:sqlite (Node 22+) và better-sqlite3 (Node 20)
 */

import { getDb, runDb, getDbRow } from './sqlite_adapter.js';
import { createHash } from 'crypto';

const DEFAULT_TTL_MS = Number(process.env.EMBEDDING_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DEFAULT_MAX = Number(process.env.EMBEDDING_CACHE_MAX || 10000);
const MEMORY_CACHE_MAX = Number(process.env.MEMORY_CACHE_MAX || 500);

// ── Tier 1: In-Memory LRU ───────────────────────────────────────────────────

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
    this._hits = 0;
    this._misses = 0;
  }
  get(key) {
    const v = this.map.get(key);
    if (v) { this._hits++; return v; }
    this._misses++;
    return null;
  }
  set(key, value) {
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  get stats() {
    const total = this._hits + this._misses;
    return { size: this.map.size, hits: this._hits, misses: this._misses, hitRate: total > 0 ? Math.round((this._hits / total) * 100) : 0 };
  }
}

const memoryCache = new LRUCache(MEMORY_CACHE_MAX);

function textToHash(text) {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer);
}

function bufferToFloat32(buf) {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// ── Tier 2: SQLite ──────────────────────────────────────────────────────────

export async function getCachedEmbedding(text) {
  const hash = textToHash(text);

  // Tier 1: memory
  const mem = memoryCache.get(hash);
  if (mem) return mem;

  // Tier 2: SQLite
  try {
    const row = await getOne('SELECT embedding, created_at FROM embedding_cache WHERE text_hash = ?', [hash]);
    if (!row) return null;

    // TTL check
    if (Date.now() - row.created_at > DEFAULT_TTL_MS) {
      await runQuery('DELETE FROM embedding_cache WHERE text_hash = ?', [hash]);
      return null;
    }

    // Update stats
    await runQuery('UPDATE embedding_cache SET accessed_at = ?, hit_count = hit_count + 1 WHERE text_hash = ?', [Date.now(), hash]);

    const embedding = bufferToFloat32(row.embedding);
    memoryCache.set(hash, embedding);
    return embedding;
  } catch { return null; }
}

export async function setCachedEmbedding(text, embedding) {
  const hash = textToHash(text);
  memoryCache.set(hash, embedding);

  try {
    const buf = float32ToBuffer(embedding);
    const now = Date.now();

    // runDb tự động getDb() — không cần truyền db param
    await runDb(`CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT PRIMARY KEY, text_preview TEXT, embedding BLOB,
      dims INTEGER, created_at INTEGER, accessed_at INTEGER, hit_count INTEGER DEFAULT 1
    )`);

    await runDb('INSERT OR REPLACE INTO embedding_cache VALUES (?, ?, ?, ?, ?, ?, 1)',
      hash, text.slice(0, 80), buf, embedding.length, now, now);

    // Evict old
    const count = await getDbRow('SELECT COUNT(*) as n FROM embedding_cache');
    if (count && count.n > DEFAULT_MAX) {
      const evict = Math.ceil(DEFAULT_MAX * 0.2);
      await runDb('DELETE FROM embedding_cache WHERE text_hash IN (SELECT text_hash FROM embedding_cache ORDER BY accessed_at ASC LIMIT ?)', evict);
    }
  } catch { /* cache must never break pipeline */ }
}

export async function getCacheStats() {
  try {
    const db = await getDb();
    const row = getDbRow(db, 'SELECT COUNT(*) as total, SUM(hit_count) as total_hits FROM embedding_cache');
    return { memory: memoryCache.stats, sqlite: { total: row?.total || 0, totalHits: row?.total_hits || 0, maxSize: DEFAULT_MAX } };
  } catch { return { memory: memoryCache.stats, sqlite: { total: 0, totalHits: 0, maxSize: DEFAULT_MAX } }; }
}

export async function clearCache() {
  try {
    const db = await getDb();
    runDb(db, 'DELETE FROM embedding_cache');
  } catch { /* ignore */ }
}

export default { getCachedEmbedding, setCachedEmbedding, getCacheStats, clearCache };
