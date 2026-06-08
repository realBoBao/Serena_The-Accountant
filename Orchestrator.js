/**
 * Orchestrator — Event-driven orchestration layer
 *
 * Nhận events từ Discord Bot / REST API / Scheduler
 * → Chuyển thành (intent, context) → Gọi RouterAgent
 * → RouterAgent quyết định agent nào được "thức dậy"
 *
 * Orchestrator KHÔNG gọi agent trực tiếp nữa.
 * Mọi routing đều đi qua RouterAgent.
 */

import EventEmitter from 'events';
import { routerAgent } from './agents/RouterAgent.js';
import { getLogger } from './lib/logger.js';

const logger = getLogger('Orchestrator');

// ── Event Type → Intent Mapping ──
const EVENT_INTENT_MAP = {
  pdf_file: 'PDF',
  discord_question: 'RAG',
  discord_interaction: 'INTERACTION',
  repo_url: 'RAG',
  vision_request: 'VISION',
  voice_request: 'VOICE',
  debate_request: 'DEBATE',
  animate_request: 'ANIMATE',
  planner_request: 'PLANNER',
  vision_planner_request: 'VISION_PLANNER',
};

class Orchestrator extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * Route event đến agent phù hợp thông qua RouterAgent
   */
  async route(event) {
    try {
      const intent = EVENT_INTENT_MAP[event.type];
      if (!intent) {
        throw new Error(`Unsupported event type: ${event.type}`);
      }

      // Build context từ event
      const context = this._buildContext(event);

      // Gọi RouterAgent (mọi request đi qua đây)
      const { result, agent, error } = await routerAgent.route(intent, context);

      if (error) {
        logger.warn(`Routing failed for ${event.type}: ${error}`);
        return { error, agent };
      }

      return result;
    } catch (error) {
      logger.error(`Orchestrator error: ${error.message}`);
      this.emit('error', error, event);
      return { error: error.message || String(error) };
    }
  }

  /**
   * Build context object từ event data
   */
  _buildContext(event) {
    switch (event.type) {
      case 'pdf_file':
        return { filePath: event.filePath };
      case 'discord_question':
        return { query: event.query, options: { biasTopic: event.biasTopic } };
      case 'discord_interaction':
        return { topic: event.topic };
      case 'repo_url':
        return { query: event.url };
      case 'vision_request':
        return {
          imageBuffer: event.imageBuffer,
          mimeType: event.mimeType,
          prompt: event.prompt,
        };
      case 'voice_request':
        return {
          audioBuffer: event.audioBuffer,
          options: event.options || {},
        };
      case 'debate_request':
        return {
          query: event.query,
          quick: event.quick || false,
        };
      case 'animate_request':
        return {
          query: event.query,
          async: event.async || false,
          compress: event.compress || false,
        };
      case 'planner_request':
        return {
          query: event.query,
          context: event.context || '',
        };
      case 'vision_planner_request':
        return {
          imageBuffer: event.imageBuffer,
          mimeType: event.mimeType,
          query: event.query || '',
          context: event.context || '',
        };
      default:
        return { ...event };
    }
  }

  // ── State Toggle API (proxy đến RouterAgent) ──

  setAgentState(agentKey, enabled) {
    return routerAgent.setAgentState(agentKey, enabled);
  }

  getAgentStates() {
    return routerAgent.getAgentStates();
  }

  setAllAgents(enabled) {
    return routerAgent.setAllAgents(enabled);
  }

  getStats() {
    return routerAgent.getStats();
  }
}

export const orchestrator = new Orchestrator();
