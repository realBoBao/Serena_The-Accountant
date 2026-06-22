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
    _state._db = new _state.DatabaseSync(dbPath);
    if (!_state._db.run) {
      _state._db.run  = (sql, ...p) => _state._db.prepare(sql).run(...p.flat());
      _state._db.get  = (sql, ...p) => _state._db.prepare(sql).get(...p.flat());
      _state._db.all  = (sql, ...p) => _state._db.prepare(sql).all(...p.flat());
      _state._db.exec = (sql)       => { _state._db.prepare(sql).run(); return _state._db; };
    }
  } else if (_state.DatabaseBetter) {
    _state._db = new _state.DatabaseBetter(dbPath);
  } else {
    throw new Error('No SQLite backend available');
  }
  return _state._db;
}

function _runDb(db, sql, ...params) {
  if (db.prepare) return db.prepare(sql).run(...params);
  return db.run(sql, params);
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
