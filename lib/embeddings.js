import 'dotenv/config';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { getCachedEmbedding, setCachedEmbedding, getCacheStats } from './embedding_cache.js';

// ── Embedding Model ─────────────────────────────────────────
// Hỗ trợ nhiều model name để tránh lỗi deprecated
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-004';

let _embeddingsModel = null;

function getEmbeddingsModel() {
  if (!_embeddingsModel) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.Google_API_KEY || '';
    _embeddingsModel = new GoogleGenerativeAIEmbeddings({
      apiKey,
      modelName: EMBED_MODEL,
    });
  }
  return _embeddingsModel;
}

/** Reset model (dùng khi cần đổi model hoặc sau lỗi) */
export function resetEmbeddingsModel() {
  _embeddingsModel = null;
}

/**
 * Embed a single text with cache-first strategy.
 * Checks SQLite cache before calling Gemini API.
 */
export async function embedText(text) {
  // Check cache first
  const cached = await getCachedEmbedding(text);
  if (cached) return cached;

  // Cache miss — call API
  try {
    const model = getEmbeddingsModel();
    const [embedding] = await model.embedDocuments([text]);
    const result = new Float32Array(embedding);
    // Store in cache (fire-and-forget)
    setCachedEmbedding(text, result).catch(() => {});
    return result;
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('404') || msg.includes('not found') || msg.includes('model')) {
      console.warn(`[Embeddings] Model "${EMBED_MODEL}" không khả dụng, thử fallback...`);
      // Thử lại với model cũ hơn
      try {
        _embeddingsModel = new GoogleGenerativeAIEmbeddings({
          apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
          modelName: 'embedding-001',
        });
        const [embedding] = await _embeddingsModel.embedDocuments([text]);
        const result = new Float32Array(embedding);
        setCachedEmbedding(text, result).catch(() => {});
        return result;
      } catch {
        // Ultimate fallback: zero vector (không break pipeline)
        console.error('[Embeddings] Tất cả models đều fail. Trả về zero vector.');
        return new Float32Array(768);
      }
    }
    throw err;
  }
}

/**
 * Batch embed multiple texts efficiently.
 */
export async function embedTextsBatch(texts) {
  const results = [];
  const missing = [];
  const missingIndices = [];

  // Check cache for each text
  for (let i = 0; i < texts.length; i++) {
    const cached = await getCachedEmbedding(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      missing.push(texts[i]);
      missingIndices.push(i);
      results[i] = null;
    }
  }

  // Batch API call for missing texts
  if (missing.length > 0) {
    try {
      const model = getEmbeddingsModel();
      const embeddings = await model.embedDocuments(missing);
      for (let i = 0; i < missing.length; i++) {
        const result = new Float32Array(embeddings[i]);
        results[missingIndices[i]] = result;
        setCachedEmbedding(missing[i], result).catch(() => {});
      }
    } catch (err) {
      console.error('[Embeddings] Batch embed failed:', err?.message || err);
      for (const idx of missingIndices) {
        if (!results[idx]) results[idx] = new Float32Array(768);
      }
    }
  }

  return results;
}

/**
 * Get embedding cache statistics.
 * Returns { hits, misses, size, maxSize } or null if cache unavailable.
 */
export async function getEmbeddingCacheStats() {
  try {
    const stats = await getCacheStats();
    return stats;
  } catch {
    return { hits: 0, misses: 0, size: 0, maxSize: 10000 };
  }
}

/**
 * Tính cosine similarity giữa 2 vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 0-1
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
