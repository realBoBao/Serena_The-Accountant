/**
 * lib/persona_router.js — Persona Routing (Tier 1: AGI "giả mạo")
 *
 * Phân loại câu hỏi thành 2 persona:
 * - THERAPIST: Câu hỏi cảm xúc, tâm sự, stress, cô đơn → Skip RAG, chỉ dùng system prompt + memory
 * - TECHNICAL: Câu hỏi kỹ thuật, code, DevOps → Kích hoạt full RAG pipeline
 *
 * Nguyên tắc: Nếu không chắc chắn → mặc định TECHNICAL (để không bỏ sót kiến thức).
 * Chỉ khi confidence THERAPIST > 0.8 mới skip RAG.
 */

import { getLogger } from './logger.js';

const logger = getLogger('PersonaRouter');

// ── Persona Detection Rules ──────────────────────────────────────────────────
// Mỗi rule là một regex pattern. Nếu match → tăng confidence cho persona tương ứng.
// Patterns được thiết kế để match với cả tiếng Việt có dấu và không dấu.
const THERAPIST_PATTERNS = [
  // Cảm xúc tiêu cực — match chính xác từ khóa
  /\bmệt\b|\bstress\b|\blo lắng\b|\bbuồn\b|\bchán\b|\bnản\b|\báp lực\b/i,
  /\bdeadline\b|\bsập\b|\bcrash\b|\bburnout\b|\bkiệt sức\b|\bcô đơn\b/i,
  // Tâm sự — match từ khóa tâm sự
  /\btâm sự\b|\bkể nghe\b|\btrò chuyện\b|\bgiải tỏa\b|\bcảm xúc\b/i,
  /\btình cảm\b|\bhạnh phúc\b|\bvui\b|\bđau\b|\bmất ngủ\b|\bngủ không ngon\b/i,
  // Giao tiếp xã hội — match lời chào/hỏi đơn giản
  /\bchào\b|\bhi\b|\bhello\b|\bhey\b|\bcảm ơn\b|\bthank\b|\bxin lỗi\b/i,
  // Hỏi về bản thân bot
  /\bbạn là ai\b|\btên bạn\b|\bbạn tên gì\b|\bai tạo ra bạn\b|\bbạn biết gì\b/i,
  // Câu hỏi đơn giản không có từ kỹ thuật
  /\bbạn khỏe không\b|\bnhư thế nào\b|\bthế nào\b|\bgì vậy\b|\bsao\b/i,
  // Lắng nghe, tâm sự (không dùng \b vì tiếng Việt có dấu)
  /lắng nghe|tâm sự|kể chuyện|sự cố|chán ghét/i,
  // Mệt mỏi
  /\bmệt\b|\bmỏi\b|\bmệt mỏi\b|\bchán ghét\b|\bbực bội\b/i,
];

const TECHNICAL_PATTERNS = [
  // Code/Programming — match từ kỹ thuật
  /\bcode\b|\bviết\b|\bchạy\b|\bcompile\b|\bdebug\b|\bfunction\b|\bclass\b|\bmethod\b/i,
  /\bapi\b|\blibrary\b|\bframework\b|\bscript\b|\bmodule\b|\bpackage\b/i,
  // DevOps/Infrastructure
  /\bdocker\b|\bkubernetes\b|\bk8s\b|\bdeploy\b|\bci\/cd\b|\bpipeline\b|\bserver\b/i,
  /\bdatabase\b|\bsql\b|\bnosql\b|\bredis\b|\bmongodb\b|\bpostgres\b/i,
  // System design
  /\barchitecture\b|\bmicroservices\b|\bmonolith\b|\bscalab\b|\bperformance\b|\bcache\b/i,
  // Algorithms
  /\balgorithm\b|\bthuật toán\b|\bsort\b|\bsearch\b|\btree\b|\bgraph\b|\bhash\b/i,
  // Networking
  /\bhttp\b|\btcp\b|\budp\b|\bdns\b|\bssl\b|\btls\b|\bwebsocket\b|\brest\b/i,
  // Tools
  /\bgit\b|\bgithub\b|\bvscode\b|\blinux\b|\bterminal\b|\bbash\b|\bnginx\b/i,
];

// ── Confidence Thresholds ─────────────────────────────────────────────────────
const THERAPIST_THRESHOLD = 0.4;  // Chỉ skip RAG khi confidence > 0.4 (lenient)
const TECHNICAL_THRESHOLD = 0.5; // Kích hoạt RAG khi confidence > 0.5

/**
 * Phân loại persona của câu hỏi
 * @param {string} text — User input
 * @returns {{ persona: 'THERAPIST'|'TECHNICAL', confidence: number, reason: string }}
 */
export function detectPersona(text) {
  if (!text || typeof text !== 'string') {
    return { persona: 'TECHNICAL', confidence: 0, reason: 'empty_input' };
  }

  const lowerText = text.toLowerCase().trim();

  // Đếm số pattern match cho mỗi persona
  let therapistScore = 0;
  let technicalScore = 0;

  for (const pattern of THERAPIST_PATTERNS) {
    if (pattern.test(lowerText)) therapistScore++;
  }

  for (const pattern of TECHNICAL_PATTERNS) {
    if (pattern.test(lowerText)) technicalScore++;
  }

  // Tính confidence (0-1) dựa trên số pattern match
  // Weight: therapist patterns quan trọng hơn (cần ít match hơn để trigger)
  const therapistConfidence = Math.min(therapistScore / 2, 1);  // 2 match = 100%
  const technicalConfidence = Math.min(technicalScore / 3, 1);  // 3 match = 100%

  // Quyết định persona
  if (therapistConfidence > THERAPIST_THRESHOLD && therapistConfidence > technicalConfidence) {
    logger.info(`[PersonaRouter] THERAPIST (${therapistConfidence.toFixed(2)}): "${lowerText.slice(0, 50)}..."`);
    return {
      persona: 'THERAPIST',
      confidence: therapistConfidence,
      reason: `matched ${therapistScore} therapist patterns`,
    };
  }

  if (technicalConfidence > TECHNICAL_THRESHOLD) {
    logger.info(`[PersonaRouter] TECHNICAL (${technicalConfidence.toFixed(2)}): "${lowerText.slice(0, 50)}..."`);
    return {
      persona: 'TECHNICAL',
      confidence: technicalConfidence,
      reason: `matched ${technicalScore} technical patterns`,
    };
  }

  // Default: TECHNICAL (để không bỏ sót kiến thức)
  logger.debug(`[PersonaRouter] DEFAULT → TECHNICAL: "${lowerText.slice(0, 50)}..."`);
  return {
    persona: 'TECHNICAL',
    confidence: 0.5,
    reason: 'default_to_technical',
  };
}

/**
 * Kiểm tra xem có nên skip RAG pipeline không
 * @param {string} text — User input
 * @returns {boolean} true = skip RAG (chỉ dùng system prompt + memory)
 */
export function shouldSkipRag(text) {
  const { persona, confidence } = detectPersona(text);
  return persona === 'THERAPIST' && confidence > THERAPIST_THRESHOLD;
}

/**
 * Lấy system prompt cho persona
 * @param {'THERAPIST'|'TECHNICAL'} persona
 * @returns {string} System prompt phù hợp
 */
export function getPersonaSystemPrompt(persona) {
  if (persona === 'THERAPIST') {
    return `Bạn là một người bạn thấu cảm, luôn lắng nghe và không phán xét.
Nhiệm vụ: Lắng nghe, đồng cảm, đưa ra lời khuyên nhẹ nhàng.
Quy tắc:
- KHÔNG tìm kiếm tài liệu, KHÔNG dùng RAG
- Chỉ dùng kiến thức trong system prompt và ngữ cảnh cuộc trò chuyện
- Trả lời ngắn gọn, ấm áp, khuyến khích người dùng
- Nếu hỏi chuyên quá → hướng dẫn hỏi câu hỏi cụ thể hơn`;
  }

  return `Bạn là chuyên gia kỹ thuật, luôn tìm kiếm thông tin chính xác.
Nhiệm vụ: Phân tích, giải thích, đưa ra giải pháp chi tiết.
Quy tắc:
- LUÔN kích hoạt RAG pipeline để tìm kiếm tài liệu liên quan
- Trả lời chi tiết, có code ví dụ khi cần
- Trích dẫn nguồn khi có thể`;
}
