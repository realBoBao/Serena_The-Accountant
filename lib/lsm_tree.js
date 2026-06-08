/**
 * ═══════════════════════════════════════════════════════════════
 * LSM-Tree (Log-Structured Merge-Tree) — High-Performance Storage Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * Trái tim của Google Bigtable, AWS DynamoDB, Cassandra.
 *
 * Kiến trúc:
 * ┌─────────────────────────────────────────────────────────┐
 * │  WRITE PATH                                             │
 * │  ┌──────────┐    ┌──────────┐    ┌──────────────────┐  │
 * │  │ MemTable │ →  │  Flush   │ →  │  SSTable (Disk)  │  │
 * │  │  (RAM)   │    │          │    │  Sorted + Immutable│ │
 * │  └──────────┘    └──────────┘    └──────────────────┘  │
 * │                                      ↓                  │
 * │                              ┌──────────────┐          │
 * │                              │  Compaction  │          │
 * │                              │  (Background)│          │
 * │                              └──────────────┘          │
 * │                                                         │
 * │  READ PATH                                              │
 * │  MemTable → Immutable MemTables → SSTable L0 → L1 → L2 │
 * └─────────────────────────────────────────────────────────┘
 *
 * @author Serena_Project00
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getLogger } from './logger.js';

const logger = getLogger('LSM-Tree');

// ═══════════════════════════════════════════════════════════
//  SkipList — O(log n) sorted in-memory structure for MemTable
// ═══════════════════════════════════════════════════════════

const SKIPLIST_MAX_LEVEL = 16;
const SKIPLIST_P = 0.5;

class SkipListNode {
  constructor(key, value, level) {
    this.key = key;
    this.value = value;
    this.forward = new Array(level).fill(null);
  }
}

class SkipList {
  constructor() {
    this.level = 1;
    this.size = 0;
    this.head = new SkipListNode(null, null, SKIPLIST_MAX_LEVEL);
  }

  _randomLevel() {
    let lvl = 1;
    while (Math.random() < SKIPLIST_P && lvl < SKIPLIST_MAX_LEVEL) lvl++;
    return lvl;
  }

  insert(key, value) {
    const update = new Array(SKIPLIST_MAX_LEVEL).fill(null);
    let current = this.head;

    for (let i = this.level - 1; i >= 0; i--) {
      while (current.forward[i] && current.forward[i].key < key) {
        current = current.forward[i];
      }
      update[i] = current;
    }

    current = current.forward[0];

    // Update existing key
    if (current && current.key === key) {
      current.value = value;
      return;
    }

    const newLevel = this._randomLevel();
    if (newLevel > this.level) {
      for (let i = this.level; i < newLevel; i++) {
        update[i] = this.head;
      }
      this.level = newLevel;
    }

    const newNode = new SkipListNode(key, value, newLevel);
    for (let i = 0; i < newLevel; i++) {
      newNode.forward[i] = update[i].forward[i];
      update[i].forward[i] = newNode;
    }
    this.size++;
  }

  get(key) {
    let current = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (current.forward[i] && current.forward[i].key < key) {
        current = current.forward[i];
      }
    }
    current = current.forward[0];
    if (current && current.key === key) return current.value;
    return null;
  }

  delete(key) {
    // Tombstone: mark as deleted
    this.insert(key, { __deleted: true, __ts: Date.now() });
  }

  has(key) {
    const val = this.get(key);
    return val !== null && !val.__deleted;
  }

  // Iterate all entries in sorted order
  *entries() {
    let current = this.head.forward[0];
    while (current) {
      yield { key: current.key, value: current.value };
      current = current.forward[0];
    }
  }

  toArray() {
    const result = [];
    for (const { key, value } of this.entries()) {
      result.push({ key, value });
    }
    return result;
  }

  clear() {
    this.level = 1;
    this.size = 0;
    this.head = new SkipListNode(null, null, SKIPLIST_MAX_LEVEL);
  }

  get byteSize() {
    // Rough estimate of memory usage
    let bytes = 0;
    for (const { key, value } of this.entries()) {
      bytes += (key?.length || 0) * 2; // UTF-16
      bytes += JSON.stringify(value).length * 2;
    }
    return bytes;
  }
}

// ═══════════════════════════════════════════════════════════
//  SSTable — Immutable sorted file on disk
// ═══════════════════════════════════════════════════════════

class SSTable {
  constructor(filePath, level = 0) {
    this.filePath = filePath;
    this.level = level;
    this.index = new Map(); // key → file offset (loaded on open)
    this.minKey = null;
    this.maxKey = null;
    this.entryCount = 0;
    this.loaded = false;
  }

  /**
   * Write a sorted array of { key, value } entries to disk.
   * Format: [4 bytes entry_count][entry1_len][entry1_json]...
   */
  static async write(filePath, entries) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const chunks = [];
    // Header: entry count
    const header = Buffer.alloc(4);
    header.writeUInt32LE(entries.length, 0);
    chunks.push(header);

    for (const { key, value } of entries) {
      const entryJson = JSON.stringify({ key, value });
      const entryBuf = Buffer.from(entryJson, 'utf8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(entryBuf.length, 0);
      chunks.push(lenBuf, entryBuf);
    }

    await fs.writeFile(filePath, Buffer.concat(chunks));
    logger.info(`[SSTable] Wrote ${entries.length} entries → ${path.basename(filePath)}`);
  }

  /**
   * Load index from disk (scan once, then use in-memory index).
   */
  async load() {
    if (this.loaded) return;
    if (!existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }

    const buf = await fs.readFile(this.filePath);
    let offset = 4; // skip header (4 bytes entry count)
    const count = buf.readUInt32LE(0);

    for (let i = 0; i < count; i++) {
      const entryLen = buf.readUInt32LE(offset);
      const entryStart = offset + 4; // start of JSON data
      const entryJson = buf.slice(entryStart, entryStart + entryLen).toString('utf8');
      offset = entryStart + entryLen; // advance past this entry

      try {
        const { key, value } = JSON.parse(entryJson);
        if (!this.minKey || key < this.minKey) this.minKey = key;
        if (!this.maxKey || key > this.maxKey) this.maxKey = key;
        // Store offset pointing to the JSON data (not the length prefix)
        this.index.set(key, { dataOffset: entryStart, dataLength: entryLen });
      } catch { /* skip corrupt entry */ }
    }

    this.entryCount = count;
    this.loaded = true;
  }

  /**
   * Get value by key (O(1) with index).
   */
  async get(key) {
    if (!this.loaded) await this.load();
    if (this.minKey === null || this.maxKey === null) return null;
    if (key < this.minKey || key > this.maxKey) return null;

    const meta = this.index.get(key);
    if (!meta) return null;

    const buf = await fs.readFile(this.filePath);
    const entryJson = buf.slice(meta.dataOffset, meta.dataOffset + meta.dataLength).toString('utf8');
    try {
      const { value } = JSON.parse(entryJson);
      return value;
    } catch {
      return null;
    }
  }

  /**
   * Check if key might be in this SSTable (range check).
   */
  mightContain(key) {
    if (!this.loaded) return true; // conservative
    return key >= this.minKey && key <= this.maxKey;
  }

  /**
   * Get all entries as sorted array.
   */
  async allEntries() {
    if (!this.loaded) await this.load();
    const result = [];
    for (const [key] of this.index) {
      const value = await this.get(key);
      if (value !== null) result.push({ key, value });
    }
    return result.sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  get size() {
    return this.entryCount;
  }

  get fileSize() {
    try {
      const stat = require('fs').statSync(this.filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  LSM-Tree — Main Engine
// ═══════════════════════════════════════════════════════════

export class LSMTree {
  /**
   * @param {Object} opts
   * @param {string} opts.dataDir     — Directory for SSTable files
   * @param {number} [opts.memTableSize=1000] — Max entries before flush
   * @param {number} [opts.memTableBytes=4194304] — Max bytes (4MB) before flush
   * @param {number} [opts.compactionInterval=60000] — Compaction check interval (ms)
   * @param {number} [opts.maxSSTablesPerLevel=4] — Trigger compaction when exceeded
   */
  constructor({
    dataDir = './data/lsm',
    memTableSize = 1000,
    memTableBytes = 4 * 1024 * 1024, // 4MB
    compactionInterval = 60000,
    maxSSTablesPerLevel = 4,
  } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.memTableSize = memTableSize;
    this.memTableBytes = memTableBytes;
    this.compactionInterval = compactionInterval;
    this.maxSSTablesPerLevel = maxSSTablesPerLevel;

    // Active MemTable (accepts writes)
    this.memTable = new SkipList();

    // Immutable MemTables (waiting to be flushed)
    this.immutableMemTables = [];

    // SSTables on disk, organized by level
    this.sstables = [[], [], [], [], [], []]; // L0 → L5

    // Compaction tombstones tracking
    this.stats = {
      writes: 0,
      reads: 0,
      flushes: 0,
      compactions: 0,
      deletes: 0,
    };

    this._compactionTimer = null;
    this._walPath = path.join(this.dataDir, 'wal.log');
    this._sstCounter = 0;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async open() {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Recover from WAL if exists
    await this._recoverFromWAL();

    // Load existing SSTable metadata
    await this._loadExistingSSTables();

    // Start background compaction
    this._startCompaction();

    logger.info(`[LSM-Tree] Opened — ${this.sstables.flat().length} SSTables, ${this.memTable.size} in MemTable`);
  }

  async close() {
    if (this._compactionTimer) {
      clearInterval(this._compactionTimer);
      this._compactionTimer = null;
    }

    // Flush remaining MemTable
    if (this.memTable.size > 0) {
      await this._flushMemTable();
    }

    // Flush immutable MemTables
    while (this.immutableMemTables.length > 0) {
      await this._flushMemTable();
    }

    logger.info('[LSM-Tree] Closed');
  }

  // ── Write Path ────────────────────────────────────────────

  /**
   * Put key-value pair. O(1) amortized.
   * @param {string} key
   * @param {*} value — JSON-serializable
   */
  async put(key, value) {
    // Write to WAL first (durability)
    await this._writeWAL(key, value, 'PUT');

    // Insert into MemTable
    this.memTable.insert(key, value);
    this.stats.writes++;

    // Check if MemTable is full → trigger flush
    if (this.memTable.size >= this.memTableSize ||
        this.memTable.byteSize >= this.memTableBytes) {
      await this._rotateMemTable();
    }
  }

  /**
   * Delete key (tombstone). O(1).
   */
  async delete(key) {
    await this._writeWAL(key, null, 'DELETE');
    this.memTable.delete(key);
    this.stats.deletes++;
  }

  // ── Read Path ─────────────────────────────────────────────

  /**
   * Get value by key. Searches: MemTable → Immutable → SSTables.
   * @param {string} key
   * @returns {*} value or null
   */
  async get(key) {
    this.stats.reads++;

    // 1. Check active MemTable
    const memVal = this.memTable.get(key);
    if (memVal !== null) {
      if (memVal.__deleted) return null;
      return memVal;
    }

    // 2. Check immutable MemTables (newest first)
    for (let i = this.immutableMemTables.length - 1; i >= 0; i--) {
      const immVal = this.immutableMemTables[i].get(key);
      if (immVal !== null) {
        if (immVal.__deleted) return null;
        return immVal;
      }
    }

    // 3. Check SSTables (L0 first, then L1, L2...)
    for (let level = 0; level < this.sstables.length; level++) {
      // L0: check all (may overlap), newest first
      // L1+: check only SSTables that might contain key
      const tables = level === 0
        ? [...this.sstables[level]].reverse()
        : this.sstables[level].filter(s => s.mightContain(key));

      for (const sst of tables) {
        const val = await sst.get(key);
        if (val !== null) {
          if (val.__deleted) return null;
          return val;
        }
      }
    }

    return null;
  }

  /**
   * Check if key exists.
   */
  async has(key) {
    return (await this.get(key)) !== null;
  }

  /**
   * Get all entries (for compaction/debug).
   */
  async *scan() {
    // Collect all unique keys from all sources
    const seen = new Set();

    // MemTable
    for (const { key, value } of this.memTable.entries()) {
      if (!value.__deleted && !seen.has(key)) {
        seen.add(key);
        yield { key, value };
      }
    }

    // Immutable MemTables
    for (const imm of this.immutableMemTables) {
      for (const { key, value } of imm.entries()) {
        if (!value.__deleted && !seen.has(key)) {
          seen.add(key);
          yield { key, value };
        }
      }
    }

    // SSTables
    for (const levelTables of this.sstables) {
      for (const sst of levelTables) {
        const entries = await sst.allEntries();
        for (const { key, value } of entries) {
          if (!value.__deleted && !seen.has(key)) {
            seen.add(key);
            yield { key, value };
          }
        }
      }
    }
  }

  // ── Flush (MemTable → SSTable) ───────────────────────────

  async _rotateMemTable() {
    if (this.memTable.size === 0) return;

    // Freeze current MemTable
    this.immutableMemTables.push(this.memTable);
    this.memTable = new SkipList();

    logger.info(`[LSM-Tree] MemTable rotated → ${this.immutableMemTables.length} immutable waiting`);
  }

  async _flushMemTable() {
    if (this.immutableMemTables.length === 0) return;

    const imm = this.immutableMemTables.shift();
    if (imm.size === 0) return;

    const entries = imm.toArray().filter(({ value }) => !value.__deleted);
    entries.sort((a, b) => (a.key < b.key ? -1 : 1));

    const sstPath = path.join(this.dataDir, `L0_${Date.now()}_${++this._sstCounter}.sst`);
    await SSTable.write(sstPath, entries);

    const sst = new SSTable(sstPath, 0);
    await sst.load();
    this.sstables[0].push(sst);

    this.stats.flushes++;
    logger.info(`[LSM-Tree] Flushed ${entries.length} entries → L0 (${this.sstables[0].length} tables)`);

    // Clear WAL after successful flush
    await this._clearWAL();
  }

  // ── Compaction (Background Merge-Sort) ────────────────────

  _startCompaction() {
    this._compactionTimer = setInterval(async () => {
      try {
        await this._compact();
      } catch (err) {
        logger.error(`[LSM-Tree] Compaction error: ${err.message}`);
      }
    }, this.compactionInterval);

    // Don't block process exit
    if (this._compactionTimer.unref) this._compactionTimer.unref();
  }

  async _compact() {
    // Flush any remaining immutable MemTables
    while (this.immutableMemTables.length > 0) {
      await this._flushMemTable();
    }

    // Compact each level
    for (let level = 0; level < this.sstables.length - 1; level++) {
      if (this.sstables[level].length >= this.maxSSTablesPerLevel) {
        await this._compactLevel(level);
      }
    }
  }

  /**
   * Merge-sort SSTables from level N into level N+1.
   * Removes tombstones and deduplicates.
   */
  async _compactLevel(level) {
    const tables = this.sstables[level];
    if (tables.length === 0) return;

    // Pick tables to merge (all at L0, or oldest at L1+)
    const toMerge = level === 0 ? [...tables] : tables.slice(0, Math.ceil(tables.length / 2));

    logger.info(`[LSM-Tree] Compacting L${level}: merging ${toMerge.length} SSTables`);

    // Collect all entries from tables being merged
    const allEntries = [];
    const mergedKeys = new Map(); // key → newest value

    for (const sst of toMerge) {
      const entries = await sst.allEntries();
      for (const { key, value } of entries) {
        mergedKeys.set(key, value); // Last write wins
      }
    }

    // Remove tombstones
    const cleanEntries = [];
    for (const [key, value] of mergedKeys) {
      if (!value.__deleted) {
        cleanEntries.push({ key, value });
      }
    }
    cleanEntries.sort((a, b) => (a.key < b.key ? -1 : 1));

    if (cleanEntries.length === 0) {
      // All deleted — just remove the files
      for (const sst of toMerge) {
        await fs.unlink(sst.filePath).catch(() => {});
      }
      this.sstables[level] = this.sstables[level].filter(s => !toMerge.includes(s));
      return;
    }

    // Write new SSTable at level+1
    const nextLevel = level + 1;
    const sstPath = path.join(this.dataDir, `L${nextLevel}_${Date.now()}_${++this._sstCounter}.sst`);
    await SSTable.write(sstPath, cleanEntries);

    const newSst = new SSTable(sstPath, nextLevel);
    await newSst.load();

    // Add to next level
    if (!this.sstables[nextLevel]) this.sstables[nextLevel] = [];
    this.sstables[nextLevel].push(newSst);

    // Remove old SSTables
    for (const sst of toMerge) {
      await fs.unlink(sst.filePath).catch(() => {});
    }
    this.sstables[level] = this.sstables[level].filter(s => !toMerge.includes(s));

    this.stats.compactions++;
    logger.info(`[LSM-Tree] Compaction done: ${cleanEntries.length} entries → L${nextLevel}`);
  }

  // ── WAL (Write-Ahead Log) ────────────────────────────────

  async _writeWAL(key, value, op) {
    const line = JSON.stringify({ op, key, value, ts: Date.now() }) + '\n';
    await fs.appendFile(this._walPath, line, 'utf8').catch(() => {});
  }

  async _clearWAL() {
    await fs.writeFile(this._walPath, '', 'utf8').catch(() => {});
  }

  async _recoverFromWAL() {
    if (!existsSync(this._walPath)) return;

    try {
      const content = await fs.readFile(this._walPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      let recovered = 0;

      for (const line of lines) {
        try {
          const { op, key, value } = JSON.parse(line);
          if (op === 'PUT') {
            this.memTable.insert(key, value);
            recovered++;
          } else if (op === 'DELETE') {
            this.memTable.delete(key);
          }
        } catch { /* skip corrupt line */ }
      }

      if (recovered > 0) {
        logger.info(`[LSM-Tree] Recovered ${recovered} entries from WAL`);
      }
    } catch {
      // WAL read failed — start fresh
    }
  }

  async _loadExistingSSTables() {
    if (!existsSync(this.dataDir)) return;

    const files = await fs.readdir(this.dataDir);
    for (const file of files) {
      if (!file.endsWith('.sst')) continue;

      const levelMatch = file.match(/^L(\d+)_/);
      if (!levelMatch) continue;

      const level = parseInt(levelMatch[1], 10);
      if (level >= this.sstables.length) continue;

      const filePath = path.join(this.dataDir, file);
      const sst = new SSTable(filePath, level);
      await sst.load();
      this.sstables[level].push(sst);
    }

    // Sort each level by creation time (oldest first)
    for (const levelTables of this.sstables) {
      levelTables.sort((a, b) => {
        const aTime = parseInt(a.filePath.match(/L\d+_(\d+)/)?.[1] || '0', 10);
        const bTime = parseInt(b.filePath.match(/L\d+_(\d+)/)?.[1] || '0', 10);
        return aTime - bTime;
      });
    }
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats() {
    const sstCounts = this.sstables.map((level, i) => ({
      level: i,
      tables: level.length,
      entries: level.reduce((sum, s) => sum + s.size, 0),
    }));

    return {
      ...this.stats,
      memTableEntries: this.memTable.size,
      memTableBytes: this.memTable.byteSize,
      immutableCount: this.immutableMemTables.length,
      sstables: sstCounts.filter(s => s.tables > 0),
    };
  }
}

export { SkipList, SSTable };
