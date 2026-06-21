/**
 * Transactional Outbox Pattern — Tier 3
 *
 * Đảm bảo không mất message khi Discord/API bị lỗi.
 * Khi Agent tính toán xong, kết quả được lưu vào outbox cùng transaction.
 * Một worker chạy ngầm quét outbox và gửi retry cho đến khi thành công.
 *
 * Schema:
 *   id          — INTEGER PK
 *   channel     — 'discord' | 'webhook' | 'api'
 *   payload     — JSON string (message content)
 *   status      — 'pending' | 'sent' | 'failed'
 *   retries     — số lần đã retry
 *   last_error  — error message lần cuối
 *   created_at  — timestamp
 *   sent_at     — timestamp khi gửi thành công
 *
 * ponytail: SQLite-based outbox, không dùng message queue.
 *   Đủ cho single-instance Cloud Run. Nếu scale multi-instance,
 *   cần chuyển sang Cloud Tasks hoặc Pub/Sub.
 */

import { open } from './sqlite_adapter.js';
import path from 'path';
import { info, warn, error } from './structured_logger.js';

const OUTBOX_DB = path.resolve('./outbox.db');

let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const db = await open({ filename: OUTBOX_DB, driver: null });
    await db.exec('PRAGMA journal_mode=WAL');
    await db.exec('PRAGMA synchronous=NORMAL');

    await db.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL DEFAULT 'discord',
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      retries INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    )`);

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status)`);

    return db;
  })();

  return _dbPromise;
}

/**
 * Thêm message vào outbox.
 * @param {string} channel — 'discord' | 'webhook' | 'api'
 * @param {object} payload — message data (sẽ được JSON.stringify)
 * @returns {number} id của bản ghi
 */
export async function enqueue(channel, payload) {
  const db = await getDb();
  const result = await db.run(
    'INSERT INTO outbox (channel, payload) VALUES (?, ?)',
    channel,
    JSON.stringify(payload)
  );
  info('Outbox', 'message enqueued', { id: result.lastID, channel });
  return result.lastID;
}

/**
 * Lấy các message pending (theo thứ tự FIFO).
 * @param {number} limit — số lượng tối đa
 * @returns {Array} danh sách { id, channel, payload, retries }
 */
export async function getPending(limit = 20) {
  const db = await getDb();
  const rows = db.prepare(
    'SELECT id, channel, payload, retries FROM outbox WHERE status = ? ORDER BY id ASC LIMIT ?'
  ).all('pending', limit);
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

/**
 * Đánh dấu message đã gửi thành công.
 */
export async function markSent(id) {
  const db = await getDb();
  await db.run(
    'UPDATE outbox SET status = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?',
    'sent',
    id
  );
  info('Outbox', 'message sent', { id });
}

/**
 * Đánh dấu message thất bại, tăng retry count.
 * Nếu retries >= 5, đánh dấu 'failed' (không retry nữa).
 */
export async function markFailed(id, err) {
  const db = await getDb();
  const msg = db.prepare('SELECT retries FROM outbox WHERE id = ?').get(id);
  const retries = (msg?.retries || 0) + 1;
  const status = retries >= 5 ? 'failed' : 'pending';

  await db.run(
    'UPDATE outbox SET retries = ?, last_error = ?, status = ? WHERE id = ?',
    retries,
    err?.message || String(err),
    status,
    id
  );

  if (status === 'failed') {
    error('Outbox', 'message permanently failed', { id, retries, error: err?.message });
  } else {
    warn('Outbox', 'message retry scheduled', { id, retries });
  }
}

/**
 * Lấy thống kê outbox.
 */
export async function getStats() {
  const db = await getDb();
  const rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM outbox GROUP BY status'
  ).all();
  const stats = { pending: 0, sent: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.count;
  return stats;
}

/**
 * Dọn dẹp message đã sent quá 24h.
 */
export async function cleanup() {
  const db = await getDb();
  const result = await db.run(
    "DELETE FROM outbox WHERE status = 'sent' AND sent_at < datetime('now', '-1 day')"
  );
  if (result.changes > 0) {
    info('Outbox', 'cleaned up sent messages', { deleted: result.changes });
  }
  return result.changes;
}
