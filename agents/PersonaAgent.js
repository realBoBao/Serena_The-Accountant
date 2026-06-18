/**
 * agents/PersonaAgent.js — Lightweight Persona Agent (Tier 1)
 *
 * Xử lý câu hỏi cảm xúc, tâm sự, casual chat mà KHÔNG cần RAG pipeline.
 * Tiết kiệm token + chi phí API cho các câu hỏi không cần tìm kiếm tài liệu.
 *
 * Nguyên tắc:
 * - Chỉ dùng system prompt + conversation history (short-term memory)
 * - KHÔNG gọi Vector DB, KHÔNG gọi LLM nặng
 * - Trả lời nhanh, ấm áp, khuyến khích
 */

import { getLogger } from '../lib/logger.js';
import { getPersonaSystemPrompt } from '../lib/persona_router.js';

const logger = getLogger('PersonaAgent');

// ── Short-term Memory (session-based) ────────────────────────────────────────
// Lưu 10 tin nhắn gần nhất để có context mà không cần DB
const _sessionMemory = new Map(); // userId -> [{ role, content, ts }]

function _getSession(userId) {
  if (!_sessionMemory.has(userId)) {
    _sessionMemory.set(userId, []);
  }
  return _sessionMemory.get(userId);
}

function _addToSession(userId, role, content) {
  const session = _getSession(userId);
  session.push({ role, content, ts: Date.now() });
  // Giữ tối đa 10 tin nhắn gần nhất
  if (session.length > 10) {
    session.shift();
  }
}

/**
 * Xử lý câu hỏi persona (therapist/casual)
 * @param {object} context — { query, userId, options }
 * @returns {Promise<object>} — { answer, agent, cached }
 */
export async function answerQuestion(context = {}) {
  const { query, userId = 'anonymous' } = context;

  if (!query) {
    return { answer: 'Bạn muốn trò chuyện về gì? Mình ở đây lắng nghe nè 😊', agent: 'persona' };
  }

  logger.info(`[PersonaAgent] Processing: "${query.slice(0, 50)}..." (user: ${userId})`);

  // Lấy system prompt cho persona
  const systemPrompt = getPersonaSystemPrompt('THERAPIST');

  // Lấy session history
  const session = _getSession(userId);

  // Thêm user message vào session
  _addToSession(userId, 'user', query);

  // Xây dựng response (rule-based + context-aware)
  const response = _generatePersonaResponse(query, session);

  // Thêm assistant response vào session
  _addToSession(userId, 'assistant', response);

  return {
    answer: response,
    agent: 'persona',
    cached: false,
    persona: 'THERAPIST',
  };
}

/**
 * Tạo response dựa trên pattern matching + session context
 * Đây là "AGI giả mạo" — không gọi LLM, dùng rule-based thông minh
 */
function _generatePersonaResponse(query, session) {
  const lowerQuery = query.toLowerCase();

  // ── Pattern: Chào hỏi ──
  if (/^(chào|hi|hello|hey|chào bạn|hi there)/i.test(lowerQuery)) {
    return `Chào bạn! 😊 Hôm nay bạn thế nào? Có gì muốn trò chuyện không?`;
  }

  // ── Pattern: Cảm xúc tiêu cực ──
  if (/mệt|stress|lo lắng|buồn|chán|nản|áp lực|deadline/i.test(lowerQuery)) {
    return `Mình hiểu cảm giác đó. Khi bạn thấy quá tải, hãy thử chia nhỏ vấn đề thành các bước nhỏ hơn nhé. Bạn đang phải đối mặt với điều gì? Kể mình nghe đi, đôi khi chỉ cần nói ra cũng nhẹ đầu rất nhiều 😊`;
  }

  // ── Pattern: Burnout ──
  if (/burnout|kiệt sức|muốn bỏ|chán nản|cô đơn/i.test(lowerQuery)) {
    return `Burnout là điều rất nhiều developer trải qua, và bạn không đơn độc đâu. Hãy thử nghỉ ngơi 1-2 ngày, làm điều gì đó không liên quan đến code. Nếu cần, mình có thể gợi ý vài cách thư giãn hoặc đề xuất chủ đề học mới để tạo động lực lại cho bạn! 💪`;
  }

  // ── Pattern: Cảm ơn ──
  if (/cảm ơn|thank|cám ơn/i.test(lowerQuery)) {
    return `Không có gì đâu! 😊 Rất vui được trò chuyện với bạn. Cần gì cứ hỏi mình nhé!`;
  }

  // ── Pattern: Hỏi về bản thân bot ──
  if (/bạn là ai|tên bạn|bạn tên gì|ai tạo ra bạn/i.test(lowerQuery)) {
    return `Mình là AI Brain — người bạn đồng hành học tập của bạn! Mình có thể giúp bạn học code, ôn bài, hoặc đơn giản là lắng nghe bạn tâm sự. Hôm nay bạn muốn làm gì? 🌟`;
  }

  // ── Pattern: Khuyến khích học ──
  if (/học|study|ôn|review|flashcard|quiz/i.test(lowerQuery)) {
    return `Bạn muốn học gì? Mình có thể gợi ý chủ đề, tạo flashcard, hoặc làm quiz cho bạn! Cứ nói mình nghe nhé 📚`;
  }

  // ── Pattern: Default (lắng nghe) ──
  // Kiểm tra session history để đưa ra response phù hợp
  const recentMessages = session.filter(m => m.role === 'user').slice(-3);
  if (recentMessages.length > 1) {
    return `Mình nghe đây. Bạn đang nói về "${recentMessages[recentMessages.length - 1].content.slice(0, 30)}..." đúng không? Kể thêm đi, mình không vội đâu 😊`;
  }

  return `Mình hiểu. Bạn đang cảm thấy thế nào? Kể mình nghe về ngày hôm nay của bạn đi — đôi khi chỉ cần trò chuyện cũng giúp nhẹ đầu rất nhiều! 💬`;
}

/**
 * Agent interface — onLoad
 */
export async function onLoad() {
  logger.info('[PersonaAgent] Loaded — lightweight persona agent (no RAG)');
}

/**
 * Agent interface — onMessage (alias for answerQuestion)
 */
export async function onMessage(context = {}) {
  return answerQuestion(context);
}

/**
 * Agent interface — onUnload
 */
export async function onUnload() {
  logger.info('[PersonaAgent] Unloaded');
}
