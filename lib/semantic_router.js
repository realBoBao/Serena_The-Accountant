/**
 * lib/semantic_router.js — Semantic Intent Routing via Cosine Similarity
 *
 * Thay thế keyword matching bằng vector similarity.
 * - Embed các câu mẫu của mỗi intent → cache vectors
 * - Khi có tin nhắn mới → embed → tính cosine similarity với từng intent
 * - Intent có điểm cao nhất (và > threshold) → route đến đó
 * - Fallback: keyword matching nếu similarity thấp
 *
 * Usage:
 *   import { classifyIntentSemantic } from './semantic_router.js';
 *   const intent = await classifyIntentSemantic(message.content);
 */

import { embedText } from './embeddings.js';
import { cosineSimilarity } from './embeddings.js';
import { getLogger } from './logger.js';

const logger = getLogger('SemanticRouter');

// ── Intent Examples — Các câu mẫu cho mỗi intent ──
const INTENT_EXAMPLES = {
  CODE: [
    'viết code Python tính giai thừa',
    'chạy code JavaScript sort mảng',
    'biên dịch C++ chương trình',
    'viết hàm tìm kiếm nhị phân',
    'code Java đọc file CSV',
    'thực thi script Python',
    'compile và chạy code',
    'viết thuật toán sắp xếp',
    'code C quản lý bộ nhớ',
    'chạy thử chương trình',
  ],
  RAG: [
    'tìm kiếm tài liệu về microservices',
    'hỏi về kiến trúc hệ thống',
    'giải thích về DevOps',
    'tìm bài viết về Docker',
    'có tài liệu nào về Kubernetes không',
    'tìm kiếm thông tin về backend',
    'hướng dẫn về CI/CD',
    'tìm paper về machine learning',
    'có bài nào về system design không',
    'tìm tài liệu học Python',
  ],
  DEBATE: [
    'tranh luận giải pháp A vs B',
    'so sánh thuật toán',
    'debate giữa các approach',
    'phân tích ưu nhược điểm',
    'đánh giá giải pháp',
    'so sánh performance',
    'tranh luận kỹ thuật',
  ],
  ANIMATE: [
    'tạo video animation',
    'vẽ đồ thị animation',
    'tạo video giải thích thuật toán',
    'animation minh họa',
    'trình chiếu video',
    'manim animation',
  ],
  VISION: [
    'phân tích ảnh',
    'nhìn ảnh này',
    'chụp màn hình lỗi',
    'phân tích hình ảnh',
    'xem ảnh code',
    'ảnh sơ đồ kiến trúc',
  ],
  MEMORY: [
    'lưu trí nhớ',
    'ghi nhớ điều này',
    'nhớ đi',
    'lưu lại thông tin',
    'thêm vào memory',
    'ghi chú',
  ],
  ANALYZE: [
    'phân tích GitHub repo',
    'phân tích video YouTube',
    'tổng hợp tài liệu',
    'phân tích URL',
    'tìm kiếm và phân tích',
  ],
  REVIEW: [
    'shadow review code',
    'ôn tập code',
    'bắt bẻ code',
    'chấm điểm code',
    'review code',
  ],
  INCIDENT: [
    'chaos engineering',
    'sự cố production',
    '3am alert',
    'incident simulator',
    'debug sự cố',
  ],
  SCHEDULE: [
    'thời khóa biểu',
    'lịch học',
    'lịch thi',
    'syllabus',
    'đồng bộ lịch',
  ],
};

// ── Cache ───────────────────────────────────────────────
let cachedVectors = null; // { intent: [vectors] }
let cacheReady = false;

/**
 * Khởi tạo cache vectors cho tất cả intent examples
 * Gọi 1 lần khi startup
 */
export async function initSemanticRouter() {
  if (cacheReady) return;

  logger.info('[SemanticRouter] Initializing intent vectors...');
  cachedVectors = {};

  for (const [intent, examples] of Object.entries(INTENT_EXAMPLES)) {
    const vectors = [];
    for (const text of examples) {
      try {
        const vec = await embedText(text);
        if (vec) vectors.push(vec);
      } catch (err) {
        logger.debug(`[SemanticRouter] Skip example for ${intent}: ${err.message}`);
      }
    }
    cachedVectors[intent] = vectors;
    logger.info(`[SemanticRouter] ${intent}: ${vectors.length} vectors cached`);
  }

  cacheReady = true;
  logger.info('[SemanticRouter] Ready ✅');
}

/**
 * Tính cosine similarity giữa 2 vectors
 */
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Phân loại intent bằng semantic similarity
 * @param {string} text — Tin nhắn user
 * @returns {string} — Intent name (CODE, RAG, DEBATE, ...)
 */
export async function classifyIntentSemantic(text) {
  if (!cacheReady) {
    await initSemanticRouter();
  }

  // Nếu cache chưa ready → fallback
  if (!cacheReady || !cachedVectors) {
    return null;
  }

  let userVec;
  try {
    userVec = await embedText(text);
  } catch {
    return null; // Embedding fail → fallback
  }

  if (!userVec) return null;

  // Tính max similarity với mỗi intent
  let bestIntent = null;
  let bestScore = 0;
  const scores = {};

  for (const [intent, vectors] of Object.entries(cachedVectors)) {
    if (vectors.length === 0) continue;

    // Lấy max similarity với bất kỳ example nào của intent này
    let maxSim = 0;
    for (const vec of vectors) {
      const sim = cosineSim(userVec, vec);
      if (sim > maxSim) maxSim = sim;
    }

    scores[intent] = maxSim;
    if (maxSim > bestScore) {
      bestScore = maxSim;
      bestIntent = intent;
    }
  }

  // Threshold: 0.75 (điều chỉnh được)
  const THRESHOLD = 0.75;

  if (bestScore >= THRESHOLD) {
    logger.debug(`[SemanticRouter] "${text.slice(0, 40)}..." → ${bestIntent} (${bestScore.toFixed(3)})`);
    return bestIntent;
  }

  // Fallback: trả null để dùng keyword matching
  logger.debug(`[SemanticRouter] "${text.slice(0, 40)}..." → no match (best: ${bestIntent} ${bestScore.toFixed(3)} < ${THRESHOLD})`);
  return null;
}

export default { initSemanticRouter, classifyIntentSemantic };
