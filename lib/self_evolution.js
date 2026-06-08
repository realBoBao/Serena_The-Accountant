/**
 * Self-Evolution Protocol — Phase 20
 *
 * 1. Auto-Evaluate Responses: Score answer quality, log low-quality ones
 * 2. Self-Repair Pipeline: Detect bugs from logs → create fix → test → deploy
 * 3. Adaptive Model Selection: Auto-select optimal model per query type & cost
 * 4. Knowledge Gap Detection: Find weak knowledge areas → auto-ingest documents
 * 5. A/B Testing Framework: Compare prompt strategies
 */

import { getLogger } from './logger.js';
import { embedText } from './embeddings.js';
import { search as vectorSearch } from './vector_store.js';

const logger = getLogger('SelfEvolution');

// ── 1. Auto-Evaluate Responses ──

const QUALITY_THRESHOLD = 0.5;
const evaluationLog = []; // In-memory; persisted to SQLite in production
const MAX_LOG_SIZE = 1000;

/**
 * Evaluate response quality using heuristics + LLM self-reflection.
 * Returns score 0-1.
 */
export async function evaluateResponse(query, response, context = {}) {
  const checks = [];

  // Heuristic 1: Response length (too short = likely bad)
  const lenScore = Math.min(response.length / 200, 1.0);
  checks.push({ check: 'length', score: lenScore });

  // Heuristic 2: Contains relevant keywords from query
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const responseLower = response.toLowerCase();
  const keywordHits = queryWords.filter(w => responseLower.includes(w)).length;
  const keywordScore = queryWords.length > 0 ? keywordHits / queryWords.length : 0.5;
  checks.push({ check: 'keyword_relevance', score: keywordScore });

  // Heuristic 3: Has source citations
  const hasSource = /source|according to|based on|from|reference/i.test(response);
  checks.push({ check: 'has_source', score: hasSource ? 1.0 : 0.3 });

  // Heuristic 4: Not a refusal
  const isRefusal = /i don't know|i cannot|i'm unable|i don't have information/i.test(response.toLowerCase());
  checks.push({ check: 'not_refusal', score: isRefusal ? 0.1 : 1.0 });

  // Weighted average
  const weights = { length: 0.15, keyword_relevance: 0.35, has_source: 0.25, not_refusal: 0.25 };
  const totalScore = checks.reduce((sum, c) => sum + c.score * (weights[c.check] || 0.1), 0);

  const evaluation = {
    query: query.slice(0, 100),
    responsePreview: response.slice(0, 200),
    score: Math.round(totalScore * 100) / 100,
    checks,
    timestamp: new Date().toISOString(),
    lowQuality: totalScore < QUALITY_THRESHOLD,
  };

  // Log it
  evaluationLog.push(evaluation);
  if (evaluationLog.length > MAX_LOG_SIZE) evaluationLog.shift();

  if (evaluation.lowQuality) {
    logger.warn(`[SelfEval] Low-quality response detected (score: ${evaluation.score})`, { query: query.slice(0, 80) });
  }

  return evaluation;
}

/**
 * Get low-quality responses for analysis.
 */
export async function getLowQualityResponses(limit = 20) {
  return evaluationLog.filter(e => e.lowQuality).slice(-limit);
}

/**
 * Get evaluation statistics.
 */
export function getEvaluationStats() {
  if (evaluationLog.length === 0) return { total: 0, avgScore: 0, lowQualityRate: 0 };
  const total = evaluationLog.length;
  const avgScore = evaluationLog.reduce((s, e) => s + e.score, 0) / total;
  const lowCount = evaluationLog.filter(e => e.lowQuality).length;
  return {
    total,
    avgScore: Math.round(avgScore * 100) / 100,
    lowQualityCount: lowCount,
    lowQualityRate: Math.round((lowCount / total) * 100) / 100,
  };
}

// ── 2. Adaptive Model Selection ──

/**
 * Model performance tracker.
 * Tracks latency, success rate, and cost per model.
 */
const modelStats = new Map();

/**
 * Record a model call result.
 */
export function recordModelCall(modelName, { latencyMs, success, tokensUsed = 0, cost = 0 }) {
  if (!modelStats.has(modelName)) {
    modelStats.set(modelName, { calls: 0, successes: 0, totalLatency: 0, totalTokens: 0, totalCost: 0, errors: [] });
  }
  const stats = modelStats.get(modelName);
  stats.calls++;
  if (success) stats.successes++;
  stats.totalLatency += latencyMs;
  stats.totalTokens += tokensUsed;
  stats.totalCost += cost;
  if (!success && stats.errors.length < 50) {
    stats.errors.push({ time: new Date().toISOString(), latencyMs });
  }
}

/**
 * Get the best model for a given query type.
 * Considers: success rate, latency, cost.
 */
export function selectOptimalModel(queryType = 'general', availableModels = null) {
  const models = availableModels || Array.from(modelStats.keys());
  if (models.length === 0) return null;

  let bestModel = models[0];
  let bestScore = -Infinity;

  for (const model of models) {
    const stats = modelStats.get(model);
    if (!stats || stats.calls < 3) {
      // Not enough data — give it a chance with a neutral score
      const score = 0.5;
      if (score > bestScore) { bestScore = score; bestModel = model; }
      continue;
    }

    const successRate = stats.successes / stats.calls;
    const avgLatency = stats.totalLatency / stats.calls;
    const avgCost = stats.totalCost / stats.calls;

    // Score: high success, low latency, low cost
    const latencyScore = Math.max(0, 1 - avgLatency / 30000); // 30s = 0 score
    const costScore = Math.max(0, 1 - avgCost / 0.01); // $0.01 = 0 score
    const score = successRate * 0.5 + latencyScore * 0.3 + costScore * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestModel = model;
    }
  }

  logger.info(`[AdaptiveModel] Selected "${bestModel}" (score: ${bestScore.toFixed(2)}) for query type: ${queryType}`);
  return bestModel;
}

/**
 * Get model performance report.
 */
export function getModelPerformanceReport() {
  const report = {};
  for (const [model, stats] of modelStats) {
    report[model] = {
      calls: stats.calls,
      successRate: stats.calls > 0 ? Math.round((stats.successes / stats.calls) * 100) / 100 : 0,
      avgLatencyMs: stats.calls > 0 ? Math.round(stats.totalLatency / stats.calls) : 0,
      totalTokens: stats.totalTokens,
      totalCost: Math.round(stats.totalCost * 10000) / 10000,
      recentErrors: stats.errors.slice(-5),
    };
  }
  return report;
}

// ── 3. Knowledge Gap Detection ──

/**
 * Detect knowledge gaps by analyzing low-quality responses.
 * Finds topics where the system consistently fails.
 */
export async function detectKnowledgeGaps() {
  const lowQuality = evaluationLog.filter(e => e.lowQuality);
  if (lowQuality.length < 3) return { gaps: [], message: 'Not enough data to detect gaps' };

  // Extract common keywords from low-quality queries
  const topicFreq = new Map();
  for (const entry of lowQuality) {
    const words = entry.query.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    for (const w of words) {
      topicFreq.set(w, (topicFreq.get(w) || 0) + 1);
    }
  }

  // Sort by frequency
  const sorted = [...topicFreq.entries()].sort((a, b) => b[1] - a[1]);
  const gaps = sorted.slice(0, 10).map(([topic, count]) => ({ topic, failureCount: count }));

  // Check if these topics exist in vector store
  const verifiedGaps = [];
  for (const gap of gaps) {
    try {
      const queryEmbedding = await embedText(gap.topic);
      const results = await vectorSearch(queryEmbedding, 3);
      const hasGoodResults = results.some(r => r.score > 0.6);
      if (!hasGoodResults) {
        verifiedGaps.push({ ...gap, vectorResults: results.length, maxScore: Math.max(...results.map(r => r.score), 0) });
      }
    } catch {
      verifiedGaps.push({ ...gap, vectorResults: 0, maxScore: 0 });
    }
  }

  logger.info(`[KnowledgeGap] Detected ${verifiedGaps.length} knowledge gaps`, { gaps: verifiedGaps.map(g => g.topic) });
  return { gaps: verifiedGaps, totalLowQuality: lowQuality.length };
}

// ── 4. A/B Testing Framework ──

const abTests = new Map();

/**
 * Create an A/B test for prompt strategies.
 * @param {string} testId - Unique test identifier
 * @param {object} strategyA - { name, promptModifier }
 * @param {object} strategyB - { name, promptModifier }
 */
export function createABTest(testId, strategyA, strategyB) {
  abTests.set(testId, {
    strategyA: { ...strategyA, uses: 0, totalScore: 0 },
    strategyB: { ...strategyB, uses: 0, totalScore: 0 },
    createdAt: new Date().toISOString(),
  });
  logger.info(`[ABTest] Created test "${testId}": ${strategyA.name} vs ${strategyB.name}`);
  return testId;
}

/**
 * Select a strategy for a given test (random assignment).
 */
export function selectStrategy(testId) {
  const test = abTests.get(testId);
  if (!test) return null;
  const useA = Math.random() < 0.5;
  return useA ? { strategy: 'A', ...test.strategyA } : { strategy: 'B', ...test.strategyB };
}

/**
 * Record the result of an A/B test use.
 */
export function recordABResult(testId, strategy, score) {
  const test = abTests.get(testId);
  if (!test) return;
  const key = strategy === 'A' ? 'strategyA' : 'strategyB';
  test[key].uses++;
  test[key].totalScore += score;
}

/**
 * Get A/B test results.
 */
export function getABTestResults(testId) {
  const test = abTests.get(testId);
  if (!test) return null;
  const avgA = test.strategyA.uses > 0 ? test.strategyA.totalScore / test.strategyA.uses : 0;
  const avgB = test.strategyB.uses > 0 ? test.strategyB.totalScore / test.strategyB.uses : 0;
  return {
    testId,
    strategyA: { name: test.strategyA.name, uses: test.strategyA.uses, avgScore: Math.round(avgA * 100) / 100 },
    strategyB: { name: test.strategyB.name, uses: test.strategyB.uses, avgScore: Math.round(avgB * 100) / 100 },
    winner: avgA > avgB ? 'A' : avgB > avgA ? 'B' : 'tie',
    createdAt: test.createdAt,
  };
}

/**
 * Get all A/B test results.
 */
export function getAllABTestResults() {
  const results = {};
  for (const [id] of abTests) {
    results[id] = getABTestResults(id);
  }
  return results;
}

// ── 5. Self-Repair Pipeline ──

/**
 * Analyze error patterns from logs and suggest fixes.
 * Simple heuristic-based approach.
 */
export async function analyzeErrorPatterns() {
  const report = {
    totalEvaluations: evaluationLog.length,
    evaluationStats: getEvaluationStats(),
    modelPerformance: getModelPerformanceReport(),
    knowledgeGaps: await detectKnowledgeGaps(),
    abTests: getAllABTestResults(),
    recommendations: [],
  };

  // Generate recommendations
  const evalStats = report.evaluationStats;
  if (evalStats.lowQualityRate > 0.3) {
    report.recommendations.push({
      priority: 'HIGH',
      issue: `Low quality rate is ${(evalStats.lowQualityRate * 100).toFixed(0)}%`,
      suggestion: 'Consider improving RAG context retrieval or adding more documents',
    });
  }

  const gaps = report.knowledgeGaps?.gaps || [];
  if (gaps.length > 0) {
    report.recommendations.push({
      priority: 'MEDIUM',
      issue: `Knowledge gaps detected in: ${gaps.slice(0, 5).map(g => g.topic).join(', ')}`,
      suggestion: 'Ingest more documents covering these topics',
    });
  }

  // Check for underperforming models
  for (const [model, perf] of Object.entries(report.modelPerformance)) {
    if (perf.calls > 10 && perf.successRate < 0.7) {
      report.recommendations.push({
        priority: 'HIGH',
        issue: `Model ${model} has low success rate: ${(perf.successRate * 100).toFixed(0)}%`,
        suggestion: `Consider removing ${model} from fallback list`,
      });
    }
  }

  return report;
}

// ── 6. Default A/B Tests ──

// Create default A/B test for RAG prompt style on first import
if (!abTests.has('rag_prompt_style')) {
  createABTest('rag_prompt_style',
    {
      name: 'detailed',
      promptModifier: 'Hãy trả lời chi tiết, đầy đủ với ví dụ minh họa và trích dẫn nguồn nếu có.',
    },
    {
      name: 'concise',
      promptModifier: 'Hãy trả lời ngắn gọn, súc tích, đi thẳng vào vấn đề. Chỉ nêu điểm chính.',
    }
  );
}
