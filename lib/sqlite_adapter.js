/**
 * lib/sqlite_adapter.js — SQLite adapter with dual backend
 * Tries node:sqlite first (Node 22.5+), falls back to better-sqlite3 (Node 20+).
 */
let DatabaseSync = null;
let DatabaseBetter = null;

try {
  DatabaseSync = (await import('node:sqlite')).DatabaseSync;
} catch {
  // node:sqlite not available (Node < 22.5)
}

try {
  DatabaseBetter = (await import('better-sqlite3')).default;
} catch {
  // better-sqlite3 not installed
}

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dbPath = process.env.DB_PATH || './data.db';
  if (DatabaseSync) {
    _db = new DatabaseSync(dbPath);
  } else if (DatabaseBetter) {
    _db = new DatabaseBetter(dbPath);
  } else {
    throw new Error('No SQLite backend available');
  }
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

/**
 * Open a separate SQLite database file.
 * Used by memory_decay.js and other modules that need isolated DBs.
 */
export function openDbFile(dbPath) {
  if (DatabaseSync) return new DatabaseSync(dbPath);
  if (DatabaseBetter) return new DatabaseBetter(dbPath);
  throw new Error('No SQLite backend available');
}
