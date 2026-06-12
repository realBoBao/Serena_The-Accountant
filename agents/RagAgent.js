import 'dotenv/config';
import { HumanMessage } from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';

import { ask as llmAsk } from '../lib/llm.js';
import { getLogger } from '../lib/logger.js';
import { embedText } from '../lib/embeddings.js';
import { search as vectorSearch } from '../lib/vector_store.js';
import { getPredictedTopic } from '../lib/markov_engine.js';
import { getCachedEmbedding, setCachedEmbedding } from '../lib/embedding_cache.js';
import { searchBm25 } from '../lib/bm25_search.js';
import { recordModelCall, selectOptimalModel } from '../lib/self_evolution.js';
import { enhanceWithGraph, buildGraphAugmentedPrompt } from '../lib/graph_rag.js';
import { startSpan, endSpan, generateTraceId } from '../lib/tracing.js';
import {
  compareResponses,
  learnFromResponse,
  improvePromptWithLearning,
  updateSourcePreference,
  getSourcePreferences,
  setUserPreference,
  getUserPreference,
} from '../lib/cross_model_learner.js';
// Lazy imports for optional features (loaded on demand to reduce startup memory)
let _bandit = null;
let _pagerank = null;
async function getBandit() { if (!_bandit) _bandit = await import('../lib/bandit.js'); return _bandit; }
async function getPagerank() { if (!_pagerank) _pagerank = await import('../lib/graph_pagerank.js'); return _pagerank; }

const similarityThreshold = Number(process.env.DISCORD_SIMILARITY_THRESHOLD || 0.6);
const maxResults = Number(process.env.DISCORD_MAX_RESULTS || 4);
const webSearchLimit = Number(process.env.DISCORD_WEB_SEARCH_LIMIT || 10);

// ── External API Configuration ──────────────────────────
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_MIN_STARS = Number(process.env.GITHUB_MIN_STARS || 10);
const YOUTUBE_MIN_VIEWS = Number(process.env.YOUTUBE_MIN_VIEWS || 10000);

// Collection weights for multi-space search
const COLLECTION_WEIGHTS = {
  academic: Number(process.env.WEIGHT_ACADEMIC || 1.0),
  system: Number(process.env.WEIGHT_SYSTEM || 0.8),
  daily: Number(process.env.WEIGHT_DAILY || 0.9),
};

// Self-reflect config
const SELF_REFLECT_THRESHOLD = Number(process.env.SELF_REFLECT_THRESHOLD || 0.7);
const MAX_REFLECT_RETRIES = Number(process.env.MAX_REFLECT_RETRIES || 2);

// Hybrid search config
const HYBRID_BM25_WEIGHT = Number(process.env.HYBRID_BM25_WEIGHT || 0.3);

const logger = getLogger('RagAgent');

const systemInstruction = 'You are Serena_Project00, an elite AI assistant. If the user asks who you are, introduce yourself proudly as Serena_Project00. Always answer politely and honestly based on available context.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, { retries = 2, baseDelayMs = 800, factor = 2, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = Math.round(baseDelayMs * (factor ** attempt) + Math.random() * 150);
      if (onRetry) onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Embedding with Cache ──
export async function embedTextCached(text) {
  const cached = await getCachedEmbedding(text);
  if (cached) {
    logger.debug('[EmbeddingCache] HIT');
    return cached;
  }
  logger.debug('[EmbeddingCache] MISS');
  const embedding = await embedText(text);
  setCachedEmbedding(text, embedding).catch(() => {});
  return embedding;
}

// ── HyDE (Hypothetical Document Embeddings) ──
// Thay vì embed câu hỏi ngắn → tìm vector gần nhất,
// HyDE dùng LLM sinh ra một "câu trả lời giả định" (hypothetical answer),
// rồi embed câu trả lời đó đi tìm trong Vector DB.
// Giải quyết "bất đối xứng không gian vector": câu hỏi ngắn ≠ tài liệu dài.
const HYDE_ENABLED = process.env.HYDE_ENABLED === 'true';
const HYDE_NUM_HYPOTHETICAL = Number(process.env.HYDE_NUM_HYPOTHETICAL || 1);

async function hydeEmbedQuery(query) {
  if (!HYDE_ENABLED) return embedTextCached(query);

  const hydePrompt = `Bạn là một chuyên gia kiến thức. Dựa trên câu hỏi dưới đây, hãy viết một đoạn văn trả lời CHI TIẾT, ĐẦY ĐỦ (200-500 từ) như thể bạn đang giải thích cho người khác.
QUAN TRỌNG: Chỉ viết nội dung trả lời, KHÔNG giải thích, KHÔNG thêm tiêu đề, KHÔNG markdown.

Câu hỏi: "${query.replace(/"/g, '\\"')}"

Câu trả lời chi tiết:`;

  try {
    const hypotheticalAnswer = await invokeLlm(
      [new HumanMessage(systemInstruction), new HumanMessage(hydePrompt)],
      'HyDE'
    );

    if (hypotheticalAnswer && hypotheticalAnswer.trim().length > 50) {
      logger.info(`[HyDE] Generated hypothetical answer (${hypotheticalAnswer.trim().length} chars)`);

      // Embed câu trả lời giả định thay vì câu hỏi gốc
      const hydeEmbedding = await embedTextCached(hypotheticalAnswer.trim());

      // Kết hợp: 70% HyDE embedding + 30% original query embedding
      const originalEmbedding = await embedTextCached(query);
      const combinedEmbedding = new Float32Array(hydeEmbedding.length);
      for (let i = 0; i < hydeEmbedding.length; i++) {
        combinedEmbedding[i] = hydeEmbedding[i] * 0.7 + originalEmbedding[i] * 0.3;
      }

      return combinedEmbedding;
    }
  } catch (err) {
    logger.warn('[HyDE] Failed, falling back to direct embedding:', err?.message);
  }

  return embedTextCached(query);
}

// ── Query Expansion for Self-Reflect ──
async function expandQuery(originalQuery) {
  if (MAX_REFLECT_RETRIES < 1) return [originalQuery];

  const expansionPrompt = `You are a search query optimizer. Given the user's question, generate 2 alternative search queries that might find better information. Return ONLY a JSON array of strings (no markdown, no explanation).\n\nOriginal question: "${originalQuery.replace(/"/g, '\\"')}"\n\nJSON array:`;

  try {
    const raw = await invokeLlm(
      [
        new HumanMessage(systemInstruction),
        new HumanMessage(expansionPrompt),
      ],
      'QueryExpansion'
    );

    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed) && parsed.length > 0) {
        const expansions = parsed
          .filter((q) => typeof q === 'string' && q.trim().length > 0)
          .slice(0, 2);
        logger.info(`[QueryExpansion] Generated ${expansions.length} expanded queries`);
        return [originalQuery, ...expansions];
      }
    }
  } catch (err) {
    logger.warn('[QueryExpansion] Failed:', err?.message || String(err));
  }

  return [originalQuery];
}

// ── Hybrid Search: Vector + BM25 via RRF (Reciprocal Rank Fusion) ──
// RRF formula: score(d) = Σ 1/(k + rank_i(d)) for each ranking list i
// k=60 is the standard constant (smooths low-rank contributions)
// This is used by Elasticsearch, Qdrant, and other production search systems
const RRF_K = 60;

function mergeHybridResults(vectorResults, bm25Results, bm25Weight = HYBRID_BM25_WEIGHT) {
  const scoreMap = new Map();

  // Build rank-based scores from vector results (sorted by score desc)
  const sortedVec = [...vectorResults].sort((a, b) => b.score - a.score);
  sortedVec.forEach((r, rank) => {
    const key = `${r.doc_id}::${r.chunk_index}`;
    const rrfScore = 1 / (RRF_K + rank + 1); // rank is 0-indexed
    scoreMap.set(key, {
      ...r,
      vectorRank: rank + 1,
      bm25Rank: null,
      vectorScore: r.score,
      bm25Score: 0,
      rrfScore: rrfScore,
    });
  });

  // Merge BM25 results using RRF
  const sortedBm25 = [...bm25Results].sort((a, b) => b.score - a.score);
  sortedBm25.forEach((r, rank) => {
    const key = `${r.doc_id}::${r.chunk_index}`;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(key);

    if (existing) {
      existing.bm25Rank = rank + 1;
      existing.bm25Score = r.score;
      existing.rrfScore += rrfScore;
    } else {
      scoreMap.set(key, {
        ...r,
        vectorRank: null,
        bm25Rank: rank + 1,
        vectorScore: 0,
        bm25Score: r.score,
        rrfScore: rrfScore,
      });
    }
  });

  // Apply BM25 weight: boost docs that appear in both lists
  for (const entry of scoreMap.values()) {
    if (entry.vectorRank && entry.bm25Rank) {
      // Doc appears in both — apply weight bonus
      entry.rrfScore = entry.rrfScore * (1 + bm25Weight);
    }
  }

  return Array.from(scoreMap.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

// ── Local Context Deduplication ──
// Removes duplicate chunks (same doc_id + chunk_index) from merged results
// Keeps the highest-scored version of each unique chunk
function deduplicateLocalResults(results) {
  const seen = new Map();
  for (const r of results) {
    const key = `${r.doc_id}::${r.chunk_index}`;
    const existing = seen.get(key);
    if (!existing || (r.score > existing.score)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

function formatContext(results) {
  return results
    .map((result, index) => {
      const snippet = result.chunk_text.length > 800 ? `${result.chunk_text.slice(0, 800).trim()}...` : result.chunk_text;
      return `Source ${index + 1}: ${result.url || result.doc_id}\n${snippet}`;
    })
    .join('\n\n---\n\n');
}

function formatWebContext(results) {
  return results
    .map((result, index) => {
      const description = result.description ? result.description.trim() : 'No description.';
      const sourceTag = result.source ? `[${result.source.toUpperCase()}] ` : '';
      // Không thêm URL ở đây vì formatSourcesWithScore đã có hyperlink
      return `Nguồn ${index + 1}: ${sourceTag}${result.title}\n${description}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Format search results with score (weight) for display.
 * Used by Discord bot, REST API, and webhook notifications.
 * 
 * @param {Array} results - Array of result objects with score, title, url, source, etc.
 * @param {string} type - 'local' for vector/BM25 results, 'web' for web search results
 * @param {number} maxItems - Max number of sources to show (default 5)
 * @returns {string} Formatted source list with scores
 */
function formatSourcesWithScore(results, type = 'web', maxItems = 5) {
  if (!results || results.length === 0) return '';

  // Deduplicate by URL
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.url || r.title || '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const items = deduped.slice(0, maxItems);
  const lines = [];

  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const score = r.score != null ? Number(r.score).toFixed(3) : 'N/A';
    const title = r.title || r.doc_id || r.url || `Source ${i + 1}`;
    const url = r.url || '';
    const source = r.source || (type === 'local' ? 'vector' : 'web');

    // Score bar: ████░░░░░░ (visual weight indicator)
    // Score is already normalized to 0-1
    const scoreNum = r.score != null ? Number(r.score) : 0;
    const barLen = Math.min(10, Math.max(0, Math.round(scoreNum * 10)));
    const scoreBar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);

    // Dùng Markdown hyperlink [title](url) thay vì URL riêng
    const linkedTitle = url ? `[${title.slice(0, 80)}](${url})` : title.slice(0, 80);
    let line = `**${i + 1}.** [${source.toUpperCase()}] ${linkedTitle}\n`;
    line += `   📊 Score: **${scoreNum.toFixed(3)}** ${scoreBar}`;

    // Extra metadata for web results
    if (type === 'web') {
      if (r.views) line += ` | 👁 ${Number(r.views).toLocaleString()} views`;
      if (r.stars) line += ` | ⭐ ${Number(r.stars).toLocaleString()}`;
      if (r.likes) line += ` | ❤ ${Number(r.likes).toLocaleString()}`;
      if (r.channelTitle) line += `\n   📺 ${r.channelTitle}`;
      if (r.language) line += ` | 🌐 ${r.language}`;
    }

    // Extra metadata for local results
    if (type === 'local') {
      if (r.collection) line += ` | 📁 ${r.collection}`;
      if (r.hybridScore != null) line += ` | hybrid: ${r.hybridScore.toFixed(3)}`;
    }

    lines.push(line);
  }

  return lines.join('\n\n');
}

function formatResponse(response) {
  if (typeof response === 'string') return response;
  if (response?.text) return response.text;
  if (Array.isArray(response?.content)) {
    return response.content.map((block) => (typeof block === 'string' ? block : JSON.stringify(block))).join('');
  }
  return String(response);
}

// ── [SỬA LỖI 1]: TÍCH HỢP LLM GATEWAY CHUYỂN HƯỚNG OPENROUTER ──
export async function invokeLlm(messages, label) {
  // Chuyển LangChain messages → plain text cho unified LLM layer
  const systemMsg = messages.find(m => m._getType?.() === 'system');
  const userMsg = messages.filter(m => m._getType?.() === 'human' || m._getType?.() === 'user');
  const lastUser = userMsg[userMsg.length - 1]?.content || messages[messages.length - 1]?.content || '';

  const systemPrompt = systemMsg?.content || systemInstruction;

  // Bandit-based prompt strategy selection (Thompson Sampling)
  let banditStrategy = null;
  let query = lastUser;
  if (process.env.BANDIT_ENABLED === 'true') {
    try {
      const bandit = await getBandit();
      banditStrategy = bandit.selectPromptStrategy('general');
      if (banditStrategy?.promptModifier) {
        query = lastUser + '\n\n' + banditStrategy.promptModifier;
      }
      logger.debug(`[Bandit] Selected strategy: ${banditStrategy.strategy}`);
    } catch (e) { /* bandit optional */ }
  }

  const startTime = Date.now();

  try {
    // Dùng unified LLM layer: Gemini → OpenRouter → Local → Static
    const result = await llmAsk(query, {
      systemPrompt,
      temperature: 0.2,
      maxTokens: 1024,
    });

    const latencyMs = Date.now() - startTime;
    recordModelCall(result.model, { latencyMs, success: true });

    // Auto-evaluate and feed back to bandit
    if (banditStrategy) {
      const qualityScore = Math.min(result.answer.length / 500, 1.0) * 0.5 + (/source|according to|dựa trên/i.test(result.answer) ? 0.5 : 0);
      try { const bandit = await getBandit(); bandit.recordBanditFeedback(banditStrategy.strategy, qualityScore); } catch (e) { /* optional */ }
    }

    logger.info(`[LLM Gateway] ${label} → ${result.provider}/${result.model}`);
    return result.answer;
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    recordModelCall('unknown', { latencyMs, success: false });
    throw err;
  }
}

async function translateToEnglish(text) {
  try {
    const result = await llmAsk(text, {
      systemPrompt: 'Translate the following Vietnamese text into fluent English. Return only the English translation, nothing else.',
      temperature: 0.1,
    });
    // Nếu LLM return static fallback → translation fail, dùng text gốc
    if (result.provider === 'static' || result.answer.includes('chế độ offline')) {
      logger.warn('[Translate] LLM returned static fallback, using original text');
      return text;
    }
    return result.answer || text;
  } catch {
    logger.warn('Translation fallback due to error');
    return text;
  }
}

// ── [SỬA LỖI 3]: CẬP NHẬT TRUYỀN localResults VÀO ĐỒ THỊ KNOWLEDGE GRAPH ──
async function getGraphEnhancedContext(query, localResults = []) {
  if (process.env.GRAPH_ENHANCED_RAG !== 'true') return '';
  try {
    const { graphContext } = await enhanceWithGraph(query, localResults);
    if (graphContext) return '\n\n=== Knowledge Graph Context ===\n' + graphContext;
  } catch (err) {
    logger.debug('[GraphRAG] Enhancement skipped:', err?.message || err);
  }
  return '';
}

async function localRetrieval(query, biasTopic, queryEmbedding) {
  const { searchAcademic, searchSystem, searchDaily } = await import('../lib/vector_collections.js');

  const [academicResults, systemResults, dailyResults] = await Promise.allSettled([
    searchAcademic(queryEmbedding, 6),
    searchSystem(queryEmbedding, 4),
    searchDaily(queryEmbedding, 4),
  ]);

  const weightResults = (results, weight) => results.map((r) => ({ ...r, score: r.score * weight }));

  const allResults = [
    ...(academicResults.status === 'fulfilled' ? weightResults(academicResults.value, COLLECTION_WEIGHTS.academic) : []),
    ...(systemResults.status === 'fulfilled' ? weightResults(systemResults.value, COLLECTION_WEIGHTS.system) : []),
    ...(dailyResults.status === 'fulfilled' ? weightResults(dailyResults.value, COLLECTION_WEIGHTS.daily) : []),
  ];

  return allResults
    .map((item) => {
      let score = item.score;
      if (biasTopic && item.metadata) {
        const normalizedTitle = String(item.metadata.title || '').toLowerCase();
        const normalizedTopic = String(biasTopic || '').toLowerCase();
        if (normalizedTitle.includes(normalizedTopic) || String(item.metadata.topic || '').toLowerCase() === normalizedTopic) {
          score *= 1.2;
        }
      }
      return { ...item, score };
    })
    .filter((item) => item.score > similarityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

async function hybridLocalRetrieval(query, biasTopic) {
  // Dùng HyDE embedding nếu enabled, ngược lại dùng embedding trực tiếp
  const queryEmbedding = await hydeEmbedQuery(query);

  const [vectorResults, bm25Results] = await Promise.allSettled([
    localRetrieval(query, biasTopic, queryEmbedding),
    searchBm25(query, maxResults + 2),
  ]);

  const vecRes = vectorResults.status === 'fulfilled' ? vectorResults.value : [];
  const bm25Res = bm25Results.status === 'fulfilled' ? bm25Results.value : [];

  if (HYBRID_BM25_WEIGHT === 0 || bm25Res.length === 0) return vecRes;
  if (vecRes.length === 0) return bm25Res.slice(0, maxResults);

  const merged = mergeHybridResults(vecRes, bm25Res, HYBRID_BM25_WEIGHT);
  const deduped = deduplicateLocalResults(merged);

  // Apply PageRank boost if graph data available
  if (process.env.PAGERANK_ENABLED === 'true') {
    try {
      const pagerank = await getPagerank();
      const prScores = await pagerank.getPageRankScores();
      if (prScores.size > 0) {
        const boosted = pagerank.applyPageRankBoost(deduped, prScores, 0.15);
        return boosted.slice(0, maxResults);
      }
    } catch (err) {
      logger.debug('[PageRank] Boost skipped:', err?.message || err);
    }
  }

  return deduped.slice(0, maxResults);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Web Scout — Kiến trúc Tìm kiếm Lai (Hybrid Search Routing)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2 luồng chạy song song:
 *   🛰️ Tavily  — Trinh sát mở đường (General Web Scout)
 *   🎯 Google  — Thấu kính học thuật (Specialized Lens, 50 domains)
 *
 * Smart Router tự động chọn luồng dựa trên intent classification.
 * Circuit Breaker: Google fail → fallback Tavily.
 *
 * Ngoài ra giữ lại YouTube + GitHub search riêng (đã có API key).
 */
async function webScout(query) {
  const allResults = [];

  // ── YouTube & GitHub search (giữ nguyên, chạy song song) ──
  const [youtubeResults, githubResults, hybridResults] = await Promise.allSettled([
    searchYouTube(query),
    searchGitHub(query),
    // 🧠 Hybrid Search Router (Google Custom Search + Tavily)
    (async () => {
      try {
        const { hybridWebScout, formatHybridContext } = await import('../lib/hybrid_search.js');
        const { results, source } = await hybridWebScout(query, { maxResults: webSearchLimit });
        if (results.length > 0) {
          logger.info(`[HybridSearch] ${source}: ${results.length} results`);
        }
        return results;
      } catch (err) {
        logger.debug('[HybridSearch] Error:', err?.message || err);
        return [];
      }
    })(),
  ]);

  if (youtubeResults.status === 'fulfilled' && youtubeResults.value.length) {
    allResults.push(...youtubeResults.value);
    logger.info(`[WebScout] youtube: ${youtubeResults.value.length} results`);
  }
  if (githubResults.status === 'fulfilled' && githubResults.value.length) {
    allResults.push(...githubResults.value);
    logger.info(`[WebScout] github: ${githubResults.value.length} results`);
  }
  if (hybridResults.status === 'fulfilled' && hybridResults.value.length) {
    allResults.push(...hybridResults.value);
    logger.info(`[WebScout] hybrid: ${hybridResults.value.length} results`);
  }

  // Sort by score giảm dần
  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Deduplicate theo URL
  const seen = new Set();
  const deduped = allResults.filter(r => {
    const key = r.url || r.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Diversification: Nếu query giống query gần đây → skip web search ──
  const queryFingerprint = query.toLowerCase().trim().slice(0, 80);
  if (isDuplicateQuery(queryFingerprint)) {
    logger.info(`[WebScout] Duplicate query detected — skipping web search`);
    // Chỉ trả về local results (nếu có), không search web
    const localOnly = deduped.filter(r => r.source === 'local' || r.type === 'local');
    return localOnly.slice(0, webSearchLimit);
  }
  // Lưu query fingerprint cho lần sau
  saveQueryFingerprint(queryFingerprint);

  logger.info(`[WebScout] Total: ${deduped.length} results (YouTube + GitHub + Hybrid)`);
  return deduped.slice(0, webSearchLimit);
}

// ─── Query Deduplication ───────────────────────────────────
// Nếu query giống query trong 4h qua → bỏ qua web search
const QUERY_DEDUP_FILE = path.join(process.cwd(), '.query_dedup.json');

function isDuplicateQuery(fingerprint) {
  try {
    if (fs.existsSync(QUERY_DEDUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUERY_DEDUP_FILE, 'utf8'));
      const cutoff = Date.now() - 4 * 3600 * 1000; // 4 giờ
      for (const [fp, ts] of Object.entries(data)) {
        if (ts > cutoff && isSimilarQuery(fp, fingerprint)) {
          return true;
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

function saveQueryFingerprint(fingerprint) {
  try {
    let data = {};
    if (fs.existsSync(QUERY_DEDUP_FILE)) {
      data = JSON.parse(fs.readFileSync(QUERY_DEDUP_FILE, 'utf8'));
    }
    data[fingerprint] = Date.now();
    // Cleanup old entries
    const cutoff = Date.now() - 4 * 3600 * 1000;
    for (const [fp, ts] of Object.entries(data)) {
      if (ts < cutoff) delete data[fp];
    }
    fs.writeFileSync(QUERY_DEDUP_FILE, JSON.stringify(data), 'utf8');
  } catch { /* ignore */ }
}

// So sánh 2 query → trả về true nếu giống nhau (>90% similarity)
function isSimilarQuery(a, b) {
  if (a === b) return true;
  // So sánh word overlap
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size > 0.8;
}

// ─── User Source Tracking (File-based) ─────────────────────
// Lưu sources đã hiển thị cho user để tránh trùng lặp
// Persist vào file để survive PM2 restarts
const USER_SOURCES_FILE = path.join(process.cwd(), '.user_sources.json');

async function getSeenSources(userId) {
  try {
    if (fs.existsSync(USER_SOURCES_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_SOURCES_FILE, 'utf8'));
      const cutoff = Date.now() - 24 * 3600 * 1000; // 24 giờ
      const seen = new Set();
      const userData = data[userId] || {};
      for (const [sid, ts] of Object.entries(userData)) {
        if (ts > cutoff) seen.add(sid);
      }
      return seen;
    }
  } catch { /* ignore */ }
  return new Set();
}

async function markSourceSeen(userId, sourceId) {
  try {
    let data = {};
    if (fs.existsSync(USER_SOURCES_FILE)) {
      data = JSON.parse(fs.readFileSync(USER_SOURCES_FILE, 'utf8'));
    }
    if (!data[userId]) data[userId] = {};
    data[userId][sourceId] = Date.now();
    // Giới hạn max 500 sources per user
    const keys = Object.keys(data[userId]);
    if (keys.length > 500) {
      const oldest = keys.sort((a, b) => data[userId][a] - data[userId][b])[0];
      delete data[userId][oldest];
    }
    fs.writeFileSync(USER_SOURCES_FILE, JSON.stringify(data), 'utf8');
  } catch { /* ignore */ }
}

// ─── YouTube Search ────────────────────────────────────────
async function searchYouTube(query) {
  if (!YOUTUBE_API_KEY) {
    logger.debug('[WebScout] YouTube: No API key');
    return [];
  }

  try {
    const searchQuery = encodeURIComponent(query);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${searchQuery}&type=video&order=viewCount&maxResults=${webSearchLimit}&key=${YOUTUBE_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 403) throw new Error('YouTube API quota exceeded or invalid key');
      return [];
    }
    const data = await res.json();
    const items = data?.items || [];
    if (!items.length) return [];

    const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
    if (!videoIds) return [];

    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const statsRes = await fetch(statsUrl);
    if (!statsRes.ok) return [];
    const statsData = await statsRes.json();

    const results = [];
    const seenVideoIds = new Set();
    for (const video of statsData?.items || []) {
      // Deduplicate by video ID
      if (seenVideoIds.has(video.id)) continue;
      seenVideoIds.add(video.id);
      const views = parseInt(video?.statistics?.viewCount || 0);
      const likes = parseInt(video?.statistics?.likeCount || 0);
      if (views < YOUTUBE_MIN_VIEWS) continue;

      // Normalize score to 0-1 range (10M views + 100k likes ≈ 1.0)
      const score = Math.min(1, (Math.log10(views + 1) * 10 + Math.log10(likes + 1) * 5) / 100);
      results.push({
        title: `[YouTube] ${video?.snippet?.title || ''}`,
        description: `${(video?.snippet?.description || '').slice(0, 300)}\nKênh: ${video?.snippet?.channelTitle || ''} | Views: ${views.toLocaleString()} | Likes: ${likes.toLocaleString()}`,
        url: `https://www.youtube.com/watch?v=${video?.id}`,
        source: 'youtube',
        score,
        views,
        likes,
        channelTitle: video?.snippet?.channelTitle || '',
      });
    }
    return results;
  } catch (err) {
    logger.debug('[WebScout] YouTube error:', err?.message || err);
    return [];
  }
}

// ─── GitHub Search ─────────────────────────────────────────
async function searchGitHub(query) {
  if (!GITHUB_TOKEN) {
    logger.warn('[WebScout] GitHub: No GITHUB_TOKEN configured — skipping GitHub search');
    return [];
  }

  try {
    const searchQuery = encodeURIComponent(`${query} stars:>=${GITHUB_MIN_STARS}`);
    const url = `https://api.github.com/search/repositories?q=${searchQuery}&sort=stars&order=desc&per_page=${webSearchLimit}`;

    logger.info(`[WebScout] GitHub: Searching "${query}" (minStars=${GITHUB_MIN_STARS})`);

    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'my-ai-brain',
      },
    });

    if (!res.ok) {
      if (res.status === 401) {
        logger.warn('[WebScout] GitHub: Token invalid (401) — check GITHUB_TOKEN');
        return [];
      }
      if (res.status === 403) {
        const rateLimitReset = res.headers.get('x-ratelimit-reset');
        const resetTime = rateLimitReset ? new Date(Number(rateLimitReset) * 1000).toISOString() : 'unknown';
        logger.warn(`[WebScout] GitHub: Rate limited (403) — resets at ${resetTime}`);
        return [];
      }
      if (res.status === 422) {
        // Retry với simplified query (bỏ special characters)
        logger.warn('[WebScout] GitHub: Query rejected (422) — retrying with simplified query');
        try {
          const simpleQuery = encodeURIComponent(query.replace(/[^a-zA-Z0-9\s]/g, '').trim());
          const retryUrl = `https://api.github.com/search/repositories?q=${simpleQuery}&sort=stars&order=desc&per_page=${webSearchLimit}`;
          const retryRes = await fetch(retryUrl, {
            headers: {
              'Authorization': `token ${GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'my-ai-brain',
            },
          });
          if (retryRes.ok) {
            const data = await retryRes.json();
            logger.info(`[WebScout] GitHub: Retry succeeded — ${(data?.items || []).length} results`);
            return (data?.items || []).map(repo => {
              const stars = repo.stargazers_count || 0;
              const forks = repo.forks_count || 0;
              const score = Math.min(1, (Math.log10(stars + 1) * 15 + Math.log10(forks + 1) * 8) / 100);
              return {
                title: `[GitHub] ${repo.full_name} ⭐${stars.toLocaleString()}`,
                description: `${repo.description || 'No description'}\nLanguage: ${repo.language || 'N/A'} | Forks: ${forks.toLocaleString()} | Updated: ${repo.updated_at?.slice(0, 10)}`,
                url: repo.html_url,
                source: 'github',
                score,
                stars,
                forks,
              };
            });
          }
        } catch (retryErr) {
          logger.warn('[WebScout] GitHub: Retry also failed:', retryErr.message);
        }
        return [];
      }
      logger.warn(`[WebScout] GitHub: HTTP ${res.status} — ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const items = data?.items || [];
    const totalCount = data?.total_count ?? 0;

    logger.info(`[WebScout] GitHub: ${items.length} results returned (total_count=${totalCount})`);

    if (!items.length) {
      logger.warn(`[WebScout] GitHub: 0 results for "${query}" — try lowering GITHUB_MIN_STARS (current: ${GITHUB_MIN_STARS}) or check token permissions`);
      return [];
    }

    return items.map(repo => {
      const stars = repo.stargazers_count || 0;
      const forks = repo.forks_count || 0;
      // Normalize score to 0-1 range (100k stars + 10k forks ≈ 1.0)
      const score = Math.min(1, (Math.log10(stars + 1) * 15 + Math.log10(forks + 1) * 8) / 100);
      return {
        title: `[GitHub] ${repo.full_name} ⭐${stars.toLocaleString()}`,
        description: `${repo.description || 'No description'}\nLanguage: ${repo.language || 'N/A'} | Forks: ${forks.toLocaleString()} | Updated: ${repo.updated_at?.slice(0, 10)}`,
        url: repo.html_url,
        source: 'github',
        score,
        stars,
        forks,
      };
    });
  } catch (err) {
    logger.warn('[WebScout] GitHub error:', err?.message || err);
    return [];
  }
}

async function synthesizeAnswer(query, context, sourceType, userId = null) {
  // Build source quality summary for the LLM
  let sourceInfo = '';
  if (sourceType === 'web') {
    // Extract source types from context
    const sources = context.match(/\[(YOUTUBE|GITHUB|FACEBOOK|WEB)\]/g) || [];
    const uniqueSources = [...new Set(sources)];
    sourceInfo = `\n📊 Đánh giá nguồn: ${uniqueSources.join(', ')}`;
    sourceInfo += '\n- YouTube: Độ tin cậy cao (video có view/like thực tế từ kênh nổi tiếng)';
    sourceInfo += '\n- GitHub: Độ tin cậy cao (repo có star/fork thực tế, code review cộng đồng)';
    sourceInfo += '\n- Facebook: Độ tin cậy trung bình (post công khai, cần xác minh thêm)';
    sourceInfo += '\n- Web: Độ tin cậy thấp nhất (generic, cần cross-check)';
  }

  // ── User Profile Context ──
  let profileContext = '';
  if (userId) {
    try {
      const { userProfileManager } = await import('../lib/user_profile.js');
      profileContext = userProfileManager.buildSystemContext(userId);
    } catch { /* profile optional */ }
  }

  const prompt = sourceType === 'web'
    ? `Local data is missing. Use the following Web Context to answer in natural Vietnamese with Vietnamese diacritics. If URLs are available, cite them at the end.${sourceInfo}\n\n⚠️ QUAN TRỌNG: Ưu tiên thông tin từ nguồn đáng tin cậy nhất (YouTube > GitHub > Facebook > Web). Nếu các nguồn mâu thuẫn, dùng nguồn có độ tin cậy cao hơn.${profileContext ? '\n\n' + profileContext : ''}\n\nWeb Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`
    : `Use the system Context below to answer the question in natural Vietnamese with Vietnamese diacritics. If the context is not enough, clearly say that you could not find suitable data and suggest how to search or rephrase.${profileContext ? '\n\n' + profileContext : ''}\n\nContext:\n${context}\n\nQuestion: ${query}\n\nAnswer:`;

  try {
    return await invokeLlm([new HumanMessage(systemInstruction), new HumanMessage(prompt)], 'LLM');
  } catch (err) {
    logger.warn('[RagAgent] synthesizeAnswer LLM failed, using context fallback:', err?.message);
    // Fallback: trả về context summary khi LLM không available
    const contextSummary = context.slice(0, 2000);
    return `⚠️ LLM tạm thời không khả dụng (rate limited). Dưới đây là thông tin tham khảo:\n\n${contextSummary}`;
  }
}

async function selfReflectAnswerGate({ query, answer, results, source }) {
  // Skip gate nếu answer quá ngắn hoặc quá dài (đã đủ tự tin)
  if (answer.length < 50 || answer.length > 3000) {
    return { pass: true, reason: 'skip-gate-length' };
  }

  // Skip gate nếu source là local vector search (đã có context)
  if (source === 'local' && results?.length > 0) {
    return { pass: true, reason: 'skip-gate-local' };
  }

  const contextSummary = results?.length ? formatRetrievedSnippets(results) : '(no retrieved context)';

  const gatePrompt = `Evaluate if the ANSWER correctly addresses the QUESTION based on CONTEXT. Return JSON: {"pass": true|false, "reason": "brief", "safeAnswer": "if false"}\n\nQ: ${query}\nA: ${answer.slice(0, 500)}\nJSON:`;

  try {
    const raw = await invokeLlm([new HumanMessage(gatePrompt)], 'SelfReflectGate');

    // Robust JSON extraction
    let jsonText = raw.trim();
    // Remove markdown code blocks
    jsonText = jsonText.replace(/```(?:json)?\s*/g, '').replace(/```$/g, '');
    // Find first { and last }
    const jsonStart = jsonText.indexOf('{');
    const jsonEnd = jsonText.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      jsonText = jsonText.slice(jsonStart, jsonEnd + 1);
    }
    const parsed = JSON.parse(jsonText);

    const pass = Boolean(parsed?.pass);
    const reason = parsed?.reason ? String(parsed.reason) : 'unknown';
    if (pass) return { pass: true, reason };

    const safeAnswer = parsed?.safeAnswer ? String(parsed.safeAnswer) : null;
    return { pass: false, reason, safeAnswer };
  } catch (err) {
    logger.warn('Self-reflect gate failed:', err?.message || String(err));
    // Nếu gate fail → cho qua (đừng block câu trả lời)
    return { pass: true, reason: 'gate-error-open' };
  }
}

function formatRetrievedSnippets(results) {
  return (results || [])
    .slice(0, 6)
    .map((r, i) => {
      const src = r.url || r.doc_id || `local:${i + 1}`;
      const chunk = String(r.chunk_text || '').replace(/\s+/g, ' ').trim();
      return `(${i + 1}) ${src}: ${chunk.slice(0, 420)}${chunk.length > 420 ? '...' : ''}`;
    })
    .join('\n');
}

export async function answerQuestion(query, options = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    return {
      answer: 'Ban chua gui cau hoi. Hay nhap noi dung sau lenh `!ask`.',
      source: 'validation',
      results: [],
    };
  }

  // ── Distributed Tracing ──
  const traceId = options.traceId || generateTraceId();
  const rootSpan = startSpan('RagAgent.answerQuestion', {
    traceId,
    query: cleanQuery.slice(0, 200),
    source: 'rag-agent',
  });

  const predictedTopic = options.biasTopic || (await getPredictedTopic());
  let lastError = null;

  const formatErrorForUser = (err) => {
    const msg = err?.message ? String(err.message) : '';
    const responseData = err?.response?.data
      ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
      : null;
    const stack = err?.stack ? String(err.stack) : '';

    const parts = [];
    if (msg) parts.push(msg);
    if (responseData) parts.push(responseData);
    if (!parts.length && stack) parts.push(stack.slice(0, 800));

    return parts.join(' | ').trim() || 'Unknown error';
  };

  try {
    const localResults = await hybridLocalRetrieval(cleanQuery, predictedTopic);

    let graphContext = '';
    if (localResults.length > 0) {
      // ── [SỬA LỖI 3]: KÍCH HOẠT GRAPH CONTEXT BẰNG DỮ LIỆU ĐÃ TRUY XUẤT ──
      graphContext = await getGraphEnhancedContext(cleanQuery, localResults);
    }

    if (localResults.length) {
      const context = formatContext(localResults) + graphContext;

      const answer = await synthesizeAnswer(cleanQuery, context, 'local');
      const gate = await selfReflectAnswerGate({
        query: cleanQuery,
        answer,
        results: localResults,
        source: 'local',
      });

      if (gate.pass) {
        // ── Cross-Model Learning: học từ response tốt ──
        if (options.userId && getUserPreference(options.userId).learningEnabled) {
          learnFromResponse(cleanQuery, answer, 'local', localResults).catch(() => {});
          updateSourcePreference(predictedTopic, 'local', gate.pass ? 0.8 : 0.3);
        }
        return { answer, source: 'local', results: localResults, predictedTopic, sourcesFormatted: formatSourcesWithScore(localResults, 'local') };
      }

      // ── Query Expansion with Promise.any (Fast-Exit) ──
      const expandedQueries = await expandQuery(cleanQuery);
      const queriesToRetry = expandedQueries.slice(1, MAX_REFLECT_RETRIES + 1);

      if (queriesToRetry.length > 0) {
        logger.info(`[QueryExpansion] Fast-exit race for: ${queriesToRetry.join(', ')}`);

        // Each query runs the full pipeline: retrieve → synthesize → self-reflect
        // First one to PASS the gate wins — others are abandoned
        const racingTasks = queriesToRetry.map(async (expandedQuery, index) => {
          const retryResults = await hybridLocalRetrieval(expandedQuery, predictedTopic);
          if (!retryResults.length) throw new Error('no_results');

          const retryContext = formatContext(retryResults);
          const retryAnswer = await synthesizeAnswer(cleanQuery, retryContext, 'local');

          const retryGate = await selfReflectAnswerGate({
            query: cleanQuery,
            answer: retryAnswer,
            results: retryResults,
            source: `local-expanded-${index + 1}`,
          });

          if (!retryGate.pass) throw new Error('gate_failed');

          return {
            answer: retryAnswer,
            source: `local-expanded-${index + 1}`,
            results: retryResults,
            sourcesFormatted: formatSourcesWithScore(retryResults, 'local'),
          };
        });

        // Promise.any: first to PASS wins, ignore the rest
        try {
          const winner = await Promise.any(racingTasks);
          logger.info(`[QueryExpansion] Fast-exit winner: ${winner.source}`);
          return { ...winner, predictedTopic };
        } catch (err) {
          // All queries failed the gate or had no results
          logger.info('[QueryExpansion] All expanded queries failed gate');
        }
      }

      const fallbackSnippet = formatRetrievedSnippets(localResults);
      const safe = gate.safeAnswer || `Toi khong dam bao cau tra loi nay hoan toan dung vi du lieu hien co chua du. Duoi day la cac mảnh thong tin de ban doi chieu:\n\n${fallbackSnippet}`;
      return { answer: safe, source: 'local', results: localResults, predictedTopic, sourcesFormatted: formatSourcesWithScore(localResults, 'local') };
    }
  } catch (err) {
    logger.warn('Local synthesize/retrieval failed:', err?.message || String(err));
    lastError = err;
  }

  // Web search fallback
  try {
    const webQuery = await translateToEnglish(cleanQuery);
    const webResults = await webScout(webQuery);

    if (webResults.length) {
      const context = formatWebContext(webResults);
      const answer = await synthesizeAnswer(cleanQuery, context, 'web');

      const gate = await selfReflectAnswerGate({
        query: cleanQuery,
        answer,
        results: webResults,
        source: 'web',
      });

      // ── Source Deduplication: Loại source đã hiển thị cho user ──
      const userId = options.userId || 'anonymous';
      const seenSources = await getSeenSources(userId);
      const freshWebResults = webResults.filter(r => {
        const sid = (r.url || r.title || '').toLowerCase().slice(0, 60);
        return !seenSources.has(sid);
      });
      // Lưu sources hiện tại cho lần sau
      for (const r of webResults) {
        const sid = (r.url || r.title || '').toLowerCase().slice(0, 60);
        await markSourceSeen(userId, sid);
      }
      // Nếu có source mới → dùng source mới, không thì dùng tất cả
      const finalResults = freshWebResults.length > 0 ? freshWebResults : webResults;

      if (gate.pass) {
        // ── Cross-Model Learning: học từ response tốt ──
        if (options.userId && getUserPreference(options.userId).learningEnabled) {
          learnFromResponse(cleanQuery, answer, 'web', finalResults).catch(() => {});
          updateSourcePreference(predictedTopic, 'web', gate.pass ? 0.8 : 0.3);
        }
        return { answer, source: 'web', results: finalResults, predictedTopic, sourcesFormatted: formatSourcesWithScore(finalResults, 'web') };
      }

      const fallbackSnippet = formatRetrievedSnippets(finalResults);
      const safe = gate.safeAnswer || `Toi khong dam bao cau tra loi nay hoan toan dung vi du lieu hien co chua du. Duoi day la cac mảnh thong tin de ban doi chieu:\n\n${fallbackSnippet}`;
      return { answer: safe, source: 'web', results: finalResults, predictedTopic, sourcesFormatted: formatSourcesWithScore(finalResults, 'web') };
    }
  } catch (err) {
    logger.warn('Web synthesize failed:', err?.message || String(err));
    lastError = err;
  }

  // Final error
  const finalAnswer = lastError
    ? `❌ **Hệ thống gặp sự cố!**\n🔍 **Nguyên nhân kỹ thuật:** \`${formatErrorForUser(lastError)}\``
    : 'Hiện tại tôi chưa thể tạo câu trả lời do không tìm thấy dữ liệu hoặc nghẽn mạng.';

  endSpan(rootSpan, { error: lastError, output: finalAnswer.slice(0, 200) });

  return {
    answer: finalAnswer,
    source: 'error',
    results: [],
    predictedTopic,
    traceId,
  };
}