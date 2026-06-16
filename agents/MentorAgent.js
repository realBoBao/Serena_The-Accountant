/**
 * MentorAgent — Senior Dev đóng vai trò chấm code & gợi ý
 *
 * Vai trò:
 * 1. Nhận code từ user → chấm điểm (KHÔNG viết đáp án)
 * 2. Đưa ra hints từng bước nhỏ nếu user bí
 * 3. Ném code vào Sandbox để kiểm chứng thực tế
 * 4. Theo dõi tiến trình học của user
 *
 * Được gọi bởi:
 * - Shadow Review (!review command)
 * - Incident Simulator (!incident command)
 */

import { executeCode } from '../lib/code_sandbox.js';
import { invokeLlm } from '../lib/llm.js';
import { HumanMessage } from '@langchain/core/messages';
import { getLogger } from '../lib/logger.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  findUserCodeSnippets,
  generateChallenge,
  evaluateAnswer,
  createSession,
  getSession,
  updateSession,
} from '../lib/shadow_review.js';
import { buildXmlPrompt } from '../lib/prompt_xml.js';

const logger = getLogger('MentorAgent');

// ── Tier 1: Clean Code Standards (ryanmcdermott/clean-code-javascript) ──
let _cleanCodeRules = null;
function getCleanCodeRules() {
  if (_cleanCodeRules) return _cleanCodeRules;
  try {
    _cleanCodeRules = readFileSync(resolve('./data/clean-code-rules.md'), 'utf8');
  } catch {
    _cleanCodeRules = ''; // Fallback if file not found
  }
  return _cleanCodeRules;
}

// ── Enhanced system prompt with Clean Code standards ──
function buildMentorSystemPrompt() {
  return buildXmlPrompt({
    system: `Bạn là Senior Backend Developer nghiêm khắc. Bạn LUÔN trả lời bằng tiếng Việt. Bạn chấm code theo chuẩn Clean Code công nghiệp.`,
    context: `<clean_code_rules>\n${getCleanCodeRules()}\n</clean_code_rules>`,
    instructions: `Khi chấm code, bạn PHẢI:
1. Kiểm tra tuân thủ Clean Code rules (đặt tên, SOLID, DRY, KISS)
2. Chấm điểm theo thang 1-10 cho: Correctness, Readability, Performance, Maintainability
3. Đưa ra gợi ý cải tiến cụ thể (không chung chung)
4. Nếu code vi phạm nghiêm trọng → yêu cầu viết lại
5. Nếu code tốt → khen ngợi và đề xuất thử thách khó hơn`,
    constraints: `KHÔNG bao giờ viết đáp án thay user
KHÔNG chấp nhận code vi phạm SOLID principles
LUÔN dẫn dắt user tự tìm ra câu trả lời (phương pháp Socratic)`,
    output: '[Đánh giá chi tiếm theo từng tiêu chí Clean Code, điểm số, và gợi ý cải tiến]',
  });
}

// ── Shadow Review Flow ──

/**
 * Bắt đầu một Shadow Review session.
 * Tìm code cũ của user → tạo thử thách → gửi cho user.
 */
export async function startShadowReview(userId, level = 1) {
  logger.info(`[MentorAgent] Starting Shadow Review for ${userId}, level ${level}`);

  // 1. Tìm code snippets từ memory
  const snippets = await findUserCodeSnippets(5);
  if (snippets.length === 0) {
    return {
      ok: false,
      message: '❌ Không tìm thấy code nào trong memory để review. Hãy dùng `!code` để giải vài bài trước đã!',
    };
  }

  // 2. Chọn snippet ngẫu nhiên
  const snippet = snippets[Math.floor(Math.random() * snippets.length)];
  logger.info(`[MentorAgent] Selected snippet: ${snippet.language} from ${snippet.source}`);

  // 3. Tạo challenge bằng LLM
  const challenge = await generateChallenge(
    snippet.text,
    snippet.language,
    level,
    async (prompt) => {
      const raw = await invokeLlm([
        new HumanMessage(buildMentorSystemPrompt()),
        new HumanMessage(prompt),
      ], 'MentorChallenge');
      return raw;
    }
  );

  // 4. Tạo session
  const sessionId = createSession(userId, challenge);

  // 5. Format output cho user
  const output = [
    `🔍 **Shadow Review — Level ${level} (${challenge.levelName})**`,
    `📌 **Chủ đề:** ${challenge.topic}`,
    ``,
    `📝 **Code cũ của bạn** (${challenge.language}):`,
    `\`\`\`${challenge.language}`,
    challenge.originalCode.slice(0, 800) + (challenge.originalCode.length > 800 ? '\n...' : ''),
    `\`\`\``,
    ``,
    `🚨 **Thử thách:**`,
    challenge.challenge,
    ``,
    `💡 **Gợi ý đầu tiên:** ${challenge.hint}`,
    ``,
    `⏱️ Bạn có ${getSession(sessionId).maxAttempts} lần nộp code.`,
    `Gõ code và gửi lên để Sandbox chấm điểm!`,
    `Session: \`${sessionId}\``,
  ].join('\n');

  return {
    ok: true,
    sessionId,
    challenge,
    message: output,
  };
}

/**
 * Xử lý câu trả lời của user trong Shadow Review.
 * 1. Ném code vào Sandbox
 * 2. Chấm điểm bằng LLM
 * 3. Đưa hint tiếp theo nếu chưa đạt
 */
export async function submitReviewAnswer(userId, sessionId, userCode, language = 'cpp') {
  const session = getSession(sessionId);
  if (!session) {
    return { ok: false, message: '❌ Session không tồn tại hoặc đã hết hạn. Gõ `!review` để bắt đầu lại.' };
  }

  if (session.status !== 'active') {
    return { ok: false, message: `❌ Session đã kết thúc (trạng thái: ${session.status}). Gõ \`!review\` để bắt đầu lại.` };
  }

  if (session.attempts >= session.maxAttempts) {
    session.status = 'failed';
    return {
      ok: false,
      message: `❌ Đã hết ${session.maxAttempts} lần nộp. Gõ \`!review\` để thử thử thách mới.`,
    };
  }

  // 1. Chạy code trong Sandbox
  logger.info(`[MentorAgent] Running user code in Sandbox (attempt ${session.attempts + 1})`);
  let sandboxResult;
  try {
    sandboxResult = await executeCode({ agent: 'shadow_review', code: userCode, language });
  } catch (err) {
    sandboxResult = { success: false, error: err.message, stdout: '', stderr: err.message };
  }

  // 2. Chấm điểm bằng LLM
  const evaluation = await evaluateAnswer(
    userCode,
    session.challenge,
    language,
    sandboxResult,
    async (prompt) => {
      const raw = await invokeLlm([
        new HumanMessage(buildMentorSystemPrompt()),
        new HumanMessage(prompt),
      ], 'MentorEval');
      return raw;
    }
  );

  // 3. Cập nhật session
  updateSession(sessionId, {
    lastScore: evaluation.score,
    lastPassed: evaluation.passed,
    status: evaluation.passed ? 'passed' : 'active',
  });

  // 4. Format output
  const scoreBar = '█'.repeat(Math.round(evaluation.score)) + '░'.repeat(10 - Math.round(evaluation.score));
  const output = [
    `📊 **Kết quả nộp #${session.attempts}**`,
    ``,
    `${sandboxResult.success ? '✅ Code chạy thành công' : '❌ Code có lỗi'}`,
    `Score: [${scoreBar}] ${evaluation.score}/10`,
    ``,
    `💬 **Nhận xét:**`,
    evaluation.feedback,
  ];

  if (evaluation.strengths.length > 0) {
    output.push(``, `✅ **Điểm mạnh:**`);
    evaluation.strengths.forEach(s => output.push(`  • ${s}`));
  }

  if (evaluation.weaknesses.length > 0) {
    output.push(``, `⚠️ **Cần cải thiện:**`);
    evaluation.weaknesses.forEach(w => output.push(`  • ${w}`));
  }

  if (evaluation.passed) {
    output.push(
      ``,
      `🎉 **CHÚC MỪNG! Bạn đã vượt qua thử thách!**`,
      evaluation.nextHint ? `🚀 **Gợi ý nâng cao:** ${evaluation.nextHint}` : ``,
      ``,
      `Gõ \`!review\` để nhận thử thách mới, hoặc \`!review --level 2\` để tăng độ khó.`
    );
  } else {
    output.push(
      ``,
      `💡 **Gợi ý tiếp theo:** ${evaluation.nextHint || 'Thử lại với cách tiếp cận khác.'}`,
      ``,
      `Còn ${session.maxAttempts - session.attempts} lần nộp.`
    );
  }

  return {
    ok: true,
    passed: evaluation.passed,
    score: evaluation.score,
    sandboxResult,
    evaluation,
    message: output.join('\n'),
  };
}

// ── Hint System ──

/**
 * Đưa ra hint tiếp theo cho user đang bí.
 * Mỗi hint mở ra thêm một phần của giải pháp.
 */
export async function getNextHint(userId, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return { ok: false, message: '❌ Session không tồn tại.' };
  }

  session.hintsUsed++;
  const challenge = session.challenge;

  const hintPrompt = `Bạn là Senior Dev. Người dùng đang giải thử thách nhưng bí.

Thử thách: ${challenge.challenge}
Code gốc: ${challenge.originalCode.slice(0, 500)}

Người dùng đã dùng ${session.hintsUsed} hint. Hãy đưa ra HINT TIẾP THEO cụ thể hơn hint trước.
QUAN TRỌNG: KHÔNG viết code đáp án. Chỉ gợi ý hướng tiếp cận, thư viện, hoặc cú pháp cần dùng.
Hint phải ngắn gọn, đúng trọng tâm. Tiếng Việt.`;

  try {
    const hint = await invokeLlm([
      new HumanMessage(buildMentorSystemPrompt()),
      new HumanMessage(hintPrompt),
    ], 'MentorHint');

    return {
      ok: true,
      hintNumber: session.hintsUsed,
      hint: hint.trim(),
      message: `💡 **Hint #${session.hintsUsed}:**\n${hint.trim()}`,
    };
  } catch (err) {
    return {
      ok: true,
      hintNumber: session.hintsUsed,
      hint: challenge.hint,
      message: `💡 **Hint #${session.hintsUsed}:**\n${challenge.hint}`,
    };
  }
}

// ── Stats ──

export function getMentorStats() {
  const stats = { total: 0, active: 0, passed: 0, failed: 0 };
  for (const [, s] of getSession) {
    stats.total++;
    stats[s.status === 'active' ? 'active' : s.status === 'passed' ? 'passed' : 'failed']++;
  }
  return stats;
}
