/**
 * lib/semantic_fingerprint.js — Semantic Fingerprinting for Memory Deduplication
 *
 * Khi nạp tài liệu mới vào Vector DB:
 * 1. Tính semantic hash (fingerprint) từ vector embedding
 * 2. So sánh với các fingerprint đã có trong DB
 * 3. Nếu similarity > 98% → không tạo mới, chỉ "củng cố" (strengthen) node trong Knowledge Graph
 * 4. Nếu similarity 85-98% → tạo mới nhưng link vào node gốc (merge relationship)
 * 5. Nếu similarity < 85% → tạo mới hoàn toàn
 *
 * Giúp AI không bị "lẩm cẩm" vì thông tin trùng lặp.
 *
 * Usage:
 *   import { checkDuplicate, strengthenNode } from './semantic_fingerprint.js';
 *   const { action, existingId, similarity } = await checkDuplicate(newContent, 'academic');
 */

import crypto from 'crypto';
import { embedText } from './embeddings.js';
import { cosineSimilarity } from './embeddings.js';
import { getLogger } from './logger.js';

const logger = getLogger('SemanticFingerprint');

// ── Thresholds ──────────────────────────────────────────
const THRESHOLD_IDENTICAL = 0.98;  // > 98% → duplicate, strengthen
const THRESHOLD_SIMILAR = 0.85;   // 85-98% → similar, merge
const THRESHOLD_NEW = 0.85;       // < 85% → new document

// ── In-memory fingerprint cache ────────────────────────
// Trong production, lưu vào Redis hoặc SQLite
const fingerprintCache = new Map(); // space → [{ id, hash, vectorSample }]

/**
 * Tính semantic fingerprint từ text
 * @param {string} text
 * @returns {object} { hash, vector }
 */
export async function computeFingerprint(text) {
  const vector = await embedText(text.slice(0, 2000));  // First 2000 chars for speed
  if (!vector) return null;

  // Tạo hash từ vector (quantized)
  const quantized = vector.map(v => Math.round(v * 100) / 100);  // Reduce precision
  const hash = crypto.createHash('sha256').update(JSON.stringify(quantized)).digest('hex');

  return { hash, vector, quantized };
}

/**
 * Kiểm tra xem tài liệu mới có trùng/similar với cái đã có không
 *
 * @param {string} newContent — Nội dung mới
 * @param {string} space — Vector DB space (academic, system, daily)
 * @returns {object} { action: 'identical'|'similar'|'new', existingId, similarity, existingHash }
 */
export async function checkDuplicate(newContent, space = 'academic') {
  const fingerprint = await computeFingerprint(newContent);
  if (!fingerprint) {
    return { action: 'new', existingId: null, similarity: 0 };
  }

  const spaceCache = fingerprintCache.get(space) || [];

  let bestMatch = null;
  let bestSimilarity = 0;

  for (const existing of spaceCache) {
    // Quick hash check
    if (fingerprint.hash === existing.hash) {
      return { action: 'identical', existingId: existing.id, similarity: 1.0, existingHash: existing.hash };
    }

    // Cosine similarity (chỉ check nếu hash prefix giống — optimization)
    if (fingerprint.hash.slice(0, 8) === existing.hash.slice(0, 8)) {
      const sim = cosineSimilarity(fingerprint.vector, existing.vector);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = existing;
      }
    }
  }

  // Full scan nếu không có hash prefix match
  if (!bestMatch && spaceCache.length < 1000) {  // Only scan if cache is small
    for (const existing of spaceCache) {
      const sim = cosineSimilarity(fingerprint.vector, existing.vector);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = existing;
      }
    }
  }

  // Xác định action
  if (bestSimilarity >= THRESHOLD_IDENTICAL) {
    logger.info(`[Fingerprint] IDENTICAL (${bestSimilarity.toFixed(3)}) → strengthen node ${bestMatch.id}`);
    return { action: 'identical', existingId: bestMatch.id, similarity: bestSimilarity, existingHash: bestMatch.hash };
  }

  if (bestSimilarity >= THRESHOLD_SIMILAR) {
    logger.info(`[Fingerprint] SIMILAR (${bestSimilarity.toFixed(3)}) → merge with ${bestMatch.id}`);
    return { action: 'similar', existingId: bestMatch.id, similarity: bestSimilarity, existingHash: bestMatch.hash };
  }

  // New document → add to cache
  const newId = `doc:${space}:${Date.now()}:${fingerprint.hash.slice(0, 8)}`;
  spaceCache.push({ id: newId, hash: fingerprint.hash, vector: fingerprint.vector });
  fingerprintCache.set(space, spaceCache);

  logger.info(`[Fingerprint] NEW document → ${newId} (best similarity: ${bestSimilarity.toFixed(3)})`);
  return { action: 'new', existingId: null, similarity: bestSimilarity, newId };
}

/**
 * Củng cố node trong Knowledge Graph (tăng weight)
 * Gọi khi phát hiện duplicate
 */
export async function strengthenNode(nodeId, additionalWeight = 0.1) {
  try {
    const { upsertEntity, getEntity } = await import('./knowledge_graph.js');
    const entity = await getEntity(nodeId);

    if (entity) {
      const newWeight = (entity.weight || 1) + additionalWeight;
      await upsertEntity(nodeId, { ...entity, weight: newWeight, strengthenedAt: new Date().toISOString() });
      logger.info(`[Fingerprint] Strengthened node ${nodeId} → weight: ${newWeight.toFixed(2)}`);
    }
  } catch (err) {
    logger.warn('[Fingerprint] strengthenNode error:', err.message);
  }
}

/**
 * Merge relationship — link document mới vào document gốc
 * Gọi khi phát hiện similar (85-98%)
 */
export async function mergeRelationship(newId, existingId, similarity) {
  try {
    const { addRelationship } = await import('./knowledge_graph.js');
    await addRelationship(existingId, newId, 'similar_to', { similarity, mergedAt: new Date().toISOString() });
    logger.info(`[Fingerprint] Merged ${newId} → ${existingId} (similarity: ${similarity.toFixed(3)})`);
  } catch (err) {
    logger.warn('[Fingerprint] mergeRelationship error:', err.message);
  }
}

/**
 * Cleanup cache khi quá lớn
 */
export function cleanupFingerprintCache(maxSize = 5000) {
  for (const [space, cache] of fingerprintCache) {
    if (cache.length > maxSize) {
      // Giữ lại 80% mới nhất
      const keep = Math.floor(maxSize * 0.8);
      fingerprintCache.set(space, cache.slice(-keep));
      logger.info(`[Fingerprint] Cleaned ${space} cache: ${cache.length} → ${keep}`);
    }
  }
}

export default { computeFingerprint, checkDuplicate, strengthenNode, mergeRelationship, cleanupFingerprintCache };
