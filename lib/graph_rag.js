/**
 * Graph-Enhanced RAG — Phase 19
 *
 * Combines vector search with knowledge graph traversal for deeper,
 * more contextual answers. Uses the knowledge graph to:
 * 1. Expand query with related entities
 * 2. Find multi-hop relationships between concepts
 * 3. Provide structured context from graph traversal
 *
 * Falls back gracefully if knowledge_graph.db is empty or unavailable.
 */

import { getLogger } from './logger.js';
import { embedText } from './embeddings.js';
import { search as vectorSearch } from './vector_store.js';

const logger = getLogger('GraphRAG');

// ── Graph Context Builder ──

/**
 * Build a context string from graph traversal results.
 */
function formatGraphContext(traversal) {
  if (!traversal || !traversal.nodes || traversal.nodes.length === 0) {
    return '';
  }

  const lines = [];

  // Add entities
  for (const node of traversal.nodes) {
    const desc = node.description ? ` — ${node.description}` : '';
    lines.push(`• ${node.name} (${node.type})${desc}`);
  }

  // Add relationships
  if (traversal.links && traversal.links.length > 0) {
    lines.push('');
    lines.push('Relationships:');
    for (const link of traversal.links.slice(0, 15)) {
      const source = traversal.nodes.find(n => n.id === link.source);
      const target = traversal.nodes.find(n => n.id === link.target);
      if (source && target) {
        lines.push(`  ${source.name} → [${link.label || 'related to'}] → ${target.name}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Extract key entities from a query for graph lookup.
 * Uses simple heuristics: capitalized words, technical terms.
 */
function extractQueryEntities(query) {
  const entities = [];
  const seen = new Set();

  // Capitalized phrases (potential proper nouns / concepts)
  const capitalized = query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  for (const e of capitalized) {
    if (!seen.has(e.toLowerCase()) && e.length > 2) {
      seen.add(e.toLowerCase());
      entities.push(e);
    }
  }

  // Technical terms: camelCase, snake_case, acronyms
  const techTerms = query.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b|\b[A-Z]{2,}\b/g) || [];
  for (const t of techTerms) {
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      entities.push(t);
    }
  }

  // Important Vietnamese terms (words > 4 chars that aren't common)
  const stopWords = ['như thế nào', 'là gì', 'tại sao', 'thế nào', 'có thể', 'những gì', 'được không'];
  const words = query.split(/\s+/).filter(w => w.length > 4 && !stopWords.some(s => w.toLowerCase().includes(s)));
  for (const w of words.slice(0, 3)) {
    if (!seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase());
      entities.push(w);
    }
  }

  return entities.slice(0, 5);
}

/**
 * Enhance RAG answer with graph context.
 * Takes the original query + vector results, finds related entities in the
 * knowledge graph, traverses relationships, and returns enriched context.
 *
 * @param {string} query - Original user query
 * @param {Array} vectorResults - Results from vector search
 * @returns {Promise<{graphContext, relatedEntities, graphError?}>}
 */
export async function enhanceWithGraph(query, vectorResults = []) {
  try {
    // Dynamic import to avoid startup cost
    const { searchEntities, traverseGraph, getRelationships } = await import('./knowledge_graph.js');

    // Extract entities from query
    const queryEntities = extractQueryEntities(query);
    if (queryEntities.length === 0) {
      return { graphContext: '', relatedEntities: [] };
    }

    // Find matching entities in knowledge graph
    const matchedEntities = [];
    for (const entityName of queryEntities) {
      const found = await searchEntities(entityName, null, 3);
      if (found && found.length > 0) {
        matchedEntities.push(found[0]); // Take best match
      }
    }

    if (matchedEntities.length === 0) {
      return { graphContext: '', relatedEntities: [] };
    }

    // Traverse graph from each matched entity
    const allTraversals = [];
    for (const entity of matchedEntities.slice(0, 2)) { // Max 2 starting points
      try {
        const traversal = await traverseGraph(entity.id, 2);
        if (traversal && traversal.nodes && traversal.nodes.length > 1) {
          allTraversals.push(traversal);
        }
      } catch {
        // Skip failed traversals
      }
    }

    if (allTraversals.length === 0) {
      return {
        graphContext: '',
        relatedEntities: matchedEntities.map(e => e.name),
      };
    }

    // Merge traversals and build context
    const mergedNodes = new Map();
    const mergedLinks = new Map();
    for (const t of allTraversals) {
      for (const n of t.nodes) {
        if (!mergedNodes.has(n.id)) mergedNodes.set(n.id, n);
      }
      for (const l of t.links) {
        const key = `${l.source}->${l.target}`;
        if (!mergedLinks.has(key)) mergedLinks.set(key, l);
      }
    }

    const mergedTraversal = {
      nodes: Array.from(mergedNodes.values()),
      links: Array.from(mergedLinks.values()),
    };

    const graphContext = formatGraphContext(mergedTraversal);
    const relatedEntities = matchedEntities.map(e => e.name);

    logger.info(`[GraphRAG] Enhanced query with ${mergedTraversal.nodes.length} entities, ${mergedTraversal.links.length} relationships`);

    return {
      graphContext,
      relatedEntities,
      entityCount: mergedTraversal.nodes.length,
      relationshipCount: mergedTraversal.links.length,
    };
  } catch (err) {
    logger.warn('[GraphRAG] Graph enhancement failed (non-fatal):', err.message);
    return { graphContext: '', relatedEntities: [], graphError: err.message };
  }
}

/**
 * Build an augmented prompt that includes graph context.
 */
export function buildGraphAugmentedPrompt(query, vectorContext, graphContext) {
  let prompt = '';

  if (vectorContext) {
    prompt += `=== Retrieved Documents ===\n${vectorContext}\n\n`;
  }

  if (graphContext) {
    prompt += `=== Knowledge Graph Context ===\n${graphContext}\n\n`;
  }

  prompt += `=== Question ===\n${query}\n\n`;
  prompt += `Answer in natural Vietnamese with Vietnamese diacritics. Use both the retrieved documents and the knowledge graph context to provide a comprehensive answer. If the graph shows relationships between concepts, explain them.`;

  return prompt;
}

/**
 * Get graph-enhanced search statistics.
 */
export async function getGraphRagStats() {
  try {
    const { getGraphStats } = await import('./knowledge_graph.js');
    const stats = await getGraphStats();
    return {
      enabled: true,
      ...stats,
    };
  } catch {
    return { enabled: false, totalEntities: 0, totalEdges: 0 };
  }
}
