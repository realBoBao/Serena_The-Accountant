/**
 * db.js — Simple key-value database (stub)
 *
 * Lưu trữ processed items để tránh duplicate processing.
 * Sẽ được thay thế bằng SQLite trong phiên bản hoàn chỉnh.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const DB_FILE = path.resolve('./data/processed.json');

// In-memory cache
let _cache = null;

function loadDb() {
  if (_cache) return _cache;
  try {
    if (existsSync(DB_FILE)) {
      _cache = JSON.parse(readFileSync(DB_FILE, 'utf8'));
    } else {
      _cache = {};
    }
  } catch {
    _cache = {};
  }
  return _cache;
}

function saveDb(db) {
  _cache = db;
  try {
    writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }
}

export { loadDb, saveDb };

export function isProcessed(id) {
  const db = loadDb();
  return !!db[id];
}

export function markProcessed(id, meta = {}) {
  const db = loadDb();
  db[id] = { processedAt: new Date().toISOString(), ...meta };
  saveDb(db);
}

export function getProcessed(id) {
  const db = loadDb();
  return db[id] || null;
}

export function getAllProcessed() {
  return loadDb();
}
