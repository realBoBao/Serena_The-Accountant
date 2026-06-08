/**
 * Router Agent — Trung tâm điều phối tất cả Agents
 *
 * Nguyên tắc "Agent-in-the-loop":
 * - Mọi yêu cầu từ Discord/Voice/Vision phải đi qua Router trước
 * - Router quyết định Agent nào được phép "thức dậy"
 * - Agent không được tự ý gọi nhau vô tận
 * - Hỗ trợ State Toggle: bật/tắt từng agent từ Admin Dashboard
 *
 * Usage: import { routerAgent } from './RouterAgent.js'
 */

import { getLogger } from '../lib/logger.js';

const logger = getLogger('RouterAgent');

// ── Agent Registry ──
// Đăng ký tất cả agents với metadata
const AGENT_REGISTRY = {
  rag: {
    name: 'RagAgent',
    description: 'RAG-powered Q&A, web search, knowledge retrieval',
    import: () => import('./RagAgent.js'),
    enabled: true,  // Có thể toggle từ Dashboard
    cost: 'medium', // Token cost: low/medium/high
  },
  pdf: {
    name: 'PdfAgent',
    description: 'PDF processing, text extraction, flashcard generation',
    import: () => import('./PdfAgent.js'),
    enabled: true,
    cost: 'high',
  },
  debate: {
    name: 'DebateAgent',
    description: 'Multi-agent debate (Coder vs Rag → Judge)',
    import: () => import('./DebateAgent.js'),
    enabled: true,
    cost: 'high',
  },
  manim: {
    name: 'ManimAgent',
    description: 'AI animation video generation via Manim',
    import: () => import('./ManimAgent.js'),
    enabled: true,
    cost: 'high',
  },
  interaction: {
    name: 'InteractionAgent',
    description: 'Discord interaction tracking, Markov prediction',
    import: () => import('./InteractionAgent.js'),
    enabled: true,
    cost: 'low',
  },
  vision: {
    name: 'VisionAgent',
    description: 'Image analysis via Gemini Vision',
    import: () => import('./VisionAgent.js'),
    enabled: true,
    cost: 'medium',
  },
  voice: {
    name: 'VoiceAgent',
    description: 'Voice message transcription via whisper.cpp',
    import: () => import('./VoiceAgent.js'),
    enabled: true,
    cost: 'low',
  },
  planner: {
    name: 'PlannerAgent',
    description: 'DAG Task Planner — analyzes intent and creates task graphs',
    import: () => import('./PlannerAgent.js'),
    enabled: true,
    cost: 'medium',
  },
  coder: {
    name: 'CoderAgent',
    description: 'Algorithm expert — write, run, debug code with AddressSanitizer',
    import: () => import('./CoderAgent.js'),
    enabled: true,
    cost: 'high',
  },
  analysis: {
    name: 'AnalysisAgent',
    description: 'URL analyzer — GitHub repo, YouTube video, web page → summary + flashcards',
    import: () => import('./AnalysisAgent.js'),
    enabled: true,
    cost: 'high',
  },
};

// ── Intent → Agent Mapping ──
// Mỗi intent chỉ được route đến agent đã đăng ký
const INTENT_AGENT_MAP = {
  RAG: ['rag'],
  CODE: ['coder'],
  MEMORY: ['rag'],
  PDF: ['pdf'],
  DEBATE: ['debate'],
  ANIMATE: ['manim'],
  INTERACTION: ['interaction'],
  VISION: ['vision'],
  VOICE: ['voice'],
  CHAT: ['rag'],
  PLANNER: ['planner'],
  VISION_PLANNER: ['vision'],
  ANALYZE: ['analysis'],
};

class RouterAgent {
  constructor() {
    this._agentCache = new Map();  // Lazy-loaded agent modules
    this._stats = {
      totalRequests: 0,
      agentCalls: {},
      errors: 0,
    };
  }

  // ── State Toggle API (cho Admin Dashboard) ──

  /**
   * Bật/tắt một agent
   * @param {string} agentKey - Key trong AGENT_REGISTRY (rag, pdf, debate, ...)
   * @param {boolean} enabled
   */
  setAgentState(agentKey, enabled) {
    if (!AGENT_REGISTRY[agentKey]) {
      throw new Error(`Unknown agent: ${agentKey}`);
    }
    AGENT_REGISTRY[agentKey].enabled = enabled;
    logger.info(`Agent ${agentKey} ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return this.getAgentStates();
  }

  /**
   * Lấy trạng thái tất cả agents
   */
  getAgentStates() {
    const states = {};
    for (const [key, agent] of Object.entries(AGENT_REGISTRY)) {
      states[key] = {
        name: agent.name,
        enabled: agent.enabled,
        cost: agent.cost,
        description: agent.description,
        cached: this._agentCache.has(key),
      };
    }
    return states;
  }

  /**
   * Bật/tắt tất cả agents cùng lúc
   */
  setAllAgents(enabled) {
    for (const key of Object.keys(AGENT_REGISTRY)) {
      AGENT_REGISTRY[key].enabled = enabled;
    }
    logger.info(`All agents ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return this.getAgentStates();
  }

  // ── Routing Core ──

  /**
   * Route request đến agent phù hợp
   * @param {string} intent - Intent type (RAG, CODE, PDF, DEBATE, ...)
   * @param {object} context - Request context { query, filePath, url, ... }
   * @returns {object} { result, agent, cached }
   */
  async route(intent, context = {}) {
    this._stats.totalRequests++;

    const agentKeys = INTENT_AGENT_MAP[intent];
    if (!agentKeys || agentKeys.length === 0) {
      logger.warn(`No agent mapped for intent: ${intent}`);
      return { result: null, agent: null, error: `No agent for intent: ${intent}` };
    }

    // Lấy agent đầu tiên enabled trong danh sách
    const agentKey = agentKeys.find(k => AGENT_REGISTRY[k]?.enabled);
    if (!agentKey) {
      logger.warn(`All agents disabled for intent: ${intent}`);
      return { result: null, agent: null, error: `All agents disabled for intent: ${intent}` };
    }

    const agent = AGENT_REGISTRY[agentKey];
    logger.info(`Routing intent "${intent}" → ${agent.name}`);

    try {
      // Lazy load agent module (chỉ import khi cần)
      const module = await this._loadAgent(agentKey);

      // Gọi agent function phù hợp
      const result = await this._dispatch(agentKey, module, intent, context);

      // Update stats
      this._stats.agentCalls[agentKey] = (this._stats.agentCalls[agentKey] || 0) + 1;

      return { result, agent: agentKey, cached: this._agentCache.has(agentKey) };
    } catch (err) {
      this._stats.errors++;
      logger.error(`Agent ${agentKey} failed: ${err.message}`);
      return { result: null, agent: agentKey, error: err.message };
    }
  }

  /**
   * Lazy load agent module (cache sau khi load)
   */
  async _loadAgent(agentKey) {
    if (this._agentCache.has(agentKey)) {
      return this._agentCache.get(agentKey);
    }

    const agent = AGENT_REGISTRY[agentKey];
    const module = await agent.import();
    this._agentCache.set(agentKey, module);
    logger.info(`Agent ${agent.name} loaded and cached`);
    return module;
  }

  /**
   * Dispatch đến function phù hợp trong agent module
   */
  async _dispatch(agentKey, module, intent, context) {
    switch (agentKey) {
      case 'rag':
        if (intent === 'RAG' || intent === 'CHAT' || intent === 'MEMORY') {
          return await module.answerQuestion(context.query, context.options || {});
        }
        return await module.answerQuestion(context.query, context.options || {});

      case 'pdf':
        return await module.processPdf(context.filePath);

      case 'debate': {
        const quick = context.quick || false;
        return quick
          ? await module.quickDebate(context.query)
          : await module.runDebate(context.query);
      }

      case 'manim': {
        const asyncRender = context.async || false;
        if (asyncRender) {
          return await module.createAnimationAsync(context.query);
        }
        const compress = context.compress || false;
        return compress
          ? await module.createAnimationWithCompression(context.query)
          : await module.createAnimation(context.query);
      }

      case 'interaction':
        return await module.handleInteraction(context.topic);

      case 'vision':
        // VISION_PLANNER: describe image → return structured text for PlannerAgent
        if (intent === 'VISION_PLANNER') {
          return await module.describeImageForPlanner(context.imageBuffer, context.mimeType, context.query);
        }
        // VISION: full markdown analysis for user
        return await module.analyzeImageBuffer(context.imageBuffer, context.mimeType, context.prompt);

      case 'voice':
        return await module.processVoiceMessage(context.audioBuffer, context.options);

      case 'planner':
        return await module.createPlan({
          type: context.type || 'planner_request',
          content: context.query || '',
          context: context.context || '',
        });

      case 'coder':
        return await module.solveWithDebugLoop(context.query, {
          language: context.language || null,
          maxRetries: context.maxRetries ?? 2,
          runTests: context.runTests !== false,
        });

      default:
        throw new Error(`Unknown agent dispatch: ${agentKey}`);
    }
  }

  // ── Stats API (cho Admin Dashboard) ──

  getStats() {
    return {
      ...this._stats,
      agents: this.getAgentStates(),
      uptime: process.uptime(),
    };
  }

  resetStats() {
    this._stats = { totalRequests: 0, agentCalls: {}, errors: 0 };
  }
}

// Singleton
export const routerAgent = new RouterAgent();
