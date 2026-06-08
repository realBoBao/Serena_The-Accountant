/**
 * lib/tot_mcts.js — Tree of Thoughts + Monte Carlo Tree Search for Code Generation
 *
 * Thay vì linear reasoning (viết code → chạy → sửa), ToT-MCTS:
 * 1. Generate: Đề xuất N hướng giải quyết (thuật toán) khác nhau
 * 2. Evaluate: Chấm điểm heuristic (Big O, feasibility) cho mỗi hướng
 * 3. Expand: Chọn hướng tốt nhất → viết code chi tiết
 * 4. Backtrack: Nếu fail → prune nhánh, thử nhánh khác
 *
 * Usage:
 *   import { totSolve } from './tot_mcts.js';
 *   const result = await totSolve(problem, { language, maxBranches: 3, maxDepth: 2 });
 */

import { ask as llmAsk } from './llm.js';
import { getLogger } from './logger.js';

const logger = getLogger('ToT-MCTS');

// ── Tree Node ───────────────────────────────────────────
class ThoughtNode {
  constructor({ id, thought, parent = null, depth = 0 }) {
    this.id = id;
    this.thought = thought;       // Mô tả hướng giải quyết (text)
    this.parent = parent;
    this.children = [];
    this.depth = depth;
    this.visits = 0;
    this.score = 0;               // Heuristic score (0-1)
    this.code = null;             // Code đã viết (nếu đã expand)
    this.executionResult = null;  // Kết quả chạy sandbox
    this.pruned = false;          // Đã bị cắt tỉa
  }

  // UCB1 score để chọn nhánh tốt nhất
  ucb1(explorationWeight = 1.414) {
    if (this.visits === 0) return Infinity;
    const exploitation = this.score / this.visits;
    const exploration = explorationWeight * Math.sqrt(Math.log(this.parent?.visits || 1) / this.visits);
    return exploitation + exploration;
  }

  bestChild() {
    if (this.children.length === 0) return null;
    return this.children
      .filter(c => !c.pruned)
      .reduce((best, c) => c.ucb1() > best.ucb1() ? c : best, this.children.find(c => !c.pruned));
  }
}

// ── Generate: Đề xuất N hướng giải quyết ───────────────

async function generateThoughts(problem, language, count = 3) {
  const prompt = `Bạn là kỹ sư giải thuật cấp cao. Cho bài toán sau, đề xuất ${count} HƯỚNG GIẢI QUYẾT KHÁC NHAU (khác thuật toán/approach).

## Bài toán:
${problem}
${language ? `Ngôn ngữ: ${language}` : ''}

Trả về JSON array:
[
  {
    "approach": "Tên thuật toán/hướng đi",
    "description": "Mô tả ngắn gọn cách tiếp cận",
    "timeComplexity": "O(?)",
    "spaceComplexity": "O(?)",
    "pros": ["ưu điểm 1", "ưu điểm 2"],
    "cons": ["nhược điểm 1"],
    "feasibility": 0.0-1.0  // Khả năng thành công (dựa trên độ phức tạp)
  }
]

QUAN TRỌNG: Mỗi hướng phải KHÁC NHAU về thuật toán cốt lõi. Không được trùng lặp.`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 2000, temperature: 0.7 });
    const jsonMatch = result.answer.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const thoughts = JSON.parse(jsonMatch[0]);
    return Array.isArray(thoughts) ? thoughts.slice(0, count) : [];
  } catch (err) {
    logger.warn('[ToT-MCTS] generateThoughts error:', err.message);
    return [];
  }
}

// ── Evaluate: Chấm điểm heuristic ──────────────────────

function evaluateThought(thought) {
  let score = thought.feasibility || 0.5;

  // Bonus cho độ phức tạp thấp hơn
  const timeStr = (thought.timeComplexity || '').toLowerCase();
  if (timeStr.includes('o(1)')) score += 0.2;
  else if (timeStr.includes('o(log')) score += 0.15;
  else if (timeStr.includes('o(n)') && !timeStr.includes('log')) score += 0.1;
  else if (timeStr.includes('o(n log')) score += 0.05;
  else if (timeStr.includes('o(n^2)')) score -= 0.1;
  else if (timeStr.includes('o(2^') || timeStr.includes('o(n!)')) score -= 0.2;

  // Bonus cho space efficiency
  const spaceStr = (thought.spaceComplexity || '').toLowerCase();
  if (spaceStr.includes('o(1)')) score += 0.1;
  else if (spaceStr.includes('o(n^2)')) score -= 0.05;

  // Bonus cho pros, penalty cho cons
  score += (thought.pros?.length || 0) * 0.03;
  score -= (thought.cons?.length || 0) * 0.03;

  return Math.min(1, Math.max(0, score));
}

// ── Expand: Viết code cho 1 nhánh ──────────────────────

async function expandNode(node, problem, language) {
  const prompt = `Bạn là chuyên gia giải thuật. Viết code hoàn chỉnh cho hướng giải quyết sau:

## Bài toán:
${problem}
${language ? `Ngôn ngữ: ${language}` : ''}

## Hướng giải quyết: ${node.thought.approach}
${node.thought.description}

## Yêu cầu:
1. Viết code hoàn chỉnh, chạy được
2. Có try/catch hoặc xử lý lỗi
3. Có test cases
4. Phân tích Big O

\`\`\`[language]
// Code chính
[code]

// Test cases
[test code]
\`\`\`

## Big O: ${node.thought.timeComplexity} time, ${node.thought.spaceComplexity} space`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 3000, temperature: 0.2 });
    const codeMatch = result.answer.match(/```\w*\n([\s\S]*?)```/);
    if (codeMatch) {
      node.code = codeMatch[1].trim();
      return true;
    }
    return false;
  } catch (err) {
    logger.warn('[ToT-MCTS] expandNode error:', err.message);
    return false;
  }
}

// ── Main: ToT-MCTS Solver ───────────────────────────────

/**
 * Giải bài toán bằng Tree of Thoughts + MCTS
 *
 * @param {string} problem  — Mô tả bài toán
 * @param {object} options  — { language, maxBranches, maxDepth, executeCode }
 * @returns {object} { status, code, approach, score, tree }
 */
export async function totSolve(problem, options = {}) {
  const {
    language = null,
    maxBranches = 3,
    maxDepth = 2,
    executeCode = null,  // Function(code, language) → { success, stdout, stderr }
  } = options;

  logger.info(`[ToT-MCTS] Solving: "${problem.slice(0, 60)}..." (${maxBranches} branches, depth ${maxDepth})`);

  // ── Step 1: Generate root + thoughts ──
  const root = new ThoughtNode({ id: 'root', thought: { approach: 'Root', description: problem }, depth: 0 });

  const thoughts = await generateThoughts(problem, language, maxBranches);
  if (thoughts.length === 0) {
    logger.warn('[ToT-MCTS] No thoughts generated, falling back to linear');
    return null; // Fallback to linear solver
  }

  // ── Step 2: Create child nodes + evaluate ──
  for (let i = 0; i < thoughts.length; i++) {
    const thought = thoughts[i];
    const node = new ThoughtNode({
      id: `branch-${i}`,
      thought,
      parent: root,
      depth: 1,
    });
    node.score = evaluateThought(thought);
    root.children.push(node);
    logger.info(`[ToT-MCTS] Branch ${i}: ${thought.approach} (score: ${node.score.toFixed(2)})`);
  }

  // ── Step 3: MCTS Loop ──
  const maxIterations = maxBranches * maxDepth;
  let bestResult = null;
  let bestScore = -1;

  for (let iter = 0; iter < maxIterations; iter++) {
    // Selection: Chọn nhánh tốt nhất (UCB1)
    let node = root;
    while (node.children.length > 0 && node.children.some(c => !c.pruned && c.code === null)) {
      node = node.bestChild();
      if (!node) break;
    }

    if (!node || node.pruned) continue;

    // Expand: Viết code cho nhánh nếu chưa có
    if (!node.code) {
      const expanded = await expandNode(node, problem, language);
      if (!expanded) {
        node.pruned = true;
        continue;
      }
    }

    // Evaluate: Chạy code (nếu có executeCode function)
    if (executeCode && node.code) {
      try {
        node.executionResult = await executeCode(node.code, language || 'javascript');
        node.visits++;

        if (node.executionResult.success) {
          // Thành công → score cao
          node.score = Math.min(1, node.score + 0.3);
          logger.info(`[ToT-MCTS] ✅ ${node.thought.approach} — SUCCESS (score: ${node.score.toFixed(2)})`);

          if (node.score > bestScore) {
            bestScore = node.score;
            bestResult = {
              status: 'success',
              code: node.code,
              approach: node.thought.approach,
              timeComplexity: node.thought.timeComplexity,
              spaceComplexity: node.thought.spaceComplexity,
              score: node.score,
              executionResult: node.executionResult,
            };
          }

          // Nếu score đủ cao → dừng sớm
          if (bestScore >= 0.9) break;
        } else {
          // Fail → giảm score, có thể prune
          node.score = Math.max(0, node.score - 0.2);
          node.visits++;

          if (node.visits >= 2 && node.score < 0.3) {
            node.pruned = true;
            logger.info(`[ToT-MCTS] ✂️ Pruned: ${node.thought.approach} (score too low: ${node.score.toFixed(2)})`);
          }
        }
      } catch (err) {
        node.visits++;
        logger.warn(`[ToT-MCTS] Execution error for ${node.thought.approach}:`, err.message);
      }
    } else {
      // Không có executeCode → dùng heuristic score
      node.visits++;
      if (node.score > bestScore) {
        bestScore = node.score;
        bestResult = {
          status: 'heuristic',
          code: node.code,
          approach: node.thought.approach,
          timeComplexity: node.thought.timeComplexity,
          spaceComplexity: node.thought.spaceComplexity,
          score: node.score,
        };
      }
    }
  }

  // ── Step 4: Return best result ──
  if (bestResult) {
    logger.info(`[ToT-MCTS] Best: ${bestResult.approach} (score: ${bestScore.toFixed(2)})`);
    return {
      ...bestResult,
      tree: {
        branches: root.children.length,
        pruned: root.children.filter(c => c.pruned).length,
        evaluated: root.children.filter(c => c.visits > 0).length,
      },
      allApproaches: root.children.map(c => ({
        approach: c.thought.approach,
        score: c.score,
        visits: c.visits,
        pruned: c.pruned,
      })),
    };
  }

  logger.warn('[ToT-MCTS] No valid result found');
  return null;
}

export default { totSolve, generateThoughts, evaluateThought };
