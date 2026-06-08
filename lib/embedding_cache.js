/**
 * Embedding Cache — SQLite-backed LRU cache for Gemini embeddings.
 * Avoids re-computing embeddings for repeated/similar queries.
 *
 * TTL: 7 days (configurable via EMBEDDING_CACHE_TTL_MS)
 * Max entries: 10000 (configurable via EMBEDDING_CACHE_MAX)
 *
 * 2-tier caching:
 *   Tier 1: In-memory LRU (Doubly Linked List + HashMap) — O(1) lookup
 *   Tier 2: SQLite persistent cache — survives restarts
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { createHash } from 'crypto';

const CACHE_DB = path.resolve('./embedding_cache.db');
const DEFAULT_TTL_MS = Number(process.env.EMBEDDING_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DEFAULT_MAX = Number(process.env.EMBEDDING_CACHE_MAX || 10000);

// ── Tier 1: In-Memory LRU Cache (Doubly Linked List + HashMap) ──
// O(1) lookup, O(1) insert, O(1) eviction — prevents OOM by capping RAM usage

const MEMORY_CACHE_MAX = Number(process.env.MEMORY_CACHE_MAX || 500); // Max entries in RAM

class LRUNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

class LRUCache {
  constructor(maxSize = MEMORY_CACHE_MAX) {
    this.maxSize = maxSize;
    this.map = new Map();       // key → LRUNode
    this.head = new LRUNode(null, null); // dummy head (most recent)
    this.tail = new LRUNode(null, null); // dummy tail (least recent)
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this._hits = 0;
    this._misses = 0;
  }

  get(key) {
    const node = this.map.get(key);
    if (!node) {
      this._misses++;
      return null;
    }
    this._hits++;
    this._moveToHead(node);
    return node.value;
  }

  set(key, value) {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      this._moveToHead(existing);
      return;
    }

    const node = new LRUNode(key, value);
    this.map.set(key, node);
    this._addToHead(node);

    if (this.map.size > this.maxSize) {
      const evicted = this._removeTail();
      if (evicted) this.map.delete(evicted.key);
    }
  }

  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }

  get stats() {
    const total = this._hits + this._misses;
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? Math.round((this._hits / total) * 100) : 0,
    };
  }

  _addToHead(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }

  _removeNode(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _moveToHead(node) {
    this._removeNode(node);
    this._addToHead(node);
  }

  _removeTail() {
    const node = this.tail.prev;
    if (node === this.head) return null;
    this._removeNode(node);
    return node;
  }
}

// Global in-memory LRU instance
const memoryCache = new LRUCache(MEMORY_CACHE_MAX);

// ── Tier 2: SQLite Persistent Cache ──

let dbPromise = null;

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await open({ filename: CACHE_DB, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash TEXT PRIMARY KEY,
        text_preview TEXT,
        embedding BLOB,
        dims INTEGER,
        created_at INTEGER,
        accessed_at INTEGER,
        hit_count INTEGER DEFAULT 1
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_accessed ON embedding_cache(accessed_at)`);
    return db;
  })();
  return dbPromise;
}

function textToHash(text) {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer);
}

function bufferToFloat32(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

/**
 * Get cached embedding. Returns null if miss or expired.
 * Tier 1: In-memory LRU (O(1)) → Tier 2: SQLite (persistent)
 */
export async function getCachedEmbedding(text) {
  const hash = textToHash(text);

  // Tier 1: Check in-memory LRU first (O(1))
  const memResult = memoryCache.get(hash);
  if (memResult) return memResult;

  // Tier 2: Check SQLite
  try {
    const db = await getDb();
    const row = await db.get(
      'SELECT embedding, dims, created_at FROM embedding_cache WHERE text_hash = ?',
      hash
    );
    if (!row) return null;

    // Check TTL
    const age = Date.now() - row.created_at;
    if (age > DEFAULT_TTL_MS) {
      await db.run('DELETE FROM embedding_cache WHERE text_hash = ?', hash);
      return null;
    }

    // Update access stats
    await db.run(
      'UPDATE embedding_cache SET accessed_at = ?, hit_count = hit_count + 1 WHERE text_hash = ?',
      Date.now(), hash
    );

    const embedding = bufferToFloat32(row.embedding);

    // Promote to Tier 1 (in-memory LRU)
    memoryCache.set(hash, embedding);

    return embedding;
  } catch (_) {
    return null; // Cache must never break the pipeline
  }
}

/**
 * Store embedding in cache. Evicts oldest entries if over max.
 * Writes to both Tier 1 (memory) and Tier 2 (SQLite).
 */
export async function setCachedEmbedding(text, embedding) {
  const hash = textToHash(text);

  // Tier 1: Write to in-memory LRU immediately
  memoryCache.set(hash, embedding);

  // Tier 2: Write to SQLite (async, non-blocking)
  try {
    const db = await getDb();
    const buf = float32ToBuffer(embedding);
    const now = Date.now();
    const preview = text.slice(0, 80);

    await db.run(
      `INSERT OR REPLACE INTO embedding_cache (text_hash, text_preview, embedding, dims, created_at, accessed_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      hash, preview, buf, embedding.length, now, now
    );

    // Evict oldest if over max (batch delete to avoid frequent cleanup)
    const count = await db.get('SELECT COUNT(*) as n FROM embedding_cache');
    if (count.n > DEFAULT_MAX) {
      const evictCount = Math.ceil(DEFAULT_MAX * 0.2); // Evict 20%
      await db.run(
        `DELETE FROM embedding_cache WHERE text_hash IN (
          SELECT text_hash FROM embedding_cache ORDER BY accessed_at ASC LIMIT ?
        )`,
        evictCount
      );
    }
  } catch (_) {
    // Cache must never break the pipeline
  }
}

/**
 * Get cache stats for monitoring.
 */
export async function getCacheStats() {
  const memStats = memoryCache.stats;
  try {
    const db = await getDb();
    const row = await db.get('SELECT COUNT(*) as total, SUM(hit_count) as total_hits FROM embedding_cache');
    return {
      memory: memStats,
      sqlite: {
        total: row?.total || 0,
        totalHits: row?.total_hits || 0,
        maxSize: DEFAULT_MAX,
      },
      combinedHitRate: memStats.hitRate,
    };
  } catch {
    return {
      memory: memStats,
      sqlite: { total: 0, totalHits: 0, maxSize: DEFAULT_MAX },
      combinedHitRate: memStats.hitRate,
    };
  }
}

/**
 * Clear all cached embeddings.
 */
export async function clearCache() {
  try {
    const db = await getDb();
    await db.run('DELETE FROM embedding_cache');
  } catch (_) {
    // ignore
  }
}
