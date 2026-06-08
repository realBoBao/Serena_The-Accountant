/**
 * lib/judge_diff.js — Judge Agent cho Shadow Execution Diff Analysis
 *
 * Khi 2 shadow instances trả về kết quả khác nhau:
 * 1. Phân tích diff giữa 2 outputs
 * 2. Chọn kết quả tốt hơn (hoặc merge)
 * 3. Giải thích lý do chọn
 *
 * Usage:
 *   import { judgeDiff } from './judge_diff.js';
 *   const analysis = await judgeDiff(task, outputA, outputB);
 */

import { ask as llmAsk } from './llm.js';
import { getLogger } from './logger.js';

const logger = getLogger('JudgeDiff');

/**
 * So sánh 2 outputs và chọn kết quả tốt hơn
 *
 * @param {object} task — Task gốc
 * @param {string} outputA — Kết quả từ instance A
 * @param {string} outputB — Kết quả từ instance B
 * @returns {object} { selectedOutput, selectedInstance, reason, confidence }
 */
export async function judgeDiff(task, outputA, outputB) {
  logger.info('[JudgeDiff] Analyzing diff between 2 shadow outputs');

  const prompt = `Bạn là Judge Agent — chuyên gia đánh giá chất lượng code/kết quả.

## Task gốc:
${task.problem || task.action || JSON.stringify(task)}

## Output A:
\`\`\`
${outputA.slice(0, 3000)}
\`\`\`

## Output B:
\`\`\`
${outputB.slice(0, 3000)}
\`\`\`

## Yêu cầu:
1. So sánh 2 outputs về: correctness, completeness, efficiency, readability
2. Chọn output tốt hơn (A hoặc B)
3. Giải thích ngắn gọn lý do chọn (2-3 câu)
4. Nếu cả 2 đều sai → chọn cái ít sai hơn và gợi ý cách sửa

Trả về JSON:
{
  "selectedInstance": "A" | "B",
  "confidence": 0.0-1.0,
  "reason": "giải thích ngắn gọn",
  "issues": ["vấn đề 1", "vấn đề 2"],
  "suggestion": "gợi ý cải thiện (nếu có)"
}`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 1000, temperature: 0.2 });
    const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { selectedOutput: outputA, selectedInstance: 'A', confidence: 0.5, reason: 'Judge parse failed, fallback to A' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedOutput = parsed.selectedInstance === 'A' ? outputA : outputB;

    logger.info(`[JudgeDiff] Selected: ${parsed.selectedInstance} (confidence: ${parsed.confidence}) — ${parsed.reason?.slice(0, 80)}`);

    return {
      selectedOutput,
      selectedInstance: parsed.selectedInstance,
      confidence: parsed.confidence || 0.5,
      reason: parsed.reason || '',
      issues: parsed.issues || [],
      suggestion: parsed.suggestion || '',
    };
  } catch (err) {
    logger.warn('[JudgeDiff] Judge failed:', err.message);
    return { selectedOutput: outputA, selectedInstance: 'A', confidence: 0.5, reason: 'Judge error, fallback to A' };
  }
}

export default { judgeDiff };
