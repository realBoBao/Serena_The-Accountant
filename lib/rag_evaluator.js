/**
 * ═══════════════════════════════════════════════════════════════
 * RAG Quality Evaluator — DeepEval Integration
 * ═══════════════════════════════════════════════════════════════
 *
 * Đo lường chất lượng RAG pipeline:
 * - Contextual Relevancy: Context có liên quan đến câu hỏi không
 * - Faithfulness: Câu trả lời có trung thành với context không
 * - Hallucination Rate: Tỷ lệ bịa đặt thông tin
 *
 * Chạy: node scripts/eval_rag.js
 */

import { getLogger } from './logger.js';
const logger = getLogger('RagEval');

/**
 * Đánh giá chất lượng RAG answer.
 * @param {string} question - Câu hỏi
 * @param {string} answer - Câu trả lời từ RAG
 * @param {string} context - Context được sử dụng
 * @returns {{ relevancy: number, faithfulness: number, passed: boolean }}
 */
export function evaluateRagAnswer(question, answer, context) {
  // Simple heuristic evaluation (không cần DeepEval API)
  const relevancy = computeRelevancy(question, context);
  const faithfulness = computeFaithfulness(answer, context);

  return {
    relevancy: Math.round(relevancy * 100) / 100,
    faithfulness: Math.round(faithfulness * 100) / 100,
    passed: relevancy >= 0.5 && faithfulness >= 0.6,
  };
}

/**
 * Tính relevancy: context có chứa từ khóa từ question không.
 */
function computeRelevancy(question, context) {
  if (!question || !context) return 0;
  // Normalize context: support both string and array
  const ctxStr = Array.isArray(context) ? context.join(' ') : String(context);
  if (!ctxStr.trim()) return 0;

  const qWords = question.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

  const ctxLower = ctxStr.toLowerCase();
  let matchCount = 0;

  for (const word of qWords) {
    if (ctxLower.includes(word)) matchCount++;
  }

  return qWords.length > 0 ? matchCount / qWords.length : 0;
}

/**
 * Tính faithfulness: answer có chứa thông tin nằm trong context không.
 */
function computeFaithfulness(answer, context) {
  if (!answer || !context) return 0;
  // Normalize context: support both string and array
  const ctxStr = Array.isArray(context) ? context.join(' ') : String(context);
  if (!ctxStr.trim()) return 0;

  // Extract key phrases from answer (nouns, numbers, technical terms)
  const aWords = answer.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4);

  const ctxLower = ctxStr.toLowerCase();
  let matchCount = 0;

  for (const word of aWords) {
    if (ctxLower.includes(word)) matchCount++;
  }

  // Faithfulness = tỷ lệ từ trong answer có trong context
  // Nếu answer quá ngắn → không đủ thông tin để đánh giá, trả về 0.5 (neutral)
  if (aWords.length < 3) return 0.5;

  return aWords.length > 0 ? matchCount / aWords.length : 0;
}

/**
 * Batch evaluation cho nhiều Q&A pairs.
 */
export function batchEvaluate(pairs) {
  const results = [];
  let totalRelevancy = 0;
  let totalFaithfulness = 0;
  let passed = 0;

  for (const { question, answer, context } of pairs) {
    const r = evaluateRagAnswer(question, answer, context);
    results.push({ question: question.slice(0, 60), ...r });
    totalRelevancy += r.relevancy;
    totalFaithfulness += r.faithfulness;
    if (r.passed) passed++;
  }

  const n = pairs.length || 1;
  return {
    count: pairs.length,
    avgRelevancy: Math.round((totalRelevancy / n) * 100) / 100,
    avgFaithfulness: Math.round((totalFaithfulness / n) * 100) / 100,
    passRate: Math.round((passed / n) * 100),
    details: results,
  };
}
