/**
 * Lazy Loading Agents — Phase 17: Performance Optimization
 *
 * Dynamically imports agents only when needed, reducing memory footprint
 * at startup. Maintains a cache of loaded agents to avoid repeated imports.
 *
 * Usage:
 *   const agent = await loadAgent('RagAgent');
 *   const result = await agent.answerQuestion(query);
 */

import { getLogger } from './logger.js';

const logger = getLogger('LazyAgents');

// Agent registry: maps agent names to their module paths
const AGENT_REGISTRY = {
  RagAgent: () => import('../agents/RagAgent.js'),
  PdfAgent: () => import('../agents/PdfAgent.js'),
  VisionAgent: () => import('../agents/VisionAgent.js'),
  VoiceAgent: () => import('../agents/VoiceAgent.js'),
  DebateAgent: () => import('../agents/DebateAgent.js'),
  ManimAgent: () => import('../agents/ManimAgent.js'),
  CoderAgent: () => import('../agents/CoderAgent.js'),
  PlannerAgent: () => import('../agents/PlannerAgent.js'),
  EvoAgent: () => import('../agents/EvoAgent.js'),
  GraphAgent: () => import('../agents/GraphAgent.js'),
  RouterAgent: () => import('../agents/RouterAgent.js'),
  InteractionAgent: () => import('../agents/InteractionAgent.js'),
};

// Cache for loaded agent modules
const agentCache = new Map();

// Memory tracking
let totalLoads = 0;
let cacheHits = 0;

/**
 * Load an agent module dynamically, with caching.
 * @param {string} agentName - Name of the agent (must be in AGENT_REGISTRY)
 * @returns {Promise<object>} - The loaded agent module
 */
export async function loadAgent(agentName) {
  // Check cache first
  if (agentCache.has(agentName)) {
    cacheHits++;
    logger.debug(`[LazyAgents] Cache HIT for ${agentName}`);
    return agentCache.get(agentName);
  }

  const loader = AGENT_REGISTRY[agentName];
  if (!loader) {
    throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(AGENT_REGISTRY).join(', ')}`);
  }

  logger.info(`[LazyAgents] Loading agent: ${agentName}`);
  totalLoads++;

  try {
    const module = await loader();
    agentCache.set(agentName, module);
    return module;
  } catch (err) {
    logger.error(`[LazyAgents] Failed to load ${agentName}:`, err.message);
    throw err;
  }
}

/**
 * Preload multiple agents in parallel.
 * @param {string[]} agentNames - Array of agent names to preload
 */
export async function preloadAgents(agentNames) {
  await Promise.allSettled(agentNames.map(name => loadAgent(name)));
}

/**
 * Unload an agent from cache to free memory.
 * @param {string} agentName - Name of the agent to unload
 */
export function unloadAgent(agentName) {
  if (agentCache.has(agentName)) {
    agentCache.delete(agentName);
    logger.info(`[LazyAgents] Unloaded agent: ${agentName}`);
  }
}

/**
 * Unload all cached agents.
 */
export function unloadAll() {
  agentCache.clear();
  logger.info('[LazyAgents] All agents unloaded');
}

/**
 * Get lazy loading statistics.
 */
export function getStats() {
  return {
    cached: Array.from(agentCache.keys()),
    cacheSize: agentCache.size,
    totalLoads,
    cacheHits,
    hitRate: totalLoads > 0 ? Math.round((cacheHits / (cacheHits + totalLoads)) * 100) : 0,
    available: Object.keys(AGENT_REGISTRY),
  };
}

/**
 * Check if an agent is currently cached.
 */
export function isLoaded(agentName) {
  return agentCache.has(agentName);
}
