/**
 * lib/sqlite_adapter.js — SQLite adapter with dual backend
 * Tries node:sqlite first (Node 22.5+), falls back to better-sqlite3 (Node 20+).
 *
 * Jest ESM fix: globalThis guard prevents re-declaration when module
 * is loaded multiple times by Jest workers.
 */

// Use globalThis to survive Jest ESM module re-loading
if (!globalThis.__sqlite_adapter) {
  globalThis.__sqlite_adapter = {
    _initialized: false,
    DatabaseSync: null,
    DatabaseBetter: null,
    _db: null,
  };
}
const _state = globalThis.__sqlite_adapter;

async function _ensureInit() {
  if (_state._initialized) return;
  // Do NOT set _initialized until imports are done — prevents race condition
  // where a second call sees _initialized=true but imports haven't resolved yet.
  try {
    _state.DatabaseSync = (await import('node:sqlite')).DatabaseSync;
  } catch { /* node:sqlite not available */ }
  try {
    _state.DatabaseBetter = (await import('better-sqlite3')).default;
  } catch { /* better-sqlite3 not installed */ }
  _state._initialized = true;
}

// ponytail: global singleton DB — if multiple DB paths needed, use openDbFile() instead
async function _getDb(dbPath) {
  await _ensureInit();
  if (_state._db) return _state._db;
  dbPath = dbPath || process.env.DB_PATH || './data.db';
  if (_state.DatabaseSync) {
    try {
      const rawDb = new _state.DatabaseSync(dbPath);
      // Check what methods actually exist (varies by Node version)
      const hasPrepare = typeof rawDb.prepare === 'function';
      const hasRun = typeof rawDb.run === 'function';
      const hasGet = typeof rawDb.get === 'function';
      const hasAll = typeof rawDb.all === 'function';
      const hasExec = typeof rawDb.exec === 'function';

      if (!hasPrepare && !hasRun) {
        // No usable methods — this is a broken/unknown version
        throw new Error('node:sqlite DatabaseSync has no prepare() or run() method');
      }

      // Build a normalized DB object
      _state._db = rawDb;

      // Patch missing methods using what IS available
      if (hasPrepare && !hasRun) {
        rawDb.run = (sql, ...p) => rawDb.prepare(sql).run(...p.flat());
      }
      if (hasPrepare && !hasGet) {
        rawDb.get = (sql, ...p) => rawDb.prepare(sql).get(...p.flat());
      }
      if (hasPrepare && !hasAll) {
        rawDb.all = (sql, ...p) => rawDb.prepare(sql).all(...p.flat());
      }
      if (hasPrepare && !hasExec) {
        rawDb.exec = (sql) => { rawDb.prepare(sql).run(); return rawDb; };
      }
      if (hasRun && !hasPrepare) {
        // Older API: only has run/get/all, no prepare
        rawDb.prepare = (sql) => {
          const stmt = { run: (...p) => rawDb.run(sql, ...p), get: (...p) => rawDb.get(sql, ...p), all: (...p) => rawDb.all(sql, ...p) };
          return stmt;
        };
      }

      // WAL mode + busy timeout
      if (typeof rawDb.exec === 'function') {
        rawDb.exec('PRAGMA journal_mode = WAL');
        rawDb.exec('PRAGMA busy_timeout = 5000');
      } else if (typeof rawDb.prepare === 'function') {
        rawDb.prepare('PRAGMA journal_mode = WAL').run();
        rawDb.prepare('PRAGMA busy_timeout = 5000').run();
      }
    } catch (syncErr) {
      // node:sqlite failed — fallback to better-sqlite3
      console.warn('[sqlite_adapter] node:sqlite failed:', syncErr.message);
      _state.DatabaseSync = null;
    }
  }
  if (!_state._db && _state.DatabaseBetter) {
    _state._db = new _state.DatabaseBetter(dbPath);
    _state._db.pragma('journal_mode = WAL');
    _state._db.pragma('busy_timeout = 5000');
  }
  if (!_state._db) {
    // Final fallback: try import better-sqlite3
    try {
      const { default: Database } = await import('better-sqlite3');
      _state._db = new Database(dbPath);
      _state._db.pragma('journal_mode = WAL');
      _state._db.pragma('busy_timeout = 5000');
    } catch {
      throw new Error('No SQLite backend available — run: npm i better-sqlite3');
    }
  }
  // Safety check: ensure db has prepare() method
  if (!_state._db || !_state._db.prepare) {
    throw new Error('SQLite DB missing prepare() method — better-sqlite3 not installed or version mismatch');
  }
  return _state._db;
}

function _runDb(db, sql, ...params) {
  // node:sqlite (DatabaseSync) — always has .prepare()
  if (db.prepare) return db.prepare(sql).run(...params.flat());
  // better-sqlite3 fallback
  if (db.run) return db.run(sql, ...params);
  throw new Error('DB has no run or prepare method');
}

function _getDbRow(db, sql, ...params) {
  if (db.prepare) return db.prepare(sql).get(...params);
  return db.get(sql, params);
}

function _getAllDbRows(db, sql, ...params) {
  if (db.prepare) return db.prepare(sql).all(...params);
  return db.all(sql, params);
}

function _closeDb() {
  if (_state._db) {
    try { _state._db.close(); } catch { /* ignore */ }
    _state._db = null;
  }
}

async function _openDbFile(dbPath) {
  await _ensureInit();
  let db;
  if (_state.DatabaseSync) {
    db = new _state.DatabaseSync(dbPath);
    // node:sqlite DatabaseSync has prepare() but NOT run/get/all directly
    db.run  = (sql, ...p) => db.prepare(sql).run(...p.flat());
    db.get  = (sql, ...p) => db.prepare(sql).get(...p.flat());
    db.all  = (sql, ...p) => db.prepare(sql).all(...p.flat());
    db.exec = (sql)       => { db.prepare(sql).run(); return db; };
  } else if (_state.DatabaseBetter) {
    db = new _state.DatabaseBetter(dbPath);
  } else {
    throw new Error('No SQLite backend available');
  }
  return db;
}

async function _openDb() { return _getDb(); }
async function _initDb() { await _ensureInit(); }

// ── Exports: use var to allow re-declaration in Jest ESM ──
export const getDb = _getDb;
export const runDb = _runDb;
export const getDbRow = _getDbRow;
export const getAllDbRows = _getAllDbRows;
export const openDb = _openDb;
export const closeDb = _closeDb;
export const openDbFile = _openDbFile;
export const initDb = _initDb;
export const open = _getDb;
