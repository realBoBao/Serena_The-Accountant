/**
 * Graph-based RAG with PageRank
 *
 * Implements PageRank algorithm on the knowledge graph to determine
 * entity importance based on connection structure, not just vector similarity.
 *
 * Uses graphology for graph operations + PageRank computation.
 * Falls back to SQLite-backed lightweight PageRank if graphology unavailable.
 *
 * Integration: Called by RagAgent after vector search to re-rank results
 * using graph importance scores.
 */

import { getLogger } from './logger.js';

const logger = getLogger('GraphPageRank');

// ── Lightweight PageRank (no external dependency) ──
// Implements PageRank directly on adjacency list from SQLite

/**
 * Compute PageRank scores for all entities in the knowledge graph.
 * Uses iterative power method with damping factor.
 *
 * @param {object} opts
 * @param {number} opts.damping - Damping factor (default 0.85)
 * @param {number} opts.maxIterations - Max iterations (default 30)
 * @param {number} opts.tolerance - Convergence tolerance (default 1e-6)
 * @param {number} opts.limit - Max entities to compute (default 5000)
 * @returns {Promise<Map<string, number>>} entity_id → pagerank score
 */
export async function computePageRank({ damping = 0.85, maxIterations = 30, tolerance = 1e-6, limit = 5000 } = {}) {
  try {
    const { getAllEntities, getAllEdges } = await import('./knowledge_graph.js');

    const entities = await getAllEntities(limit);
    if (!entities || entities.length === 0) {
      logger.debug('[PageRank] No entities in graph');
      return new Map();
    }

    const edges = await getAllEdges(limit * 5);
    const n = entities.length;

    // Build adjacency list
    const outgoing = new Map(); // entity_id → [target_ids]
    const incoming = new Map(); // entity_id → [source_ids]
    const entityIds = new Set();

    for (const e of entities) {
      entityIds.add(e.id);
      if (!outgoing.has(e.id)) outgoing.set(e.id, []);
      if (!incoming.has(e.id)) incoming.set(e.id, []);
    }

    for (const edge of edges) {
      if (entityIds.has(edge.source_id) && entityIds.has(edge.target_id)) {
        outgoing.get(edge.source_id)?.push(edge.target_id);
        incoming.get(edge.target_id)?.push(edge.source_id);
      }
    }

    // Initialize PageRank scores uniformly
    const scores = new Map();
    const baseScore = 1 / n;
    for (const id of entityIds) {
      scores.set(id, baseScore);
    }

    // Power iteration
    for (let iter = 0; iter < maxIterations; iter++) {
      const newScores = new Map();
      let danglingSum = 0;

      // Compute dangling node contribution
      for (const id of entityIds) {
        const outLinks = outgoing.get(id) || [];
        if (outLinks.length === 0) {
          danglingSum += scores.get(id) || 0;
        }
      }

      let maxDiff = 0;

      for (const id of entityIds) {
        const inLinks = incoming.get(id) || [];
        let rank = (1 - damping) / n;

        // Contribution from incoming links
        for (const sourceId of inLinks) {
          const sourceOutCount = (outgoing.get(sourceId) || []).length;
          if (sourceOutCount > 0) {
            rank += damping * ((scores.get(sourceId) || 0) / sourceOutCount);
          }
        }

        // Contribution from dangling nodes
        rank += damping * danglingSum / n;

        newScores.set(id, rank);

        const diff = Math.abs(rank - (scores.get(id) || 0));
        if (diff > maxDiff) maxDiff = diff;
      }

      // Update scores
      for (const [id, score] of newScores) {
        scores.set(id, score);
      }

      // Check convergence
      if (maxDiff < tolerance) {
        logger.info(`[PageRank] Converged after ${iter + 1} iterations (n=${n})`);
        break;
      }
    }

    logger.info(`[PageRank] Computed scores for ${scores.size} entities`);
    return scores;
  } catch (err) {
    logger.warn('[PageRank] Computation failed:', err.message);
    return new Map();
  }
}

/**
 * Get PageRank-boosted scores for a set of entity IDs.
 * Combines vector similarity with graph importance.
 *
 * @param {Array} vectorResults - Results from vector search (with entity references)
 * @param {Map<string, number>} pageRankScores - Pre-computed PageRank scores
 * @param {number} boostWeight - How much to weight PageRank (0-1, default 0.2)
 * @returns {Array} Re-ranked results with combined scores
 */
export function applyPageRankBoost(vectorResults, pageRankScores, boostWeight = 0.2) {
  if (!pageRankScores || pageRankScores.size === 0) return vectorResults;

  // Normalize PageRank scores to [0, 1]
  let maxPR = 0;
  for (const score of pageRankScores.values()) {
    if (score > maxPR) maxPR = score;
  }
  if (maxPR === 0) return vectorResults;

  const normalizedPR = new Map();
  for (const [id, score] of pageRankScores) {
    normalizedPR.set(id, score / maxPR);
  }

  // Apply boost to results that have entity references
  const boosted = vectorResults.map(r => {
    // Check if result has an associated entity ID (from graph-enhanced search)
    const entityId = r.entity_id || r.id;
    const prScore = normalizedPR.get(entityId) || 0;

    // Combined score: (1 - weight) * vector_score + weight * pagerank_score
    const vectorScore = r.score || 0;
    const combined = (1 - boostWeight) * vectorScore + boostWeight * prScore;

    return {
      ...r,
      score: combined,
      pagerankScore: prScore,
      vectorScore,
    };
  });

  // Re-sort by combined score
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * Cache for PageRank scores (recomputed periodically, not per-query)
 */
let _cachedScores = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached PageRank scores (compute if stale).
 */
export async function getPageRankScores(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedScores && (now - _cacheTime) < CACHE_TTL_MS) {
    return _cachedScores;
  }

  _cachedScores = await computePageRank();
  _cacheTime = now;
  return _cachedScores;
}

/**
 * Invalidate PageRank cache (call after graph updates).
 */
export function invalidatePageRankCache() {
  _cachedScores = null;
  _cacheTime = 0;
}
