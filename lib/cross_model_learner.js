/**
 * ═══════════════════════════════════════════════════════════════
 * Cross-Model Learner — Học chéo giữa các LLM models
 * ═══════════════════════════════════════════════════════════════
 *
 * Ý tưởng:
 * - Khi OpenRouter trả lời tốt → lưu pattern để Gemini học theo
 * - Khi Gemini trả lời tốt → lưu pattern để OpenRouter học theo
 * - Tạo "best practices" từ cả 2 models
 * - User có thể chọn sở thích: ưu tiên model nào, ưu tiên source nào
 *
 * Flow:
 * 1. User gửi query
 * 2. Hệ thống gọi cả 2 models (OpenRouter + Gemini) song song
 * 3. So sánh quality score
 * 4. Lưu response tốt hơn vào "learning DB"
 * 5. Lần sau, dùng pattern từ response tốt để improve prompt
 */

import { getLogger } from './logger.js';
import { evaluateResponse } from './self_evolution.js';
import { embedTextCached } from '../agents/RagAgent.js';
import { search as vectorSearch } from './vector_store.js';

const logger = getLogger('CrossModelLearner');

// ── User Preferences ──
const userPreferences = new Map(); // userId → preferences

export function setUserPreference(userId, prefs) {
  userPreferences.set(userId, {
    preferredModel: prefs.preferredModel || 'auto',      // 'openrouter' | 'gemini' | 'auto'
    preferredSources: prefs.preferredSources || [],       // ['youtube', 'github', 'stackoverflow']
    learningEnabled: prefs.learningEnabled !== false,     // true = học từ responses
    ...prefs,
  });
  logger.info(`[CrossModel] User ${userId} preferences updated:`, prefs);
}

export function getUserPreference(userId) {
  return userPreferences.get(userId) || {
    preferredModel: 'auto',
    preferredSources: [],
    learningEnabled: true,
  };
}

// ── Response Quality Comparison ──
const responseHistory = []; // Lưu lịch sử responses để học
const MAX_HISTORY = 500;

/**
 * So sánh quality của 2 responses từ 2 models khác nhau.
 * Trả về model tốt hơn + quality scores.
 */
export async function compareResponses(query, responseA, responseB, modelA, modelB) {
  const evalA = await evaluateResponse(query, responseA);
  const evalB = await evaluateResponse(query, responseB);

  const winner = evalA.score >= evalB.score ? 'A' : 'B';
  const winnerResponse = winner === 'A' ? responseA : responseB;
  const winnerModel = winner === 'A' ? modelA : modelB;
  const loserModel = winner === 'A' ? modelB : modelA;

  const comparison = {
    query: query.slice(0, 100),
    modelA,
    modelB,
    scoreA: evalA.score,
    scoreB: evalB.score,
    winner,
    winnerModel,
    scoreDiff: Math.abs(evalA.score - evalB.score),
    timestamp: new Date().toISOString(),
  };

  // Lưu vào history
  responseHistory.push(comparison);
  if (responseHistory.length > MAX_HISTORY) responseHistory.shift();

  logger.info(`[CrossModel] ${modelA}(${evalA.score.toFixed(2)}) vs ${modelB}(${evalB.score.toFixed(2)}) → Winner: ${winnerModel}`);

  return { comparison, winnerResponse, winnerModel, evalA, evalB };
}

// ── Learning from Good Responses ──
const learnedPatterns = new Map(); // queryPattern → bestResponsePattern

/**
 * Học từ response tốt hơn.
 * Extract patterns (cách trả lời, cấu trúc, nguồn) để dùng cho lần sau.
 */
export async function learnFromResponse(query, goodResponse, model, sources = []) {
  try {
    // Extract key patterns từ response
    const patterns = extractPatterns(goodResponse);

    // Embed query để tìm similar queries
    const queryEmbedding = await embedTextCached(query);

    // Lưu pattern
    const key = query.slice(0, 50).toLowerCase();
    learnedPatterns.set(key, {
      patterns,
      model,
      sources: sources.map(s => s.source || s.type || 'unknown'),
      score: patterns.qualityScore,
      useCount: 0,
      lastUsed: null,
      createdAt: new Date().toISOString(),
    });

    logger.info(`[CrossModel] Learned pattern for "${query.slice(0, 40)}..." from ${model}`);

    // Giới hạn size
    if (learnedPatterns.size > 1000) {
      const oldest = learnedPatterns.keys().next().value;
      learnedPatterns.delete(oldest);
    }
  } catch (err) {
    logger.warn('[CrossModel] Learning failed:', err.message);
  }
}

/**
 * Extract patterns từ một response tốt.
 */
function extractPatterns(response) {
  const patterns = {
    hasStructure: /#{1,3}\s|^\d+\.\s|^\s*[-*]/m.test(response),
    hasSources: /source|according to|based on|from|http/i.test(response),
    hasExamples: /example|ví dụ|for instance|such as/i.test(response),
    hasCode: /```|`[^`]+`/.test(response),
    avgSentenceLength: response.split(/[.!?]+/).filter(s => s.trim().length > 10).length,
    wordCount: response.split(/\s+/).length,
    qualityScore: 0,
  };

  // Tính quality score dựa trên patterns
  let score = 0.5;
  if (patterns.hasStructure) score += 0.15;
  if (patterns.hasSources) score += 0.15;
  if (patterns.hasExamples) score += 0.1;
  if (patterns.hasCode) score += 0.05;
  if (patterns.wordCount > 100 && patterns.wordCount < 1000) score += 0.05;
  patterns.qualityScore = Math.min(1, score);

  return patterns;
}

/**
 * Tạo improved prompt dựa trên learned patterns.
 * Nếu query giống query đã học → thêm hints từ pattern tốt.
 */
export async function improvePromptWithLearning(query, basePrompt) {
  const key = query.slice(0, 50).toLowerCase();
  const learned = learnedPatterns.get(key);

  if (!learned) return basePrompt;

  // Tìm similar patterns
  const similarPatterns = [];
  for (const [k, v] of learnedPatterns) {
    if (k !== key && querySimilarity(key, k) > 0.7) {
      similarPatterns.push(v);
    }
  }

  if (similarPatterns.length === 0) return basePrompt;

  // Tạo hints từ patterns
  const hints = [];
  const bestPattern = similarPatterns.sort((a, b) => b.score - a.score)[0];

  if (bestPattern.patterns.hasStructure) {
    hints.push('Trả lời có cấu trúc rõ ràng với headings và bullet points.');
  }
  if (bestPattern.patterns.hasSources) {
    hints.push('Trích dẫn nguồn tham khảu khi có thể.');
  }
  if (bestPattern.patterns.hasExamples) {
    hints.push('Đưa ra ví dụ cụ thể minh họa.');
  }
  if (bestPattern.patterns.hasCode) {
    hints.push('Bao gồm code examples nếu phù hợp.');
  }

  // Thêm source preferences
  if (bestPattern.sources.length > 0) {
    const uniqueSources = [...new Set(bestPattern.sources)];
    hints.push(`Ưu tiên nguồn từ: ${uniqueSources.join(', ')}.`);
  }

  if (hints.length === 0) return basePrompt;

  const improvedPrompt = `${basePrompt}\n\n💡 HINTS từ lịch sử học:\n${hints.map(h => `- ${h}`).join('\n')}`;

  // Update use count
  learned.useCount++;
  learned.lastUsed = new Date().toISOString();

  return improvedPrompt;
}

function querySimilarity(a, b) {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.length / union.size;
}

// ── Source Preference Learning ──
const sourcePreferences = new Map(); // queryType → { source: score }

/**
 * Cập nhật source preference dựa trên user feedback hoặc quality score.
 */
export function updateSourcePreference(queryType, source, qualityScore) {
  if (!sourcePreferences.has(queryType)) {
    sourcePreferences.set(queryType, new Map());
  }
  const sources = sourcePreferences.get(queryType);
  const current = sources.get(source) || { totalScore: 0, count: 0 };
  current.totalScore += qualityScore;
  current.count++;
  sources.set(source, current);
}

/**
 * Lấy source preferences cho một query type.
 * Trả về danh sách sources được sắp xếp theo preference score.
 */
export function getSourcePreferences(queryType) {
  const sources = sourcePreferences.get(queryType);
  if (!sources) return [];

  return [...sources.entries()]
    .map(([source, { totalScore, count }]) => ({
      source,
      avgScore: totalScore / count,
      count,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);
}

// ── Statistics ──
export function getLearningStats() {
  return {
    totalComparisons: responseHistory.length,
    learnedPatterns: learnedPatterns.size,
    sourcePreferences: Object.fromEntries(
      [...sourcePreferences.entries()].map(([k, v]) => [k, [...v.entries()].length])
    ),
    recentWinners: responseHistory.slice(-10).map(r => ({
      query: r.query.slice(0, 50),
      winner: r.winnerModel,
      scoreDiff: r.scoreDiff,
    })),
  };
}

export { responseHistory, learnedPatterns };
