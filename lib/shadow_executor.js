/**
 * lib/shadow_executor.js — Shadow Execution & Consensus Engine
 *
 * Khi PlannerAgent tạo plan, thay vì chạy 1 lần:
 * 1. Spawn 2+ AgentWorker độc lập trên Sandbox khác nhau
 * 2. Chạy song song cùng task
 * 3. So sánh output (hash matching)
 *    - Khớp → tự tin trả về
 *    - Lệch → gọi JudgeAgent phân tích diff
 *
 * Usage:
 *   import { shadowExecute } from './shadow_executor.js';
 *   const result = await shadowExecute(task, { instances: 2, timeoutMs: 60000 });
 */

import crypto from 'crypto';
import { getLogger } from './logger.js';

const logger = getLogger('ShadowExec');

/**
 * Normalize output để so sánh (loại bỏ whitespace, comments)
 */
function normalizeOutput(text) {
  if (!text) return '';
  return text
    .replace(/\s+/g, ' ')
    .replace(/\/\/.*$/gm, '')  // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // strip block comments
    .replace(/#.*$/gm, '')  // strip python comments
    .trim()
    .toLowerCase();
}

/**
 * Tính hash của output
 */
function hashOutput(text) {
  return crypto.createHash('sha256').update(normalizeOutput(text)).digest('hex');
}

/**
 * So sánh 2 outputs — trả về similarity score (0-1)
 */
function compareOutputs(a, b) {
  const normA = normalizeOutput(a);
  const normB = normalizeOutput(b);

  if (normA === normB) return 1;
  if (!normA || !normB) return 0;

  // Simple word-level Jaccard similarity
  const wordsA = new Set(normA.split(/\s+/));
  const wordsB = new Set(normB.split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Shadow Execute — Chạy song song N instances, so sánh kết quả
 *
 * @param {object} task — { agent, action, problem, language, options }
 * @param {object} config — { instances, timeoutMs, similarityThreshold }
 * @returns {object} { result, consensus, instances, details }
 */
export async function shadowExecute(task, config = {}) {
  const {
    instances = 2,
    timeoutMs = 60000,
    similarityThreshold = 0.85,
  } = config;

  logger.info(`[ShadowExec] Starting ${instances} parallel instances for: ${task.action || task.problem?.slice(0, 50)}`);

  // Spawn N parallel executions
  const promises = [];
  for (let i = 0; i < instances; i++) {
    promises.push(
      executeSingle(task, i, timeoutMs).then(result => ({
        instance: i,
        ...result,
      }))
    );
  }

  const results = await Promise.allSettled(promises);

  // Collect successful results
  const successful = [];
  const failed = [];

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.success) {
      successful.push(r.value);
    } else {
      failed.push(r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
    }
  }

  // Nếu không có successful → fail
  if (successful.length === 0) {
    logger.warn('[ShadowExec] All instances failed');
    return {
      success: false,
      consensus: 'none',
      instances,
      failed: failed.length,
      error: 'All shadow instances failed',
    };
  }

  // Nếu chỉ 1 successful → trả về (không cần consensus)
  if (successful.length === 1) {
    logger.info('[ShadowExec] Only 1 successful instance — returning without consensus');
    return {
      success: true,
      consensus: 'single',
      instances,
      result: successful[0].output,
      details: successful,
    };
  }

  // So sánh outputs
  const outputs = successful.map(s => s.output);
  const hashes = outputs.map(o => hashOutput(o));

  // Check if all hashes match
  const allMatch = hashes.every(h => h === hashes[0]);

  if (allMatch) {
    logger.info(`[ShadowExec] ✅ Consensus reached — all ${successful.length} instances match`);
    return {
      success: true,
      consensus: 'full',
      instances,
      result: outputs[0],
      details: successful,
    };
  }

  // Partial match — tính similarity matrix
  let maxSimilarity = 0;
  let bestPair = [0, 1];

  for (let i = 0; i < outputs.length; i++) {
    for (let j = i + 1; j < outputs.length; j++) {
      const sim = compareOutputs(outputs[i], outputs[j]);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        bestPair = [i, j];
      }
    }
  }

  // Nếu similarity > threshold → lấy output dài hơn (chi tiết hơn)
  if (maxSimilarity >= similarityThreshold) {
    const best = outputs[bestPair[0]].length >= outputs[bestPair[1]].length
      ? outputs[bestPair[0]]
      : outputs[bestPair[1]];
    logger.info(`[ShadowExec] ⚠️ Partial consensus — similarity: ${(maxSimilarity * 100).toFixed(1)}%`);
    return {
      success: true,
      consensus: 'partial',
      similarity: maxSimilarity,
      instances,
      result: best,
      details: successful,
    };
  }

  // Không consensus → cần JudgeAgent
  logger.warn(`[ShadowExec] ❌ No consensus — max similarity: ${(maxSimilarity * 100).toFixed(1)}%`);
  return {
    success: false,
    consensus: 'conflict',
    similarity: maxSimilarity,
    instances,
    outputs,
    needsJudge: true,
    details: successful,
  };
}

/**
 * Execute single instance (wrapper với timeout)
 */
async function executeSingle(task, index, timeoutMs) {
  const { agent, action, problem, language, options } = task;

  try {
    // Dynamic import để tránh circular dependency
    let result;

    if (agent === 'CoderAgent') {
      const { solveWithDebugLoop } = await import('../agents/CoderAgent.js');
      result = await solveWithDebugLoop(problem, {
        language,
        maxRetries: 1,
        runTests: true,
        action,
        ...options,
      });
    } else if (agent === 'RagAgent') {
      const { answerQuestion } = await import('../agents/RagAgent.js');
      result = await answerQuestion(problem, options);
    } else {
      // Generic: invoke LLM directly
      const { ask } = await import('../lib/llm.js');
      const { HumanMessage } = await import('@langchain/core/messages');
      const answer = await ask(problem, { maxTokens: options?.maxTokens || 20048 });
      result = { answer: answer.answer };
    }

    // Extract output text
    const output = result?.answer || result?.code || result?.stdout || JSON.stringify(result);

    return {
      success: true,
      output,
      raw: result,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

export default { shadowExecute, compareOutputs, hashOutput };
