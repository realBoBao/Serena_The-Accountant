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

// ── Wrapper methods cho compatibility với better-sqlite3 API ───────────────
// node:sqlite dùng db.prepare().run/get/all, better-sqlite3 dùng db.run/get/all

export function runDb(db, sql, ...params) {
  if (db.prepare) {
    // node:sqlite
    return db.prepare(sql).run(...params);
  }
  // better-sqlite3
  return db.run(sql, params);
}

export function getDbRow(db, sql, ...params) {
  if (db.prepare) {
    return db.prepare(sql).get(...params);
  }
  return db.get(sql, params);
}

export function getAllDbRows(db, sql, ...params) {
  if (db.prepare) {
    return db.prepare(sql).all(...params);
  }
  return db.all(sql, params);
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
