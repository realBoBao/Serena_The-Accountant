/**
 * Shadow Review — Ôn tập Kiến trúc Cá nhân
 *
 * Lấy code CỦA CHÍNH NGƯỜI DÙNG từ vector store / daily-memory,
 * dùng LLM đóng vai Senior Dev đặt thử thách nâng cấp,
 * ép người dùng TỰ VIẾT LẠI code — không cho xem đáp án.
 *
 * Nguyên tắc:
 * 1. KHÔNG BAO GIỜ viết sẵn code đáp án
 * 2. Chỉ gợi ý (hint) từng bước nhỏ
 * 3. Code của user phải qua Sandbox thực thi
 * 4. Chấm điểm dựa trên: correctness + performance + memory
 */

import { getLogger } from './logger.js';
import { searchDaily, searchSystem } from './vector_collections.js';
import { search as vectorSearch } from './vector_store.js';
import { embedText } from './embeddings.js';

const logger = getLogger('ShadowReview');

// ── Level definitions ──
const LEVELS = {
  1: {
    name: 'Beginner',
    topics: [
      'Tối ưu thuật toán (Big O)',
      'Xử lý lỗi cơ bản (null check, try/catch)',
      'Tách hàm thành module',
    ],
    prompt: 'Đây là level Beginner. Hãy đặt thử thách ĐƠN GIẢN, tập trung vào tối ưu thuật toán hoặc xử lý lỗi cơ bản.',
  },
  2: {
    name: 'Intermediate',
    topics: [
      'Đổi từ xử lý đồng bộ sang async',
      'Kết nối Database thay vì file text',
      'Tách thành REST API endpoint',
      'Xử lý đa luồng cơ bản',
    ],
    prompt: 'Đây là level Intermediate. Hãy đặt thử thách về chuyển đổi kiến trúc từ script đơn giản sang chuẩn Backend.',
  },
  3: {
    name: 'Advanced',
    topics: [
      'Scaling (xử lý 10K+ requests/s)',
      'Sharding / Partitioning',
      'Message Queue / Event-driven',
      'Caching strategy',
      'Connection pooling',
    ],
    prompt: 'Đây là level Advanced. Hãy đặt thử thách về scaling hệ thống phân tán.',
  },
};

// ── Extract code snippets from memory ──

/**
 * Tìm đoạn code trong daily-memory / system-logs.
 * Trả về mảng { text, source, date } chứa code snippets.
 */
export async function findUserCodeSnippets(limit = 5) {
  const snippets = [];

  // Tìm trong daily-memory
  try {
    const dailyResults = await searchDaily(null, limit * 2);
    if (dailyResults && dailyResults.length > 0) {
      for (const r of dailyResults) {
        const text = r.chunk_text || r.text || '';
        const codeBlocks = extractCodeBlocks(text);
        for (const block of codeBlocks) {
          snippets.push({
            text: block.code,
            language: block.language,
            source: r.url || r.doc_id || 'daily-memory',
            date: r.added_at || r.updated_at || 'unknown',
          });
        }
      }
    }
  } catch (err) {
    logger.debug('[ShadowReview] daily-memory search failed:', err.message);
  }

  // Tìm trong vectors.db (legacy SQLite)
  try {
    const queryEmbedding = await embedText('code function algorithm implementation');
    const vecResults = await vectorSearch(queryEmbedding, limit * 2);
    if (vecResults && vecResults.length > 0) {
      for (const r of vecResults) {
        const text = r.chunk_text || '';
        const codeBlocks = extractCodeBlocks(text);
        for (const block of codeBlocks) {
          snippets.push({
            text: block.code,
            language: block.language,
            source: r.url || r.doc_id || 'vector-store',
            date: r.added_at || 'unknown',
          });
        }
      }
    }
  } catch (err) {
    logger.debug('[ShadowReview] vector search failed:', err.message);
  }

  // Deduplicate and return
  const seen = new Set();
  return snippets.filter(s => {
    const key = s.text.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

/**
 * Trích xuất code blocks từ text.
 * Hỗ trợ ```language ... ``` và indentation-based code.
 */
function extractCodeBlocks(text) {
  const blocks = [];

  // Markdown code blocks: ```lang ... ```
  const mdPattern = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = mdPattern.exec(text)) !== null) {
    const lang = match[1] || detectLanguage(match[2]);
    if (match[2].trim().length > 20) {
      blocks.push({ code: match[2].trim(), language: lang });
    }
  }

  // Inline code with function definitions (fallback)
  if (blocks.length === 0) {
    const funcPattern = /(?:void|int|char|bool|float|double|long|string|auto|public|private|protected|static|def|function|class)\s+\w+\s*\([^)]*\)\s*\{[^}]*\}/g;
    while ((match = funcPattern.exec(text)) !== null) {
      blocks.push({ code: match[0], language: detectLanguage(match[0]) });
    }
  }

  return blocks;
}

function detectLanguage(code) {
  if (code.includes('#include') || code.includes('std::') || code.includes('cout') || code.includes('cin')) return 'cpp';
  if (code.includes('public class') || code.includes('System.out') || code.includes('import java.')) return 'java';
  if (code.includes('def ') || code.includes('import ') && !code.includes('#include')) return 'python';
  if (code.includes('function ') || code.includes('const ') || code.includes('let ') || code.includes('=>')) return 'javascript';
  if (code.includes('#!/bin/bash') || code.includes('echo ') || code.includes('grep ')) return 'bash';
  return 'cpp'; // default
}

// ── Challenge Generator ──

/**
 * Tạo thử thách Shadow Review từ code snippet.
 * Dùng LLM để phân tích code và đặt câu hỏi thách thức.
 *
 * @param {string} codeSnippet - Đoạn code cũ của user
 * @param {string} language - Ngôn ngữ lập trình
 * @param {number} level - Level (1=Beginner, 2=Intermediate, 3=Advanced)
 * @param {Function} invokeLlmFn - Hàm gọi LLM
 * @returns {Promise<{challenge, hint, originalCode, level, topic}>}
 */
export async function generateChallenge(codeSnippet, language, level = 1, invokeLlmFn) {
  const levelConfig = LEVELS[level] || LEVELS[1];

  const prompt = `Bạn là một Senior Backend Developer giỏi. Nhiệm vụ: PHÂN TÍCH đoạn code dưới đây và đặt MỘT thử thách nâng cấp.

=== ĐOẠN CODE CỦA NGƯỜI DÙNG (${language}) ===
\`\`\`${language}
${codeSnippet.slice(0, 2000)}
\`\`\`

=== LEVEL: ${levelConfig.name} ===
Các chủ đề phù hợp: ${levelConfig.topics.join(', ')}

${levelConfig.prompt}

=== QUY TẮC QUAN TRỌNG ===
1. KHÔNG BAO GIỜ viết code đáp án. Chỉ đặt câu hỏi/thử thách.
2. Thử thách phải CỤ THỂ, có thể kiểm chứng bằng code.
3. Đưa ra GỢI Ý ĐẦU TIÊN (hint) nhẹ nhàng, chưa phải lời giải.
4. Thử thách phải bám sát đoạn code đã cho — không đưa ví dụ ngoài.

Trả về JSON hợp lệ:
{
  "topic": "Chủ đề thử thách (VD: Tối ưu Big O, Xử lý null pointer, Chuyển sang async)",
  "challenge": "Mô tả thử thách chi tiết bằng tiếng Việt. Câu hỏi cụ thể người dùng phải làm gì.",
  "hint": "Gợi ý đầu tiên nhẹ nhàng (không phải đáp án). Gợi ý về hướng tiếp cận hoặc thư viện cần dùng.",
  "evaluationCriteria": ["tiêu chí 1", "tiêu chí 2", "tiêu chí 3"]
}`;

  try {
    const raw = await invokeLlmFn(prompt);
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      return {
        topic: parsed.topic || 'Code Review',
        challenge: parsed.challenge || 'Hãy tối ưu đoạn code trên.',
        hint: parsed.hint || 'Hãy nghĩ về độ phức tạp thuật toán.',
        evaluationCriteria: parsed.evaluationCriteria || ['Correctness', 'Performance'],
        originalCode: codeSnippet,
        language,
        level,
        levelName: levelConfig.name,
      };
    }
  } catch (err) {
    logger.warn('[ShadowReview] LLM challenge generation failed:', err.message);
  }

  // Fallback challenge
  return {
    topic: 'Code Review',
    challenge: `Đoạn code ${language} trên có thể cải thiện điều gì? Hãy viết lại phiên bản tối ưu hơn.`,
    hint: 'Hãy nghĩ về: độ phức tạp thuật toán, xử lý lỗi, và khả năng mở rộng.',
    evaluationCriteria: ['Correctness', 'Performance', 'Readability'],
    originalCode: codeSnippet,
    language,
    level,
    levelName: levelConfig.name,
  };
}

// ── Answer Evaluator ──

/**
 * Chấm điểm câu trả lời của user.
 * KHÔNG đưa đáp án, chỉ chấm và gợi ý tiếp.
 *
 * @param {string} userCode - Code user viết
 * @param {object} challenge - Challenge object từ generateChallenge
 * @param {string} language - Ngôn ngữ
 * @param {object} sandboxResult - Kết quả từ code_sandbox
 * @param {Function} invokeLlmFn - Hàm gọi LLM
 * @returns {Promise<{score, feedback, nextHint, passed}>}
 */
export async function evaluateAnswer(userCode, challenge, language, sandboxResult, invokeLlmFn) {
  const prompt = `Bạn là Senior Backend Developer chấm code. Nhiệm vụ: CHẤM ĐIỂM code của Junior dev.

=== THỬ THÁCH ===
${challenge.challenge}

=== CODE GỐC ===
\`\`\`${language}
${challenge.originalCode.slice(0, 1000)}
\`\`\===

=== CODE CỦA NGƯỜI DÙNG ===
\`\`\`${language}
${userCode.slice(0, 2000)}
\`\`\===

=== KẾT QUẢ CHẠY THỬ ===
${sandboxResult.success ? `✅ Thành công\nOutput: ${sandboxResult.stdout?.slice(0, 500) || '(empty)'}` : `❌ Lỗi\n${sandboxResult.stderr?.slice(0, 500) || sandboxResult.error || 'Unknown error'}`}

=== TIÊU CHÍ CHẤM ===
${challenge.evaluationCriteria.map(c => `- ${c}`).join('\n')}

=== QUY TẮC ===
1. KHÔNG viết code đáp án. Chỉ chấm và gợi ý.
2. Nếu code chưa đạt, đưa ra GỢI Ý TIẾP THEO (nextHint) cụ thể.
3. Nếu code đạt, khen ngợi và gợi ý cải thiện thêm nhỏ.
4. Score từ 0-10.

Trả về JSON:
{
  "score": <0-10>,
  "passed": <true nếu score >= 6>,
  "feedback": "Nhận xét chi tiếng Việt về code",
  "nextHint": "Gợi ý tiếp theo nếu chưa đạt, hoặc gợi ý nâng cao nếu đã đạt",
  "strengths": ["điểm mạnh 1", "điểm mạnh 2"],
  "weaknesses": ["điểm yếu 1"]
}`;

  try {
    const raw = await invokeLlmFn(prompt);
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      return {
        score: Math.min(10, Math.max(0, parsed.score || 0)),
        passed: parsed.passed !== false && (parsed.score || 0) >= 6,
        feedback: parsed.feedback || 'Không có nhận xét.',
        nextHint: parsed.nextHint || null,
        strengths: parsed.strengths || [],
        weaknesses: parsed.weaknesses || [],
      };
    }
  } catch (err) {
    logger.warn('[ShadowReview] LLM evaluation failed:', err.message);
  }

  // Fallback evaluation
  const passed = sandboxResult.success;
  return {
    score: passed ? 7 : 3,
    passed,
    feedback: passed
      ? '✅ Code chạy thành công! Hãy nghĩ thêm về tối ưu hóa.'
      : '❌ Code chưa chạy được. Hãy kiểm tra lỗi và thử lại.',
    nextHint: passed
      ? 'Thử tối ưu thêm: giảm số vòng lặp, dùng cấu trúc dữ liệu phù hợp hơn.'
      : 'Kiểm tra cú pháp, dấu ngoặc, và kiểu dữ liệu. Thử chạy từng phần nhỏ.',
    strengths: passed ? ['Code compiles'] : [],
    weaknesses: passed ? [] : ['Code has errors'],
  };
}

// ── Session State ──

const reviewSessions = new Map();

export function createSession(userId, challenge) {
  const sessionId = `review:${userId}:${Date.now()}`;
  reviewSessions.set(sessionId, {
    userId,
    challenge,
    attempts: 0,
    maxAttempts: 5,
    hintsUsed: 0,
    status: 'active', // active, passed, failed, abandoned
    createdAt: Date.now(),
  });
  return sessionId;
}

export function getSession(sessionId) {
  return reviewSessions.get(sessionId);
}

export function updateSession(sessionId, updates) {
  const session = reviewSessions.get(sessionId);
  if (session) {
    Object.assign(session, updates);
    session.attempts++;
  }
  return session;
}

export function cleanupSessions(maxAgeMs = 3600000) {
  const now = Date.now();
  for (const [id, s] of reviewSessions) {
    if (now - s.createdAt > maxAgeMs) reviewSessions.delete(id);
  }
}
