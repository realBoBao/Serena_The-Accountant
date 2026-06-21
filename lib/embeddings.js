/**
 * lib/embeddings.js — Embedding with multi-provider fallback
 *
 * Thứ tự:
 *   1. Cache (SQLite)
 *   2. OpenRouter (nomic-embed-text, text-embedding-3-small, v.v.)
 *   3. Local hash-based embedding (deterministic fallback, không cần API)
 *
 * Local fallback tạo 768-dim vector từ text hash — đủ cho similarity search
 * khi không có API key hoặc hết credit.
 */

import 'dotenv/config';
import { getCachedEmbedding, setCachedEmbedding } from './embedding_cache.js';

const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const EMBED_DIM = 768; // Standard embedding dimension

/**
 * Deterministic local embedding — hash-based fallback khi API fail.
 * Tạo 768-dim vector từ text, cùng text luôn cho cùng vector.
 * Đủ cho BM25 + vector hybrid search hoạt động mà không cần API.
 */
function localEmbedText(text) {
  const vec = new Float32Array(EMBED_DIM);
  const str = String(text || '');
  // Simple hash-based embedding: mỗi ký tự contribute vào các dimensions
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const idx = (code * 31 + i * 17) % EMBED_DIM;
    vec[idx] += (code % 100) / 100;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

/**
 * Embed a single text with cache-first strategy + multi-provider fallback.
 */
export async function embedText(text) {
  // 1. Check cache first
  const cached = await getCachedEmbedding(text);
  if (cached) return cached;

  // 2. Try OpenRouter embedding API
  if (OPENROUTER_KEY) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input: text,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data.data?.[0]?.embedding;
        if (embedding && embedding.length > 0) {
          const result = new Float32Array(embedding);
          setCachedEmbedding(text, result).catch(() => {});
          return result;
        }
      }
      // 402 = Payment Required, 429 = Rate Limit → skip OpenRouter for this session
      if (res.status === 402 || res.status === 429) {
        console.warn(`[Embeddings] OpenRouter API ${res.status} (credits/rate limit), dùng local fallback permanently`);
        // Disable OpenRouter for rest of session to avoid spam
        process.env.OPENROUTER_API_KEY = '';
      } else {
        console.warn(`[Embeddings] OpenRouter API ${res.status}, dùng local fallback`);
      }
    } catch (err) {
      console.warn(`[Embeddings] OpenRouter lỗi: ${err.message}, dùng local fallback`);
    }
  }

  // 3. Local fallback (deterministic hash-based)
  return localEmbedText(text);
}

/**
 * Batch embed multiple texts efficiently.
 */
export async function embedTextsBatch(texts) {
  if (!texts || !Array.isArray(texts)) return [];
  const results = [];
  for (const text of texts) {
    try {
      const emb = await embedText(text);
      results.push(emb);
    } catch (err) {
      console.error(`[Embeddings] Batch error: ${err.message}`);
      results.push(new Float32Array(3072)); // zero vector fallback
    }
  }
  return results;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export default { embedText, embedTextsBatch, cosineSimilarity };
