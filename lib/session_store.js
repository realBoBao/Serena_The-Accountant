/**
 * SessionStore — In-memory session state management (Redis optional).
 *
 * Mỗi session lưu trữ:
 *   - originalRequest:  Yêu cầu gốc từ user
 *   - dag:              Mảng task DAG (từ PlannerAgent.createPlan)
 *   - currentStep:     Step đang thực thi
 *   - status:          'planning' | 'running' | 'waiting_for_worker' | 'completed' | 'failed'
 *   - results:         Map<step, result> — kết quả trả về từ mỗi worker
 *   - history:         Mảng OODA loop iterations (audit trail)
 *   - createdAt / updatedAt
 *
 * Key format:   session:<sessionId>
 * TTL:          1 giờ (có thể extend khi active)
 */

const SESSION_TTL = 3600;
const KEY_PREFIX = 'session:';

// In-memory store (replaces Redis)
const _store = new Map();

function _serialize(session) { return JSON.stringify(session); }
function _deserialize(raw) { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }

// ─── CRUD ───────────────────────────────────────────────────

/**
 * Tạo session mới.
 * @param {string} sessionId
 * @param {Object} originalRequest  — Yêu cầu gốc
 * @returns {Object} Session object
 */
export async function createSession(sessionId, originalRequest) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('Invalid session ID');
  const now = Date.now();
  const session = { id: sessionId, originalRequest, dag: [], currentStep: null, status: 'planning', results: {}, history: [], createdAt: now, updatedAt: now };
  _store.set(`${KEY_PREFIX}${sessionId}`, _serialize(session));
  return session;
}

export async function getSession(sessionId) {
  return _deserialize(_store.get(`${KEY_PREFIX}${sessionId}`));
}

export async function updateSession(sessionId, updates) {
  const key = `${KEY_PREFIX}${sessionId}`;
  const session = _deserialize(_store.get(key));
  if (!session) return null;
  Object.assign(session, updates, { updatedAt: Date.now() });
  _store.set(key, _serialize(session));
  return session;
}

export async function deleteSession(sessionId) {
  _store.delete(`${KEY_PREFIX}${sessionId}`);
}

/**
 * Lưu kết quả của một step.
 * @param {string} sessionId
 * @param {number} step
 * @param {*} result
 * @returns {Object|null}
 */
export async function saveStepResult(sessionId, step, result) {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.results[step] = result;
  session.updatedAt = Date.now();
  _store.set(`${KEY_PREFIX}${sessionId}`, _serialize(session));
  return session;
}

/**
 * Thêm OODA iteration vào history.
 * @param {string} sessionId
 * @param {Object} iteration  — { observe, orient, decide, act, timestamp }
 * @returns {Object|null}
 */
export async function addHistoryEntry(sessionId, iteration) {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.history.push({ ...iteration, timestamp: Date.now() });
  session.updatedAt = Date.now();
  _store.set(`${KEY_PREFIX}${sessionId}`, _serialize(session));
  return session;
}

export async function listSessions() {
  return [..._store.values()].map(_deserialize).filter(Boolean);
}

export async function closeSessionStore() {
  _store.clear();
}

export default {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  saveStepResult,
  addHistoryEntry,
  listSessions,
  closeSessionStore,
};
