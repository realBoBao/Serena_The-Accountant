/**
 * lib/synthetic_dataset.js — Synthetic Dataset Generation (Self-Play)
 *
 * Tự sinh "Bài thi cuối kỳ" cho chính hệ thống:
 * 1. CoderAgent viết đề bài (dựa trên knowledge base)
 * 2. InteractionAgent giải đề
 * 3. JudgeAgent chấm điểm
 * 4. PerformanceProfiler lưu kết quả
 * 5. Nếu score thấp → EvoAgent điều chỉnh RAG/model params
 *
 * Mô phỏng Self-Play của AlphaZero.
 *
 * Usage:
 *   import { runSelfPlay } from './synthetic_dataset.js';
 *   const result = await runSelfPlay({ topic: 'system design', difficulty: 'hard' });
 */

import { ask as llmAsk } from './llm.js';
import { getLogger } from './logger.js';
import { addMemory } from './lib/memory_manager.js';
import { recordModelCall } from './lib/self_evolution.js';

const logger = getLogger('SyntheticDataset');

/**
 * Chạy 1 vòng self-play: tạo đề → giải → chấm → đánh giá
 *
 * @param {object} options — { topic, difficulty, category }
 * @returns {object} { question, answer, score, feedback, improved }
 */
export async function runSelfPlay(options = {}) {
  const { topic = 'algorithms', difficulty = 'medium', category = 'Backend' } = options;

  logger.info(`[SelfPlay] Starting self-play: ${topic} (${difficulty})`);

  // ── Step 1: CoderAgent tạo đề bài ──
  const question = await generateQuestion(topic, difficulty, category);
  if (!question) {
    return { success: false, error: 'Failed to generate question' };
  }

  logger.info(`[SelfPlay] Question generated: ${question.title}`);

  // ── Step 2: InteractionAgent giải đề ──
  const answer = await solveQuestion(question, category);
  if (!answer) {
    return { success: false, error: 'Failed to solve question', question };
  }

  logger.info(`[SelfPlay] Answer generated (${answer.solution?.length || 0} chars)`);

  // ── Step 3: JudgeAgent chấm điểm ──
  const grading = await gradeAnswer(question, answer, category);
  logger.info(`[SelfPlay] Score: ${grading.score}/10 — ${grading.verdict}`);

  // ── Step 4: Lưu kết quả vào PerformanceProfiler ──
  const result = {
    topic,
    difficulty,
    category,
    question: question.title,
    score: grading.score,
    verdict: grading.verdict,
    feedback: grading.feedback,
    timestamp: new Date().toISOString(),
  };

  // Lưu vào memory để tracking
  await addMemory({
    id: `selfplay:${Date.now()}:${topic.replace(/\s+/g, '_')}`,
    type: 'self-play-result',
    source: 'synthetic-dataset',
    sourceUrl: '',
    content: JSON.stringify(result),
    tags: ['self-play', topic, difficulty, grading.score >= 7 ? 'pass' : 'fail'],
    metadata: { score: grading.score, isHighValueStudy: grading.score >= 8 },
  });

  // Ghi nhận vào self-evolution
  await recordModelCall({
    model: 'self-play',
    success: grading.score >= 7,
    latencyMs: 0,
    tokensUsed: 0,
  });

  // ── Step 5: Nếu score thấp → trigger EvoAgent ──
  let improved = false;
  if (grading.score < 5) {
    logger.warn(`[SelfPlay] Low score (${grading.score}) — triggering EvoAgent optimization`);
    await triggerEvoOptimization(topic, grading);
    improved = true;
  }

  return {
    success: true,
    ...result,
    improved,
    questionDetail: question,
    answerDetail: answer,
    gradingDetail: grading,
  };
}

/**
 * Tạo đề bài từ topic
 */
async function generateQuestion(topic, difficulty, category) {
  const prompt = `Bạn là giảng viên đại học chuyên về ${category}. Hãy tạo 1 BÀI THI CUỐI KỲ chất lượng cao.

## Chủ đề: ${topic}
## Độ khó: ${difficulty}

## Yêu cầu:
1. Đề bài phải thực tế, gần với bài toán production (không phải bài textbook đơn giản)
2. Yêu cầu code hoặc thiết kế hệ thống cụ thể
3. Có test cases hoặc tiêu chí đánh giá rõ ràng
4. Độ khó phù hợp: ${difficulty}

Trả về JSON:
{
  "title": "Tên bài toán",
  "description": "Mô tả chi tiết bài toán (2-5 câu)",
  "requirements": ["yêu cầu 1", "yêu cầu 2"],
  "test_cases": ["test case 1", "test case 2"],
  "evaluation_criteria": ["tiêu chí 1", "tiêu chí 2"],
  "expected_complexity": "O(?) time, O(?) space",
  "hints": ["gợi ý 1"]  // Chứa gợi ý, không phải lời giải
}`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 1500, temperature: 0.7 });
    const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn('[SelfPlay] generateQuestion error:', err.message);
    return null;
  }
}

/**
 * Giải đề bài
 */
async function solveQuestion(question, category) {
  const prompt = `Bạn là kỹ sư ${category} cấp senior. Hãy giải bài toán sau:

## ${question.title}

${question.description}

## Yêu cầu:
${(question.requirements || []).map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Test cases:
${(question.test_cases || []).map((t, i) => `Test ${i + 1}: ${t}`).join('\n')}

## Độ phức tạp mong đợi: ${question.expected_complexity || 'N/A'}

Hãy viết lời giải chi tiết bao gồm:
1. Phân tích bài toán (1-2 câu)
2. Thuật toán/approach đề xuất
3. Code hoàn chỉnh (có comments)
4. Phân tích Big O
5. Giải thích tại sao approach này tối ưu`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 3000, temperature: 0.3 });
    return {
      solution: result.answer,
      approach: result.answer.match(/approach|thuật toán|algorithm/i)?.[0] || 'unknown',
    };
  } catch (err) {
    logger.warn('[SelfPlay] solveQuestion error:', err.message);
    return null;
  }
}

/**
 * Chấm điểm lời giải
 */
async function gradeAnswer(question, answer, category) {
  const prompt = `Bạn là giảng viên chấm thi cuối kỳ môn ${category}.

## Đề bài: ${question.title}
${question.description}

## Tiêu chí đánh giá:
${(question.evaluation_criteria || ['Correctness', 'Efficiency', 'Readability']).map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Lời giải của sinh viên:
\`\`\`
${answer.solution?.slice(0, 4000) || '(không có lời giải)'}
\`\`\`

## Yêu cầu chấm:
1. Chấm điểm 0-10 (10 = hoàn hảo)
2. Liệt kê điểm mạnh và điểm yếu cụ thể
3. Gợi ý cải thiện
4. Verdict: excellent (≥8), good (6-7), pass (5), fail (<5)

Trả về JSON:
{
  "score": 0-10,
  "verdict": "excellent|good|pass|fail",
  "strengths": ["điểm mạnh 1"],
  "weaknesses": ["điểm yếu 1"],
  "suggestions": ["gợi ý 1"],
  "feedback": "Nhận xét tổng quan (2-3 câu)"
}`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 1000, temperature: 0.2 });
    const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { score: 5, verdict: 'pass', feedback: 'Parse failed, default score' };
    }
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn('[SelfPlay] gradeAnswer error:', err.message);
    return { score: 5, verdict: 'pass', feedback: 'Grading error' };
  }
}

/**
 * Trigger EvoAgent khi score thấp
 */
async function triggerEvoOptimization(topic, grading) {
  try {
    const { detectKnowledgeGaps, selectOptimalModel } = await import('./self_evolution.js');

    // Phát hiện knowledge gap
    await detectKnowledgeGaps(topic, grading.weaknesses || []);

    // Điều chỉnh model selection
    const currentPerf = await selectOptimalModel();
    logger.info(`[SelfPlay] EvoAgent triggered for "${topic}" — current best model: ${currentPerf}`);
  } catch (err) {
    logger.warn('[SelfPlay] EvoAgent trigger failed:', err.message);
  }
}

/**
 * Batch self-play — chạy nhiều rounds
 */
export async function runBatchSelfPlay(rounds = 5, topics = null) {
  const defaultTopics = [
    'system design', 'algorithms', 'database optimization',
    'microservices', 'caching strategies', 'concurrency',
  ];
  const playTopics = topics || defaultTopics;

  const results = [];
  for (let i = 0; i < rounds; i++) {
    const topic = playTopics[i % playTopics.length];
    const difficulty = i % 3 === 0 ? 'hard' : i % 3 === 1 ? 'medium' : 'easy';

    logger.info(`[SelfPlay] Round ${i + 1}/${rounds}: ${topic} (${difficulty})`);
    const result = await runSelfPlay({ topic, difficulty });
    results.push(result);

    // Delay giữa các rounds để tránh rate limit
    if (i < rounds - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Tổng kết
  const avgScore = results.reduce((s, r) => s + (r.score || 0), 0) / results.length;
  const passRate = results.filter(r => (r.score || 0) >= 5).length / results.length;

  logger.info(`[SelfPlay] Batch complete: avg score ${avgScore.toFixed(1)}/10, pass rate ${(passRate * 100).toFixed(0)}%`);

  return {
    rounds,
    results,
    avgScore,
    passRate,
    summary: results.map(r => ({ topic: r.topic, difficulty: r.difficulty, score: r.score, verdict: r.verdict })),
  };
}

export default { runSelfPlay, runBatchSelfPlay };
