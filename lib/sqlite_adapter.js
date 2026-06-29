/**
 * lib/sqlite_adapter.js - SQLite adapter (backward compatibility)
 *
 * TIER 1: Now delegates to lib/db.js singleton.
 * This file kept for backward compatibility - new code should import from db.js.
 *
 * @module lib/sqlite_adapter
 */

import { getDb, runQuery, getOne, getAll, closeDb, getDbPath, transaction } from './db.js';

// Re-export everything from db.js singleton
export { getDb, closeDb, getDbPath, transaction };

// runDb backward compatible: hỗ cả 2 signature:
//   runDb(sql, params)     — new style
//   runDb(db, sql, params)  — old style (db param ignored)
export async function runDb(...args) {
  let sql, params;
  if (args.length >= 2 && typeof args[0] !== 'string') {
    // Old style: runDb(db, sql, ...params)
    [, sql, ...params] = args;
  } else {
    // New style: runDb(sql, ...params)
    [sql, ...params] = args;
  }
  return runQuery(sql, params);
}

// getDbRow backward compatible: hỗ cả 2 signature
export async function getDbRow(...args) {
  let sql, params;
  if (args.length >= 2 && typeof args[0] !== 'string') {
    [, sql, ...params] = args;
  } else {
    [sql, ...params] = args;
  }
  return getOne(sql, params);
}

// getAllDbRows backward compatible
export async function getAllDbRows(...args) {
  let sql, params;
  if (args.length >= 2 && typeof args[0] !== 'string') {
    [, sql, ...params] = args;
  } else {
    [sql, ...params] = args;
  }
  return getAll(sql, params);
}

// Legacy aliases for backward compatibility (need local binding)
export const openDb = getDb;
export const initDb = async () => { await getDb(); };
export const openDbFile = getDb;
export const open = getDb;

export default { getDb, runDb: runQuery, getDbRow: getOne, getAllDbRows: getAll, closeDb, getDbPath, transaction, openDb, initDb, openDbFile, open };
