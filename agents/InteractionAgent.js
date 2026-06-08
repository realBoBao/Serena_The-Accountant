/**
 * ═══════════════════════════════════════════════════════════════════════════
 * InteractionAgent — Lễ tân & Khởi tạo Phiên (Session Init Gateway)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nhiệm vụ:
 *   1. Nhận tin nhắn từ mọi nguồn (Discord, REST API, Dashboard, Webhook)
 *   2. Khởi tạo một Session_ID duy nhất (UUID v4)
 *   3. Lưu trạng thái ban đầu (input người dùng) vào Redis Hash
 *      key: session:<session_id>:state
 *   4. Bắn một Job khởi tạo vào queue:planner kèm Session_ID
 *
 * Luồng:
 *   Input → InteractionAgent.receive() → Session_ID
 *     → Redis HSET session:<id>:state { source, userId, content, ... }
 *     → BullMQ addJob('planner-tasks', 'init_session', { sessionId, ... })
 *
 * @author my-ai-brain
 * @since 2026-06-03
 */

import crypto from 'crypto';

const SESSION_TTL = 3600;
const MAX_CONTENT_LENGTH = 4000;
const VALID_SOURCES = new Set(['discord', 'rest_api', 'dashboard', 'webhook']);

// ── Storage: in-memory (Redis optional via env) ────────────────────────────

const _memStore = new Map();

let _redis = null;

function getRedis() {
  // Redis disabled by default — set USE_REDIS=1 to enable
  if (process.env.USE_REDIS === '1' && !_redis) {
    try {
      const Redis = require('ioredis');
      _redis = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        lazyConnect: true,
      });
    } catch { /* Redis not available */ }
  }
  return _redis;
}

// ── ESM lazy imports ───────────────────────────────────────────────────────

let _tq = null, _ss = null;
async function tq() { if (!_tq) _tq = await import('../lib/task_queue.js'); return _tq; }
async function ss() { if (!_ss) _ss = await import('../lib/session_store.js'); return _ss; }

// ═══════════════════════════════════════════════════════════════════════════
// InteractionAgent Class
// ═══════════════════════════════════════════════════════════════════════════

export class InteractionAgent {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this._stats = { totalReceived: 0, totalSessionsCreated: 0, totalJobsDispatched: 0, totalErrors: 0, bySource: {} };
  }

  static generateSessionId() { return crypto.randomUUID(); }

  // ── Redis state ─────────────────────────────────────────────────────────

  async _saveState(sessionId, state) {
    const key = `session:${sessionId}:state`;
    const data = {
      session_id: sessionId, source: state.source, user_id: state.userId,
      username: state.username, channel_id: state.channelId,
      content: (state.content || '').slice(0, MAX_CONTENT_LENGTH),
      content_length: String(state.contentLength ?? (state.content || '').length),
      attachment_count: String(state.attachmentCount ?? 0),
      has_image: state.hasImage ? '1' : '0', has_audio: state.hasAudio ? '1' : '0',
      is_admin: state.isAdmin ? '1' : '0', message_id: state.messageId || '',
      created_at: new Date().toISOString(), status: 'pending',
    };
    const r = getRedis();
    if (r) {
      try {
        const p = r.pipeline(); p.hset(key, data); p.expire(key, SESSION_TTL);
        const res = await p.exec();
        if (res?.every(x => x[0] === null)) return true;
      } catch { /* fallback to memory */ }
    }
    // In-memory fallback
    _memStore.set(key, { ...data, _ts: Date.now() });
    return true;
  }

  async updateStatus(sessionId, status, extra = {}) {
    const key = `session:${sessionId}:state`;
    const r = getRedis();
    if (r) { try { await r.hset(key, { status, updated_at: new Date().toISOString(), ...extra }); return; } catch {} }
    // In-memory fallback
    const cur = _memStore.get(key);
    if (cur) _memStore.set(key, { ...cur, status, updated_at: new Date().toISOString(), ...extra });
  }

  async getState(sessionId) {
    const key = `session:${sessionId}:state`;
    const r = getRedis();
    if (r) { try { const d = await r.hgetall(key); if (d && Object.keys(d).length > 0) return d; } catch {} }
    // In-memory fallback
    const d = _memStore.get(key);
    return d ? (({ _ts, ...rest }) => rest)(d) : null;
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  async _dispatch(sessionId, state) {
    try {
      const m = await tq();
      const job = await m.addJob(m.QueueName.PLANNER, 'init_session', {
        session_id: sessionId, source: state.source, user_id: state.userId,
        username: state.username, channel_id: state.channelId,
        content: (state.content || '').slice(0, MAX_CONTENT_LENGTH),
        content_length: state.contentLength ?? (state.content || '').length,
        attachment_count: state.attachmentCount ?? 0, has_image: !!state.hasImage,
        has_audio: !!state.hasAudio, is_admin: !!state.isAdmin,
        message_id: state.messageId || null, created_at: new Date().toISOString(),
      }, { priority: state.isAdmin ? 1 : 5, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
      return { jobId: job.id };
    } catch (err) { this.logger?.error?.(`[IA] Dispatch: ${err.message}`); return null; }
  }

  // ── Core: receive() ─────────────────────────────────────────────────────

  async receive(input) {
    this._stats.totalReceived++;
    const source = input?.source;
    if (!source || !VALID_SOURCES.has(source)) { this._stats.totalErrors++; return { sessionId: null, jobId: null, state: null, error: `Invalid source: ${source}`, statusCode: 400 }; }

    const content = (input?.content || '').trim();
    if (!content && !input?.attachmentCount) { this._stats.totalErrors++; return { sessionId: null, jobId: null, state: null, error: 'Empty input', statusCode: 400 }; }

    const sessionId = InteractionAgent.generateSessionId();
    const state = { source, userId: String(input?.userId || 'anonymous'), username: String(input?.username || 'unknown'), channelId: String(input?.channelId || 'unknown'), content, contentLength: content.length, attachmentCount: input?.attachmentCount ?? 0, hasImage: !!input?.hasImage, hasAudio: !!input?.hasAudio, isAdmin: !!input?.isAdmin, messageId: input?.messageId || null };

    if (!await this._saveState(sessionId, state)) { this._stats.totalErrors++; return { sessionId, jobId: null, state, error: 'Redis save failed', statusCode: 503 }; }

    this._stats.totalSessionsCreated++;
    this._stats.bySource[source] = (this._stats.bySource[source] || 0) + 1;

    try { const s = await ss(); if (s?.createSession) await s.createSession(sessionId, { type: source, content, context: JSON.stringify(state) }); } catch {}

    const job = await this._dispatch(sessionId, state);
    if (job) { this._stats.totalJobsDispatched++; try { const s = await ss(); if (s?.updateSession) await s.updateSession(sessionId, { status: 'planning' }); } catch {} }

    this.logger?.info?.(`[IA] ✓ ${sessionId} src=${source} usr=${state.username} job=${job?.jobId ?? 'FAIL'}`);
    return { sessionId, jobId: job?.jobId ?? null, state, error: job ? null : 'Dispatch failed', statusCode: job ? 200 : 503 };
  }

  // ── Convenience ─────────────────────────────────────────────────────────

  async receiveFromDiscord(msg) {
    if (!msg) return { sessionId: null, jobId: null, state: null, error: 'Null', statusCode: 400 };
    if (msg.author?.bot) return { sessionId: null, jobId: null, state: null, error: null, statusCode: 204 };
    let att = msg.attachments; if (att?.values) att = [...att.values()]; att = att || [];
    return this.receive({ source: 'discord', userId: msg.author?.id || 'unknown', username: msg.author?.username || 'unknown', channelId: msg.channelId || 'unknown', content: msg.content || '', messageId: msg.id || null, isAdmin: false, hasImage: att.some(a => (a.contentType || '').startsWith('image/')), hasAudio: att.some(a => (a.contentType || '').startsWith('audio/')), attachmentCount: att.length });
  }

  async receiveFromRestApi(body = {}) {
    return this.receive({ source: 'rest_api', userId: body.userId || 'api', username: body.username || 'api', channelId: body.endpoint || 'rest_api', content: body.message || body.content || '', isAdmin: true, attachmentCount: body.attachments?.length ?? 0 });
  }

  async receiveFromDashboard(session = {}, body = {}) {
    return this.receive({ source: 'dashboard', userId: session.userId || 'admin', username: session.username || 'admin', channelId: 'admin_dashboard', content: body.message || body.content || '', isAdmin: true });
  }

  async receiveFromWebhook(body = {}) {
    return this.receive({ source: 'webhook', userId: body.source || 'webhook', username: body.source || 'webhook', channelId: body.endpoint || 'webhook', content: body.message || body.content || JSON.stringify(body).slice(0, MAX_CONTENT_LENGTH), isAdmin: true });
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  getStats() { return { ...this._stats }; }
  health() { return { status: 'healthy', redis: _redis?.status || 'not_connected', stats: this._stats }; }
  destroy() { if (_redis) { _redis.disconnect(); _redis = null; } }
}

export default InteractionAgent;

// ── Named export for RouterAgent dispatch ──
export async function handleInteraction(topic) {
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return { message: '❌ Chủ đề không hợp lệ.' };
  }

  const normalizedTopic = topic.trim();

  // 1. Lưu vào Markov engine (persist interest)
  try {
    const { recordInteraction } = await import('../lib/markov_engine.js');
    await recordInteraction(normalizedTopic);
  } catch (err) {
    console.warn('[InteractionAgent] Markov record failed:', err?.message || err);
  }

  // 2. Lưu vào user_state.json (persist user preferences)
  try {
    const { readJson, writeJson } = await import('../lib/json_store.js');
    const statePath = './user_state.json';
    const state = await readJson(statePath, { interests: [], interestCounts: {} });
    if (!state.interests) state.interests = [];
    if (!state.interestCounts) state.interestCounts = {};

    // Thêm vào danh sách interests (unique, max 50)
    if (!state.interests.includes(normalizedTopic)) {
      state.interests.unshift(normalizedTopic);
      if (state.interests.length > 50) state.interests.pop();
    }

    // Tăng count
    state.interestCounts[normalizedTopic] = (state.interestCounts[normalizedTopic] || 0) + 1;

    await writeJson(statePath, state);
  } catch (err) {
    console.warn('[InteractionAgent] User state save failed:', err?.message || err);
  }

  return { message: `✅ Đã ghi nhận bạn quan tâm đến: **${normalizedTopic}**\n📊 Hệ thống sẽ ưu tiên tìm kiếm nội dung liên quan đến chủ đề này.` };
}
