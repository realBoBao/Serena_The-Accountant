/**
 * lib/sqlite_adapter.js — SQLite adapter using node:sqlite (built-in)
 * Works with ESM on Node 20+ without native dependencies.
 */
import { DatabaseSync } from 'node:sqlite';

let _db = null;

export async function getDb() {
  if (_db) return _db;
  const dbPath = process.env.DB_PATH || './data.db';
  _db = new DatabaseSync(dbPath);
  return _db;
}

export function openDb() { return getDb(); }
export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}
export { getDb as open };
